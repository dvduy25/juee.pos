import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Types } from 'mongoose';
import { isDuplicate, jsonTransform, localFilter } from '../src/utils/db';
import { vnd } from '../src/validators/common';
import { Bill, MemberPlan, Order, PlanVersion, Product, ProductVariant, Subscription, TicketType } from '../src/models';
import { readProductImage } from '../src/services/product-image';
import { readStaffImages } from '../src/services/staff-identity';
import { activeSubscriptionFilter, simulatedSubscription, simulatedSubscriptionsEnabled, subscriptionStatus } from '../src/services/tenants';
import { qrImage } from '../src/utils/qr';
import { buffetMenuFilter, isBuffetIncluded } from '../src/services/buffet';
import { facilityToday, memberAccessStatus, memberPlanDaysRemaining, monthlyPlanExpiry, nextMemberEnrollment, shiftDays } from '../src/services/membership-plans';
import { warehouseBalance, warehouseCountFilter, warehouseExpiry, warehouseQuantity } from '../src/services/warehouse';
import { applyStockLotChanges, availableStock, issueStockLots, sliceStockLots, stockLotChanges, stockLots } from '../src/services/stock-lots';
import { ingredientLineCost, refundBeforeTax, revenueRange } from '../src/services/revenue';
import { inventoryCountValue, profitAfterInventory, saleCost } from '../src/services/profit-report';
import { hotelNoon, quoteHotelStay, isStayDate, stayNights, stayOverlap, stayTotal, stayWindowOverlap } from '../src/services/hotel-stays';
import { ticketEntryQuantities, ticketSalePrice, ticketWindowState } from '../src/services/ticket-rules';
import { signupNeedsVerification } from '../src/services/account-email';
import { platformSubscriptionFilter, platformSubscriptionState } from '../src/services/platform-subscriptions';
import { summarizeExpenses } from '../src/services/operating-expenses';
import { calculatePayroll } from '../src/services/payroll';
import { expandStaffShiftRange, expandStaffShifts, staffShiftOnDate, staffShiftStatus } from '../src/services/staff-shifts';
import { resolveStaffPunch } from '../src/services/staff-attendance';
import { requireReviewedTable, tableDiscountAmount, tableTotals, unservedQuantity } from '../src/services/table-checkout';
import { retailAmounts, roundedMoney } from '../src/services/retail';
import { stockReturnPlan } from '../src/services/sales';
import { addIngredientUsage, dishRecipeInput } from '../src/services/dish-recipes';
import { branchLocation, distanceMeters, guestLocation, requireGuestLocation } from '../src/validators/order-location';

