import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Header, Headers, Param, Patch,
  Post, Req, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange } from '../middleware/business-access';
import { Branch, StaffAttendance, StaffClockCredential, StaffClockDevice, Tenant, staffDeviceMethods } from '../models';
import { scopedRoute } from '../routes/branch';
import { idempotent } from '../services/sales';
import { clockIn, clockOut, findOpenAttendance, resolveStaffPunch, staffEmployee } from '../services/staff-attendance';
import { requireBusinessAvailable } from '../services/tenants';
import { found, isDuplicate, mongoId } from '../utils/db';
import { label, objectId, read } from '../validators/common';

type Route = { tenantId: string; branchId: string; id: string; method: string };
const method = z.enum(staffDeviceMethods);
const code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_:.@+-]{0,79}$/, 'Mã phải có 1–80 ký tự hợp lệ.');
const methods = z.array(method).min(1).max(staffDeviceMethods.length).refine(items => new Set(items).size === items.length);
const deviceInput = z.object({ name: label, methods }).strict();
const eventInput = z.object({
  code, method, direction: z.enum(['IN', 'OUT', 'AUTO']).default('AUTO'),
  occurredAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
}).strict();
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

@Controller(scopedRoute)
export class StaffDeviceController {
  @Get('staff-clock-devices')
  async devices(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    return StaffClockDevice.find({ ...scope, revokedAt: null }).select('name methods createdAt').sort('name _id').lean();
  }

  @Post('staff-clock-devices')
  @Header('Cache-Control', 'no-store')
  createDevice(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(deviceInput, body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const key = `juee-staff-${randomBytes(32).toString('hex')}`;
      const device = await StaffClockDevice.insertOne({ ...scope, ...input, keyHash: hashKey(key) }, { session });
      await logChange(scope, actorId, 'STAFF_DEVICE_CREATE', device._id, session, { name: input.name });
      return { id: device._id, name: device.name, methods: device.methods, key };
    });
  }

  @Delete('staff-clock-devices/:id')
  revokeDevice(@Req() req: Request, @Param() route: Route) {
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const device = found(await StaffClockDevice.findOneAndUpdate({ ...scope, _id: id, revokedAt: null },
        { $set: { revokedAt: new Date() } }, { session }).lean(), 'Không tìm thấy máy chấm công đang hoạt động.');
      await logChange(scope, actorId, 'STAFF_DEVICE_REVOKE', device._id, session);
      return { id };
    });
  }

  @Get('staff-clock-credentials/:id')
  async credentials(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const { memberId } = await staffEmployee(scope, read(objectId, route.id));
    return StaffClockCredential.find({ ...scope, membershipId: memberId }).select('method code').lean();
  }

  @Patch('staff-clock-credentials/:id/:method')
  credential(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { code: identifier } = read(z.object({ code: code.nullable() }).strict(), body);
    const channel = read(method, route.method);
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.schedule', session);
      const { memberId } = await staffEmployee(scope, id, session);
      const match = { ...scope, membershipId: memberId, method: channel };
      if (identifier === null) await StaffClockCredential.deleteOne(match).session(session);
      else await StaffClockCredential.updateOne(match, { $set: { code: identifier } }, { upsert: true, session, runValidators: true });
      await logChange(scope, actorId, 'STAFF_DEVICE_CREDENTIAL', memberId, session, { method: channel, linked: identifier !== null });
      return { method: channel, code: identifier };
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mã này đã gắn với nhân viên khác tại chi nhánh.');
      throw error;
    });
  }

  @Post('staff-clock-events')
  @Header('Cache-Control', 'no-store')
  async event(@Param() route: Route, @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const token = authorization?.match(/^Bearer (juee-staff-[a-f0-9]{64})$/)?.[1];
    if (!token) throw new UnauthorizedException('Khóa máy chấm công không hợp lệ.');
    const scope = { tenantId: mongoId(read(objectId, route.tenantId)), branchId: mongoId(read(objectId, route.branchId)) };
    const match = { ...scope, keyHash: hashKey(token), revokedAt: null };
    const device = await StaffClockDevice.findOne(match).select('_id').lean();
    if (!device) throw new UnauthorizedException('Khóa máy chấm công không hợp lệ.');
    const input = read(eventInput, body);
    return idempotent(scope, `STAFF_CLOCK_DEVICE:${device._id}`, key, input, async session => {
      await requireBusinessAvailable(scope.tenantId, session, true);
      const tenant = await Tenant.updateOne({ _id: scope.tenantId, locked: { $ne: true } },
        { $set: { branchWriteToken: randomUUID() } }, { session });
      const branch = await Branch.updateOne({ tenantId: scope.tenantId, _id: scope.branchId },
        { $set: { writeToken: randomUUID() } }, { session });
      if (!tenant.matchedCount || !branch.matchedCount) throw new UnauthorizedException();
      const current = await StaffClockDevice.findOne(match).select('methods').session(session).lean();
      if (!current) throw new UnauthorizedException('Khóa máy chấm công đã hết hiệu lực.');
      if (!current.methods.includes(input.method)) throw new ForbiddenException('Phương thức này chưa được bật trên máy.');
      const now = Date.now();
      const at = input.occurredAt;
      if (!Number.isFinite(+at) || +at > now + 30_000 || +at < now - 7 * 86_400_000) {
        throw new BadRequestException('Kiểm tra đồng hồ máy. Chỉ nhận lượt từ 7 ngày trước đến hiện tại.');
      }
      const credential = found(await StaffClockCredential.findOne({ ...scope, method: input.method, code: input.code })
        .select('membershipId updatedAt').session(session).lean(), 'Mã chấm công chưa liên kết với nhân viên.');
      if (credential.updatedAt && +at < +credential.updatedAt - 30_000) {
        throw new ConflictException('Lượt chấm công có trước lần liên kết mã hiện tại.');
      }
      const worker = await staffEmployee(scope, credential.membershipId, session);
      const last = await StaffAttendance.findOne({ tenantId: scope.tenantId, membershipId: worker.memberId })
        .sort('-checkedInAt -_id').session(session).lean();
      const lastAt = last?.checkedOutAt ?? last?.checkedInAt;
      const punch = resolveStaffPunch(input.direction, at, last && lastAt && {
        at: lastAt, open: last.status === 'OPEN', sameBranch: last.branchId.equals(scope.branchId),
      });
      if (punch.duplicate && last) {
        return { id: last._id, direction: punch.direction, occurredAt: lastAt, duplicate: true };
      }
      const source = { at, method: input.method, deviceId: device._id };
      const attended = punch.direction === 'IN' ? await clockIn(scope, worker, source, session) :
        await clockOut(scope, found(await findOpenAttendance(scope.tenantId, worker.memberId, session), 'Nhân viên chưa check-in.'), source, session);
      return { id: attended._id, direction: punch.direction, occurredAt: at, duplicate: false };
    });
  }
}
