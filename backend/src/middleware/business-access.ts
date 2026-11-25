import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { ClientSession, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { authenticate } from './auth';
import { found, mongoId } from '../utils/db';
import { objectId, read } from '../validators/common';
import { AuditLog, Branch, Membership, OutboxEvent, Tenant, tableBranchModes, type BranchMode, type Role } from '../models';
import { canManageBranches, hasBranchAccess } from './policy';
import { requireBusinessAvailable, tenantMembership } from '../services/tenants';

const permissions = {
  'catalog.read': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'INVENTORY', 'ACCOUNTANT'],
  'products.write': ['OWNER', 'MANAGER'],
  'catalog.branch-write': ['OWNER', 'MANAGER'],
  'branch-prices.write': ['OWNER', 'MANAGER'],
  'catalog.availability': ['OWNER', 'MANAGER'],
  'members.read': ['OWNER', 'MANAGER', 'CASHIER'],
  'members.create': ['OWNER', 'MANAGER', 'CASHIER'],
  'members.write': ['OWNER', 'MANAGER'],
  'member-classes.read': ['OWNER', 'MANAGER', 'CASHIER'],
  'member-classes.attendance': ['OWNER', 'MANAGER', 'CASHIER'],
  'member-plans.manage': ['OWNER', 'MANAGER'],
  'member-check-in.manage': ['OWNER', 'MANAGER'],
  'hotel.operate': ['OWNER', 'MANAGER', 'CASHIER'],
  'hotel.manage': ['OWNER', 'MANAGER'],
  'tickets.operate': ['OWNER', 'MANAGER', 'CASHIER'],
  'tickets.manage': ['OWNER', 'MANAGER'],
  'orders.read': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'ACCOUNTANT'],
  'orders.create': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
  'orders.accept': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
  'orders.edit': ['OWNER', 'MANAGER'],
  'orders.cancel': ['OWNER', 'MANAGER'],
  'orders.cancellations': ['OWNER', 'MANAGER'],
  'bills.read': ['OWNER', 'MANAGER', 'CASHIER', 'ACCOUNTANT'],
  'transfers.review': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
  'payments.collect': ['OWNER', 'MANAGER', 'CASHIER'],
  'refunds.approve': ['OWNER', 'MANAGER'],
  'tables.serve': ['OWNER', 'MANAGER', 'WAITER', 'CASHIER'],
  'tables.manage': ['OWNER', 'MANAGER', 'WAITER', 'CASHIER'],
  'tables.configure': ['OWNER', 'MANAGER'],
  'table-discounts.manage': ['OWNER', 'MANAGER'],
  'buffet.manage': ['OWNER', 'MANAGER'],
  'kitchen.work': ['OWNER', 'MANAGER', 'KITCHEN'],
  'kitchen.serve': ['OWNER', 'MANAGER', 'KITCHEN', 'WAITER', 'CASHIER'],
  'reports.view': ['OWNER', 'MANAGER', 'ACCOUNTANT'],
  'company.report': ['OWNER', 'MANAGER'],
  'company.revenue': ['OWNER', 'MANAGER'],
  'finance.manage': ['OWNER', 'MANAGER'],
  'warehouse.ai': ['OWNER'],
  'tax.manage': ['OWNER'],
  'purchases.manage': ['OWNER', 'MANAGER'],
  'staff.manage': ['OWNER'],
  'staff.profiles': ['OWNER', 'MANAGER'],
  'staff.schedule': ['OWNER', 'MANAGER'],
  'staff.clock': ['OWNER', 'MANAGER', 'CASHIER'],
  'warehouse.read': ['OWNER', 'MANAGER', 'INVENTORY'],
  'warehouse.write': ['OWNER', 'MANAGER', 'INVENTORY'],
  'customers.manage': ['OWNER', 'MANAGER', 'CASHIER'],
  'registers.manage': ['OWNER', 'MANAGER'],
  'registers.read': ['OWNER', 'MANAGER', 'CASHIER'],
  'shifts.manage': ['OWNER', 'MANAGER', 'CASHIER'],
} satisfies Record<string, Role[]>;

