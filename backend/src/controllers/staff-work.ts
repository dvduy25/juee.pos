import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, Param, Patch,
  Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange, type Scope } from '../middleware/business-access';
import { Branch, StaffAttendance, StaffSchedule, staffShiftKinds } from '../models';
import { scopedRoute } from '../routes/branch';
import { isStayDate } from '../services/hotel-stays';
import { facilityToday, shiftDays } from '../services/membership-plans';
import { idempotent } from '../services/sales';
import { clockIn, clockOut, staffEmployee } from '../services/staff-attendance';
import { expandStaffShiftRange, expandStaffShifts, staffShiftOnDate, staffShiftStatus } from '../services/staff-shifts';
import { found } from '../utils/db';
import { label, objectId, read } from '../validators/common';
import { pageSchema } from '../validators/sales';

type Route = { tenantId: string; branchId: string; id: string };
const dateTime = z.string().datetime({ offset: true }).transform(value => new Date(value));
const scheduleInput = z.object({ membershipId: objectId, title: label, note: z.string().trim().max(500).optional(),
  startsAt: dateTime, endsAt: dateTime, kind: z.enum(staffShiftKinds).default('FIXED'),
  targetMinutes: z.number().int().min(1).max(1440).optional(),
  throughDate: z.string().refine(isStayDate).optional(), applyFollowing: z.boolean().optional(),
  repeatWeeks: z.number().int().min(1).max(26).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).refine(items => new Set(items).size === items.length).optional(),
}).strict();
const periodInput = z.object({ day: z.string().refine(isStayDate).optional(), page: pageSchema, view: z.enum(['mine', 'branch']).default('mine') });
const monthInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(value => value >= '1970-01' && value < '9999-12');
const exchangeInput = z.union([
  z.object({ expectedMembershipId: objectId, membershipId: objectId }).strict(),
  z.object({ expectedMembershipId: objectId, otherScheduleId: objectId, otherMembershipId: objectId }).strict(),
]);

async function checkStaffAvailability(scope: Scope, memberId: Types.ObjectId, times: { startsAt: Date; endsAt: Date }[],
  excluded: Types.ObjectId[], session: ClientSession) {
  if (await StaffSchedule.exists({ tenantId: scope.tenantId, membershipId: memberId, canceledAt: null,
    $or: times.map(time => ({ startsAt: { $lt: time.endsAt }, endsAt: { $gt: time.startsAt } })),
    ...(excluded.length && { _id: { $nin: excluded } }) }).session(session)) {
    throw new ConflictException('Nhân viên đã có ca trùng giờ tại một chi nhánh.');
  }
}

async function attendanceBySchedule(scope: Scope, scheduleIds: Types.ObjectId[]) {
  if (!scheduleIds.length) return new Map<string, { firstIn: Date; lastOut?: Date | null; open: number }>();
  const records = await StaffAttendance.aggregate<{ _id: Types.ObjectId; firstIn: Date; lastOut?: Date | null; open: number }>([
    { $match: { ...scope, scheduleId: { $in: scheduleIds } } },
    { $group: { _id: '$scheduleId', firstIn: { $min: '$checkedInAt' }, lastOut: { $max: '$checkedOutAt' },
      open: { $max: { $cond: [{ $eq: ['$status', 'OPEN'] }, 1, 0] } } } },
  ]);
  return new Map(records.map(record => [String(record._id), record]));
}

function week(day = facilityToday()) {
  const start = new Date(`${day}T00:00:00+07:00`);
  const end = new Date(`${shiftDays(day, 7)}T00:00:00+07:00`);
  if (!Number.isFinite(+end)) throw new BadRequestException('Ngày bắt đầu tuần không hợp lệ.');
  return { start, end };
}

@Controller(scopedRoute)
export class StaffWorkController {
  @Get('staff-schedules')
  async schedules(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { view, day, page, singleDay } = read(periodInput.extend({ singleDay: z.literal('true').optional() }), query);
    const { scope, membership } = await access(req, route.tenantId, route.branchId, view === 'branch' ? 'staff.schedule' : 'staff.clock');
    const effectiveDay = day ?? facilityToday();
    const { start, end } = week(effectiveDay);
    const schedules = await StaffSchedule.find({ ...scope, ...(view === 'mine' && { membershipId: membership._id }),
      ...(singleDay ? { startsAt: { $gte: start, $lt: new Date(`${shiftDays(effectiveDay, 1)}T00:00:00+07:00`) } } :
        { startsAt: { $lt: end }, endsAt: { $gt: start } }) })
      .sort('startsAt _id').skip((page - 1) * 50).limit(50).lean();
    const worked = await attendanceBySchedule(scope, schedules.map(item => item._id));
    const now = new Date();
    return schedules.map(item => {
      const attendance = worked.get(String(item._id));
      return { ...item, hasAttendance: !!attendance, attendance, state: staffShiftStatus(item, attendance, now) };
    });
  }

