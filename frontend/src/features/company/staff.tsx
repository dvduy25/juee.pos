'use client';

import { useLanguage } from '@/i18n/language';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { submit, value } from '@/lib/format';
import { roleNames } from '@/features/dashboard/navigation';
import type { Branch } from '@/types/business';
import { StaffAvatar, StaffIdentityFields, useStaffIdentity } from './staff-identity';

export type Employee = { id: string; role: string; branchIds: string[]; disabled?: boolean;
  canResetPassword?: boolean;
  canEditProfile?: boolean;
  staffAvatarVersion?: string;
  staffName?: string | null; phone?: string | null; position?: string | null; specialty?: string | null; certifications?: string | null;
  user?: { name: string; email: string; locked: boolean } };
export const employeeName = (item: Employee) => item.staffName ?? item.user?.name ?? 'Nhân viên';

export function StaffDirectory({ coaches = false }: { coaches?: boolean }) {
  const { t } = useLanguage();
  const { branches, role } = useBusiness();
  const owner = role === 'OWNER';
  const canEdit = owner || role === 'MANAGER';
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('');
  const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<Employee | 'new' | 'manager'>();
  const [removing, setRemoving] = useState<Employee>();
  const [resetting, setResetting] = useState<Employee>();
  const [assigning, setAssigning] = useState<Employee>();
  const [notice, setNotice] = useState('');
  const params = new URLSearchParams({ page: String(page), ...(search.trim() ? { q: search.trim() } : {}),
    ...(scope ? { branch: scope } : {}), ...(status ? { status } : {}), ...(coaches ? { role: 'COACH' } : {}),
    ...(owner && !coaches ? { accountActions: 'true' } : {}) });
  const employees = useData<Employee[]>(`/staff?${params}`);
  return <Panel title={coaches ? t("Danh sách huấn luyện viên") : t("Danh sách nhân viên")} action={canEdit && <div className="actions">
    {owner && !coaches && <button type="button" className="plain" onClick={() => { setNotice(''); setEditor('manager'); }}><Plus size={17}/> {t("Thêm quản lý")}</button>}
    <button type="button" className="button" onClick={() => { setNotice(''); setEditor('new'); }}>
      <Plus size={17}/>{coaches ? t("Thêm huấn luyện viên") : t("Thêm nhân viên")}
    </button></div>}>
    <div className="company-filters">
      <label>{t("Tìm kiếm")}<input type="search" value={search} maxLength={120} placeholder={coaches ? t("Tên, email hoặc chuyên môn") : t("Tên, email hoặc chức vụ")}
        onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
      {owner && <label>{t("Chi nhánh")}<select value={scope} onChange={event => { setScope(event.target.value); setPage(1); }}>
        <option value="">{t("Tất cả")}</option>{branches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      <label>{t("Trạng thái")}<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="">{t("Tất cả")}</option><option value="active">{t("Đang hoạt động")}</option><option value="disabled">{t("Đã ngừng hoạt động")}</option>
      </select></label>
    </div>
    <State query={employees} empty={employees.data?.length === 0}/>
    {notice && <p className="success" role="status">{notice}</p>}
    {employees.data?.map(item => <div className="list-row service-list-row" key={item.id}>
      <div className="staff-identity-avatar"><StaffAvatar id={item.id} version={item.staffAvatarVersion}/><div>
        <strong>{employeeName(item)}</strong><small>{[(item.role === 'OWNER' || item.role === 'MANAGER') && item.user?.email, item.phone].filter(Boolean).join(' · ')}</small>
        {item.position && <small>{item.position}</small>}
        <small>{item.role === 'OWNER' ? t("Tất cả chi nhánh") :
          branches.filter(branch => item.branchIds.includes(branch.id)).map(branch => branch.name).join(', ')}</small>
        {item.role === 'COACH' && [item.specialty, item.certifications].filter(Boolean).map((entry, index) => <small key={index}>{entry}</small>)}
      </div></div>
      <div className="actions business-filters">
        <span className="badge">{roleNames[item.role] ?? item.role}</span>
        {item.disabled && <span className="badge warning">{t("Đã ngừng hoạt động")}</span>}
        {item.role === 'MANAGER' && item.user?.locked && <span className="badge warning">{t("Tài khoản bị khóa")}</span>}
        {(owner || item.canEditProfile) && item.role !== 'OWNER' && <>
          <button type="button" className="plain" onClick={() => { setNotice(''); setEditor(item); }}>{t("Sửa hồ sơ")}</button>
          {owner && item.role === 'MANAGER' && <button type="button" className="plain" onClick={() => { setNotice(''); setAssigning(item); }}>{t("Phân quyền cửa hàng")}</button>}
          {item.canResetPassword && <button type="button" className="plain" onClick={() => { setNotice(''); setResetting(item); }}>{t("Đặt lại mật khẩu")}</button>}
          <button type="button" className="plain member-delete" onClick={() => { setNotice(''); setRemoving(item); }}
            aria-label={t("Xóa {0}", employeeName(item))}>{t("Xóa")}</button>
        </>}
      </div>
    </div>)}
    <Pager page={page} full={employees.data?.length === 50} onChange={setPage}/>
    {editor && <StaffForm employee={typeof editor === 'string' ? undefined : editor} initialRole={editor === 'manager' ? 'MANAGER' : coaches ? 'COACH' : 'CASHIER'}
      close={() => setEditor(undefined)} saved={message => {
        setNotice(message); setEditor(undefined);
        if (typeof editor === 'string') { setSearch(''); setScope(''); setStatus(''); setPage(1); }
      }}/>}
    {resetting && <ResetManagerPassword employee={resetting} close={() => setResetting(undefined)} saved={() => {
      setNotice(`Đã đặt lại mật khẩu và đăng xuất các phiên của ${employeeName(resetting)}.`); setResetting(undefined);
    }}/>}
    {assigning && <ManagerAssignments employee={assigning} close={() => setAssigning(undefined)} saved={() => {
      setNotice(`Đã lưu quyền cửa hàng của ${employeeName(assigning)}.`); setAssigning(undefined);
    }}/>}
    {removing && <RemoveStaff employee={removing} close={() => setRemoving(undefined)} saved={() => {
      setNotice(`Đã xóa ${employeeName(removing)} khỏi doanh nghiệp.`);
      if (page > 1 && (employees.data?.length ?? 0) <= 1) setPage(page - 1);
      setRemoving(undefined);
    }}/>}
  </Panel>;
}

function StaffForm({ employee, initialRole, close, saved }: {
  employee?: Employee; initialRole: 'CASHIER' | 'COACH' | 'MANAGER'; close: () => void; saved: (notice: string) => void;
}) {
  const { t } = useLanguage();
  const { branch, branches, role: actorRole } = useBusiness();
  const action = useAction();
  const [createAccount, setCreateAccount] = useState(true);
  const [role, setRole] = useState(employee?.role ?? initialRole);
  const [notice, setNotice] = useState('');
  const identity = useStaffIdentity(employee?.id);
  const needsAccount = role === 'MANAGER' && !employee?.user;
  const requiresIdentity = !employee || (role === 'MANAGER' && employee.role !== 'MANAGER');
  const title = initialRole === 'MANAGER' ? t("Thêm quản lý") : initialRole === 'COACH' ? t("Thêm huấn luyện viên") : t("Thêm nhân viên");
  return <BusinessDialog title={employee ? `Sửa hồ sơ · ${employeeName(employee)}` : title}
    pending={action.pending} close={close}>
    {needsAccount && <div className="business-settings-tabs" role="group" aria-label={t("Cách cấp tài khoản")}>
      <button type="button" className="plain" aria-pressed={createAccount} disabled={action.pending} onClick={() => setCreateAccount(true)}>{t("Tạo tài khoản")}</button>
      <button type="button" className="plain" aria-pressed={!createAccount} disabled={action.pending} onClick={() => setCreateAccount(false)}>{t("Dùng tài khoản có sẵn")}</button>
    </div>}
    <form onSubmit={event => submit(event, form => {
      setNotice('');
      const branchIds = form.getAll('branch');
      if (!branchIds.length) { setNotice('Hãy chọn ít nhất một chi nhánh.'); return; }
      const avatar = form.get('avatar');
      const documents = form.getAll('documents').filter((file): file is File => file instanceof File && !!file.size);
      const removals = form.getAll('removeDocumentId');
      const uploads = avatar instanceof File && avatar.size ? [avatar, ...documents] : documents;
      if (documents.length + (identity.data?.documents.length ?? 0) - removals.length > 8) {
        setNotice('Mỗi hồ sơ lưu tối đa 8 ảnh giấy tờ.'); return;
      }
      if (uploads.some(file => file.size > 4 * 1024 * 1024) || uploads.reduce((size, file) => size + file.size, 0) > 8 * 1024 * 1024) {
        setNotice('Mỗi ảnh tối đa 4 MB và tổng ảnh mỗi lần lưu tối đa 8 MB.'); return;
      }
      const staffName = value(form, 'staffName');
      const profile = { role, branchIds, staffName: staffName || null, phone: value(form, 'phone') || null,
        position: value(form, 'position') || null, specialty: value(form, 'specialty') || null, certifications: value(form, 'certifications') || null };
      const credentials = needsAccount ? { email: value(form, 'email'), ...(createAccount &&
        { account: { name: staffName, password: String(form.get('password') ?? '') } }) } : {};
      const path = employee ? `/staff/${employee.id}` : '/staff';
      const citizenId = value(form, 'citizenId');
      const body = new FormData();
      body.set('profile', JSON.stringify({ ...profile, ...credentials,
        ...(citizenId && { citizenId }),
        ...(employee && { disabled: form.has('disabled'), removeDocumentIds: removals }),
      }));
      if (avatar instanceof File && avatar.size) body.set('avatar', avatar);
      for (const document of documents) body.append('documents', document);
      void action.send<{ verificationRequired?: boolean; verificationSent?: boolean }>(path,
        body,
        { method: employee ? 'PATCH' : 'POST' }).then(result => {
        if (!result) return;
        const message = employee ? t("Đã lưu hồ sơ nhân viên.") : t("Đã thêm nhân viên.");
        saved(result.verificationRequired ? `${message} Quản lý cần xác minh email trước khi đăng nhập.` : message);
      });
    })}>
      {needsAccount && <label>{t("Email đăng nhập")}<input name="email" type="email" maxLength={254} required/></label>}
      {role === 'MANAGER' && employee?.user && <p className="muted">{t("Email đăng nhập ·")} {employee.user.email}</p>}
      <div className="columns"><label>{t("Họ tên")}<input name="staffName" maxLength={120}
        required={role !== 'MANAGER' || (needsAccount && createAccount)} defaultValue={employee?.staffName ?? employee?.user?.name}/></label>
        <label>{t("Số điện thoại")}<input name="phone" type="tel" autoComplete="off" pattern={'[+]?[0-9]{7,15}'} maxLength={16} defaultValue={employee?.phone ?? ''}/></label></div>
      {needsAccount && createAccount && <label>{t("Mật khẩu đăng nhập")}<input name="password" type="password"
        autoComplete="new-password" minLength={12} maxLength={128} required/><small>{t("Từ 12 ký tự.")}</small></label>}
      <div className="columns"><label>{t("Vai trò")}<select name="role" value={role} onChange={event => setRole(event.target.value)}>
        {Object.entries(roleNames).filter(([key]) => key !== 'OWNER' && (key !== 'MANAGER' || actorRole === 'OWNER'))
          .map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label><label>{t("Chức vụ")}<input name="position" maxLength={120} defaultValue={employee?.position ?? ''} placeholder={t("Ví dụ: Trưởng ca")}/></label></div>
      {role === 'COACH' && <div className="columns">
        <label>{t("Chuyên môn")}<input name="specialty" maxLength={200} defaultValue={employee?.specialty ?? ''}/></label>
        <label>{t("Chứng chỉ")}<input name="certifications" maxLength={300} defaultValue={employee?.certifications ?? ''}/></label>
      </div>}
      {employee && <State query={identity}/>}
      {(!employee || identity.data) && <StaffIdentityFields id={employee?.id} version={employee?.staffAvatarVersion}
        identity={identity.data} required={requiresIdentity}/>}
      <BranchAssignments branches={branches} selected={employee?.branchIds ?? [branch.id]}
        label={role === 'MANAGER' ? t("Cửa hàng và chi nhánh được phép vào") : t("Chi nhánh làm việc")}/>
      {employee && <label className="check"><input type="checkbox" name="disabled" defaultChecked={employee.disabled}/> {t("Ngừng hoạt động tại doanh nghiệp")}</label>}
      <button type="submit" className="button" disabled={action.pending || (!!employee && !identity.data)}>{employee ? t("Lưu hồ sơ") : title}</button>
    </form>{action.feedback}
    {notice && <p className="error" role="alert">{notice}</p>}
  </BusinessDialog>;
}

function BranchAssignments({ branches, selected, label }: { branches: Branch[]; selected: string[]; label: string }) {
  const { t } = useLanguage();
  const [checked, setChecked] = useState(() => new Set(selected));
  return <fieldset><legend>{label}</legend>
    {branches.length > 1 && <div className="actions">
      <button type="button" className="plain" onClick={() => setChecked(new Set(branches.map(branch => branch.id)))}>{t("Chọn tất cả")}</button>
      <button type="button" className="plain" onClick={() => setChecked(new Set())}>{t("Bỏ chọn tất cả")}</button>
    </div>}
    {branches.map(branch => <label className="check" key={branch.id}>
      <input type="checkbox" name="branch" value={branch.id} checked={checked.has(branch.id)} onChange={event => {
        const next = new Set(checked);
        if (event.target.checked) next.add(branch.id); else next.delete(branch.id);
        setChecked(next);
      }}/>{branch.name}
    </label>)}
  </fieldset>;
}

function ManagerAssignments({ employee, close, saved }: { employee: Employee; close: () => void; saved: () => void }) {
  const { t } = useLanguage();
  const { branches } = useBusiness();
  const action = useAction();
  const [error, setError] = useState('');
  return <BusinessDialog title={t("Phân quyền cửa hàng")} close={close} pending={action.pending}>
    <p><strong>{employeeName(employee)}</strong>{employee.user && ` · ${employee.user.email}`}</p>
    <form onSubmit={event => submit(event, form => {
      const branchIds = form.getAll('branch');
      setError(branchIds.length ? '' : 'Hãy chọn ít nhất một cửa hàng hoặc chi nhánh. Dùng Ngừng hoạt động để thu hồi toàn bộ quyền.');
      if (branchIds.length) void action.send(`/staff/${employee.id}`, { branchIds }, { method: 'PATCH' }).then(result => { if (result) saved(); });
    })}>
      <BranchAssignments branches={branches} selected={employee.branchIds} label={t("Cửa hàng và chi nhánh được phép vào")}/>
      {error && <p className="error" role="alert">{t(error)}</p>}
      <button type="submit" className="button" disabled={action.pending}>{t("Lưu quyền")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function ResetManagerPassword({ employee, close, saved }: { employee: Employee; close: () => void; saved: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  const [mismatch, setMismatch] = useState(false);
  return <BusinessDialog title={t("Đặt lại mật khẩu quản lý")} close={close} pending={action.pending}>
    <p><strong>{employeeName(employee)}</strong> · {employee.user?.email}</p>
    <form onSubmit={event => submit(event, form => {
      const password = form.get('password');
      const same = password === form.get('confirm');
      setMismatch(!same);
      if (same) void action.send(`/staff/${employee.id}/reset-password`, { password }).then(result => { if (result) saved(); });
    })}>
      <label>{t("Mật khẩu mới")}<input type="password" name="password" minLength={12} maxLength={128} autoComplete="new-password" required/></label>
      <label>{t("Nhập lại mật khẩu")}<input type="password" name="confirm" minLength={12} maxLength={128} autoComplete="new-password" required/></label>
      <p className="muted">{t("Quản lý sẽ đăng nhập lại bằng mật khẩu mới.")}</p>
      {mismatch && <p className="error" role="alert">{t("Hai mật khẩu chưa khớp.")}</p>}
      <button type="submit" className="button" disabled={action.pending}>{t("Xác nhận đặt lại")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function RemoveStaff({ employee, close, saved }: { employee: Employee; close: () => void; saved: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  return <BusinessDialog title={t("Xóa nhân viên")} close={close} closeLabel="Hủy" pending={action.pending}>
    <p>{t("Xóa")} <strong>{employeeName(employee)}</strong> {t("khỏi doanh nghiệp? Hệ thống sẽ thu hồi quyền và hủy những ca sắp tới. Lịch sử chấm công vẫn được lưu.")}</p>
    <button type="button" className="button member-delete-confirm" disabled={action.pending} onClick={() => {
      void action.send(`/staff/${employee.id}`, undefined, { method: 'DELETE' }).then(result => { if (result) saved(); });
    }}>{t("Xóa nhân viên")}</button>
    {action.feedback}
  </BusinessDialog>;
}
