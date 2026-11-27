import { ConflictException } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';
import type { z } from 'zod';
import { logChange, recordEvent, type Scope } from '../middleware/business-access';
import { Bill, Order, Payment, PaymentIntent } from '../models';
import { found } from '../utils/db';
import type { editRetailOrderInput } from '../validators/sales';
import { requireDiscountCode, retailAmounts, retailPricing } from './retail';
import { issueOrderStock, prepareOrderItems, restoreOrderStock } from './sales';
import { sliceStockLots } from './stock-lots';
import { warehouseRetailCancelReturn, warehouseRetailEditReturn } from './warehouse';

type OrderDocument = InstanceType<typeof Order>;
type BillDocument = InstanceType<typeof Bill>;
type EditInput = z.output<typeof editRetailOrderInput>;

export function isRetailOrder(order: { source: string; retail?: boolean | null; tableSessionId?: Types.ObjectId | null; takeaway?: boolean | null }) {
  return order.source === 'POS' && order.retail !== false && !order.tableSessionId && !order.takeaway;
}

export function retailOrderOpen(order: { status: string }) {
  return order.status === 'PLACED' || order.status === 'ACCEPTED';
}

export function editableRetailBill(bill: { status: string; paidAmount: number; orderIds: Types.ObjectId[]; tableSessionId?: Types.ObjectId | null },
  orderId: Types.ObjectId) {
  return bill.status === 'OPEN' && bill.paidAmount === 0 && !bill.tableSessionId &&
    bill.orderIds.length === 1 && bill.orderIds[0].equals(orderId);
}

export function checkOrderRevision(order: OrderDocument, revision?: string) {
  if (revision && Date.parse(revision) !== (order.updatedAt ?? order.createdAt).getTime()) {
    throw new ConflictException('Đơn hàng vừa thay đổi. Hãy mở lại đơn để kiểm tra.');
  }
}

export async function unpaidRetailBill(scope: Scope, order: OrderDocument, session: ClientSession) {
  if (!order.billId) return null;
  const bill = found(await Bill.findOne({ ...scope, _id: order.billId }).session(session));
  if (!editableRetailBill(bill, order._id) || await Payment.exists({ ...scope, billId: bill._id }).session(session)) {
    throw new ConflictException('Chỉ sửa hoặc hủy hóa đơn bán lẻ chưa thu tiền. Khoản đã thu được xử lý trong Hóa đơn và hoàn tiền.');
  }
  return bill;
}

function expireTransfers(scope: Scope, bill: BillDocument, at: Date, session: ClientSession) {
  return PaymentIntent.updateMany({ ...scope, billId: bill._id, status: 'PENDING' }, { $min: { expiresAt: at } }, { session });
}

export async function cancelRetailOrder(scope: Scope, order: OrderDocument, bill: BillDocument | null,
  actorId: string, reason: string, session: ClientSession) {
  await restoreOrderStock(scope, [order], { actorId, note: warehouseRetailCancelReturn, referenceId: order._id }, session);
  if (bill) {
    bill.status = 'VOID';
    await bill.save({ session });
    await expireTransfers(scope, bill, new Date(), session);
    await logChange(scope, actorId, 'BILL_VOID', bill._id, session, { reason });
  }
  order.status = 'CANCELED';
  order.cancelReason = reason;
  await order.save({ session });
  await logChange(scope, actorId, 'ORDER_CANCEL', order._id, session, { reason });
  await recordEvent(scope, 'order.cancelled', order._id, session);
}

