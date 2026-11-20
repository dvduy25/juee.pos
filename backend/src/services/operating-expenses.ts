import type { PipelineStage } from 'mongoose';
import type { Scope } from '../middleware/business-access';
import { expenseKinds } from '../models';

export type ExpenseKind = typeof expenseKinds[number];
export const expenseLabels: Record<ExpenseKind, string> = {
  STAFF: 'Tiền nhân viên', RENT: 'Tiền mặt bằng', UTILITIES: 'Điện nước', OTHER: 'Chi phí khác',
};
type CashRange = { $lte: Date; $gte?: Date };

export function cashEntryRange(scope: Scope, dates: CashRange) {
  return { ...scope, $or: [{ occurredAt: dates }, { occurredAt: null, createdAt: dates }] };
}

export const expenseGroup = { $group: {
  _id: { kind: '$expenseKind', category: { $cond: [{ $ifNull: ['$expenseKind', false] }, null, '$category'] } },
  count: { $sum: 1 }, total: { $sum: '$amount' },
} } satisfies PipelineStage.Group;

export type GroupedExpense = { _id: { kind?: ExpenseKind; category?: string }; count: number; total: number };

function expenseKind(category = ''): ExpenseKind {
  const normalized = category.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').trim();
  if (/^(tien )?(luong|nhan vien|nhan su|cong nhan vien)( |$)/.test(normalized)) return 'STAFF';
  if (/^(tien )?(thue )?(mat bang|van phong|nha xuong)( |$)/.test(normalized)) return 'RENT';
  if (/^(tien |hoa don )?(dien nuoc|dien|nuoc|dien sinh hoat|nuoc sinh hoat)( (thang|ky|chi nhanh|cua hang) .+)?$/.test(normalized)) return 'UTILITIES';
  return 'OTHER';
}

export function summarizeExpenses(groups: readonly GroupedExpense[]) {
  const items = expenseKinds.map(kind => ({ kind, label: expenseLabels[kind], count: 0, total: 0 }));
  const byKind = new Map(items.map(item => [item.kind, item]));
  for (const group of groups) {
    const kind = group._id.kind ?? expenseKind(group._id.category ?? '');
    const item = byKind.get(kind) ?? items[items.length - 1];
    item.count += group.count;
    item.total += group.total;
  }
  return { items, total: items.reduce((sum, item) => sum + item.total, 0), count: items.reduce((sum, item) => sum + item.count, 0) };
}
