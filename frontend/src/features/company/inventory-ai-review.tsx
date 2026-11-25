'use client';

import { useState, type FormEvent } from 'react';
import { Pager, State } from '@/components/business-ui';
import { ServicePaymentField } from '@/features/dashboard/service-payment';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { foodVariantLabel, type Product } from '@/types/catalog';
import { WarehousePicker } from './warehouse';

type WarehouseMatch = { id: string; name: string; unit: string; code?: string };
type InvoiceLine = { name: string; unit: string | null; quantity: number | null; unitCost: number | null; taxPercent: number | null };
type ReceiptLine = InvoiceLine & { item: WarehouseMatch | null; needsMatch: boolean };
export type IssueDraft = { supplier: string | null; reference: string | null; lines: InvoiceLine[] };
export type ReceiptDraft = Omit<IssueDraft, 'lines'> & { lines: ReceiptLine[] };
type MenuChoice = { id: string; name: string; label: string };
type MenuLine = { name: string; price: number; variantId: string | null; needsMatch: boolean; choices: MenuChoice[] };
export type MenuDraft = { lines: MenuLine[] };

type ReviewCallbacks = { close: () => void; done: (message: string) => void };
type RowMode = '' | 'existing' | 'new';

function ReviewActions({ pending, confirm, close }: { pending: boolean; confirm: string; close: () => void }) {
  return <div className="actions">
    <button type="submit" className="button" disabled={pending}>{pending ? 'Đang lưu…' : confirm}</button>
    <button type="button" className="plain" onClick={close} disabled={pending}>Bỏ bản nháp</button>
  </div>;
}

export function ReviewReceipt({ draft, close, done }: { draft: ReceiptDraft } & ReviewCallbacks) {
  const action = useAction();
  const [rows, setRows] = useState(() => draft.lines.map((line, index) => ({ line, index })));

  async function commit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = rows.map(({ index }) => {
      const itemId = form.get(`item-${index}`);
      return {
        ...(form.get(`mode-${index}`) === 'existing' ? { itemId } : { name: form.get(`name-${index}`) }),
        unit: form.get(`unit-${index}`),
        quantity: String(form.get(`quantity-${index}`)),
        unitCost: Number(form.get(`cost-${index}`)),
        taxBps: Math.round(Number(form.get(`tax-${index}`)) * 100),
        expiresOn: form.get(`expires-${index}`) || undefined,
      };
    });
    const result = await action.send('/warehouse/ai/receive', { supplier: form.get('supplier'),
      reference: String(form.get('reference') ?? '').trim() || undefined, method: form.get('paymentMethod'), lines }, { idempotent: true });
    if (result) done('Đã lưu phiếu nhập, cập nhật tồn kho và ghi chi.');
  }

  return <form onSubmit={commit} className="ai-review">
    <h3>Duyệt phiếu nhập kho</h3>
    <p className="muted">Kiểm tra mặt hàng, đơn vị và số lượng trước khi xác nhận. Điền thuế suất nếu hóa đơn không ghi rõ.</p>
    <fieldset disabled={action.pending} className="ai-review-fields">
      <div className="columns">
        <label>Nhà cung cấp<input name="supplier" defaultValue={draft.supplier ?? ''} maxLength={120} required/></label>
        <label>Số chứng từ<input name="reference" defaultValue={draft.reference ?? ''} maxLength={120}/></label>
      </div>
      <ServicePaymentField neutral/>
      <div className="table-wrap" tabIndex={0} aria-label="Bảng duyệt phiếu nhập kho">
        <table><thead><tr><th>Đọc từ hóa đơn</th><th>Mặt hàng kho</th><th>Số lượng</th>
          <th>Đơn giá trước thuế (đ)</th><th>Thuế (%)</th><th>Hạn dùng</th><th>Thao tác</th></tr></thead>
        <tbody>{rows.map(({ line, index }) => <ReceiptRow key={index} line={line} index={index}
          remove={rows.length > 1 ? () => setRows(rows.filter(row => row.index !== index)) : undefined}/>)}</tbody></table>
      </div>
    </fieldset>
    <ReviewActions pending={action.pending} confirm="Xác nhận nhập kho" close={close}/>
    {action.feedback}
  </form>;
}

