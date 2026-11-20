import type { PipelineStage } from 'mongoose';
import type { Scope } from '../middleware/business-access';
import { Bill, Order, Payment, Refund, WarehouseItem, WarehouseMovement } from '../models';
import { refundBeforeTax, type revenueRange } from './revenue';
import { effectiveCountQuantity, warehouseRecipeNote, warehouseRetailCancelReturn, warehouseRetailEditReturn, warehouseSaleNote } from './warehouse';

type Range = ReturnType<typeof revenueRange>;
type CostLine = { _id: unknown; quantity: number; unitCost?: number; ingredientCost?: number; cancelReason?: string;
  ingredientCostIncomplete?: boolean; buffetIncluded?: boolean };
type CostOrder = { retail?: boolean; tableSessionId?: unknown; items: CostLine[] };
type SoldLine = CostLine & { productId?: unknown; name: string; unitPrice: number };
type SoldItem = { id: string; name: string; quantity: number; amount: number };
type ReturnedLine = { lineId: unknown; quantity: number };
type Sale = { totalAmount: number; taxAmount?: number; orders: (CostOrder & { items: SoldLine[] })[]; earlyReturns: { returnLines: ReturnedLine[] }[] };
type RefundedSale = Omit<Sale, 'earlyReturns'> & { refund: { amount: number; salesBeforeTax?: number; returnLines?: ReturnedLine[] };
  priorRefunds: { amount: number }[] };

export function saleCost(orders: CostOrder[]) {
  let retailCost = 0;
  let ingredientCost = 0;
  let buffetEstimate = 0;
  let missingCostLines = 0;
  let missingBuffetCostLines = 0;
  for (const order of orders) {
    const retail = order.retail ?? !order.tableSessionId;
    for (const line of order.items) {
      if (line.cancelReason) continue;
      if (retail) {
        if (line.unitCost == null) missingCostLines += 1;
        else retailCost += line.quantity * line.unitCost;
      } else {
        if (line.ingredientCost == null || line.ingredientCostIncomplete) {
          missingCostLines += 1;
          if (line.buffetIncluded) missingBuffetCostLines += 1;
        }
        ingredientCost += line.ingredientCost ?? 0;
        if (line.buffetIncluded) buffetEstimate += line.ingredientCost ?? 0;
      }
    }
  }
  return { retailCost, ingredientCost, buffetEstimate, missingCostLines, missingBuffetCostLines };
}

function returnedCost(orders: CostOrder[], returns: ReturnedLine[]) {
  if (!returns.length) return 0;
  const costByLine = new Map(orders.flatMap(order => order.items.map(line => [String(line._id), line.unitCost] as const)));
  return returns.reduce((total, line) => total + (costByLine.get(String(line.lineId)) ?? 0) * line.quantity, 0);
}

const paidStatuses = ['PAID', 'REFUNDED'];

function recognizedAt(scope: Scope): PipelineStage[] {
  return [
    { $lookup: { from: Payment.collection.name, localField: '_id', foreignField: 'billId', as: 'lastPayment',
      let: { legacy: { $eq: [{ $ifNull: ['$settledAt', null] }, null] } }, pipeline: [
        { $match: { ...scope, $expr: '$$legacy' } }, { $sort: { paidAt: -1 } }, { $limit: 1 }, { $project: { paidAt: 1 } },
      ] } },
    { $set: { recognizedAt: { $ifNull: ['$settledAt', { $first: '$lastPayment.paidAt' },
      { $cond: [{ $eq: ['$totalAmount', 0] }, '$createdAt', null] }] } } },
  ];
}

function settledOrders(scope: Scope): PipelineStage.Lookup {
  return { $lookup: { from: Order.collection.name, localField: 'orderIds', foreignField: '_id', as: 'orders', pipeline: [
    { $match: { ...scope, status: 'COMPLETED' } }, { $project: { retail: 1, tableSessionId: 1, 'items._id': 1, 'items.quantity': 1,
      'items.unitCost': 1, 'items.ingredientCost': 1, 'items.ingredientCostIncomplete': 1, 'items.buffetIncluded': 1, 'items.cancelReason': 1,
      'items.productId': 1, 'items.name': 1, 'items.unitPrice': 1 } },
  ] } };
}

function paymentIds(scope: Scope): PipelineStage.Lookup {
  return { $lookup: { from: Payment.collection.name, localField: '_id', foreignField: 'billId', as: 'payments',
    pipeline: [{ $match: scope }, { $project: { _id: 1 } }] } };
}

