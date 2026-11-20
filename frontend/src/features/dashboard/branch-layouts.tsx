'use client';

import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, BedDouble, Building2, Coffee, Dumbbell, Plus, Store, Ticket, Utensils, Waves } from 'lucide-react';
import type { WorkspaceLayoutProps } from '@/components/workspace';
import { DeskFrame } from '@/components/desk-frame';
import { companyHref, companyNavigation, companySection } from '@/features/company/navigation';
import { branchNames, roleNames } from './navigation';
import type { Branch, WorkspaceMode } from '@/types/business';

const icons = { RETAIL: Store, RESTAURANT: Utensils, CAFE: Coffee, GYM: Dumbbell, POOL: Waves, HOTEL: BedDouble, TICKETS: Ticket };

type LayoutProps = WorkspaceLayoutProps & {
  mode: WorkspaceMode;
  tenant?: string;
  branch?: string;
  role?: string;
  picker: ReactNode;
  modePicker?: ReactNode;
  navigation: ReactNode;
  workMode?: ReactNode;
  accountSecurityHref?: string;
};

function CompanyNavigation({ mode, active, role }: { mode?: Branch['mode']; active: boolean; role: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = companySection(pathname === '/dashboard/company/security' ? 'security' : params.get('tab'), mode, active, role).id;
  return companyNavigation(mode, active, role).map(group => <div className="desk-nav-group" key={group.label}>
    <p>{group.label}</p><div>{group.items.map(({ id, label, Icon }) => <Link key={id} href={companyHref(id)} title={label}
      aria-current={current === id ? 'page' : undefined}><Icon size={18} aria-hidden="true"/><span>{label}</span></Link>)}</div>
  </div>);
}

export function CompanyLayout({ branchMode, active = false, onCreateBusiness, ...props }: LayoutProps & {
  branchMode?: Branch['mode']; active?: boolean; onCreateBusiness?: () => void;
}) {
  const sections = <Suspense>
    {(props.role === 'OWNER' || props.role === 'MANAGER') && <CompanyNavigation mode={branchMode} active={active} role={props.role}/>}
  </Suspense>;
  const footer = <div className="desk-nav-group company-navigation-footer"><div>
    {onCreateBusiness && <button className="company-create" type="button" title="Tạo doanh nghiệp" onClick={onCreateBusiness}>
      <Plus size={18} aria-hidden="true"/><span>Tạo doanh nghiệp</span></button>}
    <Link href="/dashboard" title="Về trang chi nhánh"><ArrowLeft size={18} aria-hidden="true"/><span>Về trang chi nhánh</span></Link>
  </div></div>;
  return <DeskFrame {...props} theme={props.tenant ? props.mode : 'company'} brandHref="/dashboard/company" area="Quản lý doanh nghiệp"
    heading={<><Building2 size={19} aria-hidden="true"/><div><strong>{props.tenant ?? 'Quản lý doanh nghiệp'}</strong>
      {props.branch && <small>{props.branch}</small>}</div></>} navigation={sections} footer={footer}>
    <div className="company-content">{props.children}</div>
  </DeskFrame>;
}

export function BranchLayout(props: LayoutProps) {
  const Icon = icons[props.mode];
  const reception = props.mode === 'GYM' || props.mode === 'POOL' || props.mode === 'HOTEL';
  const footer = props.role && <div className="desk-role"><Building2 size={17} aria-hidden="true"/><div><strong>{props.tenant}</strong>
    <small>{reception && props.role === 'CASHIER' ? 'Lễ tân' : roleNames[props.role] ?? props.role}</small></div></div>;
  return <DeskFrame {...props} theme={props.mode} brandHref="/dashboard" area={branchNames[props.mode]} footer={footer} toolbar={props.modePicker}
    heading={<><Icon size={19} aria-hidden="true"/><div><strong>{props.branch ?? props.tenant ?? 'Cửa hàng'}</strong>
      {props.branch && props.tenant && <small>{props.tenant}</small>}</div></>}/>;
}
