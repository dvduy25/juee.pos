import { Body, ConflictException, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { z } from 'zod';
import { revisions } from '../services/plans';
import { activeSubscriptionFilter } from '../services/tenants';
import { activatePaidSubscription, platformSubscriptionFilter, platformSubscriptionFilters, platformSubscriptionState,
  subscriptionExpiringDays, subscriptionRequestFields, validatePlanForTenant } from '../services/platform-subscriptions';
import { platformActor } from '../middleware/auth';
import { found, isDuplicate, jsonValue, localFilter } from '../utils/db';
import { label, objectId, read } from '../validators/common';
import { transaction } from '../config/db';
import { AdminAuditLog, Branch, IncomingTransfer, Membership, Plan, PlanVersion, PlatformGrant, SaaSInvoice, Subscription, SystemNotification, Tenant, User, UserSession, branchModes } from '../models';

const userFields = 'name email phone locked createdAt emailVerifiedAt lastLoginAt';
const tenantFields = 'name locked createdAt';
const reason = z.string().trim().min(3).max(500);
const planRequest = z.object({ planVersionId: objectId, requestId: z.string().uuid().optional(), reason });
const status = z.object({ locked: z.boolean(), reason }).strict();
const pageNumber = z.coerce.number().int().min(1).max(10000).default(1);
const pageQuery = z.object({ page: pageNumber, q: z.string().trim().max(100).default(''), status: z.enum(['active', 'locked']).optional() });
const revisionSchema = z.object({
  monthlyVnd: z.string().regex(/^\d{1,15}$/).transform(value => BigInt(value)), yearlyVnd: z.string().regex(/^\d{1,15}$/).transform(value => BigInt(value)).optional(),
  maxBranches: z.number().int().min(1).max(10000), maxStaff: z.number().int().min(1).max(100000),
  maxQrTables: z.number().int().min(0).max(100000), features: z.array(label).max(50).transform(features => features.filter(feature => feature !== 'inventory')),
}).strict();
const planSchema = z.object({
  name: label, description: z.string().max(1000), published: z.boolean(), revision: revisionSchema, reason,
}).strict();
const take = 25;
const skip = (value: number) => (value - 1) * take;

async function audited<T>(
  actorId: string, action: string, explanation: string,
  change: (session: ClientSession) => Promise<{ id: Types.ObjectId | string; before?: unknown; after: T }>,
) {
  return transaction(async session => {
    const result = await change(session);
    await AdminAuditLog.insertOne({
      actorId, targetId: result.id, action, reason: explanation,
      before: result.before === undefined ? undefined : jsonValue(result.before), after: jsonValue(result.after),
    }, { session });
    return result.after;
  });
}

type Contract = NonNullable<Awaited<ReturnType<typeof getContract>>>;
function getContract(id: string) { return Subscription.findById(id).lean().exec(); }

async function withPlans<T extends Contract>(contracts: T[]) {
  const versions = await PlanVersion.find({ _id: { $in: contracts.flatMap(item => [item.planVersionId, ...(item.requestedPlanVersionId ? [item.requestedPlanVersionId] : [])]) } }).setOptions({ useBigInt64: true }).lean();
  const plans = await Plan.find({ _id: { $in: versions.map(item => item.planId) } }).lean();
  const plansById = new Map(plans.map(item => [String(item._id), item]));
  const versionsById = new Map(versions.map(item => [String(item._id), { ...item, plan: plansById.get(String(item.planId)) }]));
  const now = new Date();
  return contracts.map(item => ({ ...item, effectiveStatus: platformSubscriptionState(item, now), planVersion: versionsById.get(String(item.planVersionId)),
    requestedPlanVersion: versionsById.get(String(item.requestedPlanVersionId)) }));
}

function matchingPlanRequest(contract: Contract, input: z.output<typeof planRequest>) {
  if (!contract.requestedPlanVersionId?.equals(input.planVersionId) || (input.requestId && contract.requestId !== input.requestId)) {
    throw new ConflictException('Yêu cầu đăng ký gói đã thay đổi. Hãy tải lại danh sách.');
  }
}

function duplicateReceipt(error: unknown): never {
  if (isDuplicate(error)) throw new ConflictException('Mã giao dịch này đã được ghi nhận.');
  throw error;
}

async function withTenantSummary<T extends { _id: Types.ObjectId }>(tenants: T[]) {
  const tenantIds = tenants.map(item => item._id);
  const [members, branches, rawContracts] = await Promise.all([
    Membership.aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { tenantId: { $in: tenantIds } } }, { $group: { _id: '$tenantId', count: { $sum: 1 } } }]),
    Branch.aggregate<{ _id: Types.ObjectId; count: number }>([{ $match: { tenantId: { $in: tenantIds } } }, { $group: { _id: '$tenantId', count: { $sum: 1 } } }]),
    Subscription.find({ tenantId: { $in: tenantIds } }).lean(),
  ]);
  const contracts = await withPlans(rawContracts);
  const membersById = new Map(members.map(item => [String(item._id), item.count]));
  const branchesById = new Map(branches.map(item => [String(item._id), item.count]));
  const contractsById = new Map(contracts.map(item => [String(item.tenantId), item]));
  return tenants.map(item => {
    const id = String(item._id);
    const contract = contractsById.get(id);
    return { ...item, _count: { memberships: membersById.get(id) ?? 0, branches: branchesById.get(id) ?? 0 },
      subscriptions: contract ? [contract] : [] };
  });
}