export async function updateRetailOrder(scope: Scope, order: OrderDocument, bill: BillDocument | null,
  actorId: string, input: EditInput, session: ClientSession, localRetail = false) {
  requireDiscountCode(input);
  if (order.items.some(item => item.returnedQuantity || item.cancelReason)) {
    throw new ConflictException('Đơn đã có hàng trả lại hoặc dòng bị hủy.');
  }
  const previous = new Map(order.items.map(item => [String(item._id), item.toObject()]));
  const retained = new Map(input.items.flatMap(item => 'lineId' in item ? [[item.lineId, item.quantity] as const] : []));
  const requested = input.items.map(item => {
    const original = 'lineId' in item ? previous.get(item.lineId) : undefined;
    if ('lineId' in item && !original) throw new ConflictException('Dòng sản phẩm không còn thuộc đơn hàng.');
    const added = item.quantity - (original?.quantity ?? 0);
    return { original, added, quantity: item.quantity, variantId: 'variantId' in item ? item.variantId : String(original!.variantId) };
  });
  const stockToReturn = [...previous].flatMap(([lineId, item]) => {
    const removed = item.quantity - (retained.get(lineId) ?? 0);
    return item.warehouseItemId && removed > 0 ? [{ lineId, quantity: removed }] : [];
  });
  // Release only removed quantities. The transaction rolls this back if the replacement cannot be reserved.
  await restoreOrderStock(scope, [order], { actorId, note: warehouseRetailEditReturn, referenceId: order._id, selected: stockToReturn }, session);
  const increases = requested.filter(item => item.added > 0).map(item => ({ variantId: item.variantId, quantity: item.added, modifierIds: [] }));
  const prepared = increases.length ? await prepareOrderItems(scope, { items: increases, source: 'POS', productType: 'RETAIL', localRetail }, session) : undefined;
  const additions = prepared?.items.values();
  const items = requested.map(({ original, quantity, added }) => {
    const extra = added > 0 ? additions?.next().value : undefined;
    if (!original) return extra!;
    if (extra && String(extra.warehouseItemId ?? '') !== String(original.warehouseItemId ?? '')) {
      throw new ConflictException(`${original.name} đã đổi liên kết kho. Hãy bỏ dòng cũ và thêm sản phẩm lại.`);
    }
    if (!original.warehouseItemId || !added) return { ...original, quantity };
    const lots = original.stockLots?.length ? original.stockLots : [{ itemId: original.warehouseItemId, quantity: original.quantity * 1000 }];
    const stockLots = added < 0 ? sliceStockLots(lots, -added * 1000, quantity * 1000) : [...lots, ...extra!.stockLots!];
    return { ...original, quantity, stockLots };
  });
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const { taxBps, promotion } = await retailPricing(scope, input.promotionCode, session);
  if (input.promotionCode && !promotion) throw new ConflictException('Mã giảm giá không hợp lệ hoặc đã hết hạn.');
  const totals = retailAmounts(subtotal, 0, taxBps, promotion, items);
  if (input.expectedTotal !== undefined && totals.totalAmount !== input.expectedTotal) {
    throw new ConflictException('Giá, thuế hoặc khuyến mãi vừa thay đổi. Hãy kiểm tra lại tổng tiền.');
  }
  const before = { totalAmount: order.totalAmount, items: [...previous.values()].map(({ _id, variantId, quantity }) => ({ lineId: _id, variantId, quantity })) };
  order.set({ items, subtotal, ...totals, retail: true, promotionId: promotion?._id, promotionName: promotion?.name, promotionCode: promotion?.code });
  if (bill) {
    const now = new Date();
    bill.set({ ...totals, subtotal, retail: true, discountCode: promotion?.code, promotionName: promotion?.name });
    if (totals.totalAmount === 0) {
      bill.status = 'PAID';
      bill.settledAt = now;
      order.status = 'COMPLETED';
    }
    await bill.save({ session });
    await expireTransfers(scope, bill, now, session);
  }
  await order.save({ session });
  if (prepared) await issueOrderStock(scope, prepared, order._id, actorId, session);
  await logChange(scope, actorId, 'ORDER_EDIT', order._id, session, { before, totalAmount: order.totalAmount });
  await recordEvent(scope, 'order.updated', order._id, session);
  return order.toObject();
}