export async function profitReport(scope: Scope, range: Range) {
  const sales = Bill.aggregate<Sale>([
    { $match: { ...scope, status: { $in: paidStatuses }, $or: [{ settledAt: range }, { settledAt: null, updatedAt: { $gte: range.$gte } }] } },
    ...recognizedAt(scope), { $match: { recognizedAt: range } }, settledOrders(scope),
    paymentIds(scope),
    { $lookup: { from: Refund.collection.name, localField: 'payments._id', foreignField: 'paymentId', as: 'earlyReturns',
      let: { recognition: '$recognizedAt' }, pipeline: [{ $match: { ...scope, 'returnLines.0': { $exists: true },
        $expr: { $lt: ['$createdAt', '$$recognition'] } } }, { $project: { returnLines: 1 } }] } },
    { $project: { totalAmount: 1, taxAmount: 1, orders: 1, earlyReturns: 1 } },
  ]).cursor<Sale>({ batchSize: 100 });
  const refunded = Refund.aggregate<RefundedSale>([
    { $match: { ...scope, createdAt: range } },
    { $lookup: { from: Payment.collection.name, localField: 'paymentId', foreignField: '_id', as: 'payment', pipeline: [{ $match: scope }] } },
    { $lookup: { from: Bill.collection.name, localField: 'payment.billId', foreignField: '_id', as: 'bill',
      pipeline: [{ $match: { ...scope, status: { $in: paidStatuses } } }] } },
    { $unwind: '$bill' },
    { $replaceWith: { $mergeObjects: ['$bill', { refund: { _id: '$_id', amount: '$amount', createdAt: '$createdAt',
      salesBeforeTax: '$salesBeforeTax', returnLines: '$returnLines' } }] } },
    ...recognizedAt(scope), { $match: { $expr: { $and: [{ $ne: ['$recognizedAt', null] }, { $gte: ['$refund.createdAt', '$recognizedAt'] }] } } },
    settledOrders(scope), paymentIds(scope),
    { $lookup: { from: Refund.collection.name, localField: 'payments._id', foreignField: 'paymentId', as: 'priorRefunds',
      let: { legacy: { $eq: [{ $ifNull: ['$refund.salesBeforeTax', null] }, null] },
        recognition: '$recognizedAt', refundedAt: '$refund.createdAt', refundId: '$refund._id' },
      pipeline: [{ $match: { ...scope, $expr: { $and: ['$$legacy', { $gte: ['$createdAt', '$$recognition'] }, { $or: [
        { $lt: ['$createdAt', '$$refundedAt'] }, { $and: [{ $eq: ['$createdAt', '$$refundedAt'] }, { $lt: ['$_id', '$$refundId'] }] },
      ] }] } } }, { $group: { _id: null, amount: { $sum: '$amount' } } }] } },
    { $project: { totalAmount: 1, taxAmount: 1, orders: 1, refund: 1, priorRefunds: 1 } },
  ]).cursor<RefundedSale>({ batchSize: 100 });

  let salesBeforeTax = 0;
  let refundsBeforeTax = 0;
  let retailCost = 0;
  let ingredientCost = 0;
  let buffetEstimate = 0;
  let restockedCost = 0;
  let missingCostLines = 0;
  let missingBuffetCostLines = 0;
  let invoiceCount = 0;
  const sold = new Map<string, SoldItem>();
  try {
    for await (const bill of sales) {
      invoiceCount++;
      salesBeforeTax += bill.totalAmount - (bill.taxAmount ?? 0);
      const cost = saleCost(bill.orders);
      retailCost += cost.retailCost;
      ingredientCost += cost.ingredientCost;
      buffetEstimate += cost.buffetEstimate;
      missingCostLines += cost.missingCostLines;
      missingBuffetCostLines += cost.missingBuffetCostLines;
      restockedCost += returnedCost(bill.orders, bill.earlyReturns.flatMap(refund => refund.returnLines));
      for (const order of bill.orders) {
        for (const line of order.items) {
          if (line.cancelReason) continue;
          const id = `${line.productId ?? ''}:${line.name}`;
          const item = sold.get(id) ?? { id, name: line.name, quantity: 0, amount: 0 };
          item.quantity += line.quantity;
          item.amount += line.unitPrice * line.quantity;
          sold.set(id, item);
        }
      }
    }
    for await (const bill of refunded) {
      refundsBeforeTax += bill.refund.salesBeforeTax ?? refundBeforeTax(bill.refund.amount, bill.totalAmount, bill.taxAmount ?? 0,
        bill.priorRefunds[0]?.amount ?? 0);
      restockedCost += returnedCost(bill.orders, bill.refund.returnLines ?? []);
    }
  } finally {
    await Promise.allSettled([sales.close(), refunded.close()]);
  }
  const netSales = salesBeforeTax - refundsBeforeTax;
  const netRetailCost = retailCost - restockedCost;
  const grossProfit = netSales - netRetailCost - ingredientCost;
  const soldItems = [...sold.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'vi'));
  return { salesBeforeTax, refundsBeforeTax, netSales, retailCost: netRetailCost, ingredientCost, buffetEstimate, restockedCost,
    grossProfit, margin: netSales > 0 ? grossProfit / netSales : null, missingCostLines, missingBuffetCostLines, invoiceCount, soldItems };
}

