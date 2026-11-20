'use client';

import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, date, submit, value, vietnamLocalTime } from '@/lib/format';
import { paymentMethodLabels, ServicePaymentField, type PaymentMethod } from '@/features/dashboard/service-payment';

type Period = { from: string; to: string };
type Worker = { id: string; name: string; position?: string; archivedAt?: string };
type Rate = { effectiveOn: string; unit: 'HOUR' | 'SHIFT'; rate: number; overtimeRate: number; shiftMinutes?: number };
type Line = Omit<Rate, 'effectiveOn'> & { day: string; label: string; attendanceIds: string[]; regularMinutes: number;
  overtimeMinutes: number; baseAmount: number; overtimeAmount: number };
type Preview = { employee: Worker; lines: Line[]; rates: Rate[]; amount: number; baseAmount: number; overtimeAmount: number;
  regularMinutes: number; overtimeMinutes: number; revision: string;
  skipped: { alreadyPaid: number; open: number; noRate: number; noShift: number; invalid: number } };
type Payment = Period & { id: string; paidAt: string; amount: number; method: PaymentMethod };

const dayLabel = (day: string) => day.split('-').reverse().join('/');
const duration = (minutes: number) => `${Math.floor(minutes / 60)} giờ${minutes % 60 ? ` ${minutes % 60} phút` : ''}`;
const rateUnit = (unit: Rate['unit']) => unit === 'HOUR' ? 'giờ' : 'ca';

