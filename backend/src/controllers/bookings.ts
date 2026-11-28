import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/db';
import { verifyOrigin } from '../middleware/auth';
import { access, type Scope } from '../middleware/business-access';
import { BookingRequest, Branch, Subscription, Tenant, bookingRequestStates } from '../models';
import { idempotent } from '../services/sales';
import { businessAccessStatus } from '../services/tenants';
import { mongoId } from '../utils/db';
import { accountPhone, label, objectId, read } from '../validators/common';

const dayMs = 86_400_000;
const pageSize = 30;
const bookingInput = z.object({
  guestName: label,
  phone: accountPhone,
  startsAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  endsAt: z.string().datetime({ offset: true }).transform(value => new Date(value)).optional(),
  partySize: z.number().int().min(1).max(100),
  note: z.string().trim().max(500).optional(),
}).strict();
const queueQuery = z.object({
  status: z.enum(bookingRequestStates).default('PENDING'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
}).strict();

async function publicBranch(scope: Scope, session?: ClientSession) {
  const branchFilter = { _id: scope.branchId, tenantId: scope.tenantId, onlineBookingEnabled: true };
  const branch = session
    ? await Branch.findOneAndUpdate(branchFilter, { $set: { writeToken: randomUUID() } }, { session, timestamps: false }).select('name mode').lean()
    : await Branch.findOne(branchFilter).select('name mode').lean();
  if (!branch) throw new NotFoundException('Chi nhánh hiện không nhận đặt trước qua link này.');
  const tenant = await Tenant.findOne({ _id: scope.tenantId, locked: { $ne: true } }).select('name').session(session ?? null).lean();
  const subscription = await Subscription.findOne({ tenantId: scope.tenantId }).select('status').session(session ?? null).lean();
  if (!tenant || businessAccessStatus(subscription?.status) !== 'ACTIVE') {
    throw new NotFoundException('Chi nhánh hiện không nhận đặt trước qua link này.');
  }
  return { storeName: tenant.name, branchName: branch.name, mode: branch.mode };
}

@Controller('bookings/:tenantId/:branchId')
export class PublicBookingsController {
  @Get()
  info(@Param('tenantId') tenantId: string, @Param('branchId') branchId: string) {
    return publicBranch({ tenantId: mongoId(read(objectId, tenantId)), branchId: mongoId(read(objectId, branchId)) });
  }

  @Post()
  async create(@Req() req: Request, @Param('tenantId') tenantId: string, @Param('branchId') branchId: string, @Body() body: unknown) {
    verifyOrigin(req);
    const scope = { tenantId: mongoId(read(objectId, tenantId)), branchId: mongoId(read(objectId, branchId)) };
    const input = read(bookingInput, body);
    return idempotent(scope, 'online-booking', req.get('idempotency-key'), input, async session => {
      const { mode } = await publicBranch(scope, session);
      const now = Date.now();
      const startsAt = input.startsAt.getTime();
      if (!Number.isFinite(startsAt) || startsAt <= now || startsAt > now + 180 * dayMs) {
        throw new BadRequestException('Chọn thời gian đến trong vòng 180 ngày tới.');
      }
      const endsAt = input.endsAt?.getTime() ?? NaN;
      if (mode === 'HOTEL' && (!Number.isFinite(endsAt) || endsAt <= startsAt || endsAt > startsAt + 30 * dayMs)) {
        throw new BadRequestException('Thời gian trả phòng phải sau giờ nhận phòng và cách tối đa 30 ngày.');
      }
      const booking = await BookingRequest.insertOne({ ...scope, ...input,
        endsAt: mode === 'HOTEL' ? input.endsAt : undefined }, { session });
      return { id: booking.id };
    });
  }
}

@Controller('tenants/:tenantId/branches/:branchId/booking-requests')
export class BookingRequestsController {
  @Get()
  async list(@Req() req: Request, @Param('tenantId') tenantId: string, @Param('branchId') branchId: string, @Query() query: unknown) {
    const { scope, branch } = await access(req, tenantId, branchId, 'bookings.manage');
    const { status, page } = read(queueQuery, query);
    const items = await BookingRequest.find({ ...scope, status })
      .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize + 1)
      .select('guestName phone startsAt endsAt partySize note createdAt').lean();
    return { enabled: !!branch.onlineBookingEnabled, items: items.slice(0, pageSize), hasMore: items.length > pageSize && page < 1000 };
  }

  @Patch('settings')
  async settings(@Req() req: Request, @Param('tenantId') tenantId: string, @Param('branchId') branchId: string, @Body() body: unknown) {
    verifyOrigin(req);
    const { enabled } = read(z.object({ enabled: z.boolean() }).strict(), body);
    return transaction(async session => {
      const { scope } = await access(req, tenantId, branchId, 'bookings.configure', session);
      await Branch.updateOne({ _id: scope.branchId, tenantId: scope.tenantId }, { $set: { onlineBookingEnabled: enabled } }, { session });
      return { enabled };
    });
  }

  @Patch(':id')
  async review(@Req() req: Request, @Param('tenantId') tenantId: string, @Param('branchId') branchId: string,
    @Param('id') id: string, @Body() body: unknown) {
    verifyOrigin(req);
    const { status } = read(z.object({ status: z.enum(['CONFIRMED', 'DECLINED']) }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, tenantId, branchId, 'bookings.manage', session);
      const booking = await BookingRequest.findOneAndUpdate({ ...scope, _id: read(objectId, id), status: 'PENDING' },
        { $set: { status, reviewedBy: actorId } }, { session, returnDocument: 'after' }).select('status').lean();
      if (!booking) throw new ConflictException('Yêu cầu này đã được xử lý hoặc không còn khả dụng.');
      return booking;
    });
  }
}
