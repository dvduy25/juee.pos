export type SubscriptionStatus = { status: string; startsAt: string; expiresAt?: string | null; trial?: boolean };
export type Membership = { role: string; tenant: { id: string; name: string }; subscription?: SubscriptionStatus; canEditSharedCatalog?: boolean };
export type ServicePlan = { code: string; name: string; description: string; monthlyVnd: string; yearlyVnd: string;
  maxBranches: number; maxStaff: number; maxQrTables: number; features: string[] };

export function subscriptionActive(subscription?: SubscriptionStatus, now = Date.now()) {
  return subscription?.status === 'ACTIVE' && Date.parse(subscription.startsAt) <= now &&
    (!subscription.expiresAt || Date.parse(subscription.expiresAt) > now);
}
export type WorkspaceMode = 'RETAIL' | 'RESTAURANT' | 'CAFE' | 'GYM' | 'POOL' | 'HOTEL' | 'TICKETS';
export type BranchLocation = { latitude: number; longitude: number; radiusMeters: number };
export type Branch = { id: string; name: string; mode: WorkspaceMode | 'HYBRID'; location?: BranchLocation;
  bankAccount?: { bank?: string; account?: string; holder?: string } };
export const usesTables = (mode: Branch['mode']) => mode === 'RESTAURANT' || mode === 'CAFE' || mode === 'HYBRID';
export const usesMemberships = (mode: Branch['mode']) => mode === 'GYM' || mode === 'POOL';
export const usesServiceCounter = (mode: Branch['mode']) => usesMemberships(mode) || mode === 'HOTEL' || mode === 'TICKETS';
export const usesRetail = (mode: Branch['mode']) => mode === 'RETAIL' || mode === 'HYBRID' || usesServiceCounter(mode);
export type DiningTable = { id: string; name: string; areaId?: string; sessionId?: string; reserved?: boolean;
  reservation?: { guestName: string; phone?: string; guests: number; arrivesAt: string; note?: string } };
export type BuffetRates = { adultPrice: number; childPrice: number };
export type Buffet = BuffetRates & { adults: number; children: number; packageName?: string };
export type BuffetPackage = BuffetRates & { id: string; name: string; productIds: string[]; enabled: boolean };
export type BuffetSection = 'included' | 'extra';
export type DiningSession = { id: string; tableIds: string[]; guestCount?: number; createdAt?: string; paymentRequestedAt?: string; checkoutBillId?: string; buffet?: Buffet; buffetProductIds?: string[] };
export type TableResponse = { tables: DiningTable[]; areas: { id: string; name: string }[];
  sessions: DiningSession[]; buffetPackages?: Pick<BuffetPackage, 'id' | 'name' | 'adultPrice' | 'childPrice'>[] };
export type KitchenSummary = { totalQuantity: number; dishes: { name: string; quantity: number }[] };

export function tableState(table: DiningTable, session?: DiningSession) {
  if (session?.checkoutBillId) return { key: 'billed', label: 'Chờ thanh toán' };
  if (session?.paymentRequestedAt) return { key: 'payment', label: 'Yêu cầu tính tiền' };
  return table.sessionId ? { key: 'serving', label: 'Đang ăn' } : table.reserved ? { key: 'reserved', label: 'Đặt trước' } : { key: 'ready', label: 'Trống' };
}

export function tableMenuHref(table: DiningTable) {
  const search = new URLSearchParams({ table: table.id });
  if (table.sessionId) search.set('session', table.sessionId);
  return `/dashboard/pos?${search}`;
}

export function takeawayMenuHref(session?: string, showOrders = false) {
  const search = new URLSearchParams({ takeaway: '1' });
  if (session) search.set('session', session);
  if (showOrders) search.set('orders', '1');
  return `/dashboard/pos?${search}`;
}
