'use client';

import type { PointerEvent, ReactNode } from 'react';
import { ArrowUpRight, Layers3 } from 'lucide-react';
import { FullscreenButton } from '@/components/fullscreen-button';

export function AuthScene({ title, description, interactive = false, children }: {
  title: string;
  description?: string;
  interactive?: boolean;
  children: ReactNode;
}) {
  function moveSpotlight(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return;
    const page = event.currentTarget;
    const bounds = page.getBoundingClientRect();
    page.style.setProperty('--access-pointer-x', `${event.clientX - bounds.left}px`);
    page.style.setProperty('--access-pointer-y', `${event.clientY - bounds.top}px`);
    page.dataset.pointer = 'active';
  }

  const form = <section className="access-card" aria-labelledby="access-title">
    <div className="access-title">
      <h1 id="access-title">{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {children}
  </section>;

  return <main className={interactive ? 'access-page access-page-interactive' : 'access-page'}
    onPointerMove={interactive ? moveSpotlight : undefined}
    onPointerLeave={interactive ? event => { delete event.currentTarget.dataset.pointer; } : undefined}>
    <header className="access-header">
      <a href="/" className="access-brand" aria-label="JUEE POS, về trang giới thiệu">
        <span><Layers3 size={22} aria-hidden="true"/></span>JUEE POS
      </a>
      <FullscreenButton/>
    </header>
    {interactive ? <div className="access-stage">
      <aside className="access-preview"><a href="/#giai-phap">Khám phá các mô hình quản lý <ArrowUpRight size={17} aria-hidden="true"/></a></aside>
      {form}
    </div> : form}
  </main>;
}
