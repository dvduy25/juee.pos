'use client';

import { useLanguage } from '@/i18n/language';
import Link from 'next/link';
import { ArrowRight, BedDouble, CalendarClock, CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Clock3, DoorOpen, LogIn, Plus, Printer, Search, Sparkles, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State, StatusFilters } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, date, printReceipt, submit, value, vietnamLocalTime } from '@/lib/format';
import { bookingBase, bookingStates, bookingTypes, bookingWindow, calendarDate, canCheckIn, dayMs, hotelDay, roomStates,
  type Booking, type Room } from '@/lib/hotel';
import { ReserveRoom, type ArrivalMode } from './hotel-reservation';
import { paymentMethodLabels, ServicePaymentField } from './service-payment';

const roomFilters = [
  { key: '', label: 'Tất cả' }, { key: 'ready', label: 'Sẵn sàng' }, { key: 'occupied', label: 'Đang có khách' },
  { key: 'overdue', label: 'Quá giờ' }, { key: 'reserved', label: 'Có đặt hôm nay' }, { key: 'cleaning', label: 'Chờ dọn' }, { key: 'maintenance', label: 'Bảo trì' },
];
const hotelViews = [
  { key: 'rooms', label: 'Sơ đồ phòng', icon: BedDouble },
  { key: 'bookings', label: 'Đặt phòng', icon: ClipboardList },
  { key: 'calendar', label: 'Lịch phòng', icon: CalendarDays },
] as const;
const managesHotel = (role: string) => role === 'OWNER' || role === 'MANAGER';
const upcomingDate = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
type FrontDesk = { arrivals: number; departures: number; occupied: number };
type Calendar = { rooms: Pick<Room, 'id' | 'code' | 'category' | 'state'>[];
  bookings: (Pick<Booking, 'id' | 'roomId' | 'guestName' | 'status' | 'startsOn' | 'endsOn' | 'startsAt' | 'endsAt' | 'overdue' | 'dueAt'> & { occupiedUntil: string })[] };

function bookingNotice(booking: Booking) {
  return `${booking.status === 'CHECKED_IN' ? 'Đã check-in' : 'Đã đặt trước'} phòng ${booking.roomCode} cho ${booking.guestName}.`;
}

function HotelDeskHeader({ view, create }: { view: typeof hotelViews[number]['key']; create: () => void }) {
  const { t } = useLanguage();
  const { branch } = useBusiness();
  return <header className="hotel-desk-header">
    <div className="hotel-desk-intro">
      <div>
        <p className="hotel-branch"><BedDouble size={16} aria-hidden="true"/> {branch.name}</p>
        <h1>{t("Quầy lễ tân")}</h1>
        <p className="hotel-desk-date">{upcomingDate.format(new Date())}</p>
      </div>
      <button type="button" className="button" onClick={create}><Plus size={18} aria-hidden="true"/> {t("Đăng ký lưu trú")}</button>
    </div>
    <nav className="hotel-desk-nav" aria-label={t("Quầy lễ tân")}>
      {hotelViews.map(({ key, label, icon: Icon }) => <Link key={key} href={`/dashboard/hotel-${key}`}
        aria-current={view === key ? 'page' : undefined}><Icon size={17} aria-hidden="true"/> {t(label)}</Link>)}
    </nav>
  </header>;
}

type ReservationStart = { roomId?: string; arrival?: ArrivalMode };

