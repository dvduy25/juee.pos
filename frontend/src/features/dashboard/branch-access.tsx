'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BusinessDialog } from '@/components/business-dialog';
import { State } from '@/components/business-ui';
import type { BranchSelection } from '@/components/workspace';
import { api } from '@/services/api-client';
import type { Branch, Membership } from '@/types/business';

export function BranchAccessDialog({ member, requestedBranch, email, hasPassword, close, changeAccount, onConfirmed }: {
  member: Membership; requestedBranch?: string; email: string; hasPassword: boolean; close: () => void; changeAccount: () => void;
  onConfirmed: (scope: BranchSelection) => void;
}) {
  const tenantId = member.tenant.id;
  const permitted = member.role === 'OWNER' || member.role === 'MANAGER';
  const branches = useQuery({ queryKey: ['branches', tenantId, false], enabled: permitted,
    queryFn: () => api<Branch[]>(`/tenants/${tenantId}/branches`) });
  const [selection, setSelection] = useState(requestedBranch ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const branch = branches.data?.find(item => item.id === (selection || branches.data?.[0]?.id));

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!branch || !permitted || !hasPassword || submitting.current) return;
    const form = event.currentTarget;
    const password = new FormData(form).get('password');
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const scope = await api<BranchSelection>('/auth/branch-access', 'POST', { tenantId, branchId: branch.id, password });
      onConfirmed(scope);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa xác nhận được quyền vào chi nhánh.');
      const input = form.elements.namedItem('password');
      if (input instanceof HTMLInputElement) { input.value = ''; input.focus(); }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <BusinessDialog title="Xác nhận chuyển chi nhánh" close={close} pending={pending}>
    <p className="scope-dialog-business">{member.tenant.name}</p>
    {permitted ? <State query={branches}/> : <p>Hãy dùng tài khoản chủ doanh nghiệp hoặc quản lý được giao chi nhánh này.</p>}
    {permitted && branches.isSuccess && !branch && <p className="notice">Tài khoản này chưa được cấp quyền vào chi nhánh đã chọn.</p>}
    {permitted && branch && !hasPassword && <p className="notice"><Link href="/dashboard/company/security" onClick={close}>Đặt mật khẩu</Link> để xác nhận chuyển chi nhánh.</p>}
    {permitted && branch && hasPassword && <form onSubmit={confirm}>
      {requestedBranch ? <p>Chi nhánh <strong>{branch.name}</strong></p> :
        <label>Chi nhánh<select value={branch.id} onChange={event => { setSelection(event.target.value); setError(''); }}>
          {branches.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
      <label>Tài khoản đang đăng nhập<input name="email" type="email" value={email} readOnly autoComplete="username"/></label>
      <label>Mật khẩu<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="current-password"/></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" type="submit" disabled={pending}>{pending ? 'Đang xác nhận…' : 'Vào chi nhánh'}</button>
    </form>}
    <button className="plain" type="button" disabled={pending} onClick={changeAccount}>Đăng nhập tài khoản khác</button>
  </BusinessDialog>;
}
