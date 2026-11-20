import { date } from './format';
import type { PaymentMethod } from '@/features/dashboard/service-payment';

export const roomStates = { READY: 'Sẵn sàng', CLEANING: 'Chờ dọn', MAINTENANCE: 'Bảo trì' };
export const bookingStates = { RESERVED: 'Đã đặt', CHECKED_IN: 'Đang lưu trú', CHECKED_OUT: 'Đã trả phòng', CANCELED: 'Đã hủy', NO_SHOW: 'Khách không đến' };
export const bookingTypes = { NIGHTLY: 'Qua đêm', HOURLY: 'Theo giờ', PACKAGE: 'Combo' };
export const calendarDate = (day: string) => day.split('-').reverse().join('/');
export const hourMs = 3_600_000;
export const dayMs = 24 * hourMs;
export const hotelDay = (now = Date.now()) => new Date(now + 7 * hourMs).toISOString().slice(0, 10);

export type BookingType = keyof typeof bookingTypes;
export type Room = { id: string; code: string; category: string; capacity: number; nightlyRate?: number | null; hourlyRate?: number | null; hourlyNextRate?: number | null;
  state: keyof typeof roomStates; occupiedBy?: Pick<Booking, 'id' | 'guestName' | 'overdue' | 'dueAt' | 'bookingType'>;
  expectedToday: boolean; available: boolean };
export type HotelPackage = { id: string; name: string; price: number; durationHours: number; active: boolean };
export type Charge = { id: string; name: string; quantity: number; unitPrice: number };
export type Booking = { id: string; roomId: string; roomCode: string; guestName: string; phone?: string; guestCount: number; nightlyRate: number;
  startsOn: string; endsOn: string; amount: number; note?: string; status: keyof typeof bookingStates;
  bookingType?: BookingType; startsAt?: string; endsAt?: string | null; durationHours?: number | null; hourlyRate?: number | null;
  hourlyNextRate?: number | null; nextHourRate?: number; billedHours?: number; baseAmount?: number;
  overdue?: boolean; overdueHours?: number; overdueAmount?: number; dueAt?: string | null;
  packageId?: string; packageName?: string; packagePrice?: number;
  checkedInAt?: string; checkedOutAt?: string; paidAt?: string; paymentMethod?: PaymentMethod; closedReason?: string; charges?: Charge[] };

export function bookingWindow(booking: Pick<Booking, 'startsAt' | 'endsAt' | 'startsOn' | 'endsOn' | 'checkedInAt' | 'checkedOutAt' | 'paidAt'>) {
  if (booking.startsAt && !booking.endsAt) {
    const start = booking.checkedInAt ?? booking.startsAt;
    const end = booking.checkedOutAt ?? booking.paidAt;
    return end ? `${date(start)} – ${date(end)}` : `Nhận ${date(start)} · Chưa hẹn giờ trả`;
  }
  return booking.startsAt && booking.endsAt ? `${date(booking.startsAt)} – ${date(booking.endsAt)}` :
    `${calendarDate(booking.startsOn)} – ${calendarDate(booking.endsOn)}`;
}

export function canCheckIn(booking: Booking, now = Date.now()) {
  if (booking.status !== 'RESERVED') return false;
  const today = hotelDay(now);
  const end = booking.endsAt ?? booking.dueAt;
  const started = booking.startsAt ? Date.parse(booking.startsAt) <= now : today >= booking.startsOn;
  return started && (end ? Date.parse(end) > now : today === booking.startsOn);
}

export function bookingBase(booking: Booking) {
  if (booking.bookingType === 'PACKAGE') return { label: booking.packageName ?? 'Gói lưu trú', total: booking.packagePrice ?? 0 };
  if (booking.bookingType === 'HOURLY') {
    const hours = booking.billedHours ?? booking.durationHours ?? 1;
    const first = booking.hourlyRate ?? 0;
    const next = booking.nextHourRate ?? booking.hourlyNextRate ?? first;
    return { label: `${hours} giờ`, total: booking.baseAmount ?? first + (hours - 1) * next };
  }
  const nights = (Date.parse(booking.endsOn) - Date.parse(booking.startsOn)) / dayMs;
  return { label: `${nights} đêm`, total: booking.nightlyRate * nights };
}

export const roomNextHourRate = (room: Pick<Room, 'hourlyRate' | 'hourlyNextRate'>) => room.hourlyNextRate ?? room.hourlyRate ?? 0;
