import { BadRequestException } from '@nestjs/common';
import { facilityToday } from './membership-plans';

export const hotelHour = 3_600_000;
export const hotelMidnight = (day: string) => new Date(`${day}T00:00:00+07:00`);
export const hotelNoon = (day: string) => new Date(`${day}T12:00:00+07:00`);

export function isStayDate(value: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function stayNights(startsOn: string, endsOn: string) {
  const nights = (Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000;
  if (!isStayDate(startsOn) || !isStayDate(endsOn) || nights < 1 || nights > 365) {
    throw new BadRequestException('Chọn ngày trả phòng sau ngày nhận phòng, tối đa 365 đêm.');
  }
  return nights;
}

export function stayOverlap(startsOn: string, endsOn: string) {
  return { startsOn: { $lt: endsOn }, endsOn: { $gt: startsOn } };
}

export function stayWindowOverlap(start: Date, end: Date | null, now = new Date()) {
  const startsAt = end ? { $lt: end } : { $ne: null };
  const startDay = facilityToday(+start);
  const endDay = end && facilityToday(+end);
  return { $or: [
    { startsAt, endsAt: { $gt: start } },
    { startsAt, endsAt: null, bookingType: 'HOURLY' as const,
      $or: [{ status: 'CHECKED_IN' as const }, { endsOn: { $gte: facilityToday(+now) } }] },
    { startsAt: null, endsOn: start < hotelNoon(startDay) ? { $gte: startDay } : { $gt: startDay },
      ...(end && endDay && { startsOn: end <= hotelNoon(endDay) ? { $lt: endDay } : { $lte: endDay } }) },
  ] };
}

type Charge = { quantity: number; unitPrice: number };
type HotelFare = {
  bookingType?: string | null; status?: string; nightlyRate: number; startsOn: string; endsOn: string;
  hourlyRate?: number | null; hourlyNextRate?: number | null; packagePrice?: number | null; durationHours?: number | null;
  endsAt?: Date | null; checkedInAt?: Date | null; billedHours?: number | null;
  overdueHours?: number | null; overdueAmount?: number | null; charges?: readonly Charge[];
};

export const hotelNextRate = (room?: Pick<HotelFare, 'hourlyRate' | 'hourlyNextRate'> | null) =>
  room?.hourlyNextRate ?? room?.hourlyRate ?? 0;

export function hotelDueAt(booking: Pick<HotelFare, 'bookingType' | 'endsOn' | 'endsAt'>) {
  if (booking.bookingType === 'HOURLY') return null;
  return booking.bookingType === 'PACKAGE' ? booking.endsAt ?? null : hotelNoon(booking.endsOn);
}

export function stayTotal(rate: number, units: number, charges: readonly Charge[]) {
  const total = charges.reduce((sum, charge) => sum + charge.quantity * charge.unitPrice, rate * units);
  if (!Number.isSafeInteger(total)) throw new BadRequestException('Tổng tiền lưu trú vượt giới hạn.');
  return total;
}

export function quoteHotelStay(booking: HotelFare, now: Date, fallbackNextRate = 0) {
  const hourly = booking.bookingType === 'HOURLY';
  const liveHourly = hourly && (booking.durationHours == null || booking.hourlyNextRate != null);
  const current = booking.status === 'CHECKED_IN';
  const nextHourRate = booking.hourlyNextRate ?? (hourly ? booking.hourlyRate ?? 0 : fallbackNextRate);
  const billedHours = hourly ? booking.billedHours ?? (liveHourly && current && booking.checkedInAt ?
    Math.max(1, Math.ceil((+now - +booking.checkedInAt) / hotelHour)) : booking.durationHours ?? 1) : undefined;
  const dueAt = hotelDueAt(booking);
  const overdue = !!(current && dueAt && now > dueAt);
  const overdueHours = overdue ? Math.ceil((+now - +dueAt!) / hotelHour) : booking.overdueHours ?? 0;
  const overdueAmount = booking.overdueAmount ?? stayTotal(nextHourRate, overdueHours, []);
  const baseAmount = hourly ? (booking.hourlyRate ?? 0) + ((billedHours ?? 1) - 1) * nextHourRate :
    booking.bookingType === 'PACKAGE' ? booking.packagePrice ?? 0 :
      booking.nightlyRate * stayNights(booking.startsOn, booking.endsOn);
  return { baseAmount, amount: stayTotal(baseAmount + overdueAmount, 1, booking.charges ?? []),
    billedHours, nextHourRate, overdue, overdueHours, overdueAmount, dueAt };
}

