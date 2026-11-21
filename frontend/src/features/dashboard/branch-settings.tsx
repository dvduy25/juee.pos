'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Store } from 'lucide-react';
import { api } from '@/services/api-client';
import { usesTables, type Branch, type Membership } from '@/types/business';
import { branchNames } from './navigation';
import { BranchLocationFields, readBranchLocation } from './branch-location';

export function BranchSettings({ member, branches, onCreate, embedded = false }: {
  member: Membership; branches: Branch[]; onCreate?: () => void; embedded?: boolean;
}) {
  const tenantId = member.tenant.id;
  const notifications = useQuery({ queryKey: ['notifications', tenantId], enabled: !embedded,
    queryFn: () => api<{ id: string; title: string; body: string }[]>(`/tenants/${tenantId}/notifications`) });
  return <>
    {!embedded && <div className="desk-page-title"><h1>Cửa hàng và chi nhánh</h1>
      {member.role === 'OWNER' && onCreate && <button className="button" onClick={onCreate}><Plus size={17}/> Tạo cửa hàng</button>}
    </div>}
    <div className={embedded ? 'branch-settings' : 'columns branch-settings'}>
      <section className="card"><h2><Store size={20}/> Chi nhánh của {member.tenant.name}</h2>
        {!branches.length && <p className="muted">Bạn chưa được cấp chi nhánh.</p>}
        <BranchManagement key={tenantId} tenantId={tenantId} membership={member} branches={branches}/>
      </section>
      {!embedded && <section className="card"><h2>Thông báo hệ thống</h2>
        {notifications.isLoading && <div className="skeleton"/>}
        {notifications.error && <p className="error" role="alert">{notifications.error.message}</p>}
        {notifications.isSuccess && !notifications.data.length && <p className="muted">Chưa có thông báo.</p>}
        {notifications.data?.map(item => <div className="list-row" key={item.id}><div><strong>{item.title}</strong><p>{item.body}</p></div></div>)}
      </section>}
    </div>
  </>;
}

function BranchManagement({ tenantId, membership, branches }: { tenantId: string; membership: Membership; branches: Branch[] }) {
  const client = useQueryClient();
  const [action, setAction] = useState<{ type: 'rename' | 'create' } | { type: 'edit'; branch: Branch }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const owner = membership.role === 'OWNER';
  const basic = membership.subscription?.features?.includes('basic-sales');
  const canEdit = owner || membership.role === 'MANAGER';
  const root = `/tenants/${tenantId}`;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || pending) return;
    const form = new FormData(event.currentTarget);
    const name = form.get('name');
    const mode = form.get('mode');
    setPending(true);
    setError('');
    try {
      const hasBank = Boolean(form.get('bank') || form.get('account') || form.get('holder'));
      const bankAccount = owner && hasBank ? { bank: form.get('bank'), account: form.get('account'), holder: form.get('holder') } :
        owner && action.type === 'edit' && action.branch.bankAccount?.bank ? null : undefined;
      if (action.type === 'rename') {
        await api(root, 'PATCH', { name });
        await client.invalidateQueries({ queryKey: ['tenants'] });
      } else {
        const location = owner ? readBranchLocation(form) : undefined;
        if (action.type === 'edit') await api(`${root}/branches/${action.branch.id}`, 'PATCH', { name, mode, bankAccount, location });
        else await api(`${root}/branches`, 'POST', { name, mode, bankAccount, location });
        await client.invalidateQueries({ queryKey: ['branches', tenantId] });
      }
      setAction(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể lưu thay đổi.');
    } finally {
      setPending(false);
    }
  }

  const editing = action?.type === 'edit' ? action.branch : undefined;
  return <>
    {branches.map(branch => <div className="list-row" key={branch.id}>
      <div><strong>{branch.name}</strong>{usesTables(branch.mode) && <small>{branch.location ?
        `Phạm vi gọi món QR ${branch.location.radiusMeters} m` : 'Chưa ghim vị trí gọi món QR'}</small>}</div>
      <div className="actions"><span className="badge">{branchNames[branch.mode]}</span>
        {canEdit && <button className="plain" disabled={pending} onClick={() => { setError(''); setAction({ type: 'edit', branch }); }}>Chỉnh sửa</button>}</div>
    </div>)}
    {owner && <div className="actions">
      {basic && <Link className="plain" href="/dashboard/company?tab=subscription">Nâng cấp để thêm chi nhánh</Link>}
      {!basic && !membership.subscription?.trial && <button className="plain" disabled={pending} onClick={() => { setError(''); setAction({ type: 'create' }); }}>Thêm chi nhánh</button>}
      <button className="plain" disabled={pending} onClick={() => { setError(''); setAction({ type: 'rename' }); }}>Đổi tên doanh nghiệp</button>
    </div>}
    {action && <form className="section-title" key={editing?.id ?? action.type} onSubmit={save}>
      <label>{action.type === 'rename' ? 'Tên doanh nghiệp' : 'Tên chi nhánh'}<input name="name" maxLength={120} required
        defaultValue={action.type === 'rename' ? membership.tenant.name : editing?.name}/></label>
      {action.type !== 'rename' && <label>Mô hình<select name="mode" defaultValue={editing?.mode ?? 'RETAIL'}>
        {Object.entries(branchNames).filter(([mode]) => !basic || mode === 'RETAIL').map(([mode, name]) => <option key={mode} value={mode}>{name}</option>)}
      </select></label>}
      {owner && action.type !== 'rename' && <BranchLocationFields location={editing?.location} required={action.type === 'create'}/>}
      {owner && action.type !== 'rename' && <fieldset><legend>Thông tin nhận chuyển khoản</legend>
        <label>Mã BIN ngân hàng (6 số)<input name="bank" inputMode="numeric" pattern="[0-9]{6}" defaultValue={editing?.bankAccount?.bank}/></label>
        <label>Số tài khoản<input name="account" inputMode="numeric" pattern="[0-9]{4,30}" defaultValue={editing?.bankAccount?.account}/></label>
        <label>Tên chủ tài khoản<input name="holder" maxLength={120} defaultValue={editing?.bankAccount?.holder}/></label>
      </fieldset>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions"><button className="button" disabled={pending}>{pending ? 'Đang lưu…' : 'Lưu'}</button>
        <button type="button" className="plain" disabled={pending} onClick={() => setAction(undefined)}>Hủy</button></div>
    </form>}
  </>;
}