export function StaffPayroll() {
  const { branch } = useBusiness();
  const today = vietnamLocalTime().slice(0, 10);
  const [period, setPeriod] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [workerId, setWorkerId] = useState('');
  const valid = !!period.from && !!period.to && period.from <= period.to && period.to <= today &&
    (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 < 62;
  const workers = useData<Worker[]>(`/payroll/workers?${new URLSearchParams({ ...period, page: String(page), q: search })}`, undefined, valid);
  return <>
    <Panel title={`Tính lương · ${branch.name}`}>
      <div className="company-filters">
        <label>Từ ngày<input type="date" min="1970-01-01" max={today} value={period.from}
          onChange={event => { setPeriod({ ...period, from: event.target.value }); setPage(1); }}/></label>
        <label>Đến ngày<input type="date" min="1970-01-01" max={today} value={period.to}
          onChange={event => { setPeriod({ ...period, to: event.target.value }); setPage(1); }}/></label>
        <label>Tìm nhân viên<input type="search" value={search} maxLength={120} placeholder="Tên hoặc chức vụ"
          onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
      </div>
      {valid ? <State query={workers} empty={workers.data?.length === 0}/> :
        <p className="notice">Chọn kỳ tối đa 62 ngày, đến hết hôm nay.</p>}
      {valid && workers.data?.map(worker => <div className="list-row" key={worker.id}>
        <div><strong>{worker.name}</strong>{worker.position && <small>{worker.position}</small>}
          {worker.archivedAt && <small>Hồ sơ đã lưu trữ</small>}</div>
        <button type="button" className="plain" aria-pressed={worker.id === workerId} onClick={() => setWorkerId(worker.id)}>
          {worker.id === workerId ? 'Đang xem' : 'Xem bảng lương'}
        </button>
      </div>)}
      {valid && (page > 1 || workers.data?.length === 50) && <Pager page={page} full={workers.data?.length === 50} onChange={setPage}/>}
    </Panel>
    {valid && workerId && <EmployeePayroll key={workerId} workerId={workerId} period={period}/>}
  </>;
}

function EmployeePayroll({ workerId, period }: { workerId: string; period: Period }) {
  const { role } = useBusiness();
  const [editing, setEditing] = useState<Rate | 'new'>();
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState('');
  const [paymentId, setPaymentId] = useState<string>();
  const [page, setPage] = useState(1);
  const path = `/payroll/${workerId}`;
  const query = useData<Preview>(`${path}?${new URLSearchParams(period)}`);
  const history = useData<Payment[]>(`${path}/payments?page=${page}`);
  const data = query.data;
  const manage = role === 'OWNER' || role === 'MANAGER';
  const warnings = data && [
    [data.skipped.open, 'ca/lượt chưa kết thúc'], [data.skipped.noRate, 'ca/lượt thiếu đơn giá'],
    [data.skipped.noShift, 'lượt thiếu lịch ca để tính theo ca'], [data.skipped.invalid, 'ca/lượt thiếu thời gian tính lương'],
    [data.skipped.alreadyPaid, 'ca/lượt đã trả'],
  ].filter(([count]) => !!count).map(([count, label]) => `${count} ${label}`).join(' · ');
  return <>
    <Panel title={data ? `Bảng lương · ${data.employee.name}` : 'Bảng lương'} action={manage && data &&
      <button type="button" className="plain" onClick={() => setEditing('new')}>Cài đơn giá</button>}>
      <State query={query}/>
      {notice && <p className="success" role="status">{notice}</p>}
      {data && <>
        <div className="company-metrics">
          <div><small>Lương thường · {duration(data.regularMinutes)}</small><strong>{currency.format(data.baseAmount)}</strong></div>
          <div><small>Tăng ca · {duration(data.overtimeMinutes)}</small><strong>{currency.format(data.overtimeAmount)}</strong></div>
          <div><small>Tổng chưa trả trong kỳ</small><strong>{currency.format(data.amount)}</strong></div>
        </div>
        {warnings && <p className="muted">{warnings}.</p>}
        {data.lines.length > 0 ? <PayrollLines lines={data.lines}/> : <p className="muted">Chưa có khoản lương chờ trả trong kỳ.</p>}
        {manage && data.amount > 0 && <button type="button" className="button" onClick={() => setPaying(true)}>Chốt lương</button>}
        <details>
          <summary>Lịch sử đơn giá</summary>
          {!data.rates.length && <p className="muted">Chưa cài đơn giá.</p>}
          {data.rates.map(rate => <div className="list-row" key={rate.effectiveOn}>
            <div><strong>Từ {dayLabel(rate.effectiveOn)}</strong><small>{currency.format(rate.rate)}/{rateUnit(rate.unit)}
              {rate.shiftMinutes && ` · ${duration(rate.shiftMinutes)}/ca`}
              {' · '}Tăng ca {currency.format(rate.overtimeRate)}/giờ</small></div>
            {manage && <button type="button" className="plain" onClick={() => setEditing(rate)}>Sửa</button>}
          </div>)}
        </details>
      </>}
    </Panel>
    <Panel title="Lịch sử trả lương">
      <State query={history} empty={history.data?.length === 0}/>
      {history.data?.map(item => <div className="list-row" key={item.id}>
        <div><strong>{currency.format(item.amount)}</strong><small>{date(item.paidAt)} · {paymentMethodLabels[item.method]}</small>
          <small>Kỳ {dayLabel(item.from)} – {dayLabel(item.to)}</small></div>
        <button type="button" className="plain" onClick={() => setPaymentId(item.id)}>Xem chi tiết</button>
      </div>)}
      {(page > 1 || history.data?.length === 20) && <Pager page={page} full={history.data?.length === 20} onChange={setPage}/>}
    </Panel>
    {editing && <RateEditor path={path} startingDay={period.from} rate={editing === 'new' ? undefined : editing}
      close={() => setEditing(undefined)} saved={() => { setEditing(undefined); setNotice('Đã lưu đơn giá.'); }}/>}
    {paying && data && <PayDialog path={path} period={period} preview={data} close={() => setPaying(false)}
      saved={() => { setPaying(false); setPage(1); setNotice('Đã chốt lương, lập phiếu chi trong Sổ quỹ và ghi chi phí nhân viên trong Thuế & kế toán.'); }}/>}
    {paymentId && <PaymentDetail path={`${path}/payments/${paymentId}`} close={() => setPaymentId(undefined)}/>}
  </>;
}

function PaymentDetail({ path, close }: { path: string; close: () => void }) {
  return <BusinessDialog title="Chi tiết phiếu lương" close={close}>
    <PayrollReceipt path={path}/>
  </BusinessDialog>;
}

export function PayrollReceipt({ path }: { path: string }) {
  const query = useData<Payment & { lines: Line[] }>(path);
  const payment = query.data;
  return <>
    <State query={query}/>
    {payment && <>
      <p>Kỳ lương {dayLabel(payment.from)} – {dayLabel(payment.to)}</p>
      <p>{date(payment.paidAt)} · {paymentMethodLabels[payment.method]} · <strong>{currency.format(payment.amount)}</strong></p>
      <PayrollLines lines={payment.lines}/>
    </>}
  </>;
}

function PayrollLines({ lines }: { lines: Line[] }) {
  return <div className="table-wrap"><table>
    <thead><tr><th>Ngày công</th><th>Thời gian thường</th><th>Lương thường</th><th>Tăng ca</th><th>Tiền tăng ca</th></tr></thead>
    <tbody>{lines.map(line => <tr key={line.attendanceIds[0]}>
      <th scope="row">{dayLabel(line.day)}<small>{line.label}</small></th>
      <td>{duration(line.regularMinutes)}{line.shiftMinutes && <small>Chuẩn {duration(line.shiftMinutes)}/ca</small>}</td>
      <td>{currency.format(line.baseAmount)}<small>{currency.format(line.rate)}/{rateUnit(line.unit)}</small></td>
      <td>{duration(line.overtimeMinutes)}</td><td>{currency.format(line.overtimeAmount)}<small>{currency.format(line.overtimeRate)}/giờ</small></td>
    </tr>)}</tbody>
  </table></div>;
}

function RateEditor({ path, rate, startingDay, close, saved }: { path: string; rate?: Rate; startingDay: string; close: () => void; saved: () => void }) {
  const action = useAction();
  const [unit, setUnit] = useState<Rate['unit']>(rate?.unit ?? 'HOUR');
  return <BusinessDialog title="Đơn giá lương" close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      void action.send(`${path}/rate`, { effectiveOn: value(form, 'effectiveOn'), unit, rate: amount(form, 'rate'),
        overtimeRate: amount(form, 'overtimeRate'),
        ...(unit === 'SHIFT' && { shiftMinutes: amount(form, 'shiftHours') * 60 + amount(form, 'shiftExtraMinutes') }),
      }, { method: 'PATCH' }).then(result => { if (result) saved(); });
    })}>
      <label>Áp dụng từ ngày<input type="date" name="effectiveOn" min="1970-01-01" defaultValue={rate?.effectiveOn ?? startingDay} required/></label>
      <label>Cách trả lương<select value={unit} onChange={event => setUnit(event.target.value as Rate['unit'])}>
        <option value="HOUR">Theo giờ</option><option value="SHIFT">Theo ca</option>
      </select></label>
      {unit === 'SHIFT' && <fieldset>
        <legend>Thời lượng một ca</legend>
        <div className="columns">
          <label>Số giờ<input name="shiftHours" type="number" min={0} max={24} step={1}
            defaultValue={Math.floor((rate?.shiftMinutes ?? 480) / 60)} required/></label>
          <label>Số phút lẻ<input name="shiftExtraMinutes" type="number" min={0} max={59} step={1}
            defaultValue={(rate?.shiftMinutes ?? 480) % 60} required/></label>
        </div>
        <small>Tính đủ đơn giá khi làm đủ thời lượng một ca. Làm ít hơn tính theo tỷ lệ thời gian thực tế. Phần vượt tính tăng ca.</small>
      </fieldset>}
      <div className="columns">
        <label>Lương thường (đ/{rateUnit(unit)})<input type="number" name="rate" min={1} max={1000000000000} defaultValue={rate?.rate} required/></label>
        <label>Tăng ca (đ/giờ)<input type="number" name="overtimeRate" min={1} max={1000000000000} defaultValue={rate?.overtimeRate} required/></label>
      </div>
      {unit === 'HOUR' && <p className="muted">Tăng ca tính sau giờ kết thúc đã xếp cho từng ngày.</p>}
      <button type="submit" className="button" disabled={action.pending}>Lưu đơn giá</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function PayDialog({ path, period, preview, close, saved }: { path: string; period: Period; preview: Preview; close: () => void; saved: () => void }) {
  const action = useAction();
  return <BusinessDialog title="Chốt lương và ghi đã trả" close={close} pending={action.pending}>
    <p>{preview.employee.name} · {dayLabel(period.from)} – {dayLabel(period.to)}</p>
    <div className="list-row"><span>Số tiền đã trả</span><strong>{currency.format(preview.amount)}</strong></div>
    <p className="muted">Sổ quỹ và Thuế & kế toán ghi khoản chi này theo ngày xác nhận.</p>
    <form onSubmit={event => submit(event, form => {
      void action.send(`${path}/payments`, { ...period, expectedAmount: preview.amount, expectedRevision: preview.revision,
        method: value(form, 'paymentMethod') }, { idempotent: true }).then(result => { if (result) saved(); });
    })}>
      <ServicePaymentField neutral/>
      <button type="submit" className="button" disabled={action.pending}>Xác nhận chốt lương</button>
    </form>{action.feedback}
  </BusinessDialog>;
}
