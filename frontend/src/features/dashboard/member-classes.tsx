'use client';

import { useLanguage } from '@/i18n/language';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, date, submit, value, vietnamDateTimeInput, vietnamLocalTime } from '@/lib/format';
import type { MemberList } from './members';

type Seat = { id: string; memberId: string; memberName: string; status: 'BOOKED' | 'WAITING'; attendedAt?: string };
type MemberClass = { id: string; name: string; instructor?: string; instructorId?: string; startsAt: string; endsAt: string;
  capacity: number; seats: Seat[]; canceledAt?: string };
type Coach = { id: string; name: string; specialty?: string };
const canManageClasses = (role: string) => role === 'OWNER' || role === 'MANAGER';

export function MemberClasses() {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const [day, setDay] = useState(() => vietnamLocalTime().slice(0, 10));
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>();
  const query = useData<MemberClass[]>(`/member-classes?day=${day}&page=${page}`, 8000);
  const selectedClass = query.data?.find(item => item.id === selected);
  return <Panel title={t("Lịch lớp trong 14 ngày")} action={canManageClasses(role) &&
    <button type="button" className="button" onClick={() => setCreating(true)}><Plus size={17}/> {t("Thêm lớp")}</button>}>
    <label>{t("Xem từ ngày")}<input type="date" value={day} onChange={event => {
      if (event.target.value) { setDay(event.target.value); setPage(1); }
    }}/></label>
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => {
      const booked = item.seats.filter(seat => seat.status === 'BOOKED').length;
      const attended = item.seats.filter(seat => !!seat.attendedAt).length;
      const started = Date.parse(item.startsAt) <= Date.now();
      return <div className="list-row service-list-row" key={item.id}>
        <div><strong>{item.name}</strong><small>{date(item.startsAt)} – {date(item.endsAt)}</small>
          <small>{item.instructor && `${item.instructor} · `}{item.canceledAt ? t("Đã hủy") :
            `${booked}/${item.capacity} chỗ · ${started ? `${attended} có mặt` : `${item.seats.length - booked} người chờ`}`}</small></div>
        <button className="plain" type="button" onClick={() => setSelected(item.id)}>{t("Xem danh sách")}</button>
      </div>;
    })}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    {creating && <CreateClass close={() => setCreating(false)} saved={item => {
      setDay(vietnamLocalTime(item.startsAt).slice(0, 10)); setPage(1); setCreating(false);
    }}/>}
    {selectedClass && <ClassRoster item={selectedClass} close={() => setSelected(undefined)}/>}
  </Panel>;
}

