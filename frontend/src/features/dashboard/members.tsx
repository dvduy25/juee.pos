'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Plus, ScanLine, Search } from 'lucide-react';
import { Pager, Panel, State } from '@/components/business-ui';
import { BusinessDialog } from '@/components/business-dialog';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { currency, date, submit, value, vietnamLocalTime } from '@/lib/format';
import { planPrice, planUnits, type MemberPlan as Plan } from '@/lib/member-plans';
import { ApiError } from '@/services/api-client';
import { MemberPhoto } from './member-photo';
import { paymentMethodLabels, ServicePaymentField, type PaymentMethod } from './service-payment';
import { VisitProgressFields } from '@/features/check-in/visit-progress';
import { checkInMethodLabels as methods, memberCredentialLabels as credentials, type CheckInMethod as Method,
  type CheckInSettings, type VisitProgress } from '@/types/member-check-in';

type CredentialMethod = keyof typeof credentials;
type Enrollment = { planId: string; planName: string; kind: Plan['kind']; startsOn: string; expiresOn?: string; remaining?: number;
  price?: number; chargeId?: string; paymentId?: string };
const statusLabels = { ACTIVE: 'Có thể check-in', PAUSED: 'Tạm dừng', FROZEN: 'Đang bảo lưu', PENDING: 'Chưa bắt đầu', NO_PLAN: 'Chưa có gói',
  NO_VISITS: 'Hết lượt', EXPIRED: 'Hết hạn' };
type Member = { id: string; name: string; phone: string; code: string; plan?: string; expiresOn?: string; active: boolean;
  enrollment?: Enrollment; photo?: { version: string }; accessStatus: keyof typeof statusLabels;
  freeze?: { startsOn: string; resumesOn: string; reason: string }; createdAt?: string };
export type MemberList = { members: Member[]; activeMembers: number; visitsToday: number };
const sourceLabels = { STAFF: 'Lễ tân', KIOSK: 'Tự check-in', DEVICE: 'Thiết bị' };
type Visit = { id: string; memberId: string; memberName: string; photoVersion?: string; createdAt: string;
  method?: Method; planName?: string; remaining?: number; progress?: VisitProgress; source?: keyof typeof sourceLabels };

const editable = (role: string) => role === 'OWNER' || role === 'MANAGER';
const receptionAllowed = (role: string) => editable(role) || role === 'CASHIER';

function registrationNotice(member: Member) {
  const { enrollment } = member;
  const collected = enrollment?.paymentId && typeof enrollment.price === 'number' ? ` · Đã thu ${currency.format(enrollment.price)}` : '';
  return `Đã thêm ${member.name} · Mã hội viên ${member.code}${enrollment ? ` · ${enrollment.planName}` : ''}${collected}.`;
}

function planPayment(price: number, form: FormData) {
  return { expectedAmount: price, method: price > 0 ? value(form, 'paymentMethod') : undefined };
}

function visitMethod(visit: Visit) {
  return [methods[visit.method ?? 'MEMBER_CODE'], visit.source && sourceLabels[visit.source]].filter(Boolean).join(' · ');
}

function MemberVisitRows({ visits, onDetails, highlight = false, showLatestProgress = false }: {
  visits: Visit[]; onDetails: (visit: Visit) => void; highlight?: boolean; showLatestProgress?: boolean;
}) {
  return visits.map((visit, index) => {
    const showProgress = !!visit.progress && (highlight || (showLatestProgress && index === 0));
    return <div className="list-row service-list-row member-list-row" key={visit.id}>
      <div className="member-identity">
        <MemberPhoto memberId={visit.memberId} version={visit.photoVersion} large={highlight}/>
        <div><strong>{visit.memberName}</strong><small>{[visitMethod(visit), visit.planName].filter(Boolean).join(' · ')}</small>
          {!showProgress && typeof visit.remaining === 'number' && <small>Còn {visit.remaining} lượt sau check-in</small>}</div>
      </div>
      <div className="member-visit-time"><time dateTime={visit.createdAt}>{date(visit.createdAt)}</time>
        <button type="button" className="plain" aria-label={`Xem thông tin ${visit.memberName}`} onClick={() => onDetails(visit)}>Xem thông tin</button></div>
      {showProgress && <dl className="member-visit-details member-progress"><VisitProgressFields progress={visit.progress} remaining={visit.remaining}/></dl>}
    </div>;
  });
}

