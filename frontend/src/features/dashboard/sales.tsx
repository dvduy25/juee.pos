'use client';

import { useLanguage } from '@/i18n/language';
import { Suspense, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { createPortal, flushSync } from 'react-dom';
import { Armchair, ArrowUpRight, Check, CheckCheck, ChefHat, ChevronDown, CircleAlert, ClipboardList, Clock, CookingPot, History, Pencil, Printer, ReceiptText, ShoppingBag, StickyNote, Users } from 'lucide-react';
import { eventStream } from '@/services/api-client';
import Link from 'next/link';
import { amount, currency, date, printReceipt, submit, value } from '@/lib/format';
import { BuffetCharge } from '@/components/buffet-charge';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State, StatusFilters } from '@/components/business-ui';
import { CsvExport } from '@/components/report-period';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { tableMenuHref, tableState, takeawayMenuHref, usesTables, type Buffet, type DiningSession, type DiningTable, type KitchenSummary, type TableResponse } from '@/types/business';
import { elapsedTime, isWaitingForService, itemTiming, useOrderClock, type Preparation } from '@/lib/order-timing';
import { RetailOrderEditor, type RetailOrderForEdit } from './retail-order-editor';
import { AutoPrintSwitch, printPaidReceipt } from './receipt-print';
import { sectionTitle } from './navigation';

const orderStatus: Record<string, string> = { PLACED: 'Chờ xác nhận', ACCEPTED: 'Đã nhận', COMPLETED: 'Đã thanh toán', CANCELED: 'Đã hủy' };
const billStatus: Record<string, string> = { OPEN: 'Chờ thu tiền', PAID: 'Đã thanh toán', VOID: 'Đã hủy', REFUNDED: 'Đã hoàn tiền' };
type Line = RetailOrderForEdit['items'][number] & { note?: string; cancelReason?: string; modifiers: { name: string }[]; buffetIncluded?: boolean;
  warehouseItemId?: string; returnedQuantity?: number };
type Order = Omit<RetailOrderForEdit, 'items'> & { tableName?: string; tableSessionId?: string; takeaway?: boolean; cancelReason?: string; source: string;
  status: string; items: Line[]; kitchen?: Preparation[]; retailEditable?: boolean; promotionName?: string };
type Bill = { id: string; orderIds: string[]; totalAmount: number; paidAmount: number; status: string; createdAt: string;
  tableSessionId?: string; tableSessionClosed?: boolean; takeaway?: boolean; retail?: boolean; discountCode?: string;
  discountAmount?: number; promotionName?: string; taxAmount?: number; buffet?: Buffet };
type TableCart = { orders: Order[]; bills: Bill[]; due: number; subtotal: number; revision: string; pending: number; unservedQuantity: number;
  status: 'OPEN' | 'CLOSED'; takeaway?: boolean; guestCount?: number; checkoutBillId?: string; buffet?: Buffet };
type Payment = { id: string; method: string; amount: number; refundedAmount: number; paidAt: string; reference?: string };
type Intent = { id: string; qrUrl: string; reference: string; amount: number; expiresAt: string; bankAccount: { holder: string; account: string } };
type ActiveTransfer = Pick<Intent, 'id' | 'reference' | 'amount' | 'expiresAt'>;
type TableQr = { url: string; image: string };
const shortId = (id: string) => id.slice(-8).toUpperCase();

export function Orders({ management = false, onViewBill }: { management?: boolean; onViewBill?: (id: string) => void }) {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const { role, mode, branch } = useBusiness();
  const [source, setSource] = useState(management || usesTables(mode) ? '' : 'POS');
  const [editing, setEditing] = useState<Order>();
  const [saved, setSaved] = useState('');
  const action = useAction();
  const orders = useData<Order[]>(`/orders?page=${page}${status ? `&status=${status}` : ''}${source ? `&source=${source}` : ''}${management ? '&view=management' : ''}`, 8000);
  const collect = !management && ['OWNER', 'MANAGER', 'CASHIER'].includes(role);
  return <Panel title={t("Danh sách đơn hàng")}><div className="actions business-filters">
    <label>{t("Nguồn đơn")}<select value={source} onChange={event => {
      setSource(event.target.value); setPage(1);
    }}><option value="">{t("Tất cả")}</option><option value="POS">{t("Tại quầy")}</option>
      {usesTables(branch.mode) && <option value="QR">{t("Gọi món QR")}</option>}</select></label>
    <label>{t("Trạng thái")}<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
    <option value="">{t("Tất cả")}</option>{Object.entries(orderStatus).map(([key, title]) => <option key={key} value={key}>{t(title)}</option>)}</select></label></div>
    <State query={orders} empty={orders.data?.length === 0}/>
    {saved && <p className="success" role="status">{saved}</p>}
    {orders.data?.map(order => <details className="business-details" key={order.id}><summary>
      <strong>{order.takeaway ? t("Mang về") : order.tableName || (order.source === 'POS' ? 'Tại quầy' : 'QR')} · {shortId(order.id)}</strong>
      <span className="badge">{t(orderStatus[order.status])}</span> <strong>{currency.format(order.totalAmount)}</strong>
    </summary><p className="muted">{date(order.createdAt)}</p>
      {order.cancelReason && <p className="muted">{t("Lý do hủy ·")} {order.cancelReason}</p>}
      {order.promotionName && <p className="muted">{t("Khuyến mãi")} {order.promotionName}</p>}
      <OrderLines items={order.items}/>
      {!management && <div className="actions business-filters">
        <AcceptOrder order={order} action={action}/>
        {order.tableSessionId && ['PLACED', 'ACCEPTED'].includes(order.status) && role !== 'ACCOUNTANT' &&
          <Link className="plain" href={order.takeaway ? takeawayMenuHref(order.tableSessionId) : `/dashboard/tables?session=${order.tableSessionId}`}>
            {order.takeaway ? t("Mở đơn mang về") : t("Mở bàn")}</Link>}
        {collect && !order.tableSessionId && order.status === 'ACCEPTED' && !order.billId && <button className="button" disabled={action.pending}
          onClick={() => void action.send('/bills', { orderIds: [order.id] }, { idempotent: true, message: 'Đã lập hóa đơn. Mở Thanh toán để thu tiền.' })}>{t("Lập hóa đơn")}</button>}
        {collect && order.billId && !order.tableSessionId && <Link className="plain" href="/dashboard/payments">{t("Mở thanh toán")}</Link>}
      </div>}
      {management && <div className="actions business-filters">
        {order.retailEditable && <button className="plain" type="button" disabled={action.pending} onClick={() => { setSaved(''); setEditing(order); }}>
          <Pencil size={16} aria-hidden="true"/> {t("Sửa đơn hàng")}
        </button>}
        <CancelOrder order={order} action={action}/>
        {order.billId && onViewBill && <button className="plain" type="button" onClick={() => onViewBill(order.billId!)}>{t("Xem hóa đơn")}</button>}
      </div>}
    </details>)}
    {editing && <RetailOrderEditor key={editing.id} order={editing} onClose={() => setEditing(undefined)} onSaved={total => {
      setSaved(t("Đã sửa đơn {0}. Tổng mới {1}.", shortId(editing.id), currency.format(total))); setEditing(undefined);
    }}/>}
    {action.feedback}<Pager page={page} full={orders.data?.length === 50} onChange={setPage}/>
  </Panel>;
}

function takeawayStatus(order: Order, allServed: boolean) {
  if (order.status === 'ACCEPTED') return order.billId ? 'Chờ thanh toán' : allServed ? 'Đã ra đủ món' : 'Chờ ra món';
  return orderStatus[order.status];
}

function takeawayServed(order: Order) {
  const served = new Set(order.kitchen?.filter(item => item.status === 'SERVED').map(item => item.orderItemId));
  return order.items.every(item => item.cancelReason || served.has(item.id));
}

