import { Body, ConflictException, Controller, ForbiddenException, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { authenticate, verifyOrigin } from '../middleware/auth';
import { found, mongoId } from '../utils/db';
import { label, objectId, read } from '../validators/common';
import { transaction } from '../config/db';
import { Branch, HotelBooking, IncomingTransfer, Membership, Plan, PlanVersion, SaaSCheckout, SaaSInvoice, Subscription, SystemNotification, TableSession, Tenant, User, UserSession, branchModes, loginRoles, tableBranchModes } from '../models';
import { activePlan, paidPlan, simulatedPlanDays, simulatedSubscription, simulatedSubscriptionsEnabled, subscriptionStatus,
  tenantMembership, trialDays } from '../services/tenants';
import { canManageBranches } from '../middleware/policy';
import { branchLocation } from '../validators/order-location';
import { createSubscriptionCheckout, sameSubscriptionDestination, subscriptionPaymentConfig } from '../services/subscription-payments';
import { subscriptionRequestFields, validatePlanForTenant } from '../services/platform-subscriptions';

const branchSchema = z.object({
  name: label, mode: z.enum(branchModes),
  location: branchLocation,
  bankAccount: z.object({ bank: z.string().regex(/^\d{6}$/), account: z.string().regex(/^\d{4,30}$/), holder: label }).strict().optional(),
}).strict();
const branchChanges = branchSchema.partial().extend({ bankAccount: branchSchema.shape.bankAccount.nullable() }).refine(input => Object.keys(input).length > 0);
const branchFields = 'name tenantId mode createdAt bankAccount location';
const planCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/);
const trialBranch = branchSchema.extend({ mode: branchSchema.shape.mode.exclude(['HYBRID']) });
const tenantInput = z.discriminatedUnion('subscription', [
  z.object({ name: label, branch: trialBranch, subscription: z.literal('TRIAL') }).strict(),
  z.object({ name: label, branch: branchSchema, subscription: z.literal('PAID'), planCode }).strict(),
]);

function trialAvailable(userId: string, session?: ClientSession) {
  return Membership.exists({ userId, role: 'OWNER' }).session(session ?? null).then(owner => !owner);
}

@Controller('tenants')
export class TenantsController {
  @Get()
  async list(@Req() req: Request) {
    const { userId, staffMode } = await authenticate(req);
    const memberships = await Membership.find({ userId, role: { $in: loginRoles }, disabled: { $ne: true }, archivedAt: null,
      ...(staffMode ? { tenantId: staffMode.tenantId } : {}) }).lean();
    const ids = memberships.map(item => item.tenantId);
    const [tenants, subscriptions, branches] = await Promise.all([
      Tenant.find({ _id: { $in: ids }, locked: { $ne: true } }).select('name').sort('name _id').lean(),
      Subscription.find({ tenantId: { $in: ids } }).select('tenantId status startsAt expiresAt trial simulated').lean(),
      Branch.find({ tenantId: { $in: memberships.filter(item => item.role === 'MANAGER' && !staffMode).map(item => item.tenantId) } })
        .select('tenantId').lean(),
    ]);
    const byTenant = new Map(memberships.map(item => [String(item.tenantId), item]));
    const contracts = new Map(subscriptions.map(({ tenantId, status, startsAt, expiresAt, trial, simulated }) =>
      [String(tenantId), { status: subscriptionStatus(status, simulated), startsAt, expiresAt, trial }]));
    return tenants.map(tenant => {
      const item = byTenant.get(String(tenant._id));
      const role = staffMode ? 'CASHIER' : item?.role;
      const assigned = new Set(item?.branchIds.map(String));
      const canEditSharedCatalog = role === 'OWNER' || (role === 'MANAGER' && assigned.size > 0 &&
        branches.every(branch => !branch.tenantId.equals(tenant._id) || assigned.has(String(branch._id))));
      return { tenant, role, canEditSharedCatalog, subscription: contracts.get(String(tenant._id)) };
    });
  }

