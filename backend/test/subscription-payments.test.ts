import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSubscriptionTransfer, subscriptionPaymentConfig, subscriptionReferences } from '../src/services/subscription-payments';
import { subscriptionPeriod } from '../src/services/platform-subscriptions';

const env = {
  SAAS_BANK_BIN: '970422', SAAS_BANK_ACCOUNT: '0000001234', SAAS_BANK_HOLDER: 'Test',
  SAAS_BANK_GATEWAY: 'MBBank', SAAS_SEPAY_WEBHOOK_API_KEY: 'fixture-subscription-key-00000000',
};

test('subscription checkout is enabled only with complete settings and a dedicated webhook key', () => {
  assert.equal(subscriptionPaymentConfig({}), undefined);
  assert.throws(() => subscriptionPaymentConfig({ SAAS_BANK_BIN: '970422' }));
  assert.throws(() => subscriptionPaymentConfig({ ...env, SEPAY_WEBHOOK_API_KEY: env.SAAS_SEPAY_WEBHOOK_API_KEY }));
  assert.equal(subscriptionPaymentConfig(env)?.account, '0000001234');
  assert.deepEqual(subscriptionReferences('Nop jpabcdef1234567890 JPABCDEF1234567890'), ['JPABCDEF1234567890']);
  assert.deepEqual(subscriptionReferences('JUEE ABCDEF123456'), []);
  assert.deepEqual(subscriptionReferences('JPABCDEF1234567890 JPABCDEF1234567891'), ['JPABCDEF1234567890', 'JPABCDEF1234567891']);
});

test('subscription transfer must match the bank, amount and original checkout window in Vietnam time', () => {
  const config = subscriptionPaymentConfig(env)!;
  const issuedAt = new Date('2026-11-20T03:00:00Z');
  const expiresAt = new Date('2026-11-20T03:30:00Z');
  const quote = { ...config, amount: 39000, issuedAt, expiresAt };
  const received = { accountNumber: config.account, gateway: 'mbbank', transactionDate: '2026-11-20 10:01:00', transferAmount: quote.amount };
  const now = new Date('2026-11-20T03:35:00Z');
  assert.deepEqual(checkSubscriptionTransfer(quote, received, config, now), { paidAt: new Date('2026-11-20T03:01:00Z') });
  for (const invalid of [
    { transferAmount: quote.amount - 1 }, { transferAmount: quote.amount + 1 }, { accountNumber: '111111' }, { gateway: 'OtherBank' },
    { transactionDate: '2026-11-20 09:59:59' }, { transactionDate: '2026-11-20 10:30:00' }, { transactionDate: '2026-11-31 10:01:00' },
    { transactionDate: undefined },
  ]) {
    assert.ok('reason' in checkSubscriptionTransfer(quote, { ...received, ...invalid }, config, now));
  }
  assert.ok('reason' in checkSubscriptionTransfer(quote, received, { ...config, account: '111111' }, now));
});

test('renewal preserves paid time on the current plan and starts a fresh period when changing plans', () => {
  const now = new Date('2026-11-20T03:00:00Z');
  const current = { startsAt: new Date('2026-11-01T03:00:00Z'), expiresAt: new Date('2026-12-01T03:00:00Z') };
  assert.deepEqual(subscriptionPeriod(current, true, now), { startsAt: current.startsAt, expiresAt: new Date('2026-12-31T03:00:00Z') });
  assert.deepEqual(subscriptionPeriod(current, false, now), { startsAt: now, expiresAt: new Date('2026-12-20T03:00:00Z') });
  const expired = { ...current, expiresAt: new Date('2026-11-15T03:00:00Z') };
  assert.equal(subscriptionPeriod(expired, true, now).expiresAt.toISOString(), '2026-12-20T03:00:00.000Z');
});
