import { Body, ConflictException, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { authenticate, verifyOrigin } from '../middleware/auth';
import { found, mongoId } from '../utils/db';
import { label, objectId, read } from '../validators/common';
import { transaction } from '../config/db';
import { Branch, HotelBooking, Membership, Plan, SaaSInvoice, Subscription, SystemNotification, TableSession, Tenant, UserSession, branchModes, loginRoles, tableBranchModes } from '../models';
import { businessAccessStatus, requireBusinessAvailable, tenantMembership } from '../services/tenants';
import { revisions } from '../services/plans';
import { freePlanCode, freeRevision } from '../services/service-plan-catalog';
import { canManageBranches } from '../middleware/policy';
import { branchLocation } from '../validators/order-location';
import { reportPeriodQuery, selectedReportRange } from '../validators/reports';
import { ownerPerformance } from '../services/owner-performance';

const branchSchema = z.object({
  name: label, mode: z.enum(branchModes),
  location: branchLocation,
  bankAccount: z.object({ bank: z.string().regex(/^\d{6}$/), account: z.string().regex(/^\d{4,30}$/), holder: label }).strict().optional(),
}).strict();
const branchChanges = branchSchema.partial().extend({ bankAccount: branchSchema.shape.bankAccount.nullable() }).refine(input => Object.keys(input).length > 0);
const branchFields = 'name tenantId mode createdAt bankAccount location';
const planCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/);
const tenantInput = z.object({
  name: label, branch: branchSchema,
  subscription: z.enum(['FREE', 'PAID']).optional(), planCode: planCode.optional(),
}).strict();

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
      Subscription.find({ tenantId: { $in: ids } }).select('tenantId status').lean(),
      Branch.find({ tenantId: { $in: memberships.filter(item => item.role === 'MANAGER' && !staffMode).map(item => item.tenantId) } })
        .select('tenantId').lean(),
    ]);
    const byTenant = new Map(memberships.map(item => [String(item.tenantId), item]));
    const statuses = new Map(subscriptions.map(item => [String(item.tenantId), item.status]));
    return tenants.map(tenant => {
      const item = byTenant.get(String(tenant._id));
      const role = staffMode ? 'CASHIER' : item?.role;
      const assigned = new Set(item?.branchIds.map(String));
      const canEditSharedCatalog = role === 'OWNER' || (role === 'MANAGER' && assigned.size > 0 &&
        branches.every(branch => !branch.tenantId.equals(tenant._id) || assigned.has(String(branch._id))));
      return { tenant, role, canEditSharedCatalog, subscription: { status: businessAccessStatus(statuses.get(String(tenant._id))), startsAt: tenant.createdAt, features: freeRevision.features } };
    });
  }

  @Get('setup')
  async setup(@Req() req: Request) {
    await authenticate(req, { management: true });
    return { freeAvailable: true, onlinePayment: false, simulatedPlanDays: null };
  }

  @Get('owner-performance')
  async performance(@Req() req: Request, @Query() query: unknown) {
    const { userId } = await authenticate(req, { management: true });
    const { period, on, tenantId } = read(reportPeriodQuery.extend({ tenantId: objectId.optional() }).strict(), query);
    return ownerPerformance(userId, selectedReportRange(period, on), tenantId);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(tenantInput, body);
    return transaction(async session => {
      const { id: sessionId, userId } = await authenticate(req, { management: true, session });
      const plan = await Plan.findOne({ code: freePlanCode }).select('_id').session(session).orFail();
      const [revision] = await revisions(plan._id, session);
      if (!revision) throw new ConflictException('Cấu hình dịch vụ miễn phí chưa sẵn sàng.');
      const tenant = await Tenant.insertOne({ name: input.name }, { session });
      const tenantId = tenant._id;
      await Membership.insertOne({ tenantId, userId, role: 'OWNER', branchIds: [] }, { session });
      const branch = await Branch.insertOne({ tenantId, ...input.branch }, { session });
      await Subscription.insertOne({ tenantId, planVersionId: revision._id, status: 'ACTIVE' }, { session });
      await UserSession.updateOne({ _id: sessionId }, { $set: { selectedBranch: { tenantId, branchId: branch._id } } }, { session });
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
      await requireBusinessAvailable(tenantId, session, true);
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
      await requireBusinessAvailable(tenantId, session, true);
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
      await requireBusinessAvailable(tenantId, session, true);
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
    const contract = await Subscription.findOne({ tenantId }).select('status').lean();
    const invoices = contract ? await SaaSInvoice.find({ subscriptionId: contract._id }).select('reference amountVnd paidAt')
      .sort('-createdAt').limit(50).setOptions({ useBigInt64: true }).lean() : [];
    return { status: businessAccessStatus(contract?.status), invoices,
      planVersion: { ...freeRevision, plan: { name: 'Miễn phí' } } };
  }

  @Post(':id/subscription/request')
  async requestPlan(@Req() req: Request, @Param('id') rawId: string) {
    verifyOrigin(req);
    const tenantId = read(objectId, rawId);
    const { userId } = await authenticate(req, { management: true });
    const { membership } = await tenantMembership(userId, tenantId);
    if (membership.role !== 'OWNER') throw new ForbiddenException();
    await requireBusinessAvailable(tenantId);
    throw new ConflictException('JUEE POS đã miễn phí toàn bộ tính năng.');
  }
}
