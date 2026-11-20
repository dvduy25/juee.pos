import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange, type Scope } from '../middleware/business-access';
import { CashEntry, Membership, StaffAttendance, StaffPayPayment, StaffPayRate, User, recordedPaymentMethods, staffPayUnits } from '../models';
import { scopedRoute } from '../routes/branch';
import { isStayDate } from '../services/hotel-stays';
import { facilityToday, shiftDays } from '../services/membership-plans';
import { expenseLabels } from '../services/operating-expenses';
import { calculatePayroll } from '../services/payroll';
import { idempotent } from '../services/sales';
import { found, localFilter, mongoId } from '../utils/db';
import { objectId, read } from '../validators/common';
import { amount, pageSchema } from '../validators/sales';

type Route = { tenantId: string; branchId: string; id: string; paymentId: string };
const localDay = z.string().refine(value => value >= '1970-01-01' && isStayDate(value), 'Ngày không hợp lệ.');
const periodInput = z.object({ from: localDay, to: localDay });
type Period = z.output<typeof periodInput>;
const payRateInput = z.object({ effectiveOn: localDay, unit: z.enum(staffPayUnits), rate: amount, overtimeRate: amount,
  shiftMinutes: z.number().int().min(1).max(1440).optional() }).strict()
  .refine(input => input.unit === 'SHIFT' || input.shiftMinutes === undefined, 'Chỉ cài số giờ một ca khi trả lương theo ca.');

