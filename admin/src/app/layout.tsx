import type { ReactNode } from 'react';
import './style.css';

export const metadata = { title: 'JUEE POS · Quản trị nền tảng', robots: 'noindex, nofollow' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="vi"><body>{children}</body></html>;
}
