import { currency } from './format';

export type MemberPlan = { id: string; name: string; kind: 'MONTH' | 'DAY' | 'VISITS'; units: number; price?: number; validityMonths?: number | null; active: boolean };

export const unitLabels = { MONTH: 'tháng', DAY: 'ngày', VISITS: 'lượt' };
export const unitLimits = { MONTH: 120, DAY: 3650, VISITS: 100000 };
export const planUnits = (plan: MemberPlan) => `${plan.units} ${unitLabels[plan.kind]}${plan.validityMonths ? ` trong ${plan.validityMonths} tháng` : ''}`;
export const planPrice = (plan: MemberPlan) => typeof plan.price === 'number' ? currency.format(plan.price) : 'Chưa đặt giá';
