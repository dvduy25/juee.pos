'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { Panel, State } from '@/components/business-ui';
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

const tabLoading = () => <div className="skeleton" role="status" aria-label="Đang tải nội dung"/>;
const Reports = dynamic(() => import('@/features/dashboard/reports').then(module => module.Reports), { loading: tabLoading });
const Catalog = dynamic(() => import('./catalog').then(module => module.Catalog), { loading: tabLoading });
const Categories = dynamic(() => import('./catalog').then(module => module.Categories), { loading: tabLoading });
const RetailCatalog = dynamic(() => import('./catalog').then(module => module.RetailCatalog), { loading: tabLoading });
const Accounting = dynamic(() => import('./finance').then(module => module.Accounting), { loading: tabLoading });
const Cashbook = dynamic(() => import('./finance').then(module => module.Cashbook), { loading: tabLoading });
const Promotions = dynamic(() => import('./finance').then(module => module.Promotions), { loading: tabLoading });
const Purchases = dynamic(() => import('./finance').then(module => module.Purchases), { loading: tabLoading });
const StaffWorkspace = dynamic(() => import('./staff-work').then(module => module.StaffWorkspace), { loading: tabLoading });
const InventoryAi = dynamic(() => import('./inventory-ai').then(module => module.InventoryAi), { loading: tabLoading });
const TaxDeclarations = dynamic(() => import('./tax-declarations').then(module => module.TaxDeclarations), { loading: tabLoading });

export function CompanyDashboard({ requested }: { requested?: string }) {
  const { company, role, staffMode, branches, branch, membership } = useBusiness();
  if (!company || staffMode) return <p className="error" role="alert">Hãy dùng tài khoản chủ doanh nghiệp hoặc quản lý được giao chi nhánh.</p>;
  const { id: current, label } = companySection(requested, branch.mode, true, role, membership.subscription?.features);
  return <div className="company-dashboard">
    <header className="company-title"><h1>{label}</h1></header>
    {current === 'overview' && <CompanyOverview/>}
    {current === 'branches' && <BranchSettings member={company.membership} branches={branches} onCreate={company.createBusiness} embedded/>}
    {current === 'products' && <RetailCatalog key={branch.id}/>}
    {current === 'menu' && <div className="company-catalog">
      <p className="muted">Thực đơn dùng chung trong doanh nghiệp. Định lượng nguyên liệu, giá riêng và tình trạng bán áp dụng tại <strong>{branch.name}</strong>.</p>
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
  const { company, tenantId, branches, branch, membership } = useBusiness();
  const [period, setPeriod] = useState('today');
  const basic = membership.subscription?.features?.includes('basic-sales');
  const query = useData<Revenue>(`/company/revenue?period=${period}`, 15000, !basic);
  return <>
    {!basic && <Panel title="Doanh thu theo chi nhánh">
      <div className="actions business-filters"><label>Kỳ báo cáo<select value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="today">Hôm nay</option><option value="month">Tháng này</option>
      </select></label></div>
      <State query={query}/>
      {query.data && <RevenueDetails report={query.data}/>}
    </Panel>}
    <div className="columns">
      <Panel title="Doanh nghiệp của bạn">
        {company?.businesses.map(item => <div className="list-row" key={item.tenant.id}>
          <div className="company-entity"><Building2 size={17} aria-hidden="true"/><div><strong>{item.tenant.name}</strong>
            <small>{roleNames[item.role] ?? item.role}</small></div></div>
          {tenantId === item.tenant.id ? <span className="badge">Đang xem</span> :
            <button className="plain" type="button" onClick={() => company.selectBusiness(item.tenant.id)}>Chọn doanh nghiệp</button>}
        </div>)}
      </Panel>
      <Panel title={`Cửa hàng và chi nhánh · ${branches.length}`}>
        {branches.map(item => <div className="list-row" key={item.id}><div><strong>{item.name}</strong><small>{branchNames[item.mode]}</small></div>
          <div className="actions business-filters">{branch.id === item.id && <span className="badge">Đang chọn</span>}
            <button type="button" className="plain" onClick={() => company?.selectBranch(item.id, '/dashboard/company?tab=warehouse')}>Xem kho</button>
          </div>
        </div>)}
        <Link href="/dashboard/company?tab=branches" className="plain">Cài đặt cửa hàng và chi nhánh</Link>
      </Panel>
    </div>
  </>;
}

type Amounts = { gross: number; refunded: number; revenue: number };
type Revenue = Amounts & { branches: (Pick<Branch, 'id' | 'name' | 'mode'> & Amounts)[] };

function RevenueDetails({ report }: { report: Revenue }) {
  return <>
    <div className="company-metrics">
      <div><small>Doanh thu thuần</small><strong>{currency.format(report.revenue)}</strong></div>
      <div><small>Đã thu</small><strong>{currency.format(report.gross)}</strong></div>
      <div><small>Đã hoàn</small><strong>{currency.format(report.refunded)}</strong></div>
    </div>
    <div className="company-table-wrap"><table className="company-table">
      <thead><tr><th scope="col">Chi nhánh</th><th scope="col">Đã thu</th><th scope="col">Đã hoàn</th><th scope="col">Doanh thu thuần</th></tr></thead>
      <tbody>{report.branches.map(item => <tr key={item.id}><th scope="row">{item.name}<small>{branchNames[item.mode]}</small></th>
        <td>{currency.format(item.gross)}</td><td>{currency.format(item.refunded)}</td><td><strong>{currency.format(item.revenue)}</strong></td></tr>)}</tbody>
    </table></div>
  </>;
}
