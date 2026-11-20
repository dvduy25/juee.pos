import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ClientSession, InferSchemaType } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange, type Scope } from '../middleware/business-access';
import { HotelBooking, HotelPackage, HotelRoom, hotelBookingStates, hotelRoomStates, recordedPaymentMethods } from '../models';
import { scopedRoute } from '../routes/branch';
import { facilityToday, shiftDays } from '../services/membership-plans';
import { hotelDueAt, hotelHour, hotelMidnight, hotelNextRate, hotelNoon, isStayDate, quoteHotelStay, stayNights, stayWindowOverlap } from '../services/hotel-stays';
import { idempotent } from '../services/sales';
import { found, isDuplicate, localFilter } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { pageSchema } from '../validators/sales';

type Route = { tenantId: string; branchId: string; id: string };
const roomCode = z.string().trim().min(1).max(30).transform(value => value.toUpperCase());
const guestCount = z.number().int().min(1).max(100);
const roomInput = z.object({ code: roomCode, category: label, capacity: guestCount,
  nightlyRate: vnd.nullable().optional(), hourlyRate: vnd.nullable().optional(), hourlyNextRate: vnd.nullable().optional() }).strict();
const stayDate = z.string().refine(isStayDate, 'Ngày lưu trú không hợp lệ.');
const stayTime = z.string().datetime({ offset: true }).transform(value => new Date(value));
const stayHours = z.number().int().min(1).max(8760);
const nightCount = z.number().int().min(1).max(365);
const packageInput = z.object({ name: label, price: vnd, durationHours: stayHours, active: z.boolean().default(true) }).strict();
const guestInput = z.object({ roomId: objectId, guestName: label, phone: z.string().trim().max(30).optional(),
  guestCount, note: z.string().trim().max(500).optional() });
const arrivalMode = z.enum(['ADVANCE', 'NOW']).optional();
const bookingInput = z.union([
  guestInput.extend({ bookingType: z.literal('NIGHTLY').optional(), startsOn: stayDate.optional(), endsOn: stayDate.optional(),
    expectedNightlyRate: vnd, expectedHourlyNextRate: vnd.optional(), startsAt: stayTime.optional(), nights: nightCount.optional(), arrivalMode }).strict(),
  guestInput.extend({ bookingType: z.literal('HOURLY'), startsAt: stayTime.optional(), durationHours: stayHours.nullish(), expectedHourlyRate: vnd,
    expectedHourlyNextRate: vnd.optional(), arrivalMode }).strict(),
  guestInput.extend({ bookingType: z.literal('PACKAGE'), startsAt: stayTime.optional(), packageId: objectId,
    expectedPackagePrice: vnd, expectedPackageHours: stayHours, expectedHourlyNextRate: vnd.optional(), arrivalMode }).strict(),
]);
type Booking = InferSchemaType<typeof HotelBooking.schema>;
const bookingStates = ['RESERVED', 'CHECKED_IN'] as const;
const chargeInput = z.object({ name: label, quantity: z.number().int().min(1).max(1000), unitPrice: vnd.refine(price => price > 0) }).strict();
function dueArrivals(now: Date) {
  const day = facilityToday(+now);
  return { $or: [
    { startsAt: { $lte: now }, endsAt: { $gt: now } },
    { bookingType: 'HOURLY' as const, startsAt: { $lte: now }, endsAt: null, endsOn: { $gte: day } },
    { startsAt: null, startsOn: { $lte: day }, endsOn: now < hotelNoon(day) ? { $gte: day } : { $gt: day } },
  ] };
}

function dueDepartures(now: Date) {
  const day = facilityToday(+now);
  return { $or: [
    { bookingType: { $in: ['PACKAGE', 'NIGHTLY'] as const }, endsAt: { $lt: now } },
    { startsAt: null, endsOn: now > hotelNoon(day) ? { $lte: day } : { $lt: day } },
  ] };
}

function occupancyWindow(start: Date, end: Date | null, now: Date) {
  const startDay = facilityToday(+start);
  return { $or: [...stayWindowOverlap(start, end, now).$or, {
    status: 'CHECKED_IN' as const, $or: [
      ...dueDepartures(now).$or, { endsAt: { $lte: now } },
      // A nightly guest can arrive before noon if the room was free.
      { startsAt: null, checkedInAt: end ? { $lt: end } : { $ne: null },
        endsOn: start < hotelNoon(startDay) ? { $gte: startDay } : { $gt: startDay } },
    ],
  }] };
}

