'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel, State } from '@/components/business-ui';
import { currency, date } from '@/lib/format';
import { api } from '@/services/api-client';
import type { Branch, Membership, SubscriptionStatus } from '@/types/business';
import { useBusiness } from '@/hooks/use-business';
import { PlanOptions, suitablePlans, useServicePlans } from './plan-options';

type Contract = SubscriptionStatus & {
  invoices: { id: string; reference: string; amountVnd: string; paidAt: string; paymentCode?: string }[];
  planVersion: { monthlyVnd: string; maxBranches: number; maxStaff: number; maxQrTables: number; features: string[]; plan: { name: string } };
  requestedPlan?: { code: string; name: string; monthlyVnd: string } | null;
  rejectedRequest?: { reason: string; rejectedAt: string };
  simulated?: boolean;
  simulatedPlanDays: number | null;
  onlinePayment: boolean;
  checkout?: Checkout;
};
type Checkout = { reference: string; amount: number; bank: string; account: string; holder: string;
  expiresAt: string; status: 'PENDING' | 'EXPIRED' | 'REVIEW'; qrUrl: string };
const features: Record<string, string> = { pos: 'Bán hàng tại quầy', qr: 'Bàn và gọi món QR', kitchen: 'Bếp / pha chế', chain: 'Quản lý chuỗi' };
const statuses: Record<string, string> = { PENDING: 'Chờ kích hoạt', SUSPENDED: 'Tạm dừng', CANCELED: 'Đã hủy' };

export function SubscriptionManagement() {
  const { membership, branches, active } = useBusiness();
  return <StoreSubscription member={membership} branches={branches} active={active}/>;
}

