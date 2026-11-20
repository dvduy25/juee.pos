export function shiftDays(date: string, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function facilityToday(now = Date.now()) {
  return new Date(now + 7 * 3600000).toISOString().slice(0, 10);
}

export function memberPlanDaysRemaining(expiresOn: string | null | undefined, today: string) {
  if (!expiresOn) return undefined;
  const days = (Date.parse(expiresOn) - Date.parse(today)) / 86400000;
  return Number.isInteger(days) ? Math.max(0, days + 1) : undefined;
}

export function monthlyPlanExpiry(start: string, months: number) {
  const date = new Date(start);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const endOfMonth = new Date(date);
  endOfMonth.setUTCMonth(date.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day - 1, endOfMonth.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

type Enrollment<T = unknown> = { planId: T; kind: 'MONTH' | 'DAY' | 'VISITS'; startsOn: string; expiresOn?: string | null; remaining?: number | null };

export function nextMemberEnrollment<T>(plan: { _id: T; name: string; kind: Enrollment['kind']; units: number; price?: number | null; validityMonths?: number | null },
  current: Enrollment | null | undefined, today: string): Enrollment<T> & { planName: string; price?: number } {
  const same = current?.kind === plan.kind && String(current.planId) === String(plan._id) && (!current.expiresOn || current.expiresOn >= today)
    ? current : undefined;
  const planFields = { planId: plan._id, planName: plan.name, kind: plan.kind, price: plan.price ?? undefined, startsOn: same?.startsOn ?? today };
  const nextStart = same?.expiresOn ? shiftDays(same.expiresOn, 1) : today;
  if (plan.kind === 'VISITS') {
    return { ...planFields, remaining: (same?.remaining ?? 0) + plan.units,
      expiresOn: plan.validityMonths ? monthlyPlanExpiry(nextStart, plan.validityMonths) : undefined };
  }
  return { ...planFields, expiresOn: plan.kind === 'DAY' ? shiftDays(nextStart, plan.units - 1) : monthlyPlanExpiry(nextStart, plan.units) };
}

export const memberAccessStates = ['ACTIVE', 'PAUSED', 'FROZEN', 'PENDING', 'EXPIRED', 'NO_VISITS', 'NO_PLAN'] as const;

export function memberAccessStatus(member: { active: boolean; expiresOn?: string | null;
  freeze?: { startsOn: string; resumesOn: string } | null;
  enrollment?: Pick<Enrollment, 'kind' | 'startsOn' | 'expiresOn' | 'remaining'> | null }, today: string) {
  if (!member.active) return 'PAUSED';
  if (member.freeze && member.freeze.startsOn <= today && today < member.freeze.resumesOn) return 'FROZEN';
  const { enrollment } = member;
  if (enrollment?.startsOn && enrollment.startsOn > today) return 'PENDING';
  const expiry = enrollment?.expiresOn ?? member.expiresOn;
  if (expiry && expiry < today) return 'EXPIRED';
  if (enrollment?.kind === 'VISITS') return (enrollment.remaining ?? 0) > 0 ? 'ACTIVE' : 'NO_VISITS';
  if (!expiry) return 'NO_PLAN';
  return 'ACTIVE';
}

export function membershipStatusExpression(today: string) {
  const expiry = { $ifNull: ['$enrollment.expiresOn', '$expiresOn', ''] };
  return { $switch: { branches: [
    { case: { $ne: ['$active', true] }, then: 'PAUSED' },
    { case: { $and: [{ $lte: ['$freeze.startsOn', today] }, { $gt: ['$freeze.resumesOn', today] }] }, then: 'FROZEN' },
    { case: { $gt: ['$enrollment.startsOn', today] }, then: 'PENDING' },
    { case: { $and: [{ $ne: [expiry, ''] }, { $lt: [expiry, today] }] }, then: 'EXPIRED' },
    { case: { $eq: ['$enrollment.kind', 'VISITS'] },
      then: { $cond: [{ $gt: ['$enrollment.remaining', 0] }, 'ACTIVE', 'NO_VISITS'] } },
    { case: { $eq: [expiry, ''] }, then: 'NO_PLAN' },
  ], default: 'ACTIVE' } };
}
