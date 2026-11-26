'use client';

import { useLanguage } from '@/i18n/language';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Building2, ChevronDown, Sparkles } from 'lucide-react';
import { Panel, State } from '@/components/business-ui';
import { PageLoading } from '@/components/page-loading';
import { useBusiness, useData } from '@/hooks/use-business';
import { currency } from '@/lib/format';
import type { Branch } from '@/types/business';
import { BranchSettings } from '@/features/dashboard/branch-settings';
import { branchNames, roleNames } from '@/features/dashboard/navigation';
import { TransactionManagement } from '@/features/dashboard/sales';
import { Customers } from '@/features/dashboard/operations';
import { MemberDirectory } from '@/features/dashboard/members';
import { SubscriptionManagement } from '@/features/dashboard/store-subscription';
import { WarehouseDashboard } from './warehouse';
import { TicketTypes } from './ticket-types';
import { BuffetSettings, TableSettings } from './table-settings';
import { MemberCheckInManagement, MemberPlans } from './member-settings';
import { HotelSettings } from './hotel-settings';
import { CancellationHistory } from './cancellations';
import { companySection } from './navigation';
import type { AiDocumentKind } from './inventory-ai';

function TabLoading() {
  return <PageLoading/>;
}
const Reports = dynamic(() => import('@/features/dashboard/reports').then(module => module.Reports), { loading: TabLoading });
const OwnerPerformance = dynamic(() => import('./owner-performance').then(module => module.OwnerPerformance), { loading: TabLoading });
const Catalog = dynamic(() => import('./catalog').then(module => module.Catalog), { loading: TabLoading });
const Categories = dynamic(() => import('./catalog').then(module => module.Categories), { loading: TabLoading });
const RetailCatalog = dynamic(() => import('./catalog').then(module => module.RetailCatalog), { loading: TabLoading });
const Accounting = dynamic(() => import('./finance').then(module => module.Accounting), { loading: TabLoading });
const Cashbook = dynamic(() => import('./finance').then(module => module.Cashbook), { loading: TabLoading });
const Promotions = dynamic(() => import('./finance').then(module => module.Promotions), { loading: TabLoading });
const Purchases = dynamic(() => import('./finance').then(module => module.Purchases), { loading: TabLoading });
const StaffWorkspace = dynamic(() => import('./staff-work').then(module => module.StaffWorkspace), { loading: TabLoading });
const InventoryAi = dynamic(() => import('./inventory-ai').then(module => module.InventoryAi), { loading: TabLoading });
const AiDocumentImport = dynamic(() => import('./inventory-ai').then(module => module.AiDocumentImport), { loading: TabLoading });
const TaxDeclarations = dynamic(() => import('./tax-declarations').then(module => module.TaxDeclarations), { loading: TabLoading });

const aiImportLabels = {
  receive: 'Nhập hàng bằng AI',
  issue: 'Xuất kho bằng AI',
  menu: 'Nhập thực đơn bằng AI',
  retail: 'Đăng bán sản phẩm bằng AI',
};

function AiImport({ kind }: { kind: AiDocumentKind }) {
  const { t } = useLanguage();
  const [loaded, setLoaded] = useState(false);
  return <details className="company-ai-import" onToggle={event => { if (event.currentTarget.open) setLoaded(true); }}>
    <summary className="plain"><Sparkles size={16} aria-hidden="true"/> {t(aiImportLabels[kind])} <ChevronDown size={15} aria-hidden="true"/></summary>
    {loaded && <AiDocumentImport kind={kind}/>}
  </details>;
}