  @Get('setup')
  async setup(@Req() req: Request) {
    const { userId } = await authenticate(req, { management: true });
    const user = found(await User.findById(userId).select('trialStartedAt').lean());
    const onlinePayment = !!subscriptionPaymentConfig();
    return { trialAvailable: !user.trialStartedAt && await trialAvailable(userId), trialDays, onlinePayment,
      simulatedPlanDays: !onlinePayment && simulatedSubscriptionsEnabled() ? simulatedPlanDays : null };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(tenantInput, body);
    const payments = subscriptionPaymentConfig();
    return transaction(async session => {
      const { id: sessionId, userId } = await authenticate(req, { management: true, session });
      const user = found(await User.findOneAndUpdate({ _id: userId, locked: { $ne: true } },
        { $set: { tenantWriteToken: randomUUID() } }, { session, timestamps: false }).select('trialStartedAt').lean());
      const now = new Date();
      const trial = input.subscription === 'TRIAL';
      if (trial && (user.trialStartedAt || !await trialAvailable(userId, session))) {
        throw new ConflictException('Mỗi tài khoản được dùng thử một lần cho cửa hàng đầu tiên.');
      }
      const plan = trial && await Plan.findOne({ code: 'TRIAL' }).session(session).lean();
      const revision = input.subscription === 'PAID' ? await paidPlan(input.planCode, [input.branch.mode], session) :
        plan && await PlanVersion.findOne({ planId: plan._id, version: 1 }).session(session).lean();
      if (!revision) throw new ConflictException('Gói dùng thử chưa được cấu hình. Hãy liên hệ quản trị viên JUEE POS.');
      const tenant = await Tenant.insertOne({ name: input.name }, { session });
      const tenantId = tenant._id;
      await Membership.insertOne({ tenantId, userId, role: 'OWNER', branchIds: [] }, { session });
      const branch = await Branch.insertOne({ tenantId, ...input.branch }, { session });
      const subscription = trial ? { trial: true, expiresAt: new Date(now.getTime() + trialDays * 86400000) } :
        !payments && simulatedSubscriptionsEnabled() ? simulatedSubscription(revision._id, now) :
          { status: 'PENDING', requestedPlanVersionId: revision._id, requestedAt: now, requestId: randomUUID() } as const;
      const contract = await Subscription.insertOne({ tenantId, planVersionId: revision._id, startsAt: now, ...subscription }, { session });
      if (!trial && payments && contract.requestId) {
        await createSubscriptionCheckout(payments, contract, revision, contract.requestId, session);
      }
      await UserSession.updateOne({ _id: sessionId }, { $set: { selectedBranch: { tenantId, branchId: branch._id } } }, { session });
      if (trial) await User.updateOne({ _id: userId }, { $set: { trialStartedAt: now } }, { session });
      return { _id: tenantId, name: tenant.name, createdAt: tenant.createdAt, branches: [branch.toObject()] };
    });
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') rawId: string) {
    const { userId } = await authenticate(req, { management: true });
    const { tenant, membership } = await tenantMembership(userId, read(objectId, rawId));
    return { _id: tenant._id, name: tenant.name, createdAt: tenant.createdAt, role: membership.role };
  }

  @Patch(':id')
  async rename(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const tenantId = read(objectId, rawId);
    const input = read(z.object({ name: label }).strict(), body);
    return transaction(async session => {
      const { userId } = await authenticate(req, { management: true, session });
      const { membership } = await tenantMembership(userId, tenantId, session);
      if (membership.role !== 'OWNER') throw new ForbiddenException();
      await activePlan(tenantId, session, true);
      return found(await Tenant.findOneAndUpdate({ _id: tenantId, locked: { $ne: true } }, { $set: input },
        { session, returnDocument: 'after' }).select('name createdAt').lean());
    });
  }

  @Get(':id/branches')
  async branches(@Req() req: Request, @Param('id') rawId: string) {
    const { userId, staffMode } = await authenticate(req);
    const tenantId = read(objectId, rawId);
    if (staffMode && String(staffMode.tenantId) !== tenantId) throw new ForbiddenException();
    const { membership } = await tenantMembership(userId, tenantId);
    if (staffMode && !canManageBranches(membership.role, membership.branchIds.map(String), String(staffMode.branchId))) throw new ForbiddenException();
    const scope = staffMode ? { _id: staffMode.branchId } : membership.role === 'OWNER' ? {} : { _id: { $in: membership.branchIds } };
    return Branch.find({ tenantId, ...scope })
      .sort('createdAt _id').select(staffMode ? 'name tenantId mode createdAt' : branchFields).lean();
  }