function MemberVisitDetails({ visit, close }: { visit: Visit; close: () => void }) {
  const profile = useData<Member>(`/members/${visit.memberId}`);
  const removed = profile.error instanceof ApiError && profile.error.status === 404;
  const member = removed ? undefined : profile.data;
  const enrollment = member?.enrollment;
  const expiry = enrollment?.expiresOn ?? member?.expiresOn;
  const photoVersion = removed ? undefined : member ? member.photo?.version : visit.photoVersion;
  return <BusinessDialog title="Thông tin check-in" close={close}>
    <div className="member-identity"><MemberPhoto memberId={visit.memberId} version={photoVersion} large/>
      <div><strong>{member?.name ?? visit.memberName}</strong>{member && <p>Mã hội viên <code>{member.code}</code></p>}</div>
    </div>
    <dl className="member-visit-details">
      <dt>Giờ check-in</dt><dd><time dateTime={visit.createdAt}>{date(visit.createdAt)}</time></dd>
      <dt>Phương thức</dt><dd>{visitMethod(visit)}</dd>
      {visit.planName && <><dt>Gói lúc check-in</dt><dd>{visit.planName}</dd></>}
      <VisitProgressFields progress={visit.progress} remaining={visit.remaining}/>
      {member && <><dt>Số điện thoại</dt><dd>{member.phone}</dd>
        <dt>Gói hiện tại</dt><dd>{enrollment?.planName ?? member.plan ?? 'Chưa có gói'}</dd>
        {expiry && expiry !== visit.progress?.expiresOn && <><dt>Hạn gói hiện tại</dt><dd>{expiry.split('-').reverse().join('/')}</dd></>}
        <dt>Trạng thái hội viên</dt><dd>{statusLabels[member.accessStatus]}</dd>
      </>}
    </dl>
    {removed ? <p className="muted">Hồ sơ hội viên đã được xoá.</p> : <State query={profile}/>}
  </BusinessDialog>;
}

