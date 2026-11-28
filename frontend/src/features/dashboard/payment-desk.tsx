'use client';

import Link from 'next/link';
import { BedDouble, IdCard, ReceiptText, Ticket } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Pager, Panel, State } from '@/components/business-ui';
import { useBusiness, useData } from '@/hooks/use-business';
import { useLanguage } from '@/i18n/language';
import { currency, date } from '@/lib/format';
import { usesMemberships, usesServiceCounter, type WorkspaceMode } from '@/types/business';
import { HotelFolio } from './hotel';
import { BillDetail, Bills } from './sales';
import { paymentMethodLabels, type PaymentMethod } from './service-payment';
import { TicketReceipt } from './tickets';

const categories = {
  GOODS: { label: 'Bán hàng hóa', Icon: ReceiptText },
  MEMBER: { label: 'Gói hội viên', Icon: IdCard, path: '/dashboard/members', action: 'Thu tiền gói' },
  HOTEL: { label: 'Tiền trả phòng', Icon: BedDouble, path: '/dashboard/hotel-rooms', action: 'Thu tiền và trả phòng' },
  TICKET: { label: 'Tiền vé', Icon: Ticket, path: '/dashboard/ticket-sales', action: 'Bán vé' },
} as const;
type Kind = keyof typeof categories;
type ServiceKind = Exclude<Kind, 'GOODS'>;
const statusLabels = { OPEN: 'Chờ thu tiền', PAID: 'Đã thanh toán', VOID: 'Đã hủy', REFUNDED: 'Đã hoàn tiền' } as const;
type HistoryRow = { id: string; occurredAt: string; amount: number; status: keyof typeof statusLabels } & (
  { source: 'GOODS' } | { source: ServiceKind; title: string; customer?: string; method?: PaymentMethod; packageName?: string; quantity?: number }
);
type History = { items: HistoryRow[]; hasMore: boolean };

export function PaymentDesk({ initialBill }: { initialBill?: string }) {
  const { mode } = useBusiness();
  return usesServiceCounter(mode) ? <ServicePaymentDesk mode={mode} initialBill={initialBill}/> : <Bills initialBill={initialBill}/>;
}

function ServicePaymentDesk({ mode, initialBill }: { mode: WorkspaceMode; initialBill?: string }) {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Kind | ''>(initialBill ? 'GOODS' : '');
  const [selected, setSelected] = useState<HistoryRow | { id: string; source: 'GOODS' } | undefined>(
    initialBill ? { id: initialBill, source: 'GOODS' } : undefined);
  const detail = useRef<HTMLDivElement>(null);
  const service = usesMemberships(mode) ? 'MEMBER' : mode === 'HOTEL' ? 'HOTEL' : 'TICKET';
  const serviceCategory = categories[service];
  const filters = [{ key: '', label: 'Tất cả' }, { key: 'GOODS', label: categories.GOODS.label }, { key: service, label: serviceCategory.label }] as const;
  const query = useData<History>(`/payment-history?page=${page}${filter ? `&source=${filter}` : ''}`, 8000);
  const rows = query.data?.items ?? [];
  const current = selected && (rows.find(row => row.id === selected.id && row.source === selected.source) ?? selected);
  const canCollect = ['OWNER', 'MANAGER', 'CASHIER'].includes(role);
  const actionPath = service === 'MEMBER' && role === 'OWNER' ? '/dashboard/company?tab=members' : serviceCategory.path;
  const actionLabel = service === 'MEMBER' && role === 'CASHIER' ? 'Thêm hội viên' : serviceCategory.action;

  useEffect(() => {
    if (initialBill && window.matchMedia('(max-width: 800px)').matches) detail.current?.scrollIntoView({ block: 'start' });
  }, [initialBill]);

  return <>
    <div className="business-settings-tabs" role="group" aria-label={t("Loại thanh toán")}>
      {filters.map(item => <button type="button" className="plain" key={item.key} aria-pressed={filter === item.key}
        onClick={() => { if (filter !== item.key) { setFilter(item.key); setPage(1); setSelected(undefined); } }}>{t(item.label)}</button>)}
    </div>
    <div className="payment-desk">
      <Panel title={t("Danh sách thanh toán")} action={canCollect && <Link className="plain" href={actionPath}>{t(actionLabel)}</Link>}>
        <State query={query} empty={query.isSuccess && !rows.length}/>
        <div className="bill-list">{rows.map(row => {
          const { Icon, label } = categories[row.source];
          const title = row.source === 'GOODS' ? `#${row.id.slice(-8).toUpperCase()}` :
            row.source === 'HOTEL' ? t("Phòng {0}", row.title) : row.title;
          return <button type="button" className="bill-list-row" key={`${row.source}:${row.id}`}
            aria-pressed={current?.id === row.id && current?.source === row.source} onClick={() => {
              setSelected(row);
              if (window.matchMedia('(max-width: 800px)').matches) window.requestAnimationFrame(() => detail.current?.scrollIntoView({ block: 'start' }));
            }}>
            <span className="bill-list-icon"><Icon size={18} aria-hidden="true"/></span>
            <span><strong>{title}</strong><small>{t(label)} · {date(row.occurredAt)}</small>
              {row.source !== 'GOODS' && row.customer && <small>{row.customer}</small>}</span>
            <span><strong>{currency.format(row.amount)}</strong>
              <small className={`badge bill-status-${row.status.toLowerCase()}`}>{t(statusLabels[row.status])}</small></span>
          </button>;
        })}</div>
        <Pager page={page} full={!!query.data?.hasMore} onChange={next => { setPage(next); setSelected(undefined); }}/>
      </Panel>
      <div className="payment-detail" ref={detail}>
        {current?.source === 'GOODS' ? <BillDetail key={current.id} id={current.id}/> : current ?
          <ServiceReceiptSummary key={`${current.source}:${current.id}`} row={current} canCollect={canCollect}/> :
          !!rows.length && <div className="card payment-empty"><ReceiptText size={28} aria-hidden="true"/><p>{t("Chọn một khoản để xem chi tiết thanh toán.")}</p></div>}
      </div>
    </div>
  </>;
}

