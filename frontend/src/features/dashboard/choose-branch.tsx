'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, Layers3, LogOut, Store } from 'lucide-react';
import { State } from '@/components/business-ui';
import { FullscreenButton } from '@/components/fullscreen-button';
import { LanguageSwitch } from '@/components/language-switch';
import type { BranchSelection } from '@/components/workspace';
import { useLanguage } from '@/i18n/language';
import { api } from '@/services/api-client';
import type { Branch, Membership } from '@/types/business';
import { branchNames } from './navigation';

export function ChooseBranch({ businesses, dark, error, onLogout, onSelected }: {
  businesses: Membership[];
  dark: boolean;
  error: string;
  onLogout: () => void;
  onSelected: (scope: BranchSelection) => void;
}) {
  const { t, homeHref } = useLanguage();
  const [businessId, setBusinessId] = useState(businesses[0].tenant.id);
  const [pendingBranch, setPendingBranch] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const submitting = useRef(false);
  const business = businesses.find(item => item.tenant.id === businessId) ?? businesses[0];
  const tenantId = business.tenant.id;
  const branches = useQuery({ queryKey: ['branches', tenantId, false],
    queryFn: () => api<Branch[]>(`/tenants/${tenantId}/branches`) });

  async function enterBranch(branchId: string) {
    if (submitting.current) return;
    submitting.current = true;
    setPendingBranch(branchId);
    setSelectionError('');
    try {
      const scope = await api<BranchSelection>('/auth/branch-access', 'POST', { tenantId, branchId });
      onSelected(scope);
    } catch (cause) {
      setSelectionError(cause instanceof Error ? cause.message : 'Chưa xác nhận được quyền vào chi nhánh.');
    } finally {
      submitting.current = false;
      setPendingBranch('');
    }
  }

  return <div className={`auth setup-page branch-selection-page ${dark ? 'dark' : ''}`}>
    <main className="setup-content">
      <header className="auth-header">
        <a className="brand" href={homeHref}><Layers3/> JUEE POS</a>
        <div className="actions"><LanguageSwitch/><FullscreenButton className="icon"/>
          <button className="plain" type="button" onClick={onLogout} disabled={!!pendingBranch}><LogOut size={17}/> {t("Đăng xuất")}</button>
        </div>
      </header>
      <div className="setup-intro"><h1>{t("Chọn cửa hàng hoặc chi nhánh")}</h1>
        <p>{t("Chọn nơi bạn muốn làm việc trong phiên này.")}</p>
      </div>
      {error && <p className="error" role="alert">{t(error)}</p>}
      <div className="branch-selection">
        <section className="card branch-selection-businesses" aria-labelledby="branch-selection-businesses">
          <h2 id="branch-selection-businesses">{t("Cửa hàng")}</h2>
          {businesses.map(item => <button key={item.tenant.id} type="button" aria-pressed={item.tenant.id === tenantId}
            disabled={!!pendingBranch} onClick={() => { setBusinessId(item.tenant.id); setSelectionError(''); }}>
            <Building2 size={18} aria-hidden="true"/><span><strong>{item.tenant.name}</strong>
              <small>{t(item.role === 'OWNER' ? 'Chủ doanh nghiệp' : 'Quản lý')}</small></span>
          </button>)}
        </section>
        <section aria-labelledby="branch-selection-branches">
          <h2 id="branch-selection-branches">{t("Chi nhánh")}</h2>
          <State query={branches}/>
          {branches.isError && <button className="plain" type="button" onClick={() => void branches.refetch()}>{t("Thử lại")}</button>}
          {branches.isSuccess && !branches.data.length && <p className="notice">{t("Tài khoản này chưa được cấp quyền vào chi nhánh của cửa hàng.")}</p>}
          {selectionError && <p className="error" role="alert">{t(selectionError)}</p>}
          <div className="branch-selection-branches">{branches.data?.map(branch =>
            <button className="card branch-selection-entry" key={branch.id} type="button" data-theme={branch.mode}
              disabled={!!pendingBranch} aria-busy={pendingBranch === branch.id} onClick={() => void enterBranch(branch.id)}>
              <span className="setup-icon"><Store size={23} aria-hidden="true"/></span>
              <span><strong>{branch.name}</strong><small>{t(pendingBranch === branch.id ? "Đang xác nhận…" : branchNames[branch.mode])}</small></span>
              <ArrowRight className="branch-selection-arrow" size={19} aria-hidden="true"/>
            </button>)}</div>
        </section>
      </div>
    </main>
  </div>;
}
