import { notFound } from 'next/navigation';
import { MemberKiosk } from '@/features/check-in/member-kiosk';

export const metadata = { title: 'Check-in hội viên | JUEE POS', robots: { index: false, follow: false } };

export default async function Page({ params, searchParams }: {
  params: Promise<{ tenantId: string; branchId: string }>;
  searchParams: Promise<{ method?: string | string[] }>;
}) {
  const { tenantId, branchId } = await params;
  if (![tenantId, branchId].every(id => /^[a-f0-9]{24}$/.test(id))) notFound();
  const { method } = await searchParams;
  return <MemberKiosk tenantId={tenantId} branchId={branchId}
    preferredMethod={method === 'CARD' || method === 'MEMBER_CODE' ? method : undefined}/>;
}
