import { ConflictException } from '@nestjs/common';
import { z } from 'zod';
import type { ClientSession, Types } from 'mongoose';
import { WarehouseItem, WarehouseMovement, type warehouseOperations } from '../models';
import type { Scope } from '../middleware/business-access';
import { applyStockLotChanges, issueStockLots, keepDepletedLots, stockLots, type StockLot } from './stock-lots';

export const warehouseQuantity = z.string().trim().regex(/^\d{1,9}(?:\.\d{1,3})?$/, 'Số lượng phải có tối đa 3 chữ số thập phân.')
  .transform(value => {
    const [integer, fraction = ''] = value.split('.');
    return Number(integer) * 1000 + Number(fraction.padEnd(3, '0'));
  });

export const warehouseExpiry = z.string().date('Hạn sử dụng không hợp lệ.').nullable().optional();
export const warehouseCountLots = z.array(z.object({ expiresOn: warehouseExpiry, quantity: warehouseQuantity }).strict()).max(500).optional();
export const warehouseSaleNote = 'Bán hàng';
export const warehouseRetailEditReturn = 'Hoàn tồn do sửa đơn bán lẻ';
export const warehouseRetailCancelReturn = 'Hoàn tồn do hủy đơn bán lẻ';
export const warehouseRecipeNote = 'Chế biến món';
export const warehouseCorrectionNote = 'Điều chỉnh kiểm kê';
export const effectiveCountQuantity = { $ifNull: ['$correctedQuantity', '$after'] };

const countComparisons = { SHORT: '$lt', EXCESS: '$gt', MATCH: '$eq' } as const;
export const warehouseCountFilters = ['COUNT', 'SHORT', 'EXCESS', 'MATCH'] as const;

export function warehouseCountFilter(filter?: typeof warehouseCountFilters[number]) {
  if (!filter) return {};
  return { operation: 'COUNT' as const, ...(filter === 'COUNT' ? {} : {
    $expr: { [countComparisons[filter]]: [effectiveCountQuantity, '$before'] },
  }) };
}

export function latestWarehouseCount(scope: Scope, itemId: Types.ObjectId, session: ClientSession) {
  return WarehouseMovement.findOne({ ...scope, itemId, operation: 'COUNT' })
    .sort('-itemRevision -createdAt -_id').select('createdAt after itemRevision correctedQuantity').session(session).lean();
}

export async function warehouseCountBasis(scope: Scope, itemId: Types.ObjectId, session: ClientSession) {
  const previous = await latestWarehouseCount(scope, itemId, session);
  const since = !previous ? {} : previous.itemRevision != null ? { itemRevision: { $gt: previous.itemRevision } } : {
    $or: [{ createdAt: { $gt: previous.createdAt } }, { createdAt: previous.createdAt, _id: { $gt: previous._id } }],
  };
  const [sales] = await WarehouseMovement.aggregate<{ quantity: number }>([
    { $match: { ...scope, itemId, operation: 'ISSUE', note: { $in: [warehouseSaleNote, warehouseRecipeNote] },
      referenceId: { $type: 'objectId' }, ...since } },
    { $group: { _id: null, quantity: { $sum: '$quantity' } } },
  ]).session(session);
  return { soldQuantity: sales?.quantity ?? 0,
    ...(previous ? { previousCountId: previous._id, previousCountAt: previous.createdAt, previousCountQuantity: previous.correctedQuantity ?? previous.after } : {}) };
}

export function warehouseBalance(operation: typeof warehouseOperations[number], before: number, quantity: number) {
  if (operation !== 'COUNT' && quantity === 0) throw new ConflictException('Số lượng nhập hoặc xuất phải lớn hơn 0.');
  const after = operation === 'COUNT' ? quantity : operation === 'RECEIPT' ? before + quantity : before - quantity;
  if (after < 0) throw new ConflictException('Số lượng xuất vượt tồn hiện tại.');
  if (after > 999_999_999_999) throw new ConflictException('Số lượng tồn vượt giới hạn lưu trữ.');
  return after;
}

export async function recordWarehouseMovement(scope: Scope, item: InstanceType<typeof WarehouseItem>, input: {
  operation: typeof warehouseOperations[number]; quantity: number; note: string; actorId?: string; referenceId?: Types.ObjectId;
  expiresOn?: string | null; countBasis?: Awaited<ReturnType<typeof warehouseCountBasis>>;
  lotAllocation?: readonly StockLot[]; countedLots?: readonly StockLot[];
}, session: ClientSession) {
  const { expiresOn, lotAllocation, countedLots, ...entry } = input;
  const before = item.onHand;
  const after = warehouseBalance(input.operation, before, input.quantity);
  const current = stockLots(item);
  const count = input.operation === 'COUNT';
  const inStock = count && !countedLots ? current.filter(lot => lot.quantity > 0) : [];
  if (inStock.length > 1) throw new ConflictException('Hãy nhập số lượng kiểm kê theo từng hạn sử dụng.');
  const allocation = count ? undefined : lotAllocation ?? (input.operation === 'RECEIPT' ? [{ expiresOn, quantity: input.quantity }] :
    issueStockLots(current, input.quantity, undefined, item.priorityExpiry));
  const next = count ? applyStockLotChanges([], countedLots ?? [{ expiresOn: expiresOn === undefined ? inStock[0]?.expiresOn ?? item.expiresOn : expiresOn,
    quantity: input.quantity }]) : applyStockLotChanges(current, allocation!.map(lot => ({ ...lot,
    quantity: input.operation === 'ISSUE' ? -lot.quantity : lot.quantity })));
  if (next.reduce((sum, lot) => sum + lot.quantity, 0) !== after) throw new ConflictException('Tổng số lượng theo hạn sử dụng không khớp.');
  const tracked = keepDepletedLots(current, next);
  if (tracked.length > 500) throw new ConflictException('Mặt hàng có quá nhiều lô. Hãy xác nhận các lô đã hết trước khi thêm lô mới.');
  item.onHand = after;
  item.set('lots', tracked);
  if (item.priorityExpiry && !next.some(lot => lot.expiresOn === item.priorityExpiry)) item.set('priorityExpiry', undefined);
  item.set('expiresOn', undefined);
  item.revision += 1;
  await item.save({ session });
  return WarehouseMovement.insertOne({ ...scope, itemId: item._id, itemCode: item.code, itemName: item.name, unit: item.unit,
    ...entry, before, after: item.onHand, unitCost: item.unitCost, itemRevision: item.revision,
    lotAllocation: allocation && applyStockLotChanges([], allocation), lotsAfter: count ? next : undefined,
    expiresOn: count ? (next.length === 1 ? next[0].expiresOn : undefined) : expiresOn }, { session });
}