export function TakeawayOrders({ sessions, tables }: { sessions: DiningSession[]; tables: DiningTable[] }) {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string>();
  const query = useData<Order[]>(`/orders?takeaway=true&standalone=true&page=${page}`, 4000);
  const action = useAction();
  const invoice = useRef<HTMLDivElement>(null);
  const order = query.data?.find(item => item.id === selected);
  const now = useOrderClock(!!order);
  const collect = ['OWNER', 'MANAGER', 'CASHIER'].includes(role);

  if (order) {
    const allServed = takeawayServed(order);
    const available = tables.filter(table => !table.sessionId && !table.reserved);
    return <><Panel title={t("Đơn #{0}", shortId(order.id))} className="no-print"
      action={<button className="plain" type="button" onClick={() => setSelected(undefined)}>{t("Về danh sách")}</button>}>
      <div className="list-row"><small>{date(order.createdAt)}</small><span className="badge">{takeawayStatus(order, allServed)}</span></div>
      <OrderLines items={order.items} order={order} now={now} serve={action} cancel={action}/>
      {order.cancelReason && <p className="muted">{t("Lý do hủy ·")} {order.cancelReason}</p>}
      <CancelOrder order={order} action={action}/>
      {order.status === 'ACCEPTED' && !order.billId && available.length > 0 && <form onSubmit={event => submit(event, async form => {
        const table = available.find(item => item.id === value(form, 'table'));
        if (!table) return;
        const result = await action.send<{ id: string }>('/service-mode', { mode: 'TABLE', tableId: table.id, orderId: order.id }, { idempotent: true });
        if (result) router.replace(tableMenuHref({ ...table, sessionId: result.id }));
      })}>
        <label>{t("Bàn trống")}<select name="table" defaultValue="" required><option value="" disabled>{t("Chọn bàn")}</option>
          {available.map(table => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label>
        <button className="plain" disabled={action.pending}>{t("Chuyển sang bàn")}</button>
      </form>}
      <div className="list-row pos-total"><strong>{t("Tổng tiền")}</strong><strong>{currency.format(order.totalAmount)}</strong></div>
      {collect && order.status === 'ACCEPTED' && !order.billId && <>
        {!allServed && <p className="muted">{t("Xác nhận đã ra đủ món để chốt hóa đơn.")}</p>}
        <button type="button" className="button" disabled={!allServed || action.pending} onClick={async () => {
          const bill = await action.send('/bills', { orderIds: [order.id] }, { idempotent: true, message: 'Đã chốt hóa đơn mang về.' });
          if (bill) window.requestAnimationFrame(() => invoice.current?.scrollIntoView({ block: 'start' }));
        }}>{t("Chốt hóa đơn")}</button>
      </>}
      {action.feedback}
    </Panel>
    {collect && order.billId && <div ref={invoice}><BillDetail key={order.billId} id={order.billId}/></div>}
    </>;
  }

  return <section className="card business-panel no-print" aria-label={t("Danh sách đơn mang về")}>
    {sessions.map(session => <Link className="plain takeaway-order-choice" key={session.id} href={takeawayMenuHref(session.id)}>
      <span><strong>#{shortId(session.id)}</strong>{session.createdAt && <small>{date(session.createdAt)}</small>}</span>
      <small>{session.checkoutBillId ? t("Chờ thanh toán") : t("Đang phục vụ")}</small>
    </Link>)}
    <State query={query}/>
    {query.data?.length === 0 && sessions.length === 0 && <p className="muted">{t("Chưa có đơn mang về.")}</p>}
    {query.data?.map(item => <button className="plain takeaway-order-choice" type="button" key={item.id} onClick={() => setSelected(item.id)}>
      <span><strong>#{shortId(item.id)}</strong><small>{date(item.createdAt)}</small></span>
      <span><strong>{currency.format(item.totalAmount)}</strong><small>{takeawayStatus(item, takeawayServed(item))}</small></span>
    </button>)}
    {(page > 1 || query.data?.length === 50) && <Pager page={page} full={query.data?.length === 50} onChange={next => {
      setSelected(undefined); setPage(next);
    }}/>}
  </section>;
}

function OrderLines({ items, order, now, serve, cancel }: {
  items: Line[]; order?: Order; now?: number; serve?: ReturnType<typeof useAction>; cancel?: ReturnType<typeof useAction>;
}) {
  const { language, t } = useLanguage();
  return items.map(line => {
    const preparation = order?.kitchen?.find(item => item.orderItemId === line.id);
    const status = line.cancelReason ? 'CANCELED' : preparation?.status ?? order?.status ?? '';
    const timing = order && itemTiming(order.createdAt, status, preparation?.servedAt, now ?? 0, language);
    return <div className="list-row" data-canceled={status === 'CANCELED'} key={line.id}><div>{line.name} × {line.quantity}
    {line.buffetIncluded && <small>{t("Trong gói buffet")}</small>}
    {line.modifiers.length > 0 && <small>{line.modifiers.map(item => item.name).join(', ')}</small>}{line.note && <small>{line.note}</small>}</div>
    <div>{status === 'CANCELED' ? <><span className="badge warning">{t("Đã hủy")}</span>{line.cancelReason && <small>{line.cancelReason}</small>}</> :
      <>{(!line.buffetIncluded || line.unitPrice > 0) && <strong>{currency.format(line.quantity * line.unitPrice)}</strong>}{timing && <small>{timing}</small>}</>}
      {preparation && isWaitingForService(status) && serve && <button type="button" className="button" disabled={serve.pending}
        onClick={() => void serve.send(`/kitchen/items/${preparation.id}/transition`, { status: 'SERVED' }, { message: 'Đã xác nhận ra món.' })}>{t("Xác nhận đã ra món")}</button>}
      {order && cancel && <CancelOrder order={order} line={line} action={cancel}/>}</div></div>;
  });
}

function AcceptOrder({ order, action }: { order: Order; action: ReturnType<typeof useAction> }) {
  const { t } = useLanguage();
  const { role } = useBusiness();
  if (order.status !== 'PLACED' || role === 'ACCOUNTANT') return null;
  return <button className="button" disabled={action.pending}
    onClick={() => void action.send(`/orders/${order.id}/accept`, undefined, { message: 'Đã nhận món và chuyển bếp.' })}>{t("Nhận món")}</button>;
}

function CancelOrder({ order, line, action }: { order: Order; line?: Line; action: ReturnType<typeof useAction> }) {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const [open, setOpen] = useState(false);
  if (!['OWNER', 'MANAGER'].includes(role) || !['PLACED', 'ACCEPTED'].includes(order.status) ||
    (order.billId && order.retailEditable !== true) || line?.cancelReason) return null;
  const label = line ? t("Hủy món") : order.tableSessionId ? t("Hủy đợt gọi món") : t("Hủy đơn hàng");
  return <><button className="plain order-cancel-button" type="button" disabled={action.pending} onClick={() => setOpen(true)}>{t(label)}</button>
    {open && <BusinessDialog title={line ? t("Hủy {0}", line.name) : label} close={() => setOpen(false)} pending={action.pending}>
      {order.retailEditable && <p className="muted">{t("Hàng đã xuất sẽ được trả về kho.")}{order.billId && ' Hóa đơn sẽ được hủy cùng đơn.'}</p>}
      <form onSubmit={event => submit(event, async (form, element) => {
        const input = { reason: value(form, 'reason'), itemId: line?.id, revision: order.retailEditable ? order.updatedAt ?? order.createdAt : undefined };
        if (await action.send(`/orders/${order.id}/cancel`, input, { message: line ? 'Đã hủy món.' : 'Đã hủy đơn.', reset: element })) setOpen(false);
      })}>
        <label>{t("Lý do hủy")}<textarea name="reason" required maxLength={120} rows={2}/></label>
        <button className="button" disabled={action.pending}>{t("Xác nhận hủy")}</button>
        {action.feedback}
      </form>
    </BusinessDialog>}</>;
}

export function BillDetail({ id, tableSessionId, guestCount, visible = true, management = false, cashbook = false }: {
  id: string; tableSessionId?: string; guestCount?: number; visible?: boolean; management?: boolean; cashbook?: boolean;
}) {
  const { t } = useLanguage();
  const details = useData<Bill & { orders: Pick<Order, 'id' | 'items' | 'takeaway'>[]; payments: Payment[]; transferIntents?: ActiveTransfer[] }>(
    `/bills/${id}${cashbook ? '?view=cashbook' : ''}`, 6000, visible);
  const { role, root } = useBusiness();
  const [openedIntent, setIntent] = useState<Intent>();
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(false);
  const openBill = useRef<string>(undefined);
  const paymentAmount = useRef<HTMLInputElement>(null);
  const action = useAction();
  const bill = details.data;
  const intent = openedIntent && bill?.transferIntents?.some(item => item.id === openedIntent.id) ? openedIntent : undefined;
  const due = bill ? bill.totalAmount - bill.paidAmount : 0;
  const paymentSession = tableSessionId ?? bill?.tableSessionId;
  const collect = !cashbook && !management && ['OWNER', 'MANAGER', 'CASHIER'].includes(role) &&
    (!bill?.tableSessionId || bill.tableSessionId === tableSessionId || bill.tableSessionClosed);
  const approve = !cashbook && management && ['OWNER', 'MANAGER'].includes(role);
  const items = bill?.orders.flatMap(order => order.items.filter(item => !item.cancelReason)) ?? [];
  const takeaway = bill?.takeaway;
  const returnableItems = items.flatMap(line => {
    const remaining = line.quantity - (line.returnedQuantity ?? 0);
    return line.warehouseItemId && remaining > 0 ? [{ ...line, remaining }] : [];
  });
  const lines = bill && <>
    {bill.buffet && <BuffetCharge buffet={bill.buffet}/>}
    <div className="bill-lines"><OrderLines items={items}/></div>
    {!!bill.discountAmount && <div className="list-row">{t("Giảm giá")} {bill.promotionName ?? bill.discountCode}<strong>−{currency.format(bill.discountAmount)}</strong></div>}
    {!!bill.taxAmount && <div className="list-row">{t("Thuế")}<strong>{currency.format(bill.taxAmount)}</strong></div>}
  </>;
  const printBill = useCallback(async () => {
    setPrintError(false);
    flushSync(() => setPrinting(true));
    try { await printReceipt(); } finally { setPrinting(false); }
  }, []);
  const status = bill?.status;
  useEffect(() => {
    if (!visible || !collect || (status !== 'PAID' && status !== 'OPEN')) {
      openBill.current = undefined;
      return;
    }
    if (status === 'OPEN') {
      openBill.current = id;
      return;
    }
    if (openBill.current !== id) return;
    const task = window.setTimeout(() => {
      openBill.current = undefined;
      void printPaidReceipt(root, id, printBill).catch(() => setPrintError(true));
    }, 0);
    return () => window.clearTimeout(task);
  }, [visible, collect, status, id, root, printBill]);
  return <Panel title={t("Hóa đơn {0}", shortId(id))} className="bill-detail"><State query={details}/>
    {bill && <>
      <div className="bill-meta"><span className={`badge bill-status-${bill.status.toLowerCase()}`}>{t(billStatus[bill.status])}</span>
        {takeaway && <span className="badge">{t("Mang về")}</span>}
        <time dateTime={bill.createdAt}>{date(bill.createdAt)}</time></div>
      <dl className="bill-amounts">
        <div><dt>{t("Tổng hóa đơn")}</dt><dd>{currency.format(bill.totalAmount)}</dd></div>
        <div><dt>{t("Đã thu ròng")}</dt><dd>{currency.format(bill.paidAmount)}</dd></div>
        {bill.status === 'OPEN' && <div className="bill-due"><dt>{t("Còn phải thu")}</dt><dd>{currency.format(due)}</dd></div>}
      </dl>
      {lines}
      {!cashbook && !management && !tableSessionId && bill.tableSessionId && !bill.tableSessionClosed && bill.status === 'OPEN' && role !== 'ACCOUNTANT' &&
        <Link className="button no-print" href={takeaway ? takeawayMenuHref(bill.tableSessionId) : `/dashboard/tables?session=${bill.tableSessionId}`}>
          {takeaway ? t("Mở đơn mang về để thu tiền") : t("Mở bàn để thu tiền")}</Link>}
      {bill.status === 'OPEN' && collect && <form className="no-print bill-collect" onSubmit={event => submit(event, (form, element) => {
        const method = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
        const paid = amount(form, 'amount');
        if (method === 'transfer') {
          void action.send<Intent>(`/bills/${id}/payment-intents`, { amount: paid, tableSessionId: paymentSession }, { idempotent: true, message: 'Đã tạo QR chờ xác nhận.' }).then(result => { if (result) setIntent(result); });
        } else {
          void action.send(`/bills/${id}/payments`, { method: 'CASH', amount: paid, tableSessionId: paymentSession }, { idempotent: true, reset: element }).then(result => { if (result) setIntent(undefined); });
        }
      })}>
        <label>{t("Số tiền thu (đ)")}<input ref={paymentAmount} key={due} name="amount" type="number" min="1" max={due} defaultValue={due} required/></label>
        <AutoPrintSwitch/>
        <div className="actions business-filters"><button className="button" disabled={action.pending} value="cash">{t("Xác nhận tiền mặt")}</button>
          <button className="plain" disabled={action.pending} value="transfer">{t("Tạo QR chuyển khoản")}</button></div>
      </form>}
      {bill.status === 'OPEN' && collect && paymentSession && due > 1 && <details className="business-details no-print"><summary>{t("Chia đều số tiền còn lại")}</summary>
        <form onSubmit={event => submit(event, form => {
          const shares = amount(form, 'shares');
          if (!paymentAmount.current || !Number.isInteger(shares) || shares < 2 || shares > Math.min(due, 100)) return;
          paymentAmount.current.value = String(Math.ceil(due / shares));
          paymentAmount.current.focus();
        })}>
          <label>{t("Số phần")}<input name="shares" type="number" min={2} max={Math.min(100, due)} defaultValue={Math.min(100, due, Math.max(2, guestCount ?? 2))} required/></label>
          <button className="plain" disabled={action.pending}>{t("Điền số tiền một phần")}</button>
        </form></details>}
      {intent && bill.status === 'OPEN' && <div className="qr-block no-print">
        <img src={intent.qrUrl} alt={t("Mã VietQR chuyển khoản")} referrerPolicy="no-referrer" width={192} height={192}/>
        <p><strong>{currency.format(intent.amount)}</strong> · {intent.bankAccount.holder} · {intent.bankAccount.account}</p>
        <p>{t("Nội dung")} <strong>{intent.reference}</strong> {t("· Hết hạn")} {date(intent.expiresAt)}</p>
        <form onSubmit={event => submit(event, form => {
          void action.send(`/bills/${id}/payments`, { method: 'TRANSFER', tableSessionId: paymentSession, intentId: intent.id, bankReference: value(form, 'reference') },
            { idempotent: true, message: 'Đã xác nhận chuyển khoản.' }).then(result => { if (result) setIntent(undefined); });
        })}><label>{t("Mã giao dịch trong sao kê")}<input name="reference" maxLength={120} required/></label>
          <button className="button" disabled={action.pending}>{t("Xác nhận sau khi đã nhận tiền")}</button></form>
      </div>}
      {bill.status === 'OPEN' && collect && bill.transferIntents?.filter(item => item.id !== intent?.id && item.amount <= due).map(item =>
        <details className="business-details no-print" key={item.id}><summary>{t("QR chờ đối soát ·")} {item.reference} · {currency.format(item.amount)}</summary>
          <form onSubmit={event => submit(event, (form, element) => void action.send(`/bills/${id}/payments`, {
            method: 'TRANSFER', tableSessionId: paymentSession, intentId: item.id, bankReference: value(form, 'reference'),
          }, { idempotent: true, reset: element }))}>
            <label>{t("Mã giao dịch trong sao kê")}<input name="reference" maxLength={120} required/></label>
            <button className="button" disabled={action.pending}>{t("Xác nhận sau khi đã nhận tiền")}</button>
          </form>
        </details>)}
      {approve && bill.status === 'OPEN' && bill.paidAmount === 0 && (!bill.retail || !bill.payments.length) && <details className="business-details no-print"><summary>{t("Hủy hóa đơn")}</summary>
        <form onSubmit={event => submit(event, form => void action.send(`/bills/${id}/void`, { reason: value(form, 'reason') }))}>
          <label>{t("Lý do")}<input name="reason" required maxLength={120}/></label><button className="plain" disabled={action.pending}>{t("Xác nhận hủy hóa đơn")}</button></form></details>}
      {bill.payments.map(payment => <div key={payment.id}>
        <div className="list-row"><div><strong>{payment.method === 'CASH' ? t("Tiền mặt") : t("Chuyển khoản")} · {currency.format(payment.amount)}</strong>
          <small>{date(payment.paidAt)} {payment.reference}</small></div>
          {!!payment.refundedAmount && <span>{t("Hoàn")} {currency.format(payment.refundedAmount)}</span>}</div>
        {approve && ['PAID', 'OPEN'].includes(bill.status) && payment.refundedAmount < payment.amount && <details className="business-details no-print"><summary>{t("Ghi nhận hoàn tiền")}</summary>
          <form onSubmit={event => submit(event, (form, element) => {
            const refundAmount = amount(form, 'amount');
            const fullRefund = bill.status === 'PAID' && refundAmount === bill.paidAmount;
            const returnLines = fullRefund ? [] : returnableItems.flatMap(line => {
              const quantity = amount(form, `return:${line.id}`);
              return quantity > 0 ? [{ lineId: line.id, quantity }] : [];
            });
            void action.send(`/payments/${payment.id}/refunds`, {
              amount: refundAmount, reason: value(form, 'reason'), ...(returnLines.length ? { returnLines } : {}),
            }, { idempotent: true, reset: element, message: 'Đã ghi nhận hoàn tiền.' });
          })}>
            <label>{t("Số tiền (đ)")}<input name="amount" type="number" min="1" max={payment.amount - payment.refundedAmount} required/></label>
            <label>{t("Lý do")}<input name="reason" required maxLength={120}/></label>
            {returnableItems.length > 0 && <fieldset className="business-details">
              <legend>{t("Số lượng hàng nhận lại")}</legend>
              <p className="muted">{t("Hoàn một phần thì nhập số lượng hàng thực nhận. Hoàn toàn bộ hóa đơn sẽ tự nhập lại số lượng còn lại.")}</p>
              {returnableItems.map(line => <label key={`${line.id}:${line.remaining}`}>
                {line.name} {t("· Còn")} {line.remaining} {t("có thể trả")}
                <input name={`return:${line.id}`} type="number" min={0} max={line.remaining} step={1} defaultValue={0}/>
              </label>)}
            </fieldset>}
            <button className="button" disabled={action.pending}>{t("Xác nhận đã hoàn tiền")}</button>
          </form></details>}
      </div>)}
      <button className="plain no-print" onClick={() => void printBill().catch(() => setPrintError(true))}><Printer size={17}/> {cashbook ? t("In / lưu PDF") : t("In hóa đơn")}</button>
      {printError && <p className="error no-print" role="alert">{t("Không mở được trình in. Hãy bấm nút in để thử lại.")}</p>}
      {printing && createPortal(<div className="print-receipt bill-print">
        <strong>{t("HÓA ĐƠN #")}{shortId(id)}</strong>
        <p>{date(bill.createdAt)} · {t(billStatus[bill.status])}{takeaway && ' · Mang về'}</p>
        {lines}
        <div className="list-row"><strong>{t("Tổng hóa đơn")}</strong><strong>{currency.format(bill.totalAmount)}</strong></div>
        <div className="list-row"><span>{t("Đã thu ròng")}</span><strong>{currency.format(bill.paidAmount)}</strong></div>
        {bill.status === 'OPEN' && <div className="list-row"><span>{t("Còn phải thu")}</span><strong>{currency.format(due)}</strong></div>}
        {bill.payments.map(payment => <div key={payment.id} className="list-row">
          <span>{payment.method === 'CASH' ? t("Tiền mặt") : t("Chuyển khoản")}<small>{date(payment.paidAt)} {payment.reference}</small></span>
          <strong>{currency.format(payment.amount)}</strong>
        </div>)}
      </div>, document.body)}
    </>}{action.feedback}
  </Panel>;
}

export function Bills({ management = false, initialBill }: { management?: boolean; initialBill?: string }) {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const [selected, select] = useState(initialBill ?? '');
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialBill && !management && window.matchMedia('(max-width: 800px)').matches) {
      detail.current?.scrollIntoView({ block: 'start' });
    }
  }, [initialBill, management]);
  const review = useData<{ id: string; reference: string; amount: number; createdAt: string }[]>('/transfer-review', 15000, management);
  const bills = useData<Bill[]>(`/bills?page=${page}`, 8000);
  return <><div className={management ? 'columns' : 'payment-desk'}><Panel title={t("Hóa đơn bán hàng")}><State query={bills} empty={bills.data?.length === 0}/>
    <div className="bill-list">{bills.data?.map(bill => <button type="button" className="bill-list-row" key={bill.id}
      aria-pressed={selected === bill.id} onClick={() => {
        select(bill.id);
        if (!management && window.matchMedia('(max-width: 800px)').matches) {
          window.requestAnimationFrame(() => detail.current?.scrollIntoView({ block: 'start' }));
        }
      }}>
      <span className="bill-list-icon"><ReceiptText size={18}/></span>
      <span><strong>#{shortId(bill.id)}</strong><small>{date(bill.createdAt)}</small></span>
      <span><strong>{currency.format(bill.totalAmount)}</strong>
        <small className={`badge bill-status-${bill.status.toLowerCase()}`}>{t(billStatus[bill.status])}</small></span>
    </button>)}</div>
    <Pager page={page} full={bills.data?.length === 50} onChange={setPage}/>
  </Panel><div className="payment-detail" ref={detail}>{selected ? <BillDetail key={selected} id={selected} management={management}/> :
    !management && !!bills.data?.length && <div className="card payment-empty"><ReceiptText size={28}/><p>{t("Chọn một hóa đơn để xem chi tiết.")}</p></div>}</div></div>
    {management && !!review.data?.length && <Panel title={t("Chuyển khoản cần đối chiếu")}>
      {review.data.map(item => <div className="list-row" key={item.id}><div>{item.reference}<small>{date(item.createdAt)}</small></div>
        <strong>{currency.format(item.amount)}</strong></div>)}
    </Panel>}</>;
}