function ServiceReceiptSummary({ row, canCollect }: { row: Extract<HistoryRow, { source: ServiceKind }>; canCollect: boolean }) {
  const { t } = useLanguage();
  const [receipt, setReceipt] = useState(false);
  const title = row.source === 'HOTEL' ? t("Phòng {0}", row.title) : row.title;
  return <>
    <Panel title={t("Chi tiết thanh toán")} action={<span className={`badge bill-status-${row.status.toLowerCase()}`}>{t(statusLabels[row.status])}</span>}>
      <div><strong>{title}</strong><small>{t(categories[row.source].label)} · #{row.id.slice(-8).toUpperCase()}</small></div>
      {row.customer && <div className="list-row"><span>{t("Khách hàng")}</span><strong>{row.customer}</strong></div>}
      {row.packageName && <div className="list-row"><span>{t("Gói lưu trú")}</span><strong>{row.packageName}</strong></div>}
      {row.quantity !== undefined && <div className="list-row"><span>{t("Số vé")}</span><strong>{row.quantity}</strong></div>}
      <div className="list-row"><span>{t("Thời gian thu")}</span><strong>{date(row.occurredAt)}</strong></div>
      {row.method && <div className="list-row"><span>{t("Phương thức thanh toán")}</span><strong>{t(paymentMethodLabels[row.method])}</strong></div>}
      <div className="list-row pos-total"><strong>{t(row.status === 'REFUNDED' ? 'Số tiền đã hoàn' : 'Đã thu')}</strong><strong>{currency.format(row.amount)}</strong></div>
      {canCollect && row.source !== 'MEMBER' && <div className="actions"><button type="button" className="plain" aria-haspopup="dialog"
        onClick={() => setReceipt(true)}>{t(row.source === 'TICKET' ? 'Xem hóa đơn và vé' : 'Xem phiếu thu tiền phòng')}</button></div>}
    </Panel>
    {receipt && row.source === 'TICKET' && <TicketReceipt id={row.id} close={() => setReceipt(false)}/>}
    {receipt && row.source === 'HOTEL' && <HotelFolio id={row.id} close={() => setReceipt(false)}/>}
  </>;
}