export function HotelRooms() {
  const { t } = useLanguage();
  const query = useData<Room[]>('/hotel-rooms', 8000);
  const [queue, setQueue] = useState<'TODAY' | 'DEPARTURES'>('TODAY');
  const tasks = useData<Booking[]>(`/hotel-bookings?status=${queue}`, 8000);
  const action = useAction();
  const [reservation, setReservation] = useState<ReservationStart>();
  const [folio, setFolio] = useState<string>();
  const [departing, setDeparting] = useState<DepartureBooking>();
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const rooms = (query.data ?? []).map(room => ({
    room,
    state: room.occupiedBy?.overdue ? 'overdue' : room.occupiedBy ? 'occupied' : room.state !== 'READY' ? room.state.toLowerCase() : room.expectedToday ? 'reserved' : 'ready',
  }));
  const term = search.trim().toLocaleLowerCase('vi-VN');
  const visible = rooms.filter(({ room, state }) => (!filter || state === filter) &&
    (!term || `${room.code} ${room.category} ${room.occupiedBy?.guestName ?? ''}`.toLocaleLowerCase('vi-VN').includes(term)));
  const counters = [
    { key: 'ready', title: 'Sẵn sàng', icon: DoorOpen, count: rooms.filter(({ state }) => state === 'ready').length },
    { key: 'occupied', title: 'Đang có khách', icon: UsersRound, count: rooms.filter(({ state }) => state === 'occupied').length },
    { key: 'overdue', title: 'Quá giờ trả phòng', icon: Clock3, count: rooms.filter(({ state }) => state === 'overdue').length },
    { key: 'cleaning', title: 'Chờ dọn', icon: Sparkles, count: rooms.filter(({ state }) => state === 'cleaning').length },
  ];
  function create(next: ReservationStart) {
    setNotice('');
    setReservation(next);
  }

  return <div className="hotel-desk">
    <HotelDeskHeader view="rooms" create={() => create({})}/>
    <div className="hotel-status-summary" aria-label={t("Tình trạng phòng")}>
      {counters.map(({ key, title, icon: Icon, count }) => <button type="button" key={key} data-state={key}
        aria-pressed={filter === key} onClick={() => setFilter(filter === key ? '' : key)}>
        <span className="hotel-state-icon"><Icon size={20} aria-hidden="true"/></span>
        <span><small>{t(title)}</small><strong>{query.data ? count : '—'}</strong></span>
      </button>)}
    </div>
    <div className="hotel-feedback">{action.feedback}{notice && <p className="success" role="status">{notice}</p>}</div>
    <div className="hotel-desk-columns">
      <section className="card hotel-board" aria-labelledby="hotel-board-title">
        <header className="hotel-panel-header">
          <h2 id="hotel-board-title">{t("Sơ đồ phòng")} <span>{query.data ? `${visible.length}/${rooms.length}` : ''}</span></h2>
          <label className="hotel-search"><span className="sr-only">{t("Tìm phòng")}</span><Search size={16} aria-hidden="true"/>
            <input type="search" placeholder={t("Tìm phòng hoặc tên khách")} maxLength={120} value={search}
              onChange={event => setSearch(event.target.value)}/></label>
        </header>
        {!!rooms.length && <StatusFilters label={t("Lọc theo trạng thái phòng")} value={filter} onChange={setFilter}
          items={roomFilters.map(item => ({ ...item, count: item.key ? rooms.filter(room => room.state === item.key).length : rooms.length }))}/>}
        <State query={query}/>
        {query.isSuccess && !rooms.length && <p className="hotel-empty">{t("Chi nhánh chưa có phòng.")}</p>}
        {!!rooms.length && !visible.length && <p className="hotel-empty">{t("Không tìm thấy phòng phù hợp.")}</p>}
        <div className="hotel-room-grid">
          {visible.map(({ room, state }) => {
            const guest = room.occupiedBy;
            return <article className="hotel-room-card" data-state={state} key={room.id} aria-label={t("Phòng {0}", room.code)}>
              <header className="hotel-room-header">
                <span className="hotel-state-icon"><BedDouble size={19} aria-hidden="true"/></span>
                <div><h3>{room.code}</h3><small>{room.category} · {room.capacity} {t("khách")}</small></div>
              </header>
              <div className="hotel-room-body">
                <span className="hotel-state-chip">{t(roomFilters.find(item => item.key === state)?.label)}</span>
                {guest ? <div className="hotel-room-detail"><strong>{guest.guestName}</strong>
                  <small>{guest.dueAt ? `${guest.overdue ? t('Quá hạn từ') : t('Trả dự kiến')} ${date(guest.dueAt)}` :
                    t(bookingTypes[guest.bookingType ?? 'NIGHTLY'])}</small>
                </div> : <div className="hotel-room-rates">
                  {room.hourlyRate != null && <span><strong>{currency.format(room.hourlyRate)}</strong><small>{t("Giờ đầu")}</small></span>}
                  {room.nightlyRate != null && <span><strong>{currency.format(room.nightlyRate)}</strong><small>{t("Mỗi đêm")}</small></span>}
                </div>}
              </div>
              {room.state !== 'MAINTENANCE' && <footer className="hotel-room-actions">
                {guest ? <>
                  <button className="button" type="button" onClick={() => setDeparting({ id: guest.id, guestName: guest.guestName, roomCode: room.code })}>{t("Trả phòng")}</button>
                  <button className="plain" type="button" onClick={() => setFolio(guest.id)}>{t("Tiền phòng")}</button>
                  <button className="plain" type="button" onClick={() => create({ roomId: room.id, arrival: 'ADVANCE' })}>{t("Đặt trước")}</button>
                </> : <>
                  {room.state === 'READY' && <button className="button" type="button" onClick={() => create({ roomId: room.id, arrival: 'NOW' })}>Check-in</button>}
                  {room.state === 'CLEANING' && <button className="button" type="button" disabled={action.pending}
                    onClick={() => { setNotice(''); void action.send(`/hotel-rooms/${room.id}/ready`, undefined,
                      { message: `Phòng ${room.code} đã sẵn sàng.` }); }}>{t("Dọn xong")}</button>}
                  <button className="plain" type="button" onClick={() => create({ roomId: room.id, arrival: 'ADVANCE' })}>{t("Đặt trước")}</button>
                </>}
              </footer>}
            </article>;
          })}
        </div>
      </section>
      <aside className="card hotel-queue" aria-labelledby="hotel-queue-title">
        <header className="hotel-panel-header"><h2 id="hotel-queue-title"><CalendarClock size={18} aria-hidden="true"/> {t("Công việc hôm nay")}</h2></header>
        <div className="hotel-queue-tabs" role="group" aria-label={t("Xem công việc")}>
          <button type="button" className="plain" aria-pressed={queue === 'TODAY'} onClick={() => setQueue('TODAY')}>{t("Khách đến")}</button>
          <button type="button" className="plain" aria-pressed={queue === 'DEPARTURES'} onClick={() => setQueue('DEPARTURES')}>{t("Quá giờ")}</button>
        </div>
        <State query={tasks}/>
        {tasks.isSuccess && !tasks.data.length && <p className="hotel-empty">{queue === 'TODAY' ? t("Chưa có khách chờ đến.") : t("Không có phòng quá giờ.")}</p>}
        <ul className="hotel-queue-list">
          {tasks.data?.slice(0, 6).map(booking => <li key={booking.id}>
            <span className="hotel-queue-room">{booking.roomCode}</span>
            <div><strong>{booking.guestName}</strong><small>{queue === 'DEPARTURES' && booking.dueAt ? `Hạn trả ${date(booking.dueAt)}` :
              booking.startsAt ? date(booking.startsAt) : calendarDate(booking.startsOn)}</small></div>
            {canCheckIn(booking) && <button type="button" className="plain" disabled={action.pending} aria-label={`Nhận phòng ${booking.roomCode} cho ${booking.guestName}`}
              onClick={() => { setNotice(''); void action.send(`/hotel-bookings/${booking.id}/arrive`, undefined, { message: `Đã nhận phòng ${booking.roomCode}.` }); }}>
              <LogIn size={17} aria-hidden="true"/></button>}
            {queue === 'DEPARTURES' && <button type="button" className="plain" aria-label={`Trả phòng ${booking.roomCode}`}
              onClick={() => setDeparting(booking)}><ArrowRight size={17} aria-hidden="true"/></button>}
          </li>)}
        </ul>
        <Link className="plain hotel-queue-link" href="/dashboard/hotel-bookings">{t("Xem danh sách đặt phòng")} <ArrowRight size={16} aria-hidden="true"/></Link>
      </aside>
    </div>
    {reservation && <ReserveRoom initialRoomId={reservation.roomId} initialArrival={reservation.arrival}
      close={() => setReservation(undefined)} saved={booking => { setNotice(bookingNotice(booking)); setReservation(undefined); }}/>}
    {folio && <HotelFolio id={folio} close={() => setFolio(undefined)}/>}
    {departing && <BookingTransition booking={departing} type="depart" close={() => setDeparting(undefined)}
      saved={message => { setNotice(message); setDeparting(undefined); }}/>}
  </div>;
}

