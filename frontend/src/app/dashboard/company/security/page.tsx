'use client';

import { useLanguage } from '@/i18n/language';
import { AccountSecurity } from '@/features/dashboard/security';

export default function Page() {
  const { t } = useLanguage();
  return <div className="company-dashboard">
    <header className="company-title"><h1>{t("Bảo mật tài khoản")}</h1></header>
    <AccountSecurity/>
  </div>;
}