export function MemberCheckIn() {
  const { role } = useBusiness();
  const allowed = receptionAllowed(role);
  const stats = useData<MemberList>('/members', 5000, allowed);
  const visits = useData<Visit[]>('/member-visits?page=1', 5000, allowed);
  const settings = useData<CheckInSettings>('/member-check-in-settings', 10000, allowed);
  const action = useAction();
  const [method, setMethod] = useState<Method>('MEMBER_CODE');
  const permitted = settings.data?.methods ?? [];
  const selectedMethod = permitted.includes(method) ? method : permitted[0];
  const [last, setLast] = useState<Visit>();
  const [details, setDetails] = useState<Visit>();
  const [addingMember, setAddingMember] = useState(false);
  const [registration, setRegistration] = useState('');
  const recent = visits.data ?? [];
  const latest = last && !recent.some(visit => visit.id === last.id) && (!recent[0] || last.createdAt >= recent[0].createdAt)
    ? [last, ...recent] : recent;
  const code = useRef<HTMLInputElement>(null);
  if (!allowed) return <p className="error">Bạn không có quyền check-in hội viên.</p>;
  return <div className="service-workspace">
    <div className="desk-page-title"><h1>Check-in</h1>
      <div className="actions service-tools">
        {stats.data && <div className="service-totals">
          <span>Hội viên đủ điều kiện <strong>{stats.data.activeMembers}</strong></span>
          <span>Lượt vào hôm nay <strong>{stats.data.visitsToday}</strong></span>
        </div>}
        <button type="button" className="button" onClick={() => { setRegistration(''); setAddingMember(true); }}>
          <Plus size={17} aria-hidden="true"/> Thêm hội viên
        </button>
      </div>
    </div>
    {registration && <p className="notice success" role="status">{registration}</p>}
    <div className="service-split service-entry"><Panel title="Quét hoặc nhập mã" className="service-side">
      <State query={settings}/>
      {settings.isSuccess && !selectedMethod && <p className="notice">Check-in đang tạm tắt tại phòng.</p>}
      {selectedMethod && <form onSubmit={event => submit(event, (form, element) => {
        setLast(undefined);
        void action.send<Visit>('/member-check-ins', { method: selectedMethod, code: value(form, 'code') },
          { reset: element, message: 'Đã ghi nhận check-in.' }).then(result => {
          if (result) setLast(result);
          code.current?.focus();
          if (!result) code.current?.select();
        });
      })}>
        <label>Phương thức<select value={selectedMethod} onChange={event => { setMethod(event.target.value as Method); code.current?.focus(); }}>
          {permitted.map(key => <option key={key} value={key}>{methods[key]}</option>)}
        </select></label>
        <label>{selectedMethod === 'MEMBER_CODE' ? 'Mã hội viên' : selectedMethod === 'CARD' ? 'Mã thẻ' : 'Mã định danh trên máy'}
          <input ref={code} name="code" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={80} required/>
        </label>
        <button type="submit" className="button" disabled={action.pending}><ScanLine size={17}/> Check-in</button>
      </form>}{action.feedback}
      {last && <MemberVisitRows visits={[last]} onDetails={setDetails} highlight/>}
    </Panel><Panel title="Lượt vào gần đây">
      <State query={visits} empty={visits.data?.length === 0}/>
      <MemberVisitRows visits={latest.slice(0, 6)} onDetails={setDetails} showLatestProgress={latest[0]?.id !== last?.id}/>
      <Link className="plain" href="/dashboard/member-visits">Xem lịch sử</Link>
    </Panel></div>
    {addingMember && <MemberProfile close={() => setAddingMember(false)} onCreated={member => {
      setAddingMember(false);
      setRegistration(registrationNotice(member));
    }}/>}
    {details && <MemberVisitDetails visit={details} close={() => setDetails(undefined)}/>}
  </div>;
}

