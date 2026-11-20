'use client';

import Link from 'next/link';
import { ArrowRight, ChefHat, Coffee, LayoutGrid, QrCode, Store, Utensils } from 'lucide-react';
import { State } from '@/components/business-ui';
import { useBusiness, useData } from '@/hooks/use-business';
import { currency, date } from '@/lib/format';
import { elapsedTime, useOrderClock } from '@/lib/order-timing';
import { tableMenuHref, tableState, type KitchenSummary, type TableResponse } from '@/types/business';
import { branchNames, canView, dashboardHref, managementHref, navigation, sectionTitle, type Section } from './navigation';

type RecentOrders = { id: string; status: string; totalAmount: number; createdAt: string }[];
const statusNames: Record<string, string> = { PLACED: 'Chờ xác nhận', ACCEPTED: 'Đã nhận', COMPLETED: 'Đã thanh toán', CANCELED: 'Đã hủy' };

function Shortcuts({ sections }: { sections: Section[] }) {
  const { role, mode } = useBusiness();
  const visible = sections.filter(section => canView(section, role, mode));
  if (!visible.length) return null;
  return <div className="desk-shortcuts">{visible.map(section => {
    const Icon = navigation[section].icon;
    return <Link key={section} className="card desk-shortcut" href={dashboardHref(section)}>
      <span className="desk-shortcut-icon"><Icon size={20}/></span><strong>{sectionTitle(section, mode)}</strong><ArrowRight size={16}/>
    </Link>;
  })}</div>;
}

export function RetailHome() {
  const { branch, role } = useBusiness();
  const recent = useData<RecentOrders>('/orders?page=1&source=POS', undefined, canView('orders', role));
  const firstAction: Section | undefined = (['pos', 'orders', 'payments'] as const).find(section => canView(section, role));
  return <div className="desk-home service-workspace">
    <header className="business-heading">
      <div><p className="business-heading-context"><Store size={16}/> Bán lẻ</p><h1>{branch.name}</h1></div>
      {firstAction && <Link className="button" href={dashboardHref(firstAction)}>{firstAction === 'pos' ? 'Mở quầy bán hàng' : sectionTitle(firstAction, 'RETAIL')}<ArrowRight size={17}/></Link>}
    </header>
    <Shortcuts sections={['pos', 'payments']}/>
    {canView('orders', role) && <section className="card">
      <div className="desk-section-header"><h2>Đơn tại quầy gần đây</h2><Link className="plain" href="/dashboard/orders">Mở đơn hàng <ArrowRight size={15}/></Link></div>
      <State query={recent} empty={recent.data?.length === 0}/>
      {recent.data?.slice(0, 5).map(order => <div className="list-row desk-recent-order" key={order.id}>
        <div><strong>#{order.id.slice(-8).toUpperCase()}</strong><small>{date(order.createdAt)}</small></div>
        <span className="badge">{statusNames[order.status] ?? order.status}</span>
        <strong>{currency.format(order.totalAmount)}</strong>
      </div>)}
    </section>}
  </div>;
}

export function RestaurantHome() {
  const { branch, role, mode } = useBusiness();
  const cafe = mode === 'CAFE';
  const Icon = cafe ? Coffee : Utensils;
  const canSeeTables = canView('tables', role);
  const canSeeKitchen = canView('kitchen', role);
  const kitchenView = ['WAITER', 'CASHIER'].includes(role) ? 'service' : 'kitchen';
  const tables = useData<TableResponse>('/tables', 15000, canSeeTables);
  const kitchen = useData<KitchenSummary>(`/kitchen/preparation-summary?view=${kitchenView}`, 15000, canSeeKitchen);
  const data = tables.data;
  const sessions = new Map(data?.sessions.map(session => [session.id, session]));
  const now = useOrderClock(sessions.size > 0);
  const floor = data?.tables.map(table => {
    const session = table.sessionId ? sessions.get(table.sessionId) : undefined;
    return { table, state: tableState(table, session), duration: session?.createdAt ? elapsedTime(session.createdAt, now) : '' };
  });
  const count = (key: string) => floor?.filter(item => item.state.key === key).length ?? 0;
  const waitingForPayment = count('payment') + count('billed');
  const restaurantsAction = (['tables', 'kitchen', 'payments'] as const).find(section => canView(section, role));
  return <div className="desk-home restaurant-home service-workspace">
    <header className="business-heading">
      <div><p className="business-heading-context"><Icon size={17}/> {branchNames[mode]}</p><h1>{branch.name}</h1></div>
      {restaurantsAction && <Link className="button" href={dashboardHref(restaurantsAction)}>
        {restaurantsAction === 'tables' ? 'Mở sơ đồ bàn' : sectionTitle(restaurantsAction, mode)} <ArrowRight size={17}/>
      </Link>}
    </header>
    <div className={canSeeTables && canSeeKitchen ? 'restaurant-status-grid' : ''}>
      {canSeeTables && <section className="card table-preview">
        <div className="desk-section-header"><h2><LayoutGrid size={18}/> Sơ đồ bàn</h2>
          <Link className="plain" href="/dashboard/tables">Quản lý bàn <ArrowRight size={15}/></Link></div>
        <State query={tables}/>
        {data && <><div className="table-legend">
          <span className="table-ready"><i/> {count('ready')} bàn trống</span>
          <span className="table-serving"><i/> {count('serving')} bàn đang ăn</span>
          {waitingForPayment > 0 && <span className="table-billed"><i/> {waitingForPayment} bàn đợi tính tiền hoặc thanh toán</span>}
          <span className="table-reserved"><i/> {count('reserved')} bàn đặt trước</span>
        </div>
        {!data.tables.length && <p className="muted">Chi nhánh chưa có bàn. {role === 'OWNER' && <Link className="plain" href="/dashboard/company?tab=tables">Thêm bàn trong Quản lý doanh nghiệp</Link>}</p>}
        <div className="table-preview-grid">{floor?.slice(0, 12).map(({ table, state, duration }) => <Link href={tableMenuHref(table)} key={table.id}
            className={`table-${state.key}`}>
          <LayoutGrid size={17}/><strong>{table.name}</strong><small>{state.label}</small>
          {duration && <small className="table-card-duration">{duration}</small>}
        </Link>)}</div></>}
      </section>}
      {canSeeKitchen && <section className="card restaurant-kitchen-preview">
        <div className="desk-section-header"><h2><ChefHat size={19}/> {cafe ? 'Đồ uống pha chế' : 'Món trong bếp'}</h2></div>
        <State query={kitchen}/>
        {kitchen.data && <div className="list-row"><span>Phần chưa ra</span><strong>{kitchen.data.totalQuantity.toLocaleString('vi-VN')}</strong></div>}
        <Link className="button" href="/dashboard/kitchen">{cafe ? 'Mở màn hình pha chế' : 'Vào màn hình bếp'} <ArrowRight size={16}/></Link>
      </section>}
    </div>
    <Shortcuts sections={['pos', 'payments']}/>
    {canSeeTables && tables.error && canView('subscription', role) && <Link className="plain" href={managementHref('subscription')}><QrCode size={17}/> Xem tính năng trong gói hiện tại</Link>}
  </div>;
}
