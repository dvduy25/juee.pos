import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db';
import { hotelNoon } from '../src/services/hotel-stays';
import { facilityToday, shiftDays } from '../src/services/membership-plans';
import { verificationDigest, tokenDigest } from '../src/services/account-email';
import { beginGoogleSignup, googleFlowCookie, googleSignupCookie, readGoogleFlow } from '../src/services/google-auth';
import { suggestMenuItems, suggestRetailItems, suggestWarehouseItems } from '../src/services/inventory-ai-import';
import { AccountToken, AdminAuditLog, AuditLog, Bill, Branch, BranchProductPrice, BuffetPackage, Category, DiningArea, DiningTable, FacilityMember, GuestSession, IdempotencyRecord, IncomingTransfer, KitchenTicket, MemberCredential, MemberPayment, MemberPlan, Membership, MemberVisit, Order, OutboxEvent, Payment, PaymentIntent, Plan, PlanVersion, PlatformGrant, Product, ProductVariant, Refund, SaaSInvoice, Subscription, TableSession, Tenant, UnavailableProduct, User, UserSession, WarehouseItem, WarehouseMovement } from '../src/models';
import { AdmissionTicket, BusinessAiSettings, CashEntry, TaxDeclaration, DishRecipe, HotelBooking, HotelPackage, HotelRoom, MemberClass, PurchaseReceipt, StaffAttendance, StaffClockCredential, StaffClockDevice,
  StaffDocument, StaffIdentity, StaffPayPayment, StaffPayRate, StaffSchedule, TicketRefund, TicketSale, TicketType } from '../src/models';
import { authenticator } from 'otplib';
import { setTimeout } from 'node:timers/promises';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const secondaryOrigin = 'http://localhost:3001';
const adminOrigin = 'http://127.0.0.1:3002';
const port = process.env.TEST_API_PORT ?? '14000';
const base = `http://127.0.0.1:${port}/api/v1`;
const password = 'juee-test-password-1';
const newPassword = 'juee-test-password-2';
const run = randomUUID();
const avatarFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');

function staffForm(profile: object, documents = false) {
  const form = new FormData();
  form.set('profile', JSON.stringify(profile));
  form.set('avatar', new Blob([avatarFixture], { type: 'image/png' }), 'avatar.png');
  if (documents) {
    form.append('documents', new Blob([avatarFixture], { type: 'image/png' }), 'mat-truoc.png');
    form.append('documents', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')],
      { type: 'image/png' }), 'mat-sau.png');
  }
  return form;
}

let requestCount = 0;
let firstRequestAt = 0;
let nextWindow: Promise<void> | undefined;

async function request(path: string, method = 'GET', data?: unknown, accessToken?: string, extra?: Record<string, string>) {
  // Keep the long integration scenario below the API's shared per-minute limit.
  if (requestCount >= 298) {
    nextWindow ??= setTimeout(Math.max(0, firstRequestAt + 63_000 - Date.now())).then(() => {
      firstRequestAt = Date.now();
      requestCount = 0;
      nextWindow = undefined;
    });
    await nextWindow;
  }
  if (!firstRequestAt) firstRequestAt = Date.now();
  requestCount++;
  return fetch(base + path, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: { Origin: origin, ...(data instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...extra },
    body: data instanceof FormData ? data : JSON.stringify(data),
  });
}

async function login(email: string, value = password) {
  const response = await request('/auth/login', 'POST', { email, password: value });
  assert.equal(response.status, 201);
  const { accessToken } = await response.json();
  return accessToken as string;
}

