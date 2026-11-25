import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Types, ClientSession } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Membership, Subscription, Tenant, loginRoles } from '../models';

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

export function businessAccessStatus(status?: string) {
  return status === 'SUSPENDED' || status === 'CANCELED' ? status : 'ACTIVE';
}

export async function requireBusinessAvailable(tenantId: string | Types.ObjectId, session?: ClientSession, serialize = false) {
  const contract = serialize
    ? await Subscription.findOneAndUpdate({ tenantId }, { $set: { branchWriteToken: randomUUID() } }, { session }).select('status').lean()
    : await Subscription.findOne({ tenantId }).select('status').session(session ?? null).lean();
  if (businessAccessStatus(contract?.status) !== 'ACTIVE') {
    throw new ConflictException('Cửa hàng đang bị tạm ngừng truy cập. Hãy liên hệ quản trị viên JUEE POS.');
  }
}
