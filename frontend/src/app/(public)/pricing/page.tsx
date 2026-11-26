'use client';

import { useLanguage } from '@/i18n/language';
import { LanguageSwitch } from '@/components/language-switch';
import Link from 'next/link';
import { Layers3 } from 'lucide-react';
import { FullscreenButton } from '@/components/fullscreen-button';

export default function Pricing() {
  const { homeHref, t } = useLanguage();
  return <div className="landing">
    <nav><a className="brand" href={homeHref}><Layers3/> JUEE POS</a><div className="actions"><Link className="button" href="/login">{t("Đăng nhập")}</Link><LanguageSwitch/><FullscreenButton/></div></nav>
    <main className="pricing">
      <div className="page-heading"><div><h1>{t("Bảng giá")}</h1></div></div>
      <div className="pricing-grid"><section className="card">
        <h2>{t("Miễn phí")}</h2>
        <p>{t("Dùng toàn bộ tính năng JUEE POS cho mọi doanh nghiệp và chi nhánh.")}</p>
        <Link className="button" href="/register">{t("Bắt đầu miễn phí")}</Link>
        <a className="plain justify-self-start" href={homeHref + '#quy-trinh'}>{t("Xem các quy trình sử dụng")}</a>
      </section></div>
    </main>
  </div>;
}
