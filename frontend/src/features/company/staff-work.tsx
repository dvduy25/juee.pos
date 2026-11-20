'use client';

import Link from 'next/link';
import { Clock3, Plus } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { date, submit, value, vietnamDateTimeInput, vietnamLocalTime } from '@/lib/format';
import { usesMemberships } from '@/types/business';
import { employeeName, StaffDirectory, type Employee } from './staff';
import { StaffPayroll } from './payroll';
import { StaffDevices, staffClockLabels, type DeviceMethod } from './staff-devices';
import { StaffCalendar, type CalendarCounts } from './staff-calendar';

const dayMs = 86_400_000;
const vietnamDay = (now = Date.now()) => vietnamLocalTime(now).slice(0, 10);
type Schedule = { id: string; membershipId: string; staffName: string; title: string; note?: string;
  startsAt: string; endsAt: string; canceledAt?: string; hasAttendance?: boolean;
  state: 'PLANNED' | 'WORKING' | 'ATTENDED' | 'LEAVE' | 'ABSENT' | 'CANCELED'; leaveReason?: string;
  attendance?: { firstIn: string; lastOut?: string; open: number };
  kind?: 'FIXED' | 'FLEXIBLE'; seriesId?: string; createdCount?: number; updatedCount?: number };
type Attendance = { id: string; branchId: string; staffName: string; status: 'OPEN' | 'CLOSED';
  checkInMethod?: DeviceMethod | 'MANUAL'; checkOutMethod?: DeviceMethod | 'MANUAL';
  scheduleTitle?: string; scheduledStartsAt?: string; scheduledEndsAt?: string; checkedInAt: string; checkedOutAt?: string; closeReason?: string };

export function StaffWorkspace({ management = false }: { management?: boolean }) {
  const { branch } = useBusiness();
  const [current, setCurrent] = useState(management ? 'directory' : 'attendance');
  const items = [
    ...(management ? [{ id: 'directory', label: 'Hồ sơ nhân viên' },
      ...(usesMemberships(branch.mode) ? [{ id: 'coaches', label: 'Huấn luyện viên' }] : [])] : []),
    { id: 'schedule', label: management ? 'Lịch ca' : 'Ca của tôi' }, { id: 'attendance', label: 'Chấm công' },
    ...(management ? [{ id: 'devices', label: 'Máy chấm công' }, { id: 'payroll', label: 'Lương' }] : []),
  ];
  return <div className="service-workspace">
    <div className="business-settings-tabs" role="group" aria-label="Nhân viên và quản lý">
      {items.map(item => <button key={item.id} type="button" className="plain" aria-pressed={item.id === current}
        onClick={() => setCurrent(item.id)}>{item.label}</button>)}
    </div>
    {current === 'directory' && <StaffDirectory/>}
    {current === 'coaches' && <>
      <Link href="/dashboard/member-classes" className="plain">Phân công tại lịch lớp</Link>
      <StaffDirectory coaches/>
    </>}
    {current === 'schedule' && <StaffSchedule management={management}/>}
    {current === 'attendance' && <><PersonalClock/><AttendanceHistory management={management}/></>}
    {current === 'devices' && <StaffDevices/>}
    {current === 'payroll' && <StaffPayroll/>}
  </div>;
}

function WeekSelector({ day, change }: { day: string; change: (day: string) => void }) {
  const jump = (offset: number) => change(new Date(Date.parse(day) + offset * dayMs).toISOString().slice(0, 10));
  return <div className="actions business-filters staff-week">
    <button type="button" className="plain" onClick={() => jump(-7)}>7 ngày trước</button>
    <label>Xem từ ngày<input type="date" value={day} onChange={event => { if (event.target.value) change(event.target.value); }}/></label>
    <button type="button" className="plain" onClick={() => jump(7)}>7 ngày sau</button>
  </div>;
}

