import { AccountSecurity } from '@/features/dashboard/security';

export default function Page() {
  return <div className="company-dashboard">
    <header className="company-title"><h1>Bảo mật tài khoản</h1></header>
    <AccountSecurity/>
  </div>;
}
