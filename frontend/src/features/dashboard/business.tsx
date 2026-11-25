'use client';

import Link from 'next/link';
import { redirect, usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Building2, ChevronDown, Store, Utensils } from 'lucide-react';
import { api } from '@/services/api-client';
import { Workspace, type BranchSelection, type WorkspaceLayoutProps } from '@/components/workspace';
import { BusinessContext, useBusiness, type CompanySelection } from '@/hooks/use-business';
import type { Branch, Membership, WorkspaceMode } from '@/types/business';
import { subscriptionActive, usesMemberships, usesTables } from '@/types/business';
import { Pos } from './catalog';
import { Bills, Orders, Tables, Kitchen } from './sales';
import { AccountSecurity } from './security';
import { BranchSettings } from './branch-settings';
import { MemberCheckIn, MemberDirectory, MemberVisits } from './members';
import { MemberClasses } from './member-classes';
import { HotelBookings, HotelCalendar, HotelRooms } from './hotel';
import { TicketAdmissions, TicketSales } from './tickets';
import { RetailHome, RestaurantHome } from './branch-home';
import { BranchLayout, CompanyLayout } from './branch-layouts';
import { branchNames, canView, counterSections, dashboardHref, managementHref, managementTabs, menus, modesFor, navigation, sectionTitle, type Section } from './navigation';
import { StoreSetup } from './store-setup';
import { StoreSubscription } from './store-subscription';
import { WorkModeControl } from './work-mode';
import { BranchAccessDialog } from './branch-access';

const views: Partial<Record<Section, ComponentType>> = {
  pos: Pos, orders: Orders, tables: Tables, kitchen: Kitchen,
  payments: Bills, members: MemberDirectory, 'member-visits': MemberVisits, 'member-classes': MemberClasses,
  'hotel-rooms': HotelRooms, 'hotel-bookings': HotelBookings, 'hotel-calendar': HotelCalendar,
  'ticket-sales': TicketSales, 'ticket-admissions': TicketAdmissions,
};
function employeeSections(mode: WorkspaceMode): Section[] {
  if (usesMemberships(mode)) return ['overview', 'members', 'member-classes', 'member-visits', ...counterSections];
  if (mode === 'HOTEL') return ['overview', 'hotel-rooms', 'hotel-bookings', 'hotel-calendar', ...counterSections];
  if (mode === 'TICKETS') return ['overview', 'ticket-sales', 'ticket-admissions', ...counterSections];
  return usesTables(mode) ? ['tables', 'pos', 'kitchen', 'payments'] : counterSections;
}

function employeeDescription(mode: WorkspaceMode) {
  if (usesMemberships(mode)) return 'Nhân viên có thể thêm hội viên, check-in và bán hàng hóa tại chi nhánh đang chọn.';
  if (mode === 'HOTEL') return 'Nhân viên có thể đặt phòng, nhận phòng thu tiền trả phòng và bán hàng hóa tại chi nhánh đang chọn.';
  if (mode === 'TICKETS') return 'Nhân viên có thể bán vé, soát vé và bán hàng hóa tại chi nhánh đang chọn.';
  return 'Nhân viên có thể nhận đơn và thu tiền tại chi nhánh đang chọn.';
}

export function BusinessWorkspace({ children }: { children: ReactNode }) {
  return <Workspace layout={BusinessLayout}>{children}</Workspace>;
}

