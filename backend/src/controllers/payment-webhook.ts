import { Body, Controller, Headers, HttpCode, NotFoundException, Post, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isDuplicate } from '../utils/db';
import { read, vnd } from '../validators/common';
import { transaction } from '../config/db';
import { Bill, Branch, IncomingTransfer, Payment, PaymentIntent, Tenant } from '../models';
import { collect } from '../services/sales';
import { applySubscriptionTransfer, subscriptionPaymentConfig, subscriptionReferences } from '../services/subscription-payments';

const bodySchema = z.object({
  id: z.number().int().positive().safe(), accountNumber: z.string().regex(/^\d{4,30}$/),
  content: z.string().max(2000), transferType: z.enum(['in', 'out']), transferAmount: vnd,
  referenceCode: z.string().trim().min(1).max(120),
});
const subscriptionTransferSchema = bodySchema.extend({
  gateway: z.string().max(100).optional(), transactionDate: z.string().max(40).optional(),
});
const digest = (value: string) => createHash('sha256').update(value).digest();
function verifyWebhook(authorization: string | undefined, secret?: string) {
  if (!secret) throw new NotFoundException();
  if (!authorization || !timingSafeEqual(digest(authorization), digest('Apikey ' + secret))) throw new UnauthorizedException();
}

@Controller('webhooks')
export class PaymentWebhookController {
  @Post('sepay/subscriptions')
  @HttpCode(201)
  async receiveSubscription(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const config = subscriptionPaymentConfig();
    if (!config) throw new NotFoundException();
    verifyWebhook(authorization, config.key);
    const entry = read(subscriptionTransferSchema, body);
    if (entry.transferType !== 'in') return { success: true };
    const references = subscriptionReferences(entry.content);
    if (references.length !== 1) return { success: true };
    const key = { provider: 'SEPAY', transactionId: String(entry.id) };
    try {
      await transaction(async session => {
        if (await IncomingTransfer.exists(key).session(session)) return;
        await applySubscriptionTransfer(references[0], entry, config, session);
      });
    } catch (error) {
      if (!isDuplicate(error) || !await IncomingTransfer.exists(key)) throw error;
    }
    return { success: true };
  }

  @Post('sepay')
  @HttpCode(200)
  async receive(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    verifyWebhook(authorization, process.env.SEPAY_WEBHOOK_API_KEY);
    const entry = read(bodySchema, body);
    if (entry.transferType !== 'in' || subscriptionReferences(entry.content).length) return { success: true };
    const token = entry.content.toUpperCase().match(/\bJUEE\s*([A-F0-9]{12})\b/)?.[1];
    if (!token) return { success: true };
    const reference = `JUEE ${token}`;
    const key = { provider: 'SEPAY', transactionId: String(entry.id) };
    try {
      await transaction(async session => {
        if (await IncomingTransfer.exists(key).session(session)) return;
        const intent = await PaymentIntent.findOne({ reference }).session(session);
        const event = await IncomingTransfer.insertOne({ ...key, account: entry.accountNumber, amount: entry.transferAmount, reference,
          status: 'REVIEW', tenantId: intent?.tenantId, branchId: intent?.branchId, intentId: intent?._id }, { session });
        if (!intent || intent.status !== 'PENDING' || intent.expiresAt <= new Date() || intent.amount !== entry.transferAmount || intent.account !== entry.accountNumber) return;
        const scope = { tenantId: intent.tenantId, branchId: intent.branchId };
        if (!await Tenant.exists({ _id: scope.tenantId, locked: { $ne: true } }).session(session)) return;
        const branch = await Branch.findOne({ tenantId: scope.tenantId, _id: scope.branchId, 'bankAccount.account': entry.accountNumber,
          'bankAccount.bank': intent.bank }).session(session).lean();
        if (!branch) return;
        const bill = await Bill.findOne({ ...scope, _id: intent.billId, status: 'OPEN' }).session(session).lean();
        if (!bill || bill.totalAmount - bill.paidAmount < intent.amount) return;
        if (await Payment.exists({ ...scope, reference: entry.referenceCode }).session(session)) return;
        await collect(scope, String(intent.billId), undefined, { method: 'TRANSFER', amount: intent.amount, reference: entry.referenceCode,
          provider: key.provider, providerTransactionId: key.transactionId }, session);
        intent.status = 'PAID';
        await intent.save({ session });
        event.status = 'MATCHED';
        await event.save({ session });
      });
    } catch (error) {
      if (!isDuplicate(error) || !await IncomingTransfer.exists(key)) throw error;
    }
    return { success: true };
  }
}