type InventoryItem = { _id: { itemId: unknown; unit: string }; name: string; unit: string; sold: number; used: number; manualReceipts: number;
  checks: number; shortChecks: number; excessChecks: number; shortage: number; excess: number;
  shortageValue: number; excessValue: number; unpricedCounts: number; unpricedShortage: number; unpricedExcess: number;
  currentUnitCost?: number | null };

export function inventoryCountValue(quantity: number, unpricedQuantity: number, recordedValue: number, currentUnitCost?: number | null) {
  if (!unpricedQuantity) return { amount: recordedValue, status: 'RECORDED' as const };
  if (currentUnitCost != null) {
    const estimate = Number((BigInt(unpricedQuantity) * BigInt(currentUnitCost) + 500n) / 1000n);
    return { amount: recordedValue + estimate, status: 'ESTIMATED' as const };
  }
  if (unpricedQuantity === quantity) return { amount: null, status: 'MISSING' as const };
  return { amount: recordedValue, status: 'PARTIAL' as const };
}

export async function inventoryReport(scope: Scope, range: Range) {
  const isCount = { $eq: ['$operation', 'COUNT'] };
  const manualReceipt = { $and: [{ $eq: ['$operation', 'RECEIPT'] }, { $eq: [{ $ifNull: ['$referenceId', null] }, null] }] };
  const retailReturns = [warehouseRetailEditReturn, warehouseRetailCancelReturn];
  const shortage = { $and: [isCount, { $lt: ['$delta', 0] }] };
  const excess = { $and: [isCount, { $gt: ['$delta', 0] }] };
  const costMissing = { $eq: [{ $ifNull: ['$unitCost', null] }, null] };
  const value = { $floor: { $add: [0.5, { $divide: [{ $multiply: [{ $abs: '$delta' }, { $ifNull: ['$unitCost', 0] }] }, 1000] }] } };
  const items = await WarehouseMovement.aggregate<InventoryItem>([
    { $match: { ...scope, createdAt: range, $or: [{ operation: 'COUNT' }, { operation: 'RECEIPT', referenceId: null },
      { operation: 'RECEIPT', referenceId: { $type: 'objectId' }, note: { $in: retailReturns } },
      { operation: 'ISSUE', note: { $in: [warehouseSaleNote, warehouseRecipeNote] }, referenceId: { $type: 'objectId' } }] } },
    { $sort: { createdAt: 1, _id: 1 } }, { $set: { delta: { $subtract: [effectiveCountQuantity, '$before'] } } },
    { $group: { _id: { itemId: '$itemId', unit: '$unit' }, name: { $last: '$itemName' }, unit: { $last: '$unit' },
      manualReceipts: { $sum: { $cond: [manualReceipt, '$quantity', 0] } },
      sold: { $sum: { $switch: { branches: [
        { case: { $and: [{ $eq: ['$operation', 'ISSUE'] }, { $eq: ['$note', warehouseSaleNote] }] }, then: '$quantity' },
        { case: { $and: [{ $eq: ['$operation', 'RECEIPT'] }, { $in: ['$note', retailReturns] }] }, then: { $multiply: [-1, '$quantity'] } },
      ], default: 0 } } },
      used: { $sum: { $cond: [{ $and: [{ $eq: ['$operation', 'ISSUE'] }, { $eq: ['$note', warehouseRecipeNote] }] }, '$quantity', 0] } },
      checks: { $sum: { $cond: [isCount, 1, 0] } }, shortChecks: { $sum: { $cond: [shortage, 1, 0] } },
      excessChecks: { $sum: { $cond: [excess, 1, 0] } }, shortage: { $sum: { $cond: [shortage, { $abs: '$delta' }, 0] } },
      excess: { $sum: { $cond: [excess, '$delta', 0] } }, shortageValue: { $sum: { $cond: [shortage, value, 0] } },
      excessValue: { $sum: { $cond: [excess, value, 0] } },
      unpricedShortage: { $sum: { $cond: [{ $and: [shortage, costMissing] }, { $abs: '$delta' }, 0] } },
      unpricedExcess: { $sum: { $cond: [{ $and: [excess, costMissing] }, '$delta', 0] } },
      unpricedCounts: { $sum: { $cond: [{ $and: [isCount, { $ne: ['$delta', 0] }, costMissing] }, 1, 0] } },
    } },
    { $lookup: { from: WarehouseItem.collection.name, localField: '_id.itemId', foreignField: '_id', as: 'currentItem',
      let: { countUnit: '$unit' }, pipeline: [{ $match: { ...scope, $expr: { $eq: ['$unit', '$$countUnit'] } } }, { $project: { unitCost: 1 } }] } },
    { $set: { currentUnitCost: { $first: '$currentItem.unitCost' } } }, { $unset: 'currentItem' },
    { $sort: { name: 1, '_id.itemId': 1, '_id.unit': 1 } },
  ]).allowDiskUse(true);
  const totals = { checks: 0, shortChecks: 0, excessChecks: 0, shortageValue: 0, excessValue: 0, unpricedCounts: 0, estimatedCounts: 0 };
  const rows = items.map(({ _id, unpricedShortage, unpricedExcess, ...item }) => {
    const shortage = inventoryCountValue(item.shortage, unpricedShortage, item.shortageValue, item.currentUnitCost);
    const excess = inventoryCountValue(item.excess, unpricedExcess, item.excessValue, item.currentUnitCost);
    const estimatedCounts = item.currentUnitCost != null ? item.unpricedCounts : 0;
    const unpricedCounts = item.unpricedCounts - estimatedCounts;
    totals.checks += item.checks;
    totals.shortChecks += item.shortChecks;
    totals.excessChecks += item.excessChecks;
    totals.shortageValue += shortage.amount ?? 0;
    totals.excessValue += excess.amount ?? 0;
    totals.unpricedCounts += unpricedCounts;
    totals.estimatedCounts += estimatedCounts;
    return { ...item, id: `${_id.itemId}:${_id.unit}`, unpricedCounts, shortageValue: shortage.amount, excessValue: excess.amount,
      shortageStatus: shortage.status, excessStatus: excess.status };
  });
  const hasShortageValue = !totals.shortChecks || rows.some(item => item.shortage > 0 && item.shortageValue !== null);
  const hasExcessValue = !totals.excessChecks || rows.some(item => item.excess > 0 && item.excessValue !== null);
  return { ...totals, shortageValue: hasShortageValue ? totals.shortageValue : null,
    excessValue: hasExcessValue ? totals.excessValue : null, items: rows };
}

export function profitAfterInventory(profit: Pick<Awaited<ReturnType<typeof profitReport>>,
  'netSales' | 'retailCost' | 'ingredientCost' | 'buffetEstimate' | 'missingCostLines' | 'missingBuffetCostLines'>,
inventory: Pick<Awaited<ReturnType<typeof inventoryReport>>, 'shortageValue' | 'excessValue' | 'unpricedCounts' | 'estimatedCounts' | 'checks'>) {
  const ingredientCost = profit.ingredientCost - profit.buffetEstimate;
  const amount = profit.netSales - profit.retailCost - ingredientCost - (inventory.shortageValue ?? 0) + (inventory.excessValue ?? 0);
  const missingCostLines = profit.missingCostLines - profit.missingBuffetCostLines;
  const needsBuffetCount = inventory.checks === 0 && (profit.buffetEstimate > 0 || profit.missingBuffetCostLines > 0);
  return { amount, margin: profit.netSales > 0 ? amount / profit.netSales : null, ingredientCost, missingCostLines,
    needsBuffetCount, provisional: missingCostLines > 0 || inventory.unpricedCounts > 0 || inventory.estimatedCounts > 0 || needsBuffetCount };
}