test('public registration requires SMTP and local signup exceptions stay on loopback', () => {
  const local = { NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:3000', ALLOW_UNVERIFIED_LOCAL_SIGNUP: 'true' };
  assert.equal(signupNeedsVerification({ NODE_ENV: 'production', ALLOW_UNVERIFIED_LOCAL_SIGNUP: 'true' }), true);
  assert.equal(signupNeedsVerification({ NODE_ENV: 'development' }), true);
  assert.equal(signupNeedsVerification(local), false);
  assert.equal(signupNeedsVerification({ ...local, BIND_HOST: '0.0.0.0' }), true);
  assert.equal(signupNeedsVerification({ ...local, WEB_ORIGIN: 'https://app.example.com' }), true);
  assert.equal(signupNeedsVerification({ ...local, NODE_ENV: 'test', BIND_HOST: '0.0.0.0' }), true);
  assert.equal(signupNeedsVerification({ ...local, SMTP_URL: 'smtps://smtp.example.com', MAIL_FROM: 'mail@example.com' }), true);
});

test('platform subscription states and expiry filters agree at the date boundaries', () => {
  const now = new Date('2026-11-20T04:00:00Z');
  const started = new Date(+now - 1);
  assert.equal(platformSubscriptionState({ status: 'ACTIVE', startsAt: started, expiresAt: now }, now), 'EXPIRED');
  assert.equal(platformSubscriptionState({ status: 'ACTIVE', startsAt: now, expiresAt: new Date(+now + 1) }, now), 'ACTIVE');
  assert.equal(platformSubscriptionState({ status: 'ACTIVE', startsAt: new Date(+now + 1) }, now), 'SCHEDULED');
  assert.equal(platformSubscriptionState({ status: 'SUSPENDED', startsAt: started, expiresAt: now }, now), 'SUSPENDED');
  assert.deepEqual(platformSubscriptionFilter('EXPIRING', now).expiresAt, { $gt: now, $lte: new Date('2026-11-27T04:00:00Z') });
  assert.deepEqual(platformSubscriptionFilter('REQUESTED', now).requestedPlanVersionId, { $type: 'objectId' });
});

test('stock lots preserve legacy expiry, allocate the earliest valid dates and support partial returns', () => {
  const original = stockLots({ onHand: 14_000, expiresOn: '2030-01-01' });
  const lots = applyStockLotChanges(original, [
    { expiresOn: '2030-01-15', quantity: 4000 }, { expiresOn: '2030-01-10', quantity: 2000 }, { quantity: 3000 },
  ]);
  assert.deepEqual(lots.map(lot => lot.quantity), [14_000, 2000, 4000, 3000]);
  const today = '2030-01-10';
  assert.equal(availableStock({ onHand: 23_000, lots }, today), 9000);
  const allocation = issueStockLots(lots, 5000, today);
  assert.deepEqual(allocation, [{ expiresOn: '2030-01-10', quantity: 2000 }, { expiresOn: '2030-01-15', quantity: 3000 }]);
  assert.deepEqual(sliceStockLots(allocation, 1000, 2000), [
    { expiresOn: '2030-01-10', quantity: 1000 }, { expiresOn: '2030-01-15', quantity: 1000 },
  ]);
  assert.throws(() => issueStockLots(lots, 10_000, today), /vượt tồn/);
  const corrected = [{ expiresOn: '2030-01-01', quantity: 13_000 }];
  assert.equal(applyStockLotChanges(lots, stockLotChanges(original, corrected))[0].quantity, 13_000);
});

test('inventory valuation separates missing prices from zero and estimates only unpriced counts', () => {
  assert.deepEqual(inventoryCountValue(13_000, 13_000, 0, 7_500), { amount: 97_500, status: 'ESTIMATED' });
  assert.deepEqual(inventoryCountValue(19_000, 19_000, 0), { amount: null, status: 'MISSING' });
  assert.deepEqual(inventoryCountValue(10_000, 3000, 21_000), { amount: 21_000, status: 'PARTIAL' });
  assert.deepEqual(inventoryCountValue(10_000, 3000, 21_000, 8000), { amount: 45_000, status: 'ESTIMATED' });
  assert.deepEqual(inventoryCountValue(10_000, 0, 0, 7500), { amount: 0, status: 'RECORDED' });
  assert.deepEqual(inventoryCountValue(125, 125, 0, 4004), { amount: 501, status: 'ESTIMATED' });
});

test('gross profit uses the saved costs and identifies incomplete costs and buffet estimates', () => {
  const tracked = ingredientLineCost([{ quantity: 125, unitCost: 40_000 }, { quantity: 100, unitCost: 22_000 }], 2);
  const incomplete = ingredientLineCost([{ quantity: 125, unitCost: 40_000 }, { quantity: 200 }], 1);
  assert.equal(tracked.ingredientCost, 14_400);
  assert.deepEqual(incomplete, { ingredientCost: 5000, ingredientCostIncomplete: true });
  assert.deepEqual(saleCost([
    { retail: false, items: [{ _id: 'buffet', quantity: 2, buffetIncluded: true, ...tracked }, { _id: 'extra', quantity: 1, ...incomplete }] },
    { retail: true, items: [{ _id: 'retail', quantity: 2, unitCost: 2200 }, { _id: 'legacy', quantity: 1 }] },
  ]), { retailCost: 4400, ingredientCost: 19_400, buffetEstimate: 14_400, missingCostLines: 2, missingBuffetCostLines: 0 });
});

test('profit after inventory deducts shortages, credits excess and separates buffet estimates', () => {
  const profit = { netSales: 1_000_000, retailCost: 300_000, ingredientCost: 200_000, buffetEstimate: 40_000,
    missingCostLines: 1, missingBuffetCostLines: 1 };
  const inventory = { shortageValue: 70_000, excessValue: 10_000, unpricedCounts: 0, estimatedCounts: 0, checks: 2 };
  assert.deepEqual(profitAfterInventory(profit, inventory), { amount: 480_000, margin: 0.48, ingredientCost: 160_000,
    missingCostLines: 0, needsBuffetCount: false, provisional: false });
  assert.equal(profitAfterInventory(profit, { ...inventory, shortageValue: null, unpricedCounts: 1 }).provisional, true);
  assert.equal(profitAfterInventory(profit, { ...inventory, estimatedCounts: 1 }).provisional, true);
  assert.equal(profitAfterInventory(profit, { ...inventory, checks: 0 }).needsBuffetCount, true);
  assert.equal(profitAfterInventory({ ...profit, netSales: 0 }, inventory).margin, null);
});

test('refunds use cumulative rounding so the full net sales are reversed across partial refunds', () => {
  const parts = [refundBeforeTax(1, 3, 1), refundBeforeTax(1, 3, 1, 1), refundBeforeTax(1, 3, 1, 2)];
  assert.deepEqual(parts, [1, 0, 1]);
  assert.equal(refundBeforeTax(54_000, 108_000, 8000), 50_000);
});

test('recipes validate ingredient quantities and combine shared ingredients across portions', () => {
  const rice = new Types.ObjectId();
  const meat = new Types.ObjectId();
  assert.deepEqual(dishRecipeInput.parse([{ itemId: String(rice), quantity: '0.125' }]), [{ itemId: String(rice), quantity: 125 }]);
  assert.equal(dishRecipeInput.safeParse([{ itemId: String(rice), quantity: '0' }]).success, false);
  assert.equal(dishRecipeInput.safeParse([{ itemId: String(rice), quantity: '1' }, { itemId: String(rice), quantity: '2' }]).success, false);
  const used = new Map<string, number>();
  addIngredientUsage(used, [{ itemId: rice, quantity: 125 }, { itemId: meat, quantity: 90 }], 3);
  addIngredientUsage(used, [{ itemId: rice, quantity: 250 }], 2);
  assert.deepEqual([...used], [[String(rice), 875], [String(meat), 270]]);
});

test('stock returns use the sale snapshot and return each linked quantity only once', () => {
  const warehouseItemId = new Types.ObjectId();
  const returned = { _id: new Types.ObjectId(), warehouseItemId, quantity: 3, returnedQuantity: 1 };
  const untouched = { _id: new Types.ObjectId(), warehouseItemId, quantity: 1 };
  const unlinked = { _id: new Types.ObjectId(), quantity: 4 };
  const items = [returned, untouched, unlinked];
  const selection = { lineId: String(returned._id), quantity: 1 };
  assert.deepEqual(stockReturnPlan(items, [selection]), [{ lineId: returned._id, warehouseItemId, quantity: 1 }]);
  assert.deepEqual(stockReturnPlan(items), [
    { lineId: returned._id, warehouseItemId, quantity: 2 }, { lineId: untouched._id, warehouseItemId, quantity: 1 },
  ]);
  assert.deepEqual(stockReturnPlan([{ ...returned, returnedQuantity: 3 }, unlinked]), []);
  assert.deepEqual(stockReturnPlan([{ ...untouched, cancelReason: 'Khách đổi món' }]), []);
  assert.throws(() => stockReturnPlan(items, [selection, selection]), /Số lượng trả/);
  assert.throws(() => stockReturnPlan(items, [{ ...selection, quantity: 3 }]), /Số lượng trả/);
  assert.throws(() => stockReturnPlan(items, [{ ...selection, lineId: String(unlinked._id) }]), /Số lượng trả/);
});

test('retail promotion and manual discount reduce the base before tax', () => {
  assert.deepEqual(retailAmounts(100_000, 0, 800, { kind: 'PERCENT', value: 10, minimum: 50_000 }),
    { discountAmount: 10_000, taxAmount: 7_200, totalAmount: 97_200 });
  assert.deepEqual(retailAmounts(25_000, 5_000, 1000), { discountAmount: 5_000, taxAmount: 2_000, totalAmount: 22_000 });
  assert.deepEqual(retailAmounts(1000, 0, 800, { kind: 'FIXED', value: 2000, minimum: 0 }),
    { discountAmount: 1000, taxAmount: 0, totalAmount: 0 });
  assert.throws(() => retailAmounts(1000, 1, 0, { kind: 'FIXED', value: 500, minimum: 0 }), /thủ công/);
  assert.throws(() => retailAmounts(1000, 0, 0, { kind: 'FIXED', value: 500, minimum: 2000 }), /tối thiểu/);
});

test('product promotions discount only matching cart lines and keep the order minimum', () => {
  const first = new Types.ObjectId();
  const second = new Types.ObjectId();
  const items = [
    { productId: first, unitPrice: 20_000, quantity: 2 },
    { productId: first, unitPrice: 10_000, quantity: 1 },
    { productId: second, unitPrice: 50_000, quantity: 1 },
  ];
  const promotion = { kind: 'PERCENT' as const, value: 10, minimum: 90_000, productIds: [String(first)] };
  assert.deepEqual(retailAmounts(100_000, 0, 800, promotion, items),
    { discountAmount: 5_000, taxAmount: 7_600, totalAmount: 102_600 });
  assert.deepEqual(retailAmounts(100_000, 0, 0, { ...promotion, kind: 'FIXED', value: 60_000 }, items),
    { discountAmount: 50_000, taxAmount: 0, totalAmount: 50_000 });
  assert.throws(() => retailAmounts(50_000, 0, 0, promotion, [items[2]]), /chưa có sản phẩm/);
  assert.throws(() => retailAmounts(50_000, 0, 0, promotion, items.slice(0, 2)), /tối thiểu/);
});

test('purchase values round fractional warehouse quantities and reject amount overflow', () => {
  assert.equal(roundedMoney(1500n * 2001n, 1000n), 3002);
  assert.equal(roundedMoney(3500n, 1000n), 4);
  assert.throws(() => roundedMoney(2n ** 65n, 1n), /giới hạn/);
});

test('stored ObjectIds and BSON Long-compatible money keep the existing JSON format', () => {
  const model = new PlanVersion({ planId: new Types.ObjectId(), version: 1, monthlyVnd: 149000n });
  const value = JSON.parse(JSON.stringify(model, jsonTransform));
  assert.equal(value.id, model.id);
  assert.equal(value.planId, String(model.planId));
  assert.equal(value.monthlyVnd, '149000');
  assert.equal(value._id, undefined);
});

test('prices reject fractions and unsafe integers and variants enforce unique SKUs within a tenant', async () => {
  assert.equal(vnd.safeParse(10000).success, true);
  assert.equal(vnd.safeParse(10000.5).success, false);
  assert.equal(vnd.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false);
  const index = ProductVariant.schema.indexes().find(([keys]) => keys.sku === 1);
  assert.deepEqual(index?.[0], { tenantId: 1, sku: 1 });
  assert.equal(index?.[1].unique, true);
  await assert.rejects(new Order({ subtotal: 100.1 }).validate(), /subtotal/);
  await assert.rejects(new Bill({ paidAmount: -1 }).validate(), /paidAmount/);
  assert.equal(isDuplicate(new Error()), false);
});

test('catalog search treats regex punctuation literally and tables return QR images', () => {
  const regex = localFilter('A.*[B]');
  assert.equal(regex.test('a.*[b]'), true);
  assert.equal(regex.test('abcdef'), false);
  const data = qrImage('https://example.test/order/123/test');
  const payload = Buffer.from(data.split(',')[1], 'base64').toString();
  assert.match(data, /^data:image\/svg\+xml;base64,/);
  assert.match(payload, /^<svg[^>]+shape-rendering="crispEdges"/);
});

test('staff image uploads validate multiple raster images and enforce a combined size limit', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const avatar = { buffer: png };
  const uploads = readStaffImages({ avatar: [avatar], documents: [{ buffer: jpeg, originalname: 'mặt trước.jpg' },
    { buffer: png, originalname: 'mặt sau.png' }] });
  assert.equal(uploads.avatar?.contentType, 'image/png');
  assert.deepEqual(uploads.documents.map(file => file.contentType), ['image/jpeg', 'image/png']);
  assert.notEqual(uploads.documents[0].digest, uploads.documents[1].digest);
  assert.throws(() => readStaffImages({ documents: [{ buffer: Buffer.from('<svg/>'), originalname: 'ảnh.jpg' }] }), /hợp lệ/);
  const large = Buffer.alloc(4 * 1024 * 1024);
  png.copy(large);
  assert.throws(() => readStaffImages({ avatar: [{ buffer: large }], documents: [{ buffer: large, originalname: 'một.png' },
    { buffer: jpeg, originalname: 'hai.jpg' }] }), /8 MB/);
});

