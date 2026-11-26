'use client';

const dayMs = 86_400_000;
const weekDays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

type Counts = { total: number; attended: number; leave: number; absent: number; unscheduled: number };
export type CalendarCounts = Record<string, Counts>;

export function StaffCalendar({ day, today, counts, change }: {
  day: string; today: string; counts?: CalendarCounts; change: (day: string) => void;
}) {
  const { t } = useLanguage();
  const month = day.slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const start = Date.UTC(year, monthNumber - 1, 1);
  const next = Date.UTC(year, monthNumber, 1);
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const gridStart = start - offset * dayMs;
  const length = Math.ceil((offset + (next - start) / dayMs) / 7) * 7;
  const jumpMonth = (offset: number) => change(new Date(Date.UTC(year, monthNumber - 1 + offset, 1)).toISOString().slice(0, 10));
  return <div className="staff-calendar">
    <div className="actions staff-calendar-nav">
      <button type="button" className="plain" disabled={month <= '1970-01'} aria-label={t("Tháng trước")} onClick={() => jumpMonth(-1)}>‹</button>
      <strong>{t("Tháng")} {monthNumber}/{year}</strong>
      <button type="button" className="plain" disabled={month >= '9999-11'} aria-label={t("Tháng sau")} onClick={() => jumpMonth(1)}>›</button>
      <button type="button" className="plain" onClick={() => change(today)}>{t("Hôm nay")}</button>
    </div>
    <div className="staff-calendar-grid">
      {weekDays.map(label => <span key={label} className="staff-calendar-weekday">{label}</span>)}
      {Array.from({ length }, (_, index) => {
        const slot = gridStart + index * dayMs;
        const key = new Date(slot).toISOString().slice(0, 10);
        if (slot < start || slot >= next) return <span key={key} aria-hidden="true"/>;
        const stats = counts?.[key];
        const summary = stats ? `, ${stats.total} ca, ${stats.attended} đã chấm công, ${stats.leave} nghỉ làm, ${stats.absent} vắng mặt, ${stats.unscheduled} ngoài ca` : '';
        return <button key={key} type="button" className="staff-calendar-day" aria-pressed={key === day}
          aria-current={key === today ? 'date' : undefined} aria-label={`${key.split('-').reverse().join('/')}${summary}`} onClick={() => change(key)}>
          <span className="staff-calendar-number">{new Date(slot).getUTCDate()}</span>
          {stats && <span className="staff-calendar-counts" aria-hidden="true">
            {stats.total > 0 && <span className="staff-calendar-total">{stats.total} ca</span>}
            {stats.attended > 0 && <span className="staff-calendar-present">{stats.attended} {t("công")}</span>}
            {stats.leave > 0 && <span className="staff-calendar-away">{stats.leave} {t("nghỉ")}</span>}
            {stats.absent > 0 && <span className="staff-calendar-absent">{stats.absent} {t("vắng")}</span>}
            {stats.unscheduled > 0 && <span className="staff-calendar-present">{stats.unscheduled} {t("ngoài ca")}</span>}
          </span>}
        </button>;
      })}
    </div>
  </div>;
}import { useLanguage } from '@/i18n/language';
