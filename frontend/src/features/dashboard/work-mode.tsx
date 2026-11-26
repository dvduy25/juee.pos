'use client';

import { useLanguage } from '@/i18n/language';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { LockKeyhole, UserRound } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setToken } from '@/services/api-client';

export function WorkModeControl({ staffMode, tenantId, branchId, description, hasPassword, onChange }: {
  staffMode: boolean; tenantId?: string; branchId?: string; description: string; hasPassword: boolean;
  onChange: (scope?: { tenantId: string; branchId: string }) => void;
}) {
  const { t } = useLanguage();
  const client = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function switchMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasPassword || submitting.current || (!staffMode && (!tenantId || !branchId))) return;
    const form = event.currentTarget;
    const password = new FormData(form).get('password');
    form.reset();
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const response = await api<{ accessToken: string }>('/auth/work-mode', 'POST',
        staffMode ? { mode: 'MANAGEMENT', password } : { mode: 'STAFF', tenantId, branchId });
      setToken(response.accessToken);
      client.clear();
      onChange(!staffMode && tenantId && branchId ? { tenantId, branchId } : undefined);
      localStorage.setItem('juee-work-mode-change', String(Date.now()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa chuyển được chế độ.');
      submitting.current = false;
      setPending(false);
    }
  }

  return <><button className="desk-icon work-mode-toggle" type="button" onClick={() => { setError(''); dialog.current?.showModal(); }}>
    {staffMode ? <UserRound size={17}/> : <LockKeyhole size={17}/>} {staffMode ? t("Nhân viên") : t("Quản lý")}
  </button><dialog ref={dialog} className="card work-mode-dialog" aria-labelledby="work-mode-title" onCancel={event => {
    if (pending) event.preventDefault();
  }}>
    <h2 id="work-mode-title">{staffMode ? t("Mở chế độ Quản lý") : t("Chuyển sang chế độ Nhân viên")}</h2>
    {!hasPassword ? <>
      <p><Link href="/dashboard/company/security" onClick={() => dialog.current?.close()}>{t("Đặt mật khẩu")}</Link> {t("để có thể mở lại chế độ Quản lý.")}</p>
      <button type="button" className="plain" onClick={() => dialog.current?.close()}>{t("Đóng")}</button>
    </> : <form onSubmit={switchMode}>
      {staffMode ? <label>{t("Mật khẩu tài khoản")}<input name="password" type="password" autoComplete="off" minLength={12} maxLength={128} required/></label> :
        <p>{description} {t("Cần mật khẩu tài khoản để quay lại Quản lý.")}</p>}
      {error && <p className="error" role="alert">{t(error)}</p>}
      <div className="actions"><button className="button" disabled={pending}>{pending ? t("Đang chuyển…") : staffMode ? t("Mở Quản lý") : t("Chuyển sang Nhân viên")}</button>
        <button type="button" className="plain" disabled={pending} onClick={() => dialog.current?.close()}>{t("Đóng")}</button></div>
    </form>}
  </dialog></>;
}