export function TransactionManagement() {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const [view, setView] = useState<'orders' | 'bills'>(role === 'ACCOUNTANT' ? 'bills' : 'orders');
  const [initialBill, setInitialBill] = useState<string>();
  return <>
    <div className="business-settings-tabs" role="group" aria-label={t("Quản lý giao dịch")}>
      <button type="button" className="plain" aria-pressed={view === 'orders'} onClick={() => setView('orders')}>{t("Đơn hàng")}</button>
      <button type="button" className="plain" aria-pressed={view === 'bills'} onClick={() => setView('bills')}>{t("Hóa đơn và hoàn tiền")}</button>
      <CsvExport path="/company/transactions/export" filename="juee-giao-dich" label={t("Xuất giao dịch CSV")}/>
    </div>
    {view === 'orders' ? <Orders management onViewBill={id => { setInitialBill(id); setView('bills'); }}/> : <Bills key={initialBill} initialBill={initialBill} management/>}
  </>;
}

export function Tables() {
  const { t } = useLanguage();
  return <Suspense fallback={<div className="skeleton" aria-label={t("Đang tải bàn")}/>}><TableDirectory/></Suspense>;
}

const tableFilters = [
  { key: '', label: 'Tất cả' }, { key: 'ready', label: 'Trống' }, { key: 'serving', label: 'Đang phục vụ' },
  { key: 'reserved', label: 'Đặt trước' }, { key: 'payment', label: 'Cần tính tiền' }, { key: 'billed', label: 'Chờ thanh toán' },
];