function ReceiptRow({ line, index, remove }: { line: ReceiptLine; index: number; remove?: () => void }) {
  const [mode, setMode] = useState<RowMode>(line.item ? 'existing' : line.needsMatch ? '' : 'new');
  const [item, setItem] = useState(line.item);
  const [search, setSearch] = useState(false);

  return <tr>
    <th scope="row">{line.name}{line.unit && <small>{line.unit}</small>}</th>
    <td className="ai-review-target">
      <label>Xử lý<select name={`mode-${index}`} value={mode} required
        onChange={event => setMode(event.target.value as RowMode)}>
        <option value="">Chọn cách xử lý</option>
        <option value="existing">Cộng vào mặt hàng có sẵn</option>
        <option value="new">Tạo mặt hàng mới</option>
      </select></label>
      {mode === 'existing' && <>
        {!item || search ? <WarehousePicker initial={item ?? undefined} fieldName={`item-${index}`} onSelect={setItem}/>
          : <div className="actions"><input type="hidden" name={`item-${index}`} value={item.id}/>
            <span>{item.name} · {item.code}</span><button type="button" className="plain" onClick={() => setSearch(true)}>Đổi</button>
          </div>}
        <input type="hidden" name={`unit-${index}`} value={item?.unit ?? ''}/>
        {item && line.unit && item.unit.trim().toLocaleLowerCase('vi') !== line.unit.trim().toLocaleLowerCase('vi') &&
          <small>Kiểm tra lại số lượng theo đơn vị trong kho ({item.unit}).</small>}
      </>}
      {mode === 'new' && <div className="columns">
        <label>Tên hàng<input name={`name-${index}`} defaultValue={line.name} maxLength={120} required/></label>
        <label>Đơn vị<input name={`unit-${index}`} defaultValue={line.unit ?? ''} maxLength={32} required/></label>
      </div>}
    </td>
    <td><input aria-label={`Số lượng ${line.name}${item && mode === 'existing' ? ` (${item.unit})` : ''}`} name={`quantity-${index}`}
      type="number" min="0.001" max="999999999.999" step="0.001" defaultValue={line.quantity ?? ''} required/>
      {mode === 'existing' && item && <small>{item.unit}</small>}</td>
    <td><input aria-label={`Đơn giá ${line.name}`} name={`cost-${index}`} type="number" min="0" max="1000000000000" step="1" defaultValue={line.unitCost ?? ''} required/></td>
    <td><input aria-label={`Thuế ${line.name}`} name={`tax-${index}`} type="number" min="0" max="100" step="0.01" defaultValue={line.taxPercent ?? ''} required/></td>
    <td><input aria-label={`Hạn dùng ${line.name}`} name={`expires-${index}`} type="date"/></td>
    <td>{remove && <button type="button" className="plain" aria-label={`Bỏ dòng ${line.name}`} onClick={remove}>Bỏ dòng</button>}</td>
  </tr>;
}

export function ReviewMenu({ draft, close, done }: { draft: MenuDraft } & ReviewCallbacks) {
  const { role, membership, branch } = useBusiness();
  const shared = role === 'OWNER' || membership.canEditSharedCatalog;
  const action = useAction();
  const [rows, setRows] = useState(() => draft.lines.map((line, index) => ({ line, index })));

  async function commit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = rows.map(({ index }) => ({
      name: form.get(`name-${index}`),
      price: Number(form.get(`price-${index}`)),
      variantId: form.get(`variant-${index}`) || undefined,
    }));
    const result = await action.send('/warehouse/ai/menu', { lines }, { idempotent: true });
    if (result) done('Đã lưu thay đổi thực đơn.');
  }

  return <form onSubmit={commit} className="ai-review">
    <h3>Duyệt thực đơn</h3>
    <p className="muted">Giá sửa áp dụng tại {branch.name}.
      {shared ? ' Món mới cần bổ sung định lượng nguyên liệu trong mục Thực đơn trước khi bán.' :
        ' Quyền hiện tại cho phép sửa giá món có sẵn tại chi nhánh.'}</p>
    <fieldset disabled={action.pending} className="ai-review-fields">
      <div className="table-wrap" tabIndex={0} aria-label="Bảng duyệt thực đơn">
        <table><thead><tr><th>Đọc từ ảnh</th><th>Món trong thực đơn</th><th>Tên sau khi lưu</th><th>Giá bán (đ)</th><th>Thao tác</th></tr></thead>
          <tbody>{rows.map(({ line, index }) => <MenuRow key={index} line={line} index={index} shared={!!shared}
            remove={rows.length > 1 ? () => setRows(rows.filter(row => row.index !== index)) : undefined}/>)}</tbody></table>
      </div>
    </fieldset>
    <ReviewActions pending={action.pending} confirm="Xác nhận lưu thực đơn" close={close}/>
    {action.feedback}
  </form>;
}