test('product image uploads trust raster signatures and keep bytes out of JSON catalog data', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
  const image = readProductImage({ buffer: png });
  assert.equal(image?.contentType, 'image/png');
  assert.deepEqual(image?.bytes, png);
  assert.throws(() => readProductImage({ buffer: Buffer.from('<svg></svg>') }), /JPG, PNG hoặc WebP/);
  assert.throws(() => readProductImage({ buffer: Buffer.alloc(4 * 1024 * 1024 + 1) }), /4 MB/);
  const product = new Product({ name: 'Cà phê', imageFile: image });
  assert.equal(product.toObject({ useProjection: true }).imageFile, undefined);
});

test('simulated subscriptions provide 30 days of access in development only', async () => {
  const now = new Date('2026-11-14T00:00:00Z');
  const planVersionId = new Types.ObjectId();
  const contract = new Subscription({ tenantId: new Types.ObjectId(), ...simulatedSubscription(planVersionId, now) });
  await contract.validate();
  assert.equal(contract.status, 'ACTIVE');
  assert.equal(contract.simulated, true);
  assert.equal(contract.trial, false);
  assert.equal(contract.expiresAt?.toISOString(), '2026-12-14T00:00:00.000Z');

  assert.equal(simulatedSubscriptionsEnabled('test'), false);
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    assert.equal(activeSubscriptionFilter(now).simulated, undefined);
    assert.equal(subscriptionStatus(contract.status, contract.simulated), 'ACTIVE');
    process.env.NODE_ENV = 'production';
    assert.deepEqual(activeSubscriptionFilter(now).simulated, { $ne: true });
    assert.equal(subscriptionStatus(contract.status, contract.simulated), 'PENDING');
    assert.equal(subscriptionStatus('ACTIVE', undefined), 'ACTIVE');
    assert.equal(subscriptionStatus('SUSPENDED', true), 'SUSPENDED');
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test('table checkout counts new and outstanding items once and detects additional orders', () => {
  const orders = [{ _id: 'first', status: 'ACCEPTED', totalAmount: 25000 },
    { _id: 'already-paid', status: 'COMPLETED', totalAmount: 14000, billId: 'paid' },
    { _id: 'legacy-order', status: 'ACCEPTED', totalAmount: 10000, billId: 'partial' },
    { _id: 'canceled', status: 'CANCELED', totalAmount: 12000 }];
  const bills = [{ _id: 'paid', status: 'PAID', totalAmount: 14000, paidAmount: 14000 },
    { _id: 'partial', status: 'OPEN', totalAmount: 10000, paidAmount: 4000 }];
  const first = tableTotals(orders, bills);
  const changed = tableTotals([...orders, { _id: 'second', status: 'PLACED', totalAmount: 35000 }], bills);
  assert.equal(first.subtotal, 25000);
  assert.equal(first.due, 31000);
  assert.equal(changed.due, 66000);
  assert.equal(changed.pending, 1);
  assert.throws(() => requireReviewedTable(changed.revision, first.revision), /vừa thay đổi/);
  assert.equal(tableDiscountAmount(60099, { kind: 'PERCENT', value: 10 }), 6009);
  assert.equal(tableDiscountAmount(60000, { kind: 'FIXED', value: 80000 }), 60000);
});

test('table checkout counts only unserved portions of accepted or completed orders', () => {
  const orders = [
    { _id: 'accepted', status: 'ACCEPTED', totalAmount: 90000, items: [{ _id: 'first', quantity: 1 }, { _id: 'second', quantity: 2 }] },
    { _id: 'completed', status: 'COMPLETED', totalAmount: 30000, items: [{ _id: 'legacy', quantity: 1 }] },
    { _id: 'canceled', status: 'CANCELED', totalAmount: 60000, items: [{ _id: 'canceled-item', quantity: 2 }] },
    { _id: 'pending', status: 'PLACED', totalAmount: 30000, items: [{ _id: 'pending-item', quantity: 1 }] },
  ];
  const kitchen = new Map([['accepted', [{ orderItemId: 'first', status: 'SERVED' }, { orderItemId: 'second', status: 'READY' }]]]);
  assert.equal(unservedQuantity(orders, kitchen), 3);
  kitchen.get('accepted')![1].status = 'SERVED';
  kitchen.set('completed', [{ orderItemId: 'legacy', status: 'SERVED' }]);
  assert.equal(unservedQuantity(orders, kitchen), 0);
});

test('canceling a zero-priced dish invalidates checkout review without holding up the remaining dishes', () => {
  const order = { _id: 'order', status: 'ACCEPTED', totalAmount: 30000,
    items: [{ _id: 'main', quantity: 1 }, { _id: 'side', quantity: 2 }] };
  const kitchen = new Map([['order', [{ orderItemId: 'main', status: 'SERVED' }]]]);
  const canceled = { ...order, items: [order.items[0], { ...order.items[1], cancelReason: 'Khách đổi món' }] };
  assert.equal(unservedQuantity([order], kitchen), 2);
  assert.equal(unservedQuantity([canceled], kitchen), 0);
  assert.equal(tableTotals([canceled], []).due, 30000);
  assert.notEqual(tableTotals([canceled], []).revision, tableTotals([order], []).revision);
});

test('table totals include buffet fees once and require review after guest changes', () => {
  const buffet = { adults: 2, children: 1, adultPrice: 120000, childPrice: 60000 };
  const orders = [{ _id: 'extras', status: 'ACCEPTED', totalAmount: 30000 }];
  const current = tableTotals(orders, [], buffet);
  assert.equal(current.subtotal, 330000);
  assert.equal(current.due, 330000);
  assert.equal(tableTotals([], [], buffet).due, 300000);
  assert.notEqual(tableTotals(orders, [], { ...buffet, adults: 3 }).revision, current.revision);
  const bill = { _id: 'bill', status: 'OPEN', totalAmount: 330000, paidAmount: 100000, buffet };
  const billed = [{ ...orders[0], billId: 'bill' }];
  assert.equal(tableTotals(billed, [bill], buffet).due, 230000);
  assert.equal(tableTotals(orders, [{ ...bill, status: 'VOID' }], buffet).due, 330000);
});

test('a buffet package separates its own menu from paid extras and keeps legacy tables working', () => {
  const included = new Types.ObjectId();
  const extra = new Types.ObjectId();
  const service = { buffet: { adults: 1 }, buffetProductIds: [included] };
  assert.deepEqual(buffetMenuFilter(service, 'included'), { _id: { $in: [included] } });
  assert.deepEqual(buffetMenuFilter(service, 'extra'), { _id: { $nin: [included] } });
  assert.equal(isBuffetIncluded(service, { _id: included, buffetExtra: true }), true);
  assert.equal(isBuffetIncluded(service, { _id: extra }), false);
  assert.equal(isBuffetIncluded(undefined, { _id: included }), false);
  assert.equal(isBuffetIncluded({ buffet: {} }, { _id: included }), true);
  assert.equal(isBuffetIncluded({ buffet: {} }, { _id: extra, buffetExtra: true }), false);
});

test('member plans accept an unset validity period and reject invalid month counts', async () => {
  const scope = { tenantId: new Types.ObjectId(), branchId: new Types.ObjectId() };
  const plan = { ...scope, name: 'Gói thử', units: 2, price: 120000 };
  for (const kind of ['MONTH', 'DAY', 'VISITS']) {
    await new MemberPlan({ ...plan, kind, validityMonths: null }).validate();
  }
  await new MemberPlan({ ...plan, kind: 'VISITS', validityMonths: 3 }).validate();
  await assert.rejects(new MemberPlan({ ...plan, kind: 'VISITS', validityMonths: 2.5 }).validate(), /validityMonths/);
});

test('hotel dates require real calendar days and use checkout as an exclusive boundary', () => {
  assert.equal(isStayDate('2028-02-29'), true);
  assert.equal(isStayDate('2026-02-29'), false);
  assert.equal(stayNights('2026-12-31', '2027-01-02'), 2);
  assert.throws(() => stayNights('2026-11-17', '2026-11-17'), /tối đa 365 đêm/);
  assert.throws(() => stayNights('2026-11-17', '2027-11-18'), /tối đa 365 đêm/);
  assert.deepEqual(stayOverlap('2026-11-17', '2026-11-18'),
    { startsOn: { $lt: '2026-11-18' }, endsOn: { $gt: '2026-11-17' } });
});

test('member plan days include the expiry day in Vietnam', () => {
  const beforeMidnight = Date.parse('2026-11-19T16:59:59.000Z');
  const afterMidnight = Date.parse('2026-11-19T17:00:00.000Z');
  assert.equal(memberPlanDaysRemaining('2026-11-20', facilityToday(beforeMidnight)), 2);
  assert.equal(memberPlanDaysRemaining('2026-11-20', facilityToday(afterMidnight)), 1);
  assert.equal(memberPlanDaysRemaining('2026-11-20', '2026-11-21'), 0);
  assert.equal(memberPlanDaysRemaining(undefined, '2026-11-21'), undefined);
  assert.equal(memberPlanDaysRemaining('invalid', '2026-11-21'), undefined);
});

test('monthly memberships handle Vietnam midnight, month ends and renewal', () => {
  assert.equal(facilityToday(Date.parse('2026-11-15T17:00:00Z')), '2026-11-16');
  assert.equal(monthlyPlanExpiry('2026-01-31', 1), '2026-02-28');
  assert.equal(monthlyPlanExpiry('2028-01-31', 1), '2028-02-29');
  const plan = { _id: 'month', name: 'Gói tháng', kind: 'MONTH' as const, units: 1 };
  const first = nextMemberEnrollment(plan, undefined, '2026-03-01');
  assert.equal(first.expiresOn, '2026-03-31');
  const renewed = nextMemberEnrollment(plan, first, '2026-03-16');
  assert.equal(renewed.expiresOn, '2026-04-30');
  assert.equal(memberAccessStatus({ active: true, enrollment: renewed }, '2026-04-30'), 'ACTIVE');
  assert.equal(memberAccessStatus({ active: true, enrollment: renewed }, '2026-05-01'), 'EXPIRED');
  assert.equal(memberAccessStatus({ active: true, expiresOn: '2026-05-01' }, '2026-05-01'), 'ACTIVE');
});

test('visit memberships stop at zero and renew by adding visits to the same plan', () => {
  const today = '2026-11-16';
  const plan = { _id: 'visits', name: '5 lượt', kind: 'VISITS' as const, units: 5 };
  const first = nextMemberEnrollment(plan, undefined, today);
  assert.equal(first.remaining, 5);
  assert.equal(nextMemberEnrollment(plan, { ...first, remaining: 1 }, today).remaining, 6);
  assert.equal(nextMemberEnrollment({ ...plan, _id: 'other' }, first, today).remaining, 5);
  assert.equal(memberAccessStatus({ active: true, enrollment: { ...first, remaining: 0 } }, today), 'NO_VISITS');
  assert.equal(memberAccessStatus({ active: false, enrollment: first }, today), 'PAUSED');
  assert.equal(memberAccessStatus({ active: true }, today), 'NO_PLAN');
});

test('day plans include the start day and visit plans keep their price and deadline', () => {
  const day = { _id: 'day', name: 'Vé ngày', kind: 'DAY' as const, units: 1, price: 45000 };
  const daily = nextMemberEnrollment(day, undefined, '2026-12-31');
  assert.equal(daily.price, 45000);
  assert.equal(daily.expiresOn, '2026-12-31');
  assert.equal(nextMemberEnrollment(day, daily, '2026-12-31').expiresOn, '2027-01-01');
  const plan = { _id: 'twelve', name: '12 lượt trong 2 tháng', kind: 'VISITS' as const, units: 12, price: 360000, validityMonths: 2 };
  const visits = nextMemberEnrollment(plan, undefined, '2026-11-16');
  assert.equal(visits.remaining, 12);
  assert.equal(visits.price, 360000);
  assert.equal(visits.expiresOn, '2027-01-15');
  assert.equal(memberAccessStatus({ active: true, enrollment: visits }, '2027-01-15'), 'ACTIVE');
  assert.equal(memberAccessStatus({ active: true, enrollment: visits }, '2027-01-16'), 'EXPIRED');
  assert.equal(nextMemberEnrollment(plan, visits, '2027-01-01').expiresOn, '2027-03-15');
  assert.equal(nextMemberEnrollment(plan, visits, '2027-01-16').remaining, 12);
});

test('warehouse movements use exact decimal quantities and prevent negative stock', () => {
  const before = warehouseQuantity.parse('1.275');
  assert.equal(before, 1275);
  assert.equal(warehouseQuantity.parse('0001.01'), 1010);
  assert.equal(warehouseQuantity.safeParse('1.0001').success, false);
  assert.equal(warehouseQuantity.safeParse('-1').success, false);
  assert.equal(warehouseBalance('RECEIPT', before, 125), 1400);
  assert.equal(warehouseBalance('ISSUE', before, 125), 1150);
  assert.equal(warehouseBalance('COUNT', before, 0), 0);
  assert.throws(() => warehouseBalance('ISSUE', before, 1300), /vượt tồn/);
});

test('warehouse counts support calendar expiry dates and filter discrepancies from saved quantities', () => {
  assert.equal(warehouseExpiry.parse('2032-02-29'), '2032-02-29');
  assert.equal(warehouseExpiry.safeParse('2031-02-29').success, false);
  assert.equal(warehouseExpiry.safeParse('2032-02-29T00:00:00Z').success, false);
  assert.equal(warehouseExpiry.parse(undefined), undefined);
  assert.equal(warehouseExpiry.parse(null), null);
  const counted = { $ifNull: ['$correctedQuantity', '$after'] };
  assert.deepEqual(warehouseCountFilter('SHORT'), { operation: 'COUNT', $expr: { $lt: [counted, '$before'] } });
  assert.deepEqual(warehouseCountFilter('EXCESS'), { operation: 'COUNT', $expr: { $gt: [counted, '$before'] } });
  assert.deepEqual(warehouseCountFilter('MATCH'), { operation: 'COUNT', $expr: { $eq: [counted, '$before'] } });
});

test('company revenue periods start at midnight in Vietnam', () => {
  const current = new Date('2026-10-31T17:10:00.000Z');
  assert.equal(revenueRange('month', current).$gte.toISOString(), '2026-10-31T17:00:00.000Z');
  const later = new Date('2026-11-16T08:00:00.000Z');
  const range = revenueRange('today', later);
  assert.equal(range.$gte.toISOString(), '2026-11-15T17:00:00.000Z');
  assert.equal(range.$lte, later);
});

test('historical reports end at midnight in Vietnam, including calendar boundaries', () => {
  const now = new Date('2026-11-19T03:00:00Z');
  const week = revenueRange('week', now, '2026-01-01');
  assert.equal(week.$gte.toISOString(), '2025-12-28T17:00:00.000Z');
  assert.equal(week.$lte.toISOString(), '2026-01-04T16:59:59.999Z');
  const month = revenueRange('month', now, '2024-02-15');
  assert.equal(month.$gte.toISOString(), '2024-01-31T17:00:00.000Z');
  assert.equal(month.$lte.toISOString(), '2024-02-29T16:59:59.999Z');
  const year = revenueRange('year', now, '2025-07-15');
  assert.equal(year.$gte.toISOString(), '2024-12-31T17:00:00.000Z');
  assert.equal(year.$lte.toISOString(), '2025-12-31T16:59:59.999Z');
  assert.deepEqual(revenueRange('all', now), { $gte: new Date(0), $lte: now });
});

test('QR orders require a fresh, accurate position within the configured branch radius', () => {
  const now = Date.parse('2026-11-19T04:00:00Z');
  const configured = branchLocation.parse({ latitude: 21.0278, longitude: 105.8342, radiusMeters: 100 });
  const inside = guestLocation.parse({ latitude: 21.0281, longitude: 105.8342, accuracy: 10, measuredAt: now });
  assert.ok(distanceMeters(configured, inside) > 33 && distanceMeters(configured, inside) < 34);
  assert.doesNotThrow(() => requireGuestLocation(configured, inside, now));
  assert.throws(() => requireGuestLocation(configured, { ...inside, latitude: 21.03 }, now), /ngoài phạm vi/);
  assert.throws(() => requireGuestLocation(configured, { ...inside, accuracy: 80 }, now), /chưa đủ chính xác/);
  assert.throws(() => requireGuestLocation(configured, { ...inside, measuredAt: now - 61000 }, now), /hết hạn/);
  assert.throws(() => requireGuestLocation(configured, { ...inside, measuredAt: now + 11000 }, now), /hết hạn/);
  assert.throws(() => requireGuestLocation(undefined, inside, now), /chưa ghim/);
  assert.equal(guestLocation.safeParse({ ...inside, longitude: Infinity }).success, false);
  assert.equal(guestLocation.safeParse({ ...inside, accuracy: -1 }).success, false);
  assert.equal(branchLocation.safeParse({ ...configured, radiusMeters: 0 }).success, false);
  assert.equal(branchLocation.safeParse({ ...configured, radiusMeters: 2001 }).success, false);
  assert.ok(distanceMeters({ ...configured, longitude: 179.9999 }, { ...inside, longitude: -179.9999 }) < 40);
});

test('membership freezes prevent access until the Vietnam calendar day of resumption', () => {
  const freeze = { startsOn: '2026-12-29', resumesOn: '2027-01-03' };
  const member = { active: true, expiresOn: shiftDays('2026-12-31', 5), freeze };
  assert.equal(member.expiresOn, '2027-01-05');
  assert.equal(memberAccessStatus(member, '2026-12-28'), 'ACTIVE');
  assert.equal(memberAccessStatus(member, '2026-12-29'), 'FROZEN');
  assert.equal(memberAccessStatus(member, '2027-01-02'), 'FROZEN');
  assert.equal(memberAccessStatus(member, '2027-01-03'), 'ACTIVE');
  assert.equal(memberAccessStatus({ ...member, active: false }, '2026-12-30'), 'PAUSED');
  assert.equal(memberAccessStatus(member, '2027-01-06'), 'EXPIRED');
});

test('tickets honor time boundaries and permit clearing optional sale limits', async () => {
  const opens = new Date('2026-11-19T09:00:00+07:00');
  const closes = new Date('2026-11-19T11:00:00+07:00');
  const terms = { active: true, price: 50000, earlyPrice: 0, earlyUntil: closes };
  assert.equal(ticketWindowState(opens, closes, new Date(+opens - 1)), 'UPCOMING');
  assert.equal(ticketWindowState(opens, closes, opens), 'OPEN');
  assert.equal(ticketWindowState(opens, closes, closes), 'ENDED');
  assert.equal(ticketWindowState(undefined, undefined, opens), 'OPEN');
  assert.equal(ticketSalePrice(terms, new Date(+closes - 1)), 0);
  assert.equal(ticketSalePrice(terms, closes), terms.price);
  const input = { tenantId: new Types.ObjectId(), branchId: new Types.ObjectId(), name: 'Vé vào cửa', price: 50000 };
  await new TicketType({ ...input, capacity: null, earlyPrice: null }).validate();
  await assert.rejects(new TicketType({ ...input, capacity: 1.5 }).validate(), /capacity/);
});

test('ticket issuance assigns every paid entry to a group code or to individual codes', () => {
  assert.deepEqual(ticketEntryQuantities(3, 'GROUP'), [3]);
  assert.deepEqual(ticketEntryQuantities(3, 'SEPARATE'), [1, 1, 1]);
  assert.deepEqual(ticketEntryQuantities(1, 'GROUP'), [1]);
  assert.deepEqual(ticketEntryQuantities(1, 'SEPARATE'), [1]);
});

test('hotel folio totals include room nights and each charge while preserving safe integer amounts', () => {
  assert.equal(stayTotal(350000, 2, []), 700000);
  assert.equal(stayTotal(350000, 2, [{ quantity: 2, unitPrice: 25000 }, { quantity: 1, unitPrice: 70000 }]), 820000);
  assert.throws(() => stayTotal(1, 1, [{ quantity: 2, unitPrice: Number.MAX_SAFE_INTEGER }]), /vượt giới hạn/);
});

test('timed hotel stays share half-open room windows with nightly bookings and preserve separate prices', () => {
  const start = new Date('2026-11-19T22:00:00+07:00');
  const noon = hotelNoon('2026-11-20');
  const end = new Date(+noon + 1);
  const clauses = stayWindowOverlap(start, noon, start).$or;
  assert.deepEqual(clauses[0], { startsAt: { $lt: noon }, endsAt: { $gt: start } });
  assert.equal(clauses[1].bookingType, 'HOURLY');
  assert.equal(clauses[1].endsAt, null);
  assert.deepEqual(clauses[2], { startsAt: null, startsOn: { $lt: '2026-11-20' }, endsOn: { $gt: '2026-11-19' } });
  assert.deepEqual(stayWindowOverlap(start, end).$or[2],
    { startsAt: null, startsOn: { $lte: '2026-11-20' }, endsOn: { $gt: '2026-11-19' } });
  assert.deepEqual(stayWindowOverlap(new Date(+noon - 1), null).$or[2],
    { startsAt: null, endsOn: { $gte: '2026-11-20' } });
  const sameDay = { startsOn: '2026-11-19', endsOn: '2026-11-19', nightlyRate: 0 };
  const charge = { unitPrice: 20_000, quantity: 2 };
  assert.equal(quoteHotelStay({ ...sameDay, bookingType: 'HOURLY', hourlyRate: 55_000, durationHours: 3, charges: [charge] }, start).amount, 205_000);
  assert.equal(quoteHotelStay({ ...sameDay, bookingType: 'PACKAGE', packagePrice: 125_000, durationHours: 5, charges: [charge] }, start).amount, 165_000);
});

test('hourly check-in runs without an end and hotel overtime uses the later-hour rate', () => {
  const startsOn = '2026-11-19';
  const endsOn = '2026-11-20';
  const first = hotelNoon(startsOn);
  const noon = hotelNoon(endsOn);
  const stay = { startsOn, endsOn, status: 'CHECKED_IN', nightlyRate: 250000, hourlyNextRate: 40000 };
  const hourly = { ...stay, bookingType: 'HOURLY', hourlyRate: 70000, checkedInAt: first };
  assert.equal(quoteHotelStay(hourly, first).amount, 70000);
  assert.equal(quoteHotelStay(hourly, new Date(+first + 3600000)).amount, 70000);
  assert.equal(quoteHotelStay(hourly, new Date(+first + 3600001)).amount, 110000);
  assert.equal(quoteHotelStay(hourly, noon).overdue, false);
  assert.equal(quoteHotelStay(stay, noon).amount, 250000);
  const later = new Date(+noon + 3600001);
  const late = quoteHotelStay(stay, later);
  assert.equal(late.overdue, true);
  assert.equal(late.overdueHours, 2);
  assert.equal(late.amount, 330000);
  const packageStay = { ...stay, bookingType: 'PACKAGE', packagePrice: 120000, endsAt: noon, charges: [{ quantity: 2, unitPrice: 5000 }] };
  assert.equal(quoteHotelStay(packageStay, later).amount, 210000);
  assert.equal(quoteHotelStay({ ...packageStay, status: 'CHECKED_OUT', overdueHours: 1, overdueAmount: 40000 }, later).amount, 170000);
  assert.equal(quoteHotelStay({ ...stay, hourlyNextRate: 0 }, later, 90000).overdueAmount, 0);
  assert.equal(quoteHotelStay({ ...stay, hourlyNextRate: null }, later, 30000).overdueAmount, 60000);
});

test('expense totals include saved categories and classify existing manual entries once', () => {
  const summary = summarizeExpenses([
    { _id: { kind: 'STAFF' }, count: 2, total: 6_000_000 },
    { _id: { kind: 'RENT' }, count: 1, total: 3_000_000 },
    { _id: { category: 'Lương tháng 11' }, count: 1, total: 2_000_000 },
    { _id: { category: 'Hóa đơn Điện tháng 11' }, count: 1, total: 200_000 },
    { _id: { category: 'Nước uống' }, count: 1, total: 30_000 },
  ]);
  assert.deepEqual(summary.items.map(item => [item.kind, item.count, item.total]),
    [['STAFF', 3, 8_000_000], ['RENT', 1, 3_000_000], ['UTILITIES', 1, 200_000], ['OTHER', 1, 30_000]]);
  assert.equal(summary.count, 6);
  assert.equal(summary.total, 11_230_000);
});

test('hourly payroll uses effective rates and separates after-shift time from paid regular minutes', () => {
  const at = (time: string) => new Date(`2026-11-12T${time}:00+07:00`);
  const scheduled = { _id: 'first', scheduleId: 'shift', scheduledStartsAt: at('08:00'), scheduledEndsAt: at('16:00'),
    checkedInAt: at('07:42'), checkedOutAt: at('17:30'), status: 'CLOSED' };
  const extra = { _id: 'second', checkedInAt: at('18:00'), checkedOutAt: at('18:45'), status: 'CLOSED' };
  const rates = [{ effectiveOn: '2026-11-13', unit: 'HOUR', rate: 30000, overtimeRate: 50000 },
    { effectiveOn: '2026-11-01', unit: 'HOUR', rate: 25000, overtimeRate: 40000 }] as const;
  const result = calculatePayroll([scheduled, extra], [...rates], at('20:00'));
  assert.equal(result.regularMinutes, 525);
  assert.equal(result.overtimeMinutes, 90);
  assert.equal(result.baseAmount, 218750);
  assert.equal(result.overtimeAmount, 60000);
  assert.equal(result.amount, 278750);
  assert.equal(calculatePayroll([extra, scheduled], [...rates], at('20:00')).revision, result.revision);
});

test('shift payroll combines split attendance, counts overnight overtime and never includes paid or unfinished shifts', () => {
  const at = (day: number, time: string) => new Date(`2026-11-${day}T${time}:00+07:00`);
  const first = { _id: '1', scheduleId: 'night', scheduledStartsAt: at(12, '22:00'), scheduledEndsAt: at(13, '06:00'),
    checkedInAt: at(12, '22:15'), checkedOutAt: at(13, '01:00'), status: 'CLOSED' };
  const second = { ...first, _id: '2', checkedInAt: at(13, '01:30'), checkedOutAt: at(13, '06:20') };
  const noShift = { _id: '3', checkedInAt: at(13, '08:00'), checkedOutAt: at(13, '10:00'), status: 'CLOSED' };
  const paid = { ...first, _id: '4', scheduleId: 'paid', payrollPaymentId: 'payment' };
  const open = { ...first, _id: '5', scheduleId: 'open', status: 'OPEN', checkedOutAt: undefined };
  const rates = [{ effectiveOn: '2026-11-01', unit: 'SHIFT', rate: 240000, overtimeRate: 45000 }] as const;
  const result = calculatePayroll([first, second, noShift, paid, open], [...rates], at(13, '11:00'));
  assert.deepEqual(result.lines.map(line => [line.day, line.attendanceIds, line.baseAmount, line.overtimeAmount]),
    [['2026-11-12', ['1', '2'], 240000, 15000]]);
  assert.deepEqual([result.skipped.alreadyPaid, result.skipped.open, result.skipped.noShift], [1, 1, 1]);
  assert.equal(calculatePayroll([first], [...rates], at(13, '05:00')).amount, 0);
  assert.equal(calculatePayroll([first], [], at(13, '11:00')).skipped.noRate, 1);
});

test('configurable shift hours prorate short shifts and separate excess time as overtime', () => {
  const at = (time: string) => new Date(`2026-11-12T${time}:00+07:00`);
  const record = { _id: 'first', scheduleId: 'morning', scheduledStartsAt: at('08:00'), scheduledEndsAt: at('16:00'),
    checkedInAt: at('07:45'), checkedOutAt: at('12:00'), status: 'CLOSED' };
  const rate = { effectiveOn: '2026-11-01', unit: 'SHIFT' as const, rate: 320000, overtimeRate: 60000, shiftMinutes: 480 };
  const short = calculatePayroll([record], [rate], at('20:00'));
  assert.equal(short.amount, 160000);
  assert.equal(short.lines[0].shiftMinutes, 480);
  const extended = calculatePayroll([record, { ...record, _id: 'second', checkedInAt: at('12:30'), checkedOutAt: at('17:30') }], [rate], at('20:00'));
  assert.deepEqual([extended.regularMinutes, extended.overtimeMinutes, extended.baseAmount, extended.overtimeAmount], [480, 60, 320000, 60000]);
  const sameTotal = calculatePayroll([record], [{ ...rate, rate: 160000, shiftMinutes: 240 }], at('20:00'));
  assert.equal(short.amount, sameTotal.amount);
  assert.notEqual(short.revision, sameTotal.revision);
});

test('fixed shifts repeat on selected Vietnam weekdays and keep overnight hours', () => {
  const start = new Date('2026-11-19T22:00:00+07:00');
  const end = new Date('2026-11-20T06:00:00+07:00');
  const repeated = expandStaffShifts(start, end, 2, [1, 4]);
  assert.deepEqual(repeated.map(shift => facilityToday(+shift.startsAt)),
    ['2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30']);
  assert.ok(repeated.every(shift => +shift.endsAt - +shift.startsAt === 8 * 3_600_000));
  assert.deepEqual(expandStaffShifts(start, end, 1), [{ startsAt: start, endsAt: end }]);
  assert.throws(() => expandStaffShifts(end, start, 1), /Giờ kết thúc/);
});

test('fixed ranges include every local date and keep the same hours across months', () => {
  const start = new Date('2026-11-29T22:00:00+07:00');
  const end = new Date('2026-11-30T06:00:00+07:00');
  const range = expandStaffShiftRange(start, end, '2026-12-02');
  assert.deepEqual(range.map(shift => facilityToday(+shift.startsAt)), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.equal(range[3].endsAt.toISOString(), '2026-12-02T23:00:00.000Z');
  assert.deepEqual(staffShiftOnDate(start, end, range[3].startsAt), range[3]);
  assert.throws(() => expandStaffShiftRange(start, end, '2026-11-28'), /Đến ngày/);
});

test('flexible shifts count worked minutes up to their target and the remainder as overtime', () => {
  const at = (time: string) => new Date(`2026-11-12T${time}:00+07:00`);
  const first = { _id: 'a', scheduleId: 'flex', scheduledStartsAt: at('08:00'), scheduledEndsAt: at('16:00'),
    scheduledKind: 'FLEXIBLE' as const, scheduledTargetMinutes: 240, checkedInAt: at('09:30'), checkedOutAt: at('12:00'), status: 'CLOSED' };
  const second = { ...first, _id: 'b', checkedInAt: at('13:00'), checkedOutAt: at('18:00') };
  const rates = [{ effectiveOn: '2026-11-01', unit: 'HOUR' as const, rate: 30000, overtimeRate: 45000 }];
  const result = calculatePayroll([first, second], rates, at('19:00'));
  assert.equal(result.regularMinutes, 240);
  assert.equal(result.overtimeMinutes, 210);
  assert.equal(result.amount, 277500);
  const daily = calculatePayroll([{ ...first, scheduledTargetMinutes: undefined, checkedOutAt: at('17:00') }], rates, at('19:00'));
  assert.equal(daily.regularMinutes, 390);
  assert.equal(daily.overtimeMinutes, 60);
});

test('automatic device punches debounce repeat scans and preserve explicit directions', () => {
  const at = new Date('2026-11-19T08:00:00+07:00');
  const soon = new Date(+at + 10_000);
  const afterMinute = new Date(+at + 60_000);
  const last = { at, open: true, sameBranch: true };
  assert.deepEqual(resolveStaffPunch('AUTO', at), { direction: 'IN', duplicate: false });
  assert.deepEqual(resolveStaffPunch('AUTO', soon, last), { direction: 'IN', duplicate: true });
  assert.deepEqual(resolveStaffPunch('AUTO', afterMinute, last), { direction: 'OUT', duplicate: false });
  assert.deepEqual(resolveStaffPunch('OUT', soon, last), { direction: 'OUT', duplicate: false });
  assert.deepEqual(resolveStaffPunch('AUTO', soon, { ...last, sameBranch: false }), { direction: 'OUT', duplicate: false });
  assert.throws(() => resolveStaffPunch('OUT', new Date(+at - 1), last), /sai thứ tự/);
});

test('shift status distinguishes agreed leave, no-show, and real attendance', () => {
  const endsAt = new Date('2026-11-19T17:00:00+07:00');
  const before = new Date(+endsAt - 1);
  assert.equal(staffShiftStatus({ endsAt }, undefined, before), 'PLANNED');
  assert.equal(staffShiftStatus({ endsAt }, undefined, endsAt), 'ABSENT');
  assert.equal(staffShiftStatus({ endsAt, leaveAt: before }, undefined, endsAt), 'LEAVE');
  assert.equal(staffShiftStatus({ endsAt }, { open: 0 }, endsAt), 'ATTENDED');
  assert.equal(staffShiftStatus({ endsAt }, { open: 1 }, before), 'WORKING');
  assert.equal(staffShiftStatus({ endsAt, canceledAt: before }, undefined, endsAt), 'CANCELED');
});