test('JUEE POS API against an isolated MongoDB replica set', { timeout: 150000 }, async () => {
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to a MongoDB replica set with a database name ending in _test.');
  assert.match(new URL(databaseUrl).pathname, /^\/[a-z0-9_-]+_test$/i);
  const webhookKey = randomBytes(32).toString('hex');
  const env = { ...process.env, SEPAY_WEBHOOK_API_KEY: webhookKey, MONGODB_URI: databaseUrl, WEB_ORIGIN: origin, ADMIN_WEB_ORIGIN: adminOrigin, PUBLIC_ORDER_ORIGIN: '', PORT: port,
    SECONDARY_WEB_ORIGIN: secondaryOrigin,
    NODE_ENV: 'test', JWT_SECRET: randomBytes(32).toString('hex'), AI_KEY_ENCRYPTION_SECRET: randomBytes(32).toString('hex'), SMTP_URL: '', MAIL_FROM: '', BOOTSTRAP_ADMIN_EMAIL: '',
    GOOGLE_CLIENT_ID: 'integration-client', GOOGLE_CLIENT_SECRET: 'integration-secret' };
  process.env.MONGODB_URI = databaseUrl;
  process.env.JWT_SECRET = env.JWT_SECRET;
  const ownerEmail = `owner-${run}@example.com`;
  const staffEmail = `staff-${run}@example.com`;
  const userIds: string[] = [];
  const tenantIds: string[] = [];
  const adminEmail = `admin-${run}@example.com`;
  const adminSecret = authenticator.generateSecret(20);
  const seed = spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/seed.ts'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(seed.status, 0, `Seed failed: ${seed.stderr}`);
  await connectDatabase();
  for (const phone of ['090 123 4503', '+84 901 234 503']) {
    const legacy = await User.create({ email: `legacy-${randomUUID()}@example.com`, name: 'Tài khoản cũ', phone });
    userIds.push(legacy.id);
  }
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env, stdio: 'ignore' });
  const exited = once(server, 'exit');

  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 25; attempt++) {
      if (server.exitCode !== null) break;
      health = await request('/health').catch(() => undefined);
      if (health?.ok) break;
      await setTimeout(200);
    }
    assert.equal(health?.status, 200, 'API or database unavailable');
    const plans = await request('/plans');
    assert.equal(plans.status, 200);
    const offers: { code: string; monthlyVnd: string }[] = await plans.json();
    assert.deepEqual(offers.map(({ code, monthlyVnd }) => [code, monthlyVnd]), [['FREE', '0']]);

    const ownerRegistration = { email: ownerEmail, name: 'Chủ cửa hàng', password };
    assert.equal((await request('/auth/register', 'POST', ownerRegistration)).status, 400);
    const accountIds: string[] = [];
    for (const [email, name, phone] of [[ownerEmail, 'Chủ cửa hàng', '0901234501'], [staffEmail, 'Quản lý', '0901234502']]) {
      const response = await request('/auth/register', 'POST', { email, name, password, phone });
      assert.equal(response.status, 201);
      const { id } = await response.json();
      accountIds.push(id);
      userIds.push(id);
    }
    const [ownerId, staffId] = accountIds;
    assert.equal((await request('/auth/register', 'POST', { ...ownerRegistration, email: ownerEmail.toUpperCase(), phone: '0901234504' })).status, 409);
    const alternateEmail = `duplicate-${run}@example.com`;
    for (const phone of ['+84 (901) 234-501', '84901234503']) {
      assert.equal((await request('/auth/register', 'POST', { ...ownerRegistration, email: alternateEmail, phone })).status, 409);
    }
    const simultaneous = await Promise.all(['0901234504', '+84 901 234 504'].map(phone => request('/auth/register', 'POST', {
      ...ownerRegistration, email: `concurrent-${randomUUID()}@example.com`, phone,
    })));
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [201, 409]);
    for (const response of simultaneous) if (response.ok) userIds.push((await response.json()).id);

    const startGoogle = await fetch(`${base}/auth/google/start?${new URLSearchParams({ from: 'register', origin: secondaryOrigin })}`, { redirect: 'manual' });
    assert.equal(startGoogle.status, 303);
    const googleLocation = new URL(startGoogle.headers.get('location')!);
    assert.equal(googleLocation.origin, 'https://accounts.google.com');
    assert.equal(googleLocation.searchParams.get('redirect_uri'), `${secondaryOrigin}/api/v1/auth/google/callback`);
    const flowCookie = startGoogle.headers.getSetCookie().find(item => item.startsWith(`${googleFlowCookie().name}=`));
    assert.equal(readGoogleFlow(flowCookie?.split(';', 1)[0].split('=')[1])?.origin, secondaryOrigin);

    const googleProfile = { subject: 'google-' + run, email: `google-${run}@gmail.com`, name: 'Google test', next: '/dashboard', origin: secondaryOrigin };
    const googlePending = beginGoogleSignup(googleProfile);
    const googleHeaders = { Origin: secondaryOrigin, Cookie: `${googleSignupCookie().name}=${googlePending.cookie}` };
    assert.equal((await request('/auth/google/register', 'POST', { phone: '0901234506' })).status, 401);
    assert.equal((await request('/auth/google/register', 'POST', {}, undefined, googleHeaders)).status, 400);
    assert.equal((await request('/auth/google/register', 'POST', { phone: '+84901234501' }, undefined, googleHeaders)).status, 409);
    assert.equal((await request('/auth/google/register', 'POST', { phone: '0901234506' }, undefined, { ...googleHeaders, Origin: origin })).status, 401);
    assert.equal(await User.exists({ email: googleProfile.email }), null);
    const googleRegistration = await request('/auth/google/register', 'POST', { phone: '0901234506' }, undefined, googleHeaders);
    assert.equal(googleRegistration.status, 200);
    assert.match(googleRegistration.headers.get('set-cookie') ?? '', /juee_refresh=/);
    const googleAccount = await User.findOne({ email: googleProfile.email });
    assert.ok(googleAccount);
    userIds.push(googleAccount.id);
    assert.equal(googleAccount.registrationPhone, '+84901234506');
    assert.ok(googleAccount.emailVerifiedAt);
    assert.equal(googleAccount.passwordHash, undefined);
    assert.equal((await request('/auth/google/register', 'POST', { phone: '0901234507' }, undefined, googleHeaders)).status, 409);

    await User.updateOne({ _id: ownerId }, { $set: { emailVerificationRequired: true } });
    assert.equal((await request('/auth/login', 'POST', { email: ownerEmail, password })).status, 403);

    async function issue(kind: 'VERIFY_EMAIL' | 'RESET_PASSWORD') {
      const token = kind === 'VERIFY_EMAIL' ? '612392' : randomBytes(32).toString('hex');
      const digest = kind === 'VERIFY_EMAIL' ? verificationDigest(ownerEmail, token) : tokenDigest(token);
      await AccountToken.create({ userId: ownerId, kind, digest, expiresAt: new Date(Date.now() + 60000) });
      return token;
    }

    const lockedCode = await issue('VERIFY_EMAIL');
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await request('/auth/verify-email', 'POST', { email: ownerEmail, code: '000000' })).status, 400);
    }
    assert.equal((await request('/auth/verify-email', 'POST', { email: ownerEmail, code: lockedCode })).status, 400);
    await AccountToken.deleteOne({ userId: ownerId, kind: 'VERIFY_EMAIL' });
    const verification = await issue('VERIFY_EMAIL');
    assert.equal((await request('/auth/verify-email', 'POST', { email: ownerEmail, code: verification })).status, 200);
    assert.equal((await request('/auth/verify-email', 'POST', { email: ownerEmail, code: verification })).status, 400);
    const credentialsAcrossSites = { email: ownerEmail, password };
    assert.equal((await request('/auth/login', 'POST', credentialsAcrossSites, undefined, { Origin: 'https://juee-pos-web.onrender.com.example' })).status, 403);
    const secondWeb = await request('/auth/login', 'POST', credentialsAcrossSites, undefined, { Origin: secondaryOrigin });
    assert.equal(secondWeb.status, 201);
    assert.equal(secondWeb.headers.get('access-control-allow-origin'), secondaryOrigin);
    const secondCookie = secondWeb.headers.get('set-cookie')?.split(';', 1)[0];
    assert.match(secondCookie ?? '', /^juee_refresh=/);
    const refreshedWeb = await request('/auth/refresh', 'POST', undefined, undefined, { Origin: secondaryOrigin, Cookie: secondCookie! });
    assert.equal(refreshedWeb.status, 201);
    const { accessToken: secondaryToken } = await refreshedWeb.json();
    assert.equal((await request('/auth/logout', 'POST', undefined, secondaryToken, { Origin: secondaryOrigin })).status, 201);
    let owner = await login(ownerEmail);
    const staff = await login(staffEmail);
    assert.equal((await request('/platform/dashboard', 'GET', undefined, owner)).status, 401);

    const location = { latitude: 21.0278, longitude: 105.8342, radiusMeters: 100 };
    const position = () => ({ latitude: location.latitude, longitude: location.longitude, accuracy: 8, measuredAt: Date.now() });
    const branch = { name: 'Chi nhánh chính', mode: 'RETAIL', location };
    const data = { name: 'Doanh nghiệp kiểm thử', branch };
    const registration = await request('/tenants', 'POST', data, owner);
    assert.equal(registration.status, 201);
    const ownerTenant = (await registration.json()).id;
    tenantIds.push(ownerTenant);
    const extraBusiness = await request('/tenants', 'POST',
      { name: 'Nhà hàng thứ hai', branch: { ...branch, mode: 'RESTAURANT' } }, owner);
    assert.equal(extraBusiness.status, 201);
    const restaurantId = (await extraBusiness.json()).id;
    tenantIds.push(restaurantId);

    const legacyRequest = await request('/tenants', 'POST', { ...data, subscription: 'PAID', planCode: 'PLUS' }, staff);
    assert.equal(legacyRequest.status, 201);
    const staffTenant = (await legacyRequest.json()).id;
    tenantIds.push(staffTenant);
    const root = `/tenants/${ownerTenant}`;
    assert.equal((await request(root, 'GET', undefined, staff)).status, 403);
    const [primary] = await (await request(`${root}/branches`, 'GET', undefined, owner)).json();
    const [foreign] = await (await request(`/tenants/${staffTenant}/branches`, 'GET', undefined, staff)).json();
    assert.equal((await request(`${root}/branches/${foreign.id}`, 'PATCH', { name: 'Sai phạm vi' }, owner)).status, 404);

    const legacyPlan = await Plan.create({ code: `LEGACY_${run.slice(0, 8)}`, name: 'Gói cũ', published: false });
    const legacyVersion = await PlanVersion.create({ planId: legacyPlan._id, version: 1, monthlyVnd: 99000n, yearlyVnd: 1188000n,
      maxBranches: 1, maxStaff: 0, maxQrTables: 0, features: ['pos', 'basic-sales'] });
    const contract = await Subscription.findOne({ tenantId: ownerTenant }).orFail();
    assert.equal(contract.status, 'ACTIVE');
    assert.equal(contract.expiresAt, undefined);
    const previous = await Subscription.findOne({ tenantId: staffTenant }).orFail();
    assert.equal(previous.status, 'ACTIVE');
    assert.equal(previous.requestedPlanVersionId, undefined);
    await Subscription.updateOne({ _id: previous._id }, { $set: { status: 'PENDING', planVersionId: legacyVersion._id,
      requestedPlanVersionId: legacyVersion._id, requestedAt: new Date(), requestId: randomUUID() } });
    const pendingCounter = `/tenants/${staffTenant}/branches/${foreign.id}/products`;
    assert.equal((await request(pendingCounter, 'GET', undefined, staff)).status, 200);
    await Subscription.updateOne({ _id: previous._id }, { $set: { status: 'SUSPENDED' } });
    assert.equal((await request(pendingCounter, 'GET', undefined, staff)).status, 409);
    await Subscription.updateOne({ _id: previous._id }, { $set: { status: 'PENDING' } });

    await Subscription.updateOne({ _id: contract._id }, { $set: { planVersionId: legacyVersion._id, trial: true, expiresAt: new Date(0) } });
    const freeRoot = `${root}/branches/${primary.id}`;
    assert.equal((await request(`${freeRoot}/products`, 'GET', undefined, owner)).status, 200);
    assert.equal((await request(`${freeRoot}/purchases`, 'GET', undefined, owner)).status, 200);
    assert.equal((await request(`${freeRoot}/accounting`, 'GET', undefined, owner)).status, 200);
    assert.equal((await request(`${freeRoot}/tax-declarations`, 'GET', undefined, owner)).status, 200);
    assert.equal((await request(`${root}/subscription/request`, 'POST', { code: 'PLUS' }, owner)).status, 409);
    const branchResult = await request(`${root}/branches`, 'POST', { ...branch, name: 'Chi nhánh 2' }, owner);
    assert.equal(branchResult.status, 201);
    const added = await branchResult.json();
    await Subscription.updateOne({ _id: contract._id }, { $unset: { trial: 1, expiresAt: 1 } });
    const keyPath = `${freeRoot}/warehouse/ai/settings`;
    const sampleKey = 'sk-test-only-for-inventory-encryption';
    const sampleGemini = 'AQ.fake_test_key_for_inventory_encryption_1234567890';
    const unconfigured = { configured: false, provider: 'openai', available: { openai: false, gemini: false } };
    const openaiOnly = { configured: true, provider: 'openai', available: { openai: true, gemini: false } };
    assert.deepEqual(await (await request(keyPath, 'GET', undefined, owner)).json(), unconfigured);
    assert.deepEqual(await (await request(keyPath, 'PATCH', { apiKey: sampleKey }, owner)).json(), openaiOnly);
    const storedKey = await BusinessAiSettings.findById(ownerTenant).select('+encryptedKey').orFail();
    assert.ok(storedKey.encryptedKey && !storedKey.encryptedKey.includes(sampleKey));
    await BusinessAiSettings.updateOne({ _id: storedKey._id }, { $unset: { provider: 1 } });
    assert.deepEqual(await (await request(keyPath, 'GET', undefined, owner)).json(), openaiOnly);
    assert.equal((await request(keyPath, 'PATCH', { provider: 'gemini' }, owner)).status, 400);
    assert.equal((await request(keyPath, 'PATCH', { provider: 'gemini', apiKey: sampleKey }, owner)).status, 400);
    assert.equal((await request(keyPath, 'PATCH', { provider: 'gemini', apiKey: 'AQ.' }, owner)).status, 400);
    const geminiActive = { configured: true, provider: 'gemini', available: { openai: true, gemini: true } };
    assert.deepEqual(await (await request(keyPath, 'PATCH', { provider: 'gemini', apiKey: sampleGemini }, owner)).json(), geminiActive);
    const afterGemini = await BusinessAiSettings.findById(ownerTenant).select('+encryptedKey +encryptedGeminiKey').lean().orFail();
    assert.equal(afterGemini.encryptedKey, storedKey.encryptedKey);
    assert.ok(afterGemini.encryptedGeminiKey && !afterGemini.encryptedGeminiKey.includes(sampleGemini));
    assert.deepEqual(await (await request(keyPath, 'GET', undefined, owner)).json(), geminiActive);
    const outdated = new FormData();
    outdated.set('source', 'text');
    outdated.set('text', 'Hai kg gạo');
    outdated.set('provider', 'openai');
    assert.equal((await request(`${freeRoot}/warehouse/ai/extract`, 'POST', outdated, owner)).status, 409);
    assert.deepEqual(await (await request(keyPath, 'PATCH', { provider: 'openai' }, owner)).json(),
      { ...geminiActive, provider: 'openai' });
    assert.deepEqual(await (await request(`${keyPath}?provider=gemini`, 'DELETE', undefined, owner)).json(), openaiOnly);
    assert.deepEqual(await (await request(keyPath, 'DELETE', undefined, owner)).json(), unconfigured);

    const [restaurant] = await (await request(`/tenants/${restaurantId}/branches`, 'GET', undefined, owner)).json();
    const restaurantBranch = `/tenants/${restaurantId}/branches/${restaurant.id}`;
    const aiScope = { tenantId: new mongoose.Types.ObjectId(restaurantId), branchId: new mongoose.Types.ObjectId(restaurant.id) };
    const rice = await WarehouseItem.insertOne({ ...aiScope, code: 'TEST-RICE', name: 'Gạo thơm', unit: 'kg', onHand: 1000 });
    const otherRice = await WarehouseItem.insertOne({ tenantId: ownerTenant, branchId: primary.id, code: 'TEST-OTHER-RICE',
      name: 'Gạo thơm', unit: 'kg' });
    const warehouseDraft = await suggestWarehouseItems(aiScope, [{ name: 'GẠO  thơm', unit: 'KG' },
      { name: 'Gạo thơm', unit: 'bao' }, { name: 'Nước tương', unit: 'chai' }]);
    assert.equal(warehouseDraft[0].item?.id, rice.id);
    assert.equal(warehouseDraft[1].item, null);
    assert.equal(warehouseDraft[1].needsMatch, true);
    assert.equal(warehouseDraft[2].needsMatch, false);
    const receive = `${restaurantBranch}/warehouse/ai/receive`;
    const amount = { quantity: '2.5', unitCost: 18000, taxBps: 0 };
    const purchase = { supplier: 'Nhà cung cấp thử', method: 'CASH',
      lines: [{ itemId: rice.id, unit: 'kg', ...amount }, { name: 'Nước tương', unit: 'chai', ...amount, quantity: '3' }] };
    const attempt = { ...purchase, lines: [...purchase.lines, { itemId: otherRice.id, unit: 'kg', ...amount }] };
    assert.equal((await request(receive, 'POST', attempt, owner, { 'Idempotency-Key': randomUUID() })).status, 404);
    assert.equal(await WarehouseItem.countDocuments({ ...aiScope, name: 'Nước tương' }), 0);
    assert.equal((await WarehouseItem.findById(rice._id).orFail()).onHand, 1000);
    const purchaseKey = { 'Idempotency-Key': randomUUID() };
    const purchaseResponse = await request(receive, 'POST', purchase, owner, purchaseKey);
    assert.equal(purchaseResponse.status, 201, await purchaseResponse.clone().text());
    assert.equal((await (await request(receive, 'POST', purchase, owner, purchaseKey)).json()).id, (await purchaseResponse.json()).id);
    assert.equal(await PurchaseReceipt.countDocuments(aiScope), 1);
    assert.equal((await WarehouseItem.findById(rice._id).orFail()).onHand, 3500);
    assert.equal((await WarehouseItem.findOne({ ...aiScope, name: 'Nước tương' }).orFail()).onHand, 3000);
    assert.equal((await WarehouseItem.findById(otherRice._id).orFail()).onHand, 0);
    await WarehouseItem.deleteOne({ _id: otherRice._id });

    const dish = await Product.insertOne({ tenantId: aiScope.tenantId, name: 'Phở bò', productType: 'FOOD' });
    const bowl = await ProductVariant.insertOne({ tenantId: aiScope.tenantId, productId: dish._id, sku: 'AI-PHO-BO',
      attributes: { size: 'Tô thường' }, basePrice: 45000, costPrice: 21000 });
    const menuDraft = await suggestMenuItems(aiScope, [{ name: 'PHỞ BÒ', price: 47000 }, { name: 'Bún bò', price: 51000 }]);
    assert.equal(menuDraft[0].variantId, bowl.id);
    assert.equal(menuDraft[0].choices[0].label, 'Tô thường');
    assert.equal(menuDraft[1].variantId, null);
    assert.equal(await BranchProductPrice.countDocuments(aiScope), 0);
    const menuPath = `${restaurantBranch}/warehouse/ai/menu`;
    const aiMenu = { lines: [{ variantId: bowl.id, name: 'Phở bò', price: 47000 }, { name: 'Bún bò', price: 51000 }] };
    const menuKey = { 'Idempotency-Key': randomUUID() };
    const menuResult = await request(menuPath, 'POST', aiMenu, owner, menuKey);
    assert.equal(menuResult.status, 201, await menuResult.clone().text());
    assert.deepEqual(await menuResult.json(), { count: 2 });
    assert.equal((await request(menuPath, 'POST', aiMenu, owner, menuKey)).status, 201);
    assert.equal((await BranchProductPrice.findOne({ ...aiScope, variantId: bowl._id }).orFail()).price, 47000);
    assert.equal((await ProductVariant.findById(bowl._id).orFail()).basePrice, 45000);
    assert.equal(await Product.countDocuments({ tenantId: aiScope.tenantId, name: 'Bún bò', recipeRequired: true }), 1);
    const retailScope = { tenantId: new mongoose.Types.ObjectId(ownerTenant), branchId: new mongoose.Types.ObjectId(added.id) };
    const retailBranch = `${root}/branches/${added.id}`;
    const retailPath = `${retailBranch}/warehouse/ai/retail`;
    const testBarcode = '0059123412345';
    const retailStock = await WarehouseItem.insertOne({ ...retailScope, code: 'AI-TEA-01', barcode: testBarcode,
      name: 'Trà chai thử', unit: 'chai', onHand: 3000 });
    const alternate = await WarehouseItem.insertOne({ ...retailScope, code: 'AI-TEA-02', barcode: testBarcode + '9',
      name: 'Trà chai khác', unit: 'chai' });
    const stockLookup = await request(`${retailBranch}/warehouse/items?code=${testBarcode}`, 'GET', undefined, owner);
    assert.equal(stockLookup.status, 200, await stockLookup.clone().text());
    assert.deepEqual((await stockLookup.json()).items.map((item: { id: string }) => item.id), [retailStock.id]);
    const retailDraft = await suggestRetailItems(retailScope, [
      { name: 'Trà chai thử', code: null, barcode: testBarcode, unit: 'chai', price: 24000 },
      { name: 'Trà chai thử', code: alternate.code, barcode: testBarcode, unit: 'chai', price: 24000 },
    ]);
    assert.equal(retailDraft[0].item?.id, retailStock.id);
    assert.equal(retailDraft[1].item, null);
    assert.equal(retailDraft[1].needsMatch, true);
    const fresh = { mode: 'new', name: 'Bánh AI thử', code: 'AI-CAKE-01', unit: 'hộp', price: 75000 };
    const existing = { mode: 'existing', warehouseItemId: retailStock.id, price: 24000 };
    const rejectedRetail = await request(retailPath, 'POST', { lines: [fresh, { ...existing, warehouseItemId: rice.id }] }, owner,
      { 'Idempotency-Key': randomUUID() });
    assert.equal(rejectedRetail.status, 404, await rejectedRetail.clone().text());
    assert.equal(await WarehouseItem.countDocuments({ ...retailScope, code: fresh.code }), 0);
    const confirmed = { lines: [fresh, existing] };
    const retailKey = { 'Idempotency-Key': randomUUID() };
    const retailResult = await request(retailPath, 'POST', confirmed, owner, retailKey);
    assert.equal(retailResult.status, 201, await retailResult.clone().text());
    assert.deepEqual(await retailResult.json(), { count: 2 });
    assert.equal((await request(retailPath, 'POST', confirmed, owner, retailKey)).status, 201);
    assert.equal((await request(retailPath, 'POST', { lines: [existing] }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const newStock = await WarehouseItem.findOne({ ...retailScope, code: fresh.code }).orFail();
    assert.equal(newStock.onHand, 0);
    assert.equal((await WarehouseItem.findById(retailStock.id).orFail()).onHand, 3000);
    const newListings = await Product.find({ retailBranchId: added.id, warehouseItemId: { $in: [newStock.id, retailStock.id] } });
    assert.equal(newListings.length, 2);
    for (const product of newListings) {
      const variant = await ProductVariant.findOne({ productId: product.id }).orFail();
      assert.equal(variant.basePrice, String(product.warehouseItemId) === retailStock.id ? 24000 : 75000);
    }
    await ProductVariant.deleteMany({ productId: { $in: newListings.map(item => item.id) } });
    await Product.deleteMany({ _id: { $in: newListings.map(item => item.id) } });
    await WarehouseItem.deleteMany({ _id: { $in: [newStock.id, retailStock.id, alternate.id] } });
    assert.equal((await request(`${freeRoot}/warehouse/ai/extract`, 'POST', { source: 'audio' }, owner)).status, 400);

    const taxPath = `${freeRoot}/tax-declarations`;
    const tax = { name: 'Kỳ kiểm thử', taxId: '0123456789', startsOn: '2026-10-01', endsOn: '2026-10-31',
      taxableRevenue: 100000, outputTax: 10000, inputTax: 2000, payableTax: 8000 };
    const taxResponse = await request(taxPath, 'POST', tax, owner);
    assert.equal(taxResponse.status, 201, await taxResponse.clone().text());
    const { id: taxId } = await taxResponse.json();
    assert.equal((await request(`${taxPath}/${taxId}/filing`, 'PATCH', { receipt: 'SIM-001', filedOn: '2026-11-15' }, owner)).status, 200);
    assert.equal((await request(`${taxPath}/${taxId}`, 'PATCH', tax, owner)).status, 404);

    const mode = await request('/auth/work-mode', 'POST', { mode: 'STAFF', tenantId: ownerTenant, branchId: primary.id }, owner);
    assert.equal(mode.status, 200);
    const cashier = (await mode.json()).accessToken;
    const staffCounter = `${root}/branches/${primary.id}`;
    assert.equal((await request(`${staffCounter}/products`, 'GET', undefined, cashier)).status, 200);
    assert.equal((await request(`${staffCounter}/bills`, 'GET', undefined, cashier)).status, 200);
    assert.equal((await request(`${root}/branches/${added.id}/products`, 'GET', undefined, cashier)).status, 403);
    assert.equal((await request(`${staffCounter}/products`, 'GET', undefined, owner)).status, 401);
    assert.equal((await request(`${staffCounter}/orders/${primary.id}/cancel`, 'POST', { reason: 'Đơn nhập nhầm' }, cashier)).status, 403);
    assert.equal((await request(`${staffCounter}/bills/${primary.id}/void`, 'POST', { reason: 'Đơn nhập nhầm' }, cashier)).status, 403);
    assert.equal((await request(`${staffCounter}/payments/${primary.id}/refunds`, 'POST', { amount: 1, reason: 'Hoàn tiền' }, cashier)).status, 403);
    assert.equal((await request('/auth/work-mode', 'POST', { mode: 'MANAGEMENT', password: newPassword }, cashier)).status, 403);
    const unlocked = await request('/auth/work-mode', 'POST', { mode: 'MANAGEMENT', password }, cashier);
    assert.equal(unlocked.status, 200);
    owner = (await unlocked.json()).accessToken;
    assert.equal((await request('/auth/me', 'GET', undefined, cashier)).status, 401);

    const assignedStaff = await request(`${root}/branches/${primary.id}/staff`, 'POST',
      staffForm({ email: staffEmail, role: 'MANAGER', branchIds: [primary.id], citizenId: '001000000101' }), owner);
    assert.equal(assignedStaff.status, 201);
    const linkedStaffId = (await assignedStaff.json()).id;
    assert.ok(staffId);
    const assigned = await request(`${root}/branches`, 'GET', undefined, staff);
    assert.equal(assigned.status, 200);
    assert.deepEqual((await assigned.json()).map((item: { id: string }) => item.id), [primary.id]);
    assert.equal((await request(`${root}/branches/${primary.id}`, 'PATCH', { name: 'Đã cập nhật' }, staff)).status, 200);
    assert.equal((await request(`${root}/branches/${added.id}`, 'PATCH', { name: 'Ngoài phạm vi' }, staff)).status, 403);
    assert.equal((await request(`${root}/branches`, 'POST', branch, staff)).status, 403);

    const branchRoot = `${root}/branches/${primary.id}`;
    const secondRoot = `${root}/branches/${added.id}`;
    const foreignRoot = `/tenants/${staffTenant}/branches/${foreign.id}`;
    const employeeList = await request(`${branchRoot}/staff?q=${encodeURIComponent(staffEmail)}&branch=${primary.id}`, 'GET', undefined, owner);
    assert.equal(employeeList.status, 200);
    assert.equal((await employeeList.json())[0]?.user?.email, staffEmail);
    assert.equal((await request(`${branchRoot}/staff`, 'GET', undefined, staff)).status, 200);
    assert.equal((await request(`${branchRoot}/staff?branch=${added.id}`, 'GET', undefined, staff)).status, 403);
    const managerEmail = `manager-${run}@example.com`;
    const managerGrant = await request(`${branchRoot}/staff`, 'POST', staffForm({
      email: managerEmail, role: 'MANAGER', branchIds: [primary.id, added.id], account: { name: 'Quản lý chi nhánh', password }, citizenId: '001000000102',
    }), owner);
    assert.equal(managerGrant.status, 201);
    const managerMembership = await managerGrant.json();
    userIds.push(managerMembership.userId);
    assert.equal(managerMembership.passwordHash, undefined);
    const delegatedManager = await login(managerEmail);
    const delegatedBranches = (await (await request(`${root}/branches`, 'GET', undefined, delegatedManager)).json()) as { id: string }[];
    assert.deepEqual(new Set(delegatedBranches.map(item => item.id)), new Set([primary.id, added.id]));
    async function assignedBusinessAccess() {
      const memberships = await (await request('/tenants', 'GET', undefined, delegatedManager)).json();
      return memberships.find((item: { tenant: { id: string } }) => item.tenant.id === ownerTenant);
    }
    assert.equal((await assignedBusinessAccess()).canEditSharedCatalog, true);
    const unlistedCategory = new mongoose.Types.ObjectId();
    assert.equal((await request(`${branchRoot}/categories/${unlistedCategory}`, 'PATCH', { name: 'Kiểm tra danh mục' }, delegatedManager)).status, 404);
    assert.equal((await request(`${branchRoot}/staff/${managerMembership.id}`, 'PATCH', { branchIds: [added.id] }, owner)).status, 200);
    const restrictedBranches = (await (await request(`${root}/branches`, 'GET', undefined, delegatedManager)).json()) as { id: string }[];
    assert.deepEqual(restrictedBranches.map(item => item.id), [added.id]);
    assert.equal((await assignedBusinessAccess()).canEditSharedCatalog, false);
    assert.equal((await request(`${secondRoot}/categories/${unlistedCategory}`, 'PATCH', { name: 'Kiểm tra danh mục' }, delegatedManager)).status, 403);
    assert.equal((await request(`${secondRoot}/accounting`, 'GET', undefined, delegatedManager)).status, 200);
    assert.equal((await request(`${branchRoot}/accounting`, 'GET', undefined, delegatedManager)).status, 403);
    assert.equal((await request(`${secondRoot}/warehouse/ai/settings`, 'GET', undefined, delegatedManager)).status, 200);
    assert.equal((await request(`${branchRoot}/warehouse/ai/settings`, 'GET', undefined, delegatedManager)).status, 403);
    assert.equal((await request(`${secondRoot}/warehouse/ai/settings`, 'PATCH', { apiKey: sampleKey }, delegatedManager)).status, 403);
    assert.equal((await request(`${secondRoot}/staff/${managerMembership.id}`, 'PATCH', { branchIds: [added.id, primary.id] }, delegatedManager)).status, 403);
    assert.equal((await request(`${branchRoot}/warehouse/items`, 'GET', undefined, delegatedManager)).status, 403);
    const scope = { tenantId: ownerTenant, branchId: added.id };
    assert.equal((await request('/auth/branch-access', 'POST', { ...scope, branchId: primary.id, password }, delegatedManager)).status, 403);
    assert.equal((await request('/auth/branch-access', 'POST', { ...scope, password: `${password}-wrong` }, delegatedManager)).status, 403);
    const confirmedScope = await request('/auth/branch-access', 'POST', { ...scope, password }, delegatedManager);
    assert.equal(confirmedScope.status, 200);
    assert.deepEqual(await confirmedScope.json(), scope);
    assert.deepEqual((await (await request('/auth/me', 'GET', undefined, delegatedManager)).json()).selectedBranch, scope);

    const startsNow = Date.now() - 60_000;
    const shiftInput = { membershipId: managerMembership.id, title: 'Ca tiếp đón',
      startsAt: new Date(startsNow).toISOString(), endsAt: new Date(startsNow + 3_600_000).toISOString() };
    const workSchedules = `${secondRoot}/staff-schedules`;
    const plannedShift = await request(workSchedules, 'POST', shiftInput, delegatedManager);
    assert.equal(plannedShift.status, 201);
    const planned = await plannedShift.json();
    assert.equal((await request(workSchedules, 'POST', shiftInput, owner)).status, 409);
    assert.equal((await request(workSchedules, 'POST', { ...shiftInput, membershipId: linkedStaffId }, owner)).status, 404);
    assert.equal((await request(`${workSchedules}/${planned.id}`, 'PATCH', { ...shiftInput, title: 'Ca lễ tân' }, owner)).status, 200);
    assert.equal((await (await request(workSchedules, 'GET', undefined, delegatedManager)).json())[0]?.title, 'Ca lễ tân');
    const checkInStaff = () => request(`${secondRoot}/staff-clock/check-in`, 'POST', undefined, delegatedManager, { 'Idempotency-Key': randomUUID() });
    const clockRace = await Promise.all([checkInStaff(), checkInStaff()]);
    assert.deepEqual(clockRace.map(result => result.status).sort(), [201, 409]);
    const checkedInStaff = await clockRace.find(result => result.ok)!.json();
    assert.equal(checkedInStaff.scheduleId, planned.id);
    assert.equal((await request(`${workSchedules}/${planned.id}`, 'DELETE', undefined, owner)).status, 409);
    assert.equal((await request(`${secondRoot}/staff/${managerMembership.id}`, 'DELETE', undefined, owner)).status, 409);
    const checkOutStaffPath = `${secondRoot}/staff-clock/${checkedInStaff.id}/check-out`;
    assert.equal((await request(checkOutStaffPath, 'POST', undefined, owner, { 'Idempotency-Key': randomUUID() })).status, 403);
    const checkedOutStaff = await request(checkOutStaffPath, 'POST', undefined, delegatedManager, { 'Idempotency-Key': randomUUID() });
    assert.equal(checkedOutStaff.status, 201);
    assert.equal((await checkedOutStaff.json()).status, 'CLOSED');
    assert.equal((await (await request(`${secondRoot}/staff-attendance?view=branch`, 'GET', undefined, owner)).json())[0]?.id, checkedInStaff.id);
    const staffProfiles = `${secondRoot}/staff`;
    const profilePayload = { role: 'WAITER', branchIds: [added.id], staffName: 'Nhân viên không dùng tài khoản', citizenId: '001000000103' };
    assert.equal((await request(staffProfiles, 'POST', { ...profilePayload, email: `no-login-${run}@example.com` }, owner)).status, 400);
    assert.equal((await request(staffProfiles, 'POST', profilePayload, delegatedManager)).status, 400);
    assert.equal((await request(staffProfiles, 'POST', staffForm({ ...profilePayload, citizenId: undefined }), delegatedManager)).status, 400);
    assert.equal((await request(staffProfiles, 'POST', staffForm({ ...profilePayload, branchIds: [primary.id] }), delegatedManager)).status, 403);
    const employeeResponse = await request(staffProfiles, 'POST', staffForm(profilePayload, true), delegatedManager);
    assert.equal(employeeResponse.status, 201);
    const employeeProfile = await employeeResponse.json();
    assert.equal(employeeProfile.userId, undefined);
    assert.equal(employeeProfile.citizenId, undefined);
    assert.ok(employeeProfile.staffAvatarVersion);
    const employeeIdentityPath = `${staffProfiles}/${employeeProfile.id}/identity`;
    const identityResponse = await request(employeeIdentityPath, 'GET', undefined, delegatedManager);
    assert.equal(identityResponse.status, 200);
    assert.match(identityResponse.headers.get('cache-control') ?? '', /no-store/);
    const employeeIdentity = await identityResponse.json();
    assert.equal(employeeIdentity.citizenId, profilePayload.citizenId);
    assert.deepEqual(employeeIdentity.documents.map((file: { name: string }) => file.name), ['mat-truoc.png', 'mat-sau.png']);
    assert.equal(employeeIdentity.documents[0].bytes, undefined);
    const employeePhotoPath = `${staffProfiles}/${employeeProfile.id}/avatar`;
    const employeePhotoResponse = await request(employeePhotoPath, 'GET', undefined, delegatedManager);
    assert.equal(employeePhotoResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await employeePhotoResponse.arrayBuffer()), avatarFixture);
    assert.equal((await request(employeePhotoPath, 'GET', undefined, staff)).status, 403);
    const staffDocumentPath = `${staffProfiles}/${employeeProfile.id}/documents/${employeeIdentity.documents[0].id}`;
    const verifiedDocument = await request(staffDocumentPath, 'GET', undefined, owner);
    assert.equal(verifiedDocument.status, 200);
    assert.match(verifiedDocument.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await request(staffDocumentPath, 'GET', undefined, staff)).status, 403);
    assert.equal((await request(`${staffProfiles}/${managerMembership.id}/identity`, 'GET', undefined, delegatedManager)).status, 403);
    assert.equal((await request(`${staffProfiles}/${employeeProfile.id}`, 'PATCH', { removeDocumentIds: [employeeIdentity.documents[0].id] }, delegatedManager)).status, 200);
    assert.equal((await request(staffDocumentPath, 'GET', undefined, owner)).status, 404);
    const identityAfterRemoval = await (await request(employeeIdentityPath, 'GET', undefined, owner)).json();
    assert.equal(identityAfterRemoval.citizenId, profilePayload.citizenId);
    assert.deepEqual(identityAfterRemoval.documents.map((file: { name: string }) => file.name), ['mat-sau.png']);
    const clockedEmployee = await request(`${secondRoot}/staff-clock/check-in`, 'POST',
      { employeeId: employeeProfile.id }, delegatedManager, { 'Idempotency-Key': randomUUID() });
    assert.equal(clockedEmployee.status, 201);
    const recordedAttendance = await clockedEmployee.json();
    assert.equal(recordedAttendance.membershipId, employeeProfile.id);
    assert.equal((await request(`${secondRoot}/staff-clock/${recordedAttendance.id}/check-out`, 'POST',
      { reason: 'Kết thúc ca' }, delegatedManager, { 'Idempotency-Key': randomUUID() })).status, 201);
    const futureStart = new Date(Date.now() + 10 * 86_400_000);
    const shiftTimes = { startsAt: futureStart.toISOString(), endsAt: new Date(+futureStart + 8 * 3_600_000).toISOString() };
    const shiftDay = facilityToday(+futureStart);
    const rangeShiftInput = { ...shiftTimes, membershipId: employeeProfile.id, title: 'Ca liên tục' };
    const repeatingShift = await request(`${secondRoot}/staff-schedules`, 'POST',
      { ...rangeShiftInput, kind: 'FIXED', throughDate: shiftDays(shiftDay, 2) }, delegatedManager);
    assert.equal(repeatingShift.status, 201);
    const series = await repeatingShift.json();
    assert.equal(series.createdCount, 3);
    assert.equal(await StaffSchedule.countDocuments({ seriesId: series.seriesId, canceledAt: null }), 3);
    const fixedEdit = await request(`${secondRoot}/staff-schedules/${series.id}`, 'PATCH', { ...rangeShiftInput, kind: 'FIXED',
      endsAt: new Date(+futureStart + 6 * 3_600_000).toISOString(), applyFollowing: true }, delegatedManager);
    assert.equal(fixedEdit.status, 200);
    assert.equal((await fixedEdit.json()).updatedCount, 3);
    const updatedRange = await StaffSchedule.find({ seriesId: series.seriesId }).sort('startsAt').lean();
    assert.deepEqual(updatedRange.map(item => facilityToday(+item.startsAt)), [shiftDay, shiftDays(shiftDay, 1), shiftDays(shiftDay, 2)]);
    assert.ok(updatedRange.every(item => +item.endsAt - +item.startsAt === 6 * 3_600_000));
    assert.equal((await request(`${secondRoot}/staff-schedules`, 'POST',
      { ...rangeShiftInput, kind: 'FLEXIBLE' }, delegatedManager)).status, 409);
    assert.equal((await request(`${secondRoot}/staff-schedules/${series.id}?series=true`, 'DELETE', undefined, delegatedManager)).status, 200);
    assert.equal((await request(`${secondRoot}/staff-schedules`, 'POST',
      { ...rangeShiftInput, kind: 'FLEXIBLE', throughDate: shiftDays(shiftDay, 1) }, delegatedManager)).status, 400);
    const flexShift = await request(`${secondRoot}/staff-schedules`, 'POST',
      { ...rangeShiftInput, title: 'Ca linh động', kind: 'FLEXIBLE' }, delegatedManager);
    assert.equal(flexShift.status, 201);
    const flexible = await flexShift.json();
    assert.equal(flexible.createdCount, 1);
    assert.equal(flexible.targetMinutes, undefined);
    const shiftDayPath = `${secondRoot}/staff-schedules?day=${shiftDay}&view=branch&singleDay=true`;
    const shiftLeavePath = `${secondRoot}/staff-schedules/${flexible.id}/leave`;
    assert.equal((await request(shiftLeavePath, 'PATCH', { reason: 'Nghỉ phép' }, delegatedManager)).status, 200);
    const daySchedule = await (await request(shiftDayPath, 'GET', undefined, delegatedManager)).json();
    assert.equal(daySchedule.find((item: { id: string }) => item.id === flexible.id)?.state, 'LEAVE');
    const monthSchedule = await (await request(`${secondRoot}/staff-calendar?month=${shiftDay.slice(0, 7)}&view=branch`, 'GET', undefined, delegatedManager)).json();
    assert.equal(monthSchedule[shiftDay]?.leave, 1);
    assert.equal((await request(shiftLeavePath, 'PATCH', { reason: null }, delegatedManager)).status, 200);
    const scheduleAfterLeave = await (await request(shiftDayPath, 'GET', undefined, delegatedManager)).json();
    assert.equal(scheduleAfterLeave.find((item: { id: string }) => item.id === flexible.id)?.state, 'PLANNED');
    const exchangeStart = new Date(+futureStart + 3 * 86_400_000);
    const swapCandidateResponse = await request(`${workSchedules}`, 'POST', { membershipId: managerMembership.id,
      title: 'Ca đổi lịch', startsAt: exchangeStart.toISOString(), endsAt: new Date(+exchangeStart + 3600000).toISOString(),
      throughDate: shiftDays(shiftDay, 4) }, delegatedManager);
    assert.equal(swapCandidateResponse.status, 201);
    const swapCandidate = await swapCandidateResponse.json();
    const shiftExchangePath = `${workSchedules}/${flexible.id}/exchange`;
    const swapPayload = { expectedMembershipId: employeeProfile.id, otherMembershipId: managerMembership.id, otherScheduleId: swapCandidate.id };
    assert.equal((await request(shiftExchangePath, 'PATCH', swapPayload, delegatedManager)).status, 200);
    assert.equal((await request(shiftExchangePath, 'PATCH', swapPayload, delegatedManager)).status, 409);
    const swappedShift = await StaffSchedule.findById(swapCandidate.id).lean();
    assert.equal(String(swappedShift?.membershipId), employeeProfile.id);
    assert.equal(swappedShift?.seriesId, undefined);
    assert.equal(await StaffSchedule.countDocuments({ seriesId: swapCandidate.seriesId, membershipId: managerMembership.id }), 1);
    const substitutePayload = { expectedMembershipId: managerMembership.id, membershipId: employeeProfile.id };
    const blocker = await request(workSchedules, 'POST', { ...rangeShiftInput, title: 'Ca đã có' }, delegatedManager);
    assert.equal(blocker.status, 201);
    assert.equal((await request(shiftExchangePath, 'PATCH', substitutePayload, delegatedManager)).status, 409);
    assert.equal((await request(`${workSchedules}/${(await blocker.json()).id}`, 'DELETE', undefined, delegatedManager)).status, 200);
    assert.equal((await request(shiftExchangePath, 'PATCH', substitutePayload, delegatedManager)).status, 200);
    assert.equal(String((await StaffSchedule.findById(flexible.id).lean())?.membershipId), employeeProfile.id);

    const staffDevicePath = `${secondRoot}/staff-clock-devices`;
    const deviceRegistration = await request(staffDevicePath, 'POST', { name: 'Máy cửa chính', methods: ['CARD', 'FINGERPRINT', 'FACE'] }, delegatedManager);
    assert.equal(deviceRegistration.status, 201);
    const terminal = await deviceRegistration.json();
    const devices = await (await request(staffDevicePath, 'GET', undefined, delegatedManager)).json();
    assert.equal(devices[0]?.keyHash, undefined);
    assert.equal(devices[0]?.key, undefined);
    const credentialPath = `${secondRoot}/staff-clock-credentials/${employeeProfile.id}`;
    for (const method of ['CARD', 'FINGERPRINT', 'FACE']) {
      assert.equal((await request(`${credentialPath}/${method}`, 'PATCH', { code: '00017' }, delegatedManager)).status, 200);
    }
    const eventPath = `${secondRoot}/staff-clock-events`;
    const authorization = { Authorization: `Bearer ${terminal.key}` };
    const fromTerminal = (method: string, direction: string, occurredAt = new Date().toISOString(), key = randomUUID()) =>
      request(eventPath, 'POST', { method, direction, occurredAt, code: '00017' }, undefined, { ...authorization, 'Idempotency-Key': key });
    const inKey = randomUUID();
    const inAt = new Date().toISOString();
    const deviceIn = await fromTerminal('CARD', 'IN', inAt, inKey);
    assert.equal(deviceIn.status, 201);
    const attendedByDevice = await deviceIn.json();
    assert.equal(attendedByDevice.direction, 'IN');
    assert.equal((await (await fromTerminal('CARD', 'IN', inAt, inKey)).json()).id, attendedByDevice.id);
    assert.equal((await (await fromTerminal('FINGERPRINT', 'AUTO')).json()).duplicate, true);
    const deviceOut = await fromTerminal('FACE', 'OUT');
    assert.equal(deviceOut.status, 201);
    assert.equal((await deviceOut.json()).direction, 'OUT');
    const storedDeviceAttendance = await StaffAttendance.findById(attendedByDevice.id).lean();
    assert.equal(storedDeviceAttendance?.checkInMethod, 'CARD');
    assert.equal(storedDeviceAttendance?.checkOutMethod, 'FACE');
    assert.equal((await request(`${staffDevicePath}/${terminal.id}`, 'DELETE', undefined, delegatedManager)).status, 200);
    assert.equal((await fromTerminal('CARD', 'IN')).status, 401);
    const employeePath = `${staffProfiles}/${employeeProfile.id}`;
    assert.equal((await request(employeePath, 'PATCH', { role: 'MANAGER' }, owner)).status, 400);
    const promotedEmail = `promoted-${run}@example.com`;
    const promotedEmployee = await request(employeePath, 'PATCH', {
      role: 'MANAGER', email: promotedEmail, account: { name: profilePayload.staffName, password },
    }, owner);
    assert.equal(promotedEmployee.status, 200);
    userIds.push((await promotedEmployee.json()).userId);
    const promotedToken = await login(promotedEmail);
    assert.equal((await request(staffProfiles, 'GET', undefined, promotedToken)).status, 200);
    assert.equal((await request(employeePath, 'PATCH', { role: 'WAITER' }, owner)).status, 200);
    assert.equal((await request(staffProfiles, 'GET', undefined, promotedToken)).status, 403);
    assert.equal((await request('/auth/login', 'POST', { email: promotedEmail, password })).status, 403);
    assert.equal((await request(employeePath, 'DELETE', undefined, owner)).status, 200);

    const itemsPath = `${branchRoot}/warehouse/items`;
    const movementsPath = `${branchRoot}/warehouse/movements`;
    const itemBody = { name: 'Cà phê nguyên liệu', code: 'coffee-raw', unit: 'kg', minimum: '3.5' };
    const createdItem = await request(itemsPath, 'POST', itemBody, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(createdItem.status, 201);
    const warehouseItem = await createdItem.json();
    assert.equal(warehouseItem.onHand, 0);
    assert.equal(warehouseItem.code, 'COFFEE-RAW');
    assert.equal((await request(`${secondRoot}/warehouse/items/${warehouseItem.id}`, 'GET', undefined, owner)).status, 404);
    assert.equal((await request(`${secondRoot}/warehouse/items`, 'GET', undefined, staff)).status, 403);
    const entry = { itemId: warehouseItem.id, operation: 'RECEIPT', quantity: '5.25', revision: warehouseItem.revision, note: 'Nhập hàng' };
    const entryKey = { 'Idempotency-Key': randomUUID() };
    const received = await request(movementsPath, 'POST', entry, staff, entryKey);
    assert.equal(received.status, 201);
    const receivedData = await received.json();
    assert.equal(receivedData.after, 5250);
    assert.equal((await (await request(movementsPath, 'POST', entry, staff, entryKey)).json()).id, receivedData.id);
    const stockIssue = { ...entry, operation: 'ISSUE', quantity: '2', revision: warehouseItem.revision + 1, note: 'Xuất sử dụng' };
    const moves = await Promise.all([1, 2].map(() => request(movementsPath, 'POST', stockIssue, staff, { 'Idempotency-Key': randomUUID() })));
    assert.deepEqual(moves.map(result => result.status).sort(), [201, 409]);
    const stock = await (await request(`${itemsPath}?stock=LOW`, 'GET', undefined, owner)).json();
    assert.equal(stock.low, 1);
    assert.equal(stock.items[0]?.onHand, 3250);
    assert.equal((await (await request(`${movementsPath}?itemId=${warehouseItem.id}`, 'GET', undefined, owner)).json()).length, 2);
    const category = await request(`${branchRoot}/categories`, 'POST', { name: 'Thực đơn' }, owner);
    assert.equal(category.status, 201);
    const categoryId = (await category.json()).id;
    const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
    const productForm = new FormData();
    productForm.set('product', JSON.stringify({ name: 'Cà phê JUEE', categoryId,
      variants: [{ sku: 'COFFEE', barcode: '0893123456789', basePrice: 25000, costPrice: 12000 }] }));
    productForm.set('image', new Blob([picture], { type: 'image/png' }), 'coffee.png');
    const createProduct = await request(`${branchRoot}/products`, 'POST', productForm, owner);
    assert.equal(createProduct.status, 201);
    const product = await createProduct.json();
    assert.equal(product.imageFile, undefined);
    assert.match(product.images[0], /^\/api\/v1\/product-images\/[a-f0-9]{24}\/[a-f0-9]{32}$/);
    const imagePath = product.images[0].slice('/api/v1'.length);
    const photo = await request(imagePath);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), picture);
    const variantId = product.variants[0].id;
    const barcode = '0893123456789';
    const scan = await request(`${branchRoot}/products?productType=RETAIL&code=${barcode}`, 'GET', undefined, owner);
    assert.equal(scan.status, 200);
    assert.deepEqual((await scan.json()).map((item: { id: string }) => item.id), [product.id]);
    assert.deepEqual(await (await request(`${branchRoot}/products?code=${barcode.slice(1)}`, 'GET', undefined, owner)).json(), []);
    const duplicateBarcode = await request(`${branchRoot}/products/${product.id}/variants`, 'POST', { sku: 'OTHER', barcode, basePrice: 1000 }, owner);
    assert.equal(duplicateBarcode.status, 409);
    assert.match((await duplicateBarcode.json()).message, /Mã vạch đã được dùng/);
    assert.equal((await request(`${secondRoot}/products`, 'GET', undefined, staff)).status, 403);
    assert.equal((await request(`${branchRoot}/categories/${categoryId}`, 'PATCH', { name: 'Đồ uống' }, staff)).status, 403);
    const renamed = await request(`${branchRoot}/categories/${categoryId}`, 'PATCH', { name: 'Đồ uống' }, owner);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, 'Đồ uống');
    assert.equal(await Product.countDocuments({ _id: product.id, categoryId }), 1);
    assert.equal((await request(`${branchRoot}/categories/${categoryId}`, 'DELETE', undefined, owner)).status, 200);
    assert.equal(await Category.exists({ _id: categoryId }), null);
    assert.equal(await Product.countDocuments({ _id: product.id, categoryId: { $exists: false } }), 1);

    const giftVariant = await request(`${branchRoot}/products/${product.id}/variants`, 'POST', { sku: 'GIFT', basePrice: 1000 }, owner);
    assert.equal(giftVariant.status, 201);
    assert.equal((await request(`${branchRoot}/inventory`, 'GET', undefined, owner)).status, 404);
    await ProductVariant.collection.updateOne({ _id: new mongoose.Types.ObjectId(variantId) }, { $set: { tracked: true } });
    const branchPrice = `${branchRoot}/products/${product.id}/variants/${variantId}/branch-price`;
    const availability = `${branchRoot}/products/${product.id}/variants/${variantId}/availability`;
    assert.equal((await request(branchPrice, 'PATCH', { price: 24000 }, owner)).status, 200);
    assert.equal((await request(availability, 'PATCH', { paused: true }, owner)).status, 200);
    const pausedProduct = await (await request(`${branchRoot}/products?code=COFFEE`, 'GET', undefined, owner)).json();
    assert.equal(pausedProduct[0].variants[0].paused, true);
    assert.equal(pausedProduct[0].variants[0].branchPrice, 24000);
    assert.equal((await request(branchPrice, 'PATCH', { price: null }, owner)).status, 200);
    assert.match((await (await request(`${branchRoot}/orders`, 'POST', { items: [{ variantId, quantity: 1 }] }, owner,
      { 'Idempotency-Key': randomUUID() })).json()).message, /tạm ngừng bán/);
    assert.equal((await request(availability, 'PATCH', { paused: false }, owner)).status, 200);
    const checkout = { items: [{ variantId, quantity: 1 }], method: 'CASH' };
    const keys = [randomUUID(), randomUUID()];
    const handoff = await request('/auth/work-mode', 'POST', { mode: 'STAFF', tenantId: ownerTenant, branchId: primary.id }, owner);
    assert.equal(handoff.status, 200);
    const selling = (await handoff.json()).accessToken;
    const productUrl = `${branchRoot}/products/${product.id}`;
    assert.equal((await request(productUrl, 'PATCH', { name: 'Không được đổi' }, selling)).status, 403);
    assert.equal((await request(productUrl, 'DELETE', undefined, selling)).status, 403);
    assert.equal((await request(`${branchRoot}/categories`, 'POST', { name: 'Không được thêm' }, selling)).status, 403);
    const attempts = await Promise.all(keys.map(key => request(`${branchRoot}/checkout`, 'POST', checkout, selling, { 'Idempotency-Key': key })));
    assert.deepEqual(attempts.map(item => item.status), [201, 201]);
    const [sale, secondSale] = await Promise.all(attempts.map(attempt => attempt.json()));
    assert.notEqual(sale.bill.id, secondSale.bill.id);
    assert.equal((await request(`${branchRoot}/payments/${sale.payment.id}/refunds`, 'POST',
      { amount: 1, reason: 'Không được hoàn tiền' }, selling, { 'Idempotency-Key': randomUUID() })).status, 403);
    const saleIndex = 0;
    const catalogAfterSale = await request(`${branchRoot}/products?code=${barcode}`, 'GET', undefined, selling);
    const oldVariant = (await catalogAfterSale.json())[0].variants.find((item: { id: string }) => item.id === variantId);
    assert.equal(oldVariant.available, undefined);
    assert.equal(oldVariant.tracked, undefined);
    const replay = await request(`${branchRoot}/checkout`, 'POST', checkout, selling, { 'Idempotency-Key': keys[saleIndex] });
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).bill.id, sale.bill.id);
    assert.equal(await Payment.countDocuments({ billId: sale.bill.id }), 1);
    assert.equal((await request('/tenants/owner-performance', 'GET', undefined, selling)).status, 403);
    const back = await request('/auth/work-mode', 'POST', { mode: 'MANAGEMENT', password }, selling);
    assert.equal(back.status, 200);
    owner = (await back.json()).accessToken;
    const refund = await request(`${branchRoot}/payments/${sale.payment.id}/refunds`, 'POST',
      { amount: 25000, reason: 'Đã trả hàng' }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(refund.status, 201);
    assert.equal((await Bill.findById(sale.bill.id).lean())?.status, 'REFUNDED');
    const book = await request(`${branchRoot}/cashbook?period=month&method=CASH`, 'GET', undefined, owner);
    assert.equal(book.status, 200);
    const ledger = await book.json();
    assert.equal(ledger.items.find((item: { id: string }) => item.id === sale.payment.id)?.billId, sale.bill.id);
    assert.equal(ledger.items.find((item: { source: string }) => item.source === 'REFUND')?.billId, sale.bill.id);
    const invoiceInBook = await request(`${branchRoot}/bills/${sale.bill.id}?view=cashbook`, 'GET', undefined, owner);
    assert.equal(invoiceInBook.status, 200);
    assert.equal((await invoiceInBook.json()).payments[0].refundedAmount, 25000);
    const bookCsv = await request(`${branchRoot}/cashbook/export?period=month&method=CASH`, 'GET', undefined, owner);
    assert.equal(bookCsv.status, 200);
    assert.match(bookCsv.headers.get('content-type') ?? '', /^text\/csv/);
    const csv = await bookCsv.text();
    assert.ok(csv.includes('"Mã hóa đơn"'));
    assert.ok(csv.includes(sale.bill.id));
    assert.ok(csv.includes('"Đã trả hàng"'));
    assert.equal((await request(`${branchRoot}/cashbook/export`, 'GET', undefined, staff)).status, 200);
    assert.equal((await request(`${secondRoot}/cashbook/export`, 'GET', undefined, staff)).status, 403);
    const companyReport = await request(`${branchRoot}/company/revenue?period=month`, 'GET', undefined, owner);
    assert.equal(companyReport.status, 200);
    const companyRevenue = await companyReport.json();
    assert.equal(companyRevenue.gross, 50000);
    assert.equal(companyRevenue.refunded, 25000);
    assert.equal(companyRevenue.revenue, 25000);
    assert.equal(companyRevenue.branches.length, 2);
    const branchReport = await request(`${branchRoot}/reports?period=month`, 'GET', undefined, owner);
    assert.equal(branchReport.status, 200);
    const { profit, adjustedProfit, inventory, cash, recognizedRevenue, operatingProfit } = await branchReport.json();
    assert.equal(profit.netSales, 25000);
    assert.equal(profit.retailCost, 24000);
    assert.equal(profit.grossProfit, 1000);
    assert.equal(adjustedProfit.amount, 1000);
    assert.equal(adjustedProfit.margin, 0.04);
    assert.equal(operatingProfit, 1000);
    assert.equal(recognizedRevenue, 25000);
    assert.deepEqual([cash.income, cash.expenses, cash.net], [50000, 25000, 25000]);
    assert.equal(inventory.items.find((item: { name: string }) => item.name === warehouseItem.name)?.manualReceipts, 5250);
    const scopedRevenueResponse = await request(`${branchRoot}/company/revenue?period=month`, 'GET', undefined, staff);
    assert.equal(scopedRevenueResponse.status, 200);
    const scopedRevenue = await scopedRevenueResponse.json();
    assert.deepEqual(scopedRevenue.branches.map((branch: { id: string }) => branch.id), [primary.id]);
    assert.equal((await request(`${secondRoot}/company/revenue?period=month`, 'GET', undefined, staff)).status, 403);

    const costInput = { direction: 'OUT', method: 'TRANSFER', note: 'Lương nhân viên', amount: 600, expenseKind: 'STAFF' };
    const shiftCost = await request(`${branchRoot}/cashbook`, 'POST', costInput, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(shiftCost.status, 201);
    const pastCost = await request(`${branchRoot}/cashbook`, 'POST', { ...costInput, note: 'Thuê mặt bằng', expenseKind: 'RENT', amount: 900,
      occurredAt: '2024-06-10T09:30:00+07:00' }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(pastCost.status, 201);
    const expenseAccounting = await (await request(`${branchRoot}/accounting?period=today&on=2024-06-10`, 'GET', undefined, owner)).json();
    assert.equal(expenseAccounting.operatingExpenses.total, 900);
    assert.equal(expenseAccounting.operatingExpenses.items.find((item: { kind: string }) => item.kind === 'RENT')?.count, 1);
    const afterCosts = await (await request(`${branchRoot}/reports?period=month`, 'GET', undefined, owner)).json();
    assert.equal(afterCosts.operatingProfit, 400);
    assert.equal(afterCosts.profitBeforeTax, 400);
    assert.equal(afterCosts.cash.operatingExpenses.total, 600);
    const ownerPerformancePath = '/tenants/owner-performance?period=month';
    const ownerPerformance = await request(ownerPerformancePath, 'GET', undefined, owner);
    assert.equal(ownerPerformance.status, 200);
    const performance = await ownerPerformance.json();
    assert.deepEqual(performance.stores.map((store: { id: string }) => store.id).sort(), [ownerTenant, restaurantId].sort());
    const storePerformance = performance.stores.find((store: { id: string }) => store.id === ownerTenant);
    const primaryPerformance = storePerformance.branches.find((branch: { id: string }) => branch.id === primary.id);
    assert.deepEqual([primaryPerformance.revenue, primaryPerformance.operatingExpenses, primaryPerformance.profitBeforeTax, primaryPerformance.provisional],
      [afterCosts.recognizedRevenue, afterCosts.cash.operatingExpenses.total, afterCosts.profitBeforeTax, afterCosts.adjustedProfit.provisional]);
    assert.equal(performance.revenue, performance.stores.reduce((sum: number, store: { revenue: number }) => sum + store.revenue, 0));
    assert.equal(storePerformance.profitBeforeTax, storePerformance.branches.reduce((sum: number, branch: { profitBeforeTax: number }) =>
      sum + branch.profitBeforeTax, 0));
    const selectedPerformance = await (await request(`${ownerPerformancePath}&tenantId=${ownerTenant}`, 'GET', undefined, owner)).json();
    assert.deepEqual(selectedPerformance.stores, [storePerformance]);
    assert.equal((await request(`${ownerPerformancePath}&tenantId=${ownerTenant}`, 'GET', undefined, staff)).status, 403);
    assert.equal((await request(ownerPerformancePath, 'GET', undefined, delegatedManager)).status, 403);
    const pastCsv = await request(`${branchRoot}/cashbook/export?period=today&on=2024-06-10`, 'GET', undefined, owner);
    assert.match(await pastCsv.text(), /Tiền mặt bằng/);

    const promotionResult = await request(`${branchRoot}/retail-promotions`, 'POST', {
      name: 'Ưu đãi chọn tại quầy', kind: 'PERCENT', value: 10, minimum: 20000, productIds: [product.id], enabled: true,
      startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(),
    }, owner);
    assert.equal(promotionResult.status, 201);
    const promotion = await promotionResult.json();
    const retailPricing = await (await request(`${branchRoot}/retail-pricing`, 'GET', undefined, owner)).json();
    assert.ok(retailPricing.offers.some((offer: { id: string }) => offer.id === promotion.id));
    const pendingOrder = await request(`${branchRoot}/orders`, 'POST', { items: checkout.items, promotionId: promotion.id }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(pendingOrder.status, 201);
    const pendingRetail = await pendingOrder.json();
    assert.equal(pendingRetail.promotionName, promotion.name);
    assert.equal(pendingRetail.totalAmount, 22500);
    const invoice = await request(`${branchRoot}/bills`, 'POST', { orderIds: [pendingRetail.id] }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(invoice.status, 201);
    const pendingBill = await invoice.json();
    const orderPath = `${branchRoot}/orders/${pendingRetail.id}`;
    const retailRevision = (await Order.findById(pendingRetail.id).orFail()).updatedAt.toISOString();
    const editInput = { revision: retailRevision, promotionId: promotion.id, items: [{ lineId: pendingRetail.items[0].id, quantity: 2 }], expectedTotal: 45000 };
    const edited = await request(orderPath, 'PATCH', editInput, owner);
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).totalAmount, 45000);
    assert.equal((await Bill.findById(pendingBill.id).lean())?.totalAmount, 45000);
    assert.equal((await request(orderPath, 'PATCH', { ...editInput, revision: '2026-01-01T00:00:00Z' }, owner)).status, 409);
    const cancelPath = `${orderPath}/cancel`;
    const reason = 'Khách đổi ý';
    assert.equal((await request(cancelPath, 'POST', {}, owner)).status, 400);
    assert.equal((await request(cancelPath, 'POST', { reason: '   ' }, owner)).status, 400);
    await Branch.updateOne({ _id: primary.id }, { $set: { cancellationPinHash: 'legacy-hash' } });
    const listing = await request(`${root}/branches`, 'GET', undefined, owner);
    assert.equal(listing.status, 200);
    assert.equal((await listing.json()).find((item: { id: string }) => item.id === primary.id).cancellationPinHash, undefined);
    const canceled = await request(cancelPath, 'POST', { reason }, staff);
    assert.equal(canceled.status, 201);
    const canceledOrder = await canceled.json();
    assert.equal(canceledOrder.status, 'CANCELED');
    assert.equal(canceledOrder.cancelReason, reason);
    assert.equal((await Bill.findById(pendingBill.id).lean())?.status, 'VOID');
    assert.equal((await request(cancelPath, 'POST', { reason }, owner)).status, 409);
    const cancellations = `${branchRoot}/company/cancellations`;
    const canceledOrders = await request(`${cancellations}?kind=orders`, 'GET', undefined, owner);
    assert.equal(canceledOrders.status, 200);
    assert.equal((await canceledOrders.json()).orders.find((item: { id: string }) => item.id === canceledOrder.id)?.reason, reason);
    const canceledDetail = await request(`${cancellations}/${canceledOrder.id}`, 'GET', undefined, owner);
    assert.equal(canceledDetail.status, 200);
    const canceledInfo = await canceledDetail.json();
    assert.equal(canceledInfo.items[0].canceled, true);
    assert.equal(canceledInfo.items[0].reason, reason);
    assert.ok(canceledInfo.cancellation.at);
    assert.equal((await request(cancellations, 'GET', undefined, staff)).status, 200);
    assert.equal((await request(cancellations, 'GET', undefined, delegatedManager)).status, 403);

    assert.equal((await request(branchRoot, 'PATCH', { mode: 'HYBRID',
      bankAccount: { bank: '970436', account: '010111222333', holder: 'JUEE TEST' },
    }, owner)).status, 200);
    assert.equal((await request(`${branchRoot}/tables`, 'POST', { name: 'Ngoài quyền cấu hình' }, delegatedManager)).status, 403);
    assert.equal((await request(`${branchRoot}/buffet-packages`, 'GET', undefined, staff)).status, 200);
    const table = await request(`${branchRoot}/tables`, 'POST', { name: 'Bàn A' }, staff);
    assert.equal(table.status, 201);
    const { id: tableId, qrToken, qr } = await table.json();
    const spareTable = await request(`${branchRoot}/tables`, 'POST', { name: 'Bàn dự phòng' }, owner);
    assert.equal(spareTable.status, 201);
    const spareId = (await spareTable.json()).id;
    const renamedTable = await request(`${branchRoot}/tables/${spareId}`, 'PATCH', { name: 'Bàn B', areaId: null }, owner);
    assert.equal(renamedTable.status, 200);
    assert.equal((await renamedTable.json()).name, 'Bàn B');
    assert.equal((await request(`${branchRoot}/tables/${spareId}`, 'DELETE', undefined, owner)).status, 200);
    assert.equal(qr.url, `${origin}/order/${ownerTenant}/${qrToken}`);
    assert.match(qr.image, /^data:image\/svg\+xml;base64,/);
    assert.deepEqual(await (await request(`${branchRoot}/tables/${tableId}/qr`, 'GET', undefined, owner)).json(), qr);
    const reserved = await request(`${branchRoot}/tables/${tableId}/reservation`, 'PATCH', { reserved: true,
      reservation: { guestName: 'Khách kiểm thử', phone: '0900000001', guests: 4, arrivesAt: '2026-12-14T10:00:00.000Z' } }, owner);
    assert.equal(reserved.status, 200);
    assert.equal((await reserved.json()).reservation.guests, 4);
    const menu = await request(`/guest/menu/${ownerTenant}/${qrToken}`);
    assert.equal(menu.status, 200);
    const menuProduct = (await menu.json()).products[0];
    assert.equal(menuProduct.variants[0].costPrice, undefined);
    assert.deepEqual(menuProduct.images, product.images);
    assert.equal(menuProduct.imageFile, undefined);
    assert.equal((await request('/guest/orders', 'POST', { items: checkout.items, position: position() })).status, 401);
    const service = await request(`${branchRoot}/table-sessions`, 'POST', { tableId }, owner);
    assert.equal(service.status, 201);
    const { id: serviceId } = await service.json();
    assert.equal((await request(`${branchRoot}/tables/${tableId}`, 'DELETE', undefined, owner)).status, 409);
    const seated = await DiningTable.findById(tableId).orFail();
    assert.equal(seated.reserved, false);
    assert.equal(seated.reservation, undefined);
    assert.equal((await TableSession.findById(serviceId))?.guestCount, 4);
    assert.equal((await request(`${branchRoot}/table-sessions/${serviceId}/guests`, 'PATCH', { guestCount: 5 }, owner)).status, 200);
    const food = await request(`${branchRoot}/products`, 'POST', { name: 'Trà kiểm thử', productType: 'FOOD', variants: [{ basePrice: 30000 }],
      ingredients: [{ itemId: warehouseItem.id, quantity: '0.1' }] }, owner);
    assert.equal(food.status, 201);
    const foodProduct = await food.json();
    const foodVariant = foodProduct.variants[0].id;
    const ingredientStock = (await WarehouseItem.findById(warehouseItem.id).orFail()).onHand;
    const foodOrder = { items: [{ variantId: foodVariant, quantity: 1 }], productType: 'FOOD' };
    assert.equal((await request(`${branchRoot}/orders`, 'POST', foodOrder, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(`${branchRoot}/checkout`, 'POST', { ...foodOrder, tableId, method: 'CASH' }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const counter = await request(`${branchRoot}/orders`, 'POST', { ...foodOrder, tableId, tableSessionId: serviceId }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(counter.status, 201);
    const counterOrder = await counter.json();
    assert.equal(counterOrder.tableSessionId, serviceId);
    assert.equal((await WarehouseItem.findById(warehouseItem.id).orFail()).onHand, ingredientStock - 100);
    const tableRoot = `${branchRoot}/table-sessions/${serviceId}`;
    const previousCart = await (await request(`${tableRoot}/cart`, 'GET', undefined, owner)).json();
    const counterTicket = await KitchenTicket.findOne({ orderId: counterOrder.id }).orFail();
    const counterStage = `${branchRoot}/kitchen/items/${counterTicket.items[0]._id}/transition`;
    assert.equal(previousCart.unservedQuantity, 1);
    const servingSession = await request('/auth/work-mode', 'POST', { mode: 'STAFF', tenantId: ownerTenant, branchId: primary.id }, owner);
    assert.equal(servingSession.status, 200);
    const servingToken = (await servingSession.json()).accessToken;
    const ready = await request(`${branchRoot}/kitchen/tickets?view=service&queue=active`, 'GET', undefined, servingToken);
    assert.equal(ready.status, 200);
    assert.ok((await ready.json()).some((ticket: { orderId: string }) => ticket.orderId === counterOrder.id));
    const preparationPath = `${branchRoot}/kitchen/preparation-summary`;
    const beforeServing = await request(`${preparationPath}?view=service`, 'GET', undefined, servingToken);
    assert.equal(beforeServing.status, 200);
    assert.deepEqual(await beforeServing.json(), { totalQuantity: 1, dishes: [{ name: foodProduct.name, quantity: 1 }] });
    assert.equal((await request(counterStage, 'POST', { status: 'COOKING' }, servingToken)).status, 403);
    assert.equal((await request(counterStage, 'POST', { status: 'SERVED' }, servingToken)).status, 201);
    assert.equal((await request(counterStage, 'POST', { status: 'SERVED' }, servingToken)).status, 409);
    const managerSession = await request('/auth/work-mode', 'POST', { mode: 'MANAGEMENT', password }, servingToken);
    assert.equal(managerSession.status, 200);
    owner = (await managerSession.json()).accessToken;
    const joinPath = `/guest/sessions/${ownerTenant}/${qrToken}`;
    assert.equal((await request(joinPath, 'POST', { position: { ...position(), latitude: 22 } })).status, 403);
    const joined = await request(joinPath, 'POST', { position: position() });
    assert.equal(joined.status, 201);
    const guest = { Authorization: `Guest ${(await joined.json()).token}`, 'Idempotency-Key': randomUUID() };
    const servedOrders = await (await request('/guest/orders', 'GET', undefined, undefined, guest)).json();
    const servedOrder = servedOrders.find((order: { id: string }) => order.id === counterOrder.id);
    const servedItem = servedOrder.kitchen[0];
    assert.equal(servedItem.status, 'SERVED');
    assert.ok(Date.parse(servedItem.servedAt) >= Date.parse(servedOrder.createdAt));
    assert.equal(servedItem.servedBy, undefined);
    assert.equal(servedOrder.items[0].ingredients, undefined);
    assert.equal((await request('/guest/orders', 'POST', { items: checkout.items, position: { ...position(), latitude: 22 } }, undefined, guest)).status, 403);
    const guestSale = await request('/guest/orders', 'POST', { items: checkout.items, position: position() }, undefined, guest);
    assert.equal(guestSale.status, 201);
    const guestOrder = await guestSale.json();
    const guestQrPath = '/guest/table-payment/qr';
    assert.equal((await request(guestQrPath, 'POST', undefined, undefined, guest)).status, 409);
    const replayGuest = await request('/guest/orders', 'POST', { items: checkout.items, position: position() }, undefined, guest);
    assert.equal(replayGuest.status, 201);
    assert.equal((await replayGuest.json()).id, guestOrder.id);
    assert.equal((await request('/guest/table-payment/request', 'POST', undefined, undefined, guest)).status, 201);
    assert.equal((await (await request('/guest/table-payment', 'GET', undefined, undefined, guest)).json()).requested, true);
    const extra = await request('/guest/orders', 'POST', { items: foodOrder.items, position: position() }, undefined, { ...guest, 'Idempotency-Key': randomUUID() });
    assert.equal(extra.status, 201);
    const extraOrder = await extra.json();
    assert.equal((await request(`${tableRoot}/checkout`, 'POST', { revision: previousCart.revision }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(`${branchRoot}/table-sessions/${serviceId}/close`, 'POST', undefined, owner)).status, 409);
    assert.equal((await request(`${branchRoot}/orders/${extraOrder.id}/accept`, 'POST', undefined, owner)).status, 201);
    assert.equal((await request(`${branchRoot}/orders/${guestOrder.id}/accept`, 'POST', undefined, owner)).status, 201);
    await KitchenTicket.updateOne({ orderId: guestOrder.id }, { $unset: { orderedAt: 1 } });
    const tickets = await request(`${branchRoot}/kitchen/tickets?queue=active`, 'GET', undefined, owner);
    assert.equal(tickets.status, 200);
    const kitchen = await tickets.json();
    assert.deepEqual(kitchen.map((ticket: { orderId: string }) => ticket.orderId).filter((orderId: string) =>
      orderId === guestOrder.id || orderId === extraOrder.id), [guestOrder.id, extraOrder.id]);
    const guestOrderCreatedAt = (await Order.findById(guestOrder.id).orFail()).createdAt.toISOString();
    assert.equal(kitchen.find((ticket: { orderId: string }) => ticket.orderId === guestOrder.id).orderedAt, guestOrderCreatedAt);
    for (const orderId of [guestOrder.id, extraOrder.id]) {
      const ticket = kitchen.find((item: { orderId: string }) => item.orderId === orderId);
      if (orderId === extraOrder.id) {
        const partial = await (await request(`${tableRoot}/cart`, 'GET', undefined, owner)).json();
        assert.equal(partial.unservedQuantity, 1);
        const blocked = await request(`${tableRoot}/checkout`, 'POST', { revision: partial.revision }, owner, { 'Idempotency-Key': randomUUID() });
        assert.equal(blocked.status, 409);
        assert.match((await blocked.json()).message, /chưa xác nhận ra món/);
        assert.equal(await Bill.countDocuments({ tableSessionId: serviceId }), 0);
      }
      const result = await request(`${branchRoot}/kitchen/items/${ticket.items[0].id}/transition`, 'POST', { status: 'SERVED' }, owner);
      assert.equal(result.status, 201);
    }
    const statusStream = await request(`${branchRoot}/kitchen/stream`, 'GET', undefined, owner);
    assert.equal(statusStream.status, 200);
    assert.match(statusStream.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = statusStream.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: sync/);
    await reader.cancel();
    assert.equal((await request(`${branchRoot}/bills`, 'POST', { orderIds: [guestOrder.id] }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const { revision, subtotal, orders, unservedQuantity } = await (await request(`${tableRoot}/cart`, 'GET', undefined, owner)).json();
    assert.equal(subtotal, 85000);
    assert.equal(orders.length, 3);
    assert.equal(unservedQuantity, 0);
    assert.equal((await request(`${branchRoot}/table-discounts`, 'POST', { code: 'GIAM10', kind: 'PERCENT', value: 10 }, owner)).status, 201);
    const checkoutKey = { 'Idempotency-Key': randomUUID() };
    const bill = await request(`${tableRoot}/checkout`, 'POST', { revision, discountCode: 'giam10' }, owner, checkoutKey);
    assert.equal(bill.status, 201);
    const { id: billId, discountAmount, totalAmount } = await bill.json();
    assert.equal(discountAmount, 8500);
    assert.equal(totalAmount, 76500);
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId?.toString(), serviceId);
    assert.equal((await TableSession.findById(serviceId).lean())?.status, 'OPEN');
    const waitingCart = await (await request(`${tableRoot}/cart`, 'GET', undefined, owner)).json();
    assert.equal(waitingCart.checkoutBillId, billId);
    assert.equal(waitingCart.due, 76500);
    assert.equal((await request(`${tableRoot}/close`, 'POST', undefined, owner)).status, 409);
    assert.equal((await request(`${branchRoot}/table-sessions`, 'POST', { tableId }, owner)).status, 409);
    const checkoutReplay = await request(`${tableRoot}/checkout`, 'POST', { revision, discountCode: 'giam10' }, owner, checkoutKey);
    assert.equal(checkoutReplay.status, 201);
    assert.equal((await checkoutReplay.json()).id, billId);
    assert.equal((await request(joinPath, 'POST', { position: position() })).status, 401);
    assert.equal((await request('/guest/orders', 'POST', { items: foodOrder.items, position: position() }, undefined, { ...guest, 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await (await request('/guest/orders', 'GET', undefined, undefined, guest)).json()).length, 3);
    const paymentPath = `${branchRoot}/bills/${billId}/payments`;
    const billDetails = await (await request(`${branchRoot}/bills/${billId}`, 'GET', undefined, owner)).json();
    assert.equal(billDetails.tableSessionClosed, false);
    assert.equal((await request(paymentPath, 'POST', { method: 'CASH', amount: 10000, tableSessionId: new mongoose.Types.ObjectId().toString() }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const firstPart = await request(paymentPath, 'POST', { method: 'CASH', amount: 10000, tableSessionId: serviceId }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(firstPart.status, 201);
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId?.toString(), serviceId);
    assert.equal((await TableSession.findById(serviceId).lean())?.status, 'OPEN');
    const intentResponse = await request(guestQrPath, 'POST', undefined, undefined, guest);
    assert.equal(intentResponse.status, 201);
    const intent = await intentResponse.json();
    assert.equal(intent.amount, 66500);
    assert.equal((await (await request(guestQrPath, 'POST', undefined, undefined, guest)).json()).reference, intent.reference);
    const webhook = { id: randomBytes(6).readUIntBE(0, 6) + 1, accountNumber: '010111222333', content: intent.reference,
      transferType: 'in', transferAmount: 66500, referenceCode: run };
    assert.equal((await request('/webhooks/sepay', 'POST', webhook)).status, 401);
    const calls = await Promise.all([1, 2].map(() => request('/webhooks/sepay', 'POST', webhook, undefined, { Authorization: `Apikey ${webhookKey}` })));
    assert.deepEqual(calls.map(item => item.status), [200, 200]);
    assert.equal(await Payment.countDocuments({ billId, provider: 'SEPAY' }), 1);
    assert.equal((await Bill.findById(billId).lean())?.paidAmount, 76500);
    assert.equal((await TableSession.findById(serviceId).lean())?.status, 'CLOSED');
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId, undefined);
    assert.equal((await (await request('/guest/orders', 'GET', undefined, undefined, guest)).json())[0].status, 'COMPLETED');
    const paidCart = await (await request(`${tableRoot}/cart`, 'GET', undefined, owner)).json();
    assert.equal(paidCart.status, 'CLOSED');
    assert.equal(paidCart.checkoutBillId, billId);
    assert.equal(paidCart.due, 0);
    const reopened = await request(`${branchRoot}/table-sessions`, 'POST', { tableId }, owner);
    assert.equal(reopened.status, 201);
    const nextSession = await reopened.json();
    const otherGuest = await request(joinPath, 'POST', { position: position() });
    assert.equal(otherGuest.status, 201);
    const guestInNewSession = { Authorization: `Guest ${(await otherGuest.json()).token}` };
    assert.equal((await (await request('/guest/orders', 'GET', undefined, undefined, guestInNewSession)).json()).length, 0);
    assert.equal((await request('/webhooks/sepay', 'POST', webhook, undefined, { Authorization: `Apikey ${webhookKey}` })).status, 200);
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId?.toString(), nextSession.id);
    assert.equal((await request(`${branchRoot}/table-sessions/${nextSession.id}/close`, 'POST', undefined, owner)).status, 201);
    assert.equal((await request('/guest/orders', 'GET', undefined, undefined, guestInNewSession)).status, 401);

    const rates = { adultPrice: 120000, childPrice: 60000 };
    const packageInput = { ...rates, name: 'Buffet thử', enabled: true, productIds: [foodProduct.id] };
    const createdPackage = await request(`${branchRoot}/buffet-packages`, 'POST', packageInput, owner);
    assert.equal(createdPackage.status, 201);
    const packageId = (await createdPackage.json()).id;
    assert.equal((await request(`${branchRoot}/buffet-packages`, 'POST', packageInput, owner)).status, 409);
    const buffetOpen = await request(`${branchRoot}/table-sessions`, 'POST', { tableId, buffet: { packageId, adults: 2, children: 1 } }, owner);
    assert.equal(buffetOpen.status, 201);
    const buffetSession = await buffetOpen.json();
    const buffetRoot = `${branchRoot}/table-sessions/${buffetSession.id}`;
    assert.equal((await request(`${branchRoot}/buffet-packages/${packageId}`, 'PATCH',
      { ...packageInput, adultPrice: 150000, productIds: [product.id] }, owner)).status, 200);
    const initialBuffet = await (await request(`${buffetRoot}/cart`, 'GET', undefined, owner)).json();
    assert.equal(initialBuffet.subtotal, 300000);
    assert.equal((await request(`${buffetRoot}/guests`, 'PATCH', { buffet: { adults: 1, children: 1 } }, owner)).status, 200);
    assert.equal((await request(`${buffetRoot}/checkout`, 'POST', { revision: initialBuffet.revision }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const buffetJoin = await request(joinPath, 'POST', { position: position() });
    assert.equal(buffetJoin.status, 201);
    const buffetGuest = { Authorization: `Guest ${(await buffetJoin.json()).token}`, 'Idempotency-Key': randomUUID() };
    const buffetMenuPath = `/guest/menu/${ownerTenant}/${qrToken}`;
    const includedMenu = await (await request(buffetMenuPath)).json();
    assert.equal(includedMenu.buffetName, packageInput.name);
    assert.deepEqual(includedMenu.products.map((item: { id: string }) => item.id), [foodProduct.id]);
    assert.equal(includedMenu.products[0].variants[0].basePrice, 0);
    assert.equal(includedMenu.products[0].variants[0].sku, undefined);
    const extraMenu = await (await request(`${buffetMenuPath}?section=extra`)).json();
    assert.deepEqual(extraMenu.products.map((item: { id: string }) => item.id), [product.id]);
    assert.equal(extraMenu.products[0].variants.find((item: { id: string }) => item.id === variantId).basePrice, 25000);
    const staffMenu = await (await request(`${branchRoot}/products?productType=FOOD&tableSessionId=${buffetSession.id}`, 'GET', undefined, owner)).json();
    assert.deepEqual(staffMenu.map((item: { id: string }) => item.id), [foodProduct.id]);
    const availabilityPath = `${branchRoot}/products/${foodProduct.id}/availability`;
    assert.equal((await request(availabilityPath, 'PATCH', { paused: true }, owner)).status, 200);
    assert.equal((await (await request(buffetMenuPath)).json()).products[0].variants[0].paused, true);
    assert.equal((await request('/guest/orders', 'POST', { items: foodOrder.items, position: position() }, undefined, { ...buffetGuest, 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(availabilityPath, 'PATCH', { paused: false }, owner)).status, 200);
    assert.equal((await (await request(buffetMenuPath)).json()).products[0].variants[0].paused, undefined);
    const buffetOrder = await request('/guest/orders', 'POST', { items: [...foodOrder.items, ...checkout.items], position: position() }, undefined, buffetGuest);
    assert.equal(buffetOrder.status, 201);
    const buffetOrderId = (await buffetOrder.json()).id;
    assert.equal(await WarehouseMovement.findOne({ referenceId: buffetOrderId, itemId: warehouseItem.id }), null);
    assert.equal((await request(`${branchRoot}/orders/${buffetOrderId}/accept`, 'POST', undefined, owner)).status, 201);
    const buffetCart = await (await request(`${buffetRoot}/cart`, 'GET', undefined, owner)).json();
    assert.equal(buffetCart.subtotal, 205000);
    assert.deepEqual(buffetCart.orders[0].items.map((item: { unitPrice: number }) => item.unitPrice), [0, 25000]);
    assert.equal((await request(`${buffetRoot}/checkout`, 'POST', { revision: buffetCart.revision }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const buffetTicket = await KitchenTicket.findOne({ orderId: buffetOrderId }).orFail();
    for (const item of buffetTicket.items) {
      assert.equal((await request(`${branchRoot}/kitchen/items/${item._id}/transition`, 'POST', { status: 'SERVED' }, owner)).status, 201);
    }
    const buffetCheckout = await request(`${buffetRoot}/checkout`, 'POST', { revision: buffetCart.revision }, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(buffetCheckout.status, 201);
    const buffetBill = await buffetCheckout.json();
    assert.equal(buffetBill.totalAmount, 205000);
    assert.deepEqual(buffetBill.buffet, { adults: 1, children: 1, ...rates, packageName: packageInput.name });
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId?.toString(), buffetSession.id);
    assert.equal((await TableSession.findById(buffetSession.id).lean())?.status, 'OPEN');
    assert.equal((await request(`${branchRoot}/bills/${buffetBill.id}/payments`, 'POST', { method: 'CASH', amount: 205000,
      tableSessionId: buffetSession.id }, owner, { 'Idempotency-Key': randomUUID() })).status, 201);
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId, undefined);
    assert.equal((await TableSession.findById(buffetSession.id).lean())?.status, 'CLOSED');

    const takeawayInput = { ...foodOrder, items: [...foodOrder.items, ...foodOrder.items], takeaway: true };
    const takeawayKey = { 'Idempotency-Key': randomUUID() };
    const stockBeforeTakeaway = (await WarehouseItem.findById(warehouseItem.id).orFail()).onHand;
    assert.equal((await request(`${branchRoot}/orders`, 'POST', { ...takeawayInput, tableId }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const takeawayResponse = await request(`${branchRoot}/orders`, 'POST', takeawayInput, owner, takeawayKey);
    assert.equal(takeawayResponse.status, 201);
    const takeaway = await takeawayResponse.json();
    assert.equal(takeaway.takeaway, true);
    assert.equal(takeaway.tableSessionId, undefined);
    assert.equal((await (await request(`${branchRoot}/orders`, 'POST', takeawayInput, owner, takeawayKey)).json()).id, takeaway.id);
    assert.equal((await WarehouseItem.findById(warehouseItem.id).orFail()).onHand, stockBeforeTakeaway - 200);
    const takeawayTicket = await KitchenTicket.findOne({ orderId: takeaway.id }).orFail();
    assert.equal(takeawayTicket.takeaway, true);
    assert.equal(takeawayTicket.tableName, undefined);
    const beforeCancellation = await request(preparationPath, 'GET', undefined, owner);
    assert.equal(beforeCancellation.status, 200);
    assert.deepEqual(await beforeCancellation.json(), { totalQuantity: 2, dishes: [{ name: foodProduct.name, quantity: 2 }] });
    const toCancel = takeawayTicket.items[1];
    const canceledDish = await request(`${branchRoot}/orders/${takeaway.id}/cancel`, 'POST', { reason, itemId: toCancel.orderItemId.toString() }, owner);
    assert.equal(canceledDish.status, 201);
    const updatedTakeaway = await canceledDish.json();
    assert.equal(updatedTakeaway.totalAmount, 30000);
    assert.equal(updatedTakeaway.items[1].cancelReason, reason);
    assert.equal((await WarehouseItem.findById(warehouseItem.id).orFail()).onHand, stockBeforeTakeaway - 100);
    const afterCancellation = await request(preparationPath, 'GET', undefined, owner);
    assert.equal(afterCancellation.status, 200);
    assert.deepEqual(await afterCancellation.json(), { totalQuantity: 1, dishes: [{ name: foodProduct.name, quantity: 1 }] });
    assert.equal((await request(`${branchRoot}/kitchen/items/${toCancel._id}/confirm-cancel`, 'POST', undefined, owner)).status, 201);
    const takeawayOrders = await (await request(`${branchRoot}/orders?takeaway=true`, 'GET', undefined, owner)).json();
    assert.equal(takeawayOrders.length, 1);
    assert.equal(takeawayOrders[0].kitchen[0].status, 'NEW');
    assert.equal(takeawayOrders[0].kitchen[1].status, 'CANCELED');
    assert.ok(takeawayOrders[0].kitchen[1].cancelConfirmedAt);
    const canceledItems = await request(`${cancellations}?kind=items`, 'GET', undefined, owner);
    assert.equal(canceledItems.status, 200);
    assert.equal((await canceledItems.json()).orders.find((item: { id: string }) => item.id === takeaway.id)?.quantity, 1);
    const takeawayCancellation = await request(`${cancellations}/${takeaway.id}`, 'GET', undefined, owner);
    assert.equal(takeawayCancellation.status, 200);
    const takeawayCancellationInfo = await takeawayCancellation.json();
    assert.equal(takeawayCancellationInfo.items[0].canceled, false);
    assert.equal(takeawayCancellationInfo.items[1].reason, reason);
    assert.ok(takeawayCancellationInfo.items[1].cancellation.at);
    assert.ok(takeawayCancellationInfo.items[1].kitchen.confirmedAt);
    const takeawayBillInput = { orderIds: [takeaway.id] };
    assert.equal((await request(`${branchRoot}/bills`, 'POST', takeawayBillInput, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(`${branchRoot}/kitchen/items/${takeawayTicket.items[0]._id}/transition`, 'POST', { status: 'SERVED' }, owner)).status, 201);
    const takeawayInvoice = await request(`${branchRoot}/bills`, 'POST', takeawayBillInput, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(takeawayInvoice.status, 201);
    const takeawayBill = await takeawayInvoice.json();
    assert.equal(takeawayBill.totalAmount, 30000);
    assert.equal(takeawayBill.tableSessionId, undefined);
    assert.equal((await request(`${branchRoot}/bills/${takeawayBill.id}/payments`, 'POST', { method: 'CASH', amount: 30000 }, owner,
      { 'Idempotency-Key': randomUUID() })).status, 201);
    assert.equal((await Order.findById(takeaway.id).lean())?.status, 'COMPLETED');
    assert.equal((await DiningTable.findById(tableId).lean())?.sessionId, undefined);

    assert.equal((await request(secondRoot, 'PATCH', { mode: 'GYM' }, owner)).status, 200);
    assert.equal((await request(`${secondRoot}/orders`, 'GET', undefined, owner)).status, 200);
    const facilityCatalog = await request(`${secondRoot}/products?productType=RETAIL`, 'GET', undefined, owner);
    assert.equal(facilityCatalog.status, 200);
    assert.deepEqual(await facilityCatalog.json(), []);
    assert.equal((await request(`${secondRoot}/checkout`, 'POST', checkout, owner, { 'Idempotency-Key': randomUUID() })).status, 404);

    const plansPath = `${secondRoot}/member-plans`;
    assert.equal((await request(plansPath, 'POST', { name: 'Ngoài quyền', kind: 'MONTH', units: 1, price: 200000 }, staff)).status, 403);
    const facilityDefaults = await (await request(`${secondRoot}/member-check-in-settings`, 'GET', undefined, owner)).json();
    assert.equal((await request(`${secondRoot}/member-check-in-settings`, 'PATCH', { methods: facilityDefaults.methods }, delegatedManager)).status, 200);
    const visitPlanResponse = await request(plansPath, 'POST',
      { name: '2 lượt', kind: 'VISITS', units: 2, price: 170000, validityMonths: 2 }, delegatedManager);
    assert.equal(visitPlanResponse.status, 201);
    const visitPlan = (await visitPlanResponse.json()).id;
    const membersPath = `${secondRoot}/members`;
    const memberInput = { name: 'Hội viên thử', phone: '0900000001' };
    assert.equal((await request(membersPath, 'POST', memberInput, owner)).status, 400);
    assert.equal((await request(membersPath, 'POST', { ...memberInput, planId: visitPlan }, owner)).status, 400);
    const memberForm = new FormData();
    memberForm.set('member', JSON.stringify({ ...memberInput, planId: visitPlan, payment: { method: 'CASH', expectedAmount: 170000 } }));
    memberForm.set('image', new Blob([picture], { type: 'image/png' }), 'member.png');
    const reception = await request('/auth/work-mode', 'POST', { mode: 'STAFF', tenantId: ownerTenant, branchId: added.id }, owner);
    assert.equal(reception.status, 200);
    const receptionToken = (await reception.json()).accessToken;
    assert.equal((await request(`${branchRoot}/members`, 'POST', memberForm, receptionToken)).status, 403);
    const registrationKey = { 'Idempotency-Key': randomUUID() };
    const member = await request(membersPath, 'POST', memberForm, receptionToken, registrationKey);
    assert.equal(member.status, 201);
    const { id: memberId, code: memberCode, enrollment: initialEnrollment, photo: photoInfo } = await member.json();
    assert.match(memberCode, /^HV-[A-F0-9]{10}$/);
    assert.equal(initialEnrollment.remaining, 2);
    assert.equal(initialEnrollment.planId, visitPlan);
    assert.ok(initialEnrollment.paymentId);
    const retriedMember = await request(membersPath, 'POST', memberForm, receptionToken, registrationKey);
    assert.equal((await retriedMember.json()).id, memberId);
    assert.equal(await MemberPayment.countDocuments({ memberId, amount: 170000, method: 'CASH' }), 1);
    assert.match(photoInfo.version, /^[a-f0-9]{32}$/);
    assert.equal(photoInfo.bytes, undefined);
    const memberRoot = `${membersPath}/${memberId}`;
    assert.equal((await request(memberRoot, 'PATCH', { name: 'Lễ tân sửa hồ sơ' }, receptionToken)).status, 403);
    assert.equal((await request(`${memberRoot}/history?kind=payments`, 'GET', undefined, receptionToken)).status, 403);
    const returnToManagement = await request('/auth/work-mode', 'POST', { mode: 'MANAGEMENT', password }, receptionToken);
    assert.equal(returnToManagement.status, 200);
    owner = (await returnToManagement.json()).accessToken;
    const memberImage = await request(`${memberRoot}/photo`, 'GET', undefined, owner);
    assert.equal(memberImage.status, 200);
    assert.equal(memberImage.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await memberImage.arrayBuffer()), picture);
    assert.equal((await request(`${memberRoot}/photo`)).status, 401);
    const memberList = await (await request(membersPath, 'GET', undefined, owner)).json();
    assert.deepEqual(memberList.members[0]?.photo, photoInfo);
    const memberDetail = await request(memberRoot, 'GET', undefined, owner);
    assert.equal(memberDetail.status, 200);
    const profile = await memberDetail.json();
    assert.equal(profile.code, memberCode);
    assert.equal(profile.phone, memberInput.phone);
    assert.equal(profile.accessStatus, 'ACTIVE');
    assert.deepEqual(profile.photo, photoInfo);
    assert.equal((await request(memberRoot, 'GET', undefined, staff)).status, 403);

    const visitPath = `${secondRoot}/member-check-ins`;
    const assign = (planId: string, key = randomUUID(), payment?: { method: string; expectedAmount: number }) =>
      request(`${memberRoot}/plan`, 'POST', { planId, payment }, owner, { 'Idempotency-Key': key });
    assert.equal(initialEnrollment.price, 170000);
    assert.ok(initialEnrollment.expiresOn > initialEnrollment.startsOn);
    assert.equal((await request(`${memberRoot}/credentials`, 'PATCH', { method: 'CARD', code: '000125' }, owner)).status, 200);
    assert.equal((await request(`${memberRoot}/credentials`, 'PATCH', { method: 'FACE', code: 'face-05' }, owner)).status, 200);
    const cardCheckIn = await request(visitPath, 'POST', { method: 'CARD', code: '000125' }, delegatedManager);
    assert.equal(cardCheckIn.status, 201);
    const visit = await cardCheckIn.json();
    assert.equal(visit.remaining, 1);
    assert.equal(visit.method, 'CARD');
    assert.equal(visit.memberId, memberId);
    assert.equal(visit.photoVersion, photoInfo.version);
    assert.equal(visit.progress.registeredOn, facilityToday(Date.parse(profile.createdAt)));
    assert.equal(visit.progress.firstVisitedOn, facilityToday(Date.parse(visit.createdAt)));
    assert.equal(visit.progress.attendedDays, 1);
    assert.equal(visit.progress.expiresOn, initialEnrollment.expiresOn);
    assert.ok(visit.progress.remainingDays >= 1);
    assert.equal((await MemberVisit.findById(visit.id).lean())?.createdAt.toISOString(), visit.createdAt);
    const memberHistory = await (await request(`${secondRoot}/member-visits`, 'GET', undefined, owner)).json();
    assert.equal(memberHistory[0]?.createdAt, visit.createdAt);
    assert.equal(memberHistory[0]?.memberId, memberId);
    assert.equal(memberHistory[0]?.photoVersion, photoInfo.version);
    assert.deepEqual(memberHistory[0]?.progress, visit.progress);
    assert.equal((await request(visitPath, 'POST', { method: 'MEMBER_CODE', code: memberCode }, owner)).status, 409);

    const keyResult = await request(`${secondRoot}/member-device-key`, 'POST', undefined, owner);
    assert.equal(keyResult.status, 201);
    const devicePath = `${secondRoot}/member-device-check-ins`;
    const deviceKey = (await keyResult.json()).key;
    const identity = { method: 'FACE', code: 'face-05' };
    const event = { Authorization: `Bearer ${deviceKey}`, 'Idempotency-Key': randomUUID() };
    assert.equal((await request(devicePath, 'POST', identity, undefined, { 'Idempotency-Key': randomUUID() })).status, 401);
    const settingsPath = `${secondRoot}/member-check-in-settings`;
    assert.equal((await request(settingsPath, 'PATCH', { methods: ['CARD'] }, owner)).status, 200);
    assert.equal((await request(devicePath, 'POST', identity, undefined, event)).status, 403);
    assert.equal((await request(visitPath, 'POST', { method: 'MEMBER_CODE', code: memberCode }, owner)).status, 403);
    assert.equal((await request(settingsPath, 'PATCH', { methods: ['CARD', 'FACE', 'MEMBER_CODE'] }, owner)).status, 200);
    const previousVisitDay = facilityToday(Date.now() - 86_400_000);
    await MemberVisit.collection.updateOne({ _id: new mongoose.Types.ObjectId(visit.id) }, { $set: { createdAt: new Date(`${previousVisitDay}T06:00:00+07:00`) } });
    const fromDevice = await request(devicePath, 'POST', identity, undefined, event);
    assert.equal(fromDevice.status, 201);
    const deviceVisit = await fromDevice.json();
    assert.equal(deviceVisit.remaining, 0);
    assert.equal(deviceVisit.memberName, undefined);
    assert.equal(deviceVisit.photoProof, undefined);
    assert.equal(deviceVisit.progress, undefined);
    assert.deepEqual(await (await request(devicePath, 'POST', identity, undefined, event)).json(), deviceVisit);
    assert.equal((await request(visitPath, 'POST', { method: 'MEMBER_CODE', code: memberCode }, owner)).status, 409);
    assert.equal((await request(`${secondRoot}/member-device-key`, 'DELETE', undefined, owner)).status, 200);
    assert.equal((await request(devicePath, 'POST', identity, undefined, event)).status, 401);
    const assignKey = randomUUID();
    const renewalPayment = { method: 'TRANSFER', expectedAmount: 170000 };
    const renewal = await (await assign(visitPlan, assignKey, renewalPayment)).json();
    assert.equal(renewal.remaining, 2);
    assert.ok(renewal.paymentId);
    assert.deepEqual(await (await assign(visitPlan, assignKey, renewalPayment)).json(), renewal);
    const memberReport = await (await request(`${secondRoot}/reports?period=today&view=company`, 'GET', undefined, owner)).json();
    assert.equal(memberReport.memberRevenue, 340000);
    assert.equal(memberReport.recognizedRevenue, 340000);
    assert.equal(memberReport.revenue, 340000);
    assert.equal(memberReport.cash.income, 340000);
    assert.equal(memberReport.salesItems.find((row: { unit: string }) => row.unit === 'gói hội viên')?.quantity, 2);
    const memberCashbook = await (await request(`${secondRoot}/cashbook?period=today&method=CASH`, 'GET', undefined, owner)).json();
    assert.equal(memberCashbook.income, 170000);
    assert.equal(memberCashbook.items.find((item: { source: string }) => item.source === 'MEMBER')?.amount, 170000);
    const memberAccounting = await (await request(`${secondRoot}/accounting?period=today`, 'GET', undefined, owner)).json();
    assert.deepEqual(memberAccounting.memberPayments, { count: 2, total: 340000 });
    assert.equal(memberAccounting.sales.count, 0);

    assert.equal((await request(settingsPath, 'PATCH', { methods: ['CARD', 'FACE'] }, owner)).status, 200);
    const kioskKeyPath = `${secondRoot}/member-kiosk-key`;
    const kioskKeyResponse = await request(kioskKeyPath, 'POST', undefined, owner);
    assert.equal(kioskKeyResponse.status, 201);
    const kioskKey = (await kioskKeyResponse.json()).key;
    const kioskPath = `/member-kiosk/${ownerTenant}/${added.id}`;
    const kioskAuth = { Authorization: `Bearer ${kioskKey}` };
    const kioskEvent = { ...kioskAuth, 'Idempotency-Key': randomUUID() };
    assert.equal((await request(kioskPath, 'GET')).status, 401);
    assert.equal((await request(kioskPath, 'GET', undefined, owner)).status, 401);
    assert.equal((await request(`/member-kiosk/${ownerTenant}/${primary.id}`, 'GET', undefined, undefined, kioskAuth)).status, 401);
    assert.deepEqual((await (await request(kioskPath, 'GET', undefined, undefined, kioskAuth)).json()).methods, ['CARD']);
    assert.equal((await request(`${kioskPath}/check-ins`, 'POST', { method: 'MEMBER_CODE', code: memberCode }, undefined, kioskEvent)).status, 403);
    assert.equal((await request(`${kioskPath}/check-ins`, 'POST', identity, undefined, kioskEvent)).status, 400);
    await MemberVisit.collection.updateOne({ _id: new mongoose.Types.ObjectId(deviceVisit.id) }, { $set: { createdAt: new Date(`${previousVisitDay}T18:00:00+07:00`) } });
    const kioskBody = { method: 'CARD', code: '000125' };
    const kioskResponse = await request(`${kioskPath}/check-ins`, 'POST', kioskBody, undefined, kioskEvent);
    assert.equal(kioskResponse.status, 201);
    const kioskVisit = await kioskResponse.json();
    assert.equal(kioskVisit.remaining, 1);
    assert.equal(kioskVisit.memberName, undefined);
    assert.equal(kioskVisit.progress.firstVisitedOn, previousVisitDay);
    assert.equal(kioskVisit.progress.attendedDays, 2);
    assert.deepEqual(await (await request(`${kioskPath}/check-ins`, 'POST', kioskBody, undefined, kioskEvent)).json(), kioskVisit);
    assert.match(kioskVisit.photoProof, /^[a-f0-9]{64}$/);
    const kioskPhotoPath = `${kioskPath}/check-ins/${kioskVisit.id}/photo`;
    const kioskPhotoHeaders = { ...kioskAuth, 'X-Member-Photo-Proof': kioskVisit.photoProof };
    assert.equal((await request(kioskPhotoPath, 'GET', undefined, undefined, kioskAuth)).status, 403);
    assert.equal((await request(`${kioskPath}/check-ins/${deviceVisit.id}/photo`, 'GET', undefined, undefined, kioskPhotoHeaders)).status, 403);
    const kioskPhoto = await request(kioskPhotoPath, 'GET', undefined, undefined, kioskPhotoHeaders);
    assert.equal(kioskPhoto.status, 200);
    assert.deepEqual(Buffer.from(await kioskPhoto.arrayBuffer()), picture);
    const savedKioskVisit = await MemberVisit.findById(kioskVisit.id).lean();
    assert.equal(savedKioskVisit?.source, 'KIOSK');
    assert.equal(savedKioskVisit?.createdAt.toISOString(), kioskVisit.createdAt);
    await MemberVisit.collection.updateOne({ _id: new mongoose.Types.ObjectId(kioskVisit.id) }, { $set: { createdAt: new Date(Date.now() - 31_000) } });
    assert.equal((await request(kioskPhotoPath, 'GET', undefined, undefined, kioskPhotoHeaders)).status, 404);
    assert.equal((await request(kioskKeyPath, 'DELETE', undefined, owner)).status, 200);
    assert.equal((await request(kioskPath, 'GET', undefined, undefined, kioskAuth)).status, 401);

    const monthly = await request(`${secondRoot}/member-plans`, 'POST', { name: 'Một tháng', kind: 'MONTH', units: 1, price: 210000 }, owner);
    assert.equal(monthly.status, 201);
    assert.ok((await (await assign((await monthly.json()).id)).json()).expiresOn);
    const enrolled = await FacilityMember.findById(memberId).orFail();
    assert.equal(enrolled.enrollment?.kind, 'MONTH');
    assert.equal(enrolled.enrollment?.remaining, undefined);
    await FacilityMember.updateOne({ _id: memberId }, { $unset: { 'enrollment.chargeId': 1 } });
    const oldFee = { chargeId: null, method: 'CASH', expectedAmount: 210000, paidAt: '2024-05-14T10:00:00+07:00' };
    const memberPaymentPath = `${memberRoot}/plan-payment`;
    const feeKey = { 'Idempotency-Key': randomUUID() };
    const savedFee = await request(memberPaymentPath, 'POST', oldFee, owner, feeKey);
    assert.equal(savedFee.status, 201);
    assert.equal((await savedFee.json()).paidAt, '2024-05-14T03:00:00.000Z');
    assert.equal((await request(memberPaymentPath, 'POST', oldFee, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const historicalAccounting = await (await request(`${secondRoot}/accounting?period=today&on=2024-05-14`, 'GET', undefined, owner)).json();
    assert.deepEqual(historicalAccounting.memberPayments, { count: 1, total: 210000 });
    const memberPaymentHistory = await (await request(`${memberRoot}/history?kind=payments`, 'GET', undefined, owner)).json();
    assert.equal(memberPaymentHistory.length, 3);
    const freezeInput = { resumesOn: shiftDays(facilityToday(), 5), reason: 'Nghỉ tập' };
    assert.equal((await request(`${memberRoot}/freeze`, 'POST', freezeInput, owner)).status, 201);
    const frozen = await (await request(`${membersPath}?status=FROZEN`, 'GET', undefined, owner)).json();
    assert.equal(frozen.members[0]?.id, memberId);
    assert.equal(frozen.members[0]?.enrollment.expiresOn, shiftDays(enrolled.enrollment!.expiresOn!, 5));
    assert.equal((await request(`${memberRoot}/resume`, 'POST', undefined, owner)).status, 201);
    assert.equal((await FacilityMember.findById(memberId).lean())?.enrollment?.expiresOn, enrolled.enrollment?.expiresOn);

    assert.equal((await request(memberRoot, 'DELETE', undefined, staff)).status, 403);
    const deleted = await request(memberRoot, 'DELETE', undefined, owner);
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).id, memberId);
    assert.equal(await MemberPayment.countDocuments({ memberId }), 3);
    assert.equal((await request(memberRoot, 'GET', undefined, owner)).status, 404);
    assert.equal((await request(`${memberRoot}/photo`, 'GET', undefined, owner)).status, 404);
    const remainingMembers = await (await request(membersPath, 'GET', undefined, owner)).json();
    assert.equal(remainingMembers.members.length, 0);
    assert.equal((await request(visitPath, 'POST', { method: 'CARD', code: '000125' }, owner)).status, 404);
    const savedHistory = await (await request(`${secondRoot}/member-visits`, 'GET', undefined, owner)).json();
    assert.equal(savedHistory.length, 3);
    assert.equal(savedHistory[0]?.memberName, memberInput.name);
    assert.equal(savedHistory[0]?.photoVersion, undefined);
    assert.deepEqual(savedHistory[0]?.progress, kioskVisit.progress);
    assert.ok(await AuditLog.exists({ action: 'MEMBER_DELETE', targetId: memberId }));
    memberForm.set('member', JSON.stringify({ ...memberInput, planId: visitPlan }));
    const registeredAgain = await request(membersPath, 'POST', memberForm, owner);
    assert.equal(registeredAgain.status, 201);
    const newMember = await registeredAgain.json();
    assert.notEqual(newMember.id, memberId);
    assert.equal((await request(`${membersPath}/${newMember.id}/credentials`, 'PATCH', { method: 'CARD', code: '000125' }, owner)).status, 200);
    memberForm.set('member', JSON.stringify({ ...memberInput, phone: '0900000002', name: 'Hội viên dự bị', planId: visitPlan }));
    const waitingMember = await (await request(membersPath, 'POST', memberForm, owner)).json();
    const classesPath = `${secondRoot}/member-classes`;
    const classInput = { name: 'Yoga buổi sáng', capacity: 1, startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString() };
    const classResponse = await request(classesPath, 'POST', classInput, owner, { 'Idempotency-Key': randomUUID() });
    assert.equal(classResponse.status, 201);
    const sessionClass = await classResponse.json();
    const coachGrant = await request(`${secondRoot}/staff`, 'POST', staffForm({
      role: 'COACH', branchIds: [added.id], staffName: 'Huấn luyện viên A', specialty: 'Yoga', citizenId: '001000000104',
    }), owner);
    assert.equal(coachGrant.status, 201);
    const coach = await coachGrant.json();
    assert.equal(coach.userId, undefined);
    const coaches = await request(`${secondRoot}/member-class-coaches`, 'GET', undefined, delegatedManager);
    assert.equal(coaches.status, 200);
    assert.equal((await coaches.json())[0]?.id, coach.id);
    const coachAssignment = await request(`${classesPath}/${sessionClass.id}/instructor`, 'PATCH', { instructorId: coach.id }, delegatedManager);
    assert.equal(coachAssignment.status, 200);
    assert.equal((await coachAssignment.json()).instructor, 'Huấn luyện viên A');
    assert.equal((await request(classesPath, 'POST', { ...classInput, instructorId: coach.id }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const seatsPath = `${classesPath}/${sessionClass.id}/seats`;
    const receptionForClasses = await request('/auth/work-mode', 'POST', { mode: 'STAFF', tenantId: ownerTenant, branchId: added.id }, owner);
    assert.equal(receptionForClasses.status, 200);
    const classReceptionToken = (await receptionForClasses.json()).accessToken;
    assert.equal((await request(classesPath, 'POST', classInput, classReceptionToken, { 'Idempotency-Key': randomUUID() })).status, 403);
    const bookClass = (id: string) => request(seatsPath, 'POST', { memberId: id }, classReceptionToken);
    assert.equal((await (await bookClass(newMember.id)).json()).status, 'BOOKED');
    assert.equal((await (await bookClass(waitingMember.id)).json()).status, 'WAITING');
    assert.equal((await (await bookClass(waitingMember.id)).json()).status, 'WAITING');
    assert.equal((await request(`${seatsPath}/${newMember.id}`, 'DELETE', undefined, classReceptionToken)).status, 200);
    assert.deepEqual((await MemberClass.findById(sessionClass.id).lean())?.seats.map(seat => seat.status), ['BOOKED']);
    assert.equal((await request(`${seatsPath}/${waitingMember.id}/attendance`, 'PATCH', { attended: true }, classReceptionToken)).status, 404);
    const manageAfterClasses = await request('/auth/work-mode', 'POST', { mode: 'MANAGEMENT', password }, classReceptionToken);
    assert.equal(manageAfterClasses.status, 200);
    owner = (await manageAfterClasses.json()).accessToken;
    assert.equal((await request(`${classesPath}/${sessionClass.id}/cancel`, 'POST', undefined, owner)).status, 201);
    assert.equal((await request(`${secondRoot}/staff/${coach.id}`, 'PATCH', { position: 'HLV chính' }, owner)).status, 200);
    assert.equal((await request(`${secondRoot}/staff/${coach.id}`, 'DELETE', undefined, owner)).status, 200);
    assert.ok((await Membership.findById(coach.id).lean())?.archivedAt);

    assert.equal((await request(secondRoot, 'PATCH', { mode: 'HOTEL' }, owner)).status, 200);
    const roomsUrl = `${secondRoot}/hotel-rooms`;
    const bookingsUrl = `${secondRoot}/hotel-bookings`;
    assert.equal((await request(roomsUrl, 'GET', undefined, staff)).status, 403);
    const roomInput = { code: 'p101', category: 'Phòng đôi', capacity: 2, nightlyRate: 350000 };
    const roomResponse = await request(roomsUrl, 'POST', roomInput, owner);
    assert.equal(roomResponse.status, 201);
    const room = await roomResponse.json();
    assert.equal(room.code, 'P101');
    const now = Date.now();
    const startsOn = facilityToday(now);
    const endsOn = facilityToday(now + 86400000);
    const nextEnd = facilityToday(now + 172800000);
    const stay = { roomId: room.id, startsOn, endsOn, guestName: 'Khách thử', guestCount: 2, expectedNightlyRate: 350000 };
    const reserve = (body: typeof stay, key = randomUUID()) => request(bookingsUrl, 'POST', body, owner, { 'Idempotency-Key': key });
    const stayKey = randomUUID();
    const reservation = await reserve(stay, stayKey);
    assert.equal(reservation.status, 201);
    const booking = await reservation.json();
    assert.equal(booking.amount, 350000);
    assert.equal((await (await reserve(stay, stayKey)).json()).id, booking.id);
    assert.equal((await reserve({ ...stay, guestName: 'Khách khác' })).status, 409);
    const sameInterval = await (await request(`${roomsUrl}?startsOn=${startsOn}&endsOn=${endsOn}`, 'GET', undefined, owner)).json();
    assert.equal(sameInterval[0]?.available, false);
    const adjacent = await reserve({ ...stay, startsOn: endsOn, endsOn: nextEnd });
    assert.equal(adjacent.status, 201);
    const neighboringBooking = (await adjacent.json()).id;
    const calendar = await (await request(`${secondRoot}/hotel-calendar?day=${startsOn}`, 'GET', undefined, owner)).json();
    assert.equal(calendar.bookings.length, 2);
    assert.equal((await request(`${bookingsUrl}/${booking.id}`, 'PATCH', { ...stay, endsOn: nextEnd }, owner)).status, 409);
    assert.equal((await request(`${bookingsUrl}/${booking.id}`, 'PATCH', { ...stay, guestName: 'Đổi tên khách' }, owner)).status, 200);
    assert.equal((await request(`${bookingsUrl}/${booking.id}/arrive`, 'POST', undefined, owner)).status, 201);
    const folioPath = `${bookingsUrl}/${booking.id}/charges`;
    const chargeKey = { 'Idempotency-Key': randomUUID() };
    const addCharge = () => request(folioPath, 'POST', { name: 'Minibar', quantity: 2, unitPrice: 25000 }, owner, chargeKey);
    assert.equal((await (await addCharge()).json()).amount, 400000);
    const folio = await (await addCharge()).json();
    assert.equal(folio.charges.length, 1);
    assert.equal((await request(`${bookingsUrl}/${booking.id}/depart`, 'POST',
      { paymentMethod: 'CASH', expectedAmount: 350000 }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await request(`${folioPath}/${folio.charges[0].id}`, 'DELETE', undefined, owner)).status, 200);
    const departureKey = { 'Idempotency-Key': randomUUID() };
    const depart = () => request(`${bookingsUrl}/${booking.id}/depart`, 'POST', { paymentMethod: 'CASH' }, owner, departureKey);
    const departure = await depart();
    assert.equal(departure.status, 201);
    assert.equal((await departure.json()).status, 'CHECKED_OUT');
    assert.equal((await (await depart()).json()).id, booking.id);
    assert.equal((await HotelRoom.findById(room.id).lean())?.state, 'CLEANING');
    assert.equal((await request(`${roomsUrl}/${room.id}/ready`, 'POST', undefined, owner)).status, 201);
    assert.equal((await request(secondRoot, 'PATCH', { mode: 'TICKETS' }, owner)).status, 409);
    assert.equal((await request(`${bookingsUrl}/${neighboringBooking}/cancel`, 'POST', undefined, owner)).status, 201);
    assert.deepEqual((await (await request(`${secondRoot}/accounting?period=today`, 'GET', undefined, owner)).json()).hotelPayments,
      { count: 1, total: 350000 });

    const packagesUrl = `${secondRoot}/hotel-packages`;
    const hotelBundle = { name: 'Gói lưu trú', price: 125000, durationHours: 2 };
    assert.equal((await request(packagesUrl, 'POST', hotelBundle, staff)).status, 403);
    const packageCreated = await request(packagesUrl, 'POST', hotelBundle, delegatedManager);
    assert.equal(packageCreated.status, 201);
    const hotelPackage = await packageCreated.json();
    const hourlyRoomResponse = await request(roomsUrl, 'POST', { ...roomInput, code: 'P102', hourlyRate: 55000 }, owner);
    assert.equal(hourlyRoomResponse.status, 201);
    const hourlyRoom = await hourlyRoomResponse.json();
    const hourlyStart = new Date();
    const hourlyStay = { roomId: hourlyRoom.id, bookingType: 'HOURLY', startsAt: hourlyStart.toISOString(), durationHours: 2,
      expectedHourlyRate: 55000, guestName: stay.guestName, guestCount: 1 };
    const bookTimed = (body: unknown) => request(bookingsUrl, 'POST', body, owner, { 'Idempotency-Key': randomUUID() });
    const hourlyCreated = await bookTimed(hourlyStay);
    assert.equal(hourlyCreated.status, 201);
    const hourlyBooking = await hourlyCreated.json();
    assert.equal(hourlyBooking.amount, 110000);
    const hourlyDay = facilityToday(+hourlyStart);
    const nightOverlap = await reserve({ ...stay, roomId: hourlyRoom.id, startsOn: hourlyDay, endsOn: shiftDays(hourlyDay, 1) });
    const throughNoon = +hourlyStart + 2 * 3600000 > +hotelNoon(hourlyDay);
    assert.equal(nightOverlap.status, throughNoon ? 409 : 201);
    if (!throughNoon) {
      const { id } = await nightOverlap.json();
      assert.equal((await request(`${bookingsUrl}/${id}/cancel`, 'POST', undefined, owner)).status, 201);
    }
    const bundledStay = { roomId: hourlyRoom.id, bookingType: 'PACKAGE', packageId: hotelPackage.id,
      startsAt: new Date(+hourlyStart + 2 * 3600000).toISOString(), expectedPackageHours: 2, expectedPackagePrice: 125000,
      guestName: 'Khách theo gói', guestCount: 1 };
    assert.equal((await bookTimed({ ...bundledStay, startsAt: new Date(+hourlyStart + 3600000).toISOString() })).status, 409);
    const bundledCreated = await bookTimed(bundledStay);
    assert.equal(bundledCreated.status, 201);
    const bundledBooking = await bundledCreated.json();
    assert.equal(bundledBooking.amount, 125000);
    assert.equal((await request(`${packagesUrl}/${hotelPackage.id}`, 'PATCH', { ...hotelBundle, price: 150000, active: false }, owner)).status, 200);
    assert.deepEqual(await (await request(packagesUrl, 'GET', undefined, delegatedManager)).json(), []);
    const packageAmended = await request(`${bookingsUrl}/${bundledBooking.id}`, 'PATCH', { ...bundledStay, guestName: 'Khách gói đã đổi tên' }, owner);
    assert.equal(packageAmended.status, 200);
    assert.equal((await packageAmended.json()).amount, 125000);
    assert.equal((await request(`${bookingsUrl}/${bundledBooking.id}/arrive`, 'POST', undefined, owner)).status, 409);
    assert.equal((await request(`${bookingsUrl}/${hourlyBooking.id}/arrive`, 'POST', undefined, owner)).status, 201);
    const hourlyCharge = await request(`${bookingsUrl}/${hourlyBooking.id}/charges`, 'POST', { name: 'Minibar', quantity: 1, unitPrice: 20000 }, owner,
      { 'Idempotency-Key': randomUUID() });
    assert.equal((await hourlyCharge.json()).amount, 130000);
    assert.equal((await request(`${bookingsUrl}/${hourlyBooking.id}/depart`, 'POST', { paymentMethod: 'CASH', expectedAmount: 130000 }, owner,
      { 'Idempotency-Key': randomUUID() })).status, 201);
    assert.equal((await request(`${bookingsUrl}/${bundledBooking.id}/cancel`, 'POST', undefined, owner)).status, 201);

    assert.equal((await request(secondRoot, 'PATCH', { mode: 'TICKETS' }, owner)).status, 200);
    const typeResponse = await request(`${secondRoot}/ticket-types`, 'POST', { name: 'Vé người lớn', price: 50000, capacity: 3 }, owner);
    assert.equal(typeResponse.status, 201);
    const typeId = (await typeResponse.json()).id;
    const ticketSalesUrl = `${secondRoot}/ticket-sales`;
    const saleInput = { typeId, quantity: 2, expectedPrice: 50000, paymentMethod: 'TRANSFER' };
    assert.equal((await request(ticketSalesUrl, 'POST', { ...saleInput, expectedPrice: 40000 }, owner, { 'Idempotency-Key': randomUUID() })).status, 409);
    const ticketSaleKey = { 'Idempotency-Key': randomUUID() };
    const issuedResponse = await request(ticketSalesUrl, 'POST', saleInput, owner, ticketSaleKey);
    assert.equal(issuedResponse.status, 201);
    const issuedSale = await issuedResponse.json();
    assert.equal(issuedSale.amount, 100000);
    assert.equal((await (await request(ticketSalesUrl, 'POST', saleInput, owner, ticketSaleKey)).json()).id, issuedSale.id);
    const soldTickets = (await (await request(`${ticketSalesUrl}/${issuedSale.id}`, 'GET', undefined, owner)).json()).tickets;
    assert.equal(soldTickets.length, 2);
    assert.notEqual(soldTickets[0].code, soldTickets[1].code);
    assert.match(soldTickets[0].qr, /^data:image\/svg\+xml;base64,/);
    const admissionUrl = `${secondRoot}/ticket-admissions`;
    const admit = () => request(admissionUrl, 'POST', { code: soldTickets[0].code }, owner, { 'Idempotency-Key': randomUUID() });
    assert.deepEqual((await Promise.all([admit(), admit()])).map(response => response.status).sort(), [201, 409]);
    assert.equal((await (await request(admissionUrl, 'GET', undefined, owner)).json()).length, 1);
    assert.equal((await request(`${ticketSalesUrl}/${issuedSale.id}/refund`, 'POST', { reason: 'Đổi lịch', method: 'CASH' }, owner,
      { 'Idempotency-Key': randomUUID() })).status, 409);
    const opens = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal((await request(`${secondRoot}/ticket-types/${typeId}`, 'PATCH', {
      name: 'Vé người lớn', price: 50000, admissionStartsAt: opens,
    }, owner)).status, 200);
    const buyLast = () => request(ticketSalesUrl, 'POST', { ...saleInput, quantity: 1, buyerName: 'Người mua cuối', buyerPhone: '0900000003' }, owner,
      { 'Idempotency-Key': randomUUID() });
    const lastSales = await Promise.all([buyLast(), buyLast()]);
    assert.deepEqual(lastSales.map(result => result.status).sort(), [201, 409]);
    const lastSale = await lastSales.find(result => result.ok)!.json();
    const lastTicket = (await (await request(`${ticketSalesUrl}/${lastSale.id}`, 'GET', undefined, owner)).json()).tickets[0];
    const admitLast = () => request(admissionUrl, 'POST', { code: lastTicket.code }, owner, { 'Idempotency-Key': randomUUID() });
    assert.match(JSON.stringify(await (await admitLast()).json()), /chưa đến giờ/);
    const refundTicket = () => request(`${ticketSalesUrl}/${lastSale.id}/refund`, 'POST', { reason: 'Đổi lịch', method: 'CASH' }, owner,
      { 'Idempotency-Key': randomUUID() });
    assert.equal((await refundTicket()).status, 201);
    assert.equal((await refundTicket()).status, 409);
    assert.match(JSON.stringify(await (await admitLast()).json()), /đã được hoàn/);
    const currentType = (await (await request(`${secondRoot}/ticket-types`, 'GET', undefined, owner)).json())[0];
    assert.equal(currentType.remaining, 1);
    assert.equal((await (await request(`${ticketSalesUrl}?q=${lastTicket.code}`, 'GET', undefined, owner)).json())[0]?.id, lastSale.id);
    const ticketAccounting = await (await request(`${secondRoot}/accounting?period=today`, 'GET', undefined, owner)).json();
    assert.deepEqual(ticketAccounting.ticketRefunds, { count: 1, total: 50000 });
    const serviceRevenue = await (await request(`${secondRoot}/company/revenue?period=today`, 'GET', undefined, owner)).json();
    assert.equal(serviceRevenue.branches.find((row: { id: string }) => row.id === added.id)?.gross, 970000);
    assert.equal(serviceRevenue.branches.find((row: { id: string }) => row.id === added.id)?.revenue, 920000);

    const groupTypeResponse = await request(`${secondRoot}/ticket-types`, 'POST', { name: 'Vé nhóm thử nghiệm', price: 40000, capacity: 6 }, owner);
    assert.equal(groupTypeResponse.status, 201);
    const groupTypeId = (await groupTypeResponse.json()).id;
    const groupInput = { typeId: groupTypeId, quantity: 3, expectedPrice: 40000, paymentMethod: 'CASH', ticketMode: 'GROUP' };
    const groupSaleKey = { 'Idempotency-Key': randomUUID() };
    const groupSaleResponse = await request(ticketSalesUrl, 'POST', groupInput, owner, groupSaleKey);
    assert.equal(groupSaleResponse.status, 201);
    const groupSale = await groupSaleResponse.json();
    assert.equal(groupSale.quantity, 3);
    assert.equal(groupSale.amount, 120000);
    assert.equal(groupSale.ticketMode, 'GROUP');
    assert.equal((await (await request(ticketSalesUrl, 'POST', groupInput, owner, groupSaleKey)).json()).id, groupSale.id);
    const grouped = (await (await request(`${ticketSalesUrl}/${groupSale.id}`, 'GET', undefined, owner)).json()).tickets;
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].entryQuantity, 3);
    const scanGroup = () => request(admissionUrl, 'POST', { code: grouped[0].code }, owner, { 'Idempotency-Key': randomUUID() });
    const groupScans = await Promise.all([scanGroup(), scanGroup()]);
    assert.deepEqual(groupScans.map(result => result.status).sort(), [201, 409]);
    assert.equal((await groupScans.find(result => result.ok)!.json()).entryQuantity, 3);
    const groupAdmissions = await (await request(admissionUrl, 'GET', undefined, owner)).json();
    assert.equal(groupAdmissions.find((ticket: { code: string }) => ticket.code === grouped[0].code)?.entryQuantity, 3);
    assert.equal((await request(`${ticketSalesUrl}/${groupSale.id}/refund`, 'POST', { reason: 'Đổi lịch', method: 'CASH' }, owner,
      { 'Idempotency-Key': randomUUID() })).status, 409);

    const splitResponse = await request(ticketSalesUrl, 'POST', { ...groupInput, quantity: 2, ticketMode: 'SEPARATE' }, owner,
      { 'Idempotency-Key': randomUUID() });
    assert.equal(splitResponse.status, 201);
    const splitSale = await splitResponse.json();
    assert.equal(splitSale.amount, 80000);
    const splitTickets = (await (await request(`${ticketSalesUrl}/${splitSale.id}`, 'GET', undefined, owner)).json()).tickets;
    assert.deepEqual(splitTickets.map((ticket: { entryQuantity: number }) => ticket.entryQuantity), [1, 1]);
    assert.notEqual(splitTickets[0].code, splitTickets[1].code);
    assert.equal((await request(ticketSalesUrl, 'POST', { ...groupInput, quantity: 2 }, owner,
      { 'Idempotency-Key': randomUUID() })).status, 409);

    const adminRegistration = await request('/auth/register', 'POST', { email: adminEmail, password, name: 'Kiểm thử quản trị', phone: '0901234505' });
    assert.equal(adminRegistration.status, 201);
    const adminId = (await adminRegistration.json()).id;
    userIds.push(adminId);
    const oldAdminSession = await login(adminEmail);
    function bootstrapAdmin(currentPassword: string) {
      return spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/seed.ts'], {
        env: { ...env, BOOTSTRAP_ADMIN_EMAIL: adminEmail, BOOTSTRAP_ADMIN_PASSWORD: newPassword,
          BOOTSTRAP_ADMIN_CURRENT_PASSWORD: currentPassword, BOOTSTRAP_ADMIN_TOTP: adminSecret },
        encoding: 'utf8', timeout: 15000,
      });
    }
    const duplicateEmail = bootstrapAdmin('');
    assert.equal(duplicateEmail.status, 1);
    assert.match(duplicateEmail.stderr, /--existing/);
    const wrongPassword = bootstrapAdmin(newPassword);
    assert.equal(wrongPassword.status, 1);
    assert.match(wrongPassword.stderr, /Mật khẩu hiện tại không đúng/);
    assert.equal(await PlatformGrant.exists({ userId: adminId }), null);
    const promoted = bootstrapAdmin(password);
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(await User.countDocuments({ email: adminEmail }), 1);
    assert.equal((await request('/auth/me', 'GET', undefined, oldAdminSession)).status, 401);
    assert.equal((await request('/auth/login', 'POST', { email: adminEmail, password })).status, 401);
    const credentials = { email: adminEmail, password: newPassword };
    assert.equal((await request('/auth/login', 'POST', credentials)).status, 403);
    const adminCredentials = { ...credentials, otp: authenticator.generate(adminSecret) };
    assert.equal((await request('/admin-auth/login', 'POST', adminCredentials)).status, 403);
    const adminHeaders = { Origin: adminOrigin };
    assert.equal((await request('/admin-auth/login', 'POST', { email: ownerEmail, password, otp: adminCredentials.otp }, undefined, adminHeaders)).status, 401);
    const adminLogin = await request('/admin-auth/login', 'POST', { ...adminCredentials, otp: authenticator.generate(adminSecret) }, undefined, adminHeaders);
    assert.equal(adminLogin.status, 201);
    const issuedCookie = adminLogin.headers.get('set-cookie') ?? '';
    assert.match(issuedCookie, /^juee_admin_refresh=[a-f0-9]{64};/);
    assert.match(issuedCookie, /Path=\/api\/v1\/admin-auth/);
    const admin = (await adminLogin.json()).accessToken;
    assert.equal((await request('/admin-auth/me', 'GET', undefined, owner)).status, 401);
    assert.equal((await request('/auth/me', 'GET', undefined, admin)).status, 401);
    assert.equal((await request('/admin-auth/me', 'GET', undefined, admin, adminHeaders)).status, 200);
    const adminCookie = issuedCookie.split(';', 1)[0];
    assert.equal((await request('/auth/refresh', 'POST', undefined, undefined, { Cookie: adminCookie })).status, 401);
    const pending = await Subscription.findOne({ tenantId: staffTenant }).orFail();
    const requests = await request('/platform/subscriptions?status=REQUESTED', 'GET', undefined, admin);
    assert.equal(requests.status, 200);
    assert.ok((await requests.json()).items.some((item: { id: string }) => item.id === pending.id));
    assert.equal((await request(`/platform/subscriptions/${pending.id}/reject-request`, 'POST', {
      planVersionId: pending.requestedPlanVersionId, requestId: randomUUID(), reason: 'Không còn yêu cầu này',
    }, admin)).status, 409);
    const rejection = await request(`/platform/subscriptions/${pending.id}/reject-request`, 'POST', {
      planVersionId: pending.requestedPlanVersionId, requestId: pending.requestId, reason: 'Chưa thấy khoản thanh toán',
    }, admin);
    assert.equal(rejection.status, 201);
    const rejected = await Subscription.findById(pending.id).orFail();
    assert.equal(rejected.requestedPlanVersionId, undefined);
    assert.equal(rejected.rejectedRequest?.reason, 'Chưa thấy khoản thanh toán');
    const retried = await Subscription.findByIdAndUpdate(pending.id, { $set: { requestedPlanVersionId: legacyVersion._id,
      requestedAt: new Date(), requestId: randomUUID() }, $unset: { rejectedRequest: 1 } }, { new: true }).orFail();
    const activation = { planVersionId: retried.requestedPlanVersionId, requestId: retried.requestId, reference: `SUB-${run}`, reason: 'Đã đối chiếu giao dịch' };
    assert.equal((await request(`/platform/subscriptions/${pending.id}/activate-request`, 'POST', { ...activation, requestId: pending.requestId }, admin)).status, 409);
    assert.equal((await request(`/platform/subscriptions/${pending.id}/activate-request`, 'POST', activation, admin)).status, 201);
    assert.equal((await request(`/platform/subscriptions/${pending.id}/activate-request`, 'POST', activation, admin)).status, 409);
    assert.equal((await request(`${foreignRoot}/products`, 'GET', undefined, staff)).status, 200);
    assert.equal((await request(`${foreignRoot}/products/${product.id}`, 'GET', undefined, staff)).status, 404);
    const extended = await request(`/platform/subscriptions/${contract.id}/extend`, 'POST', { days: 30, reason: 'Kiểm thử gia hạn' }, admin);
    assert.equal(extended.status, 201);
    const lock = await request(`/platform/users/${staffId}/status`, 'PATCH', { locked: true, reason: 'Kiểm thử khóa' }, admin);
    assert.equal(lock.status, 200);
    assert.equal((await request('/auth/me', 'GET', undefined, staff)).status, 401);

    const reset = await issue('RESET_PASSWORD');
    assert.equal((await request('/auth/reset-password', 'POST', { token: reset, password: newPassword })).status, 200);
    assert.equal((await request('/auth/reset-password', 'POST', { token: reset, password })).status, 400);
    assert.equal((await request('/auth/me', 'GET', undefined, owner)).status, 401);
    await User.updateOne({ _id: staffId }, { $set: { locked: false } });
    const unlockedStaff = await login(staffEmail);
    const current = await login(ownerEmail, newPassword);
    const sessions = await request('/auth/sessions', 'GET', undefined, current);
    assert.equal(sessions.status, 200);
    const [session] = await sessions.json();
    assert.equal(session.current, true);
    assert.equal((await request(`/auth/sessions/${session.id}`, 'DELETE', undefined, unlockedStaff)).status, 200);
    assert.equal((await request('/auth/me', 'GET', undefined, current)).status, 200);

    const replacement = new FormData();
    replacement.set('product', '{}');
    replacement.set('image', new Blob([picture], { type: 'image/png' }), 'replacement.png');
    const replaced = await request(`${branchRoot}/products/${product.id}`, 'PATCH', replacement, current);
    assert.equal(replaced.status, 200);
    const replacementPath = (await replaced.json()).images[0].slice('/api/v1'.length);
    assert.notEqual(replacementPath, imagePath);
    assert.equal((await request(imagePath)).status, 404);
    assert.equal((await request(replacementPath)).status, 200);
    const removed = await request(`${branchRoot}/products/${product.id}`, 'PATCH', { removeImage: true }, current);
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).images, []);
    assert.equal((await request(replacementPath)).status, 404);

    assert.equal((await request(productUrl, 'DELETE', undefined, current)).status, 200);
    assert.equal((await request(productUrl, 'DELETE', undefined, current)).status, 200);
    const archived = await (await request(`${branchRoot}/products?archived=yes&status=ARCHIVED&code=${barcode}`, 'GET', undefined, current)).json();
    assert.equal(archived[0]?.id, product.id);
    assert.equal(archived[0]?.status, 'ARCHIVED');
    assert.deepEqual(await (await request(`${branchRoot}/products?code=${barcode}`, 'GET', undefined, current)).json(), []);
    const historicalBill = await (await request(`${branchRoot}/bills/${secondSale.bill.id}`, 'GET', undefined, current)).json();
    assert.equal(historicalBill.orders[0]?.items[0]?.name, product.name);
    assert.equal(await AuditLog.countDocuments({ targetId: product.id, action: 'PRODUCT_ARCHIVE' }), 1);
    assert.equal((await request(productUrl, 'PATCH', { status: 'ACTIVE' }, current)).status, 200);
    assert.equal((await (await request(`${branchRoot}/products?code=${barcode}`, 'GET', undefined, current)).json())[0]?.id, product.id);

    const historicalDay = '2024-06-05';
    const payrollPath = `${secondRoot}/payroll/${employeeProfile.id}`;
    const payrollPeriod = { from: historicalDay, to: historicalDay };
    const payrollQuery = `${payrollPath}?${new URLSearchParams(payrollPeriod)}`;
    const payRate = { effectiveOn: historicalDay, unit: 'SHIFT', rate: 250000, overtimeRate: 45000, shiftMinutes: 450 };
    const scopeForPayroll = { tenantId: ownerTenant, branchId: added.id, membershipId: employeeProfile.id };
    const historicalAttendance = await StaffAttendance.create({ ...scopeForPayroll, staffName: profilePayload.staffName,
      scheduleId: new mongoose.Types.ObjectId(), scheduleTitle: 'Ca chiều', status: 'CLOSED',
      scheduledStartsAt: new Date('2024-06-05T14:00:00+07:00'), scheduledEndsAt: new Date('2024-06-05T22:00:00+07:00'),
      checkedInAt: new Date('2024-06-05T13:45:00+07:00'), checkedOutAt: new Date('2024-06-05T22:30:00+07:00') });
    assert.equal((await request(`${payrollPath}/rate`, 'PATCH', payRate, current)).status, 200);
    const payroll = await (await request(payrollQuery, 'GET', undefined, current)).json();
    assert.equal(payroll.amount, 295000);
    assert.equal(payroll.overtimeMinutes, 60);
    assert.equal(payroll.lines[0].shiftMinutes, 450);
    const payInput = { ...payrollPeriod, expectedAmount: payroll.amount, expectedRevision: payroll.revision, method: 'TRANSFER' };
    const payoutKey = { 'Idempotency-Key': randomUUID() };
    assert.equal((await request(`${payrollPath}/payments`, 'POST', { ...payInput, expectedAmount: 1 }, current, payoutKey)).status, 409);
    const paidPayroll = await request(`${payrollPath}/payments`, 'POST', payInput, current, payoutKey);
    assert.equal(paidPayroll.status, 201);
    const paidPayrollBody = await paidPayroll.json();
    assert.equal((await (await request(`${payrollPath}/payments`, 'POST', payInput, current, payoutKey)).json()).id, paidPayrollBody.id);
    assert.equal((await request(`${payrollPath}/payments`, 'POST', payInput, current, { 'Idempotency-Key': randomUUID() })).status, 409);
    assert.equal((await (await request(payrollQuery, 'GET', undefined, current)).json()).skipped.alreadyPaid, 1);
    const savedAttendance = await StaffAttendance.findById(historicalAttendance._id).lean();
    assert.equal(String(savedAttendance?.payrollPaymentId), paidPayrollBody.id);
    const payrollReceipt = await StaffPayPayment.findById(paidPayrollBody.id).lean();
    assert.ok(payrollReceipt);
    assert.equal(payrollReceipt.lines[0].shiftMinutes, 450);
    assert.equal(await CashEntry.countDocuments({ tenantId: ownerTenant, branchId: added.id, _id: payrollReceipt.cashEntryId,
      expenseKind: 'STAFF', amount: 295000 }), 1);
    const payrollDay = facilityToday(Date.parse(paidPayrollBody.paidAt));
    const payoutQuery = `period=today&on=${payrollDay}`;
    const payrollLedger = await (await request(`${secondRoot}/cashbook?${payoutQuery}`, 'GET', undefined, current)).json();
    const payrollEntries = payrollLedger.items.filter((entry: { payrollPaymentId?: string }) => entry.payrollPaymentId === paidPayrollBody.id);
    assert.equal(payrollEntries.length, 1);
    assert.equal(payrollEntries[0].id, String(payrollReceipt.cashEntryId));
    assert.equal(payrollEntries[0].source, 'PAYROLL');
    assert.equal(payrollEntries[0].payrollMembershipId, employeeProfile.id);
    const payoutAccounts = await (await request(`${secondRoot}/accounting?${payoutQuery}`, 'GET', undefined, current)).json();
    assert.deepEqual(payoutAccounts.payrollPayments, { count: 1, total: 295000 });
    assert.ok(payoutAccounts.operatingExpenses.items.find((item: { kind: string }) => item.kind === 'STAFF')?.total >= 295000);
    const payoutExport = await request(`${secondRoot}/cashbook/export?${payoutQuery}`, 'GET', undefined, current);
    assert.match(await payoutExport.text(), /Chi trả lương/);

    const passwordResetPath = `${secondRoot}/staff/${managerMembership.id}/reset-password`;
    const managerAccounts = await (await request(`${secondRoot}/staff?accountActions=true`, 'GET', undefined, current)).json();
    assert.equal(managerAccounts.find((item: { id: string }) => item.id === managerMembership.id)?.canResetPassword, true);
    assert.equal((await request(`${secondRoot}/staff`, 'POST', { email: `unauthorized-${run}@example.com`, role: 'MANAGER',
      branchIds: [added.id], account: { name: 'Quản lý khác', password } }, delegatedManager)).status, 403);
    assert.equal((await request(passwordResetPath, 'POST', { password: newPassword }, delegatedManager)).status, 403);
    assert.equal((await request(`${branchRoot}/staff/${linkedStaffId}/reset-password`, 'POST', { password: newPassword }, current)).status, 403);
    assert.equal((await request(passwordResetPath, 'POST', { password: newPassword }, current)).status, 201);
    assert.equal((await request('/auth/me', 'GET', undefined, delegatedManager)).status, 401);
    assert.equal((await request('/auth/login', 'POST', { email: managerEmail, password })).status, 401);
    const managerAfterReset = await login(managerEmail, newPassword);
    const currentOwnerId = (await (await request('/auth/me', 'GET', undefined, current)).json()).id;
    assert.equal((await request('/auth/change-password', 'POST', { accountId: currentOwnerId, currentPassword: newPassword, password }, managerAfterReset)).status, 403);
    assert.equal((await request('/auth/change-password', 'POST', { accountId: managerMembership.userId, currentPassword: newPassword, password }, managerAfterReset)).status, 200);
    assert.equal((await request('/auth/me', 'GET', undefined, current)).status, 200);

    assert.equal((await request(`/auth/sessions/${session.id}`, 'DELETE', undefined, current)).status, 200);
    assert.equal((await request('/auth/me', 'GET', undefined, current)).status, 401);
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
    try {
      const tenantFilter = { tenantId: { $in: tenantIds } };
      await Promise.all([
        BusinessAiSettings.deleteMany({ _id: tenantFilter.tenantId }),
        TaxDeclaration.deleteMany(tenantFilter),
        AccountToken.deleteMany({ userId: { $in: userIds } }),
        UserSession.deleteMany({ userId: { $in: userIds } }),
        PlatformGrant.deleteMany({ userId: { $in: userIds } }),
        AdminAuditLog.deleteMany({ actorId: { $in: userIds } }),
        SaaSInvoice.deleteMany({ reference: { $in: [run, `SUB-${run}`] } }),
        ...[AdmissionTicket, AuditLog, Bill, Branch, BranchProductPrice, BuffetPackage, CashEntry, Category, DiningArea, DiningTable, DishRecipe, FacilityMember, GuestSession, HotelBooking, HotelPackage, HotelRoom, IdempotencyRecord, IncomingTransfer,
          KitchenTicket, MemberClass, MemberCredential, MemberPayment, MemberPlan, Membership, MemberVisit, Order, OutboxEvent, Payment, PaymentIntent, Product, PurchaseReceipt,
          ProductVariant, Refund, StaffAttendance, StaffClockCredential, StaffClockDevice, StaffDocument, StaffIdentity, StaffPayPayment, StaffPayRate, StaffSchedule, Subscription, TableSession, TicketRefund, TicketSale, TicketType, UnavailableProduct, WarehouseItem, WarehouseMovement].map(model => model.collection.deleteMany({
            tenantId: { $in: tenantIds.map(id => new mongoose.Types.ObjectId(id)) },
          })),
        Tenant.deleteMany({ _id: tenantFilter.tenantId }),
        User.deleteMany({ _id: { $in: userIds } }),
      ]);
    } finally {
      await mongoose.disconnect();
    }
  }
});
