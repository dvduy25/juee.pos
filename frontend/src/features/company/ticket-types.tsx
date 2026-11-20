'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Panel, State } from '@/components/business-ui';
import { useAction, useData } from '@/hooks/use-business';
import { amount, currency, date, submit, value, vietnamDateTimeInput, vietnamLocalTime } from '@/lib/format';
import type { TicketType } from '@/types/tickets';

const windowFields = [
  ['saleStartsAt', 'Mở bán'], ['saleEndsAt', 'Ngừng bán'],
  ['admissionStartsAt', 'Bắt đầu vào cửa'], ['admissionEndsAt', 'Kết thúc vào cửa'],
] as const;

export function TicketTypes() {
  const query = useData<TicketType[]>('/ticket-types');
  const [editor, setEditor] = useState<TicketType | 'new'>();
  const [notice, setNotice] = useState('');
  return <Panel title="Danh sách loại vé" action={<button type="button" className="button" onClick={() => { setNotice(''); setEditor('new'); }}><Plus size={17}/> Thêm loại vé</button>}>
    <State query={query} empty={query.data?.length === 0}/>
    {notice && <p className="success" role="status">{notice}</p>}
    {query.data?.map(type => <div className="list-row" key={type.id}>
      <div><strong>{type.name}</strong><small>{currency.format(type.price)} · Đã bán {type.sold}
        {type.capacity != null && `/${type.capacity} vé · Còn ${type.remaining} vé`}</small>
        {type.earlyUntil && type.earlyPrice != null && <small>Giá mua sớm {currency.format(type.earlyPrice)} đến {date(type.earlyUntil)}</small>}</div>
      <button type="button" className="plain" onClick={() => { setNotice(''); setEditor(type); }}>Sửa loại vé</button>
    </div>)}
    {editor && <TicketTypeEditor type={editor === 'new' ? undefined : editor} close={() => setEditor(undefined)}
      saved={name => { setNotice(`Đã lưu loại vé ${name}.`); setEditor(undefined); }}/>}
  </Panel>;
}

function TicketTypeEditor({ type, close, saved }: { type?: TicketType; close: () => void; saved: (name: string) => void }) {
  const action = useAction();
  return <BusinessDialog title={type ? `Sửa ${type.name}` : 'Thêm loại vé'} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      const timestamp = (field: string) => {
        const raw = value(form, field);
        return raw ? vietnamDateTimeInput(raw) : null;
      };
      const optionalAmount = (field: string) => value(form, field) ? amount(form, field) : null;
      void action.send<TicketType>(type ? `/ticket-types/${type.id}` : '/ticket-types',
        { name: value(form, 'name'), price: amount(form, 'price'), active: form.has('active'),
          capacity: optionalAmount('capacity'), earlyPrice: optionalAmount('earlyPrice'), earlyUntil: timestamp('earlyUntil'),
          ...Object.fromEntries(windowFields.map(([field]) => [field, timestamp(field)])) },
        { method: type ? 'PATCH' : 'POST' }).then(result => { if (result) saved(result.name); });
    })}>
      <label>Tên loại vé<input name="name" defaultValue={type?.name} maxLength={120} required/></label>
      <div className="columns">
        <label>Giá vé (đ)<input name="price" type="number" min={0} max={1000000000000} defaultValue={type?.price} required/></label>
        <label>Số vé tối đa<input name="capacity" type="number" min={1} max={1000000} placeholder="Không giới hạn" defaultValue={type?.capacity ?? ''}/></label>
      </div>
      <p className="muted">Giờ Việt Nam. Để trống mốc thời gian nếu không giới hạn.</p>
      <div className="columns">{windowFields.map(([field, caption]) => <label key={field}>{caption}
        <input name={field} type="datetime-local" defaultValue={type?.[field] ? vietnamLocalTime(type[field]) : ''}/>
      </label>)}</div>
      <div className="columns">
        <label>Giá mua sớm (đ)<input name="earlyPrice" type="number" min={0} max={1000000000000} defaultValue={type?.earlyPrice ?? ''}/></label>
        <label>Hết giá mua sớm<input name="earlyUntil" type="datetime-local" defaultValue={type?.earlyUntil ? vietnamLocalTime(type.earlyUntil) : ''}/></label>
      </div>
      <label className="check"><input name="active" type="checkbox" defaultChecked={type?.active ?? true}/> Cho phép bán</label>
      <button type="submit" className="button" disabled={action.pending}>Lưu loại vé</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