function StaffSchedule({ management }: { management: boolean }) {
  const { branch } = useBusiness();
  const [day, setDay] = useState(() => vietnamDay());
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Schedule | 'new'>();
  const [cancel, setCancel] = useState<Schedule>();
  const [leave, setLeave] = useState<Schedule>();
  const [exchange, setExchange] = useState<Schedule>();
  const [notice, setNotice] = useState('');
  const view = management ? 'branch' : 'mine';
  const calendar = useData<CalendarCounts>(`/staff-calendar?month=${day.slice(0, 7)}&view=${view}`, 15000);
  const query = useData<Schedule[]>(`/staff-schedules?day=${day}&view=${view}&singleDay=true&page=${page}`, 12000);
  return <Panel title={`Lịch ca · ${branch.name}`} action={management && <button type="button" className="button" onClick={() => setEditor('new')}>
    <Plus size={17}/> Xếp ca
  </button>}>
    <StaffCalendar day={day} today={vietnamDay()} counts={calendar.data} change={next => { setDay(next); setPage(1); }}/>
    <State query={calendar}/>
    <h3>Ca làm ngày {day.split('-').reverse().join('/')}</h3>
    {notice && <p className="success" role="status">{notice}</p>}
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => <div className="list-row service-list-row" key={item.id}>
      <div><strong>{item.title}</strong>{management && <small>{item.staffName}</small>}
        <small>{date(item.startsAt)} – {date(item.endsAt)}</small>
        <small>{item.kind === 'FLEXIBLE' ? 'Ca linh động' : 'Ca cố định'}</small>
        {item.attendance && <small>Vào {date(item.attendance.firstIn)}
          {item.attendance.lastOut && !item.attendance.open ? ` · Ra ${date(item.attendance.lastOut)}` : ''}</small>}
        {item.leaveReason && <small>Lý do nghỉ: {item.leaveReason}</small>}
        {item.note && <small>{item.note}</small>}</div>
      <div className="actions">
        <span className={`badge${item.state === 'LEAVE' || item.state === 'ABSENT' ? ' warning' : ''}`}>{shiftStates[item.state]}</span>
        {management && !item.canceledAt && !item.hasAttendance && <button type="button" className="plain" onClick={() => setLeave(item)}>
          {item.state === 'LEAVE' ? 'Bỏ nghỉ' : 'Ghi nghỉ'}
        </button>}
        {management && canExchangeShift(item) && <>
          <button type="button" className="plain" onClick={() => setEditor(item)}>Sửa ca</button>
          <button type="button" className="plain" onClick={() => setExchange(item)}>Đổi ca</button>
          <button type="button" className="plain member-delete" onClick={() => setCancel(item)}>Hủy ca</button>
        </>}
      </div>
    </div>)}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    <UnscheduledAttendance key={day} day={day} view={view}/>
    {editor && <ScheduleEditor item={editor === 'new' ? undefined : editor} day={day} close={() => setEditor(undefined)} saved={next => {
      setNotice(next.createdCount && next.createdCount > 1 ? `Đã xếp ${next.createdCount} ca.` :
        next.updatedCount && next.updatedCount > 1 ? `Đã cập nhật ${next.updatedCount} ca.` : 'Đã lưu ca làm.');
      setDay(vietnamLocalTime(next.startsAt).slice(0, 10)); setPage(1); setEditor(undefined);
    }}/>}
    {cancel && <CancelSchedule item={cancel} close={() => setCancel(undefined)}/>}
    {leave && <LeaveSchedule item={leave} close={() => setLeave(undefined)}/>}
    {exchange && <ExchangeSchedule item={exchange} close={() => setExchange(undefined)} saved={() => {
      setExchange(undefined); setNotice('Đã cập nhật người làm ca.');
    }}/>}
  </Panel>;
}

const shiftStates: Record<Schedule['state'], string> = {
  PLANNED: 'Đã xếp', WORKING: 'Đang làm', ATTENDED: 'Đã chấm công', LEAVE: 'Nghỉ làm', ABSENT: 'Vắng mặt', CANCELED: 'Đã hủy',
};

function canExchangeShift(item: Schedule) {
  return !item.canceledAt && !item.hasAttendance && item.state !== 'LEAVE' && Date.parse(item.endsAt) > Date.now();
}

