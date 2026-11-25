import { BarChart3, BedDouble, Calculator, ClipboardX, Dumbbell, Fingerprint, IdCard, LayoutDashboard, LayoutGrid, Package, ReceiptText, Settings, Shield, ShoppingBag, Store, Tags, Ticket, Users, Utensils, Wallet, Warehouse } from 'lucide-react';
import { usesMemberships, usesRetail, usesTables, type Branch } from '@/types/business';

const groups = [
  { label: 'Doanh nghiệp', items: [
    { id: 'overview', label: 'Tổng quan', Icon: LayoutDashboard },
    { id: 'branches', label: 'Chi nhánh', Icon: Store },
    { id: 'staff', label: 'Nhân viên và quản lý', Icon: Users },
  ] },
  { label: 'Cửa hàng', items: [
    { id: 'products', label: 'Sản phẩm', Icon: Package },
    { id: 'menu', label: 'Thực đơn', Icon: Utensils },
    { id: 'categories', label: 'Danh mục', Icon: Tags },
    { id: 'tables', label: 'Cấu hình bàn', Icon: LayoutGrid },
    { id: 'buffet', label: 'Gói buffet', Icon: Utensils },
    { id: 'hotel-settings', label: 'Phòng và gói lưu trú', Icon: BedDouble },
    { id: 'ticket-types', label: 'Loại vé', Icon: Ticket },
    { id: 'promotions', label: 'Khuyến mãi', Icon: Tags },
    { id: 'customers', label: 'Khách hàng', Icon: Users },
  ] },
  { label: 'Hội viên', items: [
    { id: 'members', label: 'Quản lý hội viên', Icon: IdCard },
    { id: 'member-plans', label: 'Gói tập', Icon: Dumbbell },
    { id: 'member-check-in', label: 'Quản lý check-in', Icon: Fingerprint },
  ] },
  { label: 'Hàng hóa', items: [
    { id: 'warehouse', label: 'Kho hàng', Icon: Warehouse },
    { id: 'purchases', label: 'Nhập hàng', Icon: ShoppingBag },
    { id: 'warehouse-ai', label: 'Trợ lý kho AI', Icon: Warehouse },
  ] },
  { label: 'Tài chính', items: [
    { id: 'reports', label: 'Báo cáo', Icon: BarChart3 },
    { id: 'cashbook', label: 'Sổ quỹ', Icon: Wallet },
    { id: 'transactions', label: 'Giao dịch', Icon: ReceiptText },
    { id: 'cancellations', label: 'Lịch sử hủy', Icon: ClipboardX },
    { id: 'accounting', label: 'Thuế và kế toán', Icon: Calculator },
    { id: 'tax-declarations', label: 'Kê khai thuế', Icon: ReceiptText },
  ] },
  { label: 'Tài khoản', items: [
    { id: 'subscription', label: 'Gói dịch vụ', Icon: Settings },
    { id: 'security', label: 'Bảo mật tài khoản', Icon: Shield },
  ] },
] as const;

type CompanySection = typeof groups[number]['items'][number]['id'];


export function companyNavigation(mode?: Branch['mode'], active = true, role = 'OWNER') {
  const retail = !!mode && usesRetail(mode);
  const food = !!mode && usesTables(mode);
  const membership = !!mode && usesMemberships(mode);
  const available: Record<CompanySection, boolean> = {
    overview: true, branches: true, staff: true, products: retail, menu: food, categories: retail || food,
    tables: food, buffet: food, members: membership, 'member-plans': membership, 'member-check-in': membership,
    'hotel-settings': mode === 'HOTEL', 'ticket-types': mode === 'TICKETS',
    promotions: retail, customers: retail || food, warehouse: true, purchases: true, reports: true, cashbook: true,
    transactions: retail || food, cancellations: true, accounting: true, subscription: true, security: true,
    'warehouse-ai': role === 'OWNER' || role === 'MANAGER',
    'tax-declarations': role === 'OWNER',
  };
  return groups.map(group => ({ label: group.label, items: group.items.filter(({ id }) =>
    id === 'subscription' ? role === 'OWNER' : id === 'security' || (!!mode && active && available[id]),
  ).map(item => ({ ...item, label: item.id === 'member-plans' && mode === 'POOL' ? 'Gói bơi' :
    item.id === 'warehouse' && food && !retail ? 'Kho nguyên liệu' : item.label })) })).filter(group => group.items.length);
}

export function companySection(requested: string | null | undefined, mode?: Branch['mode'], active = true, role = 'OWNER') {
  const items = companyNavigation(mode, active, role).flatMap(group => group.items);
  const aliases: Record<string, CompanySection> = { registers: 'staff', 'warehouse-catalog': 'purchases' };
  const target = requested && Object.hasOwn(aliases, requested) ? aliases[requested] : requested;
  const fallback = requested === 'products' ? 'menu' : requested === 'menu' ? 'products' : 'overview';
  return items.find(item => item.id === target) ?? items.find(item => item.id === fallback) ?? items[0];
}

export function companyHref(id: CompanySection) {
  if (id === 'overview') return '/dashboard/company';
  if (id === 'security') return '/dashboard/company/security';
  return `/dashboard/company?tab=${id}`;
}