export function StoreSubscription({ member, branches, active }: { member: Membership; branches: Branch[]; active: boolean }) {
  const root = `/tenants/${member.tenant.id}/subscription`;
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['contract', member.tenant.id], queryFn: () => api<Contract>(root),
    refetchInterval: state => state.state.data?.checkout?.status === 'PENDING' ? 4000 : 15000 });
  const [choosing, setChoosing] = useState(false);
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submitting = useRef(false);
  const owner = member.role === 'OWNER';
  const contract = query.data;
  const simulatedDays = contract?.simulatedPlanDays;
  const checkout = contract?.checkout;
  const canRequest = owner && checkout?.status !== 'REVIEW' && !['SUSPENDED', 'CANCELED'].includes(contract?.status ?? '');
  const planSelection = canRequest && (choosing || (!active && !contract?.requestedPlan && !query.isPending));
  const plans = useServicePlans(planSelection);
  const choices = suitablePlans(plans.data ?? [], branches.map(branch => branch.mode));
  const selected = choices.find(plan => plan.code === code)?.code ?? '';
  const latestReceipt = contract?.invoices[0]?.id;

  useEffect(() => {
    if (latestReceipt) void client.invalidateQueries({ queryKey: ['tenants'] });
  }, [client, latestReceipt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || submitting.current) return;
    submitting.current = true;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api<{ simulated: boolean }>(`${root}/request`, 'POST', { code: selected });
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['tenants'] }),
        client.invalidateQueries({ queryKey: ['business'] })]);
      setChoosing(false);
      setCode('');
      if (result.simulated) setNotice('Đã kích hoạt gói mô phỏng. Bạn có thể sử dụng các tính năng của gói ngay.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa gửi được yêu cầu.'); }
    finally { setSaving(false); submitting.current = false; }
  }

  return <div className="subscription-management">
    {notice && <p className="success" role="status">{notice}</p>}
    {!active && <p className="notice">{member.subscription?.trial && contract?.expiresAt && new Date(contract.expiresAt) <= new Date()
      ? 'Đã hết 7 ngày dùng thử. Đăng ký gói để tiếp tục sử dụng cửa hàng.'
      : 'Cửa hàng cần gói dịch vụ đang hoạt động để vào khu vực bán hàng.'}</p>}
    <Panel title={member.tenant.name}>
      <State query={query.error && owner && !member.subscription ? { isLoading: false, error: null } : query}/>
      {contract && <>
        <div className="list-row"><strong>{contract.planVersion.plan.name}</strong><span>{contract.trial ? 'Miễn phí 7 ngày' : contract.simulated && simulatedDays ? 'Thanh toán mô phỏng' : `${currency.format(BigInt(contract.planVersion.monthlyVnd))} / tháng`}</span></div>
        <div className="list-row">Trạng thái<strong>{active ? contract.trial ? 'Đang dùng thử' : contract.simulated ? 'Đang hoạt động (mô phỏng)' : 'Đang hoạt động' :
          statuses[contract.status] ?? (contract.expiresAt && new Date(contract.expiresAt) <= new Date() ? 'Đã hết hạn' : 'Chưa bắt đầu')}</strong></div>
        {contract.status !== 'PENDING' && <div className="list-row">Ngày hết hạn<strong>{contract.expiresAt ? date(contract.expiresAt) : 'Không giới hạn'}</strong></div>}
        <div className="list-row">Hạn mức<strong>{contract.planVersion.maxBranches} chi nhánh · {contract.planVersion.maxStaff} nhân viên</strong></div>
        <div className="list-row">Tính năng<strong>{contract.planVersion.features.filter(key => key !== 'inventory' && key !== 'registers').map(key => features[key] ?? key).join(', ') || '—'}</strong></div>
        {contract.requestedPlan && <p className="notice" role="status">Yêu cầu gói <strong>{contract.requestedPlan.name}</strong> · {currency.format(BigInt(contract.requestedPlan.monthlyVnd))} / tháng.
          {' '}{simulatedDays ? 'Bạn có thể kích hoạt gói này ở chế độ mô phỏng.' :
            !contract.onlinePayment ? 'Đang chờ quản trị viên xác nhận thanh toán và kích hoạt.' :
              !checkout ? 'Tạo mã để thanh toán bằng VietQR.' : ''}</p>}
        {contract.rejectedRequest && <p className="notice" role="status"><strong>Yêu cầu gói bị từ chối</strong> · {date(contract.rejectedRequest.rejectedAt)}. {contract.rejectedRequest.reason}</p>}
      </>}
      {canRequest && !planSelection && <button className="plain" onClick={() => {
        setCode(contract?.requestedPlan?.code ?? ''); setChoosing(true); setError(''); setNotice('');
      }}>{simulatedDays ? 'Chọn gói mô phỏng' : checkout?.status === 'EXPIRED' ? 'Tạo mã mới' :
        contract?.onlinePayment && contract.requestedPlan && !checkout ? 'Tạo mã thanh toán' :
          contract?.requestedPlan ? 'Chọn lại gói' : 'Đăng ký hoặc gia hạn gói'}</button>}
      {planSelection && <form onSubmit={submit}>
        <PlanOptions plans={plans} choices={choices} selected={selected} onSelect={setCode}/>
        {simulatedDays && <p className="muted">Kích hoạt ngay trong {simulatedDays} ngày với thanh toán mô phỏng.</p>}
        {contract?.onlinePayment && <p className="muted">Mỗi lần thanh toán tiếp tục gói hiện tại thêm 30 ngày. Khi đổi gói, chu kỳ 30 ngày mới bắt đầu ngay sau khi xác nhận.</p>}
        {checkout?.status === 'PENDING' && <p className="muted">Nếu đã chuyển tiền theo mã hiện tại, hãy chờ xác nhận trước khi chọn gói khác.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button className="button" disabled={saving || !selected}>{saving ? 'Đang xử lý…' : simulatedDays ?
          'Kích hoạt gói mô phỏng' : contract?.onlinePayment ? 'Lấy mã VietQR' : 'Gửi yêu cầu đăng ký gói'}</button>
          {choosing && <button type="button" className="plain" disabled={saving} onClick={() => setChoosing(false)}>Đóng</button>}</div>
      </form>}
    </Panel>
    {checkout && <Panel title="Thanh toán bằng VietQR">
      {checkout.status === 'REVIEW' ? <p className="notice" role="status">Giao dịch {checkout.reference} đang chờ đối soát. Hãy liên hệ JUEE POS để được hỗ trợ trước khi chuyển thêm tiền.</p> :
        checkout.status === 'EXPIRED' ? <p className="notice" role="status">Mã {checkout.reference} đã hết hạn. Nếu đã chuyển, hãy liên hệ JUEE POS với mã giao dịch trên sao kê.</p> :
          <>
            <div className="qr-block">
              <img src={checkout.qrUrl} alt="VietQR thanh toán gói dịch vụ" width={192} height={192} referrerPolicy="no-referrer"/>
              <div>
                <strong>{currency.format(checkout.amount)}</strong>
                <div>{checkout.bank} · <code>{checkout.account}</code></div>
                <div>{checkout.holder}</div>
                <div>Nội dung chuyển khoản <code>{checkout.reference}</code></div>
                <small>Hiệu lực đến {date(checkout.expiresAt)}</small>
              </div>
            </div>
            <p className="notice" role="status">Đang chờ chuyển khoản. Gói tự kích hoạt khi ngân hàng xác nhận đúng số tiền và nội dung.</p>
            <button type="button" className="plain" disabled={query.isFetching} onClick={() => void query.refetch()}>Kiểm tra thanh toán</button>
          </>}
    </Panel>}
    {contract && <Panel title="Lịch sử thanh toán thuê bao">
      {!contract.invoices.length && <p className="muted">Chưa có khoản thu được ghi nhận.</p>}
      {contract.invoices.map(invoice => <div className="list-row" key={invoice.id}>
        <div>{invoice.reference}<small>{date(invoice.paidAt)}{invoice.paymentCode && ' · ' + invoice.paymentCode}</small></div><strong>{currency.format(BigInt(invoice.amountVnd))}</strong>
      </div>)}
    </Panel>}
  </div>;
}
