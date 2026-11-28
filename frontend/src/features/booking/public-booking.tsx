'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, Layers3, MapPin } from 'lucide-react';
import { LanguageSwitch } from '@/components/language-switch';
import { useLanguage } from '@/i18n/language';
import { ApiError, api, requestKey } from '@/services/api-client';
import type { Branch } from '@/types/business';
import { usesTables } from '@/types/business';

type BookingInfo = { storeName: string; branchName: string; mode: Branch['mode'] };

export function PublicBooking({ tenantId, branchId }: { tenantId: string; branchId: string }) {
  const { t } = useLanguage();
  const path = `/bookings/${tenantId}/${branchId}`;
  const [info, setInfo] = useState<BookingInfo>();
  const [error, setError] = useState<Error>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api<BookingInfo>(path).then(result => { if (active) setInfo(result); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause : new Error('Không thể tải trang đặt trước.')); });
    return () => { active = false; };
  }, [path, attempt]);

  return <main className="booking-page" data-theme={info?.mode}>
    <header className="booking-public-header">
      <span className="brand"><Layers3 size={23} aria-hidden="true"/> JUEE POS</span>
      <LanguageSwitch/>
    </header>
    {info ? <BookingForm info={info} path={path}/> : <section className="card booking-unavailable">
      <h1>{t("Đặt trước")}</h1>
      {error ? <>
        <p role="alert">{t(error.message)}</p>
        {(!(error instanceof ApiError) || error.status !== 404) &&
          <button className="button" type="button" onClick={() => { setError(undefined); setAttempt(value => value + 1); }}>{t("Thử lại")}</button>}
      </> : <div className="skeleton" aria-label={t("Đang tải")}/>}
    </section>}
  </main>;
}

function BookingForm({ info, path }: { info: BookingInfo; path: string }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const lastAttempt = useRef<{ payload: string; key: string }>(undefined);
  const hotel = info.mode === 'HOTEL';
  const tickets = info.mode === 'TICKETS';
  const title = hotel ? 'Đặt phòng' : tickets ? 'Đặt vé' : usesTables(info.mode) ? 'Đặt bàn' : 'Đặt trước';
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    const input = {
      guestName: data.get('guestName'),
      phone: data.get('phone'),
      startsAt: `${data.get('arrivalDate')}T${data.get('arrivalTime')}:00+07:00`,
      endsAt: hotel ? `${data.get('departureDate')}T${data.get('departureTime')}:00+07:00` : undefined,
      partySize: Number(data.get('partySize')),
      note: data.get('note'),
    };
    const payload = JSON.stringify(input);
    if (lastAttempt.current?.payload !== payload) lastAttempt.current = { payload, key: requestKey() };
    setPending(true);
    setError('');
    submitting.current = true;
    try {
      await api(path, 'POST', input, { 'Idempotency-Key': lastAttempt.current.key });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không gửi được yêu cầu. Vui lòng thử lại.');
    } finally {
      setPending(false);
      submitting.current = false;
    }
  }

  return <div className="booking-public-grid">
    <section className="booking-public-intro">
      <span className="booking-public-icon"><CalendarDays size={26} aria-hidden="true"/></span>
      <p className="booking-store-name">{info.storeName}</p>
      <h1>{t(title)}</h1>
      <p className="booking-branch-name"><MapPin size={17} aria-hidden="true"/>{info.branchName}</p>
      <p>{t("Chi nhánh sẽ liên hệ qua số điện thoại bạn cung cấp để xác nhận.")}</p>
    </section>
    {sent ? <section className="card booking-public-card" role="status">
      <span className="booking-public-icon"><Check size={26} aria-hidden="true"/></span>
      <h2>{t("Đã gửi yêu cầu đặt trước")}</h2>
      <p>{t("Yêu cầu đang chờ chi nhánh xác nhận.")}</p>
    </section> : <section className="card booking-public-card">
      <h2>{t("Thông tin đặt trước")}</h2>
      <form onSubmit={send}>
        <div className="booking-field-grid">
          <label>{t("Họ và tên")}<input name="guestName" autoComplete="name" required maxLength={120}/></label>
          <label>{t("Số điện thoại")}<input name="phone" type="tel" autoComplete="tel" required maxLength={32}/></label>
        </div>
        <div className="booking-field-grid">
          <label>{t(hotel ? "Ngày nhận phòng" : "Ngày đến")}<input name="arrivalDate" type="date" min={today} required/></label>
          <label>{t(hotel ? "Giờ nhận phòng" : "Giờ đến")}<input name="arrivalTime" type="time" required/></label>
        </div>
        {hotel && <div className="booking-field-grid">
          <label>{t("Ngày trả phòng")}<input name="departureDate" type="date" min={today} required/></label>
          <label>{t("Giờ trả phòng")}<input name="departureTime" type="time" required/></label>
        </div>}
        <small>{t("Thời gian theo giờ Việt Nam.")}</small>
        <label>{t(tickets ? "Số vé" : "Số khách")}<input name="partySize" type="number" min={1} max={100} defaultValue={1} required/></label>
        <label>{t("Ghi chú (không bắt buộc)")}<textarea name="note" rows={3} maxLength={500}/></label>
        {error && <p className="error" role="alert">{t(error)}</p>}
        <button className="button" type="submit" disabled={pending}>{t(pending ? "Đang gửi…" : "Gửi yêu cầu đặt trước")}
          <ArrowRight size={17} aria-hidden="true"/></button>
      </form>
    </section>}
  </div>;
}
