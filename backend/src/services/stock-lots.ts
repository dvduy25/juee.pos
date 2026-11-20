import { ConflictException } from '@nestjs/common';
import { facilityToday } from './membership-plans';

export type StockLot = { expiresOn?: string | null; quantity: number };
type Stock = { onHand: number; expiresOn?: string | null; lots?: readonly StockLot[] | null };
const byExpiry = (a: StockLot, b: StockLot) => (a.expiresOn ?? '~') < (b.expiresOn ?? '~') ? -1 :
  (a.expiresOn ?? '~') > (b.expiresOn ?? '~') ? 1 : 0;

export function stockLots(item: Stock): readonly StockLot[] {
  return item.lots ?? (item.onHand ? [{ expiresOn: item.expiresOn ?? null, quantity: item.onHand }] : []);
}

export function availableStock(item: Stock, today = facilityToday()) {
  return stockLots(item).reduce((sum, lot) => sum + (!lot.expiresOn || lot.expiresOn >= today ? lot.quantity : 0), 0);
}

export function stockLotChanges(before: readonly StockLot[], after: readonly StockLot[]) {
  const changes = new Map<string | null, number>();
  for (const lot of before) changes.set(lot.expiresOn ?? null, (changes.get(lot.expiresOn ?? null) ?? 0) - lot.quantity);
  for (const lot of after) changes.set(lot.expiresOn ?? null, (changes.get(lot.expiresOn ?? null) ?? 0) + lot.quantity);
  return [...changes].filter(([, quantity]) => quantity !== 0).map(([expiresOn, quantity]) => ({ expiresOn, quantity }));
}

export function applyStockLotChanges(before: readonly StockLot[], changes: readonly StockLot[]) {
  return stockLotChanges([], [...before, ...changes]).map(lot => {
    if (lot.quantity < 0) throw new ConflictException('Số lượng vượt tồn của lô theo hạn sử dụng. Hãy kiểm tra lại lô.');
    return lot;
  }).sort(byExpiry);
}

// Keep the original allocation order so successive partial returns restore different portions of the same sale.
export function sliceStockLots<T extends StockLot>(lots: readonly T[], offset: number, quantity: number): T[] {
  const result: T[] = [];
  for (const lot of lots) {
    const start = Math.min(lot.quantity, offset);
    offset -= start;
    const used = Math.min(lot.quantity - start, quantity);
    if (used) result.push({ ...lot, quantity: used });
    quantity -= used;
    if (!quantity) break;
  }
  if (quantity) throw new ConflictException('Số lượng xuất vượt tồn hiện tại.');
  return result;
}

export function issueStockLots(lots: readonly StockLot[], quantity: number, today?: string) {
  const available = lots.filter(lot => !today || !lot.expiresOn || lot.expiresOn >= today)
    .map(({ expiresOn, quantity }) => ({ expiresOn: expiresOn ?? null, quantity }))
    .sort(byExpiry);
  return sliceStockLots(available, 0, quantity);
}
