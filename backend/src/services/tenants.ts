import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Types, ClientSession } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { found } from '../utils/db';
import { Membership, Plan, PlanVersion, Subscription, Tenant, loginRoles, tableBranchModes, type BranchMode } from '../models';
import { revisions } from './plans';

export const simulatedPlanDays = 30;

export function simulatedSubscriptionsEnabled(environment = process.env.NODE_ENV) {
  return environment === 'development';
}

export function activeSubscriptionFilter(now = new Date()) {
  return { status: 'ACTIVE' as const, startsAt: { $lte: now }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    ...(simulatedSubscriptionsEnabled() ? {} : { simulated: { $ne: true } }) };
}

export function simulatedSubscription(planVersionId: Types.ObjectId, now: Date) {
  return { planVersionId, status: 'ACTIVE' as const, startsAt: now, expiresAt: new Date(now.getTime() + simulatedPlanDays * 86400000),
    trial: false, simulated: true };
}

export function subscriptionStatus(status: string, simulated?: boolean | null) {
  return status === 'ACTIVE' && simulated && !simulatedSubscriptionsEnabled() ? 'PENDING' : status;
}

export async function paidPlan(code: string, modes: BranchMode[], session: ClientSession) {
  const plan = await Plan.findOne({ code, published: true }).session(session).lean();
  const revision = plan && (await revisions(plan._id, session))[0];
  if (!revision || revision.monthlyVnd <= 0n || (revision.maxBranches ?? 0) < modes.length) {
    throw new ConflictException('Hãy chọn gói trả phí có đủ số chi nhánh.');
  }
  if (!revision.features.includes('pos') || (modes.some(mode => tableBranchModes.includes(mode)) &&
      (!revision.features.includes('qr') || !revision.features.includes('kitchen')))) {
    throw new ConflictException('Gói này chưa hỗ trợ mô hình đang sử dụng.');
  }
  return revision;
}

export async function tenantMembership(userId: string, tenantId: string | Types.ObjectId, session?: ClientSession) {
  const membership = await Membership.findOne({ tenantId, userId, role: { $in: loginRoles }, disabled: { $ne: true }, archivedAt: null })
    .session(session ?? null).lean();
  const tenant = membership && await Tenant.findOne({ _id: tenantId, locked: { $ne: true } }).session(session ?? null).lean();
  if (!membership || !tenant) throw new ForbiddenException();
  return { membership, tenant };
}

export async function canSignIntoBusinessAccount(userId: Types.ObjectId, session?: ClientSession) {
  const memberships = await Membership.find({ userId }).select('role disabled archivedAt').session(session ?? null).lean();
  return !memberships.length || memberships.some(item =>
    (item.role === 'OWNER' || item.role === 'MANAGER') && !item.disabled && !item.archivedAt);
}

export async function activeSubscription(tenantId: string | Types.ObjectId, session?: ClientSession, serialize = false) {
  const filter = { tenantId, ...activeSubscriptionFilter() };
  const contract = serialize
    ? await Subscription.findOneAndUpdate(filter, { $set: { branchWriteToken: randomUUID() } }, { session, returnDocument: 'after' }).lean()
    : await Subscription.findOne(filter).session(session ?? null).lean();
  if (!contract) throw new ConflictException('Cửa hàng cần kích hoạt gói dịch vụ để tiếp tục.');
  return contract;
}

export async function activePlan(tenantId: string | Types.ObjectId, session?: ClientSession, serialize = false) {
  const contract = await activeSubscription(tenantId, session, serialize);
  const version = found(await PlanVersion.findById(contract.planVersionId).session(session ?? null).lean());
  return contract.trial ? { ...version, maxBranches: 1 } : version;
}
