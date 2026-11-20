import { BusinessDashboard } from '@/features/dashboard/business';
import { redirect } from 'next/navigation';
import { dashboardHref } from '@/features/dashboard/navigation';
import { takeawayMenuHref } from '@/types/business';

export default async function Page({ params, searchParams }: {
  params: Promise<{ section: string }>; searchParams: Promise<{ tab?: string; bill?: string }>;
}) {
  const { section } = await params;
  if (section === 'takeaway') redirect(takeawayMenuHref());
  if (section === 'inventory') redirect('/dashboard/company?tab=warehouse');
  if (section === 'branches') redirect('/dashboard/company?tab=branches');
  if (section === 'staff') redirect('/dashboard/company?tab=staff');
  if (section === 'member-plans') redirect('/dashboard/company?tab=member-plans');
  if (section === 'member-devices') redirect('/dashboard/company?tab=member-check-in');
  if (section === 'products' || section === 'categories' || section === 'ticket-types') redirect(dashboardHref(section));
  if (section === 'settings') {
    const { tab } = await searchParams;
    if (tab === 'products' || tab === 'categories') redirect(dashboardHref(tab));
    redirect(`/dashboard/company?tab=${tab === 'buffet' ? 'buffet' : 'tables'}`);
  }
  const bill = section === 'payments' ? (await searchParams).bill : undefined;
  return <BusinessDashboard section={section} bill={typeof bill === 'string' && /^[a-f0-9]{24}$/.test(bill) ? bill : undefined}/>;
}