function BusinessLayout(props: WorkspaceLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const companySecurity = pathname === '/dashboard/company/security';
  const personalSecurity = pathname === '/dashboard/security';
  const security = companySecurity || personalSecurity;
  const company = pathname === '/dashboard/company' || companySecurity;
  const staffMode = !!props.user.staffMode;
  const selectedScope = props.user.staffMode ?? props.user.selectedBranch;
  const [creating, setCreating] = useState(false);
  const [preferred, setPreferred] = useState<WorkspaceMode>('RETAIL');
  const [branchChange, setBranchChange] = useState<{ member: Membership; branchId?: string; destination?: string }>();
  useEffect(() => {
    if (localStorage.getItem('juee-hybrid-mode') === 'RESTAURANT') setPreferred('RESTAURANT');
  }, []);
  const tenants = useQuery({ queryKey: ['tenants', props.user.staffMode?.branchId ?? 'management'], queryFn: () => api<Membership[]>('/tenants'), refetchInterval: 15000 });
  const selectable = company ? tenants.data?.filter(item => item.role === 'OWNER' || item.role === 'MANAGER') : tenants.data;
  const member = selectedScope && !companySecurity ? selectable?.find(item => item.tenant.id === selectedScope.tenantId) :
    selectable?.find(item => item.tenant.id === selectedScope?.tenantId) ?? selectable?.[0];
  const tenantId = member?.tenant.id;
  const branches = useQuery({ queryKey: ['branches', tenantId, staffMode], enabled: !!tenantId && !personalSecurity, refetchInterval: 15000,
    queryFn: () => api<Branch[]>(`/tenants/${tenantId}/branches`) });
  const branch = selectedScope ? branches.data?.find(item => item.id === selectedScope.branchId) : branches.data?.[0];
  const requested = pathname.split('/')[2] || (branch?.mode === 'HOTEL' ? 'hotel-rooms' : branch?.mode === 'TICKETS' ? 'ticket-sales' : 'overview');
  const section = Object.hasOwn(navigation, requested) ? requested as Section : undefined;
  const supported = section ? modesFor(section).filter(item => item === 'RETAIL' || item === 'RESTAURANT') : [];
  const directMode = supported.length === 1 ? supported[0] : undefined;
  const mode = branch?.mode === 'HYBRID' ? (directMode ?? preferred) : branch?.mode ?? 'RETAIL';
  const allowedSections = employeeSections(mode);
  const active = subscriptionActive(member?.subscription);

  function chooseHybridMode(hybridMode: WorkspaceMode, navigateHome = false) {
    setPreferred(hybridMode);
    localStorage.setItem('juee-hybrid-mode', hybridMode);
    if (navigateHome && !company) router.push('/dashboard');
  }

  function requestBranchChange(id: string, branchId?: string, destination?: string) {
    const next = selectable?.find(item => item.tenant.id === id);
    if (!next || staffMode) return;
    if (branch && id === tenantId && (!branchId || branch.id === branchId)) {
      if (destination) router.push(destination);
      return;
    }
    setBranchChange({ member: next, branchId, destination });
  }

  function changeBranch(scope: BranchSelection, destination?: string) {
    props.onBranchChange(scope);
    setBranchChange(undefined);
    if (destination) router.push(destination);
    else if (!company) router.push('/dashboard');
  }

  const branchDialog = branchChange && <BranchAccessDialog member={branchChange.member} requestedBranch={branchChange.branchId}
    email={props.user.email} hasPassword={props.user.hasPassword !== false} close={() => setBranchChange(undefined)}
    changeAccount={() => { setBranchChange(undefined); props.onLogout(); }}
    onConfirmed={scope => changeBranch(scope, branchChange.destination)}/>;

  function availableBusinesses() {
    return selectable?.filter(item => item.role === 'OWNER' || item.role === 'MANAGER').map(item =>
      <button className="plain" type="button" key={item.tenant.id} onClick={() => requestBranchChange(item.tenant.id)}>{item.tenant.name}</button>);
  }

  const nav = branch && member && active ? menus[mode].map(group => {
    const visible = group.sections.filter(key => canView(key, member.role, mode) &&
      (!staffMode || allowedSections.includes(key)));
    if (!visible.length) return null;
    return <div className="desk-nav-group" key={group.label}>
      <p>{group.label}</p><div>{visible.map(key => {
        const Icon = navigation[key].icon;
        const title = sectionTitle(key, mode);
        return <Link key={key} href={dashboardHref(key)} title={title}
          aria-current={section === key ? 'page' : undefined}
          onClick={() => {
            if (branch.mode === 'HYBRID' && mode !== preferred) chooseHybridMode(mode);
          }}><Icon size={18}/><span>{title}</span></Link>;
      })}</div>
    </div>;
  }) : !staffMode && member && canView('subscription', member.role) ?
    <div className="desk-nav-group"><div><Link href={managementHref('subscription')}><Store size={18}/> <span>Gói dịch vụ</span></Link></div></div> : null;

  const picker = !security && member && !staffMode && <div className="branch-picker-selects">
    <label><Building2 size={14} aria-hidden="true"/><span>Doanh nghiệp</span>
      <select value={member.tenant.id} onChange={event => requestBranchChange(event.target.value)}>
        {selectable?.map(item => <option key={item.tenant.id} value={item.tenant.id}>{item.tenant.name}</option>)}
      </select>
      <ChevronDown className="branch-picker-arrow" size={14} aria-hidden="true"/>
    </label>
    {!!branches.data?.length && <label><Store size={14} aria-hidden="true"/><span>Chi nhánh</span>
      <select value={branch?.id ?? ''} onChange={event => requestBranchChange(member.tenant.id, event.target.value)}>
        {!branch && <option value="" disabled>Chọn chi nhánh</option>}
        {branches.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <ChevronDown className="branch-picker-arrow" size={14} aria-hidden="true"/>
    </label>}
  </div>;
  const modePicker = !security && !company && branch?.mode === 'HYBRID' && active && <div className="mode-switch" aria-label="Mô hình bán hàng">
    {(['RETAIL', 'RESTAURANT'] as const).map(item => {
      const Icon = item === 'RETAIL' ? Store : Utensils;
      return <button key={item} type="button" aria-pressed={mode === item} onClick={() => chooseHybridMode(item, true)}>
        <Icon size={17}/>{branchNames[item]}
      </button>;
    })}
  </div>;

  const Layout = company ? CompanyLayout : BranchLayout;
  const error = tenants.error ?? (!security ? branches.error : null);
  const loading = tenants.isPending || (!security && !!tenantId && branches.isPending);
  const canSwitch = staffMode || (active && branch && (member?.role === 'OWNER' || member?.role === 'MANAGER'));
  const accountSecurityHref = staffMode || security ? undefined : !member ? '/dashboard/security' :
    member.role === 'MANAGER' || !active ? '/dashboard/company/security' : undefined;
  if (company && !loading && !error && (staffMode || !member)) return <CompanyLayout {...props} mode={mode} picker={null} navigation={null}>
    <section className="card desk-empty"><h1>Quản lý doanh nghiệp</h1>
      <p>Hãy dùng tài khoản chủ doanh nghiệp hoặc tài khoản quản lý được giao chi nhánh.</p>
      <div className="actions business-filters">
        <Link className="button" href="/dashboard">Về chi nhánh</Link>
        {!staffMode && availableBusinesses()}
        <button className="plain" type="button" onClick={props.onLogout}>Đổi tài khoản</button>
      </div>
    </section>
    {branchDialog}
  </CompanyLayout>;
  if (personalSecurity && !loading && !error) {
    if (staffMode) redirect('/dashboard');
    if (member && canView('company', member.role)) redirect('/dashboard/company/security');
    return <Layout {...props} mode={mode} tenant={member?.tenant.name} role={member?.role} picker={null} navigation={nav}>
      <div className="desk-page-title">
        <div className="desk-crumb"><Link href="/dashboard">Về chi nhánh</Link></div>
        <h1>Bảo mật tài khoản cá nhân</h1>
      </div>
      <AccountSecurity/>
    </Layout>;
  }
  if (!staffMode && !loading && !error && ((!member && !selectedScope) || creating)) return <StoreSetup {...props}
    onBack={member && (() => setCreating(false))} onCreate={(tenantId, branchId) => { changeBranch({ tenantId, branchId }); setCreating(false); }}/>;
  return <Layout {...props} mode={mode} tenant={member?.tenant.name} branch={branch?.name} role={member?.role} picker={picker} modePicker={modePicker} navigation={nav}
    branchMode={branch?.mode} active={active} onCreateBusiness={company && member?.role === 'OWNER' && active && branch ? () => setCreating(true) : undefined}
    accountSecurityHref={accountSecurityHref}
    workMode={!company && canSwitch && <WorkModeControl key={String(staffMode)} staffMode={staffMode} tenantId={tenantId} branchId={branch?.id}
      description={employeeDescription(mode)} hasPassword={props.user.hasPassword !== false}
      onChange={scope => { props.onWorkModeChange(scope); router.replace(scope && !allowedSections.includes('overview') ? dashboardHref(allowedSections[0]) : '/dashboard'); }}/> }>
    {error && <p className="error" role="alert">{error.message}</p>}
    {loading ? <div className="skeleton" aria-label="Đang tải cửa hàng"/> :
      !error && (companySecurity ? props.children : selectedScope && (!member || !branch) ?
        <section className="card desk-empty"><h1>Chi nhánh chưa được cấp quyền</h1>
          <p>Chọn chi nhánh được giao hoặc đăng nhập bằng tài khoản chủ doanh nghiệp hay quản lý của chi nhánh cần vào.</p>
          <div className="actions business-filters">{!staffMode && availableBusinesses()}
            <button className="button" type="button" onClick={props.onLogout}>Đổi tài khoản</button></div>
        </section> : member ? <BranchContext member={member} branch={branch} branches={branches.data ?? []} mode={mode}
        active={active} staffMode={staffMode} onCreate={member.role === 'OWNER' ? () => setCreating(true) : undefined}
        company={company && !staffMode ? { businesses: selectable ?? [], selectBusiness: id => requestBranchChange(id),
          selectBranch: (id, destination) => requestBranchChange(member.tenant.id, id, destination) } : undefined}>{props.children}</BranchContext> :
        <p className="error" role="alert">Bạn chưa được cấp quyền vào chi nhánh này.</p>)}
    {branchDialog}
  </Layout>;
}

function BranchContext({ member, branch, branches, mode, children, active, staffMode, onCreate, company }: {
  member: Membership; branch?: Branch; branches: Branch[]; mode: WorkspaceMode; children: ReactNode;
  active: boolean; staffMode: boolean; onCreate?: () => void; company?: CompanySelection;
}) {
  if (!staffMode && !active && canView('subscription', member.role)) {
    if (!company) redirect(managementHref('subscription'));
    return <section>
      <div className="desk-page-title"><h1>Gói dịch vụ</h1></div>
      <StoreSubscription key={member.tenant.id} member={member}/>
    </section>;
  }
  if (!active) return <p className="error" role="alert">Cửa hàng đang bị tạm ngừng truy cập. Hãy liên hệ quản trị viên JUEE POS.</p>;
  if (!staffMode && !branch) {
    return <BranchSettings key={member.tenant.id} member={member} branches={branches} onCreate={onCreate}/>;
  }
  if (!branch) return <p className="error" role="alert">Bạn chưa được cấp quyền vào chi nhánh này.</p>;
  return <BusinessContext.Provider key={`${branch.id}:${mode}:${staffMode}`} value={{ tenantId: member.tenant.id,
    branch, branches, membership: member, active, role: member.role, mode, staffMode, root: `/tenants/${member.tenant.id}/branches/${branch.id}`,
    company: company && { ...company, membership: member, createBusiness: onCreate } }}>
    {children}
  </BusinessContext.Provider>;
}

export function BusinessDashboard({ section = 'overview', bill }: { section?: string; bill?: string }) {
  const { mode, role, branch, staffMode } = useBusiness();
  if (section === 'staff-work' || section === 'registers') {
    redirect(!staffMode && canView('company', role) ? managementHref('staff') : '/dashboard');
  }
  const managementTab = managementTabs.find(tab => tab === section);
  if (managementTab) {
    if (!staffMode && canView('company', role) && canView(managementTab, role)) {
      redirect(managementHref(managementTab));
    }
    return <p className="error" role="alert">Tài khoản này chưa được cấp quyền quản lý mục này.</p>;
  }
  if (section === 'orders' && usesTables(mode)) {
    redirect(canView('tables', role) ? '/dashboard/tables' : '/dashboard');
  }
  const allowedSections = employeeSections(mode);
  if (staffMode && !allowedSections.includes(section as Section)) section = allowedSections[0];
  if (section === 'overview' && mode === 'HOTEL') section = 'hotel-rooms';
  if (section === 'overview' && mode === 'TICKETS') section = 'ticket-sales';
  if (!Object.hasOwn(navigation, section)) return <p role="alert" className="error">Không tìm thấy mục này.</p>;
  const key = section as Section;
  if (key === 'overview') return usesTables(mode) ? <RestaurantHome/> : usesMemberships(mode) ? <MemberCheckIn/> : <RetailHome/>;
  const View = views[key];
  if (!View || !canView(key, role, branch.mode) || !modesFor(key).includes(mode)) return <section className="card desk-empty">
    <h1>{sectionTitle(key, mode)}</h1><p>Mục này không khả dụng với chi nhánh hoặc quyền truy cập hiện tại.</p>
    <Link className="button" href="/dashboard">Về tổng quan</Link>
  </section>;
  const hotelDesk = key === 'hotel-rooms' || key === 'hotel-bookings' || key === 'hotel-calendar';
  return <div className="service-workspace">
    {!hotelDesk && key !== 'kitchen' && <div className="desk-page-title"><h1>{sectionTitle(key, mode)}</h1></div>}
    {key === 'payments' ? <Bills key={bill} initialBill={bill}/> : <View/>}
  </div>;
}