function TableDirectory() {
  const { language, t } = useLanguage();
  const params = useSearchParams();
  const router = useRouter();
  const highlightedTable = params.get('table');
  const requestedSession = params.get('session');
  const query = useData<TableResponse>('/tables', 6000);
  const [area, setArea] = useState('');
  const [filter, setFilter] = useState('');
  const selectedTable = query.data?.tables.find(table => highlightedTable ? table.id === highlightedTable : requestedSession && table.sessionId === requestedSession);
  const selectedHref = selectedTable && tableMenuHref(selectedTable);
  const sessions = new Map(query.data?.sessions.map(item => [item.id, item]));
  const now = useOrderClock(sessions.size > 0);
  useEffect(() => { if (selectedHref) router.replace(selectedHref); }, [router, selectedHref]);
  if (selectedHref) return <div className="skeleton" role="status" aria-label={t("Đang mở bàn")}/>;
  const areaNames = new Map(query.data?.areas.map(item => [item.id, item.name]));
  const counts: Record<string, number> = {};
  const tables = query.data?.tables.filter(table => !area || table.areaId === area).map(table => {
    const session = table.sessionId ? sessions.get(table.sessionId) : undefined;
    const state = tableState(table, session);
    counts[state.key] = (counts[state.key] ?? 0) + 1;
    return { table, session, state, duration: session?.createdAt ? elapsedTime(session.createdAt, now, language) : '' };
  });
  const visible = tables?.filter(item => !filter || item.state.key === filter);
  return <><section className="card business-panel table-directory" aria-label={t("Sơ đồ bàn")}><State query={query} empty={query.data?.tables.length === 0}/>
    {query.data && !!query.data.tables.length && <div className="table-filter-bar">
      <StatusFilters label={t("Lọc theo trạng thái bàn")} value={filter} onChange={setFilter}
        items={tableFilters.map(item => ({ ...item, count: item.key ? counts[item.key] ?? 0 : tables?.length ?? 0 }))}/>
      <select aria-label={t("Khu vực")} value={area} onChange={event => setArea(event.target.value)}><option value="">{t("Mọi khu vực")}</option>
        {query.data.areas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    </div>}
    <Link className="plain takeaway-table-link" href={takeawayMenuHref()}><ShoppingBag size={17} aria-hidden="true"/> {t("Tạo đơn mang về")}</Link>
    {!!query.data?.tables.length && !visible?.length && <p className="muted">{t("Không có bàn phù hợp.")}</p>}
    <div className="table-floor">{visible?.map(({ table, session, state, duration }) => <Link className="table-card" key={table.id}
      href={tableMenuHref(table)} data-state={state.key}>
      <span className="table-card-top"><span className="table-card-icon"><Armchair size={22} aria-hidden="true"/></span><ArrowUpRight size={18} aria-hidden="true"/></span>
      <span><strong>{table.name}</strong><small>{(table.areaId && areaNames.get(table.areaId)) || 'Khu vực chung'}</small></span>
      <span className="table-card-status">{t(state.label)}</span>
      {!!session?.guestCount && <small className="table-card-guests"><Users size={15}/> {session.buffet ? 'Buffet · ' : ''}{session.guestCount} {t("khách")}</small>}
      {duration && <small className="table-card-duration"><Clock size={14} aria-hidden="true"/> {duration}</small>}
      {!session && table.reserved && table.reservation && <small>{date(table.reservation.arrivesAt)} · {table.reservation.guests} {t("khách")}</small>}
    </Link>)}</div>
    </section>
    {requestedSession && query.isSuccess && <p className="muted">{t("Lượt phục vụ này đã đóng.")}</p>}
  </>;
}

export function TableOrders({ session, unsentItems, service, quantity, children, initiallyOpen, takeaway }: {
  session?: string; unsentItems: boolean; service?: DiningSession; quantity: number; children: ReactNode; initiallyOpen: boolean; takeaway: boolean;
}) {
  const { t } = useLanguage();
  const [disclosure, setDisclosure] = useState<'unopened' | 'open' | 'closed'>(initiallyOpen ? 'open' : 'unopened');
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const expanded = disclosure === 'open';
  function choose(view: 'open' | 'closed') {
    setDisclosure(view);
    body.current?.scrollTo({ top: 0 });
  }
  const label = takeaway ? t("Món mang về") : t("Món tại bàn");
  return <section id="table-order-pane" className="table-orders card" data-view={expanded ? 'ordered' : 'selected'} aria-label={t(label)}>
    <div className="table-order-tabs no-print" role="group" aria-label={t(label)}>
      <button className="plain" type="button" aria-pressed={!expanded} aria-controls={`${id}-selected`} onClick={() => {
        if (expanded) choose('closed');
      }}>{t("Món đang chọn")} {quantity > 0 && <span className="table-order-count">{quantity}</span>}</button>
      <button className="plain" type="button" aria-pressed={expanded} aria-controls={`${id}-ordered`}
        disabled={!session} onClick={() => { if (!expanded) choose('open'); }}><ClipboardList size={17} aria-hidden="true"/> {t("Món đã gọi")}</button>
    </div>
    {service?.paymentRequestedAt && !service.checkoutBillId && <div className="table-payment-request no-print"><span className="badge warning">{t("Khách yêu cầu tính tiền")}</span></div>}
    <div className="table-order-body" ref={body}>
      <div id={`${id}-selected`} hidden={expanded}>{children}</div>
      <div id={`${id}-ordered`} hidden={!expanded}>
        {session && disclosure !== 'unopened' &&
          <TableCartDetail session={session} unsentItems={unsentItems} guestCount={service?.guestCount} visible={expanded}/>}
      </div>
    </div>
  </section>;
}

function TableCartDetail({ session, unsentItems, guestCount, visible }: {
  session: string; unsentItems: boolean; guestCount?: number; visible: boolean;
}) {
  const { t } = useLanguage();
  const root = `/table-sessions/${session}`;
  const query = useData<TableCart>(`${root}/cart`, 4000, visible);
  const action = useAction();
  const checkout = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { role } = useBusiness();
  const now = useOrderClock(visible);
  const collect = ['OWNER', 'MANAGER', 'CASHIER'].includes(role);
  const cart = query.data;
  const checkoutBillId = cart?.checkoutBillId;
  useEffect(() => {
    if (visible && collect && checkoutBillId) checkout.current?.scrollIntoView({ block: 'start' });
  }, [visible, collect, checkoutBillId]);
  const openBills = cart?.bills.filter(bill => bill.status === 'OPEN') ?? [];
  const bills = cart?.bills.filter(bill => bill.status !== 'VOID') ?? [];
  const checkoutBill = bills.find(bill => bill.id === checkoutBillId);
  const displayedBills = checkoutBill ? [checkoutBill, ...bills.filter(bill => bill.id !== checkoutBill.id)] : bills;
  const unbilledBuffet = cart?.buffet && !cart.bills.some(bill => bill.buffet && bill.status !== 'VOID') ? cart.buffet : undefined;
  const showCheckout = collect && cart?.status === 'OPEN' && !checkoutBillId && !openBills.length &&
    (unbilledBuffet || cart.orders.some(order => order.status === 'ACCEPTED' && !order.billId));
  return <section className="table-cart-detail" aria-label={t("Món đã gọi và thanh toán")}>
    <div className="table-cart-scroll" role="region" aria-label={t("Danh sách món và hóa đơn")} tabIndex={0}>
      <State query={query}/>
      {cart && <>
        {!cart.orders.length && <p className="muted">{t("Chưa có món đã gọi.")}</p>}
        <div className="table-ordered-items">{cart.orders.map((order, index) => <article className="business-details table-cart-round" key={order.id}>
          <div className="list-row"><div><strong>{t("Đợt")} {index + 1} · {order.source === 'QR' ? t("Khách quét QR") : t("Nhân viên thêm")}</strong><small>{date(order.createdAt)}</small></div>
            <span className="badge">{t(orderStatus[order.status])}</span></div>
          <OrderLines items={order.items} order={order} now={now} serve={collect || role === 'WAITER' ? action : undefined} cancel={action}/>
          {order.cancelReason && <p className="muted">{t("Lý do hủy ·")} {order.cancelReason}</p>}
          <AcceptOrder order={order} action={action}/>
          <CancelOrder order={order} action={action}/>
        </article>)}</div>
        <div className="table-checkout" ref={checkout} tabIndex={-1}>
          {!checkoutBillId && cart.status === 'OPEN' && (showCheckout || cart.pending > 0) && <Panel title={t("Chốt hóa đơn")}>
            {unbilledBuffet && <BuffetCharge buffet={unbilledBuffet}/>}
            {cart.pending > 0 && <p className="notice">{t("Còn")} {cart.pending} {t("đợt gọi món cần xác nhận trước khi chốt hóa đơn.")}</p>}
            {cart.unservedQuantity > 0 && <p className="notice" role="status">{t("Còn")} {cart.unservedQuantity} {t("phần chưa xác nhận ra món.")}</p>}
            {showCheckout && <form onSubmit={event => submit(event, form => {
              void action.send<Bill>(`${root}/checkout`, { revision: cart.revision, discountCode: value(form, 'discount') || undefined },
                { idempotent: true, message: 'Đã chốt hóa đơn.' }).then(result => { if (!result) void query.refetch(); });
            })}>
              <label>{t("Mã giảm giá (nếu có)")}<input name="discount" maxLength={30} autoComplete="off" placeholder={t("Ví dụ GIAM10")}/></label>
              {unsentItems && <p className="muted">{t("Gửi hoặc bỏ món đang chọn trước khi chốt hóa đơn.")}</p>}
              <button className="button" disabled={action.pending || cart.pending > 0 || cart.unservedQuantity > 0 || unsentItems}>{t("Chốt hóa đơn")}</button>
            </form>}
          </Panel>}
          {action.feedback}
          {collect && displayedBills.map(bill =>
            <BillDetail key={bill.id} id={bill.id} tableSessionId={session} guestCount={cart.guestCount ?? guestCount} visible={visible}/>)}
        </div>
      </>}
    </div>
    {cart && <footer className="table-cart-footer">
      <div><small>{checkoutBill?.status === 'PAID' ? t("Đã thu đủ") : t("Còn phải thu")}</small>
        <strong>{currency.format(checkoutBill?.status === 'PAID' ? checkoutBill.paidAmount : cart.due)}</strong></div>
      {collect && (showCheckout || openBills.length > 0) && <button type="button" className="button" onClick={() => {
        checkout.current?.scrollIntoView({ block: 'start' });
        checkout.current?.focus({ preventScroll: true });
      }}>{t("Thanh toán")}</button>}
      {cart.takeaway && cart.status === 'OPEN' && !cart.checkoutBillId && !cart.buffet && !cart.orders.some(order => order.status !== 'CANCELED') &&
        <button className="plain" type="button" disabled={action.pending || unsentItems} onClick={async () => {
          if (await action.send(`${root}/close`, undefined)) router.replace(takeawayMenuHref(undefined, true));
        }}>{t("Đóng lượt")}</button>}
      {cart.status === 'CLOSED' && checkoutBill && <Link href={cart.takeaway ? takeawayMenuHref() : '/dashboard/tables'} className="plain">
        {cart.takeaway ? t("Đơn mang về mới") : t("Về sơ đồ bàn")}</Link>}
    </footer>}
  </section>;
}

export function TableService({ table, service, tables, currentSession, unsentItems, onClose }: {
  table: DiningTable; service?: DiningSession; tables: DiningTable[];
  currentSession?: string; unsentItems: boolean; onClose: () => void;
}) {
  const { language, t } = useLanguage();
  const router = useRouter();
  const { staffMode, branch, role } = useBusiness();
  const action = useAction();
  const qr = useData<TableQr>(`/tables/${table.id}/qr`);
  const [details, setDetails] = useState(false);
  const session = currentSession;
  const now = useOrderClock(!!service?.createdAt);
  const duration = service?.createdAt ? elapsedTime(service.createdAt, now, language) : '';
  const buffet = service?.buffet;
  const available = tables.filter(item => item.id !== table.id && !item.sessionId && !item.reserved);
  const localQr = qr.data && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(qr.data.url).hostname);
  return <section className="card table-service no-print" aria-label={t("Thông tin {0}", table.name)}>
    {qr.data && <a className="table-service-qr" href={qr.data.url} target="_blank" rel="noreferrer" aria-label={t("Mở thực đơn QR của {0}", table.name)}>
      <img src={qr.data.image} width={64} height={64} alt={t("QR gọi món {0}", table.name)}/>
    </a>}
    <div className="table-service-label">
      <strong>{table.name}</strong>
      <small>{t(tableState(table, service).label)}{service?.guestCount ? " " + t("· {0} khách", service.guestCount) : ''}</small>
      {duration && <small>{t("Thời gian phục vụ")} {duration}</small>}
      {qr.isLoading && <small role="status">{t("Đang tải QR…")}</small>}
      {qr.error && <small role="status">{t("Chưa tải được QR")}</small>}
    </div>
    <div className="actions table-service-actions">
      {qr.data && <a className="plain" href={qr.data.image} download={`juee-qr-${table.id}.svg`}>{t("Tải QR")}</a>}
      {(session || !staffMode || qr.data || qr.error) &&
        <button type="button" className="plain" onClick={() => setDetails(true)}>{t("Thông tin bàn")}</button>}
      <Link className="plain" href="/dashboard/tables">{t("Về sơ đồ bàn")}</Link>
    </div>
    {details && <BusinessDialog title={table.name} close={() => setDetails(false)} pending={action.pending}>
      <div className="table-service-details">
        <State query={qr}/>
        {qr.data && <a className="table-service-qr table-service-qr-large" href={qr.data.url} target="_blank" rel="noreferrer"
          aria-label={t("Mở thực đơn QR của {0}", table.name)}><img src={qr.data.image} width={176} height={176} alt={t("QR gọi món {0}", table.name)}/></a>}
        {localQr && <p className="muted">{t("QR đang mở địa chỉ trên máy này. Đặt PUBLIC_ORDER_ORIGIN thành địa chỉ HTTPS khách truy cập được để gọi món bằng điện thoại.")}</p>}
        {!staffMode && !branch.location && <p className="notice">{t("Chi nhánh cần ghim vị trí để khách gọi món QR.")}
          {role === 'OWNER' && <> <Link href="/dashboard/company?tab=branches">{t("Cài đặt chi nhánh")}</Link></>}</p>}
        {!staffMode && !table.sessionId && <TableReservation key={`${table.id}:${table.reservation?.arrivesAt}`} table={table} action={action}/>}
        {session && <>
          {service?.createdAt && <p className="muted">{t("Mở bàn lúc")} {date(service.createdAt)}</p>}
          {buffet && <p className="muted">{buffet.packageName ?? 'Buffet'} · {buffet.adults} {t("người lớn,")} {buffet.children} {t("trẻ em")}</p>}
          {!service?.checkoutBillId && <form key={`${session}:${service?.guestCount}:${buffet?.adults}`} className="table-guest-count" onSubmit={event => submit(event, form => {
            const input = buffet ? { buffet: { adults: amount(form, 'adults'), children: amount(form, 'children') } } : { guestCount: amount(form, 'guests') };
            void action.send(`/table-sessions/${session}/guests`, input, { method: 'PATCH', message: 'Đã cập nhật số khách.' });
          })}>
            {buffet ? <><label>{t("Người lớn")}<input name="adults" type="number" min={0} max={1000} defaultValue={buffet.adults} required/></label>
              <label>{t("Trẻ em")}<input name="children" type="number" min={0} max={1000} defaultValue={buffet.children} required/></label></> :
              <label>{t("Số khách")}<input name="guests" type="number" min={1} max={1000} defaultValue={service?.guestCount ?? 1} required/></label>}
            <button className="plain" disabled={action.pending}>{t("Lưu")}</button>
          </form>}
          {!service?.checkoutBillId && <div className="actions business-filters">
            <button className="plain" disabled={action.pending || unsentItems} onClick={() => void action.send(`/table-sessions/${session}/close`, undefined)
              .then(result => { if (result) onClose(); })}>{t("Đóng lượt và trả bàn")}</button>
          </div>}
          {!staffMode && !service?.checkoutBillId && available.length > 0 && !unsentItems &&
            <TableMove session={session} tables={available} action={action} onMove={table => router.replace(tableMenuHref({ ...table, sessionId: session }))}/>}
        </>}
        {action.feedback}
      </div>
    </BusinessDialog>}
  </section>;
}

