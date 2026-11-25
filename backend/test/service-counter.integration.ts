import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db';
import { AuditLog, Bill, Branch, IdempotencyRecord, Membership, Order, OutboxEvent, Payment, Product,
  ProductVariant, PurchaseReceipt, Refund, Subscription, Tenant, User, UserSession, WarehouseItem, WarehouseMovement } from '../src/models';

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
    for (const mode of ['GYM', 'POOL', 'HOTEL', 'TICKETS']) {
      const credentials = { email: `counter-${randomUUID()}@example.com`, password: 'counter-test-password-1' };
      const user = await expectJson(await request('/auth/register', 'POST', { ...credentials, name: 'Quản lý quầy' }));
      userIds.push(user.id);
      const { accessToken: owner } = await expectJson(await request('/auth/login', 'POST', credentials));
      const site = await expectJson(await request('/tenants', 'POST', { name: `Quầy ${mode}`,
        branch: { name: 'Quầy chính', mode, location: { latitude: 21, longitude: 105, radiusMeters: 100 } } }, owner));
      tenantIds.push(site.id);
      const branchId = site.branches[0].id;
      const root = `/tenants/${site.id}/branches/${branchId}`;
      const scope = { tenantId: new mongoose.Types.ObjectId(site.id), branchId: new mongoose.Types.ObjectId(branchId) };
      const item = await expectJson(await request(`${root}/warehouse/items`, 'POST',
        { name: 'Nước suối', code: 'NUOC', barcode: '8930123456789', unit: 'chai', minimum: '2' }, owner));
      await expectJson(await request(`${root}/purchases`, 'POST', { supplier: 'Kho đồ uống', method: 'CASH',
        lines: [{ itemId: item.id, quantity: '5', unitCost: 4000, taxBps: 0 }] }, owner));
      const listing = await expectJson(await request(`${root}/retail-products`, 'POST',
        { warehouseItemId: item.id, price: 12000, description: '' }, owner));

      // A tenant-wide product is not a stocked listing for this service counter.
      const shared = await Product.create({ tenantId: scope.tenantId, name: 'Hàng dùng chung', productType: 'RETAIL' });
      const sharedSku = await ProductVariant.create({ tenantId: scope.tenantId, productId: shared._id, sku: 'SHARED', basePrice: 1, costPrice: 0 });
      const catalog = await expectJson(await request(`${root}/products?code=8930123456789&productType=RETAIL`, 'GET', undefined, owner), 200);
      assert.deepEqual(catalog.map(({ id }: { id: string }) => id), [listing.id]);
      const variantId = catalog[0].variants[0].id;
      const checkout = { method: 'CASH', productType: 'RETAIL', items: [{ variantId, quantity: 2 }], expectedTotal: 24000 };
      assert.equal((await request(`${root}/checkout`, 'POST',
        { ...checkout, items: [{ variantId: sharedSku.id, quantity: 1 }] }, owner)).status, 404);

      const { accessToken: cashier } = await expectJson(await request('/auth/work-mode', 'POST',
        { mode: 'STAFF', tenantId: site.id, branchId }, owner), 200);
      assert.equal((await request(`${root}/retail-products`, 'POST', { warehouseItemId: item.id, price: 1, description: '' }, cashier)).status, 403);
      const key = randomUUID();
      const sell = () => request(`${root}/checkout`, 'POST', checkout, cashier, key);
      const paid = await expectJson(await sell());
      assert.equal(paid.bill.status, 'PAID');
      assert.equal(paid.bill.totalAmount, 24000);
      assert.equal((await expectJson(await sell())).bill.id, paid.bill.id);
      assert.equal((await WarehouseItem.findById(item.id).lean())?.onHand, 3000);
      const orders = await expectJson(await request(`${root}/orders`, 'GET', undefined, cashier), 200);
      assert.equal(orders[0].items[0].name, 'Nước suối');
      assert.equal((await request(`${root}/payments/${paid.payment.id}/refunds`, 'POST',
        { amount: 24000, reason: 'Khách trả hàng' }, cashier)).status, 403);

      const { accessToken: manager } = await expectJson(await request('/auth/work-mode', 'POST',
        { mode: 'MANAGEMENT', password: credentials.password }, cashier), 200);
      const report = await expectJson(await request(`${root}/accounting?period=all`, 'GET', undefined, manager), 200);
      assert.equal(report.sales.total, 24000);
      assert.equal(report.memberPayments.total + report.hotelPayments.total + report.ticketPayments.total, 0);
      await expectJson(await request(`${root}/payments/${paid.payment.id}/refunds`, 'POST',
        { amount: 24000, reason: 'Khách trả hàng' }, manager));
      assert.equal((await WarehouseItem.findById(item.id).lean())?.onHand, 5000);
    }
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
    try {
      const tenantId = { $in: tenantIds.map(id => new mongoose.Types.ObjectId(id)) };
      await Promise.all([AuditLog, Bill, Branch, IdempotencyRecord, Membership, Order, OutboxEvent, Payment, Product, ProductVariant,
        PurchaseReceipt, Refund, Subscription, WarehouseItem, WarehouseMovement].map(model => model.collection.deleteMany({ tenantId })));
      await Tenant.deleteMany({ _id: tenantId });
      await UserSession.deleteMany({ userId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    } finally {
      await mongoose.disconnect();
    }
  }
});
