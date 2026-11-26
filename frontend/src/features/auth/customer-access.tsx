'use client';

import { useLanguage } from '@/i18n/language';
import Link from 'next/link';
import { ArrowRight, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, setToken } from '@/services/api-client';
import { AuthScene } from './auth-scene';

const googleMessages: Record<string, string> = {
  unavailable: 'Trang này chưa bật đăng nhập bằng Google.',
  expired: 'Yêu cầu đăng nhập Google đã hết hạn. Vui lòng thử lại.',
  cancelled: 'Bạn đã hủy đăng nhập bằng Google.',
  failed: 'Chưa đăng nhập được bằng Google. Vui lòng thử lại.',
  existing: 'Email này đã có tài khoản JUEE POS. Hãy đăng nhập bằng email và mật khẩu.',
  restricted: 'Tài khoản này chưa được phép đăng nhập vào quầy.',
  unsupported_email: 'Hãy chọn tài khoản Gmail hoặc Google Workspace. Bạn cũng có thể đăng ký bằng email và xác minh OTP.',
};

function GoogleAccess({ from }: { from: 'login' | 'register' }) {
  const { t } = useLanguage();
  const [available, setAvailable] = useState(false);
  const [next, setNext] = useState('');
  const [status, setStatus] = useState('');
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    let mounted = true;
    const search = new URLSearchParams(window.location.search);
    const currentOrigin = window.location.origin;
    setStatus(search.get('google') ?? '');
    setNext(search.get('next') ?? '');
    setOrigin(currentOrigin);
    api<{ google: boolean }>(`/auth/providers?${new URLSearchParams({ origin: currentOrigin })}`)
      .then(result => { if (mounted) setAvailable(result.google === true); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  if (!available && !Object.hasOwn(googleMessages, status)) return null;
  const registering = from === 'register';
  const params = new URLSearchParams({ from, origin, ...(next && { next }) });
  const divider = <div className="access-divider"><span>{registering ? t("hoặc đăng ký bằng email") : t("hoặc")}</span></div>;
  return <div className={registering ? 'access-provider access-provider-first' : 'access-provider'}>
    {Object.hasOwn(googleMessages, status) && <p className="error access-feedback" role="alert">{t(googleMessages[status])}</p>}
    {available && <>
      {!registering && divider}
      <a className="access-google" href={'/api/v1/auth/google/start?' + params} referrerPolicy="no-referrer">
        <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="18" height="18" alt="" referrerPolicy="no-referrer"/>
        {registering ? t("Đăng ký bằng Google") : t("Tiếp tục với Google")}
      </a>
      {registering && divider}
    </>}
  </div>;
}

function PasswordField({ name, label, registering, hint, invalid, onInput }: {
  name: string; label: string; registering?: boolean; hint?: string; invalid?: boolean; onInput?: () => void;
}) {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  return <div className="access-field access-password-field"><label htmlFor={name}>{label}</label>
    <span className="access-password">
      <input id={name} name={name} type={visible ? 'text' : 'password'}
        autoComplete={registering ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required
        aria-describedby={hint ? `${name}-hint` : invalid ? 'confirm-error' : undefined}
        aria-invalid={invalid || undefined} onInput={onInput}/>
      <button className="access-eye" type="button" aria-label={`${visible ? t('Ẩn') : t('Hiện')} ${label.toLowerCase()}`}
        onClick={() => setVisible(!visible)}>
        {visible ? <EyeOff size={18} aria-hidden="true"/> : <Eye size={18} aria-hidden="true"/>}
      </button>
    </span>
    {hint && <small id={`${name}-hint`}>{hint}</small>}
    {invalid && <small id="confirm-error" className="access-field-error" role="alert">{t("Hai mật khẩu chưa khớp.")}</small>}
  </div>;
}

function PhoneField() {
  const { t } = useLanguage();
  return <label className="access-field">{t("Số điện thoại")}
    <input name="phone" type="tel" autoComplete="tel" maxLength={32} placeholder="09xx xxx xxx" required/>
  </label>;
}

async function signIn(email: string, password: string) {
  const session = await api<{ accessToken: string }>('/auth/login', 'POST', { email, password });
  setToken(session.accessToken);
}

function useAuthSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const active = useRef(false);

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  async function run(action: () => Promise<void>) {
    if (active.current || retryAt > Date.now()) return;
    active.current = true;
    setPending(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Chưa kết nối được dịch vụ. Vui lòng thử lại.');
      if (cause instanceof ApiError && cause.retryAfterSeconds) setRetryAt(Date.now() + cause.retryAfterSeconds * 1000);
    } finally {
      active.current = false;
      setPending(false);
    }
  }

  return { run, pending, error, coolingDown: retryAt > 0 };
}

function AccessSubmit({ pending, coolingDown, label, working }: {
  pending: boolean; coolingDown: boolean; label: string; working: string;
}) {
  const { t } = useLanguage();
  return <button className="button access-submit" disabled={pending || coolingDown}>
    {pending ? working : coolingDown ? t("Vui lòng chờ…") : label}
    {pending ? <LoaderCircle className="access-spinner" size={18} aria-hidden="true"/> : <ArrowRight size={18} aria-hidden="true"/>}
  </button>;
}

function loginDestination() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !/^\/dashboard(?:[/?#]|$)/.test(next)) return '/dashboard';
  const target = new URL(next, window.location.origin);
  if (target.origin !== window.location.origin || !/^\/dashboard(?:\/|$)/.test(target.pathname)) return '/dashboard';
  return target.pathname + target.search + target.hash;
}

export function CustomerLogin() {
  const { t } = useLanguage();
  const { run, error, pending, coolingDown } = useAuthSubmit();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      await signIn(String(form.get('email')).trim(), String(form.get('password')));
      window.location.replace(loginDestination());
    });
  }

  return <AuthScene interactive title={t("Đăng nhập")} description={t("Vào cửa hàng của bạn trên JUEE POS.")}>
    {error && <p className="error access-feedback" role="alert">{t(error)}</p>}
    <form className="access-form" method="post" onSubmit={submit}>
      <fieldset disabled={pending} aria-busy={pending}>
        <label className="access-field">Email<input name="email" type="email" autoComplete="username" maxLength={254}
          placeholder="ban@cuahang.vn" required/></label>
        <PasswordField name="password" label={t("Mật khẩu")}/>
        <div className="access-help">
          <Link href="/forgot-password">{t("Quên mật khẩu?")}</Link>
          <Link href="/verify-email">{t("Xác minh email")}</Link>
        </div>
      </fieldset>
      <AccessSubmit pending={pending} coolingDown={coolingDown} label={t("Đăng nhập")} working={t("Đang đăng nhập…")}/>
    </form>
    <GoogleAccess from="login"/>
    <p className="access-footer">{t("Chưa có tài khoản?")} <Link href="/register">{t("Đăng ký")}</Link></p>
  </AuthScene>;
}