function TableReservation({ table, action }: { table: DiningTable; action: ReturnType<typeof useAction> }) {
  const { t } = useLanguage();
  const booking = table.reservation;
  const localTime = booking && new Date(new Date(booking.arrivesAt).getTime() + 7 * 3600000).toISOString().slice(0, 16);
  return <details className="business-details"><summary>{table.reserved ? t("Thông tin đặt bàn") : t("Đặt trước")}</summary>
    {booking && <p className="muted">{booking.guestName} · {booking.guests} {t("khách ·")} {date(booking.arrivesAt)}</p>}
    <form onSubmit={event => submit(event, form => {
      const arrivesAt = new Date(`${value(form, 'arrivesAt')}+07:00`);
      if (!Number.isFinite(arrivesAt.getTime())) return;
      void action.send(`/tables/${table.id}/reservation`, { reserved: true, reservation: {
        guestName: value(form, 'guestName'), phone: value(form, 'phone') || undefined, guests: amount(form, 'guests'),
        arrivesAt: arrivesAt.toISOString(), note: value(form, 'note') || undefined,
      } }, { method: 'PATCH', message: 'Đã lưu đặt bàn.' });
    })}>
      <div className="form-grid form-grid-business">
        <label>{t("Tên khách")}<input name="guestName" defaultValue={booking?.guestName} maxLength={120} required/></label>
        <label>{t("Số điện thoại")}<input name="phone" type="tel" defaultValue={booking?.phone} maxLength={18}/></label>
        <label>{t("Số khách")}<input name="guests" type="number" min={1} max={1000} defaultValue={booking?.guests ?? 2} required/></label>
        <label>{t("Giờ đến (Việt Nam)")}<input name="arrivesAt" type="datetime-local" defaultValue={localTime} required/></label>
      </div>
      <label>{t("Ghi chú")}<input name="note" defaultValue={booking?.note} maxLength={240}/></label>
      <div className="actions"><button className="button" disabled={action.pending}>{t("Lưu đặt bàn")}</button>
        {table.reserved && <button type="button" className="plain" disabled={action.pending} onClick={() => void action.send(
          `/tables/${table.id}/reservation`, { reserved: false }, { method: 'PATCH', message: 'Đã bỏ đặt trước.' })}>{t("Bỏ đặt trước")}</button>}</div>
    </form></details>;
}