function CreateClass({ close, saved }: { close: () => void; saved: (item: MemberClass) => void }) {
  const { t } = useLanguage();
  const action = useAction();
  return <BusinessDialog title={t("Thêm lớp")} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      void action.send<MemberClass>('/member-classes', {
        name: value(form, 'name'), instructor: value(form, 'instructor') || undefined, instructorId: value(form, 'instructorId') || undefined,
        capacity: amount(form, 'capacity'),
        startsAt: vietnamDateTimeInput(value(form, 'startsAt')), endsAt: vietnamDateTimeInput(value(form, 'endsAt')),
      }, { idempotent: true }).then(result => { if (result) saved(result); });
    })}>
      <label>{t("Tên lớp")}<input name="name" maxLength={120} required/></label>
      <div className="columns"><CoachField/>
        <label>{t("Số chỗ")}<input type="number" name="capacity" min={1} max={100} defaultValue={10} required/></label></div>
      <label>{t("Tên người hướng dẫn khách mời")}<input name="instructor" maxLength={120} placeholder={t("Dùng cho lớp chưa chọn huấn luyện viên")}/></label>
      <div className="columns"><label>{t("Bắt đầu (giờ Việt Nam)")}<input type="datetime-local" name="startsAt" required/></label>
        <label>{t("Kết thúc (giờ Việt Nam)")}<input type="datetime-local" name="endsAt" required/></label></div>
      <button type="submit" className="button" disabled={action.pending}>{t("Lưu lớp")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function CoachField({ item }: { item?: MemberClass }) {
  const { t } = useLanguage();
  const coaches = useData<Coach[]>('/member-class-coaches');
  const options = coaches.data ?? [];
  return <div>
    <label>{t("Huấn luyện viên")}<select key={item?.instructorId ?? 'unassigned'} name="instructorId" defaultValue={item?.instructorId ?? ''}
      disabled={coaches.isLoading || !!coaches.error}>
      <option value="">{t("Chưa phân công")}</option>
      {item?.instructorId && !options.some(coach => coach.id === item.instructorId) && <option value={item.instructorId}>{item.instructor}</option>}
      {options.map(coach => <option key={coach.id} value={coach.id}>{coach.name}{coach.specialty && ` · ${coach.specialty}`}</option>)}
    </select></label>
    <State query={coaches}/>
  </div>;
}

function ClassRoster({ item, close }: { item: MemberClass; close: () => void }) {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const action = useAction();
  const [search, setSearch] = useState('');
  const [memberId, setMemberId] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState('');
  const open = !item.canceledAt && Date.parse(item.startsAt) > Date.now();
  const members = useData<MemberList>(`/members?q=${encodeURIComponent(search)}`, undefined, open && !!search.trim());
  const options = members.data?.members ?? [];
  return <BusinessDialog title={item.name} close={close} pending={action.pending}>
    <p>{item.canceledAt ? t("Lớp đã hủy") : date(item.startsAt)}</p>
    {item.instructor && <p>{t("Huấn luyện viên ·")} {item.instructor}</p>}
    {open && canManageClasses(role) && <details className="business-details">
      <summary>{t("Phân công huấn luyện viên")}</summary>
      <form onSubmit={event => submit(event, form => {
        if (!form.has('instructorId')) return;
        setNotice('');
        void action.send(`/member-classes/${item.id}/instructor`, { instructorId: value(form, 'instructorId') || null },
          { method: 'PATCH', message: 'Đã lưu phân công.' });
      })}>
        <CoachField item={item}/>
        <button type="submit" className="plain" disabled={action.pending}>{t("Lưu phân công")}</button>
      </form>
    </details>}
    {open && <form onSubmit={event => submit(event, () => {
      if (!memberId) return;
      setNotice('');
      void action.send<{ status: Seat['status'] }>(`/member-classes/${item.id}/seats`, { memberId }).then(result => {
        if (result) {
          setSearch(''); setMemberId('');
          setNotice(result.status === 'BOOKED' ? 'Đã giữ chỗ.' : 'Lớp đã đủ chỗ. Hội viên đã vào danh sách chờ.');
        }
      });
    })}>
      <label>{t("Tìm hội viên")}<input type="search" placeholder={t("Tên, mã hoặc số điện thoại")} maxLength={120} value={search}
        onChange={event => { setSearch(event.target.value); setMemberId(''); }}/></label>
      {!!search.trim() && <><State query={members} empty={members.data?.members.length === 0}/>
        {!!options.length && <label>{t("Hội viên")}<select value={memberId} required onChange={event => setMemberId(event.target.value)}>
          <option value="">{t("Chọn hội viên")}</option>{options.map(member => <option key={member.id} value={member.id}>
            {member.name} · {member.code}
          </option>)}
        </select></label>}</>}
      <button type="submit" className="button" disabled={!memberId || action.pending}>{t("Đăng ký lớp")}</button>
    </form>}
    {notice && <p className="success" role="status">{notice}</p>}
    {item.seats.length === 0 && <p className="muted">{t("Chưa có hội viên đăng ký.")}</p>}
    {item.seats.map(seat => <div className="list-row" key={seat.id}>
      <div><strong>{seat.memberName}</strong><small>{seat.attendedAt ? `Có mặt · ${date(seat.attendedAt)}` :
        seat.status === 'BOOKED' ? t("Đã giữ chỗ") : t("Đang chờ")}</small></div>
      {open && <button type="button" className="plain" disabled={action.pending} onClick={() => {
        setNotice('');
        void action.send<{ promoted?: string }>(`/member-classes/${item.id}/seats/${seat.memberId}`, undefined,
          { method: 'DELETE' }).then(result => { if (result) setNotice(result.promoted ?
            `Đã bỏ chỗ. ${result.promoted} được chuyển từ danh sách chờ.` : 'Đã bỏ chỗ.'); });
      }}>{t("Bỏ chỗ")}</button>}
      {!open && !item.canceledAt && seat.status === 'BOOKED' && <button type="button" className="plain" disabled={action.pending}
        onClick={() => {
          setNotice('');
          void action.send(`/member-classes/${item.id}/seats/${seat.memberId}/attendance`, { attended: !seat.attendedAt },
            { method: 'PATCH', message: seat.attendedAt ? 'Đã bỏ điểm danh.' : 'Đã điểm danh.' });
        }}>{seat.attendedAt ? t("Bỏ điểm danh") : t("Điểm danh")}</button>}
    </div>)}
    {open && canManageClasses(role) && <div className="actions">
      <button type="button" className="plain" disabled={action.pending} onClick={() => setConfirmCancel(!confirmCancel)}>
        {confirmCancel ? t("Giữ lớp") : t("Hủy lớp")}
      </button>
      {confirmCancel && <button type="button" className="button" disabled={action.pending} onClick={() => {
        setNotice('');
        void action.send(`/member-classes/${item.id}/cancel`, undefined, { message: 'Đã hủy lớp.' });
      }}>{t("Xác nhận hủy lớp")}</button>}
    </div>}
    {action.feedback}
  </BusinessDialog>;
}