export function CustomerRegister() {
  const { t } = useLanguage();
  const { run, error, pending, coolingDown } = useAuthSubmit();
  const [confirmationError, setConfirmationError] = useState(false);
  const [created, setCreated] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const name = String(form.get('name')).trim();
    const email = String(form.get('email')).trim();
    const phone = String(form.get('phone')).trim();
    const password = String(form.get('password'));
    if (form.get('confirm') !== password) {
      setConfirmationError(true);
      element.querySelector<HTMLInputElement>('#confirm')?.focus();
      return;
    }
    void run(async () => {
      const result = await api<{ emailVerificationRequired: boolean; verificationSent: boolean }>(
        '/auth/register', 'POST', { name, email, phone, password },
      );
      if (result.emailVerificationRequired) {
        const parameters = new URLSearchParams({ email, delivery: result.verificationSent ? 'sent' : 'retry' });
        window.location.replace(`/verify-email#${parameters}`);
      } else {
        try {
          await signIn(email, password);
        } catch (cause) {
          setCreated(true);
          throw cause;
        }
        window.location.replace('/dashboard');
      }
    });
  }

  return <AuthScene interactive title={t("Tạo tài khoản")} description={t("Chuẩn bị số điện thoại để hoàn tất đăng ký.")}>
    {created && <p className="success access-feedback" role="status">{t("Đã tạo tài khoản.")}</p>}
    {error && <p className="error access-feedback" role="alert">{t(error)}</p>}
    {!created && <GoogleAccess from="register"/>}
    {created ? <Link className="button access-submit" href="/login">{t("Đến trang đăng nhập")} <ArrowRight size={18} aria-hidden="true"/></Link> :
      <form className="access-form" method="post" onSubmit={submit}>
        <fieldset disabled={pending} aria-busy={pending}>
          <label className="access-field">{t("Họ và tên")}<input name="name" autoComplete="name" maxLength={120} placeholder="Nguyễn Văn An"
            pattern={'.*\\S.*'} title={t("Nhập họ và tên.")} required/></label>
          <label className="access-field">Email<input name="email" type="email" autoComplete="username" maxLength={254}
            placeholder="ban@cuahang.vn" required/></label>
          <PhoneField/>
          <PasswordField name="password" label={t("Mật khẩu")} registering hint={t("Ít nhất 12 ký tự.")}
            onInput={() => setConfirmationError(false)}/>
          <PasswordField name="confirm" label={t("Nhập lại mật khẩu")} registering invalid={confirmationError}
            onInput={() => setConfirmationError(false)}/>
        </fieldset>
        <AccessSubmit pending={pending} coolingDown={coolingDown} label={t("Đăng ký")} working={t("Đang tạo tài khoản…")}/>
      </form>}
    {!created && <p className="access-footer">{t("Đã có tài khoản?")} <Link href="/login">{t("Đăng nhập")}</Link></p>}
  </AuthScene>;
}

export function GoogleRegistration() {
  const { t } = useLanguage();
  const { run, pending, error, coolingDown } = useAuthSubmit();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phone = String(new FormData(event.currentTarget).get('phone')).trim();
    void run(async () => {
      const { destination } = await api<{ destination: string }>('/auth/google/register', 'POST', { phone });
      window.location.replace(destination);
    });
  }

  return <AuthScene interactive title={t("Hoàn tất đăng ký Google")} description={t("Nhập số điện thoại của bạn để tạo tài khoản JUEE POS.")}>
    {error && <p className="error access-feedback" role="alert">{t(error)}</p>}
    <form className="access-form" method="post" onSubmit={submit}>
      <fieldset disabled={pending} aria-busy={pending}><PhoneField/></fieldset>
      <AccessSubmit pending={pending} coolingDown={coolingDown} label={t("Tạo tài khoản")} working={t("Đang tạo tài khoản…")}/>
    </form>
    <p className="access-footer"><Link href="/register">{t("Về đăng ký")}</Link></p>
  </AuthScene>;
}