type Permission = keyof typeof permissions;
const staffPermissions = new Set<Permission>([
  'catalog.read', 'orders.read', 'orders.create', 'orders.accept', 'bills.read', 'payments.collect', 'tables.serve', 'registers.read', 'kitchen.serve', 'members.read',
  'hotel.operate', 'tickets.operate', 'members.create', 'staff.clock', 'member-classes.read', 'member-classes.attendance',
]);
export type Scope = { tenantId: Types.ObjectId; branchId: Types.ObjectId };

export function allows(role: Role, permission: Permission) {
  return (permissions[permission] as Role[]).includes(role);
}

export async function requireSharedCatalog(tenantId: Types.ObjectId, membership: { role: Role; branchIds: Types.ObjectId[] }, session?: ClientSession) {
  if (membership.role !== 'OWNER' && await Branch.exists({ tenantId, _id: { $nin: membership.branchIds } }).session(session ?? null)) {
    throw new ForbiddenException('Cần quyền vào tất cả cửa hàng và chi nhánh để sửa danh mục dùng chung.');
  }
}

async function branchAccess(userId: string, scope: Scope, permission: Permission, session?: ClientSession, staffMode = false) {
  const { membership, tenant } = await tenantMembership(userId, scope.tenantId, session);
  if (staffMode && !canManageBranches(membership.role, membership.branchIds.map(String), String(scope.branchId))) throw new ForbiddenException();
  const role = staffMode ? 'CASHIER' : membership.role;
  if (!allows(role, permission)) throw new ForbiddenException();
  if (!hasBranchAccess(membership.role, membership.branchIds, scope.branchId, (id, branch) => id.equals(branch))) throw new ForbiddenException();
  const branch = found(await Branch.findOne({ _id: scope.branchId, tenantId: scope.tenantId }).session(session ?? null).lean());
  await requireBusinessAvailable(scope.tenantId, session, !!session);
  if (session) {
    // Serialize against tenant locks and membership changes in the same transaction.
    await Tenant.updateOne({ _id: scope.tenantId, locked: { $ne: true } }, { $set: { branchWriteToken: randomUUID() } }, { session });
    await Branch.updateOne({ _id: scope.branchId, tenantId: scope.tenantId }, { $set: { writeToken: randomUUID() } }, { session });
    await Membership.updateOne({ _id: membership._id }, { $currentDate: { updatedAt: true } }, { session, timestamps: false });
  }
  if (permission === 'products.write') await requireSharedCatalog(scope.tenantId, membership, session);
  return { membership: { ...membership, role }, tenant, branch };
}

export async function access(req: Request, rawTenant: string, rawBranch: string, permission: Permission, session?: ClientSession) {
  const { userId, staffMode } = await authenticate(req, { session });
  const scope = { tenantId: mongoId(read(objectId, rawTenant)), branchId: mongoId(read(objectId, rawBranch)) };
  if (staffMode && (!staffPermissions.has(permission) || !staffMode.tenantId.equals(scope.tenantId) || !staffMode.branchId.equals(scope.branchId))) {
    throw new ForbiddenException('Thao tác vượt quá quyền của chế độ Nhân viên tại chi nhánh đã chọn.');
  }
  return { scope, actorId: userId, ...await branchAccess(userId, scope, permission, session, !!staffMode) };
}

export function assertRestaurantMode(mode: BranchMode) {
  if (!tableBranchModes.includes(mode)) throw new ConflictException('Mô hình chi nhánh này không phục vụ theo bàn.');
}

export async function logChange(scope: Scope, actorId: string | undefined, action: string, targetId: Types.ObjectId, session: ClientSession, details?: unknown) {
  await AuditLog.insertOne({ ...scope, actorId, action, targetId, details }, { session });
}

export async function recordEvent(scope: Scope, type: string, resourceId: Types.ObjectId, session: ClientSession) {
  await OutboxEvent.insertOne({ ...scope, type, resourceId }, { session });
}