export function MemberDirectory({ management = false }: { management?: boolean }) {
  const { role } = useBusiness();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [detailsId, setDetailsId] = useState<string>();
  const [editId, setEditId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Member>();
  const [notice, setNotice] = useState('');
  const canEdit = editable(role) && (role !== 'OWNER' || management);
  const members = useData<MemberList>(`/members?page=${page}&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`, 10000);
  const profile = useData<Member>(`/members/${editId}`, 10000, canEdit && !!editId);
  const edit = profile.data ?? members.data?.members.find(member => member.id === editId);
  return <div className={canEdit && edit ? 'service-split' : ''}><Panel title="Danh sách hội viên" action={<div className="actions service-tools">
    <label className="menu-search"><Search size={15} aria-hidden="true"/>
      <input type="search" aria-label="Tìm hội viên" placeholder="Tên, số điện thoại hoặc mã" value={q} maxLength={120}
        onChange={event => { setQ(event.target.value); setPage(1); }}/>
    </label>
    {!management && role === 'OWNER' && <Link className="plain" href="/dashboard/company?tab=members">Quản lý hội viên</Link>}
    {receptionAllowed(role) && <button type="button" className="button" onClick={() => { setEditId(undefined); setNotice(''); setCreating(true); }}>
      <Plus size={17} aria-hidden="true"/> Thêm hội viên
    </button>}
    </div>}>
    <label>Trạng thái gói<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
      <option value="">Tất cả trạng thái</option>
      {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {notice && <p className="success" role="status">{notice}</p>}
    <State query={members} empty={members.data?.members.length === 0}/>
    {members.data?.members.map(item => {
      const enrollment = item.enrollment;
      const expiry = enrollment?.expiresOn ?? item.expiresOn;
      return <div key={item.id} className="list-row service-list-row member-list-row"><div className="member-identity">
        <MemberPhoto memberId={item.id} version={item.photo?.version}/>
        <div><strong>{item.name}</strong><small>{item.phone} · <code>{item.code}</code></small>
        <small>{enrollment?.planName ?? item.plan ?? 'Chưa có gói'}
          {expiry && ` · Đến ${expiry.split('-').reverse().join('/')}`}
          {enrollment?.kind === 'VISITS' && ` · Còn ${enrollment.remaining ?? 0} lượt`}</small></div></div>
        <div className="actions member-row-actions"><span className={`badge ${item.accessStatus === 'ACTIVE' ? '' : 'warning'}`}>{statusLabels[item.accessStatus]}</span>
          <button type="button" className="plain" aria-haspopup="dialog" aria-label={`Xem chi tiết hội viên ${item.name}`}
            onClick={() => setDetailsId(item.id)}>Xem chi tiết</button>
          {canEdit && <><button type="button" className="plain" onClick={() => setEditId(item.id)}>Chỉnh sửa</button>
            <button type="button" className="plain member-delete" aria-label={`Xoá hội viên ${item.name}`}
              onClick={() => { setNotice(''); setDeleting(item); }}>Xoá</button></>}</div>
      </div>;
    })}
    <Pager page={page} full={members.data?.members.length === 50} onChange={setPage}/>
  </Panel>{canEdit && edit && <div className="member-management" key={edit.id}>
    <MemberProfile member={edit} close={() => setEditId(undefined)}/>
    <MemberEnrollment member={edit}/><MemberFreeze member={edit}/><MemberHistory memberId={edit.id}/>
    <MemberCredentials memberId={edit.id}/>
  </div>}
    {detailsId && <MemberDetails key={detailsId} memberId={detailsId} close={() => setDetailsId(undefined)}/>}
    {receptionAllowed(role) && creating && <MemberProfile close={() => setCreating(false)} onCreated={member => {
      setCreating(false);
      setQ('');
      setStatus('');
      setPage(1);
      setNotice(registrationNotice(member));
    }}/>}
    {canEdit && deleting && <MemberDeleteDialog member={deleting} close={() => setDeleting(undefined)} onDeleted={() => {
      if (editId === deleting.id) setEditId(undefined);
      if (page > 1 && (members.data?.members.length ?? 0) <= 1) setPage(page - 1);
      setNotice(`Đã xoá hội viên ${deleting.name}.`);
      setDeleting(undefined);
    }}/>}
  </div>;
}

function MemberDetails({ memberId, close }: { memberId: string; close: () => void }) {
  const profile = useData<Member>(`/members/${memberId}`);
  const member = profile.isSuccess ? profile.data : undefined;
  const enrollment = member?.enrollment;
  const expiry = enrollment?.expiresOn ?? member?.expiresOn;
  const freeze = member?.accessStatus === 'FROZEN' ? member.freeze : undefined;

  return <BusinessDialog title="Chi tiết hội viên" close={close}>
    <State query={profile}/>
    {member && <>
      <div className="member-identity member-profile-heading">
        <MemberPhoto memberId={member.id} version={member.photo?.version} large/>
        <div><h3>{member.name}</h3><span className={`badge ${member.accessStatus === 'ACTIVE' ? '' : 'warning'}`}>
          {statusLabels[member.accessStatus]}
        </span></div>
      </div>
      <dl className="member-profile-details">
        <dt>Mã hội viên</dt><dd><code>{member.code}</code></dd>
        <dt>Số điện thoại</dt><dd>{member.phone}</dd>
        {member.createdAt && <><dt>Ngày đăng ký</dt><dd><time dateTime={member.createdAt}>{date(member.createdAt)}</time></dd></>}
        <dt>Gói hiện tại</dt><dd>{enrollment?.planName ?? member.plan ?? 'Chưa có gói'}</dd>
        {enrollment?.startsOn && <><dt>Ngày bắt đầu gói</dt><dd><MemberDate day={enrollment.startsOn}/></dd></>}
        {(expiry || enrollment?.kind === 'VISITS') && <><dt>Hạn gói</dt><dd>{expiry ? <MemberDate day={expiry}/> : 'Không có ngày hết hạn'}</dd></>}
        {enrollment?.kind === 'VISITS' && <><dt>Số lượt còn lại</dt><dd>{enrollment.remaining ?? 0} lượt</dd></>}
        {freeze && <>
          <dt>Ngày mở lại sau bảo lưu</dt><dd><MemberDate day={freeze.resumesOn}/></dd>
          {freeze.reason && <><dt>Lý do bảo lưu</dt><dd>{freeze.reason}</dd></>}
        </>}
      </dl>
    </>}
  </BusinessDialog>;
}

function MemberDate({ day }: { day: string }) {
  return <time dateTime={day}>{day.split('-').reverse().join('/')}</time>;
}

function MemberFreeze({ member }: { member: Member }) {
  const action = useAction();
  const frozen = member.accessStatus === 'FROZEN';
  const tomorrow = vietnamLocalTime(Date.now() + 86_400_000).slice(0, 10);
  const canResume = !!member.freeze && member.freeze.resumesOn >= tomorrow;
  if (!canResume && member.accessStatus !== 'ACTIVE') return null;
  return <Panel title="Bảo lưu gói">
    {canResume && member.freeze ? <>
      <p>{frozen ? 'Đang bảo lưu.' : 'Hội viên đang bị tắt quyền check-in.'} Ngày mở lại theo lịch {member.freeze.resumesOn.split('-').reverse().join('/')}.
        {member.freeze.reason && ` Lý do: ${member.freeze.reason}`}</p>
      <button type="button" className="plain" disabled={action.pending} onClick={() =>
        void action.send(`/members/${member.id}/resume`, undefined, { message: 'Đã kết thúc bảo lưu.' })}>Kết thúc bảo lưu</button>
    </> : <form onSubmit={event => submit(event, (form, element) => void action.send(`/members/${member.id}/freeze`, {
      resumesOn: value(form, 'resumesOn'), reason: value(form, 'reason'),
    }, { reset: element, message: 'Đã bảo lưu gói.' }))}>
      <p className="muted">Bắt đầu hôm nay. Gói có hạn sẽ được cộng số ngày bảo lưu.</p>
      <div className="columns"><label>Ngày mở lại<input type="date" name="resumesOn" min={tomorrow} required/></label>
        <label>Lý do<input name="reason" maxLength={120} required/></label></div>
      <button type="submit" className="plain" disabled={action.pending}>Bảo lưu</button>
    </form>}{action.feedback}
  </Panel>;
}

type MemberHistoryPayment = { id: string; amount: number; method: PaymentMethod; paidAt: string; planName: string };
function MemberHistory({ memberId }: { memberId: string }) {
  const [kind, setKind] = useState<'payments' | 'visits'>('visits');
  const [page, setPage] = useState(1);
  const query = useData<(Visit | MemberHistoryPayment)[]>(`/members/${memberId}/history?kind=${kind}&page=${page}`);
  return <Panel title="Lịch sử hội viên">
    <label>Loại lịch sử<select value={kind} onChange={event => {
      setKind(event.target.value === 'payments' ? 'payments' : 'visits');
      setPage(1);
    }}><option value="visits">Check-in</option><option value="payments">Thu tiền gói</option></select></label>
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => <div key={item.id} className="list-row">
      <div><strong>{item.planName ?? 'Gói hội viên'}</strong>
        <small>{'paidAt' in item ? `${date(item.paidAt)} · ${paymentMethodLabels[item.method]}` : `${date(item.createdAt)} · ${visitMethod(item)}`}</small>
      </div>
      {'amount' in item && <strong>{currency.format(item.amount)}</strong>}
    </div>)}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
  </Panel>;
}

