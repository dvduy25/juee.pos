import { ForbiddenException } from '@nestjs/common';
import { Branch, Membership, Subscription, Tenant, type BranchMode } from '../models';
import { branchPerformance } from './branch-report';
import type { revenueRange } from './revenue';

type Performance = Awaited<ReturnType<typeof branchPerformance>>;
type BranchRow = Performance & { id: string; name: string; mode: BranchMode };

function totals(rows: readonly Performance[]): Performance {
  return rows.reduce((sum, row) => ({
    revenue: sum.revenue + row.revenue,
    operatingExpenses: sum.operatingExpenses + row.operatingExpenses,
    profitBeforeTax: sum.profitBeforeTax + row.profitBeforeTax,
    provisional: sum.provisional || row.provisional,
  }), { revenue: 0, operatingExpenses: 0, profitBeforeTax: 0, provisional: false });
}

export async function ownerPerformance(userId: string, range: ReturnType<typeof revenueRange>, tenantId?: string) {
  const ids = await Membership.distinct('tenantId', { userId, role: 'OWNER', disabled: { $ne: true }, archivedAt: null,
    ...(tenantId && { tenantId }) });
  if (!ids.length) throw new ForbiddenException('Chỉ chủ doanh nghiệp được xem báo cáo tổng hợp.');
  const [tenants, suspended] = await Promise.all([
    Tenant.find({ _id: { $in: ids }, locked: { $ne: true } }).select('name').collation({ locale: 'vi' }).sort('name _id').lean(),
    Subscription.distinct('tenantId', { tenantId: { $in: ids }, status: { $in: ['SUSPENDED', 'CANCELED'] } }),
  ]);
  const unavailable = new Set(suspended.map(String));
  const stores = tenants.filter(store => !unavailable.has(String(store._id)));
  if (tenantId && !stores.length) throw new ForbiddenException('Cửa hàng này hiện không khả dụng.');

  const branches = await Branch.find({ tenantId: { $in: stores.map(store => store._id) } })
    .select('tenantId name mode').collation({ locale: 'vi' }).sort('name _id').lean();
  const byStore = new Map(stores.map(store => [String(store._id), [] as BranchRow[]]));
  const concurrentBranches = 3;
  for (let start = 0; start < branches.length; start += concurrentBranches) {
    const batch = await Promise.all(branches.slice(start, start + concurrentBranches).map(async branch => ({
      tenantId: String(branch.tenantId),
      row: { id: String(branch._id), name: branch.name, mode: branch.mode,
        ...await branchPerformance({ tenantId: branch.tenantId, branchId: branch._id }, range) },
    })));
    for (const { tenantId, row } of batch) byStore.get(tenantId)?.push(row);
  }
  const rows = stores.map(store => {
    const branches = byStore.get(String(store._id)) ?? [];
    return { id: String(store._id), name: store.name, ...totals(branches), branches };
  });
  return { start: range.$gte, end: range.$lte, ...totals(rows), stores: rows };
}
