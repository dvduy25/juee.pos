'use client';

import { useLanguage } from '@/i18n/language';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { BusinessDialog } from '@/components/business-dialog';
import { Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, submit, value } from '@/lib/format';
import { planPrice, planUnits, unitLabels, unitLimits, type MemberPlan as Plan } from '@/lib/member-plans';
import { checkInMethodLabels as methods, type CheckInMethod as Method, type CheckInSettings, type KioskMethod } from '@/types/member-check-in';
import { MemberVisits } from '@/features/dashboard/members';

export function MemberPlans() {
  const { t } = useLanguage();
  const { mode } = useBusiness();
  const query = useData<Plan[]>('/member-plans');
  const [editor, setEditor] = useState<Plan | 'new'>();
  const [notice, setNotice] = useState('');
  const addLabel = mode === 'POOL' ? 'Thêm gói bơi' : 'Thêm gói tập';
  return <Panel title={t("Danh sách gói")} action={
    <button type="button" className="button" onClick={() => { setNotice(''); setEditor('new'); }}><Plus size={17}/> {t(addLabel)}</button>}>
    {notice && <p className="success" role="status">{notice}</p>}
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(plan => <div className="list-row" key={plan.id}>
      <div><strong>{plan.name}</strong><small>{planUnits(plan)} · {planPrice(plan)}</small><small>{plan.active ? t("Đang dùng") : t("Ngừng nhận đăng ký")}</small></div>
      <button className="plain" type="button" onClick={() => { setNotice(''); setEditor(plan); }}>{t("Sửa gói")}</button>
    </div>)}
    {editor && <MemberPlanEditor plan={editor === 'new' ? undefined : editor} addLabel={addLabel} close={() => setEditor(undefined)} onSaved={name => {
      setEditor(undefined);
      setNotice(editor === 'new' ? `Đã thêm gói ${name}.` : `Đã lưu gói ${name}.`);
    }}/>}
  </Panel>;
}