function MemberDeleteDialog({ member, close, onDeleted }: { member: Member; close: () => void; onDeleted: () => void }) {
  const { root } = useBusiness();
  const client = useQueryClient();
  const action = useAction();
  const path = `/members/${member.id}`;
  return <BusinessDialog title="Xoá hội viên" close={close} pending={action.pending} closeLabel="Huỷ">
    <p>Xoá hồ sơ của <strong>{member.name}</strong> (<code>{member.code}</code>)?</p>
    <p className="muted">Hội viên sẽ mất quyền check-in. Các lượt check-in đã ghi nhận vẫn có trong lịch sử.</p>
    {action.feedback}
    <button type="button" className="button member-delete-confirm" disabled={action.pending} onClick={async () => {
      const result = await action.send(path, undefined, { method: 'DELETE' });
      if (!result) return;
      client.removeQueries({ queryKey: ['member-photo', root, member.id] });
      client.removeQueries({ queryKey: ['business', root, path], exact: true });
      onDeleted();
    }}>{action.pending ? 'Đang xoá…' : 'Xoá hội viên'}</button>
  </BusinessDialog>;
}

function MemberProfile({ member, close, onCreated }: { member?: Member; close: () => void; onCreated?: (member: Member) => void }) {
  const { role, mode } = useBusiness();
  const action = useAction();
  const plans = useData<Plan[]>('/member-plans', undefined, !member);
  const activePlans = plans.data?.filter(plan => plan.active) ?? [];
  const [planId, setPlanId] = useState('');
  const selectedPlan = activePlans.find(plan => plan.id === planId);
  const price = selectedPlan?.price ?? 0;
  const planLabel = mode === 'POOL' ? 'Gói bơi' : 'Gói tập';
  const content = <>
    {member && <p>Mã hội viên <code>{member.code}</code></p>}
    <form onSubmit={event => submit(event, form => {
      if (!member && !selectedPlan) return;
      const image = form.get('image');
      const fields = { name: value(form, 'name'), phone: value(form, 'phone') };
      const payload = member ? { ...fields, active: form.has('active') } : { ...fields, planId, payment: planPayment(price, form) };
      let body: FormData | typeof payload = payload;
      if (image instanceof File && image.size) {
        body = new FormData();
        body.set('member', JSON.stringify(payload));
        body.set('image', image);
      }
      void action.send<Member>(member ? `/members/${member.id}` : '/members', body, member ?
        { method: 'PATCH', message: 'Đã lưu hồ sơ.' } : { idempotent: true }).then(result => {
        if (result && !member) onCreated?.(result);
        else if (!result && !member) void plans.refetch();
      });
    })}>
      <label>Họ tên<input name="name" defaultValue={member?.name} maxLength={120} required/></label>
      <label>Số điện thoại<input name="phone" type="tel" autoComplete="off" defaultValue={member?.phone} maxLength={16} required/></label>
      <MemberPhotoField key={member?.photo?.version ?? 'new-photo'} member={member}/>
      {!member && <><State query={plans}/>
        {plans.isSuccess && !activePlans.length && <p>Chưa có gói đang hoạt động tại chi nhánh. {role === 'OWNER' &&
          <Link href="/dashboard/company?tab=member-plans">Tạo gói trong Quản lý doanh nghiệp</Link>}</p>}
        {!!activePlans.length && <label>{planLabel}<select name="planId" value={planId} onChange={event => setPlanId(event.target.value)} required>
          <option value="" disabled>Chọn gói</option>
          {activePlans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {planUnits(plan)} · {planPrice(plan)}</option>)}
        </select></label>}
        {price > 0 && <><p>Phải thu <strong>{currency.format(price)}</strong></p><ServicePaymentField/></>}
      </>}
      {member && <label className="check"><input name="active" type="checkbox" defaultChecked={member.active}/> Cho phép check-in</label>}
      <button className="button" disabled={action.pending || (!member && !selectedPlan)}>{member ? 'Lưu hồ sơ' :
        price > 0 ? 'Xác nhận đã thu và thêm hội viên' : 'Thêm hội viên'}</button>
    </form>{action.feedback}
  </>;
  return member ? <Panel title={member.name} action={<button type="button" className="plain" onClick={close}>Đóng hồ sơ</button>}>{content}</Panel> :
    <BusinessDialog title="Thêm hội viên" close={close} pending={action.pending}>{content}</BusinessDialog>;
}

