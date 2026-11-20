import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import type { z } from 'zod';
import { logChange, recordEvent, type Scope } from '../middleware/business-access';
import { found, isDuplicate, jsonValue } from '../utils/db';
import { transaction } from '../config/db';
import { productBranchFilter, productTypeFilter } from './catalog';
import { buffetAmount, unservedQuantity, type Buffet } from './table-checkout';
import { isBuffetIncluded } from './buffet';
import { addIngredientUsage } from './dish-recipes';
import { lines, readIdempotencyKey } from '../validators/sales';
import { Bill, BranchProductPrice, Customer, DiningTable, DishRecipe, IdempotencyRecord, KitchenTicket, Order, Payment, PaymentIntent, Product, ProductVariant, Register, Shift, TableSession, UnavailableProduct, WarehouseItem } from '../models';
import { retailAmounts, retailPricing } from './retail';
import { ingredientLineCost } from './revenue';
import { recordWarehouseMovement, warehouseRecipeNote, warehouseSaleNote } from './warehouse';
import { applyStockLotChanges, availableStock, issueStockLots, sliceStockLots, stockLots, type StockLot } from './stock-lots';
import { facilityToday } from './membership-plans';

export async function idempotent<T>(scope: Scope, operation: string, rawKey: unknown, input: unknown, work: (session: ClientSession) => Promise<T>): Promise<T> {
  const key = readIdempotencyKey(rawKey);
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const lookup = { ...scope, operation, key };
  function replay(record: { requestHash: string; response?: unknown }) {
    if (record.requestHash !== requestHash) throw new ConflictException('Mã yêu cầu đã được dùng với nội dung khác.');
    return record.response as T;
  }
  try {
    return await transaction(async session => {
      const previous = await IdempotencyRecord.findOne(lookup).session(session).lean();
      if (previous) return replay(previous);
      const entry = await IdempotencyRecord.insertOne({ ...lookup, requestHash }, { session });
      const result = await work(session);
      entry.response = jsonValue(result);
      await entry.save({ session });
      return result;
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const previous = await IdempotencyRecord.findOne(lookup).lean();
    if (previous) return replay(previous);
    throw error;
  }
}

type OrderInput = {
  items: z.output<typeof lines>; discountAmount?: number; source: 'POS' | 'QR'; productType?: 'RETAIL' | 'FOOD';
  actorId?: string; tableSessionId?: Types.ObjectId; guestSessionId?: Types.ObjectId; tableName?: string; takeaway?: true;
  customerId?: string; promotionCode?: string; promotionId?: string; expectedTotal?: number; localRetail?: boolean;
};

export async function prepareOrderItems(scope: Scope, input: Pick<OrderInput, 'items' | 'source' | 'productType' | 'tableSessionId' | 'takeaway' | 'localRetail'>, session: ClientSession) {
  const tableSession = input.tableSessionId && found(await TableSession.findOne({ ...scope, _id: input.tableSessionId,
    status: 'OPEN', checkoutBillId: null, takeaway: input.takeaway ? true : { $ne: true } })
    .select('buffet buffetProductIds').session(session).lean(), 'Lượt phục vụ đã đổi hình thức, chốt hóa đơn hoặc đã đóng.');
  const variants = await ProductVariant.find({ tenantId: scope.tenantId, _id: { $in: input.items.map(item => item.variantId) } }).session(session).lean();
  const productType = input.productType ?? (input.source === 'QR' ? 'FOOD' : 'RETAIL');
  const products = await Product.find({ ...productBranchFilter(scope, input.localRetail), status: 'ACTIVE',
    ...productTypeFilter(productType),
    _id: { $in: variants.map(variant => variant.productId) },
  }).session(session).lean();
  const recipes = productType === 'FOOD' ? await DishRecipe.find({ ...scope, productId: { $in: products.map(product => product._id) } }).session(session).lean() : [];
  const recipeByProduct = new Map(recipes.map(recipe => [String(recipe.productId), recipe.ingredients]));
  const warehouseIds = [...products.flatMap(product => product.warehouseItemId ? [product.warehouseItemId] : []),
    ...recipes.flatMap(recipe => recipe.ingredients.map(item => item.itemId))];
  const warehouse = new Map(warehouseIds.length ? (await WarehouseItem.find({ ...scope, _id: { $in: warehouseIds } }).session(session))
    .map(item => [String(item._id), item] as const) : []);
  const allocations = new Map<string, StockLot[]>();
  const availableLots = new Map([...warehouse].map(([id, item]) => [id, stockLots(item)]));
  const today = facilityToday();
  const branchPrices = await BranchProductPrice.find({ ...scope, variantId: { $in: variants.map(item => item._id) } }).session(session).lean();
  const unavailable = productType === 'FOOD' && await UnavailableProduct.find({ ...scope, productId: { $in: products.map(item => item._id) } })
    .select('productId').session(session).lean();
  const unavailableIds = new Set(unavailable ? unavailable.map(item => String(item.productId)) : []);
  const branchSettings = new Map(branchPrices.map(item => [String(item.variantId), item]));
  const byId = new Map(variants.map(item => [String(item._id), item]));
  const byProduct = new Map(products.map(item => [String(item._id), item]));
  const items = input.items.map(line => {
    const variant = found(byId.get(line.variantId), 'Sản phẩm đã hết hoặc không tồn tại.');
    const product = found(byProduct.get(String(variant.productId)), 'Sản phẩm hiện không bán.');
    const buffetIncluded = isBuffetIncluded(tableSession, product);
    const stockId = !buffetIncluded ? product.warehouseItemId?.toString() : undefined;
    const stock = stockId ? found(warehouse.get(stockId), 'Mặt hàng không có trong kho của chi nhánh.') : undefined;
    if (unavailableIds.has(String(product._id))) throw new ConflictException(`${product.name} đang hết món tại chi nhánh.`);
    const settings = branchSettings.get(line.variantId);
    if (settings?.paused) throw new ConflictException(`${product.name} đang tạm ngừng bán tại chi nhánh này.`);
    const groups = product.modifierGroups ?? [];
    const availableIds = new Set(groups.flatMap(group => group.options.map(option => String(option._id))));
    if (line.modifierIds.some(id => !availableIds.has(id))) throw new BadRequestException('Topping không hợp lệ.');
    const modifiers = groups.flatMap(group => {
      const selected = group.options.filter(option => line.modifierIds.includes(String(option._id)));
      if (selected.length < (group.minSelect ?? 0) || selected.length > (group.maxSelect ?? 0)) {
        throw new BadRequestException(`Số lượng lựa chọn không hợp lệ cho ${group.name}.`);
      }
      return selected.map(option => ({ name: option.name, additionalPrice: option.additionalPrice }));
    });
    const recipe = recipeByProduct.get(String(product._id));
    if (productType === 'FOOD' && !buffetIncluded && product.recipeRequired && !recipe?.length) {
      throw new ConflictException(`${product.name} chưa có định lượng nguyên liệu tại chi nhánh này.`);
    }
    const ingredients = buffetIncluded ? undefined : recipe;
    const used = new Map<string, number>();
    if (stockId) used.set(stockId, line.quantity * 1000);
    if (ingredients?.length) addIngredientUsage(used, ingredients, line.quantity);
    const lineLots = [...used].flatMap(([id, quantity]) => {
      const item = found(warehouse.get(id), 'Không tìm thấy nguyên liệu của món trong kho chi nhánh.');
      const lots = availableLots.get(id)!;
      if (quantity > availableStock({ onHand: item.onHand, lots }, today)) {
        const message = productType === 'RETAIL' ? `${item.name} không đủ tồn kho còn hạn.` : input.source === 'QR' ?
          'Không đủ nguyên liệu cho số phần đã chọn.' : `Không đủ nguyên liệu còn hạn: ${item.name}.`;
        throw new ConflictException(message);
      }
      const allocation = issueStockLots(lots, quantity, today);
      availableLots.set(id, applyStockLotChanges(lots, allocation.map(lot => ({ ...lot, quantity: -lot.quantity }))));
      addLotAllocation(allocations, id, allocation);
      return allocation.map(lot => ({ ...lot, itemId: item._id }));
    });
    const ingredientCosts = ingredientLineCost(recipe?.map(item => ({ quantity: item.quantity,
      unitCost: warehouse.get(String(item.itemId))?.unitCost })), line.quantity);
    const unitCost = stock?.unitCost ?? (productType === 'RETAIL' && variant.costPrice > 0 ? variant.costPrice : undefined);
    return { _id: new Types.ObjectId(), productId: product._id, variantId: variant._id, sku: stock?.code ?? variant.sku,
      name: stock?.name ?? product.name, warehouseItemId: stock?._id, unitCost, ingredients,
      stockLots: lineLots.length ? lineLots : undefined, buffetIncluded, ...ingredientCosts,
      unitPrice: (buffetIncluded ? 0 : settings?.price ?? variant.basePrice) + modifiers.reduce((sum, item) => sum + item.additionalPrice, 0), quantity: line.quantity,
      modifiers, note: line.note };
  });
  return { items, warehouse, allocations, retail: productType === 'RETAIL' };
}

export async function issueOrderStock(scope: Scope, prepared: Awaited<ReturnType<typeof prepareOrderItems>>, orderId: Types.ObjectId,
  actorId: string | undefined, session: ClientSession) {
  for (const [id, lotAllocation] of prepared.allocations) {
    await recordWarehouseMovement(scope, prepared.warehouse.get(id)!, { operation: 'ISSUE', quantity: lotAllocation.reduce((sum, lot) => sum + lot.quantity, 0),
      lotAllocation, note: prepared.retail ? warehouseSaleNote : warehouseRecipeNote, actorId, referenceId: orderId }, session);
  }
}

export async function placeOrder(scope: Scope, input: OrderInput, session: ClientSession) {
  const prepared = await prepareOrderItems(scope, input, session);
  const { items, retail } = prepared;
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const manualDiscount = input.discountAmount ?? 0;
  if (!Number.isSafeInteger(subtotal) || manualDiscount > subtotal) throw new BadRequestException('Tổng tiền hoặc giảm giá không hợp lệ.');
  const pricing = retail ? await retailPricing(scope, { code: input.promotionCode, promotionId: input.promotionId }, session) : undefined;
  if ((input.promotionCode || input.promotionId) && !pricing?.promotion) throw new ConflictException('Khuyến mãi không còn hiệu lực.');
  const totals = pricing ? retailAmounts(subtotal, manualDiscount, pricing.taxBps, pricing.promotion, items) :
    { taxAmount: 0, discountAmount: manualDiscount, totalAmount: subtotal - manualDiscount };
  if (input.expectedTotal !== undefined && totals.totalAmount !== input.expectedTotal) {
    throw new ConflictException('Giá hoặc khuyến mãi vừa thay đổi. Kiểm tra lại tổng tiền.');
  }
  if (input.customerId) found(await Customer.exists({ _id: input.customerId, tenantId: scope.tenantId }).session(session));
  const { source, actorId, tableSessionId, guestSessionId, tableName, customerId, takeaway } = input;
  const order = await new Order({ ...scope, items, source, actorId, tableSessionId, guestSessionId, tableName, customerId, takeaway,
    subtotal, ...totals, retail, promotionCode: pricing?.promotion?.code, promotionName: pricing?.promotion?.name,
    promotionId: pricing?.promotion?._id, status: source === 'POS' ? 'ACCEPTED' : 'PLACED' }).save({ session });
  await issueOrderStock(scope, prepared, order._id, actorId, session);
  await recordEvent(scope, 'order.created', order._id, session);
  return order;
}

function addLotAllocation(allocations: Map<string, StockLot[]>, id: string, lots: readonly StockLot[]) {
  const current = allocations.get(id);
  if (current) current.push(...lots);
  else allocations.set(id, [...lots]);
}

export async function restoreOrderIngredients(scope: Scope, order: InstanceType<typeof Order>, lineIds: ReadonlySet<string>, actorId: string, session: ClientSession) {
  const allocations = new Map<string, StockLot[]>();
  for (const line of order.items) {
    if (!lineIds.has(String(line._id))) continue;
    const quantities = new Map<string, number>();
    addIngredientUsage(quantities, line.ingredients ?? [], line.quantity);
    for (const [id, quantity] of quantities) {
      const savedLots = line.stockLots?.filter(lot => String(lot.itemId) === id)
        .map(({ expiresOn, quantity }) => ({ expiresOn, quantity }));
      addLotAllocation(allocations, id, savedLots?.length ? savedLots : [{ quantity }]);
    }
  }
  for (const [id, lotAllocation] of allocations) {
    const item = found(await WarehouseItem.findOne({ ...scope, _id: id }).session(session), 'Không tìm thấy nguyên liệu trong kho chi nhánh.');
    await recordWarehouseMovement(scope, item, { operation: 'RECEIPT', quantity: lotAllocation.reduce((sum, lot) => sum + lot.quantity, 0),
      lotAllocation, note: 'Hoàn nguyên liệu do hủy món', actorId, referenceId: order._id }, session);
  }
}

type StockReturn = { lineId: string; quantity: number };
type SoldLine = { _id: Types.ObjectId; warehouseItemId?: Types.ObjectId | null; quantity: number; returnedQuantity?: number | null; cancelReason?: string | null };

export function stockReturnPlan(items: SoldLine[], selected?: StockReturn[]) {
  const linked = new Map(items.filter(item => item.warehouseItemId && !item.cancelReason).map(item => [String(item._id), item]));
  const requests = selected ?? [...linked.values()].flatMap(item => {
    const quantity = item.quantity - (item.returnedQuantity ?? 0);
    return quantity > 0 ? [{ lineId: String(item._id), quantity }] : [];
  });
  const unique = new Set<string>();
  return requests.map(({ lineId, quantity }) => {
    const item = linked.get(lineId);
    const remaining = item ? item.quantity - (item.returnedQuantity ?? 0) : 0;
    if (!item?.warehouseItemId || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > remaining || unique.has(lineId)) {
      throw new ConflictException('Số lượng trả vượt số hàng còn có thể nhập lại. Hãy tải lại hóa đơn.');
    }
    unique.add(lineId);
    return { lineId: item._id, warehouseItemId: item.warehouseItemId, quantity };
  });
}

export async function restoreOrderStock(scope: Scope, orders: InstanceType<typeof Order>[], input: {
  actorId: string; note: string; referenceId: Types.ObjectId; selected?: StockReturn[];
}, session: ClientSession) {
  const plan = stockReturnPlan(orders.flatMap(order => order.items), input.selected);
  if (!plan.length) return plan;
  const byLine = new Map(plan.map(item => [String(item.lineId), item.quantity]));
  const allocations = new Map<string, StockLot[]>();
  for (const order of orders) {
    for (const item of order.items) {
      const returned = byLine.get(String(item._id));
      if (!returned || !item.warehouseItemId) continue;
      const id = String(item.warehouseItemId);
      const savedLots = item.stockLots?.filter(lot => String(lot.itemId) === id).map(({ expiresOn, quantity }) => ({ expiresOn, quantity }));
      const previouslyReturned = item.returnedQuantity ?? 0;
      const quantity = returned * 1000;
      addLotAllocation(allocations, id, savedLots?.length ? sliceStockLots(savedLots, previouslyReturned * 1000, quantity) : [{ quantity }]);
      item.returnedQuantity = previouslyReturned + returned;
    }
    if (order.isModified()) await order.save({ session });
  }
  for (const [id, lotAllocation] of allocations) {
    const item = found(await WarehouseItem.findOne({ ...scope, _id: id }).session(session), 'Mặt hàng không thuộc kho chi nhánh.');
    await recordWarehouseMovement(scope, item, { operation: 'RECEIPT', quantity: lotAllocation.reduce((sum, lot) => sum + lot.quantity, 0),
      lotAllocation, note: input.note, actorId: input.actorId, referenceId: input.referenceId }, session);
  }
  return plan;
}

export async function makeBill(scope: Scope, orderIds: string[], session: ClientSession, checkout?: {
  tableSessionId: Types.ObjectId; discountCode?: string; discountAmount: number; buffet?: Buffet;
}) {
  const orders = await Order.find({ ...scope, _id: { $in: orderIds }, billId: null, status: 'ACCEPTED' }).session(session).lean();
  if (orders.length !== orderIds.length) throw new ConflictException('Có đơn chưa được nhận, đã hủy hoặc đã có hóa đơn.');
  if (!orders.length && !checkout?.buffet) throw new ConflictException('Không có món hoặc suất buffet cần lập hóa đơn.');
  const table = orders[0]?.tableSessionId?.toString();
  if (table && !checkout) throw new ConflictException('Hãy mở đúng bàn để lập hóa đơn cho toàn bộ món đã gọi.');
  if (checkout && orders.some(order => !order.tableSessionId?.equals(checkout.tableSessionId))) {
    throw new ConflictException('Chỉ gộp các đơn trong cùng lượt phục vụ.');
  }
  if (!checkout && orders.length > 1) throw new ConflictException('Chỉ gộp các đơn trong cùng lượt phục vụ.');
  if (!checkout && orders[0]?.takeaway && unservedQuantity(orders, await orderKitchen(scope, [orders[0]._id], session))) {
    throw new ConflictException('Hãy xác nhận đã ra đủ món của đơn mang về trước khi lập hóa đơn.');
  }
  const subtotal = orders.reduce((total, order) => total + order.totalAmount, checkout?.buffet ? buffetAmount(checkout.buffet) : 0);
  const totalAmount = subtotal - (checkout?.discountAmount ?? 0);
  if (!Number.isSafeInteger(subtotal) || totalAmount < 0) throw new ConflictException('Tổng tiền hóa đơn không hợp lệ.');
  const bill = await Bill.insertOne({ ...scope, ...checkout, orderIds: orders.map(item => item._id), totalAmount,
    ...(orders[0]?.retail ? { retail: true, subtotal: orders[0].subtotal, taxAmount: orders[0].taxAmount,
      discountAmount: orders[0].discountAmount, discountCode: orders[0].promotionCode, promotionName: orders[0].promotionName } : {}),
    paidAmount: 0, status: totalAmount === 0 ? 'PAID' : 'OPEN', settledAt: totalAmount === 0 ? new Date() : undefined }, { session });
  await Order.updateMany({ ...scope, _id: { $in: bill.orderIds } }, { $set: { billId: bill._id } }, { session });
  if (!totalAmount) await completeOrders(scope, bill.orderIds, session);
  return bill;
}

export async function transferQr(scope: Scope, billId: string, amount: number,
  account: { bank?: string | null; account?: string | null; holder?: string | null } | null | undefined, session: ClientSession, reuse = false) {
  if (!account?.bank || !account.account) throw new ConflictException('Chi nhánh chưa cấu hình tài khoản nhận chuyển khoản.');
  const bill = found(await Bill.findOne({ ...scope, _id: billId }).session(session).lean());
  if (bill.status !== 'OPEN' || amount < 1 || amount > bill.totalAmount - bill.paidAmount) throw new ConflictException('Số tiền không còn khả dụng.');
  const filter = { ...scope, billId, amount, bank: account.bank, account: account.account, status: 'PENDING' as const };
  const current = reuse ? await PaymentIntent.findOne({ ...filter, expiresAt: { $gt: new Date() } }).sort('-expiresAt').session(session) : null;
  const intent = current ?? await PaymentIntent.insertOne({ ...filter, reference: `JUEE ${randomBytes(6).toString('hex').toUpperCase()}`,
    expiresAt: new Date(Date.now() + 15 * 60000) }, { session });
  const params = new URLSearchParams({ amount: String(amount), addInfo: intent.reference });
  return { ...intent.toObject(), bankAccount: account, qrUrl: `https://img.vietqr.io/image/${account.bank}-${account.account}-qr_only.png?${params}` };
}

export async function orderKitchen(scope: Scope, orderIds: Types.ObjectId[], session?: ClientSession) {
  const tickets = await KitchenTicket.find({ ...scope, orderId: { $in: orderIds } }).select('orderId items').session(session ?? null).lean();
  return new Map(tickets.map(ticket => [String(ticket.orderId), ticket.items]));
}

export async function sendToKitchen(scope: Scope, order: InstanceType<typeof Order>, session: ClientSession) {
  await KitchenTicket.insertOne({ ...scope, orderId: order._id, tableName: order.tableName, takeaway: order.takeaway, orderedAt: order.createdAt, items: order.items.filter(item => !item.cancelReason).map(item => ({
    orderItemId: item._id, name: item.name, quantity: item.quantity, note: item.note,
    modifiers: item.modifiers.map(modifier => modifier.name), status: 'NEW' as const,
  })) }, { session });
  await recordEvent(scope, 'order.accepted', order._id, session);
}

async function completeOrders(scope: Scope, orderIds: Types.ObjectId[], session: ClientSession) {
  await Order.updateMany({ ...scope, _id: { $in: orderIds } }, { $set: { status: 'COMPLETED' } }, { session });
}

export async function releaseTables(scope: Scope, sessionId: Types.ObjectId, session: ClientSession) {
  await DiningTable.updateMany({ ...scope, sessionId }, { $unset: { sessionId: 1 } }, { session });
  await recordEvent(scope, 'table.updated', sessionId, session);
}

export async function finishPaidTable(scope: Scope, bill: InstanceType<typeof Bill>, session: ClientSession) {
  if (!bill.tableSessionId || bill.status !== 'PAID' || bill.paidAmount !== bill.totalAmount) return;
  const closed = await TableSession.updateOne({ ...scope, _id: bill.tableSessionId, status: 'OPEN', checkoutBillId: bill._id },
    { $set: { status: 'CLOSED', closedAt: bill.settledAt ?? new Date() } }, { session });
  if (closed.modifiedCount) await releaseTables(scope, bill.tableSessionId, session);
}

export async function collect(scope: Scope, billId: string, actorId: string | undefined, entry: {
  method: 'CASH' | 'TRANSFER'; amount: number; reference?: string; provider?: string; providerTransactionId?: string;
  registerId?: string; requireOwnShift?: boolean;
}, session: ClientSession) {
  const bill = found(await Bill.findOne({ ...scope, _id: billId }).session(session));
  if (bill.status !== 'OPEN' || entry.amount > bill.totalAmount - bill.paidAmount) throw new ConflictException('Số tiền vượt phần còn phải thu hoặc hóa đơn đã đóng.');
  const { registerId, requireOwnShift, ...paymentFields } = entry;
  const register = registerId ? found(await Register.findOne({ ...scope, _id: registerId }).session(session).lean()) : null;
  const shift = register?.shiftId ? await Shift.findOne({ ...scope, _id: register.shiftId, registerId, status: 'OPEN' }).session(session).lean() : null;
  if (registerId && !shift) throw new ConflictException('Quầy chưa có ca đang mở.');
  if (requireOwnShift && shift && String(shift.openedBy) !== actorId) throw new ForbiddenException('Hãy chọn ca của bạn.');
  const payment = await Payment.insertOne({ ...scope, billId, actorId, ...paymentFields, registerId: register?._id, shiftId: shift?._id }, { session });
  bill.paidAmount += entry.amount;
  if (bill.paidAmount === bill.totalAmount) {
    bill.status = 'PAID';
    bill.settledAt = payment.paidAt;
    await completeOrders(scope, bill.orderIds, session);
  }
  await bill.save({ session });
  await finishPaidTable(scope, bill, session);
  await logChange(scope, actorId, 'PAYMENT_COLLECT', payment._id, session);
  await recordEvent(scope, 'payment.completed', payment._id, session);
  return { bill: bill.toObject(), payment: payment.toObject() };
}
