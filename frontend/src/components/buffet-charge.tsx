import { currency } from '@/lib/format';
import type { Buffet } from '@/types/business';

export function BuffetCharge({ buffet }: { buffet: Buffet }) {
  return <>
    {buffet.packageName && <p><strong>{buffet.packageName}</strong></p>}
    {buffet.adults > 0 && <div className="list-row">Buffet người lớn × {buffet.adults}<strong>{currency.format(buffet.adults * buffet.adultPrice)}</strong></div>}
    {buffet.children > 0 && <div className="list-row">Buffet trẻ em × {buffet.children}<strong>{currency.format(buffet.children * buffet.childPrice)}</strong></div>}
  </>;
}