function TableMove({ session, tables, action, onMove }: { session: string; tables: DiningTable[];
  action: ReturnType<typeof useAction>; onMove: (table: DiningTable) => void }) {
  const { t } = useLanguage();
  return <details className="business-details"><summary>{t("Chuyển bàn")}</summary><form onSubmit={event => submit(event, form => {
    const table = tables.find(item => item.id === value(form, 'table'));
    if (table) void action.send(`/table-sessions/${session}/tables`, { tableId: table.id, action: 'MOVE' },
      { message: 'Đã chuyển giỏ món sang bàn mới.' }).then(result => { if (result) onMove(table); });
  })}><label>{t("Bàn đích")}<select name="table" required><option value="">{t("Chọn bàn trống")}</option>
    {tables.map(table => <option key={table.id} value={table.id}>{table.name}</option>)}
  </select></label><button className="button" disabled={action.pending}>{t("Chuyển giỏ món")}</button></form></details>;
}

export function TableDiscounts() {
  const { t } = useLanguage();
  type Discount = { code: string; kind: 'PERCENT' | 'FIXED'; value: number; enabled: boolean };
  const [open, setOpen] = useState(false);
  const query = useData<Discount[]>('/table-discounts', undefined, open);
  const action = useAction();
  const [kind, setKind] = useState('PERCENT');
  const [editing, setEditing] = useState<Discount>();
  return <details className="card business-details table-discounts" onToggle={event => setOpen(event.currentTarget.open)}><summary>{t("Mã giảm giá của chi nhánh")}</summary>
    <State query={query}/>
    {query.data?.map(item => <div className="list-row" key={item.code}><div><strong>{item.code}</strong>
      <small>{item.kind === 'PERCENT' ? `${item.value}%` : currency.format(item.value)} · {item.enabled ? t("Đang dùng") : t("Đã tắt")}</small></div>
      <button className="plain" disabled={action.pending} onClick={() => { setEditing(item); setKind(item.kind); }}>{t("Sửa mã")}</button></div>)}
    <form key={editing?.code ?? 'new'} onSubmit={event => submit(event, (form, element) => {
      void action.send('/table-discounts', { code: value(form, 'code'), kind, value: amount(form, 'discountValue'), enabled: form.has('enabled') },
        { reset: element, message: 'Đã lưu mã giảm giá.' }).then(result => { if (result) { setEditing(undefined); setKind('PERCENT'); } });
    })}>
      <div className="form-grid form-grid-business">
        <label>{t("Mã")}<input name="code" maxLength={30} required readOnly={!!editing} defaultValue={editing?.code}/></label>
        <label>{t("Loại giảm")}<select value={kind} onChange={event => setKind(event.target.value)}><option value="PERCENT">{t("Theo phần trăm")}</option><option value="FIXED">{t("Số tiền cố định")}</option></select></label>
        <label>{kind === 'PERCENT' ? t("Mức giảm (%)") : t("Mức giảm (đ)")}<input name="discountValue" type="number" min={1} max={kind === 'PERCENT' ? 100 : 1e12} required defaultValue={editing?.value}/></label>
      </div>
      <label className="check"><input type="checkbox" name="enabled" defaultChecked={editing?.enabled ?? true}/> {t("Cho phép áp dụng")}</label>
      <div className="actions"><button className="button" disabled={action.pending}>{t("Lưu mã")}</button>
        {editing && <button type="button" className="plain" onClick={() => { setEditing(undefined); setKind('PERCENT'); }}>{t("Mã mới")}</button>}</div>
    </form>{action.feedback}
  </details>;
}