@Controller('platform')
export class PlatformController {
  @Get('status')
  async systemStatus(@Req() req: Request) {
    await platformActor(req, 'platform.read');
    const database = await mongoose.connection.db!.command({ ping: 1 }, { timeoutMS: 3000 }).then(() => 'up', () => 'down');
    return { api: 'up', database, checkedAt: new Date() };
  }

  @Get('developer')
  async developer(@Req() req: Request) {
    const status = await this.systemStatus(req);
    return { ...status, environment: process.env.NODE_ENV ?? 'development', node: process.version,
      uptimeSeconds: Math.floor(process.uptime()), swaggerPath: process.env.NODE_ENV === 'production' ? null : '/docs' };
  }

  @Get('dashboard')
  async dashboard(@Req() req: Request) {
    const revenue = await this.revenue(req);
    const now = new Date();
    const pendingFilter = platformSubscriptionFilter('REQUESTED', now);
    const [requests, expiring, expired, lockedUsers, lockedTenants, registrations] = await Promise.all([
      Subscription.countDocuments(pendingFilter), Subscription.countDocuments(platformSubscriptionFilter('EXPIRING', now)),
      Subscription.countDocuments(platformSubscriptionFilter('EXPIRED', now)), User.countDocuments({ locked: true }),
      Tenant.countDocuments({ locked: true }), User.find().select(userFields).sort('-createdAt -_id').limit(5).lean(),
    ]);
    return { ...revenue, requests, expiring, expired, lockedUsers, lockedTenants, expiringDays: subscriptionExpiringDays, registrations };
  }

  @Get('revenue')
  async revenue(@Req() req: Request) {
    await platformActor(req, 'platform.read');
    const now = new Date();
    const vietnam = new Date(now.getTime() + 7 * 3600000);
    const year = vietnam.getUTCFullYear();
    const month = vietnam.getUTCMonth();
    const day = vietnam.getUTCDate();
    const localStart = (m: number, d = 1) => new Date(Date.UTC(year, m, d) - 7 * 3600000);
    const [users, tenants, branches, rawContracts, invoices, canceled, unlocked, allTime] = await Promise.all([
      User.countDocuments(), Tenant.countDocuments(), Branch.countDocuments(),
      Subscription.find(activeSubscriptionFilter(now)).lean(),
      SaaSInvoice.find({ paidAt: { $gte: localStart(0), $lte: now } }).select('paidAt amountVnd').setOptions({ useBigInt64: true }).lean(),
      Subscription.countDocuments({ status: 'CANCELED' }),
      Tenant.find({ locked: { $ne: true } }).select('_id').lean(),
      SaaSInvoice.aggregate<{ total: { toString(): string } }>([
        { $match: { paidAt: { $type: 'date' } } }, { $group: { _id: null, total: { $sum: { $toDecimal: '$amountVnd' } } } },
      ]),
    ]);
    const allowed = new Set(unlocked.map(item => String(item._id)));
    const contracts = await withPlans(rawContracts.filter(item => allowed.has(String(item.tenantId))));
    const sum = (from: Date, until = now) => invoices.reduce((total, invoice) =>
      invoice.paidAt && invoice.paidAt >= from && invoice.paidAt <= now && invoice.paidAt < until ? total + invoice.amountVnd : total, 0n);
    const paid = contracts.filter(item => !item.simulated && (item.planVersion?.monthlyVnd ?? 0n) > 0n);
    const mrr = paid.reduce((total, item) => total + (item.planVersion?.monthlyVnd ?? 0n), 0n);
    return { users, tenants, branches, active: contracts.length, paid: paid.length, canceled,
      free: contracts.filter(item => item.planVersion?.plan?.code === 'FREE').length,
      trial: contracts.filter(item => item.trial).length, totalCollected: allTime[0]?.total.toString() ?? '0',
      newThisMonth: contracts.filter(item => item.startsAt >= localStart(month)).length,
      mrr, arr: mrr * 12n, today: sum(localStart(month, day)), month: sum(localStart(month)), year: sum(localStart(0)),
      series: Array.from({ length: month + 1 }, (_, index) => ({ month: `T${index + 1}`, amount: sum(localStart(index), localStart(index + 1)) })),
    };
  }

