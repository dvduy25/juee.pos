'use client';

import { useLanguage } from '@/i18n/language';
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { Plus, Search, ShoppingBasket } from 'lucide-react';
import { api } from '@/services/api-client';
import { amount, currency, printReceipt, submit } from '@/lib/format';
import { Pager, Panel, State } from '@/components/business-ui';
import { BarcodeCamera } from '@/components/barcode-camera';
import { BusinessDialog } from '@/components/business-dialog';
import { useAction, useBusiness, useData } from '@/hooks/use-business';

import { foodVariantLabel, type Category, type Variant, type Product } from '@/types/catalog';
import { salePrice } from '@/lib/sale-price';
import { tableMenuHref, tableState, takeawayMenuHref, usesServiceCounter, usesTables, type BuffetSection, type DiningSession, type TableResponse } from '@/types/business';
import { TableOrders, TableService, TakeawayOrders } from './sales';
import { eligibleRetailOffers, RetailPromotionSelect, type RetailPricing } from './retail-promotions';
import { AutoPrintSwitch, printPaidReceipt } from './receipt-print';

type Cart = { product: string; productId: string; variant: Variant; quantity: number; buffetExtra?: boolean; modifierPrice: number; modifierIds: string[]; options: string; key: string };
export function Pos() {
  const { t } = useLanguage();
  return <Suspense fallback={<div className="skeleton" aria-label={t("Đang tải quầy bán hàng")}/>}><CounterRoute/></Suspense>;
}

function CounterRoute() {
  const { t } = useLanguage();
  const { branch, mode, role } = useBusiness();
  const params = useSearchParams();
  const table = params.get('table') ?? '';
  const session = params.get('session') ?? '';
  const takeaway = usesTables(branch.mode) && params.get('takeaway') === '1';
  const food = usesTables(mode) || (branch.mode === 'HYBRID' && (!!table || takeaway));
  const showOrders = params.get('orders') === '1';
  if (!food && role === 'WAITER') return <Link className="button" href="/dashboard/tables">{t("Chọn bàn để gọi món")}</Link>;
  return <Counter key={`${food}:${table}:${session}:${takeaway}:${showOrders}`} productType={food ? 'FOOD' : 'RETAIL'}
    initialTable={takeaway ? '' : table} expectedSession={session} takeaway={takeaway} openTakeawayOrders={showOrders}/>;
}

