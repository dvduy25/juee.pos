import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';
import type { Scope } from '../middleware/business-access';
import { Branch, RetailPromotion } from '../models';
import { found } from '../utils/db';

export function roundedMoney(numerator: bigint, denominator: bigint) {
  const value = Number((numerator + denominator / 2n) / denominator);
  if (!Number.isSafeInteger(value)) throw new BadRequestException('Số tiền vượt giới hạn lưu trữ.');
  return value;
}

const offerFields = 'code name kind value minimum productIds';
function activeOffers(scope: Scope, now = new Date()) {
  return { ...scope, enabled: true, startsAt: { $lte: now }, endsAt: { $gt: now } };
}

export async function retailPricing(scope: Scope, code?: string, session?: ClientSession) {
  const branch = await Branch.findOne({ _id: scope.branchId, tenantId: scope.tenantId }).select('retailTaxBps').session(session ?? null).lean();
  const promotion = code && await RetailPromotion.findOne({ ...activeOffers(scope), code })
    .select(offerFields).session(session ?? null).lean();
  return { taxBps: found(branch).retailTaxBps ?? 0, promotion: promotion || null };
}

export function retailProductPrice(price: number, discountPercent?: number | null) {
  return discountPercent ? price - Number(BigInt(price) * BigInt(discountPercent) / 100n) : price;
}

export function requireDiscountCode(input: { discountAmount?: number; promotionId?: string }) {
  if (input.discountAmount || input.promotionId) throw new ConflictException('Hãy nhập mã giảm giá hoặc cài mức giảm trong sản phẩm.');
}

type PromotionTerms = { kind: 'PERCENT' | 'FIXED'; value: number; minimum: number; productIds?: readonly (Types.ObjectId | string)[] | null };
type RetailLine = { productId: Types.ObjectId | string; unitPrice: number; quantity: number };

export function retailAmounts(subtotal: number, manualDiscount: number, taxBps: number,
  promotion?: PromotionTerms | null, items: RetailLine[] = []) {
  if (!Number.isSafeInteger(subtotal) || manualDiscount > subtotal) throw new BadRequestException('Tổng tiền hoặc giảm giá không hợp lệ.');
  if (promotion && manualDiscount) throw new ConflictException('Chọn mã khuyến mãi hoặc giảm giá thủ công.');
  let eligibleSubtotal = subtotal;
  if (promotion?.productIds) {
    const eligible = new Set(promotion.productIds.map(String));
    eligibleSubtotal = items.reduce((sum, item) => eligible.has(String(item.productId)) ? sum + item.unitPrice * item.quantity : sum, 0);
    if (eligibleSubtotal === 0) throw new ConflictException('Giỏ hàng chưa có sản phẩm được giảm giá theo mã này.');
  }
  if (promotion && subtotal < promotion.minimum) throw new ConflictException('Đơn chưa đạt giá trị tối thiểu của khuyến mãi.');
  const discountAmount = promotion ? Math.min(eligibleSubtotal, promotion.kind === 'FIXED' ? promotion.value :
    Number(BigInt(eligibleSubtotal) * BigInt(promotion.value) / 100n)) : manualDiscount;
  const net = subtotal - discountAmount;
  const taxAmount = roundedMoney(BigInt(net) * BigInt(taxBps), 10000n);
  if (!Number.isSafeInteger(net + taxAmount)) throw new BadRequestException('Tổng hóa đơn vượt giới hạn.');
  return { discountAmount, taxAmount, totalAmount: net + taxAmount };
}
