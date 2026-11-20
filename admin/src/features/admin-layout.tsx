'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode } from 'react';
import { Activity, Banknote, Bell, Building2, ClipboardList, Code2, CreditCard, Database, Layers3, LayoutDashboard, LogOut, Store, Users } from 'lucide-react';
import { adminHref, sections } from './sections';

const icons = {
  dashboard: LayoutDashboard, users: Users, tenants: Building2, branches: Store, plans: Layers3,
  subscriptions: CreditCard, revenue: Activity, invoices: Banknote, notifications: Bell, 'audit-logs': ClipboardList,
  status: Database, developer: Code2,
};

export type AdminUser = { name: string; email: string; platformWrite: boolean };
export const AdminWriteContext = createContext(false);

export function AdminLayout({ user, logout, error, children }: {
  user: AdminUser; logout: () => void; error: string; children: ReactNode;
}) {
  const path = usePathname();
  const active = sections.find(item => adminHref(item.key) === path) ?? sections[0];
  return <AdminWriteContext.Provider value={user.platformWrite}>
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link className="admin-brand" href="/super-admin"><Layers3 size={23} aria-hidden="true"/> <span>JUEE POS<small>Super Admin</small></span></Link>
        <nav aria-label="Quản trị nền tảng">
          {Array.from(new Set(sections.map(item => item.group))).map(group => <div className="admin-menu-group" key={group}>
            <p>{group}</p>
            {sections.filter(item => item.group === group).map(item => {
              const Icon = icons[item.key];
              return <Link href={adminHref(item.key)} key={item.key} aria-current={item.key === active.key ? 'page' : undefined}>
                <Icon size={17} aria-hidden="true"/>{item.title}
              </Link>;
            })}
          </div>)}
        </nav>
      </aside>
      <div className="admin-workspace">
        <header className="admin-top">
          <span>{active.group}</span>
          <div className="admin-account"><div><strong>{user.name}</strong><small>{user.email}</small></div>
            <button type="button" className="plain" onClick={logout}><LogOut size={17} aria-hidden="true"/> Đăng xuất</button>
          </div>
        </header>
        <main className="admin-content">
          {error && <p className="error" role="alert">{error}</p>}
          {children}
        </main>
      </div>
    </div>
  </AdminWriteContext.Provider>;
}
