'use client';

import { useLanguage } from '@/i18n/language';
import { useState } from 'react';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useData } from '@/hooks/use-business';
import { amount, currency, submit, value } from '@/lib/format';
import { tableState, type BuffetPackage, type BuffetRates, type DiningTable, type TableResponse } from '@/types/business';
import type { Product } from '@/types/catalog';
import { TableDiscounts } from '@/features/dashboard/sales';

export function TableSettings() {
  const { t } = useLanguage();
  const query = useData<TableResponse>('/tables');
  const action = useAction();
  const [editing, setEditing] = useState<DiningTable>();
  const [removing, setRemoving] = useState<DiningTable>();
  const areas = query.data?.areas ?? [];
  return <><div className="columns"><Panel title={t("Bàn và khu vực")}>
    <State query={query} empty={query.data?.tables.length === 0}/>
    {query.data?.tables.map(table => <div className="list-row" key={table.id}>
      <div><strong>{table.name}</strong><small>{areas.find(area => area.id === table.areaId)?.name ?? 'Khu vực chung'} · {t(tableState(table).label)}</small></div>
      <div className="actions"><button className="plain" disabled={action.pending || !!table.sessionId} onClick={() => { setEditing(table); setRemoving(undefined); }}>{t("Sửa")}</button>
        <button className="plain" disabled={action.pending || !!table.sessionId || table.reserved} onClick={() => setRemoving(table)}>{t("Xóa")}</button></div>
    </div>)}
    {removing && <div className="notice"><p>{t("Xóa bàn")} <strong>{removing.name}</strong> {t("và hủy mã QR của bàn này?")}</p>
      <div className="actions"><button className="button" disabled={action.pending} onClick={() => void action.send(`/tables/${removing.id}`, undefined,
        { method: 'DELETE', message: 'Đã xóa bàn.' }).then(result => { if (result) { if (editing?.id === removing.id) setEditing(undefined); setRemoving(undefined); } })}>{t("Xác nhận xóa")}</button>
        <button className="plain" disabled={action.pending} onClick={() => setRemoving(undefined)}>{t("Quay lại")}</button></div></div>}
    {action.feedback}
  </Panel>{query.isSuccess && <Panel title={editing ? t("Sửa bàn") : t("Thêm bàn")}>
    <form key={editing?.id ?? 'new'} onSubmit={event => submit(event, (form, element) => {
      const areaId = value(form, 'area');
      void action.send(editing ? `/tables/${editing.id}` : '/tables', { name: value(form, 'name'), areaId: areaId || (editing ? null : undefined) },
        { method: editing ? 'PATCH' : 'POST', reset: editing ? undefined : element, message: editing ? 'Đã lưu thông tin bàn.' : 'Đã thêm bàn.' })
        .then(result => { if (result && editing) setEditing(undefined); });
    })}>
      <label>{t("Tên bàn")}<input name="name" required maxLength={120} defaultValue={editing?.name}/></label>
      <label>{t("Khu vực")}<select name="area" defaultValue={editing?.areaId ?? ''}><option value="">{t("Khu vực chung")}</option>
        {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
      <div className="actions"><button className="button" disabled={action.pending}>{editing ? t("Lưu bàn") : t("Thêm bàn")}</button>
        {editing && <button type="button" className="plain" disabled={action.pending} onClick={() => setEditing(undefined)}>{t("Hủy sửa")}</button>}</div>
    </form>
    <form onSubmit={event => submit(event, (form, element) => void action.send('/table-areas', { name: value(form, 'name') },
      { reset: element, message: 'Đã thêm khu vực.' }))}>
      <label>{t("Tên khu vực")}<input name="name" required maxLength={120}/></label>
      <button className="plain" disabled={action.pending}>{t("Thêm khu vực")}</button>
    </form>
  </Panel>}</div>{query.isSuccess && <TableDiscounts/>}</>;
}

type PackageProduct = Pick<Product, 'id' | 'name' | 'status' | 'productType'>;

export function BuffetSettings() {
  const { t } = useLanguage();
  const query = useData<{ packages: BuffetPackage[]; products: PackageProduct[]; previousRates?: BuffetRates }>('/buffet-packages');
  const [editing, setEditing] = useState<BuffetPackage>();
  const [formVersion, setFormVersion] = useState(0);
  const action = useAction();
  return <div className="columns"><Panel title={t("Gói buffet tại chi nhánh")}>
    <State query={query} empty={query.data?.packages.length === 0}/>
    {query.data?.packages.map(pack => <div className="list-row" key={pack.id}>
      <div><strong>{pack.name}</strong><small>{currency.format(pack.adultPrice)} {t("người lớn ·")} {currency.format(pack.childPrice)} {t("trẻ em")}</small>
        <small>{pack.productIds.length} {t("món ·")} {pack.enabled ? t("Đang dùng") : t("Ngừng dùng")}</small></div>
      <button className="plain" type="button" disabled={action.pending} onClick={() => { setEditing(pack); setFormVersion(version => version + 1); }}>{t("Sửa gói")}</button>
    </div>)}
  </Panel>{query.data && <Panel title={editing ? `Sửa ${editing.name}` : t("Tạo gói buffet")}>
    <BuffetPackageForm key={formVersion} pack={editing} previousRates={query.data.packages.length ? undefined : query.data.previousRates}
      known={query.data.products} pending={action.pending} save={input => {
      void action.send(editing ? `/buffet-packages/${editing.id}` : '/buffet-packages', input,
        { method: editing ? 'PATCH' : 'POST', message: 'Đã lưu gói buffet.' }).then(result => {
        if (result) { setEditing(undefined); setFormVersion(version => version + 1); }
      });
    }}/>
    {editing && <button className="plain" type="button" disabled={action.pending} onClick={() => { setEditing(undefined); setFormVersion(version => version + 1); }}>{t("Hủy sửa")}</button>}
    {action.feedback}
  </Panel>}</div>;
}

function BuffetPackageForm({ pack, known, pending, save, previousRates }: {
  pack?: BuffetPackage; known: PackageProduct[]; pending: boolean; save: (input: Omit<BuffetPackage, 'id'>) => void; previousRates?: BuffetRates;
}) {
  const { t } = useLanguage();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const menu = useData<PackageProduct[]>(`/products?productType=FOOD&page=${page}&q=${encodeURIComponent(q)}`);
  const [selected, setSelected] = useState(() => new Map(pack?.productIds.map(id => [id, known.find(item => item.id === id)?.name ?? 'Món đã ngừng bán'])));
  function toggle(item: PackageProduct, checked: boolean) {
    setSelected(previous => {
      const next = new Map(previous);
      if (checked) next.set(item.id, item.name);
      else next.delete(item.id);
      return next;
    });
  }
  return <form onSubmit={event => submit(event, form => save({ name: value(form, 'name'), adultPrice: amount(form, 'adultPrice'),
    childPrice: amount(form, 'childPrice'), productIds: [...selected.keys()], enabled: form.has('enabled') }))}>
    <label>{t("Tên gói")}<input name="name" defaultValue={pack?.name} maxLength={120} required/></label>
    <div className="form-grid form-grid-business">
      <label>{t("Người lớn (đ/khách)")}<input type="number" name="adultPrice" min={1} max={1000000000000} defaultValue={pack?.adultPrice ?? previousRates?.adultPrice} required/></label>
      <label>{t("Trẻ em (đ/khách)")}<input type="number" name="childPrice" min={0} max={1000000000000} defaultValue={pack?.childPrice ?? previousRates?.childPrice ?? 0} required/></label>
    </div>
    <label className="check"><input name="enabled" type="checkbox" defaultChecked={pack?.enabled ?? true}/> {t("Cho phép chọn khi mở bàn")}</label>
    <fieldset><legend>{t("Món trong gói ·")} {selected.size} {t("đã chọn")}</legend>
      {!!selected.size && <details className="business-details"><summary>{t("Xem món đã chọn")}</summary><div className="table-ordered-items">
        {[...selected].map(([id, name]) => <div className="list-row" key={id}><span>{name}</span>
          <button className="plain" type="button" onClick={() => setSelected(previous => new Map([...previous].filter(([itemId]) => itemId !== id)))}>{t("Bỏ món")}</button></div>)}
      </div></details>}
      <label>{t("Tìm món")}<input value={q} maxLength={100} onChange={event => { setQ(event.target.value); setPage(1); }}/></label>
      <State query={menu} empty={menu.data?.length === 0}/>
      <div className="table-ordered-items">{menu.data?.map(item => <label className="check" key={item.id}>
        <input type="checkbox" checked={selected.has(item.id)} disabled={!selected.has(item.id) && selected.size >= 500}
          onChange={event => toggle(item, event.target.checked)}/>{item.name}
      </label>)}</div>
      {(page > 1 || menu.data?.length === 50) && <Pager page={page} full={menu.data?.length === 50} onChange={setPage}/>}
    </fieldset>
    <button className="button" disabled={pending || selected.size === 0}>{t("Lưu gói buffet")}</button>
  </form>;
}
