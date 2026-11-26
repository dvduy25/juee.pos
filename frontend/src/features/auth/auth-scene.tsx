'use client';

import { useLanguage } from '@/i18n/language';
import { LanguageSwitch } from '@/components/language-switch';
import { useRef, type PointerEvent, type ReactNode } from 'react';
import { Layers3 } from 'lucide-react';
import { FullscreenButton } from '@/components/fullscreen-button';

export function AuthScene({ title, description, interactive = false, children }: {
  title: string;
  description?: string;
  interactive?: boolean;
  children: ReactNode;
}) {
  const { homeHref, t } = useLanguage();
  const lastPointer = useRef<{ x: number; y: number; direction: number }>(null);

  function moveCursorEffect(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== 'mouse') return;
    const page = event.currentTarget;
    const bounds = page.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const previous = lastPointer.current;
    let direction = previous?.direction ?? 0;
    if (previous && Math.hypot(x - previous.x, y - previous.y) > 1) {
      const movement = Math.atan2(y - previous.y, x - previous.x);
      const turn = 2 * (movement - direction);
      // Reversing along the same line keeps the two sides of the opening in place.
      direction += Math.atan2(Math.sin(turn), Math.cos(turn)) * .23;
    }
    lastPointer.current = { x, y, direction };
    page.style.setProperty('--access-pointer-x', `${x}px`);
    page.style.setProperty('--access-pointer-y', `${y}px`);
    page.style.setProperty('--access-direction', `${direction}rad`);
    page.style.setProperty('--access-shift-x', `${Math.sin(direction) * 10}px`);
    page.style.setProperty('--access-shift-y', `${-Math.cos(direction) * 10}px`);
    page.dataset.pointer = 'active';
  }

  return <main className={interactive ? 'access-page access-page-interactive' : 'access-page'}
    onPointerMove={interactive ? moveCursorEffect : undefined}
    onPointerLeave={interactive ? event => { lastPointer.current = null; delete event.currentTarget.dataset.pointer; } : undefined}>
    {interactive && <span className="access-cursor" aria-hidden="true"><span className="access-cursor-glow"/></span>}
    <header className="access-header">
      <a href={homeHref} className="access-brand" aria-label={t("JUEE POS, về trang giới thiệu")}>
        <span><Layers3 size={22} aria-hidden="true"/></span>JUEE POS
      </a>
      <div className="access-header-tools"><LanguageSwitch/><FullscreenButton/></div>
    </header>
    <section className="access-card" aria-labelledby="access-title">
      <div className="access-title">
        <h1 id="access-title">{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  </main>;
}