export function CompanyDashboard({ requested }: { requested?: string }) {
  const { t } = useLanguage();
  const { company, role, staffMode, branches, branch } = useBusiness();
  if (!company || staffMode) return <p className="error" role="alert">{t("Hãy dùng tài khoản chủ doanh nghiệp hoặc quản lý được giao chi nhánh.")}</p>;
  if (requested === 'owner-performance' && role !== 'OWNER') return <p className="error" role="alert">{t("Chỉ chủ doanh nghiệp được xem báo cáo tổng hợp.")}</p>;
  const { id: current, label } = companySection(requested, branch.mode, true, role);
  const canImport = role === 'OWNER' || role === 'MANAGER';
  const aiKind = current === 'products' ? 'retail' : current === 'menu' ? 'menu' : current === 'purchases' ? 'receive' :
    current === 'warehouse' && role === 'OWNER' ? 'issue' : undefined;
  return <div className="company-dashboard">
    <header className="company-title"><h1>{t(label)}</h1></header>
    {canImport && aiKind && <AiImport key={branch.id + aiKind} kind={aiKind}/>}
    {current === 'overview' && <CompanyOverview/>}
    {current === 'branches' && <BranchSettings member={company.membership} branches={branches} onCreate={company.createBusiness} embedded/>}
    {current === 'products' && <RetailCatalog key={branch.id}/>}
    {current === 'menu' && <div className="company-catalog">
      <p className="muted">{t("Thực đơn dùng chung trong doanh nghiệp. Định lượng nguyên liệu, giá riêng và tình trạng bán áp dụng tại")} <strong>{branch.name}</strong>.</p>
      <Catalog type="FOOD"/>
    </div>}
    {current === 'categories' && <Categories/>}
    {current === 'tables' && <TableSettings/>}
    {current === 'buffet' && <BuffetSettings/>}
    {current === 'members' && <MemberDirectory key={branch.id} management/>}
    {current === 'member-plans' && <MemberPlans/>}
    {current === 'member-check-in' && <MemberCheckInManagement/>}
    {current === 'hotel-settings' && <HotelSettings key={branch.id}/>}
    {current === 'ticket-types' && <TicketTypes/>}
    {current === 'transactions' && <TransactionManagement/>}
    {current === 'cancellations' && <CancellationHistory key={branch.id}/>}
    {current === 'owner-performance' && <OwnerPerformance/>}
    {current === 'reports' && <Reports key={branch.id} company/>}
    {current === 'customers' && <Customers/>}
    {current === 'subscription' && <SubscriptionManagement/>}
    {current === 'staff' && <StaffWorkspace management/>}
    {current === 'warehouse' && <WarehouseDashboard key={branch.id}/>}
    {current === 'warehouse-ai' && <InventoryAi key={branch.id}/>}
    {current === 'tax-declarations' && <TaxDeclarations/>}
    {current === 'purchases' && <Purchases key={branch.id}/>}
    {current === 'accounting' && <Accounting key={branch.id}/>}
    {current === 'promotions' && <Promotions key={branch.id}/>}
    {current === 'cashbook' && <Cashbook key={branch.id}/>}
  </div>;
}

function CompanyOverview() {
  const { t } = useLanguage();
  const { company, tenantId, branches, branch } = useBusiness();
  const [period, setPeriod] = useState('today');
  const query = useData<Revenue>(`/company/revenue?period=${period}`, 15000);
  return <>
    <Panel title={t("Doanh thu theo chi nhánh")}>
      <div className="actions business-filters"><label>{t("Kỳ báo cáo")}<select value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="today">{t("Hôm nay")}</option><option value="month">{t("Tháng này")}</option>
      </select></label></div>
      <State query={query}/>
      {query.data && <RevenueDetails report={query.data}/>}
    </Panel>
    <div className="columns">
      <Panel title={t("Doanh nghiệp của bạn")}>
        {company?.businesses.map(item => <div className="list-row" key={item.tenant.id}>
          <div className="company-entity"><Building2 size={17} aria-hidden="true"/><div><strong>{item.tenant.name}</strong>
            <small>{t(roleNames[item.role] ?? item.role)}</small></div></div>
          {tenantId === item.tenant.id ? <span className="badge">{t("Đang xem")}</span> :
            <button className="plain" type="button" onClick={() => company.selectBusiness(item.tenant.id)}>{t("Chọn doanh nghiệp")}</button>}
        </div>)}
      </Panel>
      <Panel title={t("Cửa hàng và chi nhánh · {0}", branches.length)}>
        {branches.map(item => <div className="list-row" key={item.id}><div><strong>{item.name}</strong><small>{t(branchNames[item.mode])}</small></div>
          <div className="actions business-filters">{branch.id === item.id && <span className="badge">{t("Đang chọn")}</span>}
            <button type="button" className="plain" onClick={() => company?.selectBranch(item.id, '/dashboard/company?tab=warehouse')}>Xem kho</button>
          </div>
        </div>)}
        <Link href="/dashboard/company?tab=branches" className="plain">{t("Cài đặt cửa hàng và chi nhánh")}</Link>
      </Panel>
    </div>
  </>;
}

type Amounts = { gross: number; refunded: number; revenue: number };
type Revenue = Amounts & { branches: (Pick<Branch, 'id' | 'name' | 'mode'> & Amounts)[] };

function RevenueDetails({ report }: { report: Revenue }) {
  const { t } = useLanguage();
  return <>
    <div className="company-metrics">
      <div><small>{t("Doanh thu thuần")}</small><strong>{currency.format(report.revenue)}</strong></div>
      <div><small>{t("Đã thu")}</small><strong>{currency.format(report.gross)}</strong></div>
      <div><small>{t("Đã hoàn")}</small><strong>{currency.format(report.refunded)}</strong></div>
    </div>
    <div className="company-table-wrap"><table className="company-table">
      <thead><tr><th scope="col">{t("Chi nhánh")}</th><th scope="col">{t("Đã thu")}</th><th scope="col">{t("Đã hoàn")}</th><th scope="col">{t("Doanh thu thuần")}</th></tr></thead>
      <tbody>{report.branches.map(item => <tr key={item.id}><th scope="row">{item.name}<small>{t(branchNames[item.mode])}</small></th>
        <td>{currency.format(item.gross)}</td><td>{currency.format(item.refunded)}</td><td><strong>{currency.format(item.revenue)}</strong></td></tr>)}</tbody>
    </table></div>
  </>;
}
