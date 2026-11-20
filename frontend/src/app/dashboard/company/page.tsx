import { CompanyDashboard } from '@/features/company/company-dashboard';
import { redirect } from 'next/navigation';

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  if (tab === 'security') redirect('/dashboard/company/security');
  return <CompanyDashboard requested={tab}/>;
}
