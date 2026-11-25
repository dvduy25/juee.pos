'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Panel, State } from '@/components/business-ui';
import { ReportPeriodFields, reportParams, type ReportPeriod } from '@/components/report-period';
import { useBusiness } from '@/hooks/use-business';
import { currency } from '@/lib/format';
import { api } from '@/services/api-client';
import type { Branch } from '@/types/business';
import { branchNames } from '@/features/dashboard/navigation';

type FinancialAmounts = { revenue: number; operatingExpenses: number; profitBeforeTax: number; provisional: boolean };
type BranchPerformance = FinancialAmounts & Pick<Branch, 'id' | 'name' | 'mode'>;
type StorePerformance = FinancialAmounts & { id: string; name: string; branches: BranchPerformance[] };
type Report = FinancialAmounts & { start: string; end: string; stores: StorePerformance[] };

const day = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' });
const percent = new Intl.NumberFormat('vi-VN', { style: 'percent', maximumFractionDigits: 1 });

function profitMargin(row: FinancialAmounts) {
  return row.revenue > 0 ? percent.format(row.profitBeforeTax / row.revenue) : '—';
}

function AmountCells({ row }: { row: FinancialAmounts }) {
  return <>
    <td>{currency.format(row.revenue)}</td>
    <td>{currency.format(row.operatingExpenses)}</td>
    <td data-loss={row.profitBeforeTax < 0}><strong>{currency.format(row.profitBeforeTax)}</strong>{row.provisional && <small>Tạm tính</small>}</td>
    <td>{profitMargin(row)}</td>
  </>;
}

export function OwnerPerformance() {
  const { company, tenantId } = useBusiness();
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [on, setOn] = useState('');
  const [store, setStore] = useState('');
  const params = reportParams(period, on);
  if (store) params.set('tenantId', store);
  const path = `/tenants/owner-performance?${params}`;
  const query = useQuery({ queryKey: ['owner-performance', tenantId, path], queryFn: () => api<Report>(path), staleTime: 30_000 });
  const report = query.isSuccess ? query.data : undefined;

  return <Panel title="Tổng hợp theo cửa hàng" className="owner-performance">
    <div className="actions business-filters owner-performance-filters">
      <label>Cửa hàng<select value={store} onChange={event => setStore(event.target.value)}>
        <option value="">Tất cả cửa hàng của tôi</option>
        {company?.businesses.filter(item => item.role === 'OWNER' && item.subscription?.status !== 'SUSPENDED' && item.subscription?.status !== 'CANCELED')
          .map(item => <option key={item.tenant.id} value={item.tenant.id}>{item.tenant.name}</option>)}
      </select></label>
      <ReportPeriodFields period={period} on={on} setPeriod={setPeriod} setOn={setOn}/>
      <button type="button" className="plain" disabled={query.isFetching} onClick={() => void query.refetch()}>
        <RefreshCw size={17} aria-hidden="true"/> Làm mới
      </button>
    </div>
    <State query={query}/>
    {report && !report.stores.length && <p className="muted">Chưa có cửa hàng đang hoạt động để tổng hợp.</p>}
    {!!report?.stores.length && <>
      <p className="muted">{period === 'all' ? 'Toàn bộ đến ' : `${day.format(new Date(report.start))} – `}{day.format(new Date(report.end))}</p>
      <div className="company-metrics">
        <div><small>Doanh thu thuần ghi nhận</small><strong>{currency.format(report.revenue)}</strong></div>
        <div><small>Chi phí vận hành</small><strong>{currency.format(report.operatingExpenses)}</strong></div>
        <div data-loss={report.profitBeforeTax < 0}><small>Lợi nhuận trước thuế{report.provisional ? ' (tạm tính)' : ''}</small>
          <strong>{currency.format(report.profitBeforeTax)}</strong></div>
        <div><small>Tỷ suất lợi nhuận</small><strong>{profitMargin(report)}</strong></div>
      </div>
      <div className="company-table-wrap" role="region" aria-label="Doanh thu và lợi nhuận theo cửa hàng và chi nhánh" tabIndex={0}>
        <table className="company-table owner-performance-table">
          <thead><tr><th scope="col">Cửa hàng / chi nhánh</th><th scope="col">Doanh thu ghi nhận</th><th scope="col">Chi phí vận hành</th>
            <th scope="col">Lợi nhuận trước thuế</th><th scope="col">Tỷ suất</th></tr></thead>
          {report.stores.map(item => <tbody key={item.id}>
            <tr className="owner-store-total"><th scope="row">{item.name}<small>{item.branches.length} chi nhánh</small></th><AmountCells row={item}/></tr>
            {item.branches.map(branch => <tr key={branch.id}><th scope="row" className="owner-branch-name">{branch.name}
              <small>{branchNames[branch.mode]}</small></th><AmountCells row={branch}/></tr>)}
          </tbody>)}
        </table>
      </div>
      <p className="muted">Lợi nhuận trước thuế đã tính giá vốn, chênh lệch kiểm kê và chi phí vận hành. Tỷ suất là lợi nhuận chia cho doanh thu ghi nhận.</p>
      {report.provisional && <p className="notice">Một số chi nhánh còn thiếu giá vốn hoặc có chênh lệch kho tạm tính.</p>}
    </>}
  </Panel>;
}