function MemberPlanEditor({ plan, addLabel, close, onSaved }: { plan?: Plan; addLabel: string; close: () => void; onSaved: (name: string) => void }) {
  const { t } = useLanguage();
  const action = useAction();
  const [kind, setKind] = useState<Plan['kind']>(plan?.kind ?? 'MONTH');
  return <BusinessDialog title={plan ? `Sửa ${plan.name}` : addLabel} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      const fields = { name: value(form, 'name'), kind, units: amount(form, 'units'), price: amount(form, 'price'),
        validityMonths: kind === 'VISITS' && value(form, 'validityMonths') ? amount(form, 'validityMonths') : null, active: form.has('active') };
      void action.send<Plan>(plan ? `/member-plans/${plan.id}` : '/member-plans', fields, { method: plan ? 'PATCH' : 'POST' }).then(result => {
        if (result) onSaved(result.name);
      });
    })}>
      <label>{t("Tên gói")}<input name="name" maxLength={120} defaultValue={plan?.name} required/></label>
      <label>{t("Loại gói")}<select value={kind} onChange={event => setKind(event.target.value as Plan['kind'])}>
        <option value="MONTH">{t("Theo tháng")}</option><option value="DAY">{t("Theo ngày")}</option><option value="VISITS">{t("Theo lượt")}</option>
      </select></label>
      <label>{t("Số")} {t(unitLabels[kind])}<input key={kind} name="units" type="number" min={1}
        max={unitLimits[kind]} defaultValue={kind === plan?.kind ? plan.units : 1} required/></label>
      {kind === 'VISITS' && <label>{t("Hạn dùng (tháng)")}<input name="validityMonths" type="number" min={1} max={120}
        defaultValue={plan?.validityMonths ?? undefined} placeholder={t("Để trống nếu dùng tới khi hết lượt")}/></label>}
      <label>{t("Giá gói (đ)")}<input name="price" type="number" min={0} max={1000000000000} step={1} defaultValue={plan?.price ?? 0} required/></label>
      <label className="check"><input name="active" type="checkbox" defaultChecked={plan?.active ?? true}/> {t("Cho phép gán gói")}</label>
      <button className="button" disabled={action.pending}>{t("Lưu gói")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

export function MemberCheckInManagement() {
  const { t } = useLanguage();
  const [view, setView] = useState<'settings' | 'history'>('settings');
  return <>
    <div className="business-settings-tabs" role="group" aria-label={t("Quản lý check-in")}>
      <button className="plain" type="button" aria-pressed={view === 'settings'} onClick={() => setView('settings')}>{t("Cấu hình và thiết bị")}</button>
      <button className="plain" type="button" aria-pressed={view === 'history'} onClick={() => setView('history')}>{t("Lịch sử check-in")}</button>
    </div>
    {view === 'settings' ? <MemberDevices/> : <MemberVisits/>}
  </>;
}

function MemberDevices() {
  const { t } = useLanguage();
  const settings = useData<CheckInSettings>('/member-check-in-settings');
  const action = useAction();
  return <div className="member-management">
    <Panel title={t("Phương thức check-in của phòng")}>
      <State query={settings}/>
      {settings.data && <form key={settings.data.methods.join('|')} onSubmit={event => submit(event, form => {
        void action.send('/member-check-in-settings', { methods: form.getAll('method') }, { method: 'PATCH', message: 'Đã lưu phương thức check-in.' });
      })}>
        <fieldset><legend>{t("Phương thức được phép")}</legend>
          {Object.entries(methods).map(([method, label]) => <label className="check" key={method}>
            <input type="checkbox" name="method" value={method} defaultChecked={settings.data.methods.includes(method as Method)}/>{t(label)}
          </label>)}
        </fieldset>
        <button className="button" disabled={action.pending}>{t("Lưu cài đặt")}</button>
      </form>}{action.feedback}
    </Panel>
    {settings.data && <MemberKioskSettings settings={settings.data}/>}
    <MemberDeviceKey/>
  </div>;
}

function MemberKioskSettings({ settings }: { settings: CheckInSettings }) {
  const { t } = useLanguage();
  const { tenantId, branch } = useBusiness();
  const [key, setKey] = useState('');
  const action = useAction();
  const supported = settings.methods.filter((method): method is KioskMethod => method === 'CARD' || method === 'MEMBER_CODE');
  return <Panel title={t("Màn hình tự check-in tại cửa")}>
    {supported.includes('CARD') && <p>{t("Chọn link dành cho thẻ. Đặt đầu đọc ở chế độ bàn phím và gửi phím Enter sau khi quét.")}</p>}
    {!supported.length && <p className="muted">{t("Bật mã hội viên hoặc thẻ hội viên để dùng màn hình tại cửa.")}</p>}
    <div className="actions member-row-actions">
      <button className="button" type="button" disabled={action.pending || !supported.length} onClick={() => void action.send<{ key: string }>('/member-kiosk-key',
        undefined, { message: 'Đã tạo link cho màn hình tự check-in.' }).then(result => { if (result) setKey(result.key); })}>
        {settings.kioskEnabled ? t("Tạo link thay thế") : t("Tạo link tự check-in")}
      </button>
      {settings.kioskEnabled && <button className="plain" type="button" disabled={action.pending} onClick={() => void action.send('/member-kiosk-key',
        undefined, { method: 'DELETE', message: 'Đã ngắt màn hình tự check-in.' }).then(result => { if (result) setKey(''); })}>{t("Thu hồi link")}</button>}
    </div>
    {key && settings.kioskEnabled && supported.map(method => {
      const url = `${window.location.origin}/check-in/${tenantId}/${branch.id}?method=${method}#key=${key}`;
      return <div key={method} className="member-kiosk-link"><label>{t(methods[method])}<input readOnly value={url} onFocus={event => event.currentTarget.select()}/></label>
        <a href={url} className="plain" target="_blank" rel="noreferrer">{t("Mở màn hình")}</a></div>;
    })}
    {action.feedback}
  </Panel>;
}

function MemberDeviceKey() {
  const { t } = useLanguage();
  const { root } = useBusiness();
  const [key, setKey] = useState('');
  const action = useAction();
  const status = useData<{ enabled: boolean }>('/member-device-key');
  return <Panel title={t("Kết nối máy check-in")}>
    <p>{t("Liên kết mã hồ sơ trên máy với hội viên trước. Dùng bộ tích hợp của máy để gửi mã đã nhận diện đến địa chỉ dưới đây.")}</p>
    <label>{t("Đường dẫn API")}<input readOnly value={`/api/v1${root}/member-device-check-ins`} onFocus={event => event.currentTarget.select()}/></label>
    <State query={status}/>
    {status.data && <div className="actions member-row-actions">
      <button className="button" type="button" disabled={action.pending} onClick={() => void action.send<{ key: string }>('/member-device-key',
        undefined, { message: 'Đã tạo khóa thiết bị.' }).then(result => { if (result) setKey(result.key); })}>
        {status.data.enabled ? t("Tạo khóa thay thế") : t("Tạo khóa thiết bị")}
      </button>
      {status.data.enabled && <button className="plain" type="button" disabled={action.pending} onClick={() => void action.send('/member-device-key',
        undefined, { method: 'DELETE', message: 'Đã thu hồi khóa.' }).then(result => { if (result) setKey(''); })}>{t("Thu hồi khóa")}</button>}
    </div>}
    {key && <label>{t("Khóa thiết bị · Sao chép trước khi rời trang")}
      <input readOnly value={key} onFocus={event => event.currentTarget.select()}/>
    </label>}
    {action.feedback}
  </Panel>;
}
