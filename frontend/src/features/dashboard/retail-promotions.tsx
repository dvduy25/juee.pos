'use client';

import { useState } from 'react';
import { useLanguage } from '@/i18n/language';
import { useData } from '@/hooks/use-business';

type RetailOffer = { id: string; code: string; name: string; kind: 'PERCENT' | 'FIXED'; value: number; minimum: number; productIds?: string[] };
type CartPriceLine = { productId: string; quantity: number; unitPrice: number };
type RetailPricing = { taxBps: number; promotion?: RetailOffer | null };
const codeFormat = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

export function useRetailDiscount(lines: CartPriceLine[], subtotal: number, enabled = true, initialCode = '') {
  const [draft, setDraft] = useState(initialCode);
  const [code, setCode] = useState(initialCode);
  const normalized = draft.trim().toUpperCase();
  const pricing = useData<RetailPricing>(`/retail-pricing${code ? `?code=${encodeURIComponent(code)}` : ''}`, 15000, enabled);
  const offer = pricing.data?.promotion;
  const products = offer?.productIds && new Set(offer.productIds);
  const eligible = products ? lines.reduce((sum, item) => products.has(item.productId) ? sum + item.quantity * item.unitPrice : sum, 0) : subtotal;
  const promotion = offer && subtotal >= offer.minimum && Number.isSafeInteger(subtotal) && Number.isSafeInteger(eligible) && eligible > 0 ? offer : undefined;
  const reduction = promotion ? Math.min(eligible,
    promotion.kind === 'FIXED' ? promotion.value : Number(BigInt(eligible) * BigInt(promotion.value) / 100n)) : 0;
  const validDraft = !normalized || codeFormat.test(normalized);
  return {
    draft, setDraft, code, pricing, validDraft, promotion, reduction,
    ready: !!pricing.data && !pricing.error && normalized === code && (!code || !!promotion),
    canApply: !!normalized && validDraft && normalized !== code,
    apply: () => { if (codeFormat.test(normalized)) setCode(normalized); },
    clear: () => { setCode(''); setDraft(''); },
  };
}

export function RetailDiscountCode({ discount, disabled }: { discount: ReturnType<typeof useRetailDiscount>; disabled?: boolean }) {
  const { t } = useLanguage();
  return <div className="retail-discount-code">
    <label>{t("Mã giảm giá của khách")}
      <input value={discount.draft} autoComplete="off" autoCapitalize="characters" maxLength={30} spellCheck={false}
        disabled={disabled} onChange={event => discount.setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); discount.apply(); } }}/>
    </label>
    <button type="button" className="plain" disabled={disabled || !discount.canApply} onClick={discount.apply}>{t("Áp dụng")}</button>
    {(discount.code || discount.draft) && <button type="button" className="plain" disabled={disabled}
      onClick={discount.clear}>{t("Xóa mã")}</button>}
    {!discount.validDraft && <small className="error">{t("Mã giảm giá chỉ gồm chữ, số, dấu gạch ngang hoặc gạch dưới.")}</small>}
    {discount.code && discount.pricing.data && <small role="status">{discount.promotion
      ? t("Đã áp dụng mã {0}", discount.code)
      : t("Mã giảm giá không hợp lệ, đã hết hạn hoặc đơn chưa đủ điều kiện.")}</small>}
  </div>;
}
