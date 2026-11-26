'use client';

import { useLanguage } from '@/i18n/language';
import { LanguageSwitch } from '@/components/language-switch';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BedDouble, Coffee, Dumbbell, Layers3, LogOut, Store, Ticket, Utensils } from 'lucide-react';
import { FullscreenButton } from '@/components/fullscreen-button';
import { api } from '@/services/api-client';
import type { WorkspaceLayoutProps } from '@/components/workspace';
import { branchNames } from './navigation';
import { BranchLocationFields, readBranchLocation } from './branch-location';

const models = [
  { mode: 'RETAIL', name: 'Bán lẻ', Icon: Store, description: 'Bán tại quầy, quản lý sản phẩm và tồn kho.' },
  { mode: 'RESTAURANT', name: 'Nhà hàng', Icon: Utensils, description: 'Quản lý bàn, gọi món qua QR và chuyển món xuống bếp.' },
  { mode: 'CAFE', name: 'Quán nước', Icon: Coffee, description: 'Nhận đơn tại bàn, mang về và theo dõi pha chế.' },
  { mode: 'MEMBERS', name: 'Hội viên', Icon: Dumbbell, description: 'Quản lý gói tập, thẻ bơi và lượt vào.' },
  { mode: 'HOTEL', name: branchNames.HOTEL, Icon: BedDouble, description: 'Quản lý phòng, đặt chỗ, nhận và trả phòng.' },
  { mode: 'TICKETS', name: branchNames.TICKETS, Icon: Ticket, description: 'Bán vé QR và soát vé vào cửa.' },
] as const;
type Model = typeof models[number];

export function StoreSetup({ dark, onLogout, error, onCreate, onBack }: Pick<WorkspaceLayoutProps, 'dark' | 'onLogout' | 'error'> & {
  onCreate: (id: string, branchId: string) => void; onBack?: () => void;
}) {
  const { homeHref, t } = useLanguage();
  const [model, setModel] = useState<Model>();
  const lastChosen = useRef<Model['mode']>(undefined);
  const modelButtons = useRef<Partial<Record<Model['mode'], HTMLButtonElement>>>({});
  useEffect(() => {
    if (!model && lastChosen.current) modelButtons.current[lastChosen.current]?.focus();
  }, [model]);
  return <div className={`auth setup-page ${dark ? 'dark' : ''}`}>
    <main className="setup-content">
      <header className="auth-header"><a className="brand" href={homeHref}><Layers3/> JUEE POS</a>
        <div className="actions"><LanguageSwitch/><FullscreenButton className="icon"/><button className="plain" onClick={onLogout}><LogOut size={17}/> {t("Đăng xuất")}</button></div>
      </header>
      {error && <p className="error" role="alert">{t(error)}</p>}
      {model ? <StoreRegistration model={model} onBack={() => setModel(undefined)} onCreate={onCreate}/> : <>
        {onBack && <button type="button" className="plain setup-back" onClick={onBack}><ArrowLeft size={17} aria-hidden="true"/> {t("Về cửa hàng")}</button>}
        <div className="setup-intro"><h1>{t("Chọn mô hình quản lý")}</h1>
          <p>{t("Chọn mô hình phù hợp với cách cửa hàng của bạn hoạt động.")}</p>
        </div>
        <div className="setup-models">{models.map(item => <button type="button" className="card setup-model" key={item.mode}
          ref={element => { if (element) modelButtons.current[item.mode] = element; else delete modelButtons.current[item.mode]; }}
          data-theme={item.mode === 'MEMBERS' ? 'GYM' : item.mode} onClick={() => { lastChosen.current = item.mode; setModel(item); }}>
          <span className="setup-icon"><item.Icon size={26} aria-hidden="true"/></span>
          <span className="setup-model-copy"><strong>{t(item.name)}</strong><small>{t(item.description)}</small></span>
          <span className="setup-model-arrow"><ArrowRight size={19} aria-hidden="true"/></span>
        </button>)}</div>
      </>}
    </main>
  </div>;
}

function StoreRegistration({ model, onBack, onCreate }: { model: Model; onBack: () => void; onCreate: (id: string, branchId: string) => void }) {
  const { t } = useLanguage();
  const client = useQueryClient();
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [facility, setFacility] = useState<'GYM' | 'POOL'>('GYM');
  const mode = model.mode === 'MEMBERS' ? facility : model.mode;
  useEffect(() => { heading.current?.focus(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    submitting.current = true;
    setSaving(true); setError('');
    try {
      const store = await api<{ id: string; branches: { id: string }[] }>('/tenants', 'POST', {
        name: data.get('tenant'), branch: { name: data.get('branch'), mode, location: readBranchLocation(data) },
      });
      await client.invalidateQueries({ queryKey: ['tenants'] });
      onCreate(store.id, store.branches[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa tạo được cửa hàng.');
    } finally { submitting.current = false; setSaving(false); }
  }

  return <section className="setup-registration" data-theme={mode} aria-labelledby="setup-registration-heading">
    <button type="button" className="plain setup-back" onClick={onBack} disabled={saving}><ArrowLeft size={17} aria-hidden="true"/> {t("Chọn mô hình khác")}</button>
    <div className="card setup-form">
    <div className="setup-form-heading">
      <span className="setup-icon"><model.Icon size={26} aria-hidden="true"/></span>
      <div><p>{t(model.name)}</p><h1 id="setup-registration-heading" ref={heading} tabIndex={-1}>{t("Tạo cửa hàng")}</h1></div>
    </div>
    <form onSubmit={submit}>
      <div className="columns">
        <label>{t("Tên cửa hàng")}<input name="tenant" autoComplete="organization" required maxLength={120}/></label>
        <label>{t("Tên chi nhánh")}<input name="branch" defaultValue={t("Chi nhánh chính")} required maxLength={120}/></label>
      </div>
      {model.mode === 'MEMBERS' && <label>{t("Loại cơ sở")}<select value={facility} onChange={event => setFacility(event.target.value === 'POOL' ? 'POOL' : 'GYM')}>
        <option value="GYM">{branchNames.GYM}</option><option value="POOL">{branchNames.POOL}</option>
      </select></label>}
      <BranchLocationFields required/>
      {error && <p className="error" role="alert">{t(error)}</p>}
      <button className="button" disabled={saving}>{saving ? t("Đang xử lý…") : t("Tạo cửa hàng miễn phí")}</button>
    </form>
    </div>
  </section>;
}