function ExchangeSchedule({ item, close, saved }: { item: Schedule; close: () => void; saved: () => void }) {
  const { branch } = useBusiness();
  const action = useAction();
  const [swap, setSwap] = useState(true);
  const [day, setDay] = useState(() => vietnamLocalTime(item.startsAt).slice(0, 10));
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState('');
  const staff = useData<Employee[]>(`/staff?branch=${branch.id}&status=active&page=${page}&q=${encodeURIComponent(search)}`, undefined, !swap);
  const shifts = useData<Schedule[]>(`/staff-schedules?day=${day}&view=branch&singleDay=true&page=${page}`, undefined, swap && !!day);
  const query = swap ? shifts : staff;
  const options = swap ? (shifts.data ?? []).filter(shift => shift.membershipId !== item.membershipId && canExchangeShift(shift))
    .map(shift => ({ id: shift.id, membershipId: shift.membershipId, label: `${shift.staffName} · ${shift.title} · ${date(shift.startsAt)} – ${date(shift.endsAt)}` })) :
    (staff.data ?? []).filter(employee => employee.id !== item.membershipId)
      .map(employee => ({ id: employee.id, membershipId: employee.id, label: employeeName(employee) }));
  const selected = options.find(option => option.id === selectedId);
  return <BusinessDialog title="Đổi ca" close={close} pending={action.pending}>
    <p><strong>{item.staffName}</strong> · {item.title} · {date(item.startsAt)} – {date(item.endsAt)}</p>
    <form onSubmit={event => submit(event, () => {
      if (!selected) return;
      void action.send(`/staff-schedules/${item.id}/exchange`, {
        expectedMembershipId: item.membershipId,
        ...(swap ? { otherScheduleId: selected.id, otherMembershipId: selected.membershipId } : { membershipId: selected.membershipId }),
      }, { method: 'PATCH' }).then(result => { if (result) saved(); });
    })}>
      <label>Hình thức<select value={swap ? 'swap' : 'replace'} onChange={event => {
        setSwap(event.target.value === 'swap'); setSelectedId(''); setPage(1);
      }}><option value="swap">Hoán đổi hai ca</option><option value="replace">Chọn người làm thay</option></select></label>
      {swap ? <label>Ngày của ca muốn đổi<input type="date" value={day} required onChange={event => {
        setDay(event.target.value); setSelectedId(''); setPage(1);
      }}/></label> : <label>Tìm nhân viên<input type="search" value={search} maxLength={120} onChange={event => {
        setSearch(event.target.value); setSelectedId(''); setPage(1);
      }}/></label>}
      <State query={query} empty={query.isSuccess && !options.length}/>
      <label>{swap ? 'Ca muốn đổi' : 'Người làm thay'}<select value={selected?.id ?? ''} required onChange={event => setSelectedId(event.target.value)}>
        <option value="">{swap ? 'Chọn ca của nhân viên khác' : 'Chọn nhân viên'}</option>
        {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
      {(page > 1 || query.data?.length === 50) && <Pager page={page} full={query.data?.length === 50} onChange={next => {
        setPage(next); setSelectedId('');
      }}/>}
      <button type="submit" className="button" disabled={action.pending || !selected}>{swap ? 'Xác nhận đổi ca' : 'Xác nhận người làm thay'}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function UnscheduledAttendance({ day, view }: { day: string; view: string }) {
  const [page, setPage] = useState(1);
  const query = useData<Attendance[]>(`/staff-attendance?day=${day}&view=${view}&unscheduled=true&page=${page}`, 12000);
  return <>
    <State query={query}/>
    {!!query.data?.length && <>
      <h3>Chấm công ngoài lịch ca</h3>
      {query.data.map(item => <div className="list-row" key={item.id}>
        <div><strong>{item.staffName}</strong><small>Vào {date(item.checkedInAt)}
          {item.checkedOutAt && ` · Ra ${date(item.checkedOutAt)}`}</small></div>
        <span className="badge">{item.status === 'OPEN' ? 'Đang làm' : 'Đã chấm công'}</span>
      </div>)}
    </>}
    {(page > 1 || query.data?.length === 50) && <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>}
  </>;
}

function LeaveSchedule({ item, close }: { item: Schedule; close: () => void }) {
  const action = useAction();
  const clearing = item.state === 'LEAVE';
  return <BusinessDialog title={clearing ? 'Bỏ trạng thái nghỉ làm' : 'Ghi nghỉ làm'} close={close} pending={action.pending}>
    <p><strong>{item.staffName}</strong> · {item.title} · {date(item.startsAt)}</p>
    <form onSubmit={event => submit(event, form => void action.send(`/staff-schedules/${item.id}/leave`,
      { reason: clearing ? null : value(form, 'reason') }, { method: 'PATCH' }).then(result => { if (result) close(); }))}>
      {!clearing && <label>Lý do nghỉ<input name="reason" maxLength={120} required/></label>}
      <button type="submit" className="button" disabled={action.pending}>{clearing ? 'Xác nhận bỏ nghỉ' : 'Lưu nghỉ làm'}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function ScheduleEditor({ item, day, close, saved }: { item?: Schedule; day: string; close: () => void; saved: (item: Schedule) => void }) {
  const { branch } = useBusiness();
  const action = useAction();
  const [search, setSearch] = useState('');
  const [member, setMember] = useState(item?.membershipId ?? '');
  const [kind, setKind] = useState<NonNullable<Schedule['kind']>>(item?.kind ?? 'FIXED');
  const today = vietnamDay();
  const start = item && vietnamLocalTime(item.startsAt);
  const end = item && vietnamLocalTime(item.endsAt);
  const selectedDay = start?.slice(0, 10) ?? day;
  const [firstDay, setFirstDay] = useState(selectedDay < today ? today : selectedDay);
  const [lastDay, setLastDay] = useState(firstDay);
  const fixedRange = kind === 'FIXED' && !item;
  const fixedSeries = kind === 'FIXED' && !!item?.seriesId;
  const employees = useData<Employee[]>(`/staff?branch=${branch.id}&status=active&q=${encodeURIComponent(search)}`, undefined, !fixedSeries);
  const options = employees.data ?? [];
  return <BusinessDialog title={item ? 'Sửa ca làm' : 'Xếp ca làm'} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      if (!member) return;
      const startDay = fixedRange ? firstDay : selectedDay;
      const endDay = form.has('overnight') ? new Date(Date.parse(startDay) + dayMs).toISOString().slice(0, 10) : startDay;
      void action.send<Schedule>(item ? `/staff-schedules/${item.id}` : '/staff-schedules', {
        membershipId: member, title: value(form, 'title'), note: value(form, 'note'),
        startsAt: vietnamDateTimeInput(`${startDay}T${value(form, 'startsAt')}`),
        endsAt: vietnamDateTimeInput(`${endDay}T${value(form, 'endsAt')}`), kind,
        ...(fixedRange && { throughDate: lastDay }), ...(fixedSeries && { applyFollowing: true }),
      }, { method: item ? 'PATCH' : 'POST' }).then(result => { if (result) saved(result); });
    })}>
      {fixedSeries ? <p>Nhân viên <strong>{item?.staffName}</strong></p> : <>
        <label>Tìm nhân viên<input type="search" maxLength={120} value={search} placeholder="Tìm theo tên hoặc email"
        onChange={event => setSearch(event.target.value)}/></label>
        <State query={employees} empty={employees.isSuccess && !options.length}/>
        <label>Nhân viên<select value={member} onChange={event => setMember(event.target.value)} required>
          <option value="">Chọn nhân viên</option>
          {member && !options.some(option => option.id === member) && <option value={member}>{item?.membershipId === member ? item.staffName : 'Nhân viên đã chọn'}</option>}
          {options.map(option => <option key={option.id} value={option.id}>{employeeName(option)}{option.position && ` · ${option.position}`}</option>)}
        </select></label>
      </>}
      <label>Tên ca<input name="title" maxLength={120} required defaultValue={item?.title} placeholder="Ví dụ: Ca sáng"/></label>
      <label>Kiểu ca<select value={kind} disabled={!!item} onChange={event => setKind(event.target.value as NonNullable<Schedule['kind']>)}>
        <option value="FIXED">Ca cố định</option><option value="FLEXIBLE">Ca linh động</option>
      </select></label>
      {fixedRange ? <>
        <div className="columns">
          <label>Từ ngày<input type="date" value={firstDay} min={today} required onChange={event => {
            const next = event.target.value;
            setFirstDay(next);
            if (!lastDay || lastDay < next) setLastDay(next);
          }}/></label>
          <label>Đến ngày<input type="date" value={lastDay} min={firstDay} required onChange={event => setLastDay(event.target.value)}/></label>
        </div>
        <small>Áp dụng cùng khung giờ mỗi ngày trong khoảng đã chọn.</small>
      </> : <>
        <p>Ngày làm việc <strong>{selectedDay.split('-').reverse().join('/')}</strong></p>
        {fixedSeries && <small>Áp dụng từ ngày này cho các ca sau trong cùng lịch chưa chấm công.</small>}
      </>}
      <div className="columns">
        <label>Giờ bắt đầu<input type="time" name="startsAt" defaultValue={start?.slice(11, 16) ?? '08:00'} required/></label>
        <label>Giờ kết thúc<input type="time" name="endsAt" defaultValue={end?.slice(11, 16) ?? '12:00'} required/></label>
      </div>
      <label className="check"><input type="checkbox" name="overnight" defaultChecked={!!end && end.slice(0, 10) !== selectedDay}/>
        Kết thúc vào ngày hôm sau</label>
      <label>Ghi chú<textarea name="note" maxLength={500} defaultValue={item?.note}/></label>
      <button type="submit" className="button" disabled={action.pending || !member}>Lưu ca làm</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function CancelSchedule({ item, close }: { item: Schedule; close: () => void }) {
  const action = useAction();
  const [series, setSeries] = useState(false);
  return <BusinessDialog title="Hủy ca làm" close={close} pending={action.pending}>
    <p>Hủy ca <strong>{item.title}</strong> của {item.staffName}, bắt đầu lúc {date(item.startsAt)}?</p>
    {item.seriesId && <label className="check"><input type="checkbox" checked={series} onChange={event => setSeries(event.target.checked)}/>
      Hủy cả các ca sau chưa có chấm công trong lịch lặp này</label>}
    <button type="button" className="button" disabled={action.pending} onClick={() =>
      void action.send(`/staff-schedules/${item.id}${series ? '?series=true' : ''}`, undefined, { method: 'DELETE' })
        .then(result => { if (result) close(); })}>Xác nhận hủy ca</button>
    {action.feedback}
  </BusinessDialog>;
}

function PersonalClock() {
  const { branch } = useBusiness();
  const clock = useData<{ open: Attendance | null; branchName?: string }>('/staff-clock', 10000);
  const action = useAction();
  const open = clock.data?.open;
  const otherBranch = open && open.branchId !== branch.id;
  return <Panel title="Chấm công của tôi">
    <State query={clock}/>
    {clock.data && <div className="list-row service-list-row">
      <div><strong>{open ? `Đang làm · ${clock.data.branchName ?? branch.name}` : branch.name}</strong>
        {open && <small>Vào lúc {date(open.checkedInAt)}{open.scheduleTitle && ` · ${open.scheduleTitle}`}</small>}
        {otherBranch && <small>Chọn chi nhánh đã check-in để check-out.</small>}</div>
      <button type="button" className="button" disabled={action.pending || !!otherBranch} onClick={() =>
        void action.send(open ? `/staff-clock/${open.id}/check-out` : '/staff-clock/check-in', undefined, {
          idempotent: true, message: open ? 'Đã check-out.' : 'Đã check-in.',
        })}><Clock3 size={17}/>{open ? 'Check-out' : 'Check-in'}</button>
    </div>}
    {action.feedback}
  </Panel>;
}

function AttendanceHistory({ management }: { management: boolean }) {
  const { branch } = useBusiness();
  const [day, setDay] = useState(() => vietnamDay(Date.now() - 6 * dayMs));
  const [page, setPage] = useState(1);
  const [closing, setClosing] = useState<Attendance>();
  const [checkingIn, setCheckingIn] = useState(false);
  const query = useData<Attendance[]>(`/staff-attendance?day=${day}&view=${management ? 'branch' : 'mine'}&page=${page}`, 10000);
  return <Panel title={management ? `Chấm công chi nhánh · ${branch.name}` : 'Lịch sử chấm công của tôi'} action={management &&
    <button type="button" className="button" onClick={() => setCheckingIn(true)}><Clock3 size={17}/> Check-in nhân viên</button>}>
    <WeekSelector day={day} change={next => { setDay(next); setPage(1); }}/>
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => {
      const minutes = item.checkedOutAt ? Math.max(0, Math.floor((Date.parse(item.checkedOutAt) - Date.parse(item.checkedInAt)) / 60000)) : null;
      return <div className="list-row service-list-row" key={item.id}>
        <div><strong>{item.staffName}</strong><small>{item.scheduleTitle ?? 'Ngoài lịch ca'}</small>
          <small>Vào {date(item.checkedInAt)} · {staffClockLabels[item.checkInMethod ?? 'MANUAL']}</small>
          {item.checkedOutAt && <small>Ra {date(item.checkedOutAt)} · {staffClockLabels[item.checkOutMethod ?? 'MANUAL']}</small>}
          {item.closeReason && <small>Lý do đóng hộ: {item.closeReason}</small>}
        </div>
        <div className="actions">
          <span className="badge">{minutes === null ? 'Đang làm' : `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`}</span>
          {management && item.status === 'OPEN' && <button type="button" className="plain" onClick={() => setClosing(item)}>Check-out</button>}
        </div>
      </div>;
    })}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    {checkingIn && <CheckInEmployee close={() => setCheckingIn(false)} saved={() => {
      setDay(vietnamDay(Date.now() - 6 * dayMs)); setPage(1); setCheckingIn(false);
    }}/>}
    {closing && <CloseAttendance item={closing} close={() => setClosing(undefined)}/>}
  </Panel>;
}