function MemberPhotoField({ member }: { member?: Member }) {
  const [file, setFile] = useState<File>();
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const version = member?.photo?.version;
  useEffect(() => {
    if (!file) { setImage(''); return; }
    const url = URL.createObjectURL(file);
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <>
    {image && <img className="member-photo" src={image} alt="Ảnh hội viên"/>}
    {!image && member && version && <MemberPhoto memberId={member.id} version={version} large/>}
    <label>{version ? 'Đổi ảnh hội viên' : 'Ảnh hội viên'}
      <input name="image" type="file" accept="image/jpeg,image/png,image/webp" required={!member} onChange={event => {
        const input = event.currentTarget;
        const selected = input.files?.[0];
        const message = selected && selected.size > 4 * 1024 * 1024 ? 'Tệp ảnh vượt quá 4 MB.' :
          selected && !selected.size ? 'Tệp ảnh trống.' : '';
        input.setCustomValidity(message);
        setError(message);
        setFile(message ? undefined : selected);
      }}/>
      <small>JPG, PNG hoặc WebP, tối đa 4 MB.</small>
    </label>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}

function MemberEnrollment({ member }: { member: Member }) {
  const { role } = useBusiness();
  const plans = useData<Plan[]>('/member-plans');
  const action = useAction();
  const activePlans = plans.data?.filter(plan => plan.active) ?? [];
  const [planId, setPlanId] = useState(member.enrollment?.planId ?? '');
  const selectedPlan = activePlans.find(plan => plan.id === planId);
  const price = selectedPlan?.price ?? 0;
  const frozen = !!member.freeze && member.freeze.resumesOn > vietnamLocalTime().slice(0, 10);
  return <Panel title="Gán hoặc gia hạn gói">
    {member.enrollment && <CurrentMemberPayment memberId={member.id} enrollment={member.enrollment} assigning={action.pending}/>}
    <State query={plans}/>
    {plans.isSuccess && !activePlans.length && <p>Chưa có gói đang hoạt động tại chi nhánh. {role === 'OWNER' &&
      <Link href="/dashboard/company?tab=member-plans">Tạo gói trong Quản lý doanh nghiệp</Link>}</p>}
    {frozen && <p className="muted">Kết thúc bảo lưu để đổi hoặc gia hạn gói.</p>}
    {!frozen && !!activePlans.length && <form key={member.id} onSubmit={event => submit(event, (form, element) => {
      if (!selectedPlan) return;
      void action.send(`/members/${member.id}/plan`, { planId, payment: planPayment(price, form) }, { idempotent: true, reset: element,
        message: price > 0 ? `Đã cập nhật gói và ghi nhận ${currency.format(price)}.` : 'Đã cập nhật gói hội viên.' })
        .then(result => { if (!result) void plans.refetch(); });
    })}>
      <label>Gói hội viên<select name="plan" value={selectedPlan?.id ?? ''} onChange={event => setPlanId(event.target.value)} required>
        <option value="">Chọn gói</option>
        {activePlans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {planUnits(plan)} · {planPrice(plan)}</option>)}
      </select></label>
      <small>Cùng gói sẽ nối hạn hoặc cộng lượt. Đổi gói sẽ thay gói hiện tại.</small>
      {price > 0 && <><p>Phải thu <strong>{currency.format(price)}</strong></p><ServicePaymentField/></>}
      <button className="button" disabled={action.pending || !selectedPlan}>{price > 0 ?
        'Xác nhận đã thu và cập nhật gói' : 'Gán / Gia hạn'}</button>
    </form>}{action.feedback}
  </Panel>;
}

function CurrentMemberPayment({ memberId, enrollment, assigning }: { memberId: string; enrollment: Enrollment; assigning: boolean }) {
  const action = useAction();
  const amount = enrollment.price;
  if (typeof amount !== 'number') return null;
  if (!amount) return <p>Gói hiện tại miễn phí.</p>;
  if (enrollment.paymentId) return <p className="success">Đã ghi nhận {currency.format(amount)} cho gói hiện tại.</p>;
  const now = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
  return <details className="business-details" key={enrollment.chargeId ?? enrollment.planId}>
    <summary>Ghi nhận tiền đã thu cho gói hiện tại</summary>
    <p>{enrollment.planName} · <strong>{currency.format(amount)}</strong></p>
    <p className="muted">Dùng cho khoản đã nhận và chưa có trong Sổ quỹ. Ghi đúng thời điểm nhận tiền để tính vào kỳ báo cáo tương ứng.</p>
    <form onSubmit={event => submit(event, form => {
      const paidAt = new Date(`${value(form, 'paidAt')}+07:00`);
      if (!Number.isFinite(paidAt.getTime())) return;
      void action.send(`/members/${memberId}/plan-payment`, { chargeId: enrollment.chargeId ?? null, expectedAmount: amount,
        method: value(form, 'paymentMethod'), paidAt: paidAt.toISOString() }, { idempotent: true });
    })}>
      <label>Thời điểm đã thu (giờ Việt Nam)<input type="datetime-local" name="paidAt" max={now} defaultValue={now} required/></label>
      <ServicePaymentField/>
      <button className="button" disabled={action.pending || assigning}>Xác nhận đã thu</button>
    </form>
    {action.feedback}
  </details>;
}

function MemberCredentials({ memberId }: { memberId: string }) {
  const codes = useData<{ method: CredentialMethod; code: string }[]>(`/members/${memberId}/credentials`);
  const action = useAction();
  return <Panel title="Liên kết thẻ và máy nhận diện">
    <State query={codes}/>
    {codes.isSuccess && (Object.entries(credentials) as [CredentialMethod, string][]).map(([method, name]) => {
      const stored = codes.data.find(item => item.method === method)?.code;
      return <form key={`${memberId}:${method}:${stored}`} className="member-credential" onSubmit={event => submit(event, form => {
        void action.send(`/members/${memberId}/credentials`, { method, code: value(form, 'code') },
          { method: 'PATCH', message: 'Đã lưu liên kết.' });
      })}>
        <label>{name}<input name="code" defaultValue={stored} maxLength={80} required autoComplete="off" spellCheck={false}
          placeholder={method === 'CARD' ? 'Quét thẻ hoặc nhập mã tự đặt' : 'Mã hồ sơ trên máy nhận diện'}/></label>
        <div className="actions"><button className="button" disabled={action.pending}>Liên kết</button>
          {stored && <button className="plain" type="button" disabled={action.pending} onClick={() => void action.send(
            `/members/${memberId}/credentials`, { method, code: null }, { method: 'PATCH', message: 'Đã gỡ liên kết.' })}>Gỡ</button>}</div>
      </form>;
    })}{action.feedback}
  </Panel>;
}

export function MemberVisits() {
  const [page, setPage] = useState(1);
  const [details, setDetails] = useState<Visit>();
  const visits = useData<Visit[]>(`/member-visits?page=${page}`, 5000);
  return <Panel title="Lịch sử check-in">
    <State query={visits} empty={visits.data?.length === 0}/><MemberVisitRows visits={visits.data ?? []} onDetails={setDetails}/>
    <Pager page={page} full={visits.data?.length === 50} onChange={setPage}/>
    {details && <MemberVisitDetails visit={details} close={() => setDetails(undefined)}/>}
  </Panel>;
}
