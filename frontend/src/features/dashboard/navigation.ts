import { BarChart3, BedDouble, Building2, CalendarDays, ChefHat, ClipboardList, CreditCard, History, IdCard, LayoutDashboard, LayoutGrid, Package, ScanLine, Settings, ShoppingCart, Tags, Ticket, Users } from 'lucide-react';
import type { Branch, WorkspaceMode } from '@/types/business';
import { usesMemberships, usesServiceCounter, usesTables } from '@/types/business';

export const branchNames = { RETAIL: 'Bán lẻ', RESTAURANT: 'Nhà hàng', HYBRID: 'Kết hợp', CAFE: 'Quán nước', GYM: 'Phòng gym', POOL: 'Bể bơi',
  HOTEL: 'Nhà nghỉ / Khách sạn', TICKETS: 'Thu vé' };
export const roleNames: Record<string, string> = {
  OWNER: 'Chủ doanh nghiệp', MANAGER: 'Quản lý', CASHIER: 'Thu ngân', WAITER: 'Phục vụ',
  KITCHEN: 'Nhân viên bếp', INVENTORY: 'Nhân viên kho', ACCOUNTANT: 'Kế toán', COACH: 'Huấn luyện viên',
};

export const navigation = {
  overview: { label: 'Tổng quan', icon: LayoutDashboard, roles: [] },
  pos: { label: 'Quầy bán hàng', icon: ShoppingCart, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  orders: { label: 'Đơn hàng', icon: ClipboardList, roles: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'ACCOUNTANT'] },
  products: { label: 'Sản phẩm', icon: Package, roles: ['OWNER', 'MANAGER', 'INVENTORY', 'ACCOUNTANT'] },
  categories: { label: 'Danh mục', icon: Tags, roles: ['OWNER', 'MANAGER', 'INVENTORY', 'ACCOUNTANT'] },
  tables: { label: 'Bàn', icon: LayoutGrid, roles: ['OWNER', 'MANAGER', 'WAITER', 'CASHIER'] },
  kitchen: { label: 'Màn hình bếp', icon: ChefHat, roles: ['OWNER', 'MANAGER', 'KITCHEN', 'WAITER', 'CASHIER'] },
  customers: { label: 'Khách hàng', icon: Users, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  members: { label: 'Hội viên', icon: IdCard, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'member-classes': { label: 'Lịch lớp', icon: CalendarDays, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'member-visits': { label: 'Lịch sử vào', icon: History, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'hotel-rooms': { label: 'Sơ đồ phòng', icon: BedDouble, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'hotel-bookings': { label: 'Đặt phòng', icon: CalendarDays, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'hotel-calendar': { label: 'Lịch phòng', icon: CalendarDays, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'ticket-sales': { label: 'Bán vé', icon: Ticket, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'ticket-admissions': { label: 'Soát vé', icon: ScanLine, roles: ['OWNER', 'MANAGER', 'CASHIER'] },
  'ticket-types': { label: 'Loại vé', icon: Tags, roles: ['OWNER', 'MANAGER'] },
  company: { label: 'Quản lý doanh nghiệp', icon: Building2, roles: ['OWNER', 'MANAGER'] },
  'booking-requests': { label: 'Đặt trước', icon: CalendarDays, roles: ['OWNER', 'MANAGER'] },
  payments: { label: 'Thanh toán', icon: CreditCard, roles: ['OWNER', 'MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  reports: { label: 'Báo cáo', icon: BarChart3, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  subscription: { label: 'Gói dịch vụ', icon: Settings, roles: ['OWNER', 'ACCOUNTANT'] },
};

export type Section = keyof typeof navigation;
type Group = { label: string; sections: Section[] };
export const counterSections: Section[] = ['pos', 'orders', 'payments'];
const serviceCounter: Group = { label: 'Bán hàng hóa', sections: ['pos', 'orders'] };
const common: Group = { label: 'Quản lý', sections: ['booking-requests', 'company'] };
const foodMenus: Group[] = [
  { label: 'Phục vụ', sections: ['overview', 'tables', 'pos', 'kitchen', 'payments'] }, common,
];
const facilityMenus: Group[] = [
  { label: 'Tiếp đón', sections: ['overview', 'members', 'member-classes', 'member-visits', 'payments'] }, serviceCounter, common,
];
export const menus: Record<WorkspaceMode, Group[]> = {
  RETAIL: [
    { label: 'Bán tại cửa hàng', sections: ['overview', ...counterSections] }, common,
  ],
  RESTAURANT: foodMenus, CAFE: foodMenus, GYM: facilityMenus, POOL: facilityMenus,
  HOTEL: [
    { label: 'Lễ tân', sections: ['hotel-rooms', 'hotel-bookings', 'hotel-calendar', 'payments'] }, serviceCounter, common,
  ],
  TICKETS: [
    { label: 'Thu vé', sections: ['ticket-sales', 'ticket-admissions', 'payments'] }, serviceCounter, common,
  ],
};

export const modesFor = (section: Section) => (Object.keys(menus) as WorkspaceMode[])
  .filter(mode => menus[mode].some(group => group.sections.includes(section)));
export function sectionTitle(section: Section, mode: WorkspaceMode) {
  if (usesMemberships(mode) && section === 'overview') return 'Check-in';
  if (usesTables(mode) && section === 'products') return 'Thực đơn';
  if (usesTables(mode) && section === 'pos') return 'Gọi món';
  if (usesServiceCounter(mode)) {
    if (section === 'pos') return 'Bán đồ tại quầy';
    if (section === 'orders') return 'Đơn bán hàng';
  }
  if (mode === 'CAFE' && section === 'kitchen') return 'Pha chế';
  return navigation[section].label;
}
export function canView(section: Section, role: string, mode?: Branch['mode']) {
  if (section === 'pos' && role === 'WAITER') return !!mode && usesTables(mode);
  const roles: string[] = navigation[section].roles;
  return roles.length === 0 || roles.includes(role);
}
export function dashboardHref(section: Section) {
  if (section === 'products' || section === 'categories' || section === 'ticket-types') return `/dashboard/company?tab=${section}`;
  return section === 'overview' ? '/dashboard' : `/dashboard/${section}`;
}

export const managementTabs = ['reports', 'subscription', 'customers'] as const;
export type ManagementTab = typeof managementTabs[number];
export function managementHref(tab: ManagementTab | 'staff') {
  return `/dashboard/company?tab=${tab}`;
}