function stayInterval(startsOn: string, endsOn: string) {
  stayNights(startsOn, endsOn);
  return { start: hotelNoon(startsOn), end: hotelNoon(endsOn) };
}

async function lockRoomCalendar(scope: Scope, roomId: string | Booking['roomId'], session: ClientSession) {
  // A shared write serializes availability checks for the same room across transactions.
  return found(await HotelRoom.findOneAndUpdate({ ...scope, _id: roomId }, { $inc: { calendarRevision: 1 } },
    { session, timestamps: false }).lean(), 'Không tìm thấy phòng.');
}

type RoomRates = Pick<InferSchemaType<typeof HotelRoom.schema>, 'nightlyRate' | 'hourlyRate' | 'hourlyNextRate'>;

async function bookingTerms(scope: Scope, input: z.output<typeof bookingInput>, room: RoomRates,
  session: ClientSession, now: Date, existing?: Booking) {
  const bookingType = input.bookingType ?? 'NIGHTLY';
  if (existing && (existing.bookingType ?? 'NIGHTLY') !== bookingType) throw new ConflictException('Hình thức đặt phòng đã được lưu.');
  const saved = existing?.roomId.equals(input.roomId) ? existing : undefined;
  const nextHourRate = saved?.hourlyNextRate ?? hotelNextRate(room);
  const checkNextRate = (rate: number) => {
    if (input.expectedHourlyNextRate !== undefined && input.expectedHourlyNextRate !== rate) {
      throw new ConflictException('Giá giờ tiếp theo vừa thay đổi. Hãy kiểm tra lại.');
    }
  };

  if ('expectedNightlyRate' in input) {
    const rate = saved?.nightlyRate ?? room.nightlyRate;
    if (rate == null) throw new ConflictException('Phòng này chưa có giá theo đêm.');
    if (input.expectedNightlyRate !== rate) throw new ConflictException('Giá phòng vừa thay đổi. Hãy kiểm tra lại tiền phòng.');
    checkNextRate(nextHourRate);
    const startsAt = input.arrivalMode === 'NOW' ? now : input.startsAt ?? (existing?.startsAt && input.startsOn ?
      input.startsOn === existing.startsOn ? existing.startsAt : hotelNoon(input.startsOn) : undefined);
    const startsOn = startsAt ? facilityToday(+startsAt) : input.startsOn;
    const endsOn = input.arrivalMode === 'NOW' && input.nights && startsOn ? shiftDays(startsOn, input.nights) : input.endsOn;
    if (!startsOn || !endsOn) throw new BadRequestException('Chọn ngày nhận và ngày trả phòng.');
    const { start, end } = stayInterval(startsOn, endsOn);
    return { start: startsAt ?? start, end, fields: { bookingType, startsOn, endsOn,
      ...(startsAt && { startsAt, endsAt: end }), nightlyRate: rate, hourlyNextRate: nextHourRate } };
  }
  if (input.bookingType === 'HOURLY') {
    const startsAt = input.startsAt ?? existing?.startsAt ?? now;
    const durationHours = input.startsAt ? input.durationHours ?? existing?.durationHours ?? null : existing?.durationHours ?? null;
    const endsAt = durationHours == null ? null : new Date(+startsAt + durationHours * hotelHour);
    const rate = saved?.hourlyRate ?? room.hourlyRate;
    if (rate == null) throw new ConflictException('Phòng này chưa có giá giờ đầu.');
    if (rate !== input.expectedHourlyRate) throw new ConflictException('Giá giờ đầu vừa thay đổi. Hãy kiểm tra lại.');
    // Previously reserved fixed-hour stays retain their original pricing.
    const liveBilling = durationHours == null || (existing ? existing.hourlyNextRate != null : input.arrivalMode === 'ADVANCE' || input.expectedHourlyNextRate !== undefined);
    checkNextRate(liveBilling ? nextHourRate : rate);
    return { start: startsAt, end: endsAt, fields: { bookingType, startsAt, endsAt, startsOn: facilityToday(+startsAt),
      endsOn: facilityToday(+(endsAt ?? startsAt)), nightlyRate: 0, hourlyRate: rate,
      hourlyNextRate: liveBilling ? nextHourRate : undefined, durationHours } };
  }

  if (existing && !existing.packageId?.equals(input.packageId)) throw new ConflictException('Gói của đặt phòng đã được lưu.');
  const plan = existing ? { name: existing.packageName!, price: existing.packagePrice!, durationHours: existing.durationHours! } :
    found(await HotelPackage.findOne({ ...scope, _id: input.packageId, active: true }).session(session).lean(), 'Gói lưu trú không còn áp dụng.');
  if (plan.price !== input.expectedPackagePrice || plan.durationHours !== input.expectedPackageHours) {
    throw new ConflictException('Giá hoặc thời lượng của gói vừa thay đổi. Hãy chọn lại gói.');
  }
  checkNextRate(nextHourRate);
  const startsAt = input.arrivalMode === 'NOW' ? now : input.startsAt;
  if (!startsAt) throw new BadRequestException('Chọn ngày và giờ nhận phòng.');
  const endsAt = new Date(+startsAt + plan.durationHours * hotelHour);
  return { start: startsAt, end: endsAt, fields: { bookingType, startsAt, endsAt, startsOn: facilityToday(+startsAt),
    endsOn: facilityToday(+endsAt), nightlyRate: 0, hourlyNextRate: nextHourRate, durationHours: plan.durationHours,
    packageId: input.packageId, packageName: plan.name, packagePrice: plan.price } };
}

