import { GuestOrder } from '@/features/order/menu';

export default async function Page({ params }: { params: Promise<{ tenantId: string; tableToken: string }> }) {
  const { tenantId, tableToken } = await params;
  if (!/^[a-f0-9]{24}$/.test(tenantId) || !/^[a-f0-9]{40}$/.test(tableToken)) {
    return <main className="landing"><div className="guest-content"><h1>Mã bàn không hợp lệ</h1><p>Hãy quét lại mã QR tại bàn.</p></div></main>;
  }
  return <GuestOrder tenantId={tenantId} tableToken={tableToken}/>;
}
