import { GuestOrder, InvalidTable } from '@/features/order/menu';

export default async function Page({ params }: { params: Promise<{ tenantId: string; tableToken: string }> }) {
  const { tenantId, tableToken } = await params;
  if (!/^[a-f0-9]{24}$/.test(tenantId) || !/^[a-f0-9]{40}$/.test(tableToken)) {
    return <InvalidTable/>;
  }
  return <GuestOrder tenantId={tenantId} tableToken={tableToken}/>;
}
