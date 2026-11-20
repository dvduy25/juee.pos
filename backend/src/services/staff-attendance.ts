import { ConflictException } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';
import { logChange, type Scope } from '../middleware/business-access';
import { Membership, StaffAttendance, StaffSchedule, User, type staffDeviceMethods } from '../models';
import { found, mongoId } from '../utils/db';

export async function staffEmployee(scope: Scope, membershipId: string | Types.ObjectId, session?: ClientSession) {
  const member = found(await Membership.findOne({ tenantId: scope.tenantId, _id: membershipId, disabled: { $ne: true }, archivedAt: null,
    $or: [{ role: 'OWNER' }, { branchIds: scope.branchId }] }).session(session ?? null).lean(), 'Không tìm thấy nhân viên đang làm việc tại chi nhánh.');
  const user = !member.staffName && member.userId ? await User.findById(member.userId).select('name').session(session ?? null).lean() : null;
  return { memberId: member._id, staffName: member.staffName ?? user?.name ?? 'Nhân viên' };
}

type Source = { at: Date; actorId?: string; method: 'MANUAL' | typeof staffDeviceMethods[number]; deviceId?: Types.ObjectId };
export type OpenAttendance = NonNullable<Awaited<ReturnType<typeof findOpenAttendance>>>;

export function resolveStaffPunch(requested: 'AUTO' | 'IN' | 'OUT', at: Date,
  last?: { at: Date; open: boolean; sameBranch: boolean } | null) {
  if (last && at < last.at) throw new ConflictException('Lượt chấm công đến sai thứ tự. Hãy gửi từng lượt theo thứ tự thời gian.');
  const previousDirection = last?.open ? 'IN' : 'OUT';
  if (last?.sameBranch && +at - +last.at < 60_000 && (requested === 'AUTO' || requested === previousDirection)) {
    return { direction: previousDirection, duplicate: true } as const;
  }
  const automatic = last?.open ? 'OUT' : 'IN';
  return { direction: requested === 'AUTO' ? automatic : requested, duplicate: false } as const;
}

export function findOpenAttendance(tenantId: Types.ObjectId, membershipId: Types.ObjectId, session: ClientSession) {
  return StaffAttendance.findOne({ tenantId, membershipId, status: 'OPEN' }).session(session).exec();
}

export async function clockIn(scope: Scope, worker: Awaited<ReturnType<typeof staffEmployee>>, source: Source, session: ClientSession) {
  const { memberId: membershipId, staffName } = worker;
  if (await findOpenAttendance(scope.tenantId, membershipId, session)) throw new ConflictException('Nhân viên đang có lượt check-in chưa check-out.');
  const schedule = await StaffSchedule.findOne({ ...scope, membershipId, canceledAt: null,
    startsAt: { $lte: new Date(+source.at + 30 * 60_000) }, endsAt: { $gt: source.at } })
    .sort('startsAt _id').session(session).lean();
  if (schedule?.leaveAt) throw new ConflictException('Ca đã được ghi nghỉ làm. Hãy bỏ trạng thái nghỉ trước khi check-in.');
  if (schedule && await StaffAttendance.exists({ ...scope, scheduleId: schedule._id, payrollPaymentId: { $type: 'objectId' } }).session(session)) {
    throw new ConflictException('Ca này đã trả lương.');
  }
  const item = await StaffAttendance.insertOne({ ...scope, membershipId, staffName, checkedInAt: source.at, status: 'OPEN',
    checkInMethod: source.method, checkInDeviceId: source.deviceId,
    ...(schedule && { scheduleId: schedule._id, scheduleTitle: schedule.title, scheduledStartsAt: schedule.startsAt,
      scheduledEndsAt: schedule.endsAt, scheduledKind: schedule.kind, scheduledTargetMinutes: schedule.targetMinutes }),
  }, { session });
  await logChange(scope, source.actorId, 'STAFF_CHECK_IN', item._id, session, { scheduleId: schedule?._id, deviceId: source.deviceId });
  return item.toObject();
}

export async function clockOut(scope: Scope, item: OpenAttendance, source: Source, session: ClientSession, reason?: string) {
  if (!item.branchId.equals(scope.branchId)) throw new ConflictException('Hãy check-out tại chi nhánh đã check-in.');
  if (source.at < item.checkedInAt) throw new ConflictException('Giờ ra phải sau hoặc bằng giờ vào.');
  item.set({ checkedOutAt: source.at, closedBy: source.actorId && mongoId(source.actorId), status: 'CLOSED', closeReason: reason,
    checkOutMethod: source.method, checkOutDeviceId: source.deviceId });
  await item.save({ session });
  await logChange(scope, source.actorId, 'STAFF_CHECK_OUT', item._id, session, { reason, deviceId: source.deviceId });
  return item.toObject();
}