function needsRoomRate(booking: Pick<Parameters<typeof quoteHotelStay>[0], 'bookingType' | 'hourlyNextRate' | 'status'>) {
  return booking.bookingType !== 'HOURLY' && booking.hourlyNextRate == null &&
    (booking.status === 'CHECKED_IN' || booking.status === 'RESERVED');
}

async function quotedBookings<T extends Parameters<typeof quoteHotelStay>[0] & Pick<Booking, 'roomId' | 'status' | 'amount'>>(
  scope: Scope, bookings: T[], now: Date, session?: ClientSession,
) {
  const roomIds = bookings.filter(needsRoomRate).map(booking => booking.roomId);
  const rooms = roomIds.length ? await HotelRoom.find({ ...scope, _id: { $in: roomIds } })
    .select('hourlyRate hourlyNextRate').session(session ?? null).lean() : [];
  const rates = new Map(rooms.map(room => [String(room._id), hotelNextRate(room)]));
  return bookings.map(booking => {
    const quote = quoteHotelStay(booking, now, rates.get(String(booking.roomId)));
    return { ...booking, ...quote, amount: booking.status === 'CHECKED_OUT' ? booking.amount : quote.amount };
  });
}

function arrivalWindow(booking: Booking, now: Date) {
  const start = booking.startsAt ?? hotelMidnight(booking.startsOn);
  const end = booking.bookingType === 'HOURLY' ? booking.endsAt ?? hotelMidnight(shiftDays(booking.startsOn, 1)) : hotelDueAt(booking);
  return now >= start && (!end || now < end);
}

async function hotelAccess(req: Request, route: Route, session?: ClientSession, manage = false) {
  const result = await access(req, route.tenantId, route.branchId, manage ? 'hotel.manage' : 'hotel.operate', session);
  if (result.branch.mode !== 'HOTEL') throw new ConflictException('Chi nhánh này chưa dùng mô hình Nhà nghỉ / Khách sạn.');
  return result;
}

@Controller(scopedRoute)
export class HotelController {
  @Get('hotel-calendar')
  async calendar(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await hotelAccess(req, route);
    const { day } = read(z.object({ day: stayDate.default(facilityToday()) }), query);
    const end = shiftDays(day, 7);
    const [rooms, bookings] = await Promise.all([
      HotelRoom.find(scope).select('code category state').sort('code _id').lean(),
      HotelBooking.find({ ...scope, status: { $in: [...bookingStates, 'CHECKED_OUT'] },
        startsOn: { $lt: end }, $or: [{ endsOn: { $gte: day } }, { status: 'CHECKED_IN' }, { checkedOutAt: { $gte: hotelMidnight(day) } }] })
        .select('roomId roomCode guestName status startsOn endsOn bookingType startsAt endsAt checkedOutAt paidAt').sort('startsOn startsAt _id').lean(),
    ]);
    const now = new Date();
    return { rooms, bookings: bookings.map(booking => {
      const dueAt = hotelDueAt(booking);
      return { ...booking, dueAt, overdue: booking.status === 'CHECKED_IN' && !!dueAt && now > dueAt,
        occupiedUntil: booking.status === 'CHECKED_IN' ? facilityToday(+now) :
          booking.checkedOutAt ? facilityToday(+booking.checkedOutAt) : booking.endsOn };
    }) };
  }

