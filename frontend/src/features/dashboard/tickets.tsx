'use client';

import { useLanguage } from '@/i18n/language';
import Link from 'next/link';
import { Printer, ScanLine, Ticket, UsersRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { currency, date, printReceipt, submit, value } from '@/lib/format';
import { paymentMethodLabels, ServicePaymentField, type PaymentMethod } from './service-payment';

import type { TicketType } from '@/types/tickets';
type TicketMode = 'GROUP' | 'SEPARATE';
type TicketSale = { id: string; typeName: string; quantity: number; unitPrice: number; amount: number; paidAt: string; paymentMethod: PaymentMethod;
  ticketMode?: TicketMode; buyerName?: string; buyerPhone?: string; refundedAt?: string };
type Admission = { id: string; code: string; typeName: string; entryQuantity?: number; usedAt: string };
type Receipt = TicketSale & { refund?: { reason: string; method: PaymentMethod }; tickets: { id: string; code: string; qr: string; entryQuantity?: number; usedAt?: string;
  admissionStartsAt?: string; admissionEndsAt?: string }[] };

const ticketModeLabels = { GROUP: 'Vé chung', SEPARATE: 'Vé riêng' } as const;
const ticketSaleMode = (sale: TicketSale) => sale.quantity === 1 ? 'Vé lẻ' :
  sale.ticketMode === 'GROUP' ? '1 vé chung' : `${sale.quantity} vé riêng`;

export function TicketSales() {
  const { t } = useLanguage();
  const types = useData<TicketType[]>('/ticket-types', 15000);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const sales = useData<TicketSale[]>(`/ticket-sales?page=${page}&q=${encodeURIComponent(search)}`, 10000);
  const action = useAction();
  const [quantity, setQuantity] = useState('1');
  const [ticketMode, setTicketMode] = useState<TicketMode>('GROUP');
  const [typeId, setType] = useState('');
  const [receipt, setReceipt] = useState<string>();
  const available = types.data?.filter(type => type.active) ?? [];
  const selected = available.find(type => type.id === typeId && type.saleState === 'OPEN' && type.remaining !== 0);
  const maxQuantity = Math.min(50, selected?.remaining ?? 50);
  const guestCount = Number(quantity);
  const validQuantity = Number.isInteger(guestCount) && guestCount >= 1 && guestCount <= maxQuantity;
  return <>
    <div className="service-split">
      <Panel title={t("Loại vé")} action={<Link className="plain" href="/dashboard/ticket-admissions"><ScanLine size={17}/> {t("Soát vé")}</Link>}>
        <State query={types}/>
        {types.isSuccess && !available.length && <p>{t("Chưa có loại vé đang bán.")}</p>}
        <div className="table-floor">{available.map(type => <button type="button" key={type.id} className="table-card service-option"
          disabled={type.saleState !== 'OPEN' || type.remaining === 0} aria-pressed={selected?.id === type.id} onClick={() => {
            setType(type.id);
            setQuantity('1');
          }}>
          <span className="table-card-icon"><Ticket size={20} aria-hidden="true"/></span>
          <span><strong>{type.name}</strong><small>{
            type.saleState === 'UPCOMING' ? `Mở bán ${type.saleStartsAt ? date(type.saleStartsAt) : ''}` :
              type.saleState === 'ENDED' ? t("Đã đóng bán") : type.remaining === 0 ? t("Hết vé") :
                type.remaining == null ? '' : `Còn ${type.remaining} vé`
          }</small></span>
          <span><strong>{currency.format(type.currentPrice)}</strong>{type.currentPrice < type.price && <small>{t("Giá mua sớm")}</small>}</span>
        </button>)}</div>
      </Panel>
      <Panel title={t("Thanh toán vé")} className="service-side">
      {!!available.length && <form onSubmit={event => submit(event, (form, element) => {
        if (!selected || !validQuantity) return;
        void action.send<TicketSale>('/ticket-sales', { typeId: selected.id, quantity: guestCount, expectedPrice: selected.currentPrice,
          ticketMode: guestCount > 1 ? ticketMode : undefined,
          paymentMethod: value(form, 'paymentMethod'), buyerName: value(form, 'buyerName') || undefined,
          buyerPhone: value(form, 'buyerPhone') || undefined },
          { idempotent: true, reset: element, message: 'Đã ghi nhận và phát hành vé.' }).then(result => {
          if (result) { setQuantity('1'); setTicketMode('GROUP'); setPage(1); setReceipt(result.id); } else void types.refetch();
        });
      })}>
        <p>{selected ? <strong>{selected.name}</strong> : t("Chọn loại vé để tiếp tục.")}</p>
        <label>{t("Số khách")}<input type="number" min={1} max={maxQuantity} value={quantity} onChange={event => setQuantity(event.target.value)} required/></label>
        {selected && validQuantity && guestCount > 1 && <fieldset className="ticket-mode-choices" disabled={action.pending}>
          <legend>{t("Cách phát hành")}</legend>
          <label className="ticket-mode-choice">
            <input type="radio" name="ticketMode" checked={ticketMode === 'GROUP'} onChange={() => setTicketMode('GROUP')}/>
            <span><strong>{ticketModeLabels.GROUP}</strong><small>{t("1 mã QR cho")} {guestCount} {t("khách. Quét một lần khi cả nhóm vào.")}</small></span>
          </label>
          <label className="ticket-mode-choice">
            <input type="radio" name="ticketMode" checked={ticketMode === 'SEPARATE'} onChange={() => setTicketMode('SEPARATE')}/>
            <span><strong>{ticketModeLabels.SEPARATE}</strong><small>{guestCount} {t("mã QR, mỗi khách một mã để vào riêng.")}</small></span>
          </label>
        </fieldset>}
        <div className="columns"><label>{t("Tên người mua")}<input name="buyerName" maxLength={120}/></label>
          <label>{t("Số điện thoại")}<input name="buyerPhone" type="tel" maxLength={16} pattern={'[+]?[0-9]{7,15}'}/></label></div>
        <ServicePaymentField/>
        {selected && validQuantity && <div className="list-row pos-total"><span>{t("Tiền cần thu")}<small>{guestCount} {t("khách ×")} {currency.format(selected.currentPrice)}</small></span>
          <strong>{currency.format(selected.currentPrice * guestCount)}</strong></div>}
        <button type="submit" className="button" disabled={!selected || !validQuantity || action.pending}><Ticket size={17}/> {t("Xác nhận đã thu và phát hành")}</button>
      </form>}{action.feedback}
      </Panel>
    </div>
    <Panel title={t("Lịch sử bán vé")}>
      <label>{t("Tìm lượt bán")}<input type="search" value={search} maxLength={120} placeholder={t("Tên loại vé, người mua, điện thoại hoặc mã vé")}
        onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
      <State query={sales} empty={sales.data?.length === 0}/>
      {sales.data?.map(sale => <div className="list-row service-list-row" key={sale.id}>
        <div><strong>{sale.typeName} · {sale.quantity} {t("khách")}</strong><small>{t(ticketSaleMode(sale))} · {date(sale.paidAt)} · {t(paymentMethodLabels[sale.paymentMethod])}</small>
          {(sale.buyerName || sale.buyerPhone) && <small>{[sale.buyerName, sale.buyerPhone].filter(Boolean).join(' · ')}</small>}
          <small>{currency.format(sale.amount)}{sale.refundedAt && ' · Đã hoàn'}</small></div>
        <button type="button" className="plain" onClick={() => setReceipt(sale.id)}>{t("Xem hóa đơn và vé")}</button>
      </div>)}
      <Pager page={page} full={sales.data?.length === 50} onChange={setPage}/>
    </Panel>
    {receipt && <TicketReceipt id={receipt} close={() => setReceipt(undefined)}/>}
  </>;
}

function admissionWindow(ticket: Receipt['tickets'][number]) {
  return [
    ticket.admissionStartsAt && `Vào từ ${date(ticket.admissionStartsAt)}`,
    ticket.admissionEndsAt && `Đến ${date(ticket.admissionEndsAt)}`,
  ].filter(Boolean).join(' · ');
}

export function TicketReceipt({ id, close }: { id: string; close: () => void }) {
  const { t } = useLanguage();
  const { branch, role } = useBusiness();
  const query = useData<Receipt>(`/ticket-sales/${id}`, 5000);
  const action = useAction();
  const [refunding, setRefunding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const receipt = query.data;
  const groupTicket = receipt?.tickets.length === 1 && (receipt.tickets[0].entryQuantity ?? 1) > 1;
  async function print() {
    flushSync(() => setPrinting(true));
    try { await printReceipt(); } finally { setPrinting(false); }
  }
  const canRefund = receipt && !receipt.refundedAt && receipt.tickets.length > 0 && receipt.tickets.every(ticket => !ticket.usedAt) &&
    (role === 'OWNER' || role === 'MANAGER');
  return <BusinessDialog title={t("Hóa đơn và vé")} close={close} pending={printing || action.pending}>
    <State query={query}/>
    {receipt && <>
      <div className="list-row"><div><strong>{receipt.typeName} · {receipt.quantity} {t("khách")}</strong>
        <small>{t(ticketSaleMode(receipt))} · {currency.format(receipt.unitPrice)}{t("/khách")}</small>
        <small>{date(receipt.paidAt)} · {t(paymentMethodLabels[receipt.paymentMethod])}</small></div>
        <strong>{currency.format(receipt.amount)}</strong></div>
      {receipt.refundedAt ? <div className="list-row"><div><strong>{t("Đã hoàn tiền ·")} {date(receipt.refundedAt)}</strong>
        {receipt.refund && <small>{t(paymentMethodLabels[receipt.refund.method])} · {receipt.refund.reason}</small>}</div></div> : <>
      <div className="actions">
        <button type="button" className="button" disabled={printing || action.pending} onClick={() => void print()}><Printer size={17}/>
          {groupTicket ? t("In hóa đơn và vé chung") : receipt.tickets.length > 1 ? t("In các vé riêng") : t("In vé")}</button>
        {canRefund && <button type="button" className="plain" disabled={action.pending} onClick={() => setRefunding(!refunding)}>
          {refunding ? t("Đóng phiếu hoàn") : t("Hoàn toàn bộ lượt bán")}
        </button>}
      </div>
      {canRefund && refunding && <form onSubmit={event => submit(event, form => {
        void action.send(`/ticket-sales/${id}/refund`, { reason: value(form, 'reason'), method: value(form, 'paymentMethod') },
          { idempotent: true, message: 'Đã ghi nhận hoàn vé.' }).then(result => {
          if (result) setRefunding(false);
          else void query.refetch();
        });
      })}>
        <p>{t("Hoàn")} {currency.format(receipt.amount)} {t("và vô hiệu hóa")} {receipt.tickets.length} {t("mã vé.")}</p>
        <label>{t("Lý do hoàn")}<input name="reason" maxLength={120} required/></label>
        <ServicePaymentField neutral/>
        <button type="submit" className="button" disabled={action.pending}>{receipt.amount ? t("Xác nhận đã trả tiền và hoàn vé") : t("Xác nhận hoàn vé")}</button>
      </form>}
      <div className="service-ticket-grid">{receipt.tickets.map(ticket => <div key={ticket.id} className="service-ticket">
        <strong>{(ticket.entryQuantity ?? 1) > 1 ? `Vé chung · ${ticket.entryQuantity} khách` : t("1 khách")}</strong>
        <img src={ticket.qr} alt={t("Mã QR của vé")} width={100} height={100}/>
        <code>{ticket.code}</code><small>{ticket.usedAt ? `Đã soát ${date(ticket.usedAt)}` : t("Chưa soát")}</small>
        {admissionWindow(ticket) && <small>{admissionWindow(ticket)}</small>}
      </div>)}</div></>}
      {printing && !receipt.refundedAt && createPortal(<div className="print-receipt admission-print">
        {receipt.tickets.map((ticket, index) => <article key={ticket.id}>
          <strong>{branch.name}</strong>
          <strong>{groupTicket ? t("HÓA ĐƠN VÀ VÉ CHUNG") : receipt.tickets.length > 1 ? `VÉ ${index + 1}/${receipt.tickets.length}` : t("VÉ VÀO CỬA")}</strong>
          <span>{receipt.typeName} · {ticket.entryQuantity ?? 1} {t("khách")}</span>
          <span>{date(receipt.paidAt)}</span>
          {groupTicket && <><span>{receipt.quantity} × {currency.format(receipt.unitPrice)}</span>
            <strong>{t("Đã thu")} {currency.format(receipt.amount)}</strong><span>{t(paymentMethodLabels[receipt.paymentMethod])}</span></>}
          <img src={ticket.qr} alt={t("Mã QR của vé")} width={120} height={120}/><code>{ticket.code}</code>
          {admissionWindow(ticket) && <span>{admissionWindow(ticket)}</span>}
          {ticket.usedAt && <strong>{t("Vé đã soát")}</strong>}
        </article>)}
      </div>, document.body)}
    </>}{action.feedback}
  </BusinessDialog>;
}

export function TicketAdmissions() {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const query = useData<Admission[]>(`/ticket-admissions?page=${page}`, 8000);
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [last, setLast] = useState<Admission>();
  return <div className="service-split service-entry">
    <Panel title={t("Kiểm tra vé vào cửa")} className="service-side">
      <form onSubmit={event => submit(event, (form, element) => {
        if (action.pending) return;
        setLast(undefined);
        void action.send<Admission>('/ticket-admissions', { code: value(form, 'code') },
          { idempotent: true, reset: element, message: 'Vé hợp lệ. Đã ghi nhận lượt vào.' }).then(result => {
          if (result) { setLast(result); setPage(1); }
          input.current?.focus();
          if (!result) input.current?.select();
        });
      })}>
        <label>{t("Mã vé")}<input ref={input} name="code" placeholder={t("Quét QR bằng đầu đọc hoặc nhập mã vé")} autoComplete="off" spellCheck={false} autoCapitalize="characters" maxLength={23} required/></label>
        <button type="submit" className="button" disabled={action.pending}><ScanLine size={17}/> {t("Soát vé")}</button>
      </form>{action.feedback}
      {last && <div className="list-row"><div><strong>{last.typeName}</strong><small className="ticket-admitted-count">
        <UsersRound size={15} aria-hidden="true"/> {t("Đã ghi nhận")} {last.entryQuantity ?? 1} {t("khách")}</small></div><time dateTime={last.usedAt}>{date(last.usedAt)}</time></div>}
    </Panel>
    <Panel title={t("Vé đã soát")}>
      <State query={query} empty={query.data?.length === 0}/>
      {query.data?.map(ticket => <div className="list-row service-list-row" key={ticket.id}>
        <div><strong>{ticket.typeName} · {ticket.entryQuantity ?? 1} {t("khách")}</strong><small><code>{ticket.code}</code></small></div><time dateTime={ticket.usedAt}>{date(ticket.usedAt)}</time>
      </div>)}
      <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    </Panel>
  </div>;
}
