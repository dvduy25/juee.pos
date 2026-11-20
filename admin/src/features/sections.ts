export const sections = [
  { key: 'dashboard', title: 'Tổng quan', group: 'Nền tảng' },
  { key: 'users', title: 'Tài khoản', group: 'Nền tảng' },
  { key: 'tenants', title: 'Doanh nghiệp', group: 'Nền tảng' },
  { key: 'branches', title: 'Chi nhánh', group: 'Nền tảng' },
  { key: 'plans', title: 'Gói dịch vụ', group: 'Thuê bao & tài chính' },
  { key: 'subscriptions', title: 'Thuê bao', group: 'Thuê bao & tài chính' },
  { key: 'revenue', title: 'Doanh thu', group: 'Thuê bao & tài chính' },
  { key: 'invoices', title: 'Thu tiền thuê bao', group: 'Thuê bao & tài chính' },
  { key: 'notifications', title: 'Thông báo', group: 'Hệ thống' },
  { key: 'audit-logs', title: 'Nhật ký quản trị', group: 'Hệ thống' },
  { key: 'status', title: 'Trạng thái hệ thống', group: 'Hệ thống' },
  { key: 'developer', title: 'Nhà phát triển', group: 'Hệ thống' },
] as const;

export type AdminSection = typeof sections[number]['key'];
export const adminHref = (section: AdminSection) => section === 'dashboard' ? '/super-admin' : `/super-admin/${section}`;