  @Get('staff-calendar')
  async calendar(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { month, view } = read(z.object({ month: monthInput, view: periodInput.shape.view }), query);
    const { scope, membership } = await access(req, route.tenantId, route.branchId, view === 'branch' ? 'staff.schedule' : 'staff.clock');
    const start = new Date(`${month}-01T00:00:00+07:00`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
    const employeeFilter = view === 'mine' ? { membershipId: membership._id } : {};
    const dateFilter = { $gte: start, $lt: end };
    const [schedules, unscheduled] = await Promise.all([
      StaffSchedule.find({ ...scope, ...employeeFilter, canceledAt: null, startsAt: dateFilter }).select('startsAt endsAt leaveAt').lean(),
      StaffAttendance.aggregate<{ _id: string; count: number }>([
        { $match: { ...scope, ...employeeFilter, scheduleId: null, checkedInAt: dateFilter } },
        { $group: { _id: { $dateToString: { date: '$checkedInAt', format: '%Y-%m-%d', timezone: '+07:00' } }, count: { $sum: 1 } } },
      ]),
    ]);
    const worked = await attendanceBySchedule(scope, schedules.map(item => item._id));
    const days: Record<string, { total: number; attended: number; leave: number; absent: number; unscheduled: number }> = {};
    const summaryFor = (day: string) => days[day] ??= { total: 0, attended: 0, leave: 0, absent: 0, unscheduled: 0 };
    const now = new Date();
    for (const shift of schedules) {
      const day = facilityToday(+shift.startsAt);
      const summary = summaryFor(day);
      const status = staffShiftStatus(shift, worked.get(String(shift._id)), now);
      summary.total++;
      if (status === 'ATTENDED' || status === 'WORKING') summary.attended++;
      if (status === 'LEAVE') summary.leave++;
      if (status === 'ABSENT') summary.absent++;
    }
    for (const day of unscheduled) summaryFor(day._id).unscheduled = day.count;
    return days;
  }

  @Patch('staff-schedules/:id/leave')
  leave(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const { reason } = read(z.object({ reason: label.nullable() }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const shift = found(await StaffSchedule.findOne({ ...scope, _id: id, canceledAt: null }).session(session),
        'Không tìm thấy ca làm.');
      if (await StaffAttendance.exists({ ...scope, scheduleId: shift._id }).session(session)) {
        throw new ConflictException('Ca đã có chấm công.');
      }
      shift.set({ leaveAt: reason === null ? undefined : new Date(), leaveReason: reason ?? undefined });
      await shift.save({ session });
      await logChange(scope, actorId, reason === null ? 'STAFF_LEAVE_CLEAR' : 'STAFF_LEAVE_SET', shift._id, session, { reason });
      return { id };
    });
  }

  @Post('staff-schedules')
  schedule(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.saveSchedule(req, route, read(scheduleInput, body));
  }

  @Patch('staff-schedules/:id')
  editSchedule(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.saveSchedule(req, route, read(scheduleInput, body), read(objectId, route.id));
  }

  @Patch('staff-schedules/:id/exchange')
  exchangeSchedule(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const input = read(exchangeInput, body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const shift = await this.editableSchedule(scope, id, session);
      const other = 'otherScheduleId' in input ? await this.editableSchedule(scope, input.otherScheduleId, session) : undefined;
      if (shift.leaveAt || other?.leaveAt) throw new ConflictException('Hãy bỏ trạng thái nghỉ làm trước khi đổi ca.');
      if (!shift.membershipId.equals(input.expectedMembershipId) ||
          (other && 'otherMembershipId' in input && !other.membershipId.equals(input.otherMembershipId))) {
        throw new ConflictException('Người làm ca đã thay đổi. Hãy mở lại chức năng Đổi ca.');
      }
      const replacementId = 'membershipId' in input ? input.membershipId : input.otherMembershipId;
      if (shift.membershipId.equals(replacementId)) throw new BadRequestException('Hãy chọn một nhân viên khác.');
      const replacement = await staffEmployee(scope, replacementId, session);
      const excluded = other ? [shift._id, other._id] : [shift._id];
      await checkStaffAvailability(scope, replacement.memberId, [shift], excluded, session);
      if (other) {
        const current = await staffEmployee(scope, shift.membershipId, session);
        await checkStaffAvailability(scope, current.memberId, [other], excluded, session);
        other.set({ membershipId: current.memberId, staffName: current.staffName, seriesId: undefined });
        await other.save({ session });
      }
      shift.set({ membershipId: replacement.memberId, staffName: replacement.staffName, seriesId: undefined });
      await shift.save({ session });
      await logChange(scope, actorId, 'STAFF_SCHEDULE_EXCHANGE', shift._id, session, {
        previousMembershipId: input.expectedMembershipId, membershipId: replacement.memberId, otherScheduleId: other?._id,
      });
      return { id, ...(other && { otherScheduleId: String(other._id) }) };
    });
  }

