'use client';

import { useLanguage } from '@/i18n/language';
import { useState } from 'react';
import { submit, value } from '@/lib/format';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useData } from '@/hooks/use-business';

export function Customers() {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const query = useData<{ id: string; name: string; phone: string }[]>(`/customers?page=${page}&q=${encodeURIComponent(q)}`);
  const action = useAction();
  return <div className="columns"><Panel title="Danh sách khách hàng"><label>Tìm kiếm<input value={q} maxLength={80} onChange={event => {
    setQ(event.target.value); setPage(1);
  }}/></label><State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => <div className="list-row" key={item.id}><strong>{item.name}</strong><span>{item.phone}</span></div>)}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
  </Panel><Panel title="Thêm khách hàng"><form onSubmit={event => submit(event, (form, element) => void action.send('/customers',
    { name: value(form, 'name'), phone: value(form, 'phone') }, { reset: element }))}>
    <label>Họ tên<input name="name" required maxLength={120}/></label><label>{t("Số điện thoại")}<input name="phone" type="tel" required maxLength={16}/></label>
    <button className="button" disabled={action.pending}>Lưu khách hàng</button>
  </form>{action.feedback}</Panel></div>;
}