  @Get('users')
  async users(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const { page, q, status, email, id } = read(pageQuery.extend({ email: z.enum(['verified', 'unverified']).optional(), id: objectId.optional() }), query);
    const search = localFilter(q);
    const where = { ...(id && { _id: id }), ...(status ? { locked: status === 'locked' ? true : { $ne: true } } : {}),
      ...(email ? { emailVerifiedAt: email === 'verified' ? { $ne: null } : null } : {}),
      ...(q ? { $or: [{ email: search }, { name: search }, { phone: search }] } : {}) };
    const [users, total] = await Promise.all([
      User.find(where).select(userFields).sort('-createdAt -_id').skip(skip(page)).limit(take).lean(), User.countDocuments(where),
    ]);
    const [counts, grants] = await Promise.all([Membership.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { userId: { $in: users.map(user => user._id) } } }, { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]), PlatformGrant.find({ userId: { $in: users.map(user => user._id) } }).select('userId').lean()]);
    const byId = new Map(counts.map(item => [String(item._id), item.count]));
    const platformAccounts = new Set(grants.map(grant => String(grant.userId)));
    return { items: users.map(user => ({ ...user, platformAccount: platformAccounts.has(String(user._id)),
      _count: { memberships: byId.get(String(user._id)) ?? 0 } })), total, page, take };
  }

  @Get('users/:id')
  async user(@Req() req: Request, @Param('id') rawId: string) {
    await platformActor(req, 'platform.read');
    const id = read(objectId, rawId);
    const user = found(await User.findById(id).select(userFields).lean());
    const [memberships, history, sessions, grant] = await Promise.all([
      Membership.find({ userId: id }).lean(), AdminAuditLog.find({ targetId: id }).sort('-createdAt').limit(25).lean(),
      UserSession.countDocuments({ userId: id, expiresAt: { $gt: new Date() } }), PlatformGrant.exists({ userId: id }),
    ]);
    const tenants = await Tenant.find({ _id: { $in: memberships.map(item => item.tenantId) } }).select('name').lean();
    const byId = new Map(tenants.map(item => [String(item._id), item]));
    return { ...user, sessions, platformAccount: !!grant, _count: { memberships: memberships.length },
      memberships: memberships.flatMap(item => {
        const tenant = byId.get(String(item.tenantId));
        return tenant ? [{ id: item._id.toString(), role: item.role, disabled: item.disabled, archivedAt: item.archivedAt, tenant }] : [];
      }), history };
  }

  @Patch('users/:id/status')
  async userStatus(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(status, body);
    return audited(actor, 'USER_STATUS', input.reason, async session => {
      const user = found(await User.findById(id).select('locked').session(session).lean());
      if (input.locked && await PlatformGrant.exists({ userId: id }).session(session)) throw new ForbiddenException('Tài khoản quản trị cần được xử lý qua quy trình vận hành');
      await User.updateOne({ _id: id }, { $set: { locked: input.locked } }, { session });
      if (input.locked) await UserSession.deleteMany({ userId: id }, { session });
      return { id, before: { locked: user.locked }, after: { locked: input.locked } };
    });
  }

  @Post('users/:id/revoke-sessions')
  async revoke(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(z.object({ reason }).strict(), body);
    return audited(actor, 'USER_REVOKE_SESSIONS', input.reason, async session => {
      found(await User.exists({ _id: id }).session(session));
      if (await PlatformGrant.exists({ userId: id }).session(session)) throw new ForbiddenException('Phiên quản trị được quản lý qua quy trình vận hành.');
      const result = await UserSession.deleteMany({ userId: id }, { session });
      return { id, after: { count: result.deletedCount } };
    });
  }

  @Get('tenants')
  async tenants(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const { page, q, status, id } = read(pageQuery.extend({ id: objectId.optional() }), query);
    const where = { ...(id && { _id: id }), ...(status ? { locked: status === 'locked' ? true : { $ne: true } } : {}), ...(q ? { name: localFilter(q) } : {}) };
    const [tenants, total] = await Promise.all([
      Tenant.find(where).select(tenantFields).sort('-createdAt -_id').skip(skip(page)).limit(take).lean(), Tenant.countDocuments(where),
    ]);
    return { items: await withTenantSummary(tenants), total, page, take };
  }

  @Get('tenants/:id')
  async tenant(@Req() req: Request, @Param('id') rawId: string) {
    await platformActor(req, 'platform.read');
    const id = read(objectId, rawId);
    const [tenant] = await withTenantSummary([found(await Tenant.findById(id).select(tenantFields).lean())]);
    const [branches, owners, history, invoices] = await Promise.all([
      Branch.find({ tenantId: id }).select('name mode createdAt').lean(), Membership.find({ tenantId: id, role: 'OWNER' }).lean(),
      AdminAuditLog.find({ targetId: { $in: [tenant._id, ...tenant.subscriptions.map(item => item._id)] } }).sort('-createdAt').limit(25).lean(),
      SaaSInvoice.find({ subscriptionId: { $in: tenant.subscriptions.map(item => item._id) } }).sort('-createdAt').limit(25).setOptions({ useBigInt64: true }).lean(),
    ]);
    const users = await User.find({ _id: { $in: owners.map(owner => owner.userId) } }).select('name email phone locked').lean();
    return { ...tenant, branches, memberships: users.map(user => ({ user })), history, invoices };
  }

  @Get('branches')
  async branches(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const input = read(z.object({ page: pageNumber, q: z.string().trim().max(100).optional(), tenantId: objectId.optional(), mode: z.enum(branchModes).optional() }), query);
    const where = { ...(input.tenantId && { tenantId: input.tenantId }), ...(input.q && { name: localFilter(input.q) }), ...(input.mode && { mode: input.mode }) };
    const [items, total] = await Promise.all([
      Branch.find(where).select('name mode tenantId createdAt').sort('-createdAt -_id').skip(skip(input.page)).limit(take).lean(),
      Branch.countDocuments(where),
    ]);
    const tenants = await Tenant.find({ _id: { $in: items.map(item => item.tenantId) } }).select('name').lean();
    const names = new Map(tenants.map(item => [String(item._id), item.name]));
    return { items: items.map(item => ({ ...item, tenantName: names.get(String(item.tenantId)) })), total, page: input.page, take };
  }

  @Patch('tenants/:id/status')
  async tenantStatus(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(status, body);
    return audited(actor, 'TENANT_STATUS', input.reason, async session => {
      const before = found(await Tenant.findOneAndUpdate({ _id: id }, { $set: { locked: input.locked } }, { session }).select('locked').lean());
      return { id, before, after: { locked: input.locked } };
    });
  }

  @Get('plans')
  async plans(@Req() req: Request) {
    await platformActor(req, 'platform.read');
    const plans = await Plan.find().sort('code').lean();
    const counts = await Subscription.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: activeSubscriptionFilter() },
      { $lookup: { from: PlanVersion.collection.name, localField: 'planVersionId', foreignField: '_id', as: 'version' } },
      { $unwind: '$version' }, { $group: { _id: '$version.planId', total: { $sum: 1 } } },
    ]);
    const totals = new Map(counts.map(item => [String(item._id), item.total]));
    return Promise.all(plans.map(async plan => ({ ...plan, revisions: await revisions(plan._id), activeTenants: totals.get(String(plan._id)) ?? 0 })));
  }

  @Post('plans')
  async createPlan(@Req() req: Request, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const { reason: explanation, revision, ...input } = read(planSchema.extend({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/) }), body);
    return audited(actor, 'PLAN_CREATE', explanation, async session => {
      const plan = await Plan.insertOne(input, { session });
      await PlanVersion.insertOne({ ...revision, planId: plan._id, version: 1 }, { session });
      return { id: plan._id, after: { ...plan.toObject(), revisions: await revisions(plan._id, session) } };
    });
  }

  @Patch('plans/:id')
  async updatePlan(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const { reason: explanation, revision, ...input } = read(planSchema, body);
    return audited(actor, 'PLAN_VERSION', explanation, async session => {
      const before = found(await Plan.findByIdAndUpdate(id, { $set: input }, { session }).lean());
      const oldRevisions = await revisions(before._id, session);
      await PlanVersion.insertOne({ ...revision, planId: before._id, version: (oldRevisions[0]?.version ?? 0) + 1 }, { session });
      return { id, before: { ...before, revisions: oldRevisions }, after: { ...before, ...input, revisions: await revisions(before._id, session) } };
    });
  }

  @Get('subscriptions')
  async subscriptions(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const { page, status, planId, tenantId, q } = read(z.object({
      page: pageNumber, status: z.enum(platformSubscriptionFilters).optional(), planId: objectId.optional(), tenantId: objectId.optional(),
      q: z.string().trim().max(100).optional(),
    }), query);
    const versions = planId && await PlanVersion.find({ planId }).select('_id').lean();
    const matchingTenants = q && await Tenant.find({ ...(tenantId && { _id: tenantId }), name: localFilter(q) }).select('_id').lean();
    const where = { ...platformSubscriptionFilter(status, new Date()),
      ...(matchingTenants ? { tenantId: { $in: matchingTenants.map(item => item._id) } } : tenantId && { tenantId }),
      ...(versions ? { [status === 'REQUESTED' ? 'requestedPlanVersionId' : 'planVersionId']: { $in: versions.map(item => item._id) } } : {}) };
    const order = status === 'EXPIRING' ? 'expiresAt _id' : status === 'REQUESTED' ? 'requestedAt createdAt _id' : '-startsAt -_id';
    const [contracts, total] = await Promise.all([
      Subscription.find(where).sort(order).skip(skip(page)).limit(take).lean(), Subscription.countDocuments(where),
    ]);
    const tenants = await Tenant.find({ _id: { $in: contracts.map(item => item.tenantId) } }).select('name locked').lean();
    const byId = new Map(tenants.map(item => [String(item._id), item]));
    return { items: await withPlans(contracts.map(item => ({ ...item, tenant: byId.get(String(item.tenantId)) }))), total, page, take };
  }

  @Get('subscriptions/:id')
  async subscription(@Req() req: Request, @Param('id') rawId: string) {
    await platformActor(req, 'platform.read');
    const id = read(objectId, rawId);
    const contract = found(await getContract(id));
    const [details] = await withPlans([contract]);
    const [tenant, history, invoices, transferReviews] = await Promise.all([
      Tenant.findById(contract.tenantId).select('name locked').lean(),
      AdminAuditLog.find({ targetId: id }).sort('-createdAt -_id').limit(25).lean(),
      SaaSInvoice.find({ subscriptionId: id }).sort('-createdAt -_id').limit(25).setOptions({ useBigInt64: true }).lean(),
      IncomingTransfer.find({ subscriptionId: id, status: 'REVIEW' })
        .select('reference bankReference amount reviewReason createdAt').sort('-createdAt -_id').limit(25).lean(),
    ]);
    return { ...details, tenant, history, invoices, transferReviews };
  }

  @Post('subscriptions/:id/change-plan')
  async changePlan(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(z.object({ planId: objectId, expiresAt: z.string().datetime().nullable(), reason }).strict(), body);
    return audited(actor, 'SUBSCRIPTION_PLAN', input.reason, async session => {
      const plan = found(await Plan.findOne({ _id: input.planId, published: true, code: { $ne: 'TRIAL' } }).session(session).lean());
      const revision = found((await revisions(plan._id, session))[0]);
      const before = found(await Subscription.findById(id).session(session).lean());
      if (before.status === 'PENDING') throw new ConflictException('Hãy duyệt yêu cầu đăng ký gói để kích hoạt cửa hàng.');
      if (before.requestedPlanVersionId) throw new ConflictException('Hãy xử lý yêu cầu đăng ký đang chờ trước khi đổi gói thủ công.');
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (revision.monthlyVnd > 0n && !expiresAt) throw new ConflictException('Gói trả phí cần ngày hết hạn.');
      if (expiresAt && expiresAt <= new Date(Math.max(Date.now(), +before.startsAt))) throw new ConflictException('Ngày hết hạn phải sau hiện tại và ngày bắt đầu.');
      await validatePlanForTenant(before.tenantId, revision, session);
      const patch = { planVersionId: revision._id, expiresAt, trial: false };
      await Subscription.updateOne({ _id: id }, { $set: patch }, { session });
      return { id, before, after: { ...before, ...patch } };
    });
  }

  @Post('subscriptions/:id/activate-request')
  async activateRequest(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(planRequest.extend({ reference: label }).strict(), body);
    return audited(actor, 'SUBSCRIPTION_REQUEST_ACTIVATE', input.reason, async session => {
      const before = found(await Subscription.findById(id).session(session).lean());
      matchingPlanRequest(before, input);
      if (before.status === 'SUSPENDED' || before.status === 'CANCELED') throw new ConflictException('Hãy xử lý trạng thái thuê bao trước khi kích hoạt gói.');
      const revision = found(await PlanVersion.findById(input.planVersionId).setOptions({ useBigInt64: true }).session(session).lean());
      if (revision.monthlyVnd <= 0n) throw new ConflictException('Yêu cầu này không thuộc gói trả phí.');
      await validatePlanForTenant(before.tenantId, revision, session);
      const transfer = await IncomingTransfer.findOne({ subscriptionId: id, status: 'REVIEW', bankReference: input.reference }).session(session).lean();
      if (transfer && BigInt(transfer.amount) !== revision.monthlyVnd) throw new ConflictException('Số tiền chuyển chưa khớp với giá gói.');
      const after = await activatePaidSubscription(before, revision, {
        reference: input.reference, paidAt: new Date(), paymentCode: transfer?.reference,
      }, session);
      if (transfer) await IncomingTransfer.updateOne({ _id: transfer._id }, { $set: { status: 'MATCHED' }, $unset: { reviewReason: 1 } }, { session });
      return { id, before, after };
    }).catch(duplicateReceipt);
  }

  @Post('subscriptions/:id/reject-request')
  async rejectRequest(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(planRequest.strict(), body);
    return audited(actor, 'SUBSCRIPTION_REQUEST_REJECT', input.reason, async session => {
      const before = found(await Subscription.findById(id).session(session).lean());
      matchingPlanRequest(before, input);
      const after = found(await Subscription.findByIdAndUpdate(id, { $set: { rejectedRequest: { reason: input.reason, rejectedAt: new Date() } },
        $unset: subscriptionRequestFields }, { session, returnDocument: 'after' }).lean());
      return { id, before, after };
    });
  }

  @Post('subscriptions/:id/extend')
  async extend(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(z.object({ days: z.number().int().min(1).max(730), reason }).strict(), body);
    return audited(actor, 'SUBSCRIPTION_EXTEND', input.reason, async session => {
      const before = found(await Subscription.findById(id).session(session).lean());
      if (before.trial || before.status !== 'ACTIVE') throw new ConflictException('Hãy kích hoạt hoặc khôi phục thuê bao trước khi gia hạn.');
      const expiresAt = new Date(Math.max(Date.now(), before.expiresAt?.getTime() ?? 0) + input.days * 86400000);
      await Subscription.updateOne({ _id: id }, { $set: { expiresAt } }, { session });
      return { id, before, after: { ...before, expiresAt } };
    });
  }

  @Patch('subscriptions/:id/status')
  async subscriptionStatus(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const id = read(objectId, rawId);
    const input = read(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELED']), reason }).strict(), body);
    return audited(actor, 'SUBSCRIPTION_STATUS', input.reason, async session => {
      const before = found(await Subscription.findById(id).session(session).lean());
      if (before.status === 'PENDING') {
        throw new ConflictException('Hãy duyệt yêu cầu đăng ký gói để kích hoạt cửa hàng.');
      }
      await Subscription.updateOne({ _id: id }, { $set: { status: input.status } }, { session });
      return { id, before, after: { ...before, status: input.status } };
    });
  }

  @Get('invoices')
  async invoices(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const input = read(z.object({ page: pageNumber, q: z.string().trim().max(100).optional(), subscriptionId: objectId.optional() }), query);
    const where = { ...(input.subscriptionId && { subscriptionId: input.subscriptionId }), ...(input.q && { reference: localFilter(input.q) }) };
    const [invoices, total] = await Promise.all([
      SaaSInvoice.find(where).sort('-createdAt -_id').skip(skip(input.page)).limit(take).setOptions({ useBigInt64: true }).lean(), SaaSInvoice.countDocuments(where),
    ]);
    const contracts = await Subscription.find({ _id: { $in: invoices.map(item => item.subscriptionId) } }).select('tenantId').lean();
    const tenants = await Tenant.find({ _id: { $in: contracts.map(item => item.tenantId) } }).select('name').lean();
    const byTenant = new Map(tenants.map(item => [String(item._id), item]));
    const byId = new Map(contracts.map(item => [String(item._id), { tenant: byTenant.get(String(item.tenantId)) }]));
    return { items: invoices.map(item => ({ ...item, subscription: byId.get(String(item.subscriptionId)) })), total, page: input.page, take };
  }

  @Post('invoices')
  async invoice(@Req() req: Request, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const { reason: explanation, ...input } = read(z.object({
      subscriptionId: objectId, reference: label, amountVnd: z.string().regex(/^[1-9][0-9]{0,14}$/).transform(value => BigInt(value)), reason,
    }).strict(), body);
    return audited(actor, 'INVOICE_RECEIPT', explanation, async session => {
      found(await Subscription.exists({ _id: input.subscriptionId }).session(session));
      const after = await SaaSInvoice.insertOne({ ...input, paidAt: new Date() }, { session });
      return { id: after._id, after: after.toObject() };
    }).catch(duplicateReceipt);
  }

  @Get('notifications')
  async notifications(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const input = read(z.object({ page: pageNumber }), query);
    const [items, total] = await Promise.all([
      SystemNotification.find().select('title kind actorId publishedAt').sort('-publishedAt -_id').skip(skip(input.page)).limit(take).lean(),
      SystemNotification.countDocuments(),
    ]);
    return { items, total, page: input.page, take };
  }

  @Post('notifications')
  async notify(@Req() req: Request, @Body() body: unknown) {
    const actor = await platformActor(req, 'platform.write');
    const { reason: explanation, target, ...input } = read(z.object({
      title: label, body: z.string().trim().min(1).max(4000), kind: z.enum(['MAINTENANCE', 'EXPIRY', 'FEATURE']),
      target: z.discriminatedUnion('type', [
        z.object({ type: z.literal('all') }).strict(), z.object({ type: z.literal('plan'), id: objectId }).strict(),
        z.object({ type: z.literal('tenant'), id: objectId }).strict(),
      ]), reason,
    }).strict(), body);
    return audited(actor, 'NOTIFICATION_PUBLISH', explanation, async session => {
      let tenantIds: Types.ObjectId[];
      if (target.type === 'plan') {
        const versions = await PlanVersion.find({ planId: target.id }).session(session).select('_id').lean();
        const contracts = await Subscription.find({ status: 'ACTIVE', planVersionId: { $in: versions.map(item => item._id) } }).session(session).select('tenantId').lean();
        tenantIds = contracts.map(item => item.tenantId);
      } else {
        const tenants = await Tenant.find(target.type === 'tenant' ? { _id: target.id } : {}).session(session).select('_id').lean();
        tenantIds = tenants.map(item => item._id);
      }
      found(tenantIds[0], 'Không có doanh nghiệp nhận thông báo');
      const event = await SystemNotification.insertOne({ ...input, actorId: actor, tenantIds }, { session });
      return { id: event._id, after: { id: event.id, title: event.title, recipients: tenantIds.length } };
    });
  }

  @Get('audit-logs')
  async logs(@Req() req: Request, @Query() query: unknown) {
    await platformActor(req, 'platform.read');
    const input = read(z.object({ page: pageNumber, q: z.string().trim().max(100).optional(), targetId: objectId.optional() }), query);
    const where = { ...(input.targetId && { targetId: input.targetId }), ...(input.q && { $or: [{ action: localFilter(input.q) }, { reason: localFilter(input.q) }] }) };
    const [items, total] = await Promise.all([
      AdminAuditLog.find(where).select('actorId targetId action reason createdAt').sort('-createdAt -_id').skip(skip(input.page)).limit(take).lean(), AdminAuditLog.countDocuments(where),
    ]);
    const users = await User.find({ _id: { $in: items.map(item => item.actorId) } }).select('name email').lean();
    const actors = new Map(users.map(user => [String(user._id), user]));
    return { items: items.map(item => ({ ...item, actor: actors.get(String(item.actorId)) })), total, page: input.page, take };
  }
}
