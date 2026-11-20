import { BadRequestException } from '@nestjs/common';
import { facilityToday } from './membership-plans';

const dayMs = 86_400_000;

function validateShift(startsAt: Date, endsAt: Date) {
  const duration = +endsAt - +startsAt;
  if (!Number.isFinite(duration) || duration <= 0 || duration > dayMs) {
    throw new BadRequestException('Giờ kết thúc phải sau giờ bắt đầu. Mỗi ca tối đa 24 giờ.');
  }
}

function shiftOnOffset(startsAt: Date, endsAt: Date, offset: number) {
  return { startsAt: new Date(+startsAt + offset * dayMs), endsAt: new Date(+endsAt + offset * dayMs) };
}

export function expandStaffShiftRange(startsAt: Date, endsAt: Date, throughDate: string) {
  validateShift(startsAt, endsAt);
  const days = (Date.parse(throughDate) - Date.parse(facilityToday(+startsAt))) / dayMs + 1;
  if (!Number.isInteger(days) || days < 1) throw new BadRequestException('Đến ngày phải cùng hoặc sau Từ ngày.');
  if (days > 366) throw new BadRequestException('Mỗi lần xếp ca cố định tối đa 366 ngày.');
  return Array.from({ length: days }, (_, index) => shiftOnOffset(startsAt, endsAt, index));
}

export function expandStaffShifts(startsAt: Date, endsAt: Date, repeatWeeks: number, weekdays?: number[]) {
  validateShift(startsAt, endsAt);
  const firstWeekday = new Date(facilityToday(+startsAt)).getUTCDay();
  const selected = new Set(weekdays?.length ? weekdays : [firstWeekday]);
  const shifts = [];
  for (let day = 0; day < repeatWeeks * 7; day++) {
    if (!selected.has((firstWeekday + day) % 7)) continue;
    shifts.push(shiftOnOffset(startsAt, endsAt, day));
  }
  return shifts;
}

export function staffShiftOnDate(startsAt: Date, endsAt: Date, day: Date) {
  const offset = (Date.parse(facilityToday(+day)) - Date.parse(facilityToday(+startsAt))) / dayMs;
  return shiftOnOffset(startsAt, endsAt, offset);
}

export function staffShiftStatus(shift: { canceledAt?: Date | null; leaveAt?: Date | null; endsAt: Date },
  attendance?: { open: number }, now = new Date()) {
  if (shift.canceledAt) return 'CANCELED';
  if (shift.leaveAt) return 'LEAVE';
  if (attendance) return attendance.open ? 'WORKING' : 'ATTENDED';
  return shift.endsAt <= now ? 'ABSENT' : 'PLANNED';
}