function CheckInEmployee({ close, saved }: { close: () => void; saved: () => void }) {
  const { branch } = useBusiness();
  const action = useAction();
  const [search, setSearch] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const employees = useData<Employee[]>(`/staff?branch=${branch.id}&status=active&q=${encodeURIComponent(search)}`);
  return <BusinessDialog title="Check-in nhân viên" close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, () => {
      if (!employeeId) return;
      void action.send('/staff-clock/check-in', { employeeId }, { idempotent: true }).then(result => { if (result) saved(); });
    })}>
      <label>Tìm nhân viên<input type="search" maxLength={120} value={search} onChange={event => {
        setSearch(event.target.value); setEmployeeId('');
      }}/></label>
      <State query={employees} empty={employees.data?.length === 0}/>
      <label>Nhân viên<select value={employeeId} onChange={event => setEmployeeId(event.target.value)} required>
        <option value="">Chọn nhân viên</option>{employees.data?.map(item => <option value={item.id} key={item.id}>{employeeName(item)}</option>)}
      </select></label>
      <button type="submit" className="button" disabled={!employeeId || action.pending}>Xác nhận check-in</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function CloseAttendance({ item, close }: { item: Attendance; close: () => void }) {
  const action = useAction();
  return <BusinessDialog title={`Check-out hộ · ${item.staffName}`} close={close} pending={action.pending}>
    <p>Giờ ra sẽ được ghi theo thời điểm xác nhận.</p>
    <form onSubmit={event => submit(event, form => {
      void action.send(`/staff-clock/${item.id}/check-out`, { reason: value(form, 'reason') }, { idempotent: true })
        .then(result => { if (result) close(); });
    })}>
      <label>Lý do<input name="reason" maxLength={120} required/></label>
      <button type="submit" className="button" disabled={action.pending}>Xác nhận check-out</button>
    </form>{action.feedback}
  </BusinessDialog>;
}
