'use client';

import { useState, type FormEvent } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useData } from '@/hooks/use-business';
import { downloadCsv } from '@/lib/csv';
import { currency } from '@/lib/format';

type Declaration = { id: string; name: string; taxId: string; startsOn: string; endsOn: string; taxableRevenue: number;
  outputTax: number; inputTax: number; payableTax: number; note?: string; receipt?: string; filedOn?: string };
const amounts = [
  ['taxableRevenue', 'Doanh thu tính thuế'], ['outputTax', 'Thuế đầu ra'], ['inputTax', 'Thuế đầu vào'], ['payableTax', 'Thuế phải nộp'],
] as const;

function download(entry: Declaration) {
  downloadCsv([
    ['Tên hồ sơ', entry.name], ['Mã số thuế', entry.taxId], ['Từ ngày', entry.startsOn], ['Đến ngày', entry.endsOn],
    ...amounts.map(([key, label]) => [label, entry[key]]),
    ['Ghi chú', entry.note ?? ''], ['Mã tiếp nhận', entry.receipt ?? ''], ['Ngày nộp', entry.filedOn ?? ''],
  ], `ke-khai-thue-${entry.endsOn}`);
}

export function TaxDeclarations() {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Declaration | 'new'>();
  const [filing, setFiling] = useState<Declaration>();
  const query = useData<Declaration[]>(`/tax-declarations?page=${page}`);
  return <>
    <Panel title="Hồ sơ kê khai của doanh nghiệp">
      <p className="muted">Lưu số liệu đã đối chiếu, xuất bảng làm việc và ghi mã tiếp nhận sau khi nộp trên hệ thống thuế. Nộp hồ sơ chính thức thực hiện bên ngoài JUEE POS.</p>
      <button type="button" className="button" onClick={() => setEditing('new')}>Tạo bản nháp</button>
      <State query={query}/>
      {query.data?.length === 0 && <p className="muted">Chưa có hồ sơ kê khai.</p>}
      {query.data?.map(entry => <div className="list-row" key={entry.id}>
        <div><strong>{entry.name}</strong><small>{entry.startsOn} đến {entry.endsOn} · {currency.format(entry.payableTax)}</small>
          <small>{entry.receipt ? `Đã ghi nhận nộp ${entry.filedOn} · ${entry.receipt}` : 'Bản nháp'}</small></div>
        <div className="actions">
          <button className="plain" type="button" onClick={() => download(entry)}>Tải CSV</button>
          {!entry.receipt && <>
            <button className="plain" type="button" onClick={() => setEditing(entry)}>Sửa</button>
            <button className="plain" type="button" onClick={() => setFiling(entry)}>Ghi nhận đã nộp</button>
          </>}
        </div>
      </div>)}
      {(page > 1 || query.data?.length === 50) && <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>}
    </Panel>
    {editing && <TaxForm entry={editing === 'new' ? undefined : editing} close={() => setEditing(undefined)}/>}
    {filing && <FilingForm entry={filing} close={() => setFiling(undefined)}/>}
  </>;
}

function TaxForm({ entry, close }: { entry?: Declaration; close: () => void }) {
  const action = useAction();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await action.send(entry ? `/tax-declarations/${entry.id}` : '/tax-declarations', {
      name: form.get('name'), taxId: form.get('taxId'), startsOn: form.get('startsOn'), endsOn: form.get('endsOn'), note: form.get('note'),
      ...Object.fromEntries(amounts.map(([key]) => [key, Number(form.get(key))])),
    }, { method: entry ? 'PATCH' : 'POST' });
    if (result) close();
  }
  return <BusinessDialog title="Bản nháp kê khai thuế" close={close} pending={action.pending}>
    <form onSubmit={save}>
      <div className="columns">
        <label>Tên hồ sơ<input name="name" maxLength={120} defaultValue={entry?.name} required/></label>
        <label>Mã số thuế<input name="taxId" maxLength={14} defaultValue={entry?.taxId} required/></label>
        <label>Từ ngày<input type="date" name="startsOn" defaultValue={entry?.startsOn} required/></label>
        <label>Đến ngày<input type="date" name="endsOn" defaultValue={entry?.endsOn} required/></label>
        {amounts.map(([key, label]) => <label key={key}>{label} (đ)<input type="number" name={key} min={0} max={1000000000000} step={1} defaultValue={entry?.[key]} required/></label>)}
      </div>
      <label>Ghi chú<textarea name="note" maxLength={1500} defaultValue={entry?.note}/></label>
      <button className="button" disabled={action.pending}>Lưu bản nháp</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function FilingForm({ entry, close }: { entry: Declaration; close: () => void }) {
  const action = useAction();
  return <BusinessDialog title="Ghi nhận hồ sơ đã nộp" close={close} pending={action.pending}>
    <form onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void action.send(`/tax-declarations/${entry.id}/filing`, { receipt: form.get('receipt'), filedOn: form.get('filedOn') }, { method: 'PATCH' })
        .then(result => { if (result) close(); });
    }}>
      <p className="muted">Lấy mã tiếp nhận từ nơi đã nộp hồ sơ. Hồ sơ được khóa chỉnh sửa sau khi ghi nhận.</p>
      <label>Mã tiếp nhận<input name="receipt" maxLength={120} required/></label>
      <label>Ngày nộp<input type="date" name="filedOn" required/></label>
      <button className="button" disabled={action.pending}>Xác nhận đã nộp</button>
    </form>{action.feedback}
  </BusinessDialog>;
}
