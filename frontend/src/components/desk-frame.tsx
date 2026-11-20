'use client';

import { Suspense, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, Layers3, LogOut, Menu, Moon, Shield, Sun, X } from 'lucide-react';
import type { WorkspaceLayoutProps } from './workspace';
import { FullscreenButton } from './fullscreen-button';

type FrameProps = Pick<WorkspaceLayoutProps, 'user' | 'dark' | 'onThemeChange' | 'onLogout' | 'error' | 'children'> & {
  theme: string;
  brandHref: string;
  area: string;
  heading: ReactNode;
  navigation: ReactNode;
  footer?: ReactNode;
  picker?: ReactNode;
  toolbar?: ReactNode;
  workMode?: ReactNode;
  accountSecurityHref?: string;
};

function DeskHeadingMotion({ content }: { content: RefObject<HTMLElement | null> }) {
  const pathname = usePathname();
  const tab = useSearchParams().get('tab');

  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (!heading?.animate || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return;
    // Animate the heading without remounting the workspace or affecting sticky panels.
    const motion = heading.animate([{ opacity: 0.8, translate: '0 6px' }, { opacity: 1, translate: '0 0' }],
      { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    return () => motion.cancel();
  }, [content, pathname, tab]);

  return null;
}

export function DeskFrame({ user, dark, onThemeChange, onLogout, error, children, theme, brandHref, area, heading,
  navigation, footer, picker, toolbar, workMode, accountSecurityHref }: FrameProps) {
  const drawer = useRef<HTMLDialogElement>(null);
  const account = useRef<HTMLDetailsElement>(null);
  const content = useRef<HTMLElement>(null);
  const brand = <Link className="desk-brand" href={brandHref} onClick={() => drawer.current?.close()}>
    <span><Layers3 size={21} aria-hidden="true"/></span>
    <div>JUEE POS<small>{area}</small></div>
  </Link>;
  return <div className={`desk-frame${dark ? ' dark' : ''}`} data-theme={theme}>
    <aside className="desk-sidebar">
      {brand}<nav aria-label={area}>{navigation}</nav>{footer}
    </aside>
    <div className="desk-workspace">
      <header className="desk-top">
        <button className="desk-icon desk-menu-toggle" type="button" aria-label="Mở điều hướng" aria-haspopup="dialog"
          onClick={() => drawer.current?.showModal()}><Menu size={21}/></button>
        <div className="desk-where">{picker || heading}</div>
        <div className="desk-account">
          {workMode}
          <FullscreenButton className="desk-icon"/>
          <button className="desk-icon" type="button" aria-label="Giao diện tối" aria-pressed={dark}
            title={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'} onClick={onThemeChange}>
            {dark ? <Sun size={18}/> : <Moon size={18}/>}
          </button>
          <details ref={account} className="desk-profile">
            <summary className="desk-profile-trigger" aria-label="Tài khoản">
              <span className="desk-avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
              <span className="desk-username">{user.name}</span><ChevronDown size={14} aria-hidden="true"/>
            </summary>
            <div className="desk-profile-menu">
              <div className="desk-profile-identity"><strong>{user.name}</strong><small>{user.email}</small></div>
              {accountSecurityHref && <Link className="plain" href={accountSecurityHref} onClick={() => { if (account.current) account.current.open = false; }}>
                <Shield size={16}/> Bảo mật tài khoản</Link>}
              <button className="plain" type="button" onClick={() => { if (account.current) account.current.open = false; onLogout(); }}>
                <LogOut size={16}/> Đổi tài khoản</button>
            </div>
          </details>
        </div>
      </header>
      {toolbar && <div className="desk-toolbar">{toolbar}</div>}
      <main ref={content} className="desk-content">{error && <p className="error" role="alert">{error}</p>}{children}</main>
      <Suspense fallback={null}><DeskHeadingMotion content={content}/></Suspense>
    </div>
    <dialog className="desk-drawer" ref={drawer} aria-label={area}
      onClick={event => { if (event.target === event.currentTarget) drawer.current?.close(); }}>
      <header>{brand}<button type="button" className="desk-icon" aria-label="Đóng điều hướng" onClick={() => drawer.current?.close()}><X size={21}/></button></header>
      <nav aria-label={area} onClick={event => { if (event.target instanceof Element && event.target.closest('a')) drawer.current?.close(); }}>{navigation}</nav>
      {footer}
    </dialog>
  </div>;
}
