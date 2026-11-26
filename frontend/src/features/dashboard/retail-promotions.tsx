'use client';

import { useLanguage } from '@/i18n/language';
import { currency } from '@/lib/format';

type RetailOffer = { id: string; code: string; name: string; kind: 'PERCENT' | 'FIXED'; value: number; minimum: number; productIds?: string[] };
type CartPriceLine = { productId: string; quantity: number; unitPrice: number };
export type RetailPricing = { taxBps: number; offers: RetailOffer[] };
type EligibleOffer = RetailOffer & { reduction: number };

export function eligibleRetailOffers(offers: RetailOffer[] | undefined, lines: CartPriceLine[], subtotal: number): EligibleOffer[] {
  if (!offers || !Number.isSafeInteger(subtotal) || subtotal <= 0) return [];
  return offers.flatMap(offer => {
    if (subtotal < offer.minimum) return [];
    const products = offer.productIds && new Set(offer.productIds);
    const eligible = products ? lines.reduce((sum, item) => products.has(item.productId) ? sum + item.quantity * item.unitPrice : sum, 0) : subtotal;
    if (!Number.isSafeInteger(eligible) || eligible <= 0) return [];
    const reduction = Math.min(eligible, offer.kind === 'FIXED' ? offer.value : Number(BigInt(eligible) * BigInt(offer.value) / 100n));
    return reduction > 0 ? [{ ...offer, reduction }] : [];
  });
}

export function RetailPromotionSelect({ offers, selected, onChange, disabled }: {
  offers: EligibleOffer[]; selected: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const { t } = useLanguage();
  const current = offers.find(offer => offer.id === selected || offer.code === selected);
  return <label>{t("Khuyến mãi")}
    <select value={current?.id ?? selected} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{offers.length ? t("Không áp dụng") : t("Chưa có ưu đãi phù hợp")}</option>
      {!current && selected && <option value={selected} disabled>{t("Ưu đãi cũ không còn áp dụng")}</option>}
      {offers.map(offer => <option key={offer.id} value={offer.id}>{offer.name} {t("· giảm")} {currency.format(offer.reduction)}</option>)}
    </select>
  </label>;
}
