import type { ReactNode } from 'react';
import Link from 'next/link';
import { Layers3 } from 'lucide-react';
import { FullscreenButton } from '@/components/fullscreen-button';

export function AuthScene({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return <main className="access-page">
    <header className="access-header">
      <Link href="/gioi-thieu" className="access-brand" aria-label="JUEE POS, về trang giới thiệu">
        <span><Layers3 size={22} aria-hidden="true"/></span>JUEE POS
      </Link>
      <FullscreenButton/>
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
