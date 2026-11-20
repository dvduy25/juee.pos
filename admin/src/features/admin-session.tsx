'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Layers3 } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminLayout, type AdminUser } from './admin-layout';
import { api, ApiError, restore, setToken } from '@/services/api-client';

export function AdminLogin() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || retryAt > Date.now()) return;
    const form = new FormData(event.currentTarget);
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const session = await api<{ accessToken: string }>('/admin-auth/login', 'POST', {
        email: form.get('email'), password: form.get('password'), otp: form.get('otp'),
      });
      setToken(session.accessToken);
      router.replace('/super-admin');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa đăng nhập được.');
      if (cause instanceof ApiError && cause.retryAfterSeconds) setRetryAt(Date.now() + cause.retryAfterSeconds * 1000);
      setPending(false);
      submitting.current = false;
    }
  }

  return <main className="admin-auth">
    <section className="card admin-login" aria-labelledby="admin-login-title">
      <div className="admin-brand"><Layers3 size={25} aria-hidden="true"/> JUEE POS</div>
      <h1 id="admin-login-title">Đăng nhập Super Admin</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <form onSubmit={login}>
        <label>Email quản trị<input type="email" name="email" autoComplete="username" required/></label>
        <label>Mật khẩu<input type="password" name="password" autoComplete="current-password" required minLength={12} maxLength={128}/></label>
        <label>Mã từ ứng dụng Authenticator<input name="otp" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required/></label>
        <button className="button" disabled={pending || retryAt > 0}>{pending ? 'Đang đăng nhập…' : retryAt ? 'Vui lòng chờ…' : 'Đăng nhập'}</button>
      </form>
    </section>
  </main>;
}

export function AdminWorkspace({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [user, setUser] = useState<AdminUser>();
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    restore().then(async ok => ok ? api<AdminUser>('/admin-auth/me') : undefined).then(result => {
      if (!mounted) return;
      if (result) setUser(result);
      else router.replace('/login');
    }).catch(cause => {
      if (!mounted) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) router.replace('/login');
      else setError(cause instanceof Error ? cause.message : 'Không thể tải phiên quản trị.');
    });
    return () => { mounted = false; };
  }, [router]);

  async function logout() {
    try {
      await api('/admin-auth/logout', 'POST');
      setToken('');
      client.clear();
      setUser(undefined);
      router.replace('/login');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa đăng xuất được.');
    }
  }

  return <QueryClientProvider client={client}>
    {user ? <AdminLayout user={user} logout={() => void logout()} error={error}>{children}</AdminLayout> :
      <main className="admin-auth">{error ?
        <section className="card admin-login"><p className="error" role="alert">{error}</p>
          <button type="button" className="plain" onClick={() => window.location.reload()}>Thử lại</button></section> :
        <div className="card skeleton" aria-label="Đang tải phiên quản trị"/>}</main>}
  </QueryClientProvider>;
}
