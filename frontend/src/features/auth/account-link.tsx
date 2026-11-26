'use client';

import { useLanguage } from '@/i18n/language';
import { LanguageSwitch } from '@/components/language-switch';
import Link from 'next/link';
import { FullscreenButton } from '@/components/fullscreen-button';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Layers3 } from 'lucide-react';
import { api } from '@/services/api-client';
import { AuthScene } from './auth-scene';

type Mode = 'verify-email' | 'forgot-password' | 'reset-password';
const titles: Record<Mode, string> = {
  'verify-email': 'Xác minh email',
  'forgot-password': 'Quên mật khẩu',
  'reset-password': 'Đặt lại mật khẩu',
};

export function AccountLink({ mode }: { mode: Mode }) {
  const { homeHref, t } = useLanguage();
  const [email, setEmail] = useState('');
  const [resend, setResend] = useState(false);
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    setToken(fragment.get('token') ?? '');
    const parameters = new URLSearchParams(window.location.search);
    setEmail((fragment.get('email') ?? parameters.get('email') ?? '').slice(0, 254));
    if (mode === 'verify-email') {
      const delivery = fragment.get('delivery');
      if (delivery === 'sent') setMessage('Đã gửi mã OTP gồm 6 chữ số. Mã có hiệu lực trong 10 phút.');
      if (delivery === 'retry') {
        setResend(true);
        setError('Tài khoản đã được tạo nhưng email chưa gửi thành công. Hãy gửi lại mã OTP.');
      }
    }
    setReady(true);
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = new FormData(event.currentTarget);
    submitting.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'reset-password') {
        if (form.get('password') !== form.get('confirm')) throw new Error('Hai mật khẩu chưa khớp.');
        await api('/auth/reset-password', 'POST', { token, password: form.get('password') });
        setMessage('Đã đổi mật khẩu. Hãy đăng nhập lại.');
      } else if (mode === 'verify-email' && token) {
        await api('/auth/verify-email', 'POST', { token });
        setMessage('Email đã được xác minh. Bạn có thể đăng nhập.');
      } else if (mode === 'verify-email' && !resend) {
        await api('/auth/verify-email', 'POST', { email: form.get('email'), code: form.get('code') });
        setMessage('Email đã được xác minh. Bạn có thể đăng nhập.');
      } else {
        const endpoint = mode === 'verify-email' ? 'resend-verification' : mode;
        await api(`/auth/${endpoint}`, 'POST', { email: form.get('email') });
        setMessage('Nếu địa chỉ email đủ điều kiện, bạn sẽ nhận được hướng dẫn trong hộp thư.');
        if (mode === 'verify-email') {
          setEmail(String(form.get('email') ?? ''));
          setResend(false);
          return;
        }
      }
      if (token) window.history.replaceState(null, '', window.location.pathname);
      setCompleted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không xử lý được yêu cầu.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const verify = mode === 'verify-email';
  const content = <>
    {error && <p className={`error ${verify ? 'access-feedback' : ''}`} role="alert">{t(error)}</p>}
    {message && <p className={verify ? 'access-note' : undefined} role="status">{t(message)}</p>}
    {ready && !completed && (mode === 'reset-password' && !token
      ? <p>{t("Mở liên kết trong email hoặc")} <Link className="plain" href="/forgot-password">{t("yêu cầu liên kết mới")}</Link>.</p>
      : <form method="post" className={verify ? 'access-form' : undefined} onSubmit={submit}>
        {mode === 'reset-password' && <>
          <label>{t("Mật khẩu mới")}<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label>
          <label>{t("Nhập lại mật khẩu")}<input name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} required/></label>
        </>}
        {(mode === 'forgot-password' || (mode === 'verify-email' && !token)) &&
          <label className={verify ? 'access-field' : undefined}>Email<input name="email" type="email" autoComplete="email" maxLength={254}
            value={email} onChange={event => setEmail(event.target.value)} required/></label>}
        {mode === 'verify-email' && !token && !resend && <label>{t("Mã OTP 6 chữ số")}<input name="code"
          className="access-code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" maxLength={6} required/></label>}
        <button className={verify ? 'button access-submit' : 'button'} disabled={busy}>{busy ? t("Đang xử lý…") :
          token || (verify && !resend) ? titles[mode] : verify ? t("Gửi mã OTP") : t("Gửi email")}</button>
        {mode === 'verify-email' && !token && <button type="button" className="plain" disabled={busy}
          onClick={() => { setResend(!resend); setError(''); setMessage(''); }}>{resend ? t("Nhập mã OTP") : t("Gửi lại mã OTP")}</button>}
      </form>)}
    {mode === 'verify-email' && token && error && <a className="plain" href="/verify-email">{t("Yêu cầu liên kết mới")}</a>}
  </>;

  if (verify) return <AuthScene title={t(titles[mode])} description={!completed ? t("Nhập mã xác minh được gửi đến email đăng ký.") : undefined}>
    {content}
    <p className="access-footer"><Link href="/login">{t("Về trang đăng nhập")}</Link></p>
  </AuthScene>;

  return <div className="auth"><section className="card auth-card">
    <div className="auth-header"><a className="brand" href={homeHref}><Layers3/> JUEE POS</a><div className="access-header-tools"><LanguageSwitch/><FullscreenButton/></div></div>
    <h1>{t(titles[mode])}</h1>
    {content}
    <Link className="plain" href="/login">{t("Về trang đăng nhập")}</Link>
  </section></div>;
}
