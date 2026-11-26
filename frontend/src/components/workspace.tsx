'use client';

import { useLanguage } from '@/i18n/language';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { api, restore, setToken, ApiError } from '@/services/api-client';
import { PageLoading } from './page-loading';

export type BranchSelection = { tenantId: string; branchId: string };
type User = { name: string; email: string; hasPassword?: boolean; staffMode?: BranchSelection; selectedBranch?: BranchSelection };

export type WorkspaceLayoutProps = {
  user: User;
  dark: boolean;
  onThemeChange: () => void;
  onLogout: () => void;
  onWorkModeChange: (staffMode: User['staffMode']) => void;
  onBranchChange: (scope: BranchSelection) => void;
  error: string;
  children: ReactNode;
};

type WorkspaceProps = {
  layout: ComponentType<WorkspaceLayoutProps>;
  children: ReactNode;
};

export function Workspace({ layout, children }: WorkspaceProps) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><Shell layout={layout}>{children}</Shell></QueryClientProvider>;
}

function Shell({ layout: Layout, children }: WorkspaceProps) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [user, setUser] = useState<User>();
  const [error, setError] = useState('');
  const [dark, setDark] = useState(false);

  function toggleTheme() {
    localStorage.setItem('juee-theme', dark ? 'light' : 'dark');
    setDark(!dark);
  }

  useEffect(() => {
    let mounted = true;
    const goToLogin = () => {
      const { pathname, search, hash } = window.location;
      router.replace('/login?' + new URLSearchParams({ next: pathname + search + hash }));
    };
    try { setDark(localStorage.getItem('juee-theme') === 'dark'); } catch { /* Use the default theme. */ }
    restore().then(ok => ok ? api<User>('/auth/me') : undefined).then(result => {
      if (!mounted) return;
      if (result) setUser(result);
      else goToLogin();
    }).catch(cause => {
      if (!mounted) return;
      if (cause instanceof ApiError && cause.status === 401) goToLogin();
      else setError(cause instanceof ApiError ? cause.message : 'Không thể tải phiên đăng nhập.');
    });
    return () => { mounted = false; };
  }, [router]);

  useEffect(() => {
    const syncMode = (event: StorageEvent) => {
      if (event.key === 'juee-work-mode-change') window.location.reload();
    };
    window.addEventListener('storage', syncMode);
    return () => window.removeEventListener('storage', syncMode);
  }, []);

  async function logout() {
    try {
      await api('/auth/logout', 'POST');
      setToken(''); queryClient.clear(); setUser(undefined); setError('');
      router.replace('/login');
    } catch { setError('Không thể đăng xuất. Vui lòng thử lại.'); }
  }

  if (!user && !error) return <PageLoading fullPage dark={dark}/>;
  if (!user) return <div className={`auth ${dark ? 'dark' : ''}`}>
    <div className="card auth-card">
      <p role="alert" className="error">{t(error)}</p>
      <button className="plain" type="button" onClick={() => window.location.reload()}>{t("Thử lại")}</button>
      <Link className="plain" href="/login">{t("Trang đăng nhập")}</Link>
    </div>
  </div>;

  return <Layout user={user} dark={dark} onThemeChange={toggleTheme} onLogout={logout} error={error}
    onWorkModeChange={staffMode => { setUser(previous => previous && { ...previous, staffMode }); setError(''); }}
    onBranchChange={selectedBranch => { setUser(previous => previous && { ...previous, selectedBranch }); setError(''); }}>{children}</Layout>;

}
