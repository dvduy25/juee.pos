'use client';

import { useLanguage } from '@/i18n/language';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield } from 'lucide-react';
import { api, setToken } from '@/services/api-client';

type Session = { id: string; current: boolean; createdAt: string | null; expiresAt: string };
type CurrentAccount = { id: string; name: string; email: string; hasPassword: boolean };
const formatTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export function AccountSecurity() {
  const { t } = useLanguage();
  const client = useQueryClient();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const account = useQuery({ queryKey: ['account-security-user'], queryFn: () => api<CurrentAccount>('/auth/me') });
  const sessions = useQuery({ queryKey: ['account-sessions'], queryFn: () => api<Session[]>('/auth/sessions') });
  const initialPassword = account.data?.hasPassword === false;

  function signedOut() {
    setToken('');
    client.clear();
    window.location.assign('/login');
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account.data) return;
    const form = new FormData(event.currentTarget);
    setError('');
    if (form.get('password') !== form.get('confirm')) {
      setError('Hai mật khẩu chưa khớp.');
      return;
    }
    setBusy(true);
    try {
      const password = form.get('password');
      if (initialPassword) await api('/auth/set-initial-password', 'POST', { password });
      else await api('/auth/change-password', 'POST', { accountId: account.data.id, currentPassword: form.get('currentPassword'), password });
      signedOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể lưu mật khẩu.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(session: Session) {
    setBusy(true);
    setError('');
    try {
      await api(`/auth/sessions/${session.id}`, 'DELETE');
      if (session.current) signedOut();
      else await client.invalidateQueries({ queryKey: ['account-sessions'] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể thu hồi phiên.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="columns section-title" id="security">
    <div className="card"><h2><Shield size={20}/> {initialPassword ? t("Đặt mật khẩu") : t("Đổi mật khẩu")}</h2>
      {account.isLoading && <div className="skeleton" aria-label={t("Đang tải tài khoản đăng nhập")}/>}
      {account.error && <p className="error" role="alert">{account.error.message}</p>}
      {account.data && <div className="list-row"><div><small>{t("Tài khoản đang đăng nhập")}</small><strong>{account.data.name}</strong>
        <small>{account.data.email}</small></div></div>}
      {error && <p className="error" role="alert">{t(error)}</p>}
      {account.data && <form onSubmit={changePassword}>
        {initialPassword ? <p className="muted">{t("Bạn có thể đặt mật khẩu trong vòng 5 phút sau khi")} <Link href={'/login?' + new URLSearchParams({ next: pathname })}>{t("đăng nhập bằng Google")}</Link>.</p> :
          <label>{t("Mật khẩu hiện tại")}<input name="currentPassword" type="password" autoComplete="current-password" minLength={12} maxLength={128} required/></label>}
        <label>{t("Mật khẩu mới")}<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label>
        <label>{t("Nhập lại mật khẩu")}<input name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label>
        <p className="muted">{t("Lưu mật khẩu sẽ đăng xuất tất cả phiên của bạn.")}</p>
        <button className="button" disabled={busy}>{initialPassword ? t("Đặt mật khẩu") : t("Đổi mật khẩu")}</button>
      </form>}
    </div>
    <div className="card"><h2>{t("Phiên đăng nhập")}</h2>
      {sessions.isLoading && <div className="skeleton" aria-label={t("Đang tải")}/>}
      {sessions.error && <p className="error" role="alert">{sessions.error.message}</p>}
      {sessions.data?.map(session => <div className="list-row" key={session.id}>
        <div><strong>{session.current ? t("Phiên hiện tại") : t("Phiên khác")}</strong>
          {session.createdAt && <small>{t("Đăng nhập")} {formatTime.format(new Date(session.createdAt))}</small>}
          <small>{t("Hết hạn")} {formatTime.format(new Date(session.expiresAt))}</small>
        </div><button className="plain" disabled={busy} onClick={() => void revoke(session)}>{session.current ? t("Đăng xuất") : t("Thu hồi")}</button>
      </div>)}
    </div>
  </section>;
}