  @Get('hotel-front-desk')
  async frontDesk(@Req() req: Request, @Param() route: Route) {
    const { scope } = await hotelAccess(req, route);
    const now = new Date();
    const [arrivals, departures, occupied] = await Promise.all([
      HotelBooking.countDocuments({ ...scope, status: 'RESERVED', ...dueArrivals(now) }),
      HotelBooking.countDocuments({ ...scope, status: 'CHECKED_IN', ...dueDepartures(now) }),
      HotelBooking.countDocuments({ ...scope, status: 'CHECKED_IN' }),
    ]);
    return { arrivals, departures, occupied };
  }

  @Get('hotel-rooms')
  async rooms(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await hotelAccess(req, route);
    const dates = read(z.union([
      z.object({ startsOn: stayDate, endsOn: stayDate, excludeBookingId: objectId.optional() }).strict(),
      z.object({ startsAt: stayTime, endsAt: stayTime, excludeBookingId: objectId.optional() }).strict(),
      z.object({ startsAt: stayTime, openEnded: z.literal('true'), excludeBookingId: objectId.optional() }).strict(),
      z.object({ openHourly: z.literal('true'), excludeBookingId: objectId.optional() }).strict(),
      z.object({ checkInNow: z.literal('true'), nights: z.coerce.number().pipe(nightCount) }).strict(),
      z.object({ checkInNow: z.literal('true'), durationHours: z.coerce.number().pipe(stayHours) }).strict(),
      z.object({ excludeBookingId: objectId.optional(), view: z.literal('manage').optional() }).strict(),
    ]), query);
    const now = new Date();
    const today = facilityToday(+now);
    const immediate = 'openHourly' in dates || 'checkInNow' in dates;
    const interval = 'startsOn' in dates ? stayInterval(dates.startsOn, dates.endsOn) :
      'startsAt' in dates ? { start: dates.startsAt, end: 'endsAt' in dates ? dates.endsAt : null } :
      immediate ? { start: now, end: 'nights' in dates ? hotelNoon(shiftDays(today, dates.nights)) :
        'durationHours' in dates ? new Date(+now + dates.durationHours * hotelHour) : null } : undefined;
    if (interval?.end && interval.end <= interval.start) throw new BadRequestException('Giờ trả phòng phải sau giờ nhận phòng.');
    const [rooms, occupancy, overlapping] = await Promise.all([
      HotelRoom.find(scope).sort('code _id').lean(),
      HotelBooking.find({ ...scope, $or: [{ status: 'CHECKED_IN' }, { status: 'RESERVED', ...stayWindowOverlap(hotelMidnight(today), hotelMidnight(shiftDays(today, 1))) }] })
        .select('roomId guestName status bookingType endsOn endsAt').lean(),
      interval ? HotelBooking.find({ ...scope, status: { $in: bookingStates }, ...occupancyWindow(interval.start, interval.end, now),
        ...('excludeBookingId' in dates && dates.excludeBookingId && { _id: { $ne: dates.excludeBookingId } }) }).select('roomId').lean() : [],
    ]);
    const occupied = new Map(occupancy.filter(booking => booking.status === 'CHECKED_IN').map(booking => [String(booking.roomId), booking]));
    const arrivals = new Set(occupancy.filter(booking => booking.status === 'RESERVED').map(booking => String(booking.roomId)));
    const conflicts = new Set(overlapping.map(booking => String(booking.roomId)));
    return rooms.map(room => {
      const booking = occupied.get(String(room._id));
      const dueAt = booking && hotelDueAt(booking);
      return { ...room, occupiedBy: booking && { ...booking, dueAt, overdue: !!dueAt && now > dueAt },
        expectedToday: arrivals.has(String(room._id)),
        available: (immediate ? room.state === 'READY' && !booking : room.state !== 'MAINTENANCE') && !conflicts.has(String(room._id)) };
    });
  }

  @Get('hotel-packages')
  async packages(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { view } = read(z.object({ view: z.literal('manage').optional() }).strict(), query);
    const { scope } = await hotelAccess(req, route, undefined, view === 'manage');
    return HotelPackage.find({ ...scope, ...(!view && { active: true }) }).sort('name _id').lean();
  }

  @Post('hotel-packages')
  createPackage(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.savePackage(req, route, read(packageInput, body));
  }

  @Patch('hotel-packages/:id')
  updatePackage(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.savePackage(req, route, read(packageInput, body), read(objectId, route.id));
  }

