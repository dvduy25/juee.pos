import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { staffPayUnits } from '../models';
import { facilityToday } from './membership-plans';

export type PayrollRate = { effectiveOn: string; unit: typeof staffPayUnits[number]; rate: number; overtimeRate: number; shiftMinutes?: number | null };
export type WorkTime = {
  _id: unknown; scheduleId?: unknown; scheduleTitle?: string | null;
  checkedInAt: Date; checkedOutAt?: Date | null; scheduledStartsAt?: Date | null; scheduledEndsAt?: Date | null;
  scheduledKind?: 'FIXED' | 'FLEXIBLE' | null; scheduledTargetMinutes?: number | null;
  payrollPaymentId?: unknown; status: string;
};

const minute = 60_000;

export function calculatePayroll(records: WorkTime[], rateHistory: PayrollRate[], now = new Date()) {
  const rates = [...rateHistory].sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn));
  const groups = new Map<string, WorkTime[]>();
  for (const record of records) {
    const key = record.scheduleId ? `shift:${record.scheduleId}` : `work:${record._id}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const lines = [];
  const skipped = { alreadyPaid: 0, open: 0, noRate: 0, noShift: 0, invalid: 0 };
  for (const group of groups.values()) {
    const first = group[0];
    const day = facilityToday(+(first.scheduledStartsAt ?? first.checkedInAt));
    if (group.some(record => record.payrollPaymentId)) { skipped.alreadyPaid++; continue; }
    if ((first.scheduledEndsAt && first.scheduledEndsAt > now) || group.some(record => record.status === 'OPEN')) {
      skipped.open++; continue;
    }
    const terms = rates.find(rate => rate.effectiveOn <= day);
    if (!terms) { skipped.noRate++; continue; }
    const start = first.scheduledStartsAt?.getTime();
    const end = first.scheduledEndsAt?.getTime();
    const shiftMinutes = terms.unit === 'SHIFT' ? terms.shiftMinutes : undefined;
    const target = shiftMinutes ?? (first.scheduledKind === 'FLEXIBLE' ? first.scheduledTargetMinutes : undefined);
    if (terms.unit === 'SHIFT' && !first.scheduleId) { skipped.noShift++; continue; }
    if ((first.scheduleId && (start === undefined || end === undefined || end <= start)) ||
      (target != null && (!Number.isInteger(target) || target <= 0 || target > 1440)) || group.some(record =>
      !record.checkedOutAt || record.checkedOutAt < record.checkedInAt || record.checkedOutAt > now ||
      record.scheduledStartsAt?.getTime() !== start || record.scheduledEndsAt?.getTime() !== end ||
      (record.scheduledKind ?? 'FIXED') !== (first.scheduledKind ?? 'FIXED') ||
      (record.scheduledTargetMinutes ?? null) !== (first.scheduledTargetMinutes ?? null))) {
      skipped.invalid++; continue;
    }
    let regularMs = 0;
    let overtimeMs = 0;
    for (const record of group) {
      const checkedIn = +record.checkedInAt;
      const checkedOut = +record.checkedOutAt!;
      const regularEnd = target ? checkedOut : Math.min(checkedOut, end ?? checkedOut);
      regularMs += Math.max(0, regularEnd - Math.max(checkedIn, start ?? checkedIn));
      if (!target && end !== undefined) overtimeMs += Math.max(0, checkedOut - Math.max(checkedIn, end));
    }
    if (target) {
      overtimeMs = Math.max(0, regularMs - target * minute);
      regularMs -= overtimeMs;
    }
    const regularMinutes = Math.floor(regularMs / minute);
    const overtimeMinutes = Math.floor(overtimeMs / minute);
    const baseAmount = terms.unit === 'SHIFT' && shiftMinutes == null ? (regularMinutes > 0 ? terms.rate : 0) :
      Math.round(regularMinutes * terms.rate / (shiftMinutes ?? 60));
    const overtimeAmount = Math.round(overtimeMinutes * terms.overtimeRate / 60);
    if (baseAmount + overtimeAmount === 0) { skipped.invalid++; continue; }
    lines.push({ day, label: first.scheduleTitle ?? 'Ngoài lịch ca', attendanceIds: group.map(item => String(item._id)).sort(),
      unit: terms.unit, rate: terms.rate, overtimeRate: terms.overtimeRate, ...(shiftMinutes != null && { shiftMinutes }),
      regularMinutes, overtimeMinutes, baseAmount, overtimeAmount });
  }
  lines.sort((a, b) => a.day.localeCompare(b.day) || a.attendanceIds[0].localeCompare(b.attendanceIds[0]));
  const totals = lines.reduce((sum, line) => ({
    regularMinutes: sum.regularMinutes + line.regularMinutes, overtimeMinutes: sum.overtimeMinutes + line.overtimeMinutes,
    baseAmount: sum.baseAmount + line.baseAmount, overtimeAmount: sum.overtimeAmount + line.overtimeAmount,
  }), { regularMinutes: 0, overtimeMinutes: 0, baseAmount: 0, overtimeAmount: 0 });
  const amount = totals.baseAmount + totals.overtimeAmount;
  if (!Number.isSafeInteger(amount)) throw new BadRequestException('Số tiền lương vượt giới hạn. Hãy chọn kỳ ngắn hơn.');
  const revision = createHash('sha256').update(JSON.stringify(lines)).digest('hex');
  return { lines, ...totals, amount, skipped, revision };
}
