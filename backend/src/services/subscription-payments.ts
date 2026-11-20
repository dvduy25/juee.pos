import { ConflictException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { IncomingTransfer, PlanVersion, SaaSCheckout, SaaSInvoice, Subscription } from '../models';
import { label, vnd } from '../validators/common';
import { activatePaidSubscription, validatePlanForTenant } from './platform-subscriptions';

const paymentSettings = z.object({
  bank: z.string().regex(/^\d{6}$/),
  account: z.string().regex(/^\d{4,30}$/),
  holder: label,
  gateway: z.string().trim().min(1).max(100),
  key: z.string().min(32).max(256).regex(/^[\x21-\x7e]+$/),
});

export function subscriptionPaymentConfig(env = process.env) {
  const config = {
    bank: env.SAAS_BANK_BIN, account: env.SAAS_BANK_ACCOUNT, holder: env.SAAS_BANK_HOLDER,
    gateway: env.SAAS_BANK_GATEWAY, key: env.SAAS_SEPAY_WEBHOOK_API_KEY,
  };
  if (!Object.values(config).some(Boolean)) return undefined;
  const result = paymentSettings.safeParse(config);
  if (!result.success || (env.SEPAY_WEBHOOK_API_KEY && env.SEPAY_WEBHOOK_API_KEY === result.data.key)) {
    throw new Error('Set valid SAAS_BANK_BIN, SAAS_BANK_ACCOUNT, SAAS_BANK_HOLDER, SAAS_BANK_GATEWAY and a separate SAAS_SEPAY_WEBHOOK_API_KEY.');
  }
  return result.data;
}
type Config = NonNullable<ReturnType<typeof subscriptionPaymentConfig>>;
type Destination = Pick<Config, 'bank' | 'account' | 'gateway'>;
type Transfer = { id: number; accountNumber: string; gateway?: string; transactionDate?: string; transferAmount: number; referenceCode: string };
type Quote = Destination & { amount: number; issuedAt: Date; expiresAt: Date };

function sameGateway(first: string | undefined, second: string) {
  return first?.trim().toUpperCase() === second.toUpperCase();
}

export function sameSubscriptionDestination(quote: Destination, config: Destination) {
  return quote.bank === config.bank && quote.account === config.account && sameGateway(quote.gateway, config.gateway);
}

export function subscriptionReferences(content: string) {
  return [...new Set(content.toUpperCase().match(/\bJP[A-F0-9]{16}\b/g))];
}

export async function createSubscriptionCheckout(config: Config, contract: { _id: Types.ObjectId; tenantId: Types.ObjectId },
  revision: { _id: Types.ObjectId; monthlyVnd: bigint }, requestId: string, session: ClientSession) {
  const amount = vnd.safeParse(Number(revision.monthlyVnd));
  if (!amount.success || amount.data <= 0) throw new ConflictException('Giá gói nằm ngoài giới hạn thanh toán VietQR.');
  const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  return SaaSCheckout.insertOne({
    tenantId: contract.tenantId, subscriptionId: contract._id, planVersionId: revision._id, requestId,
    reference: 'JP' + randomBytes(8).toString('hex').toUpperCase(),
    bank: config.bank, account: config.account, holder: config.holder, gateway: config.gateway, amount: amount.data,
    issuedAt, expiresAt: new Date(+issuedAt + 30 * 60_000),
  }, { session });
}

function transferDate(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return undefined;
  const timestamp = Date.parse(value.replace(' ', 'T') + '+07:00');
  if (!Number.isFinite(timestamp) || new Date(timestamp + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') !== value) return undefined;
  return new Date(timestamp);
}

export function checkSubscriptionTransfer(quote: Quote, transfer: Pick<Transfer, 'accountNumber' | 'gateway' | 'transactionDate' | 'transferAmount'>,
  config: Destination, now: Date): { reason: string } | { paidAt: Date } {
  if (!sameSubscriptionDestination(quote, config) || transfer.accountNumber !== quote.account || !sameGateway(transfer.gateway, quote.gateway)) {
    return { reason: 'Tài khoản nhận hoặc ngân hàng chưa khớp.' };
  }
  if (transfer.transferAmount !== quote.amount) return { reason: 'Số tiền chuyển chưa khớp với giá gói.' };
  const paidAt = transferDate(transfer.transactionDate);
  if (!paidAt || paidAt < quote.issuedAt || paidAt >= quote.expiresAt || +paidAt > +now + 60_000) {
    return { reason: 'Thời điểm giao dịch nằm ngoài thời hạn mã thanh toán hoặc chưa xác định được.' };
  }
  return { paidAt };
}

export async function applySubscriptionTransfer(reference: string, transfer: Transfer, config: Config, session: ClientSession) {
  const checkout = await SaaSCheckout.findOne({ reference }).session(session).lean();
  if (!checkout) return;
  const event = { provider: 'SEPAY', transactionId: String(transfer.id), bankReference: transfer.referenceCode,
    account: transfer.accountNumber, amount: transfer.transferAmount, reference, tenantId: checkout.tenantId,
    subscriptionId: checkout.subscriptionId, checkoutId: checkout._id };
  const review = (reviewReason: string) => IncomingTransfer.insertOne({ ...event, status: 'REVIEW', reviewReason }, { session });
  const payment = checkSubscriptionTransfer(checkout, transfer, config, new Date());
  if ('reason' in payment) return review(payment.reason);
  const contract = await Subscription.findOne({ _id: checkout.subscriptionId, tenantId: checkout.tenantId,
    requestId: checkout.requestId, requestedPlanVersionId: checkout.planVersionId, status: { $in: ['ACTIVE', 'PENDING'] } }).session(session).lean();
  if (!contract) return review('Yêu cầu gói đã thay đổi hoặc thuê bao đang bị khóa, hủy.');
  if (await SaaSInvoice.exists({ reference: transfer.referenceCode }).session(session)) return review('Mã giao dịch ngân hàng đã được ghi nhận.');
  const revision = await PlanVersion.findById(checkout.planVersionId).setOptions({ useBigInt64: true }).session(session).lean();
  if (!revision || revision.monthlyVnd !== BigInt(checkout.amount)) return review('Không xác minh được phiên bản và giá gói.');
  try {
    await validatePlanForTenant(checkout.tenantId, revision, session);
  } catch (cause) {
    if (cause instanceof ConflictException) return review(cause.message);
    throw cause;
  }
  await activatePaidSubscription(contract, revision, { reference: transfer.referenceCode, paidAt: payment.paidAt, paymentCode: reference }, session);
  await IncomingTransfer.insertOne({ ...event, status: 'MATCHED' }, { session });
}
