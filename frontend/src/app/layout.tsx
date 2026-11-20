import type { ReactNode } from 'react';
import './style.css';
import './workspace-style.css';
import './hotel-desk.css';
import './access-style.css';
export const metadata = { title: 'JUEE POS', description: 'Quản lý bán hàng đa cửa hàng' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="vi"><body>{children}</body></html>;
}
