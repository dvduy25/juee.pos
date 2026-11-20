import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { connectDatabase, ensureIndexes, transaction } from '../src/config/db';
import { PaymentWebhookController } from '../src/controllers/payment-webhook';
import { IncomingTransfer, PlanVersion, SaaSCheckout, SaaSInvoice, Subscription, Tenant } from '../src/models';
import { createSubscriptionCheckout, subscriptionPaymentConfig } from '../src/services/subscription-payments';

test('SePay subscription receipt activates once and puts mismatches into review', { timeout: 30_000 }, async () => {
  const database = process.env.TEST_DATABASE_URL;
  assert.ok(database, 'Set TEST_DATABASE_URL to a replica set with a database name ending in _test.');
  assert.match(new URL(database).pathname, /^\/[a-z0-9_-]+_test$/i);
  const env = {
    MONGODB_URI: database, SAAS_BANK_BIN: '970422', SAAS_BANK_ACCOUNT: '0000001234', SAAS_BANK_HOLDER: 'Test',
    SAAS_BANK_GATEWAY: 'MBBank', SAAS_SEPAY_WEBHOOK_API_KEY: randomBytes(32).toString('hex'),
    SEPAY_WEBHOOK_API_KEY: randomBytes(32).toString('hex'),
  };
  Object.assign(process.env, env);
  const config = subscriptionPaymentConfig(env)!;
  const tenantId = new Types.ObjectId();
  const subscriptionId = new Types.ObjectId();
  const planId = new Types.ObjectId();
  await connectDatabase();
  try {
    await ensureIndexes();
    const revision = await PlanVersion.insertOne({ planId, version: 1, monthlyVnd: 39000n,
      maxBranches: 1, maxStaff: 3, maxQrTables: 10, features: ['pos'] });
    const requestId = randomUUID();
    await Tenant.insertOne({ _id: tenantId, name: 'Doanh nghiệp kiểm thử thanh toán' });
    const contract = await Subscription.insertOne({
      _id: subscriptionId, tenantId, status: 'PENDING', planVersionId: revision._id, requestedPlanVersionId: revision._id, requestId,
    });
    const checkout = await transaction(session => createSubscriptionCheckout(config, contract, revision, requestId, session));
    const webhook = new PaymentWebhookController();
    const auth = 'Apikey ' + config.key;
    const receipt = {
      id: randomBytes(6).readUIntBE(0, 6) + 1, gateway: config.gateway, accountNumber: config.account, transferType: 'in',
      transactionDate: new Date(+checkout.issuedAt + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
      content: checkout.reference, transferAmount: checkout.amount, referenceCode: randomUUID(),
    };
    await assert.rejects(webhook.receiveSubscription(undefined, receipt), { status: 401 });
    await assert.rejects(webhook.receiveSubscription('Apikey ' + env.SEPAY_WEBHOOK_API_KEY, receipt), { status: 401 });
    await webhook.receiveSubscription(auth, { ...receipt, id: receipt.id + 1, transferAmount: receipt.transferAmount - 1, referenceCode: randomUUID() });
    assert.equal(await IncomingTransfer.countDocuments({ subscriptionId, status: 'REVIEW' }), 1);
    assert.equal(await SaaSInvoice.countDocuments({ subscriptionId }), 0);
    assert.equal((await Subscription.findById(subscriptionId).orFail()).status, 'PENDING');

    await Promise.all([webhook.receiveSubscription(auth, receipt), webhook.receiveSubscription(auth, receipt)]);
    const active = await Subscription.findById(subscriptionId).orFail();
    assert.equal(active.status, 'ACTIVE');
    assert.equal(active.requestId, undefined);
    assert.equal(+active.expiresAt! - +active.startsAt, 30 * 86_400_000);
    const invoice = await SaaSInvoice.findOne({ subscriptionId }).orFail();
    assert.equal(invoice.amountVnd, 39000n);
    assert.equal(invoice.reference, receipt.referenceCode);
    assert.equal(await IncomingTransfer.countDocuments({ subscriptionId, status: 'MATCHED' }), 1);
    await webhook.receiveSubscription(auth, { ...receipt, id: receipt.id + 2, referenceCode: randomUUID() });
    assert.equal(await SaaSInvoice.countDocuments({ subscriptionId }), 1);
    assert.equal(await IncomingTransfer.countDocuments({ subscriptionId, status: 'REVIEW' }), 2);
  } finally {
    try {
      await Promise.all([
        Tenant.deleteOne({ _id: tenantId }), Subscription.deleteOne({ _id: subscriptionId }), PlanVersion.deleteMany({ planId }),
        SaaSCheckout.deleteMany({ subscriptionId }), SaaSInvoice.deleteMany({ subscriptionId }), IncomingTransfer.deleteMany({ subscriptionId }),
      ]);
    } finally {
      await mongoose.disconnect();
    }
  }
});
