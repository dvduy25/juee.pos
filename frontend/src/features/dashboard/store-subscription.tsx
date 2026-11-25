'use client';

import { useQuery } from '@tanstack/react-query';
import { Panel, State } from '@/components/business-ui';
import { currency, date } from '@/lib/format';
import { api } from '@/services/api-client';
import type { Membership } from '@/types/business';
import { useBusiness } from '@/hooks/use-business';

type Service = {
  status: string;
  invoices: { id: string; reference: string; amountVnd: string; paidAt: string }[];
};

export function SubscriptionManagement() {
  const { membership } = useBusiness();
  return <StoreSubscription member={membership}/>;
}

export function StoreSubscription({ member }: { member: Membership }) {
  const query = useQuery({ queryKey: ['contract', member.tenant.id],
    queryFn: () => api<Service>(`/tenants/${member.tenant.id}/subscription`) });

  return <>
    <Panel title={member.tenant.name}>
      <p>JUEE POS miễn phí toàn bộ tính năng cho mọi doanh nghiệp và chi nhánh.</p>
      <State query={query}/>
      {query.data && query.data.status !== 'ACTIVE' &&
        <p className="notice">Cửa hàng đang bị tạm ngừng truy cập. Hãy liên hệ quản trị viên JUEE POS.</p>}
    </Panel>
    {!!query.data?.invoices.length && <Panel title="Lịch sử thanh toán thuê bao">
      {query.data.invoices.map(invoice => <div className="list-row" key={invoice.id}>
        <div>{invoice.reference}<small>{date(invoice.paidAt)}</small></div>
        <strong>{currency.format(BigInt(invoice.amountVnd))}</strong>
      </div>)}
    </Panel>}
  </>;
}
