export const branchNames = { RETAIL: 'Bán lẻ', RESTAURANT: 'Nhà hàng', HYBRID: 'Kết hợp', CAFE: 'Quán nước', GYM: 'Phòng gym', POOL: 'Bể bơi',
  HOTEL: 'Nhà nghỉ / Khách sạn', TICKETS: 'Thu vé' };
export const roleNames: Record<string, string> = {
  OWNER: 'Chủ doanh nghiệp', MANAGER: 'Quản lý', CASHIER: 'Thu ngân', WAITER: 'Phục vụ',
  KITCHEN: 'Nhân viên bếp', INVENTORY: 'Nhân viên kho', ACCOUNTANT: 'Kế toán', COACH: 'Huấn luyện viên',
};

export const vnd = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
export const number = new Intl.NumberFormat('vi-VN');
export const date = (value?: string | null) => value ? new Date(value).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—';
export const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—';
export const labels: Record<string, string> = {
  ACTIVE: 'Đang hoạt động', PENDING: 'Chờ kích hoạt', SUSPENDED: 'Tạm ngừng', CANCELED: 'Đã hủy',
  EXPIRED: 'Đã hết hạn', SCHEDULED: 'Chưa bắt đầu',
};
export const contractStates = {
  REQUESTED: 'Yêu cầu đang chờ', EXPIRING: 'Hết hạn trong 7 ngày', EXPIRED: labels.EXPIRED,
  ACTIVE: labels.ACTIVE, PENDING: labels.PENDING, SUSPENDED: labels.SUSPENDED, CANCELED: labels.CANCELED, SCHEDULED: labels.SCHEDULED,
};
export const editableStates = ['ACTIVE', 'SUSPENDED', 'CANCELED'] as const;
export const auditLabels: Record<string, string> = {
  USER_STATUS: 'Đổi trạng thái tài khoản', USER_REVOKE_SESSIONS: 'Thu hồi phiên đăng nhập', TENANT_STATUS: 'Đổi trạng thái doanh nghiệp',
  PLAN_CREATE: 'Tạo gói dịch vụ', PLAN_VERSION: 'Tạo phiên bản gói', SUBSCRIPTION_PLAN: 'Đổi gói thuê bao',
  SUBSCRIPTION_REQUEST_ACTIVATE: 'Duyệt và kích hoạt gói', SUBSCRIPTION_REQUEST_REJECT: 'Từ chối yêu cầu gói',
  SUBSCRIPTION_EXTEND: 'Gia hạn thuê bao', SUBSCRIPTION_STATUS: 'Đổi trạng thái thuê bao', INVOICE_RECEIPT: 'Ghi nhận thực thu',
  NOTIFICATION_PUBLISH: 'Đăng thông báo',
};
type Revision = { version: number; monthlyVnd: string; yearlyVnd?: string; maxBranches: number; maxStaff: number; maxQrTables: number; features: string[] };
type PlanVersion = Revision & { id: string; plan?: { id: string; name: string; code: string } };
type Rejection = { reason: string; rejectedAt: string };
export type AuditItem = { id: string; action: string; reason: string; createdAt: string; actorId: string; targetId: string };
export type Payment = { id: string; reference: string; amountVnd: string; paidAt?: string };
export type Row = {
  id: string; name?: string; tenantName?: string; mode?: string; email?: string; phone?: string; locked?: boolean; createdAt?: string;
  emailVerifiedAt?: string; lastLoginAt?: string; platformAccount?: boolean; _count?: { memberships: number; branches?: number };
  code?: string; description?: string; published?: boolean; activeTenants?: number; revisions?: Revision[];
  tenantId?: string; tenant?: { id: string; name: string; locked?: boolean }; planVersion?: PlanVersion; requestedPlanVersion?: PlanVersion;
  requestId?: string; requestedAt?: string; rejectedRequest?: Rejection; trial?: boolean; simulated?: boolean;
  subscriptions?: Row[]; startsAt?: string; expiresAt?: string | null; status?: string; effectiveStatus?: string;
  title?: string; kind?: string; publishedAt?: string; subscription?: { tenant?: { id: string; name: string } };
  reference?: string; amountVnd?: string; paidAt?: string; actor?: { name: string; email: string };
  action?: string; reason?: string; actorId?: string; targetId?: string;
};
export type Profile = Row & {
  sessions?: number;
  history: AuditItem[];
  invoices?: Payment[];
  transferReviews?: { id: string; reference: string; bankReference?: string; amount: number; reviewReason?: string; createdAt: string }[];
  branches?: { id: string; name: string; mode: string; createdAt: string }[];
  memberships?: { id?: string; role?: string; disabled?: boolean; archivedAt?: string;
    tenant?: { id: string; name: string }; user?: { id: string; name: string; email: string; phone?: string; locked?: boolean } }[];
};

export type AdminFilters = { status?: string; q?: string; id?: string; tenantId?: string; subscriptionId?: string };
export type AdminAction = { title: string; path: string; method: string;
  fields?: 'plan' | 'extend' | 'switch' | 'status' | 'invoice' | 'notification' | 'activate' | 'reject'; row?: Row; data?: object };