  private saveSchedule(req: Request, route: Route, input: z.output<typeof scheduleInput>, id?: string) {
    const { membershipId, repeatWeeks, weekdays, throughDate, applyFollowing, startsAt, endsAt, ...fields } = input;
    const repeated = repeatWeeks > 1 || !!weekdays?.length;
    if ((repeated || throughDate) && (id || fields.kind !== 'FIXED')) {
      throw new BadRequestException('Chỉ xếp nhiều ngày khi tạo ca cố định.');
    }
    if ((throughDate && repeated) || (applyFollowing && (!id || fields.kind !== 'FIXED'))) {
      throw new BadRequestException('Cách xếp lịch cố định không hợp lệ.');
    }
    const times = throughDate ? expandStaffShiftRange(startsAt, endsAt, throughDate) : expandStaffShifts(startsAt, endsAt, repeatWeeks, weekdays);
    if (fields.targetMinutes !== undefined && (fields.kind !== 'FLEXIBLE' || fields.targetMinutes * 60_000 > +endsAt - +startsAt)) {
      throw new BadRequestException('Số phút làm chuẩn chỉ áp dụng cho ca linh động và phải nằm trong khung giờ ca.');
    }
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const now = new Date();
      if (times[0].endsAt <= now) throw new BadRequestException('Chọn một ca chưa kết thúc.');
      const existing = id ? await this.editableSchedule(scope, id, session) : undefined;
      const { memberId, staffName } = await staffEmployee(scope, membershipId, session);
      const following = applyFollowing && existing ? await this.followingSchedules(scope, existing, memberId, startsAt, now, session) : [];
      const updates = following.map(item => ({ item, time: staffShiftOnDate(startsAt, endsAt, item.startsAt) }));
      const replaced = existing ? [existing._id, ...following.map(item => item._id)] : [];
      await checkStaffAvailability(scope, memberId, [...times, ...updates.map(update => update.time)], replaced, session);
      const assignment = { ...fields, targetMinutes: fields.targetMinutes, membershipId: memberId, staffName };
      if (existing) {
        const seriesId = existing.membershipId.equals(memberId) && fields.kind === 'FIXED' &&
          (applyFollowing || +startsAt === +existing.startsAt)
          ? existing.seriesId : undefined;
        existing.set({ ...assignment, ...times[0], seriesId });
        for (const { item, time } of updates) item.set({ ...assignment, ...time });
        await StaffSchedule.bulkSave([existing, ...following], { session });
        await logChange(scope, actorId, 'STAFF_SCHEDULE_UPDATE', existing._id, session, { ...input, count: 1 + following.length });
        return { ...existing.toObject(), updatedCount: 1 + following.length };
      }
      const seriesId = times.length > 1 ? new Types.ObjectId() : undefined;
      const items = await StaffSchedule.insertMany(times.map(time => ({ ...scope, ...assignment, ...time, seriesId })), { session });
      await logChange(scope, actorId, 'STAFF_SCHEDULE_CREATE', items[0]._id, session, { ...input, seriesId, count: items.length });
      return { ...items[0].toObject(), createdCount: items.length };
    });
  }

  private async followingSchedules(scope: Scope, shift: Awaited<ReturnType<StaffWorkController['editableSchedule']>>,
    memberId: Types.ObjectId, startsAt: Date, now: Date, session: ClientSession) {
    if (!shift.seriesId || shift.kind !== 'FIXED' || !shift.membershipId.equals(memberId) ||
        facilityToday(+shift.startsAt) !== facilityToday(+startsAt)) {
      throw new BadRequestException('Chỉ đổi giờ các ca sau trong cùng lịch cố định của nhân viên.');
    }
    const candidates = await StaffSchedule.find({ ...scope, seriesId: shift.seriesId, membershipId: memberId,
      startsAt: { $gt: shift.startsAt }, endsAt: { $gt: now }, canceledAt: null }).session(session);
    const used = await StaffAttendance.distinct('scheduleId', { ...scope, scheduleId: { $in: candidates.map(item => item._id) } }).session(session);
    const usedIds = new Set(used.map(String));
    return candidates.filter(item => !usedIds.has(String(item._id)));
  }

  private async editableSchedule(scope: Scope, id: string, session: ClientSession) {
    const item = found(await StaffSchedule.findOne({ ...scope, _id: id, canceledAt: null }).session(session), 'Không tìm thấy ca làm.');
    if (item.endsAt <= new Date() || await StaffAttendance.exists({ ...scope, scheduleId: item._id }).session(session)) {
      throw new ConflictException('Ca đã kết thúc hoặc đã có chấm công.');
    }
    return item;
  }

  @Delete('staff-schedules/:id')
  cancelSchedule(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const id = read(objectId, route.id);
    const { series } = read(z.object({ series: z.literal('true').optional() }), query);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const item = await this.editableSchedule(scope, id, session);
      const now = new Date();
      const candidates = series && item.seriesId ? await StaffSchedule.find({ ...scope, seriesId: item.seriesId,
        startsAt: { $gte: item.startsAt }, endsAt: { $gt: now }, canceledAt: null }).select('_id').session(session).lean() : [item];
      const used = await StaffAttendance.distinct('scheduleId', { ...scope, scheduleId: { $in: candidates.map(shift => shift._id) } }).session(session);
      const usedIds = new Set(used.map(String));
      const ids = candidates.filter(shift => !usedIds.has(String(shift._id))).map(shift => shift._id);
      await StaffSchedule.updateMany({ ...scope, _id: { $in: ids } }, { $set: { canceledAt: now } }, { session });
      await logChange(scope, actorId, 'STAFF_SCHEDULE_CANCEL', item._id, session, { count: ids.length });
      return { id, canceledCount: ids.length };
    });
  }

  @Get('staff-attendance')
  async attendance(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { view, day, page, unscheduled } = read(periodInput.extend({ unscheduled: z.literal('true').optional() }), query);
    const { scope, membership } = await access(req, route.tenantId, route.branchId, view === 'branch' ? 'staff.schedule' : 'staff.clock');
    const { start, end } = week(day ?? shiftDays(facilityToday(), -6));
    return StaffAttendance.find({ ...scope, ...(view === 'mine' && { membershipId: membership._id }),
      ...(unscheduled ? { scheduleId: null, checkedInAt: { $gte: start, $lt: new Date(+start + 86_400_000) } } :
        { checkedInAt: { $lt: end }, $or: [{ status: 'OPEN' }, { checkedOutAt: { $gte: start } }] }),
    })
      .sort('-checkedInAt -_id').skip((page - 1) * 50).limit(50).lean();
  }

  @Get('staff-clock')
  async clock(@Req() req: Request, @Param() route: Route) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.clock');
    const open = await StaffAttendance.findOne({ tenantId: scope.tenantId, membershipId: membership._id, status: 'OPEN' }).lean();
    if (!open) return { open: null };
    const branch = await Branch.findOne({ tenantId: scope.tenantId, _id: open.branchId }).select('name').lean();
    return { open, branchName: branch?.name };
  }

  @Post('staff-clock/check-in')
  async checkIn(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const { employeeId } = read(z.object({ employeeId: objectId.optional() }).strict(), body ?? {});
    const permission = employeeId ? 'staff.schedule' : 'staff.clock';
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, permission);
    return idempotent(scope, 'STAFF_CHECK_IN', key, { actorId, employeeId }, async session => {
      const { membership } = await access(req, route.tenantId, route.branchId, permission, session);
      const worker = await staffEmployee(scope, employeeId ?? String(membership._id), session);
      return clockIn(scope, worker, { at: new Date(), method: 'MANUAL', actorId }, session);
    });
  }

  @Post('staff-clock/:id/check-out')
  async checkOut(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = read(objectId, route.id);
    const { reason } = read(z.object({ reason: label.optional() }).strict(), body ?? {});
    const permission = reason ? 'staff.schedule' : 'staff.clock';
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, permission);
    return idempotent(scope, 'STAFF_CHECK_OUT', key, { actorId, id, reason }, async session => {
      const { membership } = await access(req, route.tenantId, route.branchId, permission, session);
      const item = found(await StaffAttendance.findOne({ ...scope, _id: id, status: 'OPEN' }).session(session), 'Không tìm thấy lượt chấm công đang mở.');
      if (!reason && !item.membershipId.equals(membership._id)) throw new ForbiddenException();
      return clockOut(scope, item, { at: new Date(), method: 'MANUAL', actorId }, session, reason);
    });
  }
}
