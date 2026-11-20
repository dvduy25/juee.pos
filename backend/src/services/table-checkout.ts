import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

type TableOrder = { _id: unknown; status: string; totalAmount: number; billId?: unknown; items?: { _id: unknown; cancelReason?: string | null }[] };
export type Buffet = { adults: number; children: number; adultPrice: number; childPrice: number; packageName?: string | null };
type TableBill = { _id: unknown; status: string; totalAmount: number; paidAmount: number; buffet?: Buffet | null };

export function buffetAmount(buffet: Buffet) {
  return buffet.adults * buffet.adultPrice + buffet.children * buffet.childPrice;
}

export function unservedQuantity(orders: (TableOrder & { items: { _id: unknown; quantity: number; cancelReason?: string | null }[] })[],
  kitchen: ReadonlyMap<string, readonly { orderItemId: unknown; status: string }[]>) {
  let quantity = 0;
  for (const order of orders) {
    if (order.status !== 'ACCEPTED' && order.status !== 'COMPLETED') continue;
    const served = new Set(kitchen.get(String(order._id))?.filter(item => item.status === 'SERVED').map(item => String(item.orderItemId)));
    for (const item of order.items) {
      if (!item.cancelReason && !served.has(String(item._id))) quantity += item.quantity;
    }
  }
  return quantity;
}

export function tableTotals(orders: TableOrder[], bills: TableBill[], buffet?: Buffet | null) {
  const unpaid = orders.filter(order => ['PLACED', 'ACCEPTED'].includes(order.status) && !order.billId);
  const activeBills = bills.filter(bill => bill.status !== 'VOID');
  const unbilledBuffet = buffet && !activeBills.some(bill => bill.buffet) ? buffet : undefined;
  const subtotal = unpaid.reduce((sum, order) => sum + order.totalAmount, unbilledBuffet ? buffetAmount(unbilledBuffet) : 0);
  const due = activeBills.filter(bill => bill.status === 'OPEN')
    .reduce((sum, bill) => sum + Math.max(0, bill.totalAmount - bill.paidAmount), subtotal);
  const revision = createHash('sha256').update(JSON.stringify([
    orders.map(order => [String(order._id), order.status, order.totalAmount, String(order.billId ?? '')]),
    activeBills.map(bill => [String(bill._id), bill.status, bill.totalAmount, bill.paidAmount]),
    ...orders.flatMap(order => order.items?.filter(item => item.cancelReason).map(item => String(item._id)) ?? []),
    ...(buffet ? [[buffet.adults, buffet.children, buffet.adultPrice, buffet.childPrice]] : []),
  ])).digest('hex');
  return { unpaid, unbilledBuffet, subtotal, due, revision, pending: unpaid.filter(order => order.status === 'PLACED').length };
}

export function tableDiscountAmount(subtotal: number, discount: { kind: string; value: number }) {
  if (discount.kind === 'FIXED') return Math.min(subtotal, discount.value);
  return Number(BigInt(subtotal) * BigInt(discount.value) / 100n);
}

export function requireReviewedTable(actual: string, expected: string) {
  if (actual !== expected) throw new ConflictException('Món hoặc số tiền của bàn vừa thay đổi. Hãy kiểm tra lại trước khi tính tiền.');
}
