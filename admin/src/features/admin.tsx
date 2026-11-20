'use client';

import { useContext, useDeferredValue, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { DeveloperConsole } from './developer';
import { Activity, ArrowLeft, ArrowRight, Banknote, Building2, CalendarClock, ClipboardList, CreditCard, Search, Users } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AreaChart, Area, CartesianGrid, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { api } from '@/services/api-client';
import { BusinessDialog } from '@/components/business-dialog';
import { AdminWriteContext } from './admin-layout';
import { AdminProfile, ContractBadge } from './admin-profile';
import { branchNames, auditLabels, contractStates, date, dateTime, editableStates, labels, number, vnd, type AdminAction, type AdminFilters, type Profile, type Row } from './admin-data';
import { sections } from './sections';

export function Admin({ section, filters }: { section: string; filters: AdminFilters }) {
  if (section === 'dashboard' || section === 'revenue') return <Revenue section={section}/>;
  if (section === 'status') return <SystemStatus/>;
  if (section === 'developer') return <DeveloperConsole/>;
  return <Directory section={section} initial={filters}/>;
}

function SystemStatus() {
  const query = useQuery({ queryKey: ['platform', 'status'], queryFn: () => api<{ api: string; database: string; checkedAt: string }>('/platform/status'),
    refetchInterval: 30000 });
  return <section className="card"><h1>Trạng thái hệ thống</h1>
    {query.error && <p className="error" role="alert">{query.error.message}</p>}
    {query.isLoading && <div className="skeleton"/>}
    {query.data && <><div className="list-row">API<strong>{query.data.api === 'up' ? 'Đang hoạt động' : 'Gián đoạn'}</strong></div>
      <div className="list-row">MongoDB<strong>{query.data.database === 'up' ? 'Đã kết nối' : 'Gián đoạn'}</strong></div>
      <p className="muted">Cập nhật {new Date(query.data.checkedAt).toLocaleString('vi-VN')}</p></>}
  </section>;
}

type RevenueData = {
  tenants: number; branches: number; users: number; paid: number; active: number; canceled: number;
  newThisMonth: number; free: number; trial: number; totalCollected: string; today: string; month: string; year: string; mrr: string; arr: string;
  series: { month: string; amount: string }[];
  requests?: number; expiring?: number; expired?: number; lockedUsers?: number; lockedTenants?: number; expiringDays?: number; registrations?: Row[];
};

function Revenue({ section }: { section: string }) {
  const query = useQuery({ queryKey: ['platform', section], queryFn: () => api<RevenueData>(`/platform/${section}`) });
  const data = query.data;
  return <>
    <div className="page-heading"><div><h1>{section === 'dashboard' ? 'Tổng quan nền tảng' : 'Doanh thu thuê bao'}</h1>
      <p>Theo dõi doanh nghiệp và hoạt động thuê bao JUEE POS.</p></div></div>
    {query.isLoading && <div className="card skeleton" aria-label="Đang tải"/>}
    {query.error && <p className="error" role="alert">{query.error.message}</p>}
    {data && <>
      {section === 'dashboard' && <>
        <section className="card platform-overview"><h2>Cần theo dõi</h2><div className="platform-work-grid">
          {[
            { title: 'Yêu cầu gói đang chờ', href: '/super-admin/subscriptions?status=REQUESTED', count: data.requests, icon: ClipboardList },
            { title: `Hết hạn trong ${data.expiringDays ?? 7} ngày`, href: '/super-admin/subscriptions?status=EXPIRING', count: data.expiring, icon: CalendarClock },
            { title: 'Thuê bao đã hết hạn', href: '/super-admin/subscriptions?status=EXPIRED', count: data.expired, icon: CreditCard },
            { title: 'Tài khoản đã khóa', href: '/super-admin/users?status=locked', count: data.lockedUsers, icon: Users },
            { title: 'Doanh nghiệp đã khóa', href: '/super-admin/tenants?status=locked', count: data.lockedTenants, icon: Building2 },
          ].map(({ title, href, count, icon: Icon }) => <Link className="platform-work-item" href={href} key={href}>
            <span className="metric-icon"><Icon size={17} aria-hidden="true"/></span><span><small>{title}</small><strong>{number.format(count ?? 0)}</strong></span>
            <ArrowRight size={15} aria-hidden="true"/>
          </Link>)}
        </div></section>
        <section className="card platform-overview"><header className="desk-section-header">
          <h2>Tài khoản mới đăng ký</h2><Link className="plain" href="/super-admin/users">Xem tất cả</Link>
        </header>
          {!data.registrations?.length && <p className="muted">Chưa có tài khoản.</p>}
          {data.registrations?.map(user => <div className="list-row" key={user.id}>
            <div><Link className="platform-link" href={`/super-admin/users?id=${user.id}`}>{user.name}</Link>
              <small>{user.email} · {user.emailVerifiedAt ? 'Đã xác minh email' : 'Chưa xác minh email'}</small></div>
            <span>{dateTime(user.createdAt)}</span>
          </div>)}
        </section>
      </>}
      <div className="metrics">
        {[
          { name: 'MRR', value: vnd.format(BigInt(data.mrr)), icon: Banknote, sub: 'Doanh thu định kỳ tháng' },
          { name: 'ARR', value: vnd.format(BigInt(data.arr)), icon: Activity, sub: 'MRR quy đổi theo năm' },
          { name: 'Doanh nghiệp', value: number.format(data.tenants), icon: Building2, sub: `${data.branches} chi nhánh` },
          { name: 'Thuê bao trả phí', value: number.format(data.paid), icon: CreditCard, sub: `${data.active} thuê bao đang hoạt động` },
          { name: 'Tài khoản', value: number.format(data.users), icon: Users, sub: 'Tổng số tài khoản đã đăng ký' },
        ].map(({ name, value, icon: Icon, sub }) => <div className="card metric" key={name}>
          <div className="metric-label">{name}<span className="metric-icon"><Icon size={17}/></span></div>
          <strong>{value}</strong><p>{sub}</p>
        </div>)}
      </div>
      <div className="columns analytics"><section className="card"><h2>Thực thu theo tháng</h2>
        <div className="chart"><ResponsiveContainer width="100%" height={270}>
          <AreaChart data={data.series.map(item => ({ ...item, amount: Number(item.amount) }))} margin={{ left: 4, right: 16, top: 12 }}>
            <defs><linearGradient id="income" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7563e8" stopOpacity={0.35}/><stop offset="100%" stopColor="#7563e8" stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid strokeDasharray="4 4" vertical={false}/><XAxis dataKey="month"/><YAxis width={70} tickFormatter={value => number.format(value)}/>
            <Tooltip formatter={value => [vnd.format(Number(value)), 'Thực thu']}/>
            <Area dataKey="amount" type="monotone" stroke="#7563e8" strokeWidth={2} fill="url(#income)"/>
          </AreaChart>
        </ResponsiveContainer></div></section>
        <section className="card"><h2>Thực thu</h2>
          {[['Tổng thực thu', data.totalCollected], ['Hôm nay', data.today], ['Tháng này', data.month], ['Năm nay', data.year]].map(([name, value]) =>
            <div className="list-row" key={name}><span>{name}</span><strong>{vnd.format(BigInt(value))}</strong></div>)}
          <h2 className="section-title">Thuê bao</h2>
          <div className="list-row"><span>Mới trong tháng và còn hoạt động</span><strong>{data.newThisMonth}</strong></div>
          <div className="list-row"><span>Đang dùng gói Free</span><strong>{data.free}</strong></div>
          <div className="list-row"><span>Đang dùng thử</span><strong>{data.trial}</strong></div>
          <div className="list-row"><span>Đã hủy</span><strong>{data.canceled}</strong></div>
        </section>
      </div>
    </>}
  </>;
}

type Page = { items: Row[]; total: number; page: number; take: number };
const headers: Record<string, string[]> = {
  users: ['Họ tên / Email', 'Điện thoại', 'Doanh nghiệp', 'Ngày đăng ký', 'Lần đăng nhập cuối', 'Trạng thái'],
  tenants: ['Doanh nghiệp', 'Chi nhánh', 'Thành viên', 'Gói dịch vụ', 'Hết hạn', 'Trạng thái doanh nghiệp'],
  branches: ['Chi nhánh', 'Doanh nghiệp', 'Mô hình', 'Ngày tạo'],
  plans: ['Gói', 'Phiên bản', 'Giá tháng', 'Chi nhánh', 'Nhân sự', 'Đang dùng', 'Hiển thị'],
  subscriptions: ['Doanh nghiệp', 'Gói', 'Bắt đầu', 'Hết hạn', 'Trạng thái'],
  invoices: ['Doanh nghiệp', 'Mã giao dịch', 'Số tiền', 'Ngày nhận'],
  notifications: ['Tiêu đề', 'Loại', 'Người đăng', 'Ngày đăng'],
  'audit-logs': ['Thao tác', 'Người thực hiện', 'Đối tượng', 'Lý do', 'Ngày'],
};

function cells(section: string, row: Row) {
  const revision = row.revisions?.[0];
  const locked = <span className={`badge ${row.locked ? 'warning' : ''}`}>{row.locked ? 'Đã khóa' : 'Hoạt động'}</span>;
  switch (section) {
    case 'users': return [<><strong>{row.name}</strong><small>{row.email}</small><small>{row.emailVerifiedAt ? 'Email đã xác minh' : 'Email chưa xác minh'}</small>
      {row.platformAccount && <small>Quản trị nền tảng</small>}</>,
      row.phone ?? '—', row._count?.memberships, date(row.createdAt), date(row.lastLoginAt), locked];
    case 'tenants': return [<><strong>{row.name}</strong><small>Đăng ký {date(row.createdAt)}</small></>, row._count?.branches, row._count?.memberships,
      row.subscriptions?.[0] ? <>{row.subscriptions[0].planVersion?.plan?.name}<small><ContractBadge row={row.subscriptions[0]}/></small></> : 'Chưa có gói',
      date(row.subscriptions?.[0]?.expiresAt), locked];
    case 'branches': return [row.name, row.tenantName, branchNames[row.mode as keyof typeof branchNames] ?? row.mode, date(row.createdAt)];
    case 'plans': return [<><strong>{row.name}</strong><small>{row.code} · {row.id}</small></>, revision?.version, vnd.format(BigInt(revision?.monthlyVnd ?? '0')),
      revision?.maxBranches, revision?.maxStaff, row.activeTenants, row.published ? 'Đang bán' : 'Đã ẩn'];
    case 'subscriptions': return [<><strong>{row.tenant?.name}</strong>{row.tenant?.locked && <small>Doanh nghiệp đã khóa</small>}</>,
      <>{row.planVersion?.plan?.name}{row.simulated && <small>Đăng ký mô phỏng</small>}
        {row.requestedPlanVersion && <small>Yêu cầu {row.requestedPlanVersion.plan?.name} · {vnd.format(BigInt(row.requestedPlanVersion.monthlyVnd))}/tháng
          {row.requestedAt && <> · {dateTime(row.requestedAt)}</>}</small>}
        {row.rejectedRequest && <small>Yêu cầu gần nhất đã bị từ chối</small>}</>,
      row.status === 'PENDING' ? '—' : date(row.startsAt), date(row.expiresAt), <ContractBadge row={row}/>];
    case 'invoices': return [row.subscription?.tenant?.name, row.reference, vnd.format(BigInt(row.amountVnd ?? '0')), dateTime(row.paidAt)];
    case 'notifications': return [row.title, row.kind, row.actorId, date(row.publishedAt)];
    default: return [<><strong>{auditLabels[row.action ?? ''] ?? row.action}</strong><small>{row.action}</small></>,
      row.actor ? <>{row.actor.name}<small>{row.actor.email}</small></> : row.actorId, row.targetId, row.reason, dateTime(row.createdAt)];
  }
}

function Directory({ section, initial }: { section: string; initial: AdminFilters }) {
  const write = useContext(AdminWriteContext);
  const stateOptions = section === 'subscriptions' ? Object.entries(contractStates) : [['active', 'Hoạt động'], ['locked', 'Đã khóa']];
  const [search, setSearch] = useState(initial.q ?? '');
  const delayedSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(stateOptions.some(([key]) => key === initial.status) ? initial.status! : '');
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState('');
  const [planId, setPlanId] = useState('');
  const [action, setAction] = useState<AdminAction>();
  const [detail, setDetail] = useState<Row>();
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const scoped = section === 'tenants' || section === 'users' ? initial.id : ['subscriptions', 'branches'].includes(section) ? initial.tenantId :
    section === 'invoices' ? initial.subscriptionId : undefined;
  const scopeParam = section === 'tenants' || section === 'users' ? 'id' : section === 'invoices' ? 'subscriptionId' : 'tenantId';
  const filters = new URLSearchParams({ page: String(page), q: delayedSearch.trim(), ...(status && { status }),
    ...(email && { email }), ...(mode && { mode }), ...(planId && { planId }), ...(scoped && { [scopeParam]: scoped }) });
  const result = useQuery({ queryKey: ['platform', section, filters.toString()], queryFn: () =>
    api<Row[] | Page>(`/platform/${section}?${filters}`) });
  const planChoices = useQuery({ queryKey: ['platform', 'plan-choices'], enabled: section === 'subscriptions' || action?.fields === 'notification',
    queryFn: () => api<Row[]>('/platform/plans') });
  const detailQuery = useQuery({ queryKey: ['platform', section, 'detail', detail?.id], enabled: !!detail,
    queryFn: () => api<Profile>(`/platform/${section}/${detail?.id}`) });
  const paging = result.data && !Array.isArray(result.data) ? result.data : undefined;
  const items = Array.isArray(result.data) ? result.data : paging?.items;
  const canSeeProfile = ['users', 'tenants', 'subscriptions'].includes(section);
  const searchable = ['users', 'tenants', 'subscriptions', 'branches', 'invoices', 'audit-logs'].includes(section);
  const title = sections.find(item => item.key === section)?.title;
  const searchHint = section === 'users' ? 'Họ tên, email, số điện thoại' : section === 'branches' ? 'Tên chi nhánh' :
    section === 'invoices' ? 'Mã giao dịch' : section === 'audit-logs' ? 'Mã thao tác hoặc lý do' : 'Tên doanh nghiệp';

  function openAction(next: AdminAction) {
    setDetail(undefined); setAction(next);
  }

  function permissions(row: Row) {
    if (!write) return null;
    const path = `/platform/${section}/${row.id}`;
    if (section === 'users' || section === 'tenants') return !row.platformAccount && <>
      <button className="plain" onClick={() => openAction({ title: row.locked ? 'Mở khóa' : 'Khóa', path: path + '/status',
        method: 'PATCH', row, data: { locked: !row.locked } })}>{row.locked ? 'Mở khóa' : 'Khóa'}</button>
      {section === 'users' && !row.locked && <button className="plain" onClick={() => openAction({ title: 'Thu hồi phiên đăng nhập', path: path + '/revoke-sessions',
        method: 'POST', row })}>Thu hồi phiên</button>}
    </>;
    if (section === 'plans') return <button className="plain" onClick={() => openAction({
      title: 'Tạo phiên bản gói', path, method: 'PATCH', fields: 'plan', row,
    })}>Chỉnh sửa</button>;
    if (section === 'subscriptions') {
      const request = row.requestedPlanVersion;
      const data = request && { planVersionId: request.id, requestId: row.requestId };
      const canApprove = !row.tenant?.locked && row.status !== 'SUSPENDED' && row.status !== 'CANCELED';
      return <>
      {data && <>
        {canApprove && <button className="button" onClick={() => openAction({ title: 'Xác nhận thanh toán và kích hoạt',
          path: path + '/activate-request', method: 'POST', fields: 'activate', row, data })}>Duyệt yêu cầu</button>}
        <button className="plain" onClick={() => openAction({ title: 'Từ chối yêu cầu gói', path: path + '/reject-request',
          method: 'POST', fields: 'reject', row, data })}>Từ chối yêu cầu</button>
      </>}
      {row.status !== 'PENDING' && <>
        <button className="plain" onClick={() => openAction({ title: 'Ghi nhận thực thu', path: '/platform/invoices', method: 'POST', fields: 'invoice', row, data: { subscriptionId: row.id } })}>Ghi nhận thực thu</button>
        {!request && !row.tenant?.locked && <button className="plain" onClick={() => openAction({ title: 'Đổi gói', path: path + '/change-plan', method: 'POST', fields: 'switch', row })}>Đổi gói</button>}
        {!row.trial && row.status === 'ACTIVE' && <button className="plain" onClick={() => openAction({ title: 'Gia hạn', path: path + '/extend', method: 'POST', fields: 'extend', row })}>Gia hạn</button>}
        <button className="plain" onClick={() => openAction({ title: 'Đổi trạng thái', path: path + '/status', method: 'PATCH', fields: 'status', row })}>Trạng thái</button>
      </>}
      </>;
    }
    return null;
  }

  const hasActions = canSeeProfile || (write && section === 'plans');

  return <>
    <div className="page-heading"><h1>{title}</h1>{write && section === 'plans' && <button className="button" onClick={() => setAction({
      title: 'Tạo gói dịch vụ', path: '/platform/plans', method: 'POST', fields: 'plan',
    })}>Tạo gói</button>}
    {write && section === 'notifications' && <button className="button" onClick={() => setAction({
      title: 'Đăng thông báo', path: '/platform/notifications', method: 'POST', fields: 'notification',
    })}>Đăng thông báo</button>}</div>
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="card platform-directory">
      {searchable && <div className="filters platform-filters">
        <div className="search"><Search size={17} aria-hidden="true"/><input aria-label="Tìm kiếm" placeholder={searchHint} value={search} maxLength={100}
          onChange={e => { setSearch(e.target.value); setPage(1); }}/></div>
        {canSeeProfile && <select aria-label="Trạng thái" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Tất cả trạng thái</option>
          {stateOptions.map(([key, value]) => <option key={key} value={key}>{value}</option>)}
        </select>}
        {section === 'users' && <select aria-label="Xác minh email" value={email} onChange={e => { setEmail(e.target.value); setPage(1); }}>
          <option value="">Tất cả email</option><option value="verified">Đã xác minh</option><option value="unverified">Chưa xác minh</option>
        </select>}
        {section === 'branches' && <select aria-label="Mô hình" value={mode} onChange={e => { setMode(e.target.value); setPage(1); }}>
          <option value="">Tất cả mô hình</option>{Object.entries(branchNames).map(([key, value]) => <option value={key} key={key}>{value}</option>)}
        </select>}
        {section === 'subscriptions' && <select aria-label="Gói dịch vụ" value={planId} onChange={e => { setPlanId(e.target.value); setPage(1); }}>
          <option value="">Tất cả gói dịch vụ</option>{planChoices.data?.map(plan => <option value={plan.id} key={plan.id}>{plan.name}</option>)}
        </select>}
        {scoped && <Link className="plain" href={`/super-admin/${section}`}>Xóa bộ lọc liên kết</Link>}
      </div>}
      {result.isLoading && <div className="skeleton" aria-label="Đang tải"/>}
      {result.error && <p className="error" role="alert">{result.error.message}</p>}
      {items?.length === 0 && <p className="muted">Không có dữ liệu phù hợp.</p>}
      {!!items?.length && <div className="table-wrap"><table><thead><tr>
        {headers[section].map(label => <th key={label}>{label}</th>)}
        {hasActions && <th>Thao tác</th>}</tr></thead>
        <tbody>{items.map(row => <tr key={row.id}>{cells(section, row).map((cell, index) => <td key={index}>{cell}</td>)}
          {hasActions && <td className="row-actions">{canSeeProfile ? <button className="plain" onClick={() => setDetail(row)}>
            {section === 'subscriptions' && row.requestedPlanVersion ? 'Xem yêu cầu' : 'Chi tiết'}</button> : permissions(row)}</td>}</tr>)}</tbody>
      </table></div>}
      {paging && <div className="pagination">
        <span>{number.format(paging.total)} kết quả</span><div className="actions">
          <button className="icon" aria-label="Trang trước" disabled={page <= 1} onClick={() => setPage(page - 1)}><ArrowLeft size={17}/></button>
          <span>Trang {page}</span><button className="icon" aria-label="Trang sau" disabled={page * paging.take >= paging.total} onClick={() => setPage(page + 1)}><ArrowRight size={17}/></button>
        </div></div>}
    </section>
    {action && <ActionDialog action={action} plans={planChoices.data ?? []} close={() => setAction(undefined)} done={() => {
      setAction(undefined); setNotice('Đã cập nhật và ghi nhật ký quản trị.');
      void client.invalidateQueries({ queryKey: ['platform'] });
    }}/>}
    {detail && <BusinessDialog title={detail.name ?? detail.tenant?.name ?? title ?? 'Chi tiết'} close={() => setDetail(undefined)} className="platform-profile-dialog">
      {detailQuery.isLoading && <div className="skeleton"/>}
      {detailQuery.error && <p className="error">{detailQuery.error.message}</p>}
      {detailQuery.data && <>
        {write && <div className="actions platform-profile-actions">{permissions(detailQuery.data)}</div>}
        <AdminProfile section={section} profile={detailQuery.data}/>
      </>}
    </BusinessDialog>}
  </>;
}

function ActionDialog({ action, plans, close, done }: { action: AdminAction; plans: Row[]; close: () => void; done: () => void }) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState('all');
  const [newPlanId, setNewPlanId] = useState('');
  const row = action.row;
  const revision = row?.revisions?.[0];
  const paidPlan = plans.some(plan => plan.id === newPlanId && BigInt(plan.revisions?.[0]?.monthlyVnd ?? '0') > 0n);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '');
    const body: Record<string, unknown> = { ...action.data, reason: text('reason') };
    if (action.fields === 'invoice' || action.fields === 'activate') body.reference = text('reference');
    if (action.fields === 'invoice') body.amountVnd = text('amountVnd');
    if (action.fields === 'notification') {
      body.title = text('title'); body.body = text('body'); body.kind = text('kind');
      body.target = target === 'all' ? { type: target } : { type: target, id: text('targetId') };
    }
    if (action.fields === 'extend') body.days = Number(text('days'));
    if (action.fields === 'status') body.status = text('status');
    if (action.fields === 'switch') {
      body.planId = text('planId');
      body.expiresAt = text('expiresAt') ? new Date(`${text('expiresAt')}T23:59:59+07:00`).toISOString() : null;
    }
    if (action.fields === 'plan') {
      if (!row) body.code = text('code');
      body.name = text('name'); body.description = text('description'); body.published = form.has('published');
      body.revision = { monthlyVnd: text('monthlyVnd'), yearlyVnd: text('yearlyVnd') || undefined, maxBranches: Number(text('maxBranches')),
        maxStaff: Number(text('maxStaff')), maxQrTables: Number(text('maxQrTables')),
        features: text('features').split(',').map(part => part.trim()).filter(Boolean) };
    }
    submitting.current = true;
    setBusy(true); setError('');
    try { await api(action.path, action.method, body); done(); }
    catch (e) { setError((e as Error).message); setBusy(false); submitting.current = false; }
  }

  return <BusinessDialog title={action.title} close={close} pending={busy} closeLabel="Hủy" className="platform-action-dialog">
    <form onSubmit={submit}>
      {(row?.name || row?.tenant?.name) && <p><strong>{row.name ?? row.tenant?.name}</strong></p>}
      {action.fields === 'plan' && <>
        {!row && <label>Mã gói<input name="code" pattern="[A-Z][A-Z0-9_]{1,29}" required/></label>}
        <label>Tên<input name="name" defaultValue={row?.name} required maxLength={120}/></label>
        <label>Mô tả<textarea name="description" defaultValue={row?.description} maxLength={1000}/></label>
        <label>Giá tháng (VNĐ)<input name="monthlyVnd" pattern="[0-9]{1,15}" defaultValue={revision?.monthlyVnd ?? '0'} required/></label>
        <label>Giá năm (VNĐ)<input name="yearlyVnd" pattern="[0-9]{1,15}" defaultValue={revision?.yearlyVnd}/></label>
        <div className="form-grid">
          <label>Chi nhánh<input type="number" name="maxBranches" min={1} defaultValue={revision?.maxBranches ?? 1} required/></label>
          <label>Nhân sự<input type="number" name="maxStaff" min={1} defaultValue={revision?.maxStaff ?? 2} required/></label>
          <label>Bàn QR<input type="number" name="maxQrTables" min={0} defaultValue={revision?.maxQrTables ?? 0} required/></label>
        </div>
        <label>Tính năng, phân cách bằng dấu phẩy<input name="features" defaultValue={revision?.features.filter(feature => feature !== 'inventory').join(', ')}/></label>
        <label className="check"><input type="checkbox" name="published" defaultChecked={row?.published ?? true}/> Hiển thị gói</label>
      </>}
      {action.fields === 'invoice' && <>
        <label>Mã giao dịch đối soát<input name="reference" required maxLength={120}/></label>
        <label>Số tiền thực nhận (VNĐ)<input name="amountVnd" pattern="[1-9][0-9]{0,14}" required/></label>
      </>}
      {action.fields === 'activate' && row?.requestedPlanVersion && <>
        <p>Gói {row.requestedPlanVersion.plan?.name} · {vnd.format(BigInt(row.requestedPlanVersion.monthlyVnd))} cho 30 ngày.</p>
        <label>Mã giao dịch đã đối chiếu<input name="reference" maxLength={120} required/></label>
      </>}
      {action.fields === 'reject' && <p className="notice">Chủ doanh nghiệp sẽ thấy lý do trong mục Gói dịch vụ.</p>}
      {action.fields === 'notification' && <>
        <label>Tiêu đề<input name="title" maxLength={120} required/></label>
        <label>Nội dung<textarea name="body" maxLength={4000} required/></label>
        <label>Loại<select name="kind"><option value="MAINTENANCE">Bảo trì</option><option value="EXPIRY">Hết hạn</option><option value="FEATURE">Tính năng</option></select></label>
        <label>Đối tượng<select value={target} onChange={event => setTarget(event.target.value)}>
          <option value="all">Tất cả doanh nghiệp</option><option value="plan">Theo gói</option><option value="tenant">Một doanh nghiệp</option>
        </select></label>
        {target === 'plan' && <label>Gói nhận thông báo<select name="targetId" required defaultValue=""><option value="">Chọn gói</option>
          {plans.map(plan => <option value={plan.id} key={plan.id}>{plan.name}</option>)}</select></label>}
        {target === 'tenant' && <label>ID doanh nghiệp<input name="targetId" pattern="[a-fA-F0-9]{24}" required/></label>}
      </>}
      {action.fields === 'extend' && <label>Số ngày gia hạn<input type="number" name="days" min={1} max={730} required/></label>}
      {action.fields === 'status' && <label>Trạng thái<select name="status" defaultValue={row?.status}>
        {editableStates.map(key => <option key={key} value={key}>{labels[key]}</option>)}
      </select></label>}
      {action.fields === 'switch' && <>
        <label>Gói mới<select name="planId" value={newPlanId} onChange={event => setNewPlanId(event.target.value)} required><option value="">Chọn gói</option>
          {plans.filter(plan => plan.published && plan.code !== 'TRIAL').map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
        <label>Ngày hết hạn<input name="expiresAt" type="date" required={paidPlan}/></label>
      </>}
      <label>Lý do<textarea name="reason" minLength={3} maxLength={500} required/></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions"><button className="button" disabled={busy}>{busy ? 'Đang lưu…' : 'Xác nhận'}</button></div>
    </form>
  </BusinessDialog>;
}
