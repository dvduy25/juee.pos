import type { ReactNode } from 'react';
import { LanguageProvider } from '@/i18n/language';
import './style.css';
import './workspace-style.css';
import './hotel-desk.css';
import './access-style.css';
import './language.css';
export const metadata = { title: 'JUEE POS', description: 'Quản lý bán hàng đa cửa hàng' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="vi"><body><LanguageProvider>{children}</LanguageProvider></body></html>;
}
