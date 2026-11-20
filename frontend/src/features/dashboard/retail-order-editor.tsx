'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, State } from '@/components/business-ui';
import { useAction, useData } from '@/hooks/use-business';
import { currency } from '@/lib/format';
import { salePrice } from '@/lib/sale-price';
import type { Product, Variant } from '@/types/catalog';
import { eligibleRetailOffers, RetailPromotionSelect, type RetailPricing } from './retail-promotions';

type Line = { name: string; sku?: string; productId: string; variantId: string; unitPrice: number; quantity: number };
export type RetailOrderForEdit = {
  id: string; createdAt: string; updatedAt?: string; billId?: string; totalAmount: number;
  discountAmount?: number; promotionId?: string; promotionCode?: string;
  items: (Line & { id: string })[];
};
type DraftLine = Line & { lineId?: string };
const maxLines = 50;
const maxQuantity = 1000;

export function RetailOrderEditor({ order, onClose, onSaved }: { order: RetailOrderForEdit; onClose: () => void; onSaved: (total: number) => void }) {
  const [draft, setDraft] = useState<DraftLine[]>(() => order.items.map(({ id, ...item }) => ({ ...item, lineId: id })));
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [promotionSelection, setPromotionSelection] = useState(order.promotionId ?? order.promotionCode ?? '');
  const [discount, setDiscount] = useState(promotionSelection ? 0 : order.discountAmount ?? 0);
  const pricing = useData<RetailPricing>('/retail-pricing', 15000);
  const products = useData<Product[]>(`/products?productType=RETAIL&page=${page}&q=${encodeURIComponent(search)}`, undefined, adding);
  const action = useAction();

  const subtotal = draft.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const quantitiesValid = draft.length > 0 && draft.every(item => Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= maxQuantity);
  const offers = quantitiesValid ? eligibleRetailOffers(pricing.data?.offers, draft, subtotal) : [];
  const offer = offers.find(item => item.id === promotionSelection || item.code === promotionSelection);
  const reduction = offer?.reduction ?? discount;
  const valid = quantitiesValid && Number.isSafeInteger(subtotal) && Number.isSafeInteger(reduction) && reduction >= 0 &&
    reduction <= Math.min(subtotal, offer ? Number.MAX_SAFE_INTEGER : 1_000_000_000_000);
  const tax = valid ? Number((BigInt(subtotal - reduction) * BigInt(pricing.data?.taxBps ?? 0) + 5000n) / 10000n) : 0;
  const total = subtotal - reduction + tax;
  const canSave = valid && Number.isSafeInteger(total) && !!pricing.data && !pricing.error && (!promotionSelection || !!offer);

  function add(product: Product, variant: Variant) {
    setDraft(items => {
      const index = items.findIndex(item => item.variantId === variant.id);
      if (index >= 0) return items.map((item, position) => position === index ?
        { ...item, quantity: Math.min(maxQuantity, item.quantity + 1) } : item);
      if (items.length >= maxLines) return items;
      return [...items, { name: product.name, sku: variant.sku, productId: product.id, variantId: variant.id, unitPrice: salePrice(variant), quantity: 1 }];
    });
  }

  return <BusinessDialog title={`Sửa đơn ${order.id.slice(-8).toUpperCase()}`} close={onClose} pending={action.pending}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!canSave) return;
      void action.send<{ totalAmount: number }>(`/orders/${order.id}`, {
        revision: order.updatedAt ?? order.createdAt, expectedTotal: total, promotionId: offer?.id, discountAmount: discount,
        items: draft.map(item => ({ ...(item.lineId ? { lineId: item.lineId } : { variantId: item.variantId }), quantity: item.quantity })),
      }, { method: 'PATCH' }).then(result => {
        if (result) onSaved(result.totalAmount);
        else { void pricing.refetch(); if (adding) void products.refetch(); }
      });
    }}>
      {order.billId && <p className="muted">Hóa đơn chưa thu tiền sẽ cập nhật theo đơn. Mã QR chuyển khoản đã tạo sẽ hết hiệu lực.</p>}
      {!draft.length && <p className="muted">Thêm ít nhất một sản phẩm để lưu đơn.</p>}
      <div className="retail-edit-lines">{draft.map((item, index) => <div className="list-row retail-edit-line" key={item.lineId ?? item.variantId}>
        <div><strong>{item.name}</strong><small>{item.sku ? `${item.sku} · ` : ''}{currency.format(item.unitPrice)}</small></div>
        <label>Số lượng<input type="number" min={1} max={maxQuantity} step={1} required value={item.quantity || ''} disabled={action.pending}
          aria-label={`Số lượng ${item.name}`} onChange={event => {
            const quantity = Number(event.target.value);
            setDraft(items => items.map((line, position) => position === index ? { ...line, quantity } : line));
          }}/></label>
        <button type="button" className="plain" disabled={action.pending} onClick={() => setDraft(items => items.filter((_, position) => position !== index))}
          aria-label={`Bỏ ${item.name}`}>Bỏ</button>
      </div>)}</div>
      <button type="button" className="plain" aria-expanded={adding} onClick={() => setAdding(value => !value)}>
        <Plus size={16} aria-hidden="true"/> {adding ? 'Đóng danh sách sản phẩm' : 'Thêm sản phẩm'}
      </button>
      {adding && <section className="retail-edit-products" aria-label="Sản phẩm thêm vào đơn">
        <label>Tìm tên hoặc SKU<input type="search" value={search} maxLength={100}
          onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
        <State query={products} empty={products.data?.length === 0}/>
        <div className="retail-edit-results">{products.data?.flatMap(product => product.variants.map(variant => <div className="list-row" key={variant.id}>
          <div>{product.name}<small>{variant.sku} · {currency.format(salePrice(variant))}</small></div>
          <button type="button" className="plain" disabled={action.pending || !!variant.paused || draft.length >= maxLines}
            onClick={() => add(product, variant)}>{variant.paused ? 'Chưa khả dụng' : 'Thêm'}</button>
        </div>))}</div>
        <Pager page={page} full={products.data?.length === 50} onChange={setPage}/>
      </section>}
      <div className="columns">
        <RetailPromotionSelect offers={offers} selected={promotionSelection} disabled={action.pending || !pricing.data}
          onChange={id => { setPromotionSelection(id); if (id) setDiscount(0); }}/>
        <label>Giảm giá thủ công (đ)<input type="number" min={0} max={Math.min(subtotal, 1_000_000_000_000)} step={1} value={discount}
          onChange={event => setDiscount(Number(event.target.value))} disabled={action.pending || !!promotionSelection}/></label>
      </div>
      <State query={pricing}/>
      {quantitiesValid && promotionSelection && !offer && pricing.data &&
        <p className="error" role="status">Ưu đãi cũ không áp dụng cho đơn này. Hãy chọn lại hoặc bỏ ưu đãi.</p>}
      {valid && <dl className="bill-amounts">
        <div><dt>Tạm tính</dt><dd>{currency.format(subtotal)}</dd></div><div><dt>Giảm giá</dt><dd>{currency.format(reduction)}</dd></div>
        <div><dt>Thuế</dt><dd>{currency.format(tax)}</dd></div><div className="bill-due"><dt>Tổng tiền mới</dt><dd>{currency.format(total)}</dd></div>
      </dl>}
      {action.feedback}
      <button className="button" disabled={!canSave || action.pending}>{action.pending ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
    </form>
  </BusinessDialog>;
}