export function HotelBookings() {
  const { t } = useLanguage();
  const { role } = useBusiness();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('OPEN');
  const [search, setSearch] = useState('');
  const [reserving, setReserving] = useState(false);
  const [editing, setEditing] = useState<Booking>();
  const [folio, setFolio] = useState<string>();
  const [transition, setTransition] = useState<{ booking: Booking; type: 'depart' | 'cancel' | 'no-show' }>();
  const [notice, setNotice] = useState('');
  const query = useData<Booking[]>(`/hotel-bookings?status=${status}&page=${page}&q=${encodeURIComponent(search)}`, 8000);
  const desk = useData<FrontDesk>('/hotel-front-desk', 8000);
  const action = useAction();
  const today = hotelDay();
  return <div className="hotel-desk"><HotelDeskHeader view="bookings" create={() => {
    setNotice(''); setReserving(true);
  }}/><Panel title={t("Danh sách đặt phòng")} className="hotel-history">
    {desk.data && <StatusFilters label={t("Công việc lễ tân hôm nay")} value={status} onChange={next => { setStatus(next); setPage(1); }}
      items={[
        { key: 'ARRIVALS', label: 'Chờ nhận phòng', count: desk.data.arrivals },
        { key: 'DEPARTURES', label: 'Quá giờ', count: desk.data.departures },
        { key: 'CHECKED_IN', label: 'Đang lưu trú', count: desk.data.occupied },
      ]}/>}
    <div className="hotel-history-controls">
      <label>{t("Trạng thái")}<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="OPEN">{t("Đặt chỗ và lưu trú đang mở")}</option>
        <option value="TODAY">{t("Khách đến hôm nay")}</option>
        <option value="ARRIVALS">{t("Chờ nhận phòng")}</option><option value="DEPARTURES">{t("Quá giờ")}</option>
        {Object.entries(bookingStates).map(([code, label]) => <option key={code} value={code}>{t(label)}</option>)}
      </select></label>
      <label>{t("Tìm đặt phòng")}<input type="search" value={search} maxLength={120} placeholder={t("Tên khách, điện thoại hoặc phòng")}
        onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
    </div>
    <State query={query} empty={query.data?.length === 0}/>{action.feedback}
    {notice && <p className="success" role="status">{notice}</p>}
    <div className="hotel-history-list">{query.data?.map(booking => <article className="hotel-history-item" key={booking.id}>
      <div className="hotel-history-guest"><span className="hotel-queue-room">{booking.roomCode}</span><div><strong>{booking.guestName}</strong>
        <small>{bookingWindow(booking)} · {booking.guestCount} {t("khách")}{booking.phone ? ` · ${booking.phone}` : ''}</small>
        <small>{t(bookingTypes[booking.bookingType ?? 'NIGHTLY'])}{booking.packageName && ` · ${booking.packageName}`}</small>
        {booking.dueAt && booking.status !== 'CHECKED_OUT' && <small>{t("Hạn trả")} {date(booking.dueAt)}</small>}
        {booking.checkedInAt && <small>{t("Nhận phòng")} {date(booking.checkedInAt)}</small>}
        {booking.paidAt && booking.paymentMethod && <small>{t("Đã thu")} {date(booking.paidAt)} · {t(paymentMethodLabels[booking.paymentMethod])}</small>}
        {booking.note && <small>{booking.note}</small>}
        {booking.closedReason && <small>{t("Lý do:")} {booking.closedReason}</small>}
      </div></div>
      <div className="hotel-history-amount" data-state={booking.overdue ? 'overdue' : booking.status === 'CHECKED_IN' ? 'occupied' :
        booking.status === 'RESERVED' ? 'reserved' : undefined}>
        <span className="hotel-state-chip">{booking.overdue ? `Quá giờ · ${booking.overdueHours} giờ tính phí` : bookingStates[booking.status]}</span>
        <strong>{currency.format(booking.amount)}</strong>
        {booking.status === 'CHECKED_IN' && <small>{t("Tạm tính")}</small>}
      </div>
      <div className="hotel-history-actions">
        {(booking.status === 'CHECKED_IN' || booking.status === 'CHECKED_OUT') &&
          <button type="button" className="plain" onClick={() => setFolio(booking.id)}>{t("Chi tiết tiền phòng")}</button>}
        {(booking.status === 'CHECKED_IN' || booking.status === 'RESERVED') &&
          <button type="button" className="plain" onClick={() => setEditing(booking)}>{t("Sửa đặt phòng")}</button>}
        {canCheckIn(booking) &&
          <button type="button" className="button"
          disabled={action.pending} onClick={() => { setNotice(''); void action.send(`/hotel-bookings/${booking.id}/arrive`, undefined, { message: 'Đã nhận phòng.' }); }}>
          {t("Nhận phòng")}
        </button>}
        {booking.status === 'RESERVED' && managesHotel(role) && <button type="button" className="plain" onClick={() => setTransition({ booking, type: 'cancel' })}>{t("Hủy đặt")}</button>}
        {booking.status === 'RESERVED' && (booking.endsAt ? Date.parse(booking.endsAt) <= Date.now() : today > booking.startsOn) && managesHotel(role) &&
          <button type="button" className="plain" onClick={() => setTransition({ booking, type: 'no-show' })}>{t("Khách không đến")}</button>}
        {booking.status === 'CHECKED_IN' && <button type="button" className="button" onClick={() => setTransition({ booking, type: 'depart' })}>{t("Thu tiền và trả phòng")}</button>}
      </div>
    </article>)}</div>
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    {folio && <HotelFolio id={folio} close={() => setFolio(undefined)}/>}
    {editing && <ReserveRoom booking={editing} close={() => setEditing(undefined)} saved={booking => {
      setNotice(`Đã cập nhật đặt phòng ${booking.roomCode} cho ${booking.guestName}.`); setEditing(undefined);
    }}/>}
    {reserving && <ReserveRoom close={() => setReserving(false)} saved={booking => {
      setStatus('OPEN'); setPage(1); setNotice(bookingNotice(booking)); setReserving(false);
    }}/>}
    {transition && <BookingTransition booking={transition.booking} type={transition.type} close={() => setTransition(undefined)}
      saved={message => { setNotice(message); setTransition(undefined); }}/>}
  </Panel></div>;
}

