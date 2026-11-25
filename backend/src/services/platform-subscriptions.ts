import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { Branch, DiningTable, Membership, PlanVersion, SaaSInvoice, Subscription, Tenant, tableBranchModes } from '../models';
import { found } from '../utils/db';
import { activeSubscriptionFilter, simulatedSubscriptionsEnabled, subscriptionStatus } from './tenants';

export const subscriptionExpiringDays = 7;
const oneDay = 86_400_000;
export const subscriptionRequestFields = { requestedPlanVersionId: 1, requestedAt: 1, requestId: 1 } as const;
export const platformSubscriptionFilters = ['REQUESTED', 'EXPIRING', 'EXPIRED', 'ACTIVE', 'PENDING', 'SUSPENDED', 'CANCELED', 'SCHEDULED'] as const;
type SubscriptionFilter = typeof platformSubscriptionFilters[number];

export function platformSubscriptionFilter(status: SubscriptionFilter | undefined, now: Date) {
  const current = activeSubscriptionFilter(now);
  if (status === 'ACTIVE') return current;
  if (status === 'EXPIRING') return { ...current, expiresAt: { $gt: now, $lte: new Date(+now + subscriptionExpiringDays * oneDay) } };
  if (status === 'REQUESTED') return { requestedPlanVersionId: { $type: 'objectId' as const } };
  const activated = { status: current.status, ...(!simulatedSubscriptionsEnabled() && { simulated: { $ne: true } }) };
  if (status === 'EXPIRED') return { ...activated, expiresAt: { $lte: now } };
  if (status === 'SCHEDULED') return { ...activated, startsAt: { $gt: now }, $or: current.$or };
  if (status === 'PENDING' && !simulatedSubscriptionsEnabled()) return { $or: [{ status }, { status: 'ACTIVE' as const, simulated: true }] };
  return status ? { status } : {};
}

export function platformSubscriptionState(contract: { status: string; startsAt: Date; expiresAt?: Date | null; simulated?: boolean | null }, now: Date) {
  const status = subscriptionStatus(contract.status, contract.simulated);
  if (status !== 'ACTIVE') return status;
  if (contract.expiresAt && contract.expiresAt <= now) return 'EXPIRED';
  return contract.startsAt > now ? 'SCHEDULED' : 'ACTIVE';
}

export async function validatePlanForTenant(tenantId: Types.ObjectId, revision: { maxBranches?: number | null; maxStaff?: number | null;
  maxQrTables?: number | null; features: string[] }, session: ClientSession) {
  const tenant = await Tenant.findOneAndUpdate({ _id: tenantId, locked: { $ne: true } },
    { $set: { branchWriteToken: randomUUID() } }, { session, timestamps: false }).select('_id').lean();
  if (!tenant) throw new ConflictException('Hãy mở khóa doanh nghiệp trước khi cấp gói.');
  const branches = await Branch.find({ tenantId }).select('mode').session(session).lean();
  if (branches.length > (revision.maxBranches ?? 0)) throw new ConflictException('Gói không đủ hạn mức chi nhánh.');
  if (!revision.features.includes('pos') || (branches.some(branch => tableBranchModes.includes(branch.mode)) &&
    (!revision.features.includes('qr') || !revision.features.includes('kitchen')))) {
    throw new ConflictException('Gói chưa hỗ trợ mô hình đang sử dụng.');
  }
  const staff = await Membership.countDocuments({ tenantId, role: { $ne: 'OWNER' }, disabled: { $ne: true } }).session(session);
  if (staff > (revision.maxStaff ?? 0)) throw new ConflictException('Gói không đủ hạn mức nhân sự.');
  const tables = await DiningTable.countDocuments({ tenantId }).session(session);
  if (tables > (revision.maxQrTables ?? 0)) throw new ConflictException('Gói không đủ hạn mức bàn QR.');
}

export function subscriptionPeriod(current: { startsAt: Date; expiresAt?: Date | null }, samePlan: boolean, now: Date) {
  const startsAt = samePlan ? current.startsAt : now;
  const base = samePlan ? Math.max(+now, +(current.expiresAt ?? now)) : +now;
  return { startsAt, expiresAt: new Date(base + 30 * oneDay) };
}

export async function activatePaidSubscription(contract: { _id: Types.ObjectId; planVersionId: Types.ObjectId; status: string;
  startsAt: Date; expiresAt?: Date | null; trial?: boolean | null; simulated?: boolean | null },
revision: { _id: Types.ObjectId; planId: Types.ObjectId; monthlyVnd: bigint },
receipt: { reference: string; paidAt: Date; paymentCode?: string }, session: ClientSession) {
  const previous = await PlanVersion.findById(contract.planVersionId).select('planId').session(session).lean();
  const samePlan = contract.status === 'ACTIVE' && !contract.trial && !contract.simulated && !!previous?.planId.equals(revision.planId);
  const patch = { ...subscriptionPeriod(contract, samePlan, new Date()), planVersionId: revision._id, status: 'ACTIVE', trial: false, simulated: false } as const;
  const after = found(await Subscription.findByIdAndUpdate(contract._id, { $set: patch, $unset: { ...subscriptionRequestFields, rejectedRequest: 1 } },
    { session, returnDocument: 'after' }).lean());
  await SaaSInvoice.insertOne({ ...receipt, subscriptionId: contract._id, amountVnd: revision.monthlyVnd }, { session });
  return after;
}