function MenuRow({ line, index, shared, remove }: { line: MenuLine; index: number; shared: boolean; remove?: () => void }) {
  const [mode, setMode] = useState<RowMode>(line.variantId ? 'existing' : line.needsMatch || !shared ? '' : 'new');
  const [target, setTarget] = useState(line.choices.find(choice => choice.id === line.variantId));
  const [name, setName] = useState(target?.name ?? line.name);

  return <tr>
    <th scope="row">{line.name}</th>
    <td className="ai-review-target">
      <label>Xử lý<select value={mode} required onChange={event => {
        const next = event.target.value as RowMode;
        setMode(next);
        setName(next === 'existing' ? target?.name ?? line.name : line.name);
      }}>
        <option value="">Chọn cách xử lý</option><option value="existing">Sửa món có sẵn</option>
        {shared && <option value="new">Thêm món mới</option>}
      </select></label>
      {mode === 'existing' && <MenuPicker line={line} value={target} fieldName={`variant-${index}`} select={choice => {
        setTarget(choice); setName(choice.name);
      }}/>}
    </td>
    <td><input aria-label={`Tên sau khi lưu ${line.name}`} name={`name-${index}`} value={name} onChange={event => setName(event.target.value)}
      maxLength={120} required readOnly={!shared}/></td>
    <td><input aria-label={`Giá bán ${line.name}`} name={`price-${index}`} type="number" min="0" max="1000000000000" step="1"
      defaultValue={line.price} required/></td>
    <td>{remove && <button type="button" className="plain" aria-label={`Bỏ dòng ${line.name}`} onClick={remove}>Bỏ dòng</button>}</td>
  </tr>;
}

function MenuPicker({ line, value, fieldName, select }: {
  line: MenuLine; value?: MenuChoice; fieldName: string; select: (choice: MenuChoice) => void;
}) {
  const [search, setSearch] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const matches = useData<Product[]>(`/products?productType=FOOD&page=${page}&q=${encodeURIComponent(q)}`, undefined, search);
  const options = new Map(line.choices.map(choice => [choice.id, choice]));
  if (value) options.set(value.id, value);
  if (search) {
    for (const item of matches.data ?? []) {
      if (item.warehouseItemId || item.status !== 'ACTIVE') continue;
      item.variants.forEach((variant, index) => options.set(variant.id, { id: variant.id, name: item.name, label: foodVariantLabel(variant, index) }));
    }
  }
  return <>
    {search ? <>
      <label>Tìm món<input value={q} onChange={event => { setQ(event.target.value); setPage(1); }} maxLength={100}/></label>
      <State query={matches}/>
    </> : <button type="button" className="plain" onClick={() => setSearch(true)}>Tìm món khác</button>}
    <label>Món và phiên bản<select name={fieldName} value={value?.id ?? ''} required onChange={event => {
      const choice = options.get(event.target.value);
      if (choice) select(choice);
    }}><option value="" disabled>Chọn món</option>
      {[...options.values()].map(choice => <option key={choice.id} value={choice.id}>{choice.name} · {choice.label}</option>)}</select></label>
    {search && (page > 1 || matches.data?.length === 50) && <Pager page={page} onChange={setPage} full={matches.data?.length === 50}/>}
  </>;
}

export function ReviewIssue({ draft, close, done }: { draft: IssueDraft } & ReviewCallbacks) {
  const action = useAction();
  const [rows, setRows] = useState(() => draft.lines.map((line, index) => ({ line, index })));

  async function commit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ids = form.getAll('warehouseItemId');
    const quantities = form.getAll('quantity');
    const revisions = form.getAll('revision');
    const result = await action.send('/warehouse/ai/issue', { note: form.get('note'),
      lines: ids.map((itemId, index) => ({ itemId, quantity: String(quantities[index]), revision: Number(revisions[index]) })) },
    { idempotent: true });
    if (result) done('Đã lưu phiếu xuất kho.');
  }

  return <form onSubmit={commit}>
    <h3>Duyệt phiếu xuất kho</h3>
    <label>Lý do xuất và số chứng từ<input name="note" defaultValue={draft.reference ? `Xuất theo chứng từ ${draft.reference}`.slice(0, 120) : ''}
      maxLength={120} required/></label>
    {rows.map(({ line, index }) => <IssueRow key={index} line={line} pending={action.pending}
      remove={rows.length > 1 ? () => setRows(rows.filter(row => row.index !== index)) : undefined}/>)}
    <ReviewActions pending={action.pending} confirm="Xác nhận xuất kho" close={close}/>
    {action.feedback}
  </form>;
}

function IssueRow({ line, pending, remove }: { line: InvoiceLine; pending: boolean; remove?: () => void }) {
  const [item, setItem] = useState<{ unit: string; revision: number }>();
  return <fieldset disabled={pending}>
    <legend>{line.name}{line.unit ? ` · ${line.unit}` : ''}</legend>
    <WarehousePicker onSelect={setItem}/>
    <input type="hidden" name="revision" value={item?.revision ?? ''}/>
    <label>Số lượng{item ? ` (${item.unit})` : ''}<input type="number" name="quantity" min="0.001" max="999999999.999" step="0.001"
      defaultValue={line.quantity ?? ''} required/></label>
    {remove && <button type="button" className="plain" onClick={remove}>Bỏ dòng</button>}
  </fieldset>;
}
