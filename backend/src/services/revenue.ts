import { roundedMoney } from './retail';

export const reportPeriods = ['today', 'week', 'month', 'year', 'all'] as const;
export type ReportPeriod = typeof reportPeriods[number];

const vietnamOffset = 7 * 3600000;
const dayMs = 86400000;
export function revenueRange(period: ReportPeriod, now = new Date(), on?: string) {
  if (period === 'all') return { $gte: new Date(0), $lte: now };
  const local = on ? new Date(`${on}T00:00:00Z`) : new Date(now.getTime() + vietnamOffset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const monday = day - (local.getUTCDay() + 6) % 7;
  const boundaries = {
    today: [Date.UTC(year, month, day), Date.UTC(year, month, day) + dayMs],
    week: [Date.UTC(year, month, monday), Date.UTC(year, month, monday) + 7 * dayMs],
    month: [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)],
    year: [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)],
  };
  const [start, end] = boundaries[period];
  const last = end - vietnamOffset - 1;
  return { $gte: new Date(start - vietnamOffset), $lte: now.getTime() <= last ? now : new Date(last) };
}

export function ingredientLineCost(recipe: readonly { quantity: number; unitCost?: number | null }[] | undefined, servings: number) {
  if (!recipe?.length) return {};
  const knownCost = recipe.reduce((sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitCost ?? 0), 0n);
  return {
    ingredientCost: roundedMoney(knownCost * BigInt(servings), 1000n),
    ingredientCostIncomplete: recipe.some(line => line.unitCost == null) || undefined,
  };
}

export function refundBeforeTax(amount: number, total: number, tax: number, previouslyRefunded = 0) {
  if (!total) return 0;
  const beforeTax = (amount: number) => roundedMoney(BigInt(amount) * BigInt(total - tax), BigInt(total));
  return beforeTax(previouslyRefunded + amount) - beforeTax(previouslyRefunded);
}