function Counter({ productType, initialTable, expectedSession, takeaway, openTakeawayOrders }: {
  productType: 'FOOD' | 'RETAIL'; initialTable: string; expectedSession: string; takeaway: boolean; openTakeawayOrders: boolean;
}) {
  const { t } = useLanguage();
  const { role, root, mode, staffMode } = useBusiness();
  const serviceCounter = usesServiceCounter(mode);
  const router = useRouter();
  const food = productType === 'FOOD';
  const atTable = food && !takeaway;
  const [q, setQ] = useState('');
  const [scanMessage, setScanMessage] = useState<{ text: string; values?: string[]; error: boolean }>();
  const scanning = useRef(0);
  const scanQueue = useRef(Promise.resolve());
  const [scanPending, setScanPending] = useState(false);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const menu = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const [canObserve, setCanObserve] = useState(true);
  const [cart, setCart] = useState<Cart[]>([]);
  const [showTakeawayOrders, setShowTakeawayOrders] = useState(openTakeawayOrders);
  const [dish, setDish] = useState<{ product: Product; variant: Variant }>();
  const [dishError, setDishError] = useState('');
  const [discount, setDiscount] = useState(0);
  const [promotionId, setPromotionId] = useState('');
  const [customer, setCustomer] = useState('');
  const [selectedTable, setSelectedTable] = useState({ id: productType === 'FOOD' ? initialTable : '', session: productType === 'FOOD' ? expectedSession : '' });
  const [packageId, setPackageId] = useState('');
  const [buffetSection, setBuffetSection] = useState<BuffetSection>('included');
  const tableId = selectedTable.id;
  const [receipt, setReceipt] = useState<{ order: { id: string; items: { id: string; name: string; quantity: number; unitPrice: number }[];
    totalAmount: number; discountAmount: number; taxAmount: number; promotionName?: string }; bill: { id: string; status: string } }>();
  const [printError, setPrintError] = useState(false);
  const action = useAction();
  const serviceChange = useAction();
  const categories = useData<Category[]>('/categories');
  const pricing = useData<RetailPricing>('/retail-pricing', 15000, !food);
  const customers = useData<{ id: string; name: string; phone: string }[]>('/customers', undefined, productType !== 'FOOD' && !staffMode);
  const tables = useData<TableResponse>('/tables', 6000, food);
  const takeaways = useData<DiningSession[]>('/takeaway-sessions', 6000, takeaway || (atTable && !!selectedTable.session));
  const table = tables.data?.tables.find(item => item.id === tableId);
  const tableSession = tables.data?.sessions.find(item => item.id === table?.sessionId);
  const pickup = takeaways.data?.find(item => item.id === selectedTable.session);
  const staleTable = atTable && !!selectedTable.session && selectedTable.session !== table?.sessionId;
  const staleTakeaway = takeaway && !!selectedTable.session && !pickup;
  const currentSession = takeaway ? pickup?.id : staleTable ? undefined : table?.sessionId;
  const viewedSession = takeaway || table ? currentSession ?? selectedTable.session : undefined;
  const activeService = takeaway ? pickup : currentSession ? tableSession : undefined;
  useEffect(() => {
    if (currentSession && !selectedTable.session) {
      setSelectedTable(previous => previous.id === tableId && !previous.session ? { ...previous, session: currentSession } : previous);
    }
  }, [currentSession, selectedTable.session, tableId]);
  const buffet = !!activeService?.buffet;
  const packages = tables.data?.buffetPackages ?? [];
  const selectedPackage = packages.find(pack => pack.id === packageId);
  const filters = `q=${encodeURIComponent(q)}${category ? `&categoryId=${category}` : ''}`;
  const menuPath = `/products?productType=FOOD&${filters}${currentSession ? `&tableSessionId=${currentSession}&buffetSection=${buffetSection}` : ''}`;
  const retailProducts = useData<Product[]>(`/products?productType=RETAIL&page=${page}&${filters}`, 10000, !food);
  const menuProducts = useInfiniteQuery({
    queryKey: ['business', root, menuPath, 'menu'],
    queryFn: ({ pageParam }) => api<Product[]>(`${root}${menuPath}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _pages, lastPageParam) => lastPage.length === 50 && lastPageParam < 10_000 ? lastPageParam + 1 : undefined,
    enabled: food && (takeaway || !!tables.data),
    refetchInterval: query => query.state.status === 'error' ? false : 5000 * (query.state.data?.pages.length || 1),
  });
  const menuItems = useMemo(() => menuProducts.data &&
    Array.from(new Map(menuProducts.data.pages.flatMap(items => items.map(item => [item.id, item] as const))).values()), [menuProducts.data]);
  const products = food ? menuItems : retailProducts.data;
  const productQuery = food ? menuProducts : retailProducts;
  const { fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError } = menuProducts;
  useEffect(() => {
    if (!more.current || !hasNextPage || isFetching || isFetchNextPageError) return;
    if (typeof IntersectionObserver === 'undefined') {
      setCanObserve(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void fetchNextPage({ cancelRefetch: false });
    });
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [menuPath, fetchNextPage, hasNextPage, isFetching, isFetchNextPageError]);
  const tableClosedForOrders = !!activeService?.checkoutBillId;
  const unsentItems = !!cart.length || !!dish || action.pending || serviceChange.pending || scanPending;
  const movedTable = staleTable || staleTakeaway ? tables.data?.tables.find(item => item.sessionId === selectedTable.session) : undefined;
  const movedHref = staleTable && pickup ? takeawayMenuHref(pickup.id) : movedTable ? tableMenuHref(movedTable) : undefined;
  useEffect(() => {
    if (movedHref && !unsentItems) router.replace(movedHref);
  }, [movedHref, unsentItems, router]);
  const canSelectItems = !action.pending && !serviceChange.pending && !tableClosedForOrders && !staleTakeaway && (!atTable || (!staleTable && !!table));
  const isIncluded = (id: string, extra?: boolean) => buffet && (activeService?.buffetProductIds ? activeService.buffetProductIds.includes(id) : !extra);
  const cartUnitPrice = (item: Cart) => salePrice(item.variant, isIncluded(item.productId, item.buffetExtra)) + item.modifierPrice;
  const subtotal = cart.reduce((total, line) => total + line.quantity * cartUnitPrice(line), 0);
  const offers = eligibleRetailOffers(pricing.data?.offers, cart.map(line => ({ ...line, unitPrice: cartUnitPrice(line) })), subtotal);
  const promotion = offers.find(offer => offer.id === promotionId);
  const validAmount = Number.isSafeInteger(subtotal) && Number.isSafeInteger(discount) && discount >= 0 && discount <= subtotal;
  const promotionError = !!promotionId && !promotion;
  const reduction = promotion?.reduction ?? discount;
  const tax = food || !validAmount ? 0 :
    Number((BigInt(subtotal - reduction) * BigInt(pricing.data?.taxBps ?? 0) + 5000n) / 10000n);
  const total = subtotal - reduction + tax;
  const canDiscount = ['OWNER', 'MANAGER'].includes(role);
  const canCheckout = cart.length > 0 && canSelectItems && (!atTable || !!currentSession) &&
    !scanPending && validAmount && Number.isSafeInteger(total) && (food || (!!pricing.data && !pricing.error && !promotionError));

  async function selectService(id: string) {
    if (unsentItems) return;
    if (id === 'takeaway') {
      if (!currentSession) { router.push(takeawayMenuHref()); return; }
      const result = await serviceChange.send<{ id: string }>('/service-mode', { mode: 'TAKEAWAY', tableId, sessionId: currentSession }, { idempotent: true });
      if (result) router.replace(takeawayMenuHref(result.id));
      return;
    }
    const target = tables.data?.tables.find(item => item.id === id);
    if (!target) { router.push('/dashboard/pos'); return; }
    if (takeaway && currentSession) {
      const result = await serviceChange.send<{ id: string }>('/service-mode', { mode: 'TABLE', tableId: target.id, sessionId: currentSession }, { idempotent: true });
      if (result) router.replace(tableMenuHref({ ...target, sessionId: result.id }));
    } else router.push(tableMenuHref(target));
  }
  function resetResults() {
    setPage(1);
    menu.current?.scrollTo({ top: 0 });
  }
  function chooseBuffetSection(section: BuffetSection) {
    if (section === buffetSection) return;
    setBuffetSection(section);
    setCategory('');
    setDish(undefined);
    resetResults();
  }
  function add(product: Product, variant: Variant, modifierIds: string[] = []) {
    if (takeaway) setShowTakeawayOrders(false);
    const options = (product.modifierGroups ?? []).flatMap(group => group.options.filter(option => modifierIds.includes(option.id)));
    const key = JSON.stringify([variant.id, [...modifierIds].sort()]);
    const modifierPrice = options.reduce((sum, option) => sum + option.additionalPrice, 0);
    setCart(items => items.some(item => item.key === key)
      ? items.map(item => item.key === key ? { ...item, quantity: Math.min(1000, item.quantity + 1) } : item)
      : [...items, { product: product.name, productId: product.id, variant, quantity: 1, buffetExtra: product.buffetExtra, modifierPrice,
        modifierIds, options: options.map(option => option.name).join(', '), key }]);
  }
  function choose(product: Product, variant: Variant) {
    if (productType === 'FOOD' && product.modifierGroups?.length) {
      setDishError(''); setDish({ product, variant });
    } else add(product, variant);
  }
  function scan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem('scan');
    if (!(field instanceof HTMLInputElement) || !canSelectItems) return;
    const code = field.value.trim();
    if (!code || code.length > 80) return;
    event.currentTarget.reset();
    queueScan(code);
  }
  function queueScan(code: string) {
    if (!canSelectItems) return;
    setScanMessage(undefined);
    scanning.current++;
    setScanPending(true);
    scanQueue.current = scanQueue.current.then(async () => {
      try {
        const [product] = await api<Product[]>(`${root}/products?productType=${productType}&code=${encodeURIComponent(code)}`);
        const variant = product?.variants.find(item => item.barcode === code) ?? product?.variants.find(item => item.sku === code.toUpperCase());
        if (product && variant && variant.paused) {
          setScanMessage({ text: "{0} · {1} đang tạm ngừng bán.", values: [product.name, variant.sku], error: true });
        } else if (product && variant) {
          choose(product, variant);
          setScanMessage({ text: "Đã thêm {0} · {1}.", values: [product.name, variant.sku], error: false });
        } else setScanMessage({ text: "Không tìm thấy sản phẩm đang bán có mã {0}.", values: [code], error: true });
      } catch (cause) {
        setScanMessage({ text: cause instanceof Error ? cause.message : 'Không thể tra mã vạch.', error: true });
      } finally {
        scanning.current--;
        if (!scanning.current) setScanPending(false);
      }
    });
  }
  async function checkout(cash: boolean) {
    if (!canCheckout || scanning.current) return;
    const payload = { items: cart.map(item => ({ variantId: item.variant.id, quantity: item.quantity, modifierIds: item.modifierIds })), productType,
      tableId: atTable ? tableId : undefined, tableSessionId: currentSession, serviceMode: takeaway ? 'TAKEAWAY' : undefined,
      discountAmount: discount, customerId: customer || undefined,
      promotionId: food ? undefined : promotion?.id, expectedTotal: atTable ? undefined : total };
    const result = cash
      ? await action.send<NonNullable<typeof receipt>>('/checkout', { ...payload, method: 'CASH' }, { idempotent: true, message: 'Đã thu tiền mặt.' })
      : await action.send<{ id: string; tableSessionId?: string }>('/orders', payload, { idempotent: true, message: takeaway ? 'Đã gửi món mang về.' :
        atTable ? `Đã thêm món vào ${table?.name} và chuyển bếp.` : 'Đã tạo đơn chờ thanh toán. Mở Đơn hàng để lập hóa đơn.' });
    if (result) {
      setCart([]); setDiscount(0); setCustomer(''); setPromotionId('');
      if ('bill' in result) {
        setPrintError(false);
        flushSync(() => setReceipt(result));
        if (result.bill.status === 'PAID') {
          void printPaidReceipt(root, result.bill.id, printReceipt).catch(() => setPrintError(true));
        }
      }
      if (takeaway && !currentSession && 'id' in result && result.tableSessionId) router.replace(takeawayMenuHref(result.tableSessionId));
    } else if (!food) void pricing.refetch();
  }
  const quantity = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartLink = <a className="plain pos-cart-link" href={atTable || viewedSession ? '#table-order-pane' : '#pos-current-cart'}
    onClick={takeaway ? () => setShowTakeawayOrders(false) : undefined}>
    <ShoppingBasket size={17} aria-hidden="true"/> {atTable ? t("Món tại bàn") : takeaway ? t("Món mang về") : t("Giỏ hàng")} ({quantity})
  </a>;
  const categorySelect = <select aria-label={t("Danh mục")} value={category} onChange={event => { setCategory(event.target.value); resetResults(); }}>
    <option value="">{food ? t("Mọi danh mục") : t("Tất cả")}</option>
    {categories.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
  </select>;
  const toolbar = <div className="menu-toolbar">
    {buffet && <div className="menu-buffet-switch" role="group" aria-label={t("Thực đơn buffet")}>
      <button className="plain" type="button" aria-pressed={buffetSection === 'included'} onClick={() => chooseBuffetSection('included')}>{t("Trong gói")}</button>
      <button className="plain" type="button" aria-pressed={buffetSection === 'extra'} onClick={() => chooseBuffetSection('extra')}>{t("Gọi thêm (+ phí)")}</button>
    </div>}
    <div className="menu-filters">
      <label className="menu-search"><Search size={15} aria-hidden="true"/><input type="search"
        aria-label={food ? t("Tìm món") : t("Tìm sản phẩm")} placeholder={food ? t("Tìm món") : t("Tìm sản phẩm")}
        value={q} onChange={event => { setQ(event.target.value); resetResults(); }} maxLength={100} autoComplete="off"/></label>
      {categorySelect}
    </div>
    {cartLink}
  </div>;
  const catalog = <Panel className="pos-catalog no-print" title={food ? t("Thực đơn") : t("Chọn sản phẩm")} action={toolbar}>
    {atTable && !initialTable && !table && <p className="muted">{t("Chọn bàn hoặc Mang về để bắt đầu gọi món.")}</p>}
    {productType === 'RETAIL' && <form onSubmit={scan}><div className="actions scan-controls"><label>{t("Quét mã vạch hoặc SKU")}<input name="scan" maxLength={80} autoComplete="off"
      disabled={!canSelectItems} placeholder={t("Đặt con trỏ ở đây rồi quét")} required/></label>
      <button className="button" disabled={!canSelectItems}>{t("Thêm vào giỏ")}</button>
      <BarcodeCamera onRead={queueScan} disabled={!canSelectItems}/></div></form>}
    {scanMessage && <p className={scanMessage.error ? 'error' : 'success'} role={scanMessage.error ? 'alert' : 'status'}>{t(scanMessage.text, ...scanMessage.values ?? [])}</p>}
    <State query={food && isFetchNextPageError ? { isLoading: false, error: null } : productQuery} empty={products?.length === 0}/>
    {serviceCounter && productQuery.isSuccess && products?.length === 0 && !q && !category && (role === 'OWNER' || role === 'MANAGER') &&
      <Link className="plain" href="/dashboard/company?tab=products">{t("Đăng bán hàng từ kho")}</Link>}
    {dish && <BusinessDialog key={dish.variant.id} title={`${dish.product.name}${dish.variant.attributes?.size ? ` · ${dish.variant.attributes.size}` : ''}`}
      close={() => setDish(undefined)} closeLabel="Hủy">
    <form onSubmit={event => submit(event, form => {
      if (!canSelectItems) return;
      const selected = form.getAll('modifier').map(String);
      for (const group of dish.product.modifierGroups) {
        const count = group.options.filter(option => selected.includes(option.id)).length;
        if (count < group.minSelect || count > group.maxSelect) { setDishError(t("Hãy chọn từ {0} đến {1} mục ở {2}.", group.minSelect, group.maxSelect, group.name)); return; }
      }
      add(dish.product, dish.variant, selected); setDish(undefined);
    })}>
      {dish.product.modifierGroups.map(group => <fieldset key={group.id}><legend>{group.name} · {group.minSelect}–{group.maxSelect}</legend>
        {group.options.map(option => <label className="check" key={option.id}><input name="modifier" type="checkbox" value={option.id}/>
          {option.name}{option.additionalPrice > 0 && ` + ${currency.format(option.additionalPrice)}`}</label>)}</fieldset>)}
      {dishError && <p className="error" role="alert">{t(dishError)}</p>}
      <button className="button" disabled={!canSelectItems}>{t("Thêm món")}</button>
    </form></BusinessDialog>}
    <div className="product-grid">{products?.map(item => <article className="product-tile" key={item.id}>
      {item.images[0] && <img src={item.images[0]} alt="" loading="lazy"/>}<strong>{item.name}</strong>
      {item.variants.map((variant, index) => <button type="button" className="plain" disabled={!canSelectItems || variant.paused} key={variant.id} onClick={() => choose(item, variant)}>
        <span>{productType === 'FOOD' ? foodVariantLabel(variant, index) : [variant.sku, variant.attributes?.size, variant.attributes?.color].filter(Boolean).join(' ')}</span>
        <strong>{isIncluded(item.id, item.buffetExtra) ? t("Trong gói buffet") : currency.format(salePrice(variant))}</strong>
        {!variant.paused && <Plus size={19} aria-hidden="true"/>}
        {variant.paused && <small>{productType === 'FOOD' ? t("Hết món") : item.stock !== undefined && item.stock < 1000 ? t("Hết hàng") : t("Tạm ngừng bán")}</small>}</button>)}
    </article>)}</div>
    {food ? hasNextPage && <div className="menu-load-more" ref={more}>
      {isFetchingNextPage && <small role="status">{t("Đang tải thêm món…")}</small>}
      {isFetchNextPageError && <p className="error" role="alert">{t("Chưa tải được các món tiếp theo.")}</p>}
      {(!canObserve || isFetchNextPageError) && <button className="plain" type="button" disabled={isFetching}
        onClick={() => void fetchNextPage({ cancelRefetch: false })}>{isFetchNextPageError ? t("Thử lại") : t("Tải thêm món")}</button>}
    </div> : <Pager page={page} full={products?.length === 50} onChange={next => {
      setPage(next);
      menu.current?.scrollTo({ top: 0 });
    }}/>}
  </Panel>;

  const cartPanel = <Panel id={takeaway ? undefined : 'pos-current-cart'} className="pos-cart no-print" title={food ? t("Món đang chọn") : t("Giỏ hàng")}>
    {atTable && <><State query={tables}/>
      {initialTable && tables.isSuccess && !table && <p className="error">{t("Bàn này không có ở chi nhánh đang chọn.")}</p>}
      {!initialTable && tables.isSuccess && !tables.data.tables.length && <p className="muted">{t("Chi nhánh chưa có bàn để nhận đơn.")}</p>}
      {staleTable && tables.data && <p className="notice">
        {table?.sessionId ? t("Bàn đã có lượt phục vụ khác. Về sơ đồ bàn để mở lượt hiện tại.") : t("Lượt này đã kết thúc. Mở Món đã gọi để xem hóa đơn.")}
      </p>}
      {tableClosedForOrders && <p className="notice">{t("Bàn đã chốt hóa đơn.")}</p>}
      {table && !table.sessionId && !staleTable && <form onSubmit={event => submit(event, form => {
        if (packageId && !selectedPackage) return;
        const buffet = selectedPackage ? { packageId: selectedPackage.id, adults: amount(form, 'adults'), children: amount(form, 'children') } : undefined;
        void action.send<{ id: string }>('/table-sessions', { tableId, buffet }, { message: 'Đã mở lượt phục vụ.' }).then(result => {
          if (result) { setSelectedTable({ id: tableId, session: result.id }); setBuffetSection('included'); resetResults(); }
        });
      })}>
        {(packages.length > 0 || packageId) && <label>{t("Hình thức phục vụ")}<select value={packageId} onChange={event => setPackageId(event.target.value)}>
          <option value="">{t("Gọi món theo giá thực đơn")}</option>
          {packageId && !selectedPackage && <option value={packageId} disabled>{t("Gói đã ngừng dùng")}</option>}
          {packages.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
        </select></label>}
        {selectedPackage && <div className="form-grid form-grid-business">
          <label>{t("Người lớn ·")} {currency.format(selectedPackage.adultPrice)}{t("/khách")}<input name="adults" type="number" min={0} max={1000} defaultValue={table.reservation?.guests ?? 1} required/></label>
          <label>{t("Trẻ em ·")} {currency.format(selectedPackage.childPrice)}{t("/khách")}<input name="children" type="number" min={0} max={1000} defaultValue={0} required/></label>
        </div>}
        <button className="button" disabled={action.pending || scanPending || (!!packageId && !selectedPackage)}>{table.reserved ? t("Đón khách đặt trước") : t("Mở lượt phục vụ")}</button>
      </form>}</>}
    <div className="pos-cart-items">
    {cart.length === 0 && <p className="muted">{productType === 'FOOD' ? t("Chọn món từ thực đơn để bắt đầu.") : t("Chọn sản phẩm để bắt đầu.")}</p>}
      {cart.map(item => <div className="list-row" key={item.key}><div><strong>{item.product}</strong>
        <small>{productType === 'RETAIL' && `${item.variant.sku} · `}{isIncluded(item.productId, item.buffetExtra) && cartUnitPrice(item) === 0 ? t("Trong gói buffet") : currency.format(cartUnitPrice(item))}</small>{item.options && <small>{item.options}</small>}</div><div className="actions">
        <input className="quantity" type="number" min="1" max="1000" aria-label={t("Số lượng {0}", productType === 'FOOD' ? item.product : item.variant.sku)} value={item.quantity}
          disabled={action.pending} onChange={event => setCart(items => items.map(line => line === item
            ? { ...line, quantity: Math.max(1, Math.min(1000, Math.floor(Number(event.target.value)))) } : line))}/>
        <button className="plain" disabled={action.pending} onClick={() => setCart(items => items.filter(line => line !== item))}>{t("Bỏ")}</button>
      </div></div>)}
    </div>
    {productType !== 'FOOD' && !staffMode && <label>{t("Khách hàng")}<select value={customer} onChange={event => setCustomer(event.target.value)}><option value="">{t("Khách lẻ")}</option>
      {customers.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.phone}</option>)}</select></label>}
    {!food && canDiscount && <label>{t("Giảm giá (đ)")}<input value={discount} onChange={event => setDiscount(Number(event.target.value))}
      type="number" min="0" max={subtotal} step="1" disabled={action.pending || !!promotionId}/></label>}
    {!food && <>
      <RetailPromotionSelect offers={offers} selected={promotionId} disabled={action.pending || !pricing.data}
        onChange={id => { setPromotionId(id); if (id) setDiscount(0); }}/>
      <State query={pricing}/>
      {promotionError && <p className="error" role="alert">{t("Ưu đãi đã chọn không còn áp dụng cho giỏ hàng. Hãy chọn lại.")}</p>}
      {!!reduction && <div className="list-row"><span>{promotion?.name ?? 'Giảm giá'}</span><strong>−{currency.format(reduction)}</strong></div>}
      {!!tax && <div className="list-row"><span>{t("Thuế")}</span><strong>{currency.format(tax)}</strong></div>}
    </>}
    {(!buffet || subtotal > 0) && <div className="list-row pos-total"><strong>{buffet ? t("Tạm tính phụ thu") : atTable ? t("Tạm tính món đang chọn") : t("Tổng tiền")}</strong><strong>{currency.format(total)}</strong></div>}
    {food ? <div className="actions business-filters">
      <button className="button" disabled={!canCheckout} onClick={() => void checkout(false)}>{takeaway ? t("Gửi đơn mang về") : t("Gửi món vào bàn")}</button>
      {atTable && !table && <Link className="plain" href="/dashboard/tables">{t("Về sơ đồ bàn")}</Link>}
    </div> : <form onSubmit={event => submit(event, () => {
      const button = (event.nativeEvent as SubmitEvent).submitter;
      void checkout(button?.getAttribute('value') !== 'pending');
    })}>
      <AutoPrintSwitch/>
      <div className="actions business-filters"><button className="button" disabled={!canCheckout}
        value="cash">{t("Thu tiền mặt")}</button>
        <button className="plain" disabled={!canCheckout} value="pending">{t("Tạo đơn chờ thanh toán")}</button></div>
    </form>}
    {action.feedback}{productType !== 'FOOD' && <Link className="plain" href="/dashboard/orders">{serviceCounter ? t("Mở đơn bán hàng") : t("Mở đơn hàng")}</Link>}
  </Panel>;

  const servicePicker = food && <section className="card table-service service-mode-picker no-print" aria-label={t("Hình thức phục vụ")}>
    <label>{t("Phục vụ")}<select value={takeaway ? 'takeaway' : tableId} disabled={unsentItems}
      onChange={event => void selectService(event.target.value)}>
      <option value="" disabled={!!currentSession}>{t("Chọn bàn")}</option>
      <option value="takeaway" disabled={atTable && tableClosedForOrders}>{t("Mang về")}</option>
      {tables.data?.tables.map(item => <option key={item.id} value={item.id}
        disabled={takeaway && !!currentSession && (tableClosedForOrders || !!item.sessionId || !!item.reserved)}>
        {item.name} · {t(tableState(item, tables.data.sessions.find(service => service.id === item.sessionId)).label)}</option>)}
    </select></label>
    {takeaway && viewedSession && <Link className="plain" href={takeawayMenuHref(undefined, true)}>{t("Đơn mang về")}</Link>}
    {takeaway && currentSession && <span className="badge">{tableClosedForOrders ? t("Chờ thanh toán") : t("Đơn mang về đang mở")}</span>}
    {serviceChange.feedback}
  </section>;

  if (atTable || (takeaway && viewedSession)) return <div className="counter-workspace food-counter">
    {servicePicker}
    {table && <TableService key={table.id} table={table} service={currentSession ? tableSession : undefined} tables={tables.data?.tables ?? []}
      currentSession={currentSession} unsentItems={unsentItems} onClose={() => router.replace('/dashboard/tables')}/>}
    <div className="columns pos-desk">
      <div ref={menu} className="order-menu" role="region" aria-label={t("Thực đơn gọi món")} tabIndex={0}>{catalog}</div>
      <TableOrders key={`${tableId}:${viewedSession}`} session={viewedSession || undefined} unsentItems={unsentItems}
        initiallyOpen={takeaway || !!activeService?.checkoutBillId || (!!viewedSession && staleTable)} takeaway={takeaway}
        service={activeService} quantity={quantity}>{cartPanel}</TableOrders>
    </div>
  </div>;

  if (takeaway) return <div className="counter-workspace food-counter">
    {servicePicker}
    <div className="columns pos-desk">
      <div ref={menu} className="order-menu" role="region" aria-label={t("Thực đơn mang về")} tabIndex={0}>{catalog}</div>
      <div className="pos-counter-side" id="pos-current-cart">
        <div className="table-order-tabs card no-print" role="group" aria-label={t("Đơn mang về")}>
          <button type="button" className="plain" aria-pressed={!showTakeawayOrders} onClick={() => setShowTakeawayOrders(false)}>
            {t("Đơn mới")} {quantity > 0 && <span className="table-order-count">{quantity}</span>}
          </button>
          <button type="button" className="plain" aria-pressed={showTakeawayOrders}
            onClick={() => setShowTakeawayOrders(true)}>{t("Đơn đã gửi")}</button>
        </div>
        {showTakeawayOrders ? <TakeawayOrders sessions={takeaways.data ?? []} tables={tables.data?.tables ?? []}/> : cartPanel}
      </div>
    </div>
  </div>;

  return <div className="counter-workspace">
    <div className="columns pos-desk">
      <div ref={menu} className="order-menu" role="region" aria-label={t("Danh sách sản phẩm")} tabIndex={0}>{catalog}</div>
      <div className="pos-counter-side">{cartPanel}
        {receipt && <Panel title={t("Hóa đơn vừa thanh toán")} className="print-receipt">
          <p>{t("Mã hóa đơn")} {receipt.bill.id}</p>
          {receipt.order.items.map(item => <div className="list-row" key={item.id}>{item.name} × {item.quantity} <strong>{currency.format(item.quantity * item.unitPrice)}</strong></div>)}
          {!!receipt.order.discountAmount && <p>{receipt.order.promotionName ?? 'Giảm giá'} · {currency.format(receipt.order.discountAmount)}</p>}
          {!!receipt.order.taxAmount && <p>{t("Thuế")} {currency.format(receipt.order.taxAmount)}</p>}
          <strong>{t("Tổng tiền")} {currency.format(receipt.order.totalAmount)}</strong>
          <button className="button no-print" onClick={() => void printReceipt()}>{t("In hóa đơn")}</button>
          {printError && <p className="error no-print" role="alert">{t("Không mở được trình in. Bấm In hóa đơn để thử lại.")}</p>}
        </Panel>}
      </div>
    </div>
  </div>;
}
