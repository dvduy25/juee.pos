'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ClipboardList, Coffee, LocateFixed, MapPin, Minus, Plus, Search, ShoppingBag, Utensils, X } from 'lucide-react';
import { api, ApiError, requestKey } from '@/services/api-client';
import { currency, date } from '@/lib/format';
import { Pager } from '@/components/business-ui';
import { FullscreenButton } from '@/components/fullscreen-button';
import { BuffetCharge } from '@/components/buffet-charge';
import { salePrice } from '@/lib/sale-price';
import { itemTiming, useOrderClock, type Preparation } from '@/lib/order-timing';
import { currentPosition } from '@/lib/location';
import { foodVariantLabel, type Category, type Product } from '@/types/catalog';
import type { Buffet, BuffetSection } from '@/types/business';

type Menu = { tenant: string; branch: string; mode?: string; table: string; categories: Category[]; products: Product[]; buffet?: boolean; buffetName?: string;
  section: BuffetSection; orderState: 'UNCONFIGURED' | 'WAITING' | 'PAYMENT' | 'READY'; serviceId?: string };
type CartLine = { variantId: string; name: string; options: string; unitPrice: number; quantity: number; modifierIds: string[]; note: string; included: boolean };
type SavedOrder = { id: string; createdAt: string; totalAmount: number; status: string;
  items: { id: string; name: string; quantity: number; buffetIncluded?: boolean; cancelReason?: string }[]; kitchen: Omit<Preparation, 'id'>[] };
type Session = { token: string; expiresAt: string; serviceId: string };
type TablePayment = { requested: boolean; due: number; status?: string; billId?: string; qrAvailable: boolean; buffet?: Buffet };
type PaymentQr = { paid: true } | { paid: false; billId: string; qrUrl: string; amount: number; reference: string;
  bankAccount: { bank: string; account: string; holder: string }; expiresAt: string };
const statusLabels: Record<string, string> = { PLACED: 'Chờ xác nhận', ACCEPTED: 'Đã nhận', COMPLETED: 'Đã thanh toán', CANCELED: 'Đã hủy',
  NEW: 'Chờ ra món', COOKING: 'Chờ ra món', READY: 'Chờ ra món', SERVED: 'Đã phục vụ' };

function DishImage({ product }: { product: Product }) {
  return product.images?.[0] ? <img className="guest-img" src={product.images[0]} alt="" loading="lazy"/> :
    <div className="guest-img guest-image-empty" aria-hidden="true"><Utensils size={30}/></div>;
}