  @Post(':id/branches')
  async createBranch(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    const tenantId = read(objectId, rawId);
    const input = read(branchSchema, body);
    return transaction(async session => {
      const { userId } = await authenticate(req, { management: true, session });
      const { membership } = await tenantMembership(userId, tenantId, session);
      if (!canManageBranches(membership.role)) throw new ForbiddenException();
      await Tenant.updateOne({ _id: tenantId, locked: { $ne: true } }, { $set: { branchWriteToken: randomUUID() } }, { session });
      const plan = await activePlan(tenantId, session, true);
      if (await Branch.countDocuments({ tenantId }).session(session) >= (plan.maxBranches ?? 0)) {
        throw new ConflictException(`Gói hiện tại cho phép tối đa ${plan.maxBranches ?? 0} chi nhánh.`);
      }
      return (await Branch.insertOne({ tenantId, ...input }, { session })).toObject();
    });
  }

  @Patch(':id/branches/:branchId')
  async updateBranch(@Req() req: Request, @Param('id') rawId: string, @Param('branchId') rawBranchId: string, @Body() body: unknown) {
    const tenantId = read(objectId, rawId);
    const branchId = read(objectId, rawBranchId);
    const input = read(branchChanges, body);
    return transaction(async session => {
      const { userId } = await authenticate(req, { management: true, session });
      const { membership } = await tenantMembership(userId, tenantId, session);
      if (!canManageBranches(membership.role, membership.branchIds.map(String), branchId)) throw new ForbiddenException();
      await activePlan(tenantId, session, true);
      if (input.bankAccount !== undefined && membership.role !== 'OWNER') throw new ForbiddenException('Chỉ chủ doanh nghiệp sửa tài khoản nhận tiền.');
      if (input.location && membership.role !== 'OWNER') throw new ForbiddenException('Chỉ chủ doanh nghiệp được ghim vị trí chi nhánh.');
      if (input.mode && !tableBranchModes.includes(input.mode) && await TableSession.exists({ tenantId, branchId, status: 'OPEN' }).session(session)) {
        throw new ConflictException('Đóng các lượt phục vụ trước khi đổi mô hình chi nhánh.');
      }
      if (input.mode && input.mode !== 'HOTEL' && await HotelBooking.exists({
        tenantId, branchId, status: { $in: ['RESERVED', 'CHECKED_IN'] },
      }).session(session)) {
        throw new ConflictException('Xử lý các đặt phòng và lượt lưu trú đang mở trước khi đổi mô hình chi nhánh.');
      }
      return found(await Branch.findOneAndUpdate({ _id: branchId, tenantId },
        { $set: { ...input, ...(input.bankAccount === null ? { bankAccount: undefined } : {}) },
          ...(input.bankAccount === null ? { $unset: { bankAccount: 1 } } : {}) },
        { session, returnDocument: 'after' }).select(branchFields).lean());
    });
  }

  @Get(':id/notifications')
  async notifications(@Req() req: Request, @Param('id') rawId: string) {
    const { userId } = await authenticate(req, { management: true });
    const tenantId = read(objectId, rawId);
    await tenantMembership(userId, tenantId);
    return SystemNotification.find({ tenantIds: mongoId(tenantId) }).sort('-publishedAt').limit(25).select('title body kind publishedAt').lean();
  }

  @Get(':id/subscription')
  async subscription(@Req() req: Request, @Param('id') rawId: string) {
    const { userId } = await authenticate(req, { management: true });
    const tenantId = read(objectId, rawId);
    const { membership } = await tenantMembership(userId, tenantId);
    if (!['OWNER', 'ACCOUNTANT'].includes(membership.role)) throw new ForbiddenException();
    const contract = found(await Subscription.findOne({ tenantId }).lean());
    const version = found(await PlanVersion.findById(contract.planVersionId).setOptions({ useBigInt64: true }).lean());
    const payments = subscriptionPaymentConfig();
    const [plan, invoices, requested, quote] = await Promise.all([
      Plan.findById(version.planId).lean().then(value => found(value)),
      SaaSInvoice.find({ subscriptionId: contract._id }).select('reference amountVnd paidAt paymentCode')
        .sort('-createdAt').limit(50).setOptions({ useBigInt64: true }).lean(),
      contract.requestedPlanVersionId && PlanVersion.findById(contract.requestedPlanVersionId).setOptions({ useBigInt64: true }).lean(),
      payments && membership.role === 'OWNER' && contract.requestId
        ? SaaSCheckout.findOne({ subscriptionId: contract._id, requestId: contract.requestId }).lean() : null,
    ]);
    const requestedPlan = requested && await Plan.findById(requested.planId).select('name code').lean();
    let checkout;
    if (quote && payments && sameSubscriptionDestination(quote, payments) && ['ACTIVE', 'PENDING'].includes(contract.status)) {
      const review = await IncomingTransfer.exists({ subscriptionId: contract._id, checkoutId: quote._id, status: 'REVIEW' });
      const params = new URLSearchParams({ amount: String(quote.amount), addInfo: quote.reference });
      checkout = {
        reference: quote.reference, amount: quote.amount, bank: quote.gateway, account: quote.account, holder: quote.holder,
        expiresAt: quote.expiresAt, status: review ? 'REVIEW' : quote.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING',
        qrUrl: 'https://img.vietqr.io/image/' + quote.bank + '-' + quote.account + '-qr_only.png?' + params,
      };
    }
    return { ...contract, status: subscriptionStatus(contract.status, contract.simulated),
      onlinePayment: !!payments, checkout,
      simulatedPlanDays: !payments && simulatedSubscriptionsEnabled() ? simulatedPlanDays : null,
      planVersion: { ...version, maxBranches: contract.trial ? 1 : version.maxBranches, plan }, invoices,
      requestedPlan: requestedPlan && requested ? { code: requestedPlan.code, name: requestedPlan.name, monthlyVnd: requested.monthlyVnd } : null };
  }

