'use client';

import { CalendarClock, Clock3, LogIn, Moon, Package, Users } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { State } from '@/components/business-ui';
import { useAction, useData } from '@/hooks/use-business';
import { amount, currency, date, submit, value, vietnamDateTimeInput, vietnamLocalTime } from '@/lib/format';
import {
  bookingTypes, calendarDate, dayMs, hotelDay, hourMs, roomNextHourRate,
  type Booking, type BookingType, type HotelPackage, type Room,
} from '@/lib/hotel';

export type ArrivalMode = 'ADVANCE' | 'NOW';

const stayChoices = [
  { key: 'HOURLY', icon: Clock3 },
  { key: 'PACKAGE', icon: Package },
  { key: 'NIGHTLY', icon: Moon },
] as const;

const arrivalChoices = [
  { key: 'NOW', label: 'Check-in ngay', detail: 'Khách vào ở bây giờ', icon: LogIn },
  { key: 'ADVANCE', label: 'Đặt trước', detail: 'Hẹn ngày và giờ khách đến', icon: CalendarClock },
] as const;

export function ReserveRoom({ initialRoomId, initialArrival, booking, close, saved }: {
  initialRoomId?: string; initialArrival?: ArrivalMode; booking?: Booking;
  close: () => void; saved: (booking: Booking) => void;
}) {
  const today = hotelDay();
  const [mode, setMode] = useState<BookingType>(booking?.bookingType ?? 'NIGHTLY');
  const [arrival, setArrival] = useState(initialArrival);
  const [startTime, setStartTime] = useState(() => booking?.startsAt ? vietnamLocalTime(booking.startsAt) : '');
  const [startDate, setStartDate] = useState(booking?.startsOn ?? today);
  const [endDate, setEndDate] = useState(booking?.endsOn ?? '');
  const [nights, setNights] = useState(1);
  const [hourCount, setHourCount] = useState(booking?.durationHours ?? 2);
  const [packageId, setPackageId] = useState('');
  const [roomId, setRoom] = useState(booking?.roomId ?? initialRoomId ?? '');
  const action = useAction();
  const immediate = !booking && arrival === 'NOW';
  const inHouse = booking?.status === 'CHECKED_IN';
  const legacyNight = mode === 'NIGHTLY' && !!booking && !booking.startsAt;
  const nightly = mode === 'NIGHTLY';
  const hourly = mode === 'HOURLY';
  const bundled = mode === 'PACKAGE';
  const plans = useData<HotelPackage[]>('/hotel-packages', 8000, bundled && !booking && !!arrival);
  const plan = booking?.packageId ? {
    id: booking.packageId, name: booking.packageName!, price: booking.packagePrice!, durationHours: booking.durationHours!,
  } : plans.data?.find(item => item.id === packageId);
  const startsAt = booking?.startsAt && startTime === vietnamLocalTime(booking.startsAt) ? booking.startsAt : startTime ? vietnamDateTimeInput(startTime) : '';
  const startsOn = immediate ? today : legacyNight ? startDate : startTime.slice(0, 10);
  const minEnd = startsOn ? hotelDay(Date.parse(startsOn) + dayMs) : undefined;
  const validNightCount = Number.isInteger(nights) && nights >= 1 && nights <= 365;
  const endsOn = immediate ? (nightly && validNightCount ? hotelDay(Date.parse(today) + nights * dayMs) : '') : endDate;
  const nightTotal = (Date.parse(endsOn) - Date.parse(startsOn)) / dayMs;
  const holdHours = bundled ? plan?.durationHours : hourly && !immediate ? (booking?.durationHours == null && booking ? undefined : hourCount) : undefined;
  const currentMinute = vietnamLocalTime();
  const hourCountValid = holdHours === undefined || (Number.isInteger(holdHours) && holdHours >= 1 && holdHours <= 8760);
  const pastSavedStart = startsAt === booking?.startsAt || (legacyNight && startsOn === booking?.startsOn);
  const startReady = immediate || (legacyNight ? !!startsOn && (startsOn >= today || pastSavedStart) :
    !!startsAt && (pastSavedStart || startTime > currentMinute));
  const endsAt = nightly && endsOn ? `${endsOn}T12:00:00+07:00` :
    startsAt && holdHours && hourCountValid ? new Date(Date.parse(startsAt) + holdHours * hourMs).toISOString() : undefined;
  const savedEnd = !!booking && (nightly ? endsOn === booking.endsOn : startsAt === booking.startsAt && holdHours === booking.durationHours);
  const datesReady = (!!booking || !!arrival) && startReady && hourCountValid && (!bundled || !!plan) &&
    (!nightly || (nightTotal >= 1 && nightTotal <= 365)) &&
    (immediate || !endsAt || Date.parse(endsAt) > Date.now() || (inHouse && savedEnd));

  const params = new URLSearchParams();
  if (datesReady) {
    if (immediate) {
      if (hourly) params.set('openHourly', 'true');
      else {
        params.set('checkInNow', 'true');
        params.set(nightly ? 'nights' : 'durationHours', String(nightly ? nights : holdHours));
      }
    } else if (legacyNight) {
      params.set('startsOn', startsOn);
      params.set('endsOn', endsOn);
    } else {
      params.set('startsAt', startsAt);
      if (endsAt) params.set('endsAt', endsAt);
      else params.set('openEnded', 'true');
    }
    if (booking) params.set('excludeBookingId', booking.id);
  }
  const query = useData<Room[]>(`/hotel-rooms?${params}`, 8000, datesReady);
  function rateFor(room: Room) {
    const sameRoom = booking?.roomId === room.id;
    if (bundled) return plan?.price;
    return hourly ? (sameRoom ? booking.hourlyRate : room.hourlyRate) : (sameRoom ? booking.nightlyRate : room.nightlyRate);
  }
  const available = datesReady ? query.data?.filter(room => (room.available || (inHouse && booking.roomId === room.id)) && rateFor(room) != null) ?? [] : [];
  const room = available.find(item => item.id === roomId);
  const rate = room ? rateFor(room) : undefined;
  const fixedHours = hourly && booking?.durationHours != null && booking.hourlyNextRate == null;
  const nextRate = room ? (fixedHours ? rate : booking?.roomId === room.id ?
    booking.nextHourRate ?? booking.hourlyNextRate ?? roomNextHourRate(room) : roomNextHourRate(room)) : undefined;
  const formReady = datesReady && !!room && rate != null && !query.isError;
  const showDuration = hourly && !immediate && (!booking || booking.durationHours != null);

  return <BusinessDialog className="hotel-reservation-dialog" title={booking ? `Sửa lưu trú · ${booking.roomCode}` : 'Đăng ký lưu trú'}
    close={close} pending={action.pending}>
    <form className="hotel-reservation" onSubmit={event => submit(event, form => {
      if (!room || rate == null || !formReady) return;
      const timing = immediate ? {} : { startsAt };
      const terms = bundled ? {
        bookingType: mode, ...timing, packageId: plan!.id, expectedPackagePrice: rate, expectedPackageHours: holdHours,
      } : hourly ? {
        bookingType: mode, ...timing, ...(holdHours != null && { durationHours: holdHours }), expectedHourlyRate: rate,
      } : {
        bookingType: mode, ...(immediate ? { nights } : { ...(legacyNight ? { startsOn } : timing), endsOn }), expectedNightlyRate: rate,
      };
      void action.send<Booking>(booking ? `/hotel-bookings/${booking.id}` : '/hotel-bookings', {
        roomId: room.id, ...terms, ...(!booking && { arrivalMode: arrival }), expectedHourlyNextRate: nextRate,
        guestName: value(form, 'guestName'), phone: value(form, 'phone'), guestCount: amount(form, 'guestCount'), note: value(form, 'note'),
      }, booking ? { method: 'PATCH' } : { idempotent: true }).then(result => {
        if (result) saved(result);
        else { void query.refetch(); if (bundled && !booking) void plans.refetch(); }
      });
    })}>
      <fieldset className="hotel-form-section" disabled={action.pending}>
        <legend>Loại lưu trú</legend>
        {booking ? <p>{bookingTypes[mode]}{plan && ` · ${plan.name} · ${plan.durationHours} giờ`}</p> :
          <div className="hotel-choices hotel-stay-choices">
            {stayChoices.map(({ key, icon: Icon }) => <label key={key} className="hotel-choice">
              <input type="radio" name="stayType" checked={mode === key} onChange={() => setMode(key)}/>
              <Icon size={18} aria-hidden="true"/><strong>{bookingTypes[key]}</strong>
            </label>)}
          </div>}
      </fieldset>
      {!booking && <fieldset className="hotel-form-section" disabled={action.pending}>
        <legend>Hình thức nhận phòng</legend>
        <div className="hotel-choices">
          {arrivalChoices.map(({ key, label, detail, icon: Icon }) => <label key={key} className="hotel-choice">
            <input type="radio" name="arrival" checked={arrival === key} onChange={() => setArrival(key)} required/>
            <Icon size={19} aria-hidden="true"/><span><strong>{label}</strong><small>{detail}</small></span>
          </label>)}
        </div>
      </fieldset>}
      {(booking || arrival) && <>
        <fieldset className="hotel-form-section" disabled={action.pending}>
          <legend>{immediate ? 'Thời gian lưu trú' : 'Lịch lưu trú'}</legend>
          {immediate && <p className="hotel-hint">Hệ thống lấy giờ hiện tại khi xác nhận.</p>}
          {bundled && !booking && <>
            <State query={plans}/>
            {plans.data?.length === 0 && <p className="notice">Chưa có combo đang áp dụng.</p>}
            <label>Combo<select value={packageId} required onChange={event => setPackageId(event.target.value)}>
              <option value="">Chọn combo</option>
              {plans.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.durationHours} giờ · {currency.format(item.price)}</option>)}
            </select></label>
          </>}
          <div className="hotel-form-fields">
            {!immediate && (legacyNight ? <label>Ngày nhận phòng<input type="date" value={startDate} disabled={inHouse}
              required onChange={event => setStartDate(event.target.value)}/></label> :
              <label>Ngày và giờ nhận phòng<input type="datetime-local" value={startTime} disabled={inHouse} required
                min={pastSavedStart ? undefined : currentMinute} onChange={event => {
                  const next = event.target.value;
                  setStartTime(next);
                  if (nightly && next && endDate <= next.slice(0, 10)) setEndDate(hotelDay(Date.parse(next.slice(0, 10)) + dayMs));
                }}/></label>)}
            {nightly && (immediate ? <label>Số đêm<input type="number" value={nights || ''} min={1} max={365} required
              onChange={event => setNights(Number(event.target.value))}/></label> :
              <label>Ngày trả phòng<input type="date" value={endDate} min={minEnd} required onChange={event => setEndDate(event.target.value)}/></label>)}
            {showDuration && <label>Số giờ dự kiến<input type="number" value={hourCount || ''} min={1} max={8760}
              required disabled={inHouse} onChange={event => setHourCount(Number(event.target.value))}/></label>}
          </div>
          {!startReady && !!startTime && <p className="notice">Chọn ngày giờ nhận phòng sau thời điểm hiện tại.</p>}
          {nightly && endsOn && nightTotal >= 1 && <p>Trả phòng trước <strong>12:00 ngày {calendarDate(endsOn)}</strong></p>}
          {bundled && datesReady && <p>{immediate ? <>Combo bắt đầu khi check-in và kéo dài <strong>{holdHours} giờ</strong>.</> :
            <>Hết combo lúc <strong>{date(endsAt!)}</strong></>}</p>}
          {hourly && <p className="hotel-hint">{fixedHours ? 'Lượt lưu trú tính tiền theo số giờ đã đặt.' :
            immediate ? 'Tiền phòng tính theo thời gian ở thực tế đến khi trả phòng.' :
              'Số giờ dự kiến dùng để giữ chỗ. Tiền phòng tính theo thời gian ở thực tế.'}</p>}
        </fieldset>
        {datesReady && <>
          <fieldset className="hotel-form-section" disabled={action.pending}>
            <legend>Phòng</legend>
            <State query={query}/>
            {query.isSuccess && !available.length && <p className="notice">Không có phòng phù hợp với loại lưu trú và thời gian đã chọn.</p>}
            {initialRoomId && roomId === initialRoomId && query.isSuccess && !room && !!available.length &&
              <p className="notice">Phòng đã chọn không phù hợp với thời gian hoặc loại lưu trú này. Hãy chọn phòng khác.</p>}
            {!!available.length && <label>Chọn phòng<select value={room?.id ?? ''} disabled={inHouse} required onChange={event => setRoom(event.target.value)}>
              <option value="" disabled>Chọn phòng</option>
              {available.map(item => <option key={item.id} value={item.id}>{item.code} · {item.category} · {item.capacity} khách
                {!bundled && ` · ${currency.format(rateFor(item)!)}${hourly ? ' giờ đầu' : '/đêm'}`}</option>)}
            </select></label>}
          </fieldset>
        </>}
        <fieldset className="hotel-form-section" disabled={action.pending}>
            <legend><Users size={16} aria-hidden="true"/> Thông tin khách</legend>
            <label>Tên khách<input name="guestName" maxLength={120} defaultValue={booking?.guestName} required/></label>
            <div className="hotel-form-fields">
              <label>Điện thoại<input name="phone" type="tel" maxLength={30} defaultValue={booking?.phone}/></label>
              <label>Số khách<input name="guestCount" type="number" min={1} max={room?.capacity ?? 100} defaultValue={booking?.guestCount ?? 1} required/></label>
            </div>
            <label>Ghi chú<textarea name="note" rows={2} maxLength={500} defaultValue={booking?.note}/></label>
        </fieldset>
      </>}
      {action.feedback}
      <footer className="hotel-form-footer">
        {rate != null && !inHouse && <div>
          <small>{bundled ? plan?.name : nightly ? `${nightTotal} đêm` : fixedHours ? `${holdHours} giờ` : 'Giờ đầu'}</small>
          <strong>{currency.format(rate * (nightly ? nightTotal : fixedHours ? holdHours ?? 1 : 1))}</strong>
          {nextRate != null && !fixedHours && <small>{hourly ? 'Mỗi giờ tiếp theo' : 'Mỗi giờ quá hạn'} {currency.format(nextRate)}</small>}
        </div>}
        <button type="submit" className="button" disabled={!formReady || action.pending}>{booking ? 'Lưu thay đổi' :
          immediate ? 'Xác nhận check-in' : 'Xác nhận đặt trước'}</button>
      </footer>
    </form>
  </BusinessDialog>;
}