type Ticket = { id: string; orderId: string; tableName?: string; takeaway?: boolean; createdAt: string; orderedAt?: string;
  items: (Preparation & { name: string; quantity: number; note?: string; modifiers: string[] })[] };
const portionCount = new Intl.NumberFormat('vi-VN');
const kitchenWaitingStatus: Record<string, string> = { COOKING: 'Đang làm', READY: 'Sẵn sàng' };

function useKitchenStream(enabled: boolean, view: 'kitchen' | 'service') {
  const { root } = useBusiness();
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let lastId: string | undefined;
    let reconnect: number | undefined;
    async function follow() {
      try {
        const body = await eventStream(`${root}/kitchen/stream?view=${view}`, signal, lastId);
        const reader = body.getReader();
        const decode = new TextDecoder();
        let pending = '';
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decode.decode(value, { stream: true });
          const messages = pending.split('\n\n');
          pending = messages.pop() ?? '';
          let changed = false;
          for (const message of messages) {
            const id = message.match(/^id: ([a-f0-9]{24})$/m)?.[1];
            if (id) lastId = id;
            if (message.includes('event: sync')) changed = true;
          }
          if (changed) void client.invalidateQueries({ queryKey: ['business', root],
            predicate: item => String(item.queryKey[2]).startsWith('/kitchen/') });
        }
        reader.releaseLock();
      } catch { /* Periodic API refresh covers stream outages. */ }
      if (!signal.aborted) reconnect = window.setTimeout(follow, 3000);
    }
    void follow();
    return () => { controller.abort(); window.clearTimeout(reconnect); };
  }, [client, root, enabled, view]);
}

