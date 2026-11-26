'use client';

import { Layers3 } from 'lucide-react';
import { useLanguage } from '@/i18n/language';

export function PageLoading({ fullPage = false, dark = false }: { fullPage?: boolean; dark?: boolean }) {
  const { t } = useLanguage();
  return <div className={`page-loading${fullPage ? ' page-loading-full' : ''}${dark ? ' dark' : ''}`} role="status">
    <span className="page-loading-logo" aria-hidden="true"><Layers3 size={24}/></span>
    <span>{t("Đang mở trang…")}</span>
    <span className="page-loading-track" aria-hidden="true"><span/></span>
  </div>;
}
