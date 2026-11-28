import { notFound } from 'next/navigation';
import { PublicBooking } from '@/features/booking/public-booking';

export const metadata = { title: 'Đặt trước | JUEE POS', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ tenantId: string; branchId: string }> }) {
  const { tenantId, branchId } = await params;
  if (![tenantId, branchId].every(id => /^[a-f0-9]{24}$/.test(id))) notFound();
  return <PublicBooking tenantId={tenantId} branchId={branchId}/>;
}