function attendanceRange({ from, to }: Period) {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days >= 62 || to > facilityToday()) {
    throw new BadRequestException('Kỳ lương tối đa 62 ngày và không vượt quá hôm nay.');
  }
  const dates = { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${shiftDays(to, 1)}T00:00:00+07:00`) };
  return { $or: [{ scheduledStartsAt: dates }, { scheduledStartsAt: null, checkedInAt: dates }] };
}

async function payrollWorker(scope: Scope, id: string, ownerAccess: boolean, session?: ClientSession) {
  const worker = found(await Membership.findOne({ _id: id, tenantId: scope.tenantId }).session(session ?? null).lean(),
    'Không tìm thấy hồ sơ nhân viên.');
  if (worker.role === 'OWNER' && !ownerAccess) throw new ForbiddenException();
  const inBranch = worker.role === 'OWNER' || worker.branchIds.some(branch => branch.equals(scope.branchId));
  if (!inBranch && !await StaffAttendance.exists({ ...scope, membershipId: worker._id }).session(session ?? null)) {
    throw new BadRequestException('Nhân viên này không có dữ liệu tại chi nhánh.');
  }
  const user = !worker.staffName && worker.userId ? await User.findById(worker.userId).select('name').session(session ?? null).lean() : null;
  return { id: worker._id, name: worker.staffName ?? user?.name ?? 'Nhân viên' };
}

async function payrollPreview(scope: Scope, membershipId: string, period: Period, session?: ClientSession) {
  const range = attendanceRange(period);
  const work = await StaffAttendance.find({ ...scope, membershipId, ...range }).sort('checkedInAt _id').limit(2001).session(session ?? null).lean();
  if (work.length > 2000) throw new BadRequestException('Có quá nhiều lượt chấm công. Hãy chọn kỳ ngắn hơn.');
  const rates = await StaffPayRate.find({ ...scope, membershipId, effectiveOn: { $lte: period.to } })
    .sort('-effectiveOn').session(session ?? null).lean();
  return calculatePayroll(work, rates);
}

@Controller(scopedRoute)
export class PayrollController {
  @Get('payroll/workers')
  async workers(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const { from, to, page, q } = read(periodInput.extend({ page: pageSchema, q: z.string().trim().max(120).optional() }), query);
    const worked = await StaffAttendance.distinct('membershipId', { ...scope, ...attendanceRange({ from, to }) });
    const search = q && localFilter(q);
    return Membership.aggregate([
      { $match: { tenantId: scope.tenantId, ...(membership.role !== 'OWNER' && { role: { $ne: 'OWNER' } }), $or: [
        { branchIds: scope.branchId, archivedAt: null }, { role: 'OWNER' }, { _id: { $in: worked } },
      ] } },
      { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: 'user' } },
      { $project: { name: { $ifNull: ['$staffName', { $first: '$user.name' }, 'Nhân viên'] }, position: 1, archivedAt: 1 } },
      ...(search ? [{ $match: { $or: [{ name: search }, { position: search }] } }] : []),
      { $sort: { name: 1, _id: 1 } }, { $skip: (page - 1) * 50 }, { $limit: 50 },
    ]);
  }

  @Get('payroll/:id')
  async preview(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const id = read(objectId, route.id);
    const period = read(periodInput, query);
    const employee = await payrollWorker(scope, id, membership.role === 'OWNER');
    const [preview, rates] = await Promise.all([
      payrollPreview(scope, id, period),
      StaffPayRate.find({ ...scope, membershipId: id }).sort('-effectiveOn').limit(30).lean(),
    ]);
    return { employee, ...preview, rates };
  }

  @Get('payroll/:id/payments')
  async history(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const id = read(objectId, route.id);
    const { page } = read(z.object({ page: pageSchema }), query);
    await payrollWorker(scope, id, membership.role === 'OWNER');
    return StaffPayPayment.find({ ...scope, membershipId: id }).select('from to paidAt method amount').sort('-paidAt -_id')
      .skip((page - 1) * 20).limit(20).lean();
  }

  @Get('payroll/:id/payments/:paymentId')
  async payment(@Req() req: Request, @Param() route: Route) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const membershipId = read(objectId, route.id);
    const paymentId = read(objectId, route.paymentId);
    await payrollWorker(scope, membershipId, membership.role === 'OWNER');
    return found(await StaffPayPayment.findOne({ ...scope, membershipId, _id: paymentId }).select('from to paidAt method amount lines').lean(),
      'Không tìm thấy phiếu lương tại chi nhánh.');
  }

  @Patch('payroll/:id/rate')
  async setRate(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const input = read(payRateInput, body);
    return transaction(async session => {
      const { scope, actorId, membership } = await access(req, route.tenantId, route.branchId, 'finance.manage', session);
      const worker = await payrollWorker(scope, id, membership.role === 'OWNER', session);
      const { effectiveOn, shiftMinutes, ...rateTerms } = input;
      const profile = await StaffPayRate.findOneAndUpdate({ ...scope, membershipId: worker.id, effectiveOn },
        { $set: { ...rateTerms, ...(shiftMinutes !== undefined && { shiftMinutes }) },
          ...(input.unit === 'HOUR' && { $unset: { shiftMinutes: 1 } }) },
        { upsert: true, returnDocument: 'after', session, runValidators: true }).lean();
      await logChange(scope, actorId, 'PAYROLL_RATE_SET', worker.id, session, input);
      return profile;
    });
  }

  @Post('payroll/:id/payments')
  async pay(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = read(objectId, route.id);
    const { expectedRevision, expectedAmount, method, ...period } = read(periodInput.extend({
      expectedRevision: z.string().regex(/^[0-9a-f]{64}$/), expectedAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      method: z.enum(recordedPaymentMethods),
    }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'finance.manage');
    return idempotent(scope, 'PAYROLL_PAYMENT', key, { actorId, id, expectedRevision, expectedAmount, method, ...period }, async session => {
      const { membership } = await access(req, route.tenantId, route.branchId, 'finance.manage', session);
      const worker = await payrollWorker(scope, id, membership.role === 'OWNER', session);
      const preview = await payrollPreview(scope, id, period, session);
      if (!preview.amount || preview.amount !== expectedAmount || preview.revision !== expectedRevision) {
        throw new ConflictException('Bảng lương đã thay đổi hoặc đã được trả. Hãy tải lại trước khi xác nhận.');
      }
      const paidAt = new Date();
      const cashEntry = await CashEntry.insertOne({ ...scope, actorId: mongoId(actorId), note: `Trả lương · ${worker.name}`,
        category: expenseLabels.STAFF, expenseKind: 'STAFF', direction: 'OUT', amount: preview.amount, method, occurredAt: paidAt }, { session });
      const lines = preview.lines.map(line => ({ ...line, attendanceIds: line.attendanceIds.map(mongoId) }));
      const payment = await StaffPayPayment.insertOne({ ...scope, membershipId: worker.id, staffName: worker.name, actorId: mongoId(actorId),
        cashEntryId: cashEntry._id, ...period, paidAt, method, amount: preview.amount, lines }, { session });
      const attendanceIds = lines.flatMap(line => line.attendanceIds);
      const marked = await StaffAttendance.updateMany({ ...scope, membershipId: worker.id, _id: { $in: attendanceIds }, payrollPaymentId: null },
        { $set: { payrollPaymentId: payment._id } }, { session });
      if (marked.modifiedCount !== attendanceIds.length) throw new ConflictException('Lượt chấm công vừa thay đổi. Hãy thử lại.');
      await logChange(scope, actorId, 'PAYROLL_PAYMENT', payment._id, session, { membershipId: worker.id, amount: preview.amount });
      // Keep the saved response small even for a long pay period.
      return { id: payment._id.toHexString(), amount: payment.amount, paidAt };
    });
  }
}
