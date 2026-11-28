import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db';
import { AuditLog, Bill, BookingRequest, Branch, HotelBooking, IdempotencyRecord, MemberPayment, Membership, Order, OutboxEvent, Payment, Product,
  ProductVariant, PurchaseReceipt, Refund, Subscription, Tenant, TicketSale, User, UserSession, WarehouseItem, WarehouseMovement } from '../src/models';
import { facilityToday, shiftDays } from '../src/services/membership-plans';

test('service branches sell warehouse goods from reception and account for them separately', { timeout: 45000 }, async () => {
  const rawUri = process.env.TEST_DATABASE_URL;
  assert.ok(rawUri, 'Set TEST_DATABASE_URL to an isolated MongoDB replica set.');
  const uri = new URL(rawUri);
  assert.match(uri.pathname, /^\/[a-z0-9_-]+_test$/i);
  uri.pathname = uri.pathname.replace(/_test$/i, '_counter_test');
  const port = process.env.COUNTER_TEST_API_PORT ?? String(Number(process.env.TEST_API_PORT ?? 14000) + 2);
  const origin = 'http://localhost:3000';
  const env = { ...process.env, NODE_ENV: 'test', PORT: port, BIND_HOST: '127.0.0.1', WEB_ORIGIN: origin, PUBLIC_ORDER_ORIGIN: '',
    MONGODB_URI: uri.href, JWT_SECRET: randomBytes(32).toString('hex'), SMTP_URL: '', MAIL_FROM: '', BOOTSTRAP_ADMIN_EMAIL: '' };
  process.env.MONGODB_URI = uri.href;
  const seeded = spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/seed.ts'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  await connectDatabase();
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env, stdio: 'ignore' });
  const exited = once(server, 'exit');

  const userIds: string[] = [];
  const tenantIds: string[] = [];
  const request = (route: string, method = 'GET', body?: unknown, token?: string, key = randomUUID()) =>
    fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(token && { Authorization: `Bearer ${token}` }) },
    });
  const expectJson = async (response: Response, status = 201) => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 25 && !healthy; attempt++) {
      healthy = (await request('/health').catch(() => undefined))?.ok ?? false;
      if (!healthy) await setTimeout(200);
    }
    assert.ok(healthy);
    const today = facilityToday();
    const [expired, nearest, preferred, latest] = [-2, 3, 10, 20].map(days => shiftDays(today, days));
    for (const [index, mode] of ['GYM', 'POOL', 'HOTEL', 'TICKETS'].entries()) {
      const credentials = { email: `counter-${randomUUID()}@example.com`, password: 'counter-test-password-1' };
      const user = await expectJson(await request('/auth/register', 'POST', { ...credentials, name: 'Quản lý quầy', phone: `090123452${index}` }));
      userIds.push(user.id);
      const { accessToken: owner } = await expectJson(await request('/auth/login', 'POST', credentials));
      const site = await expectJson(await request('/tenants', 'POST', { name: `Quầy ${mode}`,
        branch: { name: 'Quầy chính', mode, location: { latitude: 21, longitude: 105, radiusMeters: 100 } } }, owner));
      tenantIds.push(site.id);
      const branchId = site.branches[0].id;
      const root = `/tenants/${site.id}/branches/${branchId}`;
      const scope = { tenantId: new mongoose.Types.ObjectId(site.id), branchId: new mongoose.Types.ObjectId(branchId) };
      const item = await expectJson(await request(`${root}/warehouse/items`, 'POST',
        { name: 'Nước suối', code: 'NUOC', barcode: '8930123456789', unit: 'chai', minimum: '2', ...(index === 0 && { size: 'M' }) }, owner));
      const itemPath = `${root}/warehouse/items/${item.id}`;
      const readItem = async (token = owner) => expectJson(await request(itemPath, 'GET', undefined, token), 200);
      const updateLot = async (action: string, expiresOn: string | null, revision: number, key?: string, token = owner) =>
        request(`${itemPath}/lots`, 'PATCH', { action, expiresOn, revision }, token, key);
      const lots = index === 0 ? [[expired, '1'], [nearest, '1'], [preferred, '1'], [latest, '2']] : [[undefined, '5']];
      await expectJson(await request(`${root}/purchases`, 'POST', { supplier: 'Kho đồ uống', method: 'CASH',
        lines: lots.map(([expiresOn, quantity]) => ({ itemId: item.id, expiresOn, quantity, unitCost: 4000, taxBps: 0 })) }, owner));
      if (index === 0) {
        const stocked = await readItem();
        assert.deepEqual(stocked.lots.map((lot: { quantity: number }) => lot.quantity), [1000, 1000, 1000, 2000]);
        assert.equal((await updateLot('PRIORITIZE', expired, stocked.revision)).status, 409);
        assert.equal((await updateLot('CONFIRM_EMPTY', nearest, stocked.revision)).status, 409);
        await expectJson(await updateLot('PRIORITIZE', preferred, stocked.revision), 200);
        assert.equal((await readItem()).priorityExpiry, preferred);
        assert.equal((await updateLot('PRIORITIZE', null, stocked.revision)).status, 409);
      }
      const listing = await expectJson(await request(`${root}/retail-products`, 'POST',
        { warehouseItemId: item.id, price: 12000, description: '' }, owner));

      // A tenant-wide product is not a stocked listing for this service counter.
      const shared = await Product.create({ tenantId: scope.tenantId, name: 'Hàng dùng chung', productType: 'RETAIL' });
      const sharedSku = await ProductVariant.create({ tenantId: scope.tenantId, productId: shared._id, sku: 'SHARED', basePrice: 1, costPrice: 0 });
      const catalog = await expectJson(await request(`${root}/products?code=8930123456789&productType=RETAIL`, 'GET', undefined, owner), 200);
      assert.deepEqual(catalog.map(({ id }: { id: string }) => id), [listing.id]);
      const variantId = catalog[0].variants[0].id;
      let checkoutItems = [{ variantId, quantity: 2 }];
      let expectedTotal = 24000;
      let expectedNames = ['Nước suối'];
      let promotionCode: string | undefined;
      const sizes = `${root}/retail-products/${listing.id}/sizes`;
      if (index === 0) {
        const sizeKey = randomUUID();
        const large = { size: 'L', price: 15000 };
        const addLarge = () => request(sizes, 'POST', large, owner, sizeKey);
        const largeVariant = await expectJson(await addLarge());
        assert.equal((await expectJson(await addLarge())).id, largeVariant.id);
        await WarehouseItem.updateOne({ _id: item.id }, { $set: { size: 'L' } });
        await expectJson(await request(`${sizes}/${largeVariant.id}`, 'PATCH', { size: 'L', price: 16000 }, owner), 200);
        const collisions = await Promise.all([
          request(sizes, 'POST', { size: 'XL', price: 19000 }, owner),
          request(sizes, 'POST', { size: 'ｘｌ', price: 20000 }, owner),
        ]);
        assert.deepEqual(collisions.map(response => response.status).sort(), [201, 409]);
        await expectJson(await request(`${root}/retail-products/${listing.id}`, 'PATCH',
          { price: 13000, description: 'Cỡ chuẩn', retailDiscountPercent: 10 }, owner), 200);
        const lookedUp = await expectJson(await request(`${root}/products?code=8930123456789&productType=RETAIL`, 'GET', undefined, owner), 200);
        assert.equal(lookedUp.length, 1);
        assert.equal(lookedUp[0].variants[0].id, variantId);
        assert.ok(lookedUp[0].variants.every((row: { barcode: string }) => row.barcode === '8930123456789'));
        const prices = new Map(lookedUp[0].variants.map((row: { attributes: { size: string }; basePrice: number }) => [row.attributes.size, row.basePrice]));
        assert.equal(prices.get('M'), 13000);
        assert.equal(prices.get('L'), 16000);
        assert.equal(lookedUp[0].variants.find((row: { id: string }) => row.id === largeVariant.id).retailPrice, 14400);
        promotionCode = 'QUAY1900';
        await expectJson(await request(`${root}/retail-promotions`, 'POST', { code: promotionCode, name: 'Voucher tại quầy',
          kind: 'FIXED', value: 1900, minimum: 20000, productIds: [listing.id], enabled: true,
          startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 600000).toISOString() }, owner));
        checkoutItems = [{ variantId, quantity: 1 }, { variantId: largeVariant.id, quantity: 1 }];
        expectedTotal = 24200;
        expectedNames = ['Nước suối · M', 'Nước suối · L'];
      }
      const checkout = { method: 'CASH', productType: 'RETAIL', items: checkoutItems, expectedTotal, promotionCode };
      assert.equal((await request(`${root}/checkout`, 'POST', { ...checkout, discountAmount: 1000 }, owner)).status, 409);
      assert.equal((await request(`${root}/checkout`, 'POST',
        { ...checkout, items: [{ variantId: sharedSku.id, quantity: 1 }] }, owner)).status, 404);

      const { accessToken: cashier } = await expectJson(await request('/auth/work-mode', 'POST',
        { mode: 'STAFF', tenantId: site.id, branchId }, owner), 200);
      assert.equal((await request(`${root}/retail-products`, 'POST', { warehouseItemId: item.id, price: 1, description: '' }, cashier)).status, 403);
      assert.equal((await request(sizes, 'POST', { size: 'S', price: 9000 }, cashier)).status, 403);
      const key = randomUUID();
      const sell = () => request(`${root}/checkout`, 'POST', checkout, cashier, key);
      const paid = await expectJson(await sell());
      assert.equal(paid.bill.status, 'PAID');
      assert.equal(paid.bill.totalAmount, expectedTotal);
      if (promotionCode) {
        assert.deepEqual(paid.order.items.map((line: { unitPrice: number }) => line.unitPrice), [11700, 14400]);
        assert.equal(paid.bill.discountAmount, 1900);
      }
      assert.equal((await expectJson(await sell())).bill.id, paid.bill.id);
      assert.equal((await WarehouseItem.findById(item.id).lean())?.onHand, 3000);
      const orders = await expectJson(await request(`${root}/orders`, 'GET', undefined, cashier), 200);
      assert.deepEqual(orders[0].items.map((line: { name: string }) => line.name), expectedNames);
      assert.equal((await updateLot('PRIORITIZE', null, 0, undefined, cashier)).status, 403);
      assert.equal((await request(`${root}/payments/${paid.payment.id}/refunds`, 'POST',
        { amount: expectedTotal, reason: 'Khách trả hàng' }, cashier)).status, 403);

      const { accessToken: manager } = await expectJson(await request('/auth/work-mode', 'POST',
        { mode: 'MANAGEMENT', password: credentials.password }, cashier), 200);
      if (index === 0) {
        const order = await Order.findById(orders[0].id).lean();
        assert.deepEqual(order?.items.map(line => line.stockLots?.[0]?.expiresOn), [preferred, nearest]);
        const remaining = await readItem(manager);
        assert.equal(remaining.priorityExpiry, undefined);
        assert.deepEqual(remaining.lots, [{ expiresOn: expired, quantity: 1000 }, { expiresOn: nearest, quantity: 0 },
          { expiresOn: preferred, quantity: 0 }, { expiresOn: latest, quantity: 2000 }]);
        const key = randomUUID();
        await expectJson(await updateLot('CONFIRM_EMPTY', preferred, remaining.revision, key, manager), 200);
        await expectJson(await updateLot('CONFIRM_EMPTY', preferred, remaining.revision, key, manager), 200);
        assert.deepEqual((await readItem(manager)).lots, remaining.lots.filter((lot: { expiresOn: string }) => lot.expiresOn !== preferred));
      }
      const report = await expectJson(await request(`${root}/accounting?period=all`, 'GET', undefined, manager), 200);
      assert.equal(report.sales.total, expectedTotal);
      assert.equal(report.memberPayments.total + report.hotelPayments.total + report.ticketPayments.total, 0);
      await expectJson(await request(`${root}/payments/${paid.payment.id}/refunds`, 'POST',
        { amount: expectedTotal, reason: 'Khách trả hàng' }, manager));
      assert.equal((await WarehouseItem.findById(item.id).lean())?.onHand, 5000);
      if (index === 0) {
        const restored = await readItem(manager);
        assert.ok(restored.lots.some((lot: { expiresOn: string; quantity: number }) => lot.expiresOn === preferred && lot.quantity === 1000));
        const move = (body: object) => request(`${root}/warehouse/movements`, 'POST', { itemId: item.id, note: 'Kiểm kho', ...body }, manager);
        const issued = await expectJson(await move({ operation: 'ISSUE', quantity: '1', revision: restored.revision }));
        assert.deepEqual(issued.lotAllocation, [{ expiresOn: nearest, quantity: 1000 }]);
        const recounted = await expectJson(await move({ operation: 'COUNT', quantity: '5', revision: issued.itemRevision,
          countedLots: [{ expiresOn: expired, quantity: '1' }, { expiresOn: nearest, quantity: '2' },
            { expiresOn: preferred, quantity: '0' }, { expiresOn: latest, quantity: '2' }] }));
        assert.deepEqual(recounted.lotsAfter, [{ expiresOn: expired, quantity: 1000 }, { expiresOn: nearest, quantity: 2000 },
          { expiresOn: preferred, quantity: 0 }, { expiresOn: latest, quantity: 2000 }]);
        await expectJson(await move({ operation: 'RECEIPT', quantity: '3', revision: recounted.itemRevision, expiresOn: preferred }));
        assert.ok((await readItem(manager)).lots.some((lot: { expiresOn: string; quantity: number }) => lot.expiresOn === preferred && lot.quantity === 3000));
      }

      const paidAt = new Date(Date.parse(paid.bill.createdAt) + 1000);
      const actorId = new mongoose.Types.ObjectId(user.id);
      let service;
      if (mode === 'HOTEL') {
        const publicLink = `/bookings/${site.id}/${branchId}`;
        const queuePath = `${root}/booking-requests`;
        const settings = `${queuePath}/settings`;
        assert.equal((await request(publicLink)).status, 404);
        assert.equal((await request(queuePath)).status, 401);
        const delegatedCredentials = { email: `booking-${randomUUID()}@example.com`, password: credentials.password };
        const delegatedUser = await expectJson(await request('/auth/register', 'POST',
          { ...delegatedCredentials, name: 'Quản lý đặt trước', phone: '0901234545' }));
        userIds.push(delegatedUser.id);
        await Membership.create({ tenantId: scope.tenantId, userId: delegatedUser.id, role: 'MANAGER', branchIds: [scope.branchId] });
        const { accessToken: delegated } = await expectJson(await request('/auth/login', 'POST', delegatedCredentials));
        assert.equal((await request(settings, 'PATCH', { enabled: true }, delegated)).status, 403);
        await expectJson(await request(settings, 'PATCH', { enabled: true }, manager), 200);
        assert.deepEqual(await expectJson(await request(publicLink), 200), { storeName: site.name, branchName: 'Quầy chính', mode });
        const submission = { guestName: 'Khách đặt trước', phone: '0901234567', partySize: 2, note: 'Đến sớm',
          startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() };
        assert.equal((await request(publicLink, 'POST', { ...submission, endsAt: submission.startsAt })).status, 400);
        const key = randomUUID();
        const booking = await expectJson(await request(publicLink, 'POST', submission, undefined, key));
        assert.deepEqual(await expectJson(await request(publicLink, 'POST', submission, undefined, key)), booking);
        assert.deepEqual(Object.keys(booking), ['id']);
        const pending = await expectJson(await request(queuePath, 'GET', undefined, delegated), 200);
        assert.deepEqual(pending.items.map((item: { id: string }) => item.id), [booking.id]);
        assert.equal(pending.items[0].phone, '+84901234567');
        const reviewPath = `${queuePath}/${booking.id}`;
        await expectJson(await request(reviewPath, 'PATCH', { status: 'CONFIRMED' }, delegated), 200);
        assert.equal((await request(reviewPath, 'PATCH', { status: 'DECLINED' }, manager)).status, 409);
        await expectJson(await request(settings, 'PATCH', { enabled: false }, manager), 200);
        assert.equal((await request(publicLink)).status, 404);
        assert.equal((await request(publicLink, 'POST', submission)).status, 404);
        const confirmed = await expectJson(await request(`${queuePath}?status=CONFIRMED`, 'GET', undefined, manager), 200);
        assert.equal(confirmed.enabled, false);
        assert.deepEqual(confirmed.items.map((item: { id: string }) => item.id), [booking.id]);

        const stay = { ...scope, roomId: new mongoose.Types.ObjectId(), roomCode: 'P101', guestName: 'Khách lưu trú', phone: '0900000001',
          guestCount: 1, startsOn: today, endsOn: shiftDays(today, 1), nightlyRate: 250000, amount: 250000 };
        await HotelBooking.create({ ...stay, status: 'CHECKED_IN' });
        const room = await HotelBooking.create({ ...stay, status: 'CHECKED_OUT', paymentMethod: 'TRANSFER', paidAt });
        service = { id: room.id, source: 'HOTEL', title: 'P101', customer: 'Khách lưu trú', amount: 250000, method: 'TRANSFER', status: 'PAID' };
      } else if (mode === 'TICKETS') {
        const ticket = await TicketSale.create({ ...scope, actorId, typeId: new mongoose.Types.ObjectId(), typeName: 'Vé vào cửa',
          buyerName: 'Khách mua vé', buyerPhone: '0900000002', unitPrice: 50000, quantity: 2, amount: 100000,
          paymentMethod: 'CASH', paidAt, refundedAt: paidAt });
        service = { id: ticket.id, source: 'TICKET', title: 'Vé vào cửa', customer: 'Khách mua vé', amount: 100000, method: 'CASH', status: 'REFUNDED', quantity: 2 };
      } else {
        const member = await MemberPayment.create({ ...scope, actorId, memberId: new mongoose.Types.ObjectId(), memberName: 'Hội viên mẫu',
          planId: new mongoose.Types.ObjectId(), planName: 'Gói tháng', amount: 300000, method: 'TRANSFER', paidAt });
        service = { id: member.id, source: 'MEMBER', title: 'Gói tháng', customer: 'Hội viên mẫu', amount: 300000, method: 'TRANSFER', status: 'PAID' };
      }
      const history = async (filter = '') => expectJson(await request(`${root}/payment-history${filter}`, 'GET', undefined, manager), 200);
      const serviceRow = { ...service, occurredAt: paidAt.toISOString() };
      const goodsRow = { id: paid.bill.id, occurredAt: paid.bill.createdAt, source: 'GOODS', amount: expectedTotal, status: 'REFUNDED' };
      assert.deepEqual(await history(), { items: [serviceRow, goodsRow], hasMore: false });
      assert.deepEqual(await history(`?source=${service.source}`), { items: [serviceRow], hasMore: false });
      assert.deepEqual(await history('?source=GOODS'), { items: [goodsRow], hasMore: false });
      assert.deepEqual(await history(`?source=${service.source === 'HOTEL' ? 'TICKET' : 'HOTEL'}`), { items: [], hasMore: false });
      if (index === 0) {
        await Bill.insertMany(Array.from({ length: 49 }, () => ({ ...scope, orderIds: [], createdAt: paidAt,
          status: 'OPEN', totalAmount: 1000, paidAmount: 0 })));
        const first = await history();
        const second = await history('?page=2');
        assert.equal(first.items.length, 50);
        assert.equal(first.hasMore, true);
        assert.equal(first.items.some((row: { status: string }) => row.status === 'OPEN'), true);
        assert.deepEqual(second, { items: [goodsRow], hasMore: false });
      }
    }
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
    try {
      const tenantId = { $in: tenantIds.map(id => new mongoose.Types.ObjectId(id)) };
      await Promise.all([AuditLog, Bill, BookingRequest, Branch, HotelBooking, IdempotencyRecord, MemberPayment, Membership, Order, OutboxEvent, Payment, Product, ProductVariant,
        PurchaseReceipt, Refund, Subscription, TicketSale, WarehouseItem, WarehouseMovement].map(model => model.collection.deleteMany({ tenantId })));
      await Tenant.deleteMany({ _id: tenantId });
      await UserSession.deleteMany({ userId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    } finally {
      await mongoose.disconnect();
    }
  }
});
