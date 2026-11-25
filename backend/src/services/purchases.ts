import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { logChange, type Scope } from '../middleware/business-access';
import { PurchaseReceipt, WarehouseItem, recordedPaymentMethods } from '../models';
import { found } from '../utils/db';
import { label, objectId, vnd } from '../validators/common';
import { roundedMoney } from './retail';
import { recordWarehouseMovement, warehouseExpiry, warehouseQuantity } from './warehouse';

export const purchaseHeader = z.object({ supplier: label, reference: label.optional(), method: z.enum(recordedPaymentMethods) }).strict();
export const purchaseLine = z.object({
  itemId: objectId, quantity: warehouseQuantity.refine(q => q > 0), unitCost: vnd,
  taxBps: z.number().int().min(0).max(10000), expiresOn: warehouseExpiry,
}).strict();
export const purchaseInput = purchaseHeader.extend({ lines: z.array(purchaseLine).min(1).max(30) });

export async function savePurchase(scope: Scope, actorId: string, input: z.output<typeof purchaseInput>, session: ClientSession) {
  if (new Set(input.lines.map(line => `${line.itemId}:${line.expiresOn ?? ''}`)).size !== input.lines.length) {
    throw new BadRequestException('Mỗi mặt hàng và hạn sử dụng chỉ nhập một dòng.');
  }
  const items = await WarehouseItem.find({ ...scope, _id: { $in: input.lines.map(item => item.itemId) } }).session(session);
  const byId = new Map(items.map(item => [item.id, item]));
  const lines = input.lines.map(line => {
    const item = found(byId.get(line.itemId), 'Có mặt hàng không thuộc kho chi nhánh.');
    const subtotal = roundedMoney(BigInt(line.quantity) * BigInt(line.unitCost), 1000n);
    const taxAmount = roundedMoney(BigInt(subtotal) * BigInt(line.taxBps), 10000n);
    return { ...line, itemId: item._id, name: item.name, code: item.code, unit: item.unit, subtotal, taxAmount };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const taxAmount = lines.reduce((sum, line) => sum + line.taxAmount, 0);
  const totalAmount = subtotal + taxAmount;
  if (!Number.isSafeInteger(totalAmount)) throw new ConflictException('Tổng giá trị phiếu nhập vượt giới hạn.');
  const receipt = await PurchaseReceipt.insertOne({ ...scope, actorId, ...input, lines, subtotal, taxAmount, totalAmount }, { session });
  for (const line of lines) {
    const item = byId.get(String(line.itemId))!;
    item.unitCost = roundedMoney(BigInt(item.onHand) * BigInt(item.unitCost ?? line.unitCost) +
      BigInt(line.quantity) * BigInt(line.unitCost), BigInt(item.onHand + line.quantity));
    await recordWarehouseMovement(scope, item, { operation: 'RECEIPT', quantity: line.quantity,
      actorId, note: `Nhập hàng · ${input.supplier}`, referenceId: receipt._id, expiresOn: line.expiresOn ?? null }, session);
  }
  await logChange(scope, actorId, 'PURCHASE_CREATE', receipt._id, session);
  return receipt.toObject();
}