  private savePackage(req: Request, route: Route, input: z.output<typeof packageInput>, id?: string) {
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session, true);
      const plan = found(id ? await HotelPackage.findOneAndUpdate({ ...scope, _id: id }, { $set: input },
        { returnDocument: 'after', session, runValidators: true }) :
        await HotelPackage.insertOne({ ...scope, ...input }, { session }), 'Không tìm thấy gói lưu trú.');
      await logChange(scope, actorId, id ? 'HOTEL_PACKAGE_UPDATE' : 'HOTEL_PACKAGE_CREATE', plan._id, session);
      return plan.toObject();
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tên gói đã được sử dụng tại chi nhánh.');
      throw error;
    });
  }

  @Post('hotel-rooms')
  createRoom(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(roomInput, body);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session, true);
      const room = await HotelRoom.insertOne({ ...scope, ...input }, { session });
      await logChange(scope, actorId, 'HOTEL_ROOM_CREATE', room._id, session);
      return room.toObject();
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mã phòng đã được sử dụng tại chi nhánh.');
      throw error;
    });
  }

  @Patch('hotel-rooms/:id')
  updateRoom(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const input = read(roomInput.extend({ state: z.enum(hotelRoomStates) }), body);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session, true);
      const room = found(await HotelRoom.findOne({ ...scope, _id: id }).session(session), 'Không tìm thấy phòng.');
      if (input.state !== room.state && await HotelBooking.exists({ ...scope, roomId: room._id, status: 'CHECKED_IN' }).session(session)) {
        throw new ConflictException('Phòng đang có khách. Hãy trả phòng trước khi đổi trạng thái dọn phòng hoặc bảo trì.');
      }
      if (input.capacity < room.capacity && await HotelBooking.exists({ ...scope, roomId: room._id, status: { $in: bookingStates },
        guestCount: { $gt: input.capacity } }).session(session)) {
        throw new ConflictException('Sức chứa mới thấp hơn số khách của một đặt phòng đang mở.');
      }
      room.set(input);
      await room.save({ session });
      await logChange(scope, actorId, 'HOTEL_ROOM_UPDATE', room._id, session);
      return room.toObject();
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mã phòng đã được sử dụng tại chi nhánh.');
      throw error;
    });
  }

  @Post('hotel-rooms/:id/ready')
  markReady(@Req() req: Request, @Param() route: Route) {
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session);
      const room = found(await HotelRoom.findOneAndUpdate({ ...scope, _id: id, state: 'CLEANING' }, { $set: { state: 'READY' } },
        { session, returnDocument: 'after' }).lean(), 'Không tìm thấy phòng đang chờ dọn.');
      await logChange(scope, actorId, 'HOTEL_ROOM_READY', room._id, session);
      return room;
    });
  }

  @Get('hotel-bookings')
  async bookings(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await hotelAccess(req, route);
    const { page, status, q } = read(z.object({ page: pageSchema,
      status: z.enum(['OPEN', 'TODAY', 'ARRIVALS', 'DEPARTURES', ...hotelBookingStates]).default('OPEN'),
      q: z.string().trim().max(120).optional() }), query);
    const now = new Date();
    const criteria = {
      OPEN: { status: { $in: bookingStates } },
      TODAY: { status: 'RESERVED', ...stayWindowOverlap(now, hotelMidnight(shiftDays(facilityToday(+now), 1)), now) },
      ARRIVALS: { status: 'RESERVED', ...dueArrivals(now) },
      DEPARTURES: { status: 'CHECKED_IN', ...dueDepartures(now) },
    } as const;
    const match = status === 'OPEN' || status === 'TODAY' || status === 'ARRIVALS' || status === 'DEPARTURES' ? criteria[status] : { status };
    const search = q && localFilter(q);
    const bookings = await HotelBooking.find({ ...scope, ...match, ...(search && { $and: [{ $or: [
      { guestName: search }, { phone: search }, { roomCode: search },
    ] }] }) }).sort(status === 'DEPARTURES' ? 'endsOn endsAt _id' : status in criteria || status === 'RESERVED' ? 'startsOn startsAt _id' : '-updatedAt -_id')
      .skip((page - 1) * 50).limit(50).lean();
    return quotedBookings(scope, bookings, now);
  }

  @Post('hotel-bookings')
  async reserve(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(bookingInput, body);
    const nightly = 'expectedNightlyRate' in input;
    if (input.arrivalMode === 'NOW' && (input.startsAt || (nightly && (!input.nights || input.startsOn || input.endsOn)) ||
      (input.bookingType === 'HOURLY' && input.durationHours != null))) {
      throw new BadRequestException('Nhận phòng ngay dùng thời điểm hiện tại. Với phòng qua đêm, hãy chọn số đêm.');
    }
    if (input.arrivalMode === 'ADVANCE' && (!input.startsAt || (nightly && (!input.endsOn || input.startsOn || input.nights)) ||
      (input.bookingType === 'HOURLY' && input.durationHours == null))) {
      throw new BadRequestException('Đặt trước cần ngày giờ nhận và thời gian lưu trú.');
    }
    const { scope, actorId } = await hotelAccess(req, route);
    const { roomId, ...guest } = guestInput.parse(input);
    // Keep the field order used by previous nightly reservation keys.
    const request = nightly && !input.bookingType && !input.arrivalMode && !input.startsAt ? { actorId, expectedNightlyRate: input.expectedNightlyRate,
      roomId, guestName: guest.guestName, phone: guest.phone, guestCount: guest.guestCount, startsOn: input.startsOn, endsOn: input.endsOn,
      note: guest.note } : { actorId, ...input };
    return idempotent(scope, 'HOTEL_BOOKING_CREATE', key, request, async session => {
      await hotelAccess(req, route, session);
      const room = await lockRoomCalendar(scope, roomId, session);
      if (room.state === 'MAINTENANCE') throw new ConflictException('Phòng đang bảo trì.');
      if (room.capacity < guest.guestCount) throw new ConflictException('Số khách vượt sức chứa của phòng.');
      const now = new Date();
      const immediate = input.arrivalMode === 'NOW' || (!input.arrivalMode && input.bookingType === 'HOURLY' && !input.startsAt);
      if (immediate && room.state !== 'READY') throw new ConflictException('Phòng chưa sẵn sàng nhận khách.');
      const { start, end, fields } = await bookingTerms(scope, input, room, session, now);
      if (input.arrivalMode === 'ADVANCE' ? start < now : fields.bookingType === 'NIGHTLY' ? fields.startsOn < facilityToday(+now) :
        +start < Math.floor(+now / 60_000) * 60_000) {
        throw new BadRequestException('Chọn thời gian nhận phòng từ hiện tại.');
      }
      const window = occupancyWindow(start, end, now);
      if (await HotelBooking.exists({ ...scope, roomId: room._id, status: { $in: bookingStates },
        $or: immediate ? [...window.$or, { status: 'CHECKED_IN' }] : window.$or }).session(session)) {
        throw new ConflictException('Phòng đã có đặt chỗ trùng thời gian. Hãy chọn phòng hoặc giờ khác.');
      }
      const booking = await HotelBooking.insertOne({ ...scope, ...guest, ...fields, roomId: room._id, roomCode: room.code,
        amount: quoteHotelStay(fields, now).amount, status: immediate ? 'CHECKED_IN' : 'RESERVED',
        ...(immediate && { checkedInAt: now }) }, { session });
      await logChange(scope, actorId, 'HOTEL_BOOKING_CREATE', booking._id, session);
      if (immediate) await logChange(scope, actorId, 'HOTEL_BOOKING_ARRIVE', booking._id, session);
      return booking.toObject();
    });
  }

  @Get('hotel-bookings/:id')
  async detail(@Req() req: Request, @Param() route: Route) {
    const { scope } = await hotelAccess(req, route);
    const booking = found(await HotelBooking.findOne({ ...scope, _id: read(objectId, route.id) }).lean(), 'Không tìm thấy đặt phòng.');
    return (await quotedBookings(scope, [booking], new Date()))[0];
  }

  @Patch('hotel-bookings/:id')
  amend(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const input = read(bookingInput, body);
    if (input.arrivalMode || ('nights' in input && input.nights != null)) throw new BadRequestException('Sửa thời gian trên lượt lưu trú hiện tại.');
    const { roomId, ...guest } = guestInput.parse(input);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session);
      const booking = found(await HotelBooking.findOne({ ...scope, _id: id, status: { $in: bookingStates } }).session(session),
        'Chỉ sửa đặt phòng đang mở.');
      const previousRoomId = String(booking.roomId);
      if (previousRoomId !== roomId && previousRoomId < roomId) await lockRoomCalendar(scope, previousRoomId, session);
      const room = await lockRoomCalendar(scope, roomId, session);
      if (previousRoomId !== roomId && previousRoomId > roomId) await lockRoomCalendar(scope, previousRoomId, session);
      if (room.state === 'MAINTENANCE') throw new ConflictException('Phòng đang bảo trì.');
      if (room.capacity < guest.guestCount) throw new ConflictException('Số khách vượt sức chứa của phòng.');
      const now = new Date();
      const { start, end, fields } = await bookingTerms(scope, input, room, session, now, booking);
      const sameStart = +start === +(booking.startsAt ?? hotelNoon(booking.startsOn));
      const previousEnd = booking.bookingType === 'HOURLY' ? booking.endsAt : hotelDueAt(booking);
      const sameEnd = (end ? +end : null) === (previousEnd ? +previousEnd : null);
      const currentBoundary = fields.bookingType === 'NIGHTLY' ? +hotelMidnight(facilityToday(+now)) : Math.floor(+now / 60_000) * 60_000;
      if (booking.status === 'CHECKED_IN' && (!booking.roomId.equals(room._id) || !sameStart || (!sameEnd && end && +end < currentBoundary))) {
        throw new ConflictException('Sau khi nhận phòng, giữ nguyên phòng và thời gian nhận. Thời gian trả mới phải từ hiện tại.');
      }
      if (booking.status === 'RESERVED' && ((end ? +end <= currentBoundary : fields.startsOn < facilityToday(+now)) || (+start < currentBoundary && !sameStart))) {
        throw new ConflictException('Đặt phòng phải còn hiệu lực. Thời gian nhận mới phải từ hiện tại.');
      }
      if (await HotelBooking.exists({ ...scope, _id: { $ne: booking._id }, roomId: room._id, status: { $in: bookingStates },
        ...occupancyWindow(start, end, now) }).session(session)) {
        throw new ConflictException('Phòng đã có đặt chỗ trùng thời gian.');
      }
      const from = { roomCode: booking.roomCode, start: booking.startsAt ?? booking.startsOn, end: booking.endsAt ?? booking.endsOn, amount: booking.amount };
      booking.set({ ...guest, ...fields, roomId: room._id, roomCode: room.code, amount: quoteHotelStay({ ...fields, status: booking.status, checkedInAt: booking.checkedInAt, charges: booking.charges }, now).amount });
      await booking.save({ session });
      await logChange(scope, actorId, 'HOTEL_BOOKING_AMEND', booking._id, session, {
        from, to: { roomCode: booking.roomCode, start: booking.startsAt ?? booking.startsOn, end: booking.endsAt ?? booking.endsOn, amount: booking.amount },
      });
      return booking.toObject();
    });
  }

  @Post('hotel-bookings/:id/charges')
  async addCharge(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = read(objectId, route.id);
    const input = read(chargeInput, body);
    const { scope, actorId } = await hotelAccess(req, route);
    return idempotent(scope, 'HOTEL_CHARGE_CREATE', key, { id, actorId, ...input }, async session => {
      await hotelAccess(req, route, session);
      const booking = found(await HotelBooking.findOne({ ...scope, _id: id, status: 'CHECKED_IN' }).session(session),
        'Chỉ thêm phụ phí cho khách đang lưu trú.');
      if (booking.charges.length >= 100) throw new ConflictException('Đặt phòng đã có tối đa 100 dòng phụ phí.');
      const charge = booking.charges.create({ ...input, actorId, createdAt: new Date() });
      booking.charges.push(charge);
      booking.amount = (await quotedBookings(scope, [booking.toObject()], new Date(), session))[0].amount;
      await booking.save({ session });
      await logChange(scope, actorId, 'HOTEL_CHARGE_CREATE', booking._id, session, { chargeId: charge._id, ...input });
      return booking.toObject();
    });
  }

  @Delete('hotel-bookings/:id/charges/:chargeId')
  removeCharge(@Req() req: Request, @Param() route: Route & { chargeId: string }) {
    const id = read(objectId, route.id);
    const chargeId = read(objectId, route.chargeId);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session, true);
      const booking = found(await HotelBooking.findOne({ ...scope, _id: id, status: 'CHECKED_IN' }).session(session),
        'Chỉ bỏ phụ phí trước khi trả phòng.');
      const charge = found(booking.charges.id(chargeId), 'Không tìm thấy phụ phí.');
      booking.charges.pull(chargeId);
      booking.amount = (await quotedBookings(scope, [booking.toObject()], new Date(), session))[0].amount;
      await booking.save({ session });
      await logChange(scope, actorId, 'HOTEL_CHARGE_REMOVE', booking._id, session, { chargeId, charge: charge.toObject() });
      return booking.toObject();
    });
  }

  @Post('hotel-bookings/:id/arrive')
  arrive(@Req() req: Request, @Param() route: Route) {
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session);
      const booking = found(await HotelBooking.findOne({ ...scope, _id: id }).session(session), 'Không tìm thấy đặt phòng.');
      if (booking.status === 'CHECKED_IN') return booking.toObject();
      const now = new Date();
      if (booking.status !== 'RESERVED' || !arrivalWindow(booking, now)) {
        throw new ConflictException('Chỉ nhận khách khi đã đến thời gian nhận và đặt phòng còn hiệu lực.');
      }
      const room = await lockRoomCalendar(scope, booking.roomId, session);
      if (room.state !== 'READY' || await HotelBooking.exists({ ...scope, roomId: room._id, status: 'CHECKED_IN' }).session(session)) {
        throw new ConflictException('Phòng chưa sẵn sàng nhận khách.');
      }
      const noon = hotelNoon(booking.startsOn);
      if (!booking.startsAt && now < noon && await HotelBooking.exists({ ...scope, roomId: room._id, _id: { $ne: booking._id },
        status: 'RESERVED', ...stayWindowOverlap(now, noon, now) }).session(session)) {
        throw new ConflictException('Phòng còn đặt chỗ trước giờ nhận. Hãy chọn phòng khác hoặc nhận từ 12:00.');
      }
      booking.set({ status: 'CHECKED_IN', checkedInAt: now,
        ...(needsRoomRate(booking) && { hourlyNextRate: hotelNextRate(room) }) });
      await booking.save({ session });
      await logChange(scope, actorId, 'HOTEL_BOOKING_ARRIVE', booking._id, session);
      return booking.toObject();
    });
  }

  @Post('hotel-bookings/:id/depart')
  async depart(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = read(objectId, route.id);
    const { expectedAmount, ...input } = read(z.object({ paymentMethod: z.enum(recordedPaymentMethods),
      expectedAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict(), body);
    const { scope, actorId } = await hotelAccess(req, route);
    return idempotent(scope, 'HOTEL_BOOKING_DEPART', key, { id, actorId, expectedAmount, ...input }, async session => {
      await hotelAccess(req, route, session);
      const booking = found(await HotelBooking.findOne({ ...scope, _id: id }).session(session), 'Không tìm thấy đặt phòng.');
      if (booking.status !== 'CHECKED_IN') throw new ConflictException('Chỉ thanh toán và trả phòng cho khách đang lưu trú.');
      const now = new Date();
      const quote = (await quotedBookings(scope, [booking.toObject()], now, session))[0];
      const variable = quote.overdueAmount > 0 || (booking.bookingType === 'HOURLY' && (booking.durationHours == null || booking.hourlyNextRate != null));
      if ((expectedAmount !== undefined || variable) && expectedAmount !== quote.amount) {
        throw new ConflictException('Số tiền đã thay đổi. Hãy kiểm tra lại tổng tiền trước khi xác nhận trả phòng.');
      }
      booking.set({ ...input, amount: quote.amount, status: 'CHECKED_OUT', paidAt: now, checkedOutAt: now, paidBy: actorId,
        billedHours: quote.billedHours, overdueHours: quote.overdueHours, overdueAmount: quote.overdueAmount,
        ...(needsRoomRate(booking) && { hourlyNextRate: quote.nextHourRate }) });
      await booking.save({ session });
      await HotelRoom.updateOne({ ...scope, _id: booking.roomId }, { $set: { state: 'CLEANING' } }, { session });
      await logChange(scope, actorId, 'HOTEL_BOOKING_DEPART', booking._id, session);
      return booking.toObject();
    });
  }

  @Post('hotel-bookings/:id/cancel')
  cancel(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { reason } = read(z.object({ reason: label.optional() }).strict(), body ?? {});
    return this.closeReservation(req, route, 'CANCELED', reason);
  }

  @Post('hotel-bookings/:id/no-show')
  noShow(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { reason } = read(z.object({ reason: label }).strict(), body);
    return this.closeReservation(req, route, 'NO_SHOW', reason);
  }

  private closeReservation(req: Request, route: Route, status: 'CANCELED' | 'NO_SHOW', reason?: string) {
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await hotelAccess(req, route, session, true);
      const booking = found(await HotelBooking.findOneAndUpdate({ ...scope, _id: id, status: 'RESERVED',
        ...(status === 'NO_SHOW' && { $or: [{ endsAt: { $lte: new Date() } }, { endsAt: null, startsOn: { $lt: facilityToday() } }] }) },
      { $set: { status, closedReason: reason } },
        { session, returnDocument: 'after' }).lean(), status === 'NO_SHOW' ?
        'Chưa đến thời điểm ghi khách không đến.' : 'Chỉ hủy đặt phòng chưa nhận khách.');
      await logChange(scope, actorId, status === 'NO_SHOW' ? 'HOTEL_BOOKING_NO_SHOW' : 'HOTEL_BOOKING_CANCEL', booking._id, session, { reason });
      return booking;
    });
  }
}
