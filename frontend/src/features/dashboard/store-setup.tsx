'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BedDouble, Coffee, Dumbbell, Layers3, LogOut, Store, Ticket, Utensils } from 'lucide-react';
import { State } from '@/components/business-ui';
import { FullscreenButton } from '@/components/fullscreen-button';
import { api } from '@/services/api-client';
import type { WorkspaceLayoutProps } from '@/components/workspace';
import { branchNames } from './navigation';
import { PlanOptions, suitablePlans, useServicePlans } from './plan-options';
import { BranchLocationFields, readBranchLocation } from './branch-location';

const models = [
  { mode: 'RETAIL', name: 'Bán lẻ', Icon: Store, description: 'Quầy thu ngân và sản phẩm' },
  { mode: 'RESTAURANT', name: 'Nhà hàng', Icon: Utensils, description: 'Bàn, thực đơn, gọi món QR và bếp' },
  { mode: 'CAFE', name: 'Quán nước', Icon: Coffee, description: 'Đồ uống, gọi món tại bàn và pha chế' },
  { mode: 'MEMBERS', name: 'Hội viên', Icon: Dumbbell, description: 'Gói tập, thẻ bơi và lượt vào' },
  { mode: 'HOTEL', name: branchNames.HOTEL, Icon: BedDouble, description: 'Phòng, đặt chỗ, nhận và trả phòng' },
  { mode: 'TICKETS', name: branchNames.TICKETS, Icon: Ticket, description: 'Loại vé, bán vé QR và soát vé vào cửa' },
] as const;
type Model = typeof models[number];

export function StoreSetup({ dark, onLogout, error, onCreate, onBack }: Pick<WorkspaceLayoutProps, 'dark' | 'onLogout' | 'error'> & {
  onCreate: (id: string, branchId: string) => void; onBack?: () => void;
}) {
  const [model, setModel] = useState<Model>();
  return <div className={`auth setup-page ${dark ? 'dark' : ''}`}>
    <main className="setup-content">
      <header className="auth-header"><Link className="brand" href="/"><Layers3/> JUEE POS</Link>
        <div className="actions"><FullscreenButton className="icon"/><button className="plain" onClick={onLogout}><LogOut size={17}/> Đăng xuất</button></div>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {model ? <StoreRegistration model={model} onBack={() => setModel(undefined)} onCreate={onCreate}/> : <>
        <div className="page-heading"><div><h1>Chọn mô hình quản lý</h1><p>Chọn cách cửa hàng của bạn hoạt động.</p></div></div>
        <div className="setup-models">{models.map(item => <button type="button" className="card setup-model" key={item.mode}
          data-theme={item.mode === 'MEMBERS' ? 'GYM' : item.mode} onClick={() => setModel(item)}>
          <span className="setup-icon"><item.Icon size={26}/></span><strong>{item.name}</strong><small>{item.description}</small>
        </button>)}</div>
        {onBack && <button className="plain" onClick={onBack}><ArrowLeft size={16}/> Về cửa hàng</button>}
      </>}
    </main>
  </div>;
}

function StoreRegistration({ model, onBack, onCreate }: { model: Model; onBack: () => void; onCreate: (id: string, branchId: string) => void }) {
  const client = useQueryClient();
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [option, setOption] = useState<'FREE' | 'PAID'>();
  const [facility, setFacility] = useState<'GYM' | 'POOL'>('GYM');
  const [code, setCode] = useState('');
  const setup = useQuery({ queryKey: ['tenants', 'setup'],
    queryFn: () => api<{ freeAvailable: boolean; simulatedPlanDays: number | null; onlinePayment: boolean }>('/tenants/setup') });
  const canUseFree = setup.data?.freeAvailable && model.mode === 'RETAIL';
  const subscription = canUseFree ? (option ?? 'FREE') : 'PAID';
  const simulatedDays = setup.data?.simulatedPlanDays;
  const mode = model.mode === 'MEMBERS' ? facility : model.mode;
  const plans = useServicePlans(!!setup.data && subscription === 'PAID');
  const choices = suitablePlans(plans.data ?? [], [mode]);
  const selected = choices.find(plan => plan.code === code)?.code ?? '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup.data || submitting.current || (subscription === 'PAID' && !selected)) return;
    const data = new FormData(event.currentTarget);
    submitting.current = true;
    setSaving(true); setError('');
    try {
      const store = await api<{ id: string; branches: { id: string }[] }>('/tenants', 'POST', {
        name: data.get('tenant'), branch: { name: data.get('branch'), mode, location: readBranchLocation(data) }, subscription,
        ...(subscription === 'PAID' ? { planCode: selected } : {}),
      });
      await client.invalidateQueries({ queryKey: ['tenants'] });
      onCreate(store.id, store.branches[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa tạo được cửa hàng.');
      void setup.refetch();
    } finally { submitting.current = false; setSaving(false); }
  }

  return <section className="card setup-form" data-theme={mode}>
    <button type="button" className="plain" onClick={onBack} disabled={saving}><ArrowLeft size={16}/> Chọn mô hình khác</button>
    <h1>Đăng ký cửa hàng {model.name.toLowerCase()}</h1>
    <State query={setup}/>
    {setup.data && <form onSubmit={submit}>
      <div className="columns">
        <label>Tên cửa hàng<input name="tenant" autoComplete="organization" required maxLength={120}/></label>
        <label>Tên chi nhánh<input name="branch" defaultValue="Chi nhánh chính" required maxLength={120}/></label>
      </div>
      {model.mode === 'MEMBERS' && <label>Loại cơ sở<select value={facility} onChange={event => setFacility(event.target.value === 'POOL' ? 'POOL' : 'GYM')}>
        <option value="GYM">{branchNames.GYM}</option><option value="POOL">{branchNames.POOL}</option>
      </select></label>}
      <BranchLocationFields required/>
      {canUseFree && <fieldset className="branch-models setup-plans"><legend>Hình thức đăng ký</legend>
        <label className="branch-model"><input type="radio" name="subscription" checked={subscription === 'FREE'} onChange={() => setOption('FREE')}/>
          <strong>Miễn phí</strong><small>Doanh nghiệp đầu tiên, một chi nhánh bán lẻ</small></label>
        <label className="branch-model"><input type="radio" name="subscription" checked={subscription === 'PAID'} onChange={() => setOption('PAID')}/>
          <strong>{simulatedDays ? 'Đăng ký gói mô phỏng' : 'Đăng ký gói trả phí'}</strong>
          {!simulatedDays && <small>Kích hoạt sau khi xác nhận thanh toán</small>}</label>
      </fieldset>}
      {subscription === 'PAID' && <PlanOptions plans={plans} choices={choices} selected={selected} onSelect={setCode}/>}
      {subscription === 'PAID' && simulatedDays && <p className="muted">Dùng gói đã chọn trong {simulatedDays} ngày với thanh toán mô phỏng.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" disabled={saving || (subscription === 'PAID' && !selected)}>{saving ? 'Đang xử lý…' : subscription === 'FREE' ? 'Tạo cửa hàng miễn phí' :
        simulatedDays ? 'Tạo cửa hàng và kích hoạt gói mô phỏng' : setup.data.onlinePayment ? 'Tạo cửa hàng và lấy mã thanh toán' : 'Gửi yêu cầu đăng ký gói'}</button>
    </form>}
  </section>;
}
