'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CalendarDays, Copy, Link2, Phone } from 'lucide-react';
import { Pager, State } from '@/components/business-ui';
import { useBusiness } from '@/hooks/use-business';
import { useLanguage } from '@/i18n/language';
import { api } from '@/services/api-client';

const statuses = { PENDING: 'Chờ xác nhận', CONFIRMED: 'Đã xác nhận', DECLINED: 'Đã từ chối' } as const;
type Status = keyof typeof statuses;
type Booking = { id: string; guestName: string; phone: string; startsAt: string; endsAt?: string; partySize: number; note?: string };
type BookingQueue = { enabled: boolean; items: Booking[]; hasMore: boolean };

export function BookingRequests() {
  const { branch, role, root, tenantId } = useBusiness();
  const { language, t } = useLanguage();
  const client = useQueryClient();
  const [status, setStatus] = useState<Status>('PENDING');
  const [page, setPage] = useState(1);
  const [origin, setOrigin] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const linkField = useRef<HTMLInputElement>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  const link = `${origin}/dat-truoc/${tenantId}/${branch.id}`;
  const path = root + '/booking-requests';
  const queryKey = ['booking-requests', tenantId, branch.id];
  const queue = useQuery({ queryKey: [...queryKey, status, page],
    queryFn: () => api<BookingQueue>(`${path}?status=${status}&page=${page}`), refetchInterval: status === 'PENDING' ? 15000 : false });
  const update = useMutation({
    mutationFn: ({ target, body }: { target: string; body: { enabled: boolean } | { status: Exclude<Status, 'PENDING'> } }) =>
      api(path + '/' + target, 'PATCH', body),
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  const time = new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'vi-VN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh',
  });

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopyMessage("Đã sao chép link đặt trước.");
    } catch {
      linkField.current?.focus();
      linkField.current?.select();
      setCopyMessage("Hãy sao chép link đã được chọn.");
    }
  }

  return <div className="booking-admin">
    <section className="card booking-link">
      <div>
        <h2><Link2 size={19} aria-hidden="true"/>{t("Link đặt trước của chi nhánh")}</h2>
        <p className="muted">{t("Gửi link này cho khách để nhận yêu cầu đặt trước.")}</p>
      </div>
      {queue.isSuccess && <>
        <div className="actions">
          <span className="badge">{t(queue.data.enabled ? "Đang nhận đặt trước" : "Đã tắt đặt trước")}</span>
          {role === 'OWNER' && <button type="button" className="plain" disabled={update.isPending} onClick={() => {
            setCopyMessage('');
            update.mutate({ target: 'settings', body: { enabled: !queue.data.enabled } });
          }}>{t(queue.data.enabled ? "Tắt nhận đặt trước" : "Bật nhận đặt trước")}</button>}
        </div>
        {queue.data.enabled && origin && <div className="booking-link-controls">
          <input aria-label={t("Link đặt trước của chi nhánh")} value={link} readOnly ref={linkField}/>
          <button className="button" type="button" onClick={() => void copyLink()}><Copy size={16} aria-hidden="true"/>{t("Sao chép link")}</button>
          <a className="plain" href={link} target="_blank" rel="noreferrer">{t("Mở trang của khách")} <ArrowUpRight size={16} aria-hidden="true"/></a>
          {copyMessage && <small role="status">{t(copyMessage)}</small>}
        </div>}
      </>}
    </section>
    <section className="card booking-queue">
      <h2><CalendarDays size={19} aria-hidden="true"/>{t("Yêu cầu đặt trước")}</h2>
      <div className="status-filters" role="group" aria-label={t("Trạng thái đặt trước")}>
        {(Object.keys(statuses) as Status[]).map(value => <button key={value} className="plain" type="button"
          disabled={update.isPending} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1); update.reset(); }}>
          {t(statuses[value])}
        </button>)}
      </div>
      {update.error && <p className="error" role="alert">{t(update.error.message)}</p>}
      <State query={queue}/>
      {queue.isSuccess && !queue.data.items.length && <p className="muted">{t("Chưa có yêu cầu đặt trước ở trạng thái này.")}</p>}
      {queue.data?.items.map(item => <article className="booking-queue-entry" key={item.id}>
        <div>
          <strong>{item.guestName}</strong>
          <small>{time.format(new Date(item.startsAt))}{item.endsAt && ` – ${time.format(new Date(item.endsAt))}`}</small>
          <small>{t(branch.mode === 'TICKETS' ? "{0} vé" : "{0} khách", item.partySize)}</small>
          {item.note && <p>{item.note}</p>}
        </div>
        <div className="actions">
          <a className="plain" href={`tel:${item.phone}`}><Phone size={16} aria-hidden="true"/>{item.phone}</a>
          {status === 'PENDING' && <>
            <button type="button" className="plain" disabled={update.isPending} onClick={() =>
              update.mutate({ target: item.id, body: { status: 'DECLINED' } })}>{t("Từ chối")}</button>
            <button type="button" className="button" disabled={update.isPending} onClick={() =>
              update.mutate({ target: item.id, body: { status: 'CONFIRMED' } })}>{t("Xác nhận")}</button>
          </>}
        </div>
      </article>)}
      {queue.data && (page > 1 || queue.data.hasMore) && <Pager page={page} full={queue.data.hasMore} onChange={setPage}/>}
    </section>
  </div>;
}
