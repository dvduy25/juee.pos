'use client';

import { useLanguage } from '@/i18n/language';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useBusiness, useData } from '@/hooks/use-business';
import { currency, date } from '@/lib/format';

type CanceledOrder = { id: string; status: string; source: 'POS' | 'QR'; tableName?: string; takeaway?: boolean; createdAt: string; reason?: string };
type HistoryRow = CanceledOrder & { names: string[]; quantity: number };
type Cancellation = { at?: string; by?: string };
type OrderDetail = CanceledOrder & { totalAmount: number; cancellation?: Cancellation; items: {
  id: string; name: string; quantity: number; unitPrice: number; note?: string; modifiers: { name: string }[];
  canceled: boolean; reason?: string; cancellation?: Cancellation; kitchen?: { confirmedAt?: string };
}[] };

function orderLocation(order: CanceledOrder) {
  if (order.takeaway) return 'Mang về';
  if (order.tableName) return order.source === 'QR' ? `${order.tableName} · QR` : order.tableName;
  return order.source === 'QR' ? 'Gọi món QR' : 'Tại quầy';
}

export function CancellationHistory() {
  const { t } = useLanguage();
  const { branch } = useBusiness();
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string>();
  const history = useData<{ orders: HistoryRow[]; hasMore: boolean }>(`/company/cancellations?kind=${kind}&page=${page}`, 10000);
  return <Panel title={`Lịch sử hủy · ${branch.name}`} action={<label>{t("Loại hủy")}<select value={kind} onChange={event => {
    setKind(event.target.value); setPage(1);
  }}>
    <option value="all">{t("Tất cả")}</option><option value="orders">{t("Đơn đã hủy")}</option><option value="items">{t("Có món bị hủy")}</option>
  </select></label>}>
    <State query={history}/>
    {history.data?.orders.length === 0 && <p className="muted">{t("Chưa có đơn hoặc món đã hủy theo bộ lọc này.")}</p>}
    {!!history.data?.orders.length && <div className="company-table-wrap"><table className="company-table">
      <thead><tr><th scope="col">{t("Đơn hàng")}</th><th scope="col">{t("Nội dung hủy")}</th><th scope="col">{t("Chi tiết")}</th></tr></thead>
      <tbody>{history.data.orders.map(order => <tr key={order.id}>
        <th scope="row">#{order.id.slice(-8).toUpperCase()}<small>{orderLocation(order)}</small><small>{t("Đặt lúc")} {date(order.createdAt)}</small></th>
        <td><span className="badge warning">{order.status === 'CANCELED' ? t("Đơn đã hủy") : t("Đã hủy món")}</span>
          {order.quantity > 0 && <small>SL {order.quantity} · {order.names.slice(0, 3).join(', ')}
            {order.names.length > 3 && ` +${order.names.length - 3} món`}</small>}
          {order.reason && <small>{order.reason}</small>}</td>
        <td><button className="plain" type="button" onClick={() => setSelected(order.id)}
          aria-label={`Xem chi tiết đơn ${order.id.slice(-8).toUpperCase()}`}>{t("Xem chi tiết")}</button></td>
      </tr>)}</tbody>
    </table></div>}
    {(page > 1 || history.data?.hasMore) && <Pager page={page} full={history.data?.hasMore === true} onChange={setPage}/>}
    {selected && <BusinessDialog title={`Chi tiết đơn #${selected.slice(-8).toUpperCase()}`} close={() => setSelected(undefined)}>
      <CancellationDetail id={selected}/>
    </BusinessDialog>}
  </Panel>;
}

function CancellationDetail({ id }: { id: string }) {
  const { t } = useLanguage();
  const query = useData<OrderDetail>(`/company/cancellations/${id}`, 10000);
  const order = query.data;
  return <><State query={query}/>{order && <>
    <div className="list-row"><div><strong>{orderLocation(order)}</strong><small>{t("Đặt lúc")} {date(order.createdAt)}</small></div>
      <span className="badge warning">{order.status === 'CANCELED' ? t("Đơn đã hủy") : t("Có món đã hủy")}</span></div>
    {order.reason && <p>{t("Lý do hủy ·")} {order.reason}</p>}
    {order.cancellation?.at && <p className="muted">{t("Hủy gần nhất lúc")} {date(order.cancellation.at)}{order.cancellation.by && ` · ${order.cancellation.by}`}</p>}
    <h3>{t("Món và hàng hóa trong đơn")}</h3>
    {order.items.map(item => <div className="list-row service-list-row" data-canceled={item.canceled} key={item.id}>
      <div><strong>{item.name} × {item.quantity}</strong><small>{t("Đơn giá")} {currency.format(item.unitPrice)}</small>
        {item.modifiers?.length > 0 && <small>{item.modifiers.map(option => option.name).join(', ')}</small>}
        {item.note && <small>{t("Ghi chú ·")} {item.note}</small>}
        {item.reason && <small>{t("Lý do hủy ·")} {item.reason}</small>}
        {item.cancellation?.at && <small>{t("Hủy lúc")} {date(item.cancellation.at)}{item.cancellation.by && ` · ${item.cancellation.by}`}</small>}
        {item.kitchen && <small>{item.kitchen.confirmedAt ? `Bếp đã xác nhận lúc ${date(item.kitchen.confirmedAt)}` : t("Bếp chờ xác nhận hủy")}</small>}
      </div>
      <span className={`badge${item.canceled ? ' warning' : ''}`}>{item.canceled ? t("Đã hủy") : t("Còn trong đơn")}</span>
    </div>)}
    {order.status !== 'CANCELED' && <div className="list-row"><span>{t("Tổng tiền đơn hiện tại")}</span><strong>{currency.format(order.totalAmount)}</strong></div>}
  </>}</>;
}