type DepartureBooking = Pick<Booking, 'id' | 'roomCode' | 'guestName'>;

function BookingTransition({ booking, type, close, saved }: {
  booking: DepartureBooking | Booking; type: 'depart' | 'cancel' | 'no-show'; close: () => void; saved: (message: string) => void;
}) {
  const { t } = useLanguage();
  const action = useAction();
  const departure = type === 'depart';
  const quote = useData<Booking>(`/hotel-bookings/${booking.id}`, 5000, departure);
  const current = quote.data;
  const label = { depart: 'Trả phòng', cancel: 'Hủy đặt phòng', 'no-show': 'Ghi khách không đến' }[type];
  return <BusinessDialog title={`${label} · ${booking.roomCode}`} close={close} pending={action.pending}>
    <p>{booking.guestName}{'startsOn' in booking && ` · ${bookingWindow(booking)}`}</p>
    <form onSubmit={event => submit(event, form => {
      if (departure && (!current || current.status !== 'CHECKED_IN' || quote.isError)) return;
      void action.send<Booking>(`/hotel-bookings/${booking.id}/${type}`, departure ? {
        paymentMethod: value(form, 'paymentMethod'), expectedAmount: current!.amount,
      } : { reason: value(form, 'reason') },
        { idempotent: departure }).then(result => {
        if (result) saved(departure ? `Đã thu ${currency.format(result.amount)} và trả phòng ${booking.roomCode}.` :
          `${type === 'no-show' ? 'Đã ghi khách không đến' : 'Đã hủy đặt phòng'} · ${booking.roomCode}.`);
        else if (departure) void quote.refetch();
      });
    })}>
      {departure ? <><State query={quote}/>{current && <HotelCharges booking={current}/>}<ServicePaymentField/></> :
        <label>{t("Lý do")}<input name="reason" maxLength={120} required/></label>}
      <button type="submit" className="button" disabled={action.pending || (departure && (current?.status !== 'CHECKED_IN' || quote.isError))}>{departure ? t("Xác nhận đã thu và trả phòng") : label}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function HotelCharges({ booking, remove }: { booking: Booking; remove?: (id: string) => void }) {
  const { t } = useLanguage();
  const base = bookingBase(booking);
  return <div>
    {booking.checkedInAt && <p className="muted">{t("Nhận")} {date(booking.checkedInAt)}{booking.checkedOutAt && ` · Trả ${date(booking.checkedOutAt)}`}</p>}
    {booking.overdue && booking.dueAt && <p className="badge warning">{t("Quá giờ trả phòng · Hạn")} {date(booking.dueAt)}</p>}
    <div className="list-row"><span>{t("Tiền phòng ·")} {t(base.label)}</span><strong>{currency.format(base.total)}</strong></div>
    {booking.bookingType === 'HOURLY' && booking.hourlyNextRate != null && <small>
      {t("Giờ đầu")} {currency.format(booking.hourlyRate ?? 0)} {t("· Mỗi giờ tiếp theo")} {currency.format(booking.nextHourRate ?? booking.hourlyNextRate)}
    </small>}
    {!!booking.overdueHours && <div className="list-row">
      <span>{t("Phí quá giờ ·")} {booking.overdueHours} {t("giờ ×")} {currency.format(booking.nextHourRate ?? 0)}</span>
      <strong>{currency.format(booking.overdueAmount ?? 0)}</strong>
    </div>}
    {booking.charges?.map(charge => <div className="list-row" key={charge.id}>
      <div><strong>{charge.name}</strong><small>{charge.quantity} × {currency.format(charge.unitPrice)}</small></div>
      <div className="actions"><strong>{currency.format(charge.quantity * charge.unitPrice)}</strong>
        {remove && <button type="button" className="plain" aria-label={`Bỏ phụ phí ${charge.name}`} onClick={() => remove(charge.id)}>{t("Bỏ")}</button>}</div>
    </div>)}
    <div className="list-row pos-total"><span>{booking.paidAt ? t("Đã thu") : t("Tổng cần thu")}</span><strong>{currency.format(booking.amount)}</strong></div>
  </div>;
}

export function HotelFolio({ id, close }: { id: string; close: () => void }) {
  const { t } = useLanguage();
  const { branch, role } = useBusiness();
  const path = `/hotel-bookings/${id}`;
  const query = useData<Booking>(path, 8000);
  const action = useAction();
  const [printing, setPrinting] = useState(false);
  const booking = query.data;
  const open = booking?.status === 'CHECKED_IN';
  async function print() {
    flushSync(() => setPrinting(true));
    try { await printReceipt(); } finally { setPrinting(false); }
  }
  return <BusinessDialog title={booking ? `Tiền phòng ${booking.roomCode}` : t("Tiền phòng")} close={close} pending={action.pending || printing}>
    <State query={query}/>
    {booking && <>
      <p>{booking.guestName} · {bookingWindow(booking)}</p>
      <HotelCharges booking={booking} remove={open && managesHotel(role) ? chargeId => {
        void action.send(`${path}/charges/${chargeId}`, undefined, { method: 'DELETE', message: 'Đã bỏ phụ phí.' });
      } : undefined}/>
      {booking.paidAt && booking.paymentMethod && <>
        <p className="muted">{date(booking.paidAt)} · {t(paymentMethodLabels[booking.paymentMethod])}</p>
        <button type="button" className="plain" disabled={printing} onClick={() => void print()}><Printer size={17}/> {t("In phiếu thu")}</button>
        {printing && createPortal(<article className="print-receipt bill-print">
          <strong>{branch.name} {t("· PHIẾU THU TIỀN PHÒNG")}</strong>
          <p>{t("Phòng")} {booking.roomCode} · {booking.guestName}</p>
          <p>{bookingWindow(booking)}</p>
          <HotelCharges booking={booking}/>
          <p>{date(booking.paidAt)} · {t(paymentMethodLabels[booking.paymentMethod])}</p>
        </article>, document.body)}
      </>}
    </>}
    {open && <form onSubmit={event => submit(event, (form, element) => {
      void action.send(`${path}/charges`, { name: value(form, 'name'), quantity: amount(form, 'quantity'),
        unitPrice: amount(form, 'unitPrice') }, { idempotent: true, reset: element, message: 'Đã thêm phụ phí.' });
    })}>
      <label>{t("Dịch vụ hoặc phụ phí")}<input name="name" maxLength={120} required/></label>
      <div className="columns"><label>{t("Số lượng")}<input type="number" name="quantity" min={1} max={1000} defaultValue={1} required/></label>
        <label>{t("Đơn giá (đ)")}<input type="number" name="unitPrice" min={1} max={1000000000000} required/></label></div>
      <button type="submit" className="button" disabled={action.pending}>{t("Thêm phụ phí")}</button>
    </form>}
    {action.feedback}
  </BusinessDialog>;
}

export function HotelCalendar() {
  const { t } = useLanguage();
  const [day, setDay] = useState(() => hotelDay());
  const [details, setDetails] = useState<string>();
  const [reserving, setReserving] = useState(false);
  const [notice, setNotice] = useState('');
  const query = useData<Calendar>(`/hotel-calendar?day=${day}`, 8000);
  const days = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(day) + index * dayMs).toISOString().slice(0, 10));
  const byRoom = new Map<string, Calendar['bookings']>();
  for (const booking of query.data?.bookings ?? []) {
    const list = byRoom.get(booking.roomId) ?? [];
    list.push(booking);
    byRoom.set(booking.roomId, list);
  }
  return <div className="hotel-desk"><HotelDeskHeader view="calendar" create={() => { setNotice(''); setReserving(true); }}/>
    {notice && <p className="success" role="status">{notice}</p>}
    <Panel title={t("Lịch phòng 7 ngày")} className="hotel-schedule">
    <div className="actions hotel-calendar-tools">
      <button type="button" className="plain" onClick={() => setDay(new Date(Date.parse(day) - 7 * dayMs).toISOString().slice(0, 10))}>
        <ChevronLeft size={16} aria-hidden="true"/> {t("Tuần trước")}</button>
      <label>{t("Xem từ ngày")}<input type="date" value={day} onChange={event => { if (event.target.value) setDay(event.target.value); }}/></label>
      <button type="button" className="plain" onClick={() => setDay(hotelDay())}>{t("Hôm nay")}</button>
      <button type="button" className="plain" onClick={() => setDay(new Date(Date.parse(day) + 7 * dayMs).toISOString().slice(0, 10))}>
        {t("Tuần sau")} <ChevronRight size={16} aria-hidden="true"/></button>
    </div>
    <State query={query} empty={query.data?.rooms.length === 0}/>
    {!!query.data?.rooms.length && <div className="hotel-calendar-scroll" tabIndex={0} role="region" aria-label={t("Lịch phòng bảy ngày")}>
      <table className="hotel-calendar">
        <thead><tr><th scope="col">{t("Phòng")}</th>{days.map(date => <th scope="col" key={date} data-today={date === hotelDay()}>
          <small>{new Intl.DateTimeFormat('vi-VN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(date))}</small>
          {calendarDate(date).slice(0, 5)}</th>)}</tr></thead>
        <tbody>{query.data.rooms.map(room => <tr key={room.id}>
          <th scope="row"><strong>{room.code}</strong><small>{room.category} · {t(roomStates[room.state])}</small></th>
          {days.map(date => <td key={date}>{byRoom.get(room.id)?.filter(booking => booking.startsOn <= date && (booking.status === 'CHECKED_OUT' ? date <= booking.occupiedUntil :
            date <= booking.endsOn || date <= booking.occupiedUntil))
            .map(booking => <button type="button" className={`hotel-calendar-stay ${date === booking.endsOn && date !== booking.startsOn ? 'hotel-calendar-departure' : ''}`}
              key={booking.id} data-overdue={booking.overdue || undefined} data-status={booking.status} onClick={() => setDetails(booking.id)}>
              <strong>{booking.guestName}</strong>
              <small>{booking.overdue && date >= booking.endsOn ? t("Quá giờ trả phòng") :
                booking.status === 'CHECKED_OUT' && date === booking.occupiedUntil ? t("Đã trả phòng") : booking.startsAt && !booking.endsAt ?
                bookingStates[booking.status] : booking.startsAt && booking.endsAt && date === booking.startsOn && date === booking.endsOn ?
                `${vietnamLocalTime(booking.startsAt).slice(11)} – ${vietnamLocalTime(booking.endsAt).slice(11)}` :
                date === booking.endsOn ? `Trả phòng dự kiến${booking.endsAt ? ` · ${vietnamLocalTime(booking.endsAt).slice(11)}` : ''}` :
                  `${bookingStates[booking.status]}${date === booking.startsOn && booking.startsAt ? ` · ${vietnamLocalTime(booking.startsAt).slice(11)}` : ''}`}</small>
            </button>)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>}
    {details && <HotelFolio id={details} close={() => setDetails(undefined)}/>}
    {reserving && <ReserveRoom close={() => setReserving(false)} saved={booking => { setNotice(bookingNotice(booking)); setReserving(false); }}/>}
  </Panel></div>;
}