function DishDetails({ product, add, close, disabled, included }: { product: Product; add: (item: CartLine) => void; close: () => void; disabled: boolean; included: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [variantId, setVariantId] = useState(product.variants.find(item => !item.paused)?.id ?? '');
  const [modifierIds, setModifierIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const variant = product.variants.find(item => item.id === variantId);
  const groups = product.modifierGroups ?? [];
  const modifiers = groups.flatMap(group => group.options.filter(option => modifierIds.includes(option.id)));
  const unitPrice = (variant ? salePrice(variant, included) : 0) + modifiers.reduce((sum, option) => sum + option.additionalPrice, 0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!variant || disabled || variant.paused) return;
    for (const group of groups) {
      const selected = group.options.filter(option => modifierIds.includes(option.id));
      if (selected.length < group.minSelect || selected.length > group.maxSelect) {
        setError(`Hãy chọn từ ${group.minSelect} đến ${group.maxSelect} mục ở nhóm ${group.name}.`);
        return;
      }
    }
    const form = new FormData(event.currentTarget);
    const options = [...(product.variants.length > 1 ? [foodVariantLabel(variant, product.variants.indexOf(variant))] : []), ...modifiers.map(option => option.name)].join(' · ');
    add({ variantId: variant.id, name: product.name, options, unitPrice, quantity, modifierIds, included, note: String(form.get('note') ?? '').trim() });
    close();
  }
  return <dialog ref={dialog} className="guest-dish-dialog card" aria-labelledby="guest-dish-name" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="guest-section-head"><h2 id="guest-dish-name">{product.name}</h2><button className="icon" type="button" onClick={close} aria-label="Đóng tùy chọn món"><X size={21}/></button></div>
    {product.description && <p className="muted">{product.description}</p>}
    <form onSubmit={submit}>
      {product.variants.length > 1 && <label>Phiên bản<select value={variantId} onChange={event => { setVariantId(event.target.value); setQuantity(1); }}>
        {product.variants.map((item, index) => <option disabled={item.paused} key={item.id} value={item.id}>{foodVariantLabel(item, index)}{!included && ` · ${currency.format(salePrice(item))}`}{item.paused ? ' · Hết món' : ''}</option>)}
      </select></label>}
      {groups.map(group => <fieldset key={group.id}><legend>{group.name}</legend><small>Chọn {group.minSelect === group.maxSelect ? group.maxSelect : `${group.minSelect}–${group.maxSelect}`}</small>
        {group.options.map(option => <label className="check guest-option" key={option.id}><input type="checkbox" checked={modifierIds.includes(option.id)}
          onChange={event => {
            const checked = event.target.checked;
            setError('');
            setModifierIds(current => checked ? [...current, option.id] : current.filter(id => id !== option.id));
          }}/><span>{option.name}</span>{option.additionalPrice > 0 && <span>+ {currency.format(option.additionalPrice)}</span>}</label>)}</fieldset>)}
      <label>Ghi chú<input name="note" maxLength={500} placeholder="Ví dụ ít đá"/></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="guest-dish-footer"><Quantity quantity={quantity} change={setQuantity}/>
        <button className="button" disabled={disabled || !variant || variant.paused}>Thêm món{(!included || unitPrice > 0) && ` · ${currency.format(unitPrice * quantity)}`}</button></div>
    </form>
  </dialog>;
}

function Quantity({ quantity, change, disabled = false, max = 50 }: { quantity: number; change: (value: number) => void; disabled?: boolean; max?: number }) {
  return <div className="guest-quantity">
    <button type="button" className="plain" aria-label="Giảm số lượng" disabled={disabled || quantity <= 1} onClick={() => change(quantity - 1)}><Minus size={16}/></button>
    <span aria-label="Số lượng">{quantity}</span>
    <button type="button" className="plain" aria-label="Tăng số lượng" disabled={disabled || quantity >= max} onClick={() => change(quantity + 1)}><Plus size={16}/></button>
  </div>;
}

export function GuestOrder({ tenantId, tableToken }: { tenantId: string; tableToken: string }) {
  const [menu, setMenu] = useState<Menu>();
  const [session, setSession] = useState<Session>();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [section, setSection] = useState<BuffetSection>('included');
  const [selectedId, setSelectedId] = useState<string>();
  const [menuPending, setMenuPending] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [menuError, setMenuError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [feedbackInCart, setFeedbackInCart] = useState(false);
  const [tablePayment, setTablePayment] = useState<TablePayment>();
  const [payment, setPayment] = useState<{ qr?: PaymentQr; error?: string }>();
  const [ordersOpen, setOrdersOpen] = useState(false);
  const ordersDialog = useRef<HTMLDialogElement>(null);
  const now = useOrderClock(ordersOpen);
  const retry = useRef<{ signature: string; key: string } | undefined>(undefined);
  const active = useRef(false);
  const total = cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const portions = cart.reduce((sum, item) => sum + item.quantity, 0);
  const sessionKey = `juee-guest-${tenantId}-${tableToken}`;
  useEffect(() => {
    if (!ordersOpen) return;
    const dialog = ordersDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [ordersOpen]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null') as Session | null;
      if (saved?.token && new Date(saved.expiresAt) > new Date()) setSession(saved);
    } catch { /* Continue with a new session if the browser cannot restore it. */ }
  }, [sessionKey]);
  useEffect(() => {
    let current = true;
    let inFlight = false;
    setMenuError(''); setMenuPending(true);
    const q = search.trim();
    const query = new URLSearchParams({ page: String(page), section, ...(categoryId ? { categoryId } : {}), ...(q ? { q } : {}) });
    async function loadMenu(showError = false) {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api<Menu>(`/guest/menu/${tenantId}/${tableToken}?${query}`);
        if (current) { setMenu(result); setMenuError(''); }
      } catch (cause) {
        if (current && showError) setMenuError(cause instanceof Error ? cause.message : 'Không tải được thực đơn.');
      } finally {
        inFlight = false;
        if (current) setMenuPending(false);
      }
    }
    const timer = window.setTimeout(() => void loadMenu(true), search ? 250 : 0);
    const refresh = window.setInterval(() => void loadMenu(), 5000);
    const onFocus = () => void loadMenu();
    window.addEventListener('focus', onFocus);
    return () => { current = false; window.clearTimeout(timer); window.clearInterval(refresh); window.removeEventListener('focus', onFocus); };
  }, [tenantId, tableToken, page, categoryId, search, reload, section]);

  useEffect(() => {
    if (!session) return;
    let current = true;
    async function getOrders() {
      if (active.current) return;
      try {
        const headers = { Authorization: `Guest ${session!.token}` };
        const [result, status] = await Promise.all([
          api<SavedOrder[]>('/guest/orders', 'GET', undefined, headers), api<TablePayment>('/guest/table-payment', 'GET', undefined, headers),
        ]);
        if (current && !active.current) { setOrders(result); setTablePayment(status); }
      } catch (cause) {
        if (current && cause instanceof ApiError && cause.status === 401) {
          setSession(undefined); setOrders([]); setTablePayment(undefined); setPayment(undefined); setOrdersOpen(false);
          setSection('included'); setPage(1); setCategoryId(''); setSelectedId(undefined); setReload(count => count + 1);
          setError(cause.message);
          try { sessionStorage.removeItem(sessionKey); } catch {}
        }
      }
    }
    void getOrders();
    const refresh = window.setInterval(getOrders, 5000);
    return () => { current = false; window.clearInterval(refresh); };
  }, [session, sessionKey]);

  async function connect(position: Awaited<ReturnType<typeof currentPosition>>) {
    const next = await api<Session>(`/guest/sessions/${tenantId}/${tableToken}`, 'POST', { position });
    if (session?.serviceId !== next.serviceId) {
      setOrders([]); setTablePayment(undefined); setPayment(undefined); setOrdersOpen(false);
      retry.current = undefined;
    }
    setSession(next);
    try { sessionStorage.setItem(sessionKey, JSON.stringify(next)); } catch {}
    setReload(count => count + 1);
    return next;
  }

  async function join() {
    if (active.current || menu?.orderState !== 'READY') return;
    setFeedbackInCart(false);
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await connect(await currentPosition());
      setNotice('Đã xác nhận vị trí. Bạn có thể gửi món.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể xác nhận vị trí.'); }
    finally { active.current = false; setBusy(false); }
  }

  async function send() {
    if (active.current || !cart.length || menu?.orderState !== 'READY' || billFinalized) return;
    setFeedbackInCart(true);
    active.current = true; setBusy(true); setError(''); setNotice('');
    const items = cart.map(({ variantId, quantity, modifierIds, note }) => ({ variantId, quantity, modifierIds, note }));
    try {
      const position = await currentPosition();
      const verified = session && session.serviceId === menu.serviceId ? session : await connect(position);
      const signature = JSON.stringify([verified.token, items]);
      if (retry.current?.signature !== signature) retry.current = { signature, key: requestKey() };
      const headers = { Authorization: `Guest ${verified.token}`, 'Idempotency-Key': retry.current.key };
      await api('/guest/orders', 'POST', { items, position }, headers);
      const [current, status] = await Promise.all([
        api<SavedOrder[]>('/guest/orders', 'GET', undefined, headers).catch(() => undefined),
        api<TablePayment>('/guest/table-payment', 'GET', undefined, headers).catch(() => undefined),
      ]);
      if (current) setOrders(current);
      if (status) setTablePayment(status);
      retry.current = undefined; setCart([]); setNotice('Đã gửi món đến cửa hàng.');
      setReload(count => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể gửi món.');
      if (cause instanceof ApiError && cause.status === 409) setReload(count => count + 1);
    }
    finally { active.current = false; setBusy(false); }
  }

  async function pay(request: boolean) {
    if (!session || active.current) return;
    active.current = true; setBusy(true);
    setPayment(undefined);
    const headers = { Authorization: `Guest ${session.token}` };
    try {
      if (request) await api('/guest/table-payment/request', 'POST', undefined, headers);
      else setPayment({ qr: await api<PaymentQr>('/guest/table-payment/qr', 'POST', undefined, headers) });
      setTablePayment(await api<TablePayment>('/guest/table-payment', 'GET', undefined, headers));
    } catch (cause) {
      setPayment({ error: cause instanceof Error ? cause.message : 'Chưa thực hiện được yêu cầu tính tiền.' });
    } finally { active.current = false; setBusy(false); }
  }

  const verified = !!menu?.serviceId && menu.serviceId === session?.serviceId;
  const billFinalized = menu?.orderState === 'PAYMENT' || (verified && !!tablePayment?.status);
  const canOrder = menu?.orderState === 'READY' && !billFinalized;
  const buffet = verified && tablePayment ? !!tablePayment.buffet : !!menu?.buffet;
  const included = !!menu?.buffet && menu.section === 'included';
  const selected = menu?.products.find(product => product.id === selectedId);
  const qr = payment?.qr;
  const feedback = <>{error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}</>;

  return <main className="landing guest-order-page" data-theme={menu?.mode === 'CAFE' ? 'CAFE' : 'RESTAURANT'}><div className="guest-content">
    <header className="guest-header"><div className="guest-top">
      <div className="guest-venue"><span className="guest-venue-icon">{menu?.mode === 'CAFE' ? <Coffee size={22} aria-hidden="true"/> : <Utensils size={22} aria-hidden="true"/>}</span>
        <div><strong>{menu?.tenant ?? 'JUEE POS'}</strong>{menu && <small>{menu.branch}</small>}</div></div>
      <FullscreenButton/></div>
      <div className="guest-heading"><div><h1>{menu ? `Thực đơn · ${menu.table}` : 'Thực đơn tại bàn'}</h1>
        {menu?.buffetName && <p className="muted">{menu.buffetName}</p>}</div>
        <div className="actions business-filters">
          {canOrder && (verified ? <span className="guest-verified"><Check size={16} aria-hidden="true"/> Đã xác nhận bàn</span> :
            <button type="button" className="plain guest-locate" onClick={() => void join()} disabled={busy}>
              <LocateFixed size={17} aria-hidden="true"/> Xác nhận vị trí</button>)}
          {session && <button className="plain" type="button" aria-haspopup="dialog" onClick={() => setOrdersOpen(true)}>
            <ClipboardList size={17} aria-hidden="true"/> Món đã gọi{orders.length > 0 && <span className="badge">{orders.length}</span>}</button>}
        </div>
      </div>
      {menu?.orderState === 'UNCONFIGURED' && <p className="guest-location-note"><MapPin size={16} aria-hidden="true"/> Chi nhánh chưa bật gọi món qua vị trí. Vui lòng gọi nhân viên.</p>}
      {menu?.orderState === 'WAITING' && <p className="guest-location-note">Bàn chưa mở lượt. Bạn có thể xem thực đơn và gọi nhân viên mở bàn.</p>}
      {billFinalized && <p className="guest-location-note">Lượt này đã chốt hóa đơn. Mở Món đã gọi để xem và thanh toán.</p>}
      {!feedbackInCart && feedback}
    </header>
    {menuError && <div className="error" role="alert">{menuError} <button type="button" className="plain" onClick={() => setReload(count => count + 1)}>Thử lại</button></div>}
    {!menu && menuPending && <div className="skeleton" role="status" aria-label="Đang tải thực đơn"/>}
    {menu && <div className="columns guest-columns"><section aria-label="Danh sách món">
      {buffet && <div className="guest-categories" role="group" aria-label="Thực đơn buffet">
        <button className="plain" type="button" aria-pressed={section === 'included'} onClick={() => { setSection('included'); setPage(1); setCategoryId(''); setSelectedId(undefined); }}>Món trong gói</button>
        <button className="plain" type="button" aria-pressed={section === 'extra'} onClick={() => { setSection('extra'); setPage(1); setCategoryId(''); setSelectedId(undefined); }}>Món gọi thêm có tính phí</button>
      </div>}
      <label className="guest-search"><Search size={18} aria-hidden="true"/><input aria-label="Tìm món" placeholder="Tìm món" value={search} maxLength={100}
        onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
      <div className="guest-categories" aria-label="Danh mục món">
        {[{ id: '', name: 'Tất cả' }, ...menu.categories].map(item => <button type="button" className="plain" key={item.id}
          aria-pressed={item.id === categoryId} onClick={() => { setCategoryId(item.id); setPage(1); }}>{item.name}</button>)}
      </div>
      {menuPending || menu.section !== section ? <div className="skeleton" role="status" aria-label="Đang tải món"/> : !menuError && <>
        {!menu.products.length && <p className="muted">Không tìm thấy món phù hợp.</p>}
        <div className="guest-menu">{menu.products.map(product => {
          const availableVariants = product.variants.filter(item => !item.paused);
          const pricedVariants = availableVariants.length ? availableVariants : product.variants;
          return <article className="card guest-item" key={product.id}>
          <DishImage product={product}/><div className="guest-item-body"><h2>{product.name}</h2>
            {product.description && <p className="muted">{product.description}</p>}
            <div className="guest-item-price"><strong>{included ? 'Trong gói buffet' : pricedVariants.length ? currency.format(Math.min(...pricedVariants.map(item => salePrice(item)))) : 'Chưa có giá'}</strong>
              {product.variants.length > 0 && !availableVariants.length ? <span className="badge warning">Hết món</span> :
                <button type="button" className="button" aria-label={`Chọn ${product.name}`} disabled={busy || !canOrder || !product.variants.length || cart.length >= 50} onClick={() => setSelectedId(product.id)}><Plus size={18}/></button>}</div>
          </div></article>})}</div>
        {(page > 1 || menu.products.length === 50) && <Pager page={page} full={menu.products.length === 50} onChange={setPage}/>}
      </>}
    </section><aside className="guest-sidebar" aria-label="Giỏ hàng">
      <section id="guest-cart" className="card business-panel guest-cart">
        <h2><ShoppingBag size={19} aria-hidden="true"/> Món đang chọn {portions > 0 && <span className="badge">{portions}</span>}</h2>
        {!cart.length && <p className="muted">Bạn chưa chọn món.</p>}
        <div className="guest-cart-list">{cart.map((item, index) => <div className="guest-cart-row" key={index}>
          <div><strong>{item.name}</strong>{item.options && <small>{item.options}</small>}{item.note && <small>{item.note}</small>}</div>
          <strong>{item.included && !item.unitPrice ? 'Trong gói buffet' : currency.format(item.quantity * item.unitPrice)}</strong>
          <Quantity quantity={item.quantity} disabled={busy} change={quantity => setCart(lines => lines.map((line, position) => position === index ? { ...line, quantity } : line))}/>
          <button className="plain" type="button" disabled={busy} onClick={() => setCart(lines => lines.filter((_, position) => index !== position))}>Bỏ</button>
        </div>)}</div>
        {cart.length > 0 && (!buffet || total > 0) && <div className="list-row guest-total">{buffet ? 'Tạm tính phụ thu' : 'Tổng tiền'} <strong>{currency.format(total)}</strong></div>}
        <button className="button guest-send" type="button" disabled={busy || !canOrder || !cart.length} onClick={() => void send()}>
          {busy ? 'Đang xử lý…' : 'Gửi món vào bàn'}</button>
        {canOrder && !verified && <small className="muted">Thiết bị sẽ hỏi quyền vị trí để gửi món.</small>}
        {feedbackInCart && feedback}
      </section>
    </aside></div>}
    {ordersOpen && <dialog ref={ordersDialog} className="guest-dish-dialog guest-orders-dialog card" aria-labelledby="guest-orders-title"
      onCancel={event => { event.preventDefault(); setOrdersOpen(false); }}>
      <div className="guest-section-head"><h2 id="guest-orders-title">Món đã gọi của bàn</h2>
        <button className="icon" type="button" aria-label="Đóng món đã gọi" onClick={() => setOrdersOpen(false)}><X size={21}/></button></div>
      {!orders.length && <p className="muted">Bàn chưa gọi món.</p>}
      {orders.map(order => <div className="guest-order" key={order.id}>
        <div className="list-row"><div><strong>{statusLabels[order.status]}</strong><small>{date(order.createdAt)}</small></div>
          {(!buffet || order.totalAmount > 0) && <strong>{currency.format(order.totalAmount)}</strong>}</div>
        {order.items.map(item => {
          const preparation = order.kitchen.find(kitchen => kitchen.orderItemId === item.id);
          const status = item.cancelReason ? 'CANCELED' : preparation?.status ?? order.status;
          const timing = itemTiming(order.createdAt, status, preparation?.servedAt, now);
          return <div className="list-row" key={item.id}><div>{item.name} × {item.quantity}{item.buffetIncluded && <small>Trong gói buffet</small>}</div>
            <div><small>{statusLabels[status]}</small>{item.cancelReason && <small>{item.cancelReason}</small>}
              {timing && timing !== statusLabels[status] && <small>{timing}</small>}</div></div>;
        })}
      </div>)}
        {tablePayment && (orders.length > 0 || tablePayment.buffet) && <div className="guest-payment">
          {tablePayment.buffet && <BuffetCharge buffet={tablePayment.buffet}/>}
          <div className="list-row">Còn phải thu <strong>{currency.format(tablePayment.due)}</strong></div>
          {tablePayment.status === 'PAID' && <p className="success" role="status">Bàn đã thanh toán.</p>}
          {tablePayment.status === 'VOID' && <p className="notice">Hóa đơn đã hủy.</p>}
          {!tablePayment.status && !tablePayment.requested && (tablePayment.buffet || orders.some(order => ['PLACED', 'ACCEPTED'].includes(order.status))) &&
            <button type="button" className="button" disabled={busy || !!cart.length} onClick={() => void pay(true)}>Yêu cầu tính tiền</button>}
          {!tablePayment.status && tablePayment.requested && <p className="notice">Đã yêu cầu tính tiền. Nhân viên sẽ kiểm món và chốt hóa đơn của bàn.</p>}
          {tablePayment.status === 'OPEN' && !tablePayment.qrAvailable && <p className="muted">Nhân viên sẽ thu tiền tại bàn.</p>}
          {tablePayment.qrAvailable && <button type="button" className="button" disabled={busy} onClick={() => void pay(false)}>Thanh toán QR cho bàn</button>}
          {tablePayment.qrAvailable && qr && !qr.paid && qr.billId === tablePayment.billId && (tablePayment.due !== qr.amount ?
            <p className="muted">Số tiền còn lại đã thay đổi. Bấm Thanh toán QR để lấy mã mới.</p> :
            Date.parse(qr.expiresAt) > now ? <>
            <img src={qr.qrUrl} alt="Mã VietQR thanh toán" width={220} height={220} referrerPolicy="no-referrer"/>
            <a className="plain" href={qr.qrUrl} target="_blank" rel="noreferrer">Mở ảnh QR để lưu</a>
            <dl><dt>Số tiền</dt><dd>{currency.format(qr.amount)}</dd>{qr.bankAccount.holder && <><dt>Chủ tài khoản</dt><dd>{qr.bankAccount.holder}</dd></>}
              <dt>Mã ngân hàng</dt><dd>{qr.bankAccount.bank}</dd><dt>Số tài khoản</dt><dd>{qr.bankAccount.account}</dd><dt>Nội dung</dt><dd>{qr.reference}</dd></dl>
            <small>Chờ nhà hàng xác nhận. QR hết hạn lúc {date(qr.expiresAt)}.</small>
          </> : <p className="muted">Mã QR đã hết hạn. Nếu đã chuyển khoản, hãy báo nhân viên kiểm tra.</p>)}
          {payment?.error && <p className="error" role="alert">{payment.error}</p>}
        </div>}
    </dialog>}
    {!!portions && <a className="button guest-cart-bar" href="#guest-cart"><ShoppingBag size={19}/> <span>Giỏ hàng · {portions} phần</span>{(!buffet || total > 0) && <strong>{currency.format(total)}</strong>}</a>}
    {selected && <DishDetails key={selected.id} product={selected} close={() => setSelectedId(undefined)} disabled={busy || !canOrder || cart.length >= 50} included={included}
      add={line => setCart(items => items.length < 50 ? [...items, line] : items)}/>}
  </div></main>;
}
