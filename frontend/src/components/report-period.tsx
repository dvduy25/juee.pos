'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { BusinessDialog } from '@/components/business-dialog';
import { useBusiness } from '@/hooks/use-business';
import { apiBlob } from '@/services/api-client';
import { downloadFile } from '@/lib/csv';

const periods = { today: 'Theo ngày', week: 'Theo tuần', month: 'Theo tháng', year: 'Theo năm', all: 'Toàn bộ' } as const;
export type ReportPeriod = keyof typeof periods;
export const reportDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' });

export function reportParams(period: ReportPeriod, on: string) {
  return new URLSearchParams({ period, ...(period !== 'all' && on ? { on } : {}) });
}

export function ReportPeriodFields({ period, on, setPeriod, setOn, disabled = false }: {
  period: ReportPeriod; on: string; setPeriod: (value: ReportPeriod) => void; setOn: (value: string) => void; disabled?: boolean;
}) {
  return <>
    <label>Kỳ báo cáo<select value={period} disabled={disabled} onChange={event => setPeriod(event.target.value as ReportPeriod)}>
      {Object.entries(periods).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
    </select></label>
    {period !== 'all' && <label>Ngày trong kỳ<input type="date" min="1970-01-01" max={reportDay.format(new Date())}
      value={on} disabled={disabled} onChange={event => setOn(event.target.value)}/></label>}
  </>;
}

export function CsvExport({ path, filename, label = 'Xuất CSV', snapshot = false }: {
  path: string; filename: string; label?: string; snapshot?: boolean;
}) {
  const { root } = useBusiness();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [on, setOn] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function download() {
    setPending(true);
    setError('');
    try {
      const suffix = snapshot ? '' : `${path.includes('?') ? '&' : '?'}${reportParams(period, on)}`;
      const file = await apiBlob(root + path + suffix);
      downloadFile(file, `${filename}-${snapshot ? reportDay.format(new Date()) : period + (on && period !== 'all' ? `-${on}` : '')}.csv`);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa tải được báo cáo.');
    } finally {
      setPending(false);
    }
  }

  return <>
    <button type="button" className="plain" disabled={pending} onClick={() => {
      setError('');
      if (snapshot) void download();
      else setOpen(true);
    }}><Download size={16} aria-hidden="true"/>{pending && snapshot ? 'Đang xuất…' : label}</button>
    {snapshot && error && <small className="error" role="alert">{error}</small>}
    {open && <BusinessDialog title={label} close={() => setOpen(false)} pending={pending}>
      <form onSubmit={event => { event.preventDefault(); void download(); }}>
        <div className="columns"><ReportPeriodFields period={period} on={on} setPeriod={setPeriod} setOn={setOn} disabled={pending}/></div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="button" disabled={pending}>{pending ? 'Đang xuất…' : 'Tải file CSV'}</button>
      </form>
    </BusinessDialog>}
  </>;
}