export function Kitchen() {
  const { language, t } = useLanguage();
  const { role, branch, mode } = useBusiness();
  const view = ['WAITER', 'CASHIER'].includes(role) ? 'service' : 'kitchen';
  const [queue, setQueue] = useState<'active' | 'history'>('active');
  const [page, setPage] = useState(1);
  const [paper, setPaper] = useState('80');
  const [printing, setPrinting] = useState<Ticket>();
  const tickets = useData<Ticket[]>(`/kitchen/tickets?page=${page}&view=${view}&queue=${queue}`, 10000);
  const summary = useData<KitchenSummary>(`/kitchen/preparation-summary?view=${view}`, 10000);
  useKitchenStream(tickets.isSuccess || summary.isSuccess, view);
  const action = useAction();
  const now = useOrderClock();
  useEffect(() => { if (localStorage.getItem('juee-kitchen-paper') === '58') setPaper('58'); }, []);

  async function printTicket(ticket: Ticket) {
    flushSync(() => setPrinting(ticket));
    try { await printReceipt(); } finally { setPrinting(undefined); }
  }

  return <section className="kitchen-workspace" aria-labelledby="kitchen-heading">
    <header className="kitchen-header">
      <div className="kitchen-heading">
        <span className="kitchen-heading-icon"><ChefHat size={26} aria-hidden="true"/></span>
        <div><p>{branch.name}</p><h1 id="kitchen-heading">{t(sectionTitle('kitchen', mode))}</h1></div>
      </div>
      <div className="kitchen-header-tools">
        <label className="kitchen-paper"><Printer size={17} aria-hidden="true"/> {t("Khổ giấy")}
          <select value={paper} onChange={event => {
            setPaper(event.target.value); localStorage.setItem('juee-kitchen-paper', event.target.value);
          }}><option value="80">80 mm</option><option value="58">58 mm</option></select>
        </label>
      </div>
    </header>
    <div className="kitchen-queue" role="group" aria-label={t("Lọc phiếu bếp")}>
      <button type="button" aria-pressed={queue === 'active'} onClick={() => { setQueue('active'); setPage(1); }}>
        <CookingPot size={18} aria-hidden="true"/> {t("Đang xử lý")}
      </button>
      <button type="button" aria-pressed={queue === 'history'} onClick={() => { setQueue('history'); setPage(1); }}>
        <History size={18} aria-hidden="true"/> {t("Lịch sử 24 giờ")}
      </button>
    </div>
    <details className="card kitchen-summary">
      <summary>
        <span className="kitchen-summary-icon"><ClipboardList size={20} aria-hidden="true"/></span>
        <span className="kitchen-summary-label"><strong>{t("Tổng hợp món chờ")}</strong>
          <small>{summary.data ? t("{0} món", portionCount.format(summary.data.dishes.length)) :
            summary.isError ? t("Chưa tải được") : t("Đang tải…")}</small></span>
        {summary.data && <span className="kitchen-summary-total"><strong>{portionCount.format(summary.data.totalQuantity)}</strong> {t("phần chưa ra")}</span>}
        <ChevronDown className="kitchen-summary-chevron" size={18} aria-hidden="true"/>
      </summary>
      <State query={summary}/>
      {summary.data?.dishes.length === 0 && <p className="muted">{t("Hiện không còn phần nào chờ ra.")}</p>}
      {!!summary.data?.dishes.length && <div className="table-wrap"><table>
        <thead><tr><th scope="col">{t("Món")}</th><th scope="col">{t("Số phần chưa ra")}</th></tr></thead>
        <tbody>{summary.data.dishes.map(dish => <tr key={dish.name}><th scope="row">{dish.name}</th>
          <td>{portionCount.format(dish.quantity)}</td></tr>)}</tbody>
      </table></div>}
    </details>
    <State query={tickets}/>{action.feedback}
    {tickets.data?.length === 0 && <div className="card kitchen-empty">
      <CheckCheck size={29} aria-hidden="true"/>
      <p>{queue === 'active' ? t("Hiện không có món chờ xử lý.") : t("Chưa có phiếu hoàn tất trong 24 giờ qua.")}</p>
    </div>}
    {!!tickets.data?.length && <div className="kitchen-board" aria-label={t("Danh sách phiếu bếp")}>{tickets.data.map(ticket => {
      const orderedAt = ticket.orderedAt ?? ticket.createdAt;
      const remaining = ticket.items.reduce((count, item) => count + (isWaitingForService(item.status) ? item.quantity : 0), 0);
      const awaitingCancellation = ticket.items.some(item => item.status === 'CANCELED' && item.cancelReason && !item.cancelConfirmedAt);
      const elapsed = remaining ? elapsedTime(orderedAt, now, language) : '';
      const overdue = remaining > 0 && now - Date.parse(orderedAt) >= 15 * 60_000;
      return <article key={ticket.id} className="kitchen-ticket" data-state={awaitingCancellation ? 'cancel' : remaining ? 'waiting' : 'done'}>
        <header className="kitchen-ticket-header">
          <div><h2>{ticket.takeaway ? t("Mang về") : ticket.tableName || t('Tại quầy')}</h2>
            <p><span>#{shortId(ticket.orderId)}</span> <time dateTime={orderedAt}>{date(orderedAt)}</time></p></div>
          <button className="plain kitchen-ticket-print" type="button" aria-label={t("In phiếu {0}", shortId(ticket.orderId))} onClick={() => void printTicket(ticket)}>
            <Printer size={19} aria-hidden="true"/>
          </button>
        </header>
        <div className="kitchen-ticket-progress">
          {remaining > 0 && <strong className="kitchen-tag" data-tone="waiting"><CookingPot size={15} aria-hidden="true"/> {portionCount.format(remaining)} {t("phần chờ ra")}</strong>}
          {awaitingCancellation && <strong className="kitchen-tag" data-tone="cancel"><CircleAlert size={15} aria-hidden="true"/> {t("Chờ xác nhận hủy")}</strong>}
          {!remaining && !awaitingCancellation && <strong className="kitchen-tag" data-tone="done"><CheckCheck size={15} aria-hidden="true"/> {t("Đã xử lý")}</strong>}
          {elapsed && <span className="kitchen-elapsed" data-overdue={overdue}><Clock size={15} aria-hidden="true"/> {t("Chờ")} {elapsed}</span>}
        </div>
        <ul className="kitchen-ticket-items">
        {ticket.items.map(item => {
          const waiting = isWaitingForService(item.status);
          const canceled = item.status === 'CANCELED';
          const confirmCancel = canceled && item.cancelReason && !item.cancelConfirmedAt;
          const timing = itemTiming(orderedAt, item.status, item.servedAt, now, language);
          const status = canceled ? (confirmCancel ? 'Chờ xác nhận hủy' : 'Đã hủy') : waiting ?
            (kitchenWaitingStatus[item.status] ?? 'Chờ ra món') : timing || 'Đã ra món';
          return <li className="kitchen-ticket-item" key={item.id} data-waiting={waiting} data-canceled={canceled}>
            <span className="kitchen-quantity">{portionCount.format(item.quantity)}×</span>
            <div className="kitchen-item-content">
              <strong className="kitchen-item-name">{item.name}</strong>
              {!!item.modifiers.length && <ul className="kitchen-modifiers">{item.modifiers.map((modifier, index) =>
                <li key={index}>{modifier}</li>)}</ul>}
              {item.note && <p className="kitchen-item-note"><StickyNote size={15} aria-hidden="true"/> {item.note}</p>}
              {canceled && item.cancelReason && <p className="kitchen-item-note" data-tone="cancel"><CircleAlert size={15} aria-hidden="true"/> {item.cancelReason}</p>}
              {item.status !== 'NEW' && <small className="kitchen-item-status">{t(status)}</small>}
            </div>
            {confirmCancel && <button type="button" className="kitchen-item-action" data-tone="cancel" disabled={action.pending}
              onClick={() => void action.send(`/kitchen/items/${item.id}/confirm-cancel`, undefined, { message: 'Bếp đã xác nhận hủy.' })}>{t("Xác nhận hủy")}</button>}
            {waiting && <button type="button" className="kitchen-item-action" data-tone="done" disabled={action.pending}
              onClick={() => void action.send(`/kitchen/items/${item.id}/transition`, { status: 'SERVED' }, { message: 'Đã xác nhận ra món.' })}>
              <Check size={17} aria-hidden="true"/> {t("Xác nhận đã ra món")}</button>}
          </li>;
        })}
        </ul>
      </article>;
    })}</div>}
    {(page > 1 || tickets.data?.length === 100) && <Pager page={page} full={tickets.data?.length === 100} onChange={setPage}/>}
    {printing && createPortal(<div className={`print-receipt kitchen-print kitchen-print-${paper}`}>
      <strong>{t("PHIẾU BẾP")}</strong><p>{printing.takeaway ? t("Mang về") : printing.tableName || 'Tại quầy'} · #{shortId(printing.orderId)}</p><p>{date(printing.orderedAt ?? printing.createdAt)}</p>
      {printing.items.map(item => <div className="kitchen-order-item" key={item.id}><strong>{item.quantity} × {item.name}{item.status === 'CANCELED' ? t("(Đã hủy)") : ''}</strong>
        {!!item.modifiers.length && <p>{item.modifiers.join(', ')}</p>}{item.note && <p>{item.note}</p>}
        {item.status === 'CANCELED' && item.cancelReason && <p>{t("Lý do ·")} {item.cancelReason}</p>}</div>)}
    </div>, document.body)}
  </section>;
}