  @Post(':id/subscription/request')
  async requestPlan(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
    verifyOrigin(req);
    const tenantId = read(objectId, rawId);
    const { code } = read(z.object({ code: planCode }).strict(), body);
    const payments = subscriptionPaymentConfig();
    return transaction(async session => {
      const { userId } = await authenticate(req, { management: true, session });
      const { membership } = await tenantMembership(userId, tenantId, session);
      if (membership.role !== 'OWNER') throw new ForbiddenException();
      await Tenant.updateOne({ _id: tenantId }, { $set: { branchWriteToken: randomUUID() } }, { session });
      const branches = await Branch.find({ tenantId }).select('mode').session(session).lean();
      const revision = await paidPlan(code, branches.map(branch => branch.mode), session);
      const current = await Subscription.findOne({ tenantId }).session(session).lean();
      if (current?.status === 'SUSPENDED' || current?.status === 'CANCELED') {
        throw new ConflictException('Thuê bao đang bị tạm dừng hoặc đã hủy. Hãy liên hệ quản trị viên.');
      }
      if (payments) {
        const quote = current?.requestId && await SaaSCheckout.findOne({ requestId: current.requestId, subscriptionId: current._id }).session(session).lean();
        if (quote && await IncomingTransfer.exists({ subscriptionId: quote.subscriptionId, checkoutId: quote._id, status: 'REVIEW' }).session(session)) {
          throw new ConflictException('Giao dịch đang chờ đối soát. Hãy liên hệ JUEE POS trước khi chuyển thêm tiền.');
        }
        if (quote && quote.planVersionId.equals(revision._id) && quote.expiresAt > new Date() && sameSubscriptionDestination(quote, payments)) {
          return { ok: true, simulated: false };
        }
        await validatePlanForTenant(mongoId(tenantId), revision, session);
        const requestId = randomUUID();
        const contract = found(await Subscription.findOneAndUpdate({ tenantId },
          { $set: { requestedPlanVersionId: revision._id, requestedAt: new Date(), requestId },
            $unset: { rejectedRequest: 1 }, $setOnInsert: { planVersionId: revision._id, status: 'PENDING' } },
          { session, upsert: true, returnDocument: 'after' }).lean());
        await createSubscriptionCheckout(payments, contract, revision, requestId, session);
        return { ok: true, simulated: false };
      }
      if (simulatedSubscriptionsEnabled()) {
        const now = new Date();
        const alreadyActive = current?.simulated && current.status === 'ACTIVE' && current.planVersionId.equals(revision._id) &&
          current.startsAt <= now && current.expiresAt && current.expiresAt > now;
        if (!alreadyActive) {
          await Subscription.updateOne({ tenantId }, { $set: simulatedSubscription(revision._id, now),
            $unset: { ...subscriptionRequestFields, rejectedRequest: 1 } }, { session, upsert: true });
        }
        return { ok: true, simulated: true };
      }
      if (!current?.requestedPlanVersionId?.equals(revision._id)) {
        await Subscription.updateOne({ tenantId }, { $set: { requestedPlanVersionId: revision._id, requestedAt: new Date(), requestId: randomUUID() },
          $unset: { rejectedRequest: 1 }, $setOnInsert: { planVersionId: revision._id, status: 'PENDING' } }, { session, upsert: true });
      }
      return { ok: true, simulated: false };
    });
  }
}
