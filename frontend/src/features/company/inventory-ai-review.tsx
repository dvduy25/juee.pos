'use client';

import { useLanguage } from '@/i18n/language';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, ClipboardCheck, Trash2 } from 'lucide-react';
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

type ReviewProps = { close: () => void; done: (message: string) => void; photo?: ReactNode };
type RowMode = '' | 'existing' | 'new';

function ReviewActions({ pending, confirm, close }: { pending: boolean; confirm: string; close: () => void }) {
  const { t } = useLanguage();
  return <div className="ai-review-actions">
    <button type="button" className="plain ai-secondary" onClick={close} disabled={pending}>{t("Bỏ bản nháp")}</button>
    <button type="submit" className="button ai-main-action" disabled={pending}><Check size={18} aria-hidden="true"/>{pending ? t("Đang lưu…") : confirm}</button>
  </div>;
}

function ReviewHeader({ title, children }: { title: string; children: ReactNode }) {
  return <header className="ai-workspace-head">
    <span className="ai-icon"><ClipboardCheck size={24} aria-hidden="true"/></span>
    <div><h2>{title}</h2><p>{children}</p></div>
  </header>;
}

function ReviewLineHeader({ name, unit, status, attention, remove }: {
  name: string; unit?: string | null; status?: string; attention?: boolean; remove?: () => void;
}) {
  const { t } = useLanguage();
  return <header className="ai-review-line-head">
    <div><h4>{name}</h4>{(unit || status) && <p data-attention={!!attention}>{[unit, status].filter(Boolean).join(' · ')}</p>}</div>
    {remove && <button type="button" className="icon" aria-label={t("Bỏ dòng {0}", name)} title={t("Bỏ dòng")}
      onClick={remove}><Trash2 size={17} aria-hidden="true"/></button>}
  </header>;
}

export function ReviewReceipt({ draft, close, done, photo }: { draft: ReceiptDraft } & ReviewProps) {
  const { t } = useLanguage();
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
    <ReviewHeader title={t("Duyệt phiếu nhập kho")}>{t("Kiểm tra mặt hàng, đơn vị và số lượng. Điền thuế suất nếu hóa đơn không ghi rõ.")}</ReviewHeader>
    {photo}
    <fieldset disabled={action.pending} className="ai-review-fields">
      <div className="ai-review-meta">
        <label>{t("Nhà cung cấp")}<input name="supplier" defaultValue={draft.supplier ?? ''} maxLength={120} required/></label>
        <label>{t("Số chứng từ")}<input name="reference" defaultValue={draft.reference ?? ''} maxLength={120}/></label>
        <ServicePaymentField neutral/>
      </div>
      <div className="ai-review-list">
        <h3>{rows.length} {t("mặt hàng đề xuất")}</h3>
        {rows.map(({ line, index }) => <ReceiptRow key={index} line={line} index={index}
          remove={rows.length > 1 ? () => setRows(rows.filter(row => row.index !== index)) : undefined}/>)}
      </div>
    </fieldset>
    <ReviewActions pending={action.pending} confirm="Xác nhận nhập kho" close={close}/>
    {action.feedback}
  </form>;
}

function ReceiptRow({ line, index, remove }: { line: ReceiptLine; index: number; remove?: () => void }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<RowMode>(line.item ? 'existing' : line.needsMatch ? '' : 'new');
  const [item, setItem] = useState(line.item);
  const [search, setSearch] = useState(false);

  return <article className="ai-review-line">
    <ReviewLineHeader name={line.name} unit={line.unit} status={mode === 'new' ? 'Tạo mặt hàng mới'
      : mode === 'existing' && item ? 'Cộng vào tồn kho' : 'Cần chọn mặt hàng'} attention={!mode || mode === 'existing' && !item} remove={remove}/>
    <div className="ai-review-target">
      <label>{t("Xử lý")}<select name={`mode-${index}`} value={mode} required
        onChange={event => setMode(event.target.value as RowMode)}>
        <option value="">{t("Chọn cách xử lý")}</option>
        <option value="existing">{t("Cộng vào mặt hàng có sẵn")}</option>
        <option value="new">{t("Tạo mặt hàng mới")}</option>
      </select></label>
      {mode === 'existing' && <>
        {!item || search ? <WarehousePicker initial={item ?? undefined} fieldName={`item-${index}`} onSelect={setItem}/>
          : <div className="ai-matched-item"><input type="hidden" name={`item-${index}`} value={item.id}/>
            <span>{item.name}{item.code && ` · ${item.code}`}</span><button type="button" className="plain" onClick={() => setSearch(true)}>{t("Đổi")}</button>
          </div>}
        <input type="hidden" name={`unit-${index}`} value={item?.unit ?? ''}/>
        {item && line.unit && item.unit.trim().toLocaleLowerCase('vi') !== line.unit.trim().toLocaleLowerCase('vi') &&
          <p className="ai-line-warning">{t("Kiểm tra lại số lượng theo đơn vị trong kho (")}{item.unit}).</p>}
      </>}
      {mode === 'new' && <div className="ai-new-item">
        <label>{t("Tên hàng")}<input name={`name-${index}`} defaultValue={line.name} maxLength={120} required/></label>
        <label>{t("Đơn vị")}<input name={`unit-${index}`} defaultValue={line.unit ?? ''} maxLength={32} required/></label>
      </div>}
    </div>
    <div className="ai-receipt-values">
      <label>{t("Số lượng")}{item && mode === 'existing' ? ` (${item.unit})` : ''}<input name={`quantity-${index}`}
        type="number" min="0.001" max="999999999.999" step="0.001" defaultValue={line.quantity ?? ''} required/></label>
      <label>{t("Đơn giá trước thuế (đ)")}<input name={`cost-${index}`} type="number" min="0" max="1000000000000" step="1" defaultValue={line.unitCost ?? ''} required/></label>
      <label>{t("Thuế (%)")}<input name={`tax-${index}`} type="number" min="0" max="100" step="0.01" defaultValue={line.taxPercent ?? ''} required/></label>
      <label>{t("Hạn dùng")}<input name={`expires-${index}`} type="date"/></label>
    </div>
  </article>;
}

export function ReviewMenu({ draft, close, done, photo }: { draft: MenuDraft } & ReviewProps) {
  const { t } = useLanguage();
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
    <ReviewHeader title={t("Duyệt thực đơn")}>{t("Giá sửa áp dụng tại")} {branch.name}.
      {shared ? t("Món mới cần bổ sung định lượng nguyên liệu trong mục Thực đơn trước khi bán.") :
        t("Quyền hiện tại cho phép sửa giá món có sẵn tại chi nhánh.")}</ReviewHeader>
    {photo}
    <fieldset disabled={action.pending} className="ai-review-fields">
      <div className="ai-review-list">
        <h3>{rows.length} {t("món đề xuất")}</h3>
        {rows.map(({ line, index }) => <MenuRow key={index} line={line} index={index} shared={!!shared}
          remove={rows.length > 1 ? () => setRows(rows.filter(row => row.index !== index)) : undefined}/>)}
      </div>
    </fieldset>
    <ReviewActions pending={action.pending} confirm="Xác nhận lưu thực đơn" close={close}/>
    {action.feedback}
  </form>;
}

function MenuRow({ line, index, shared, remove }: { line: MenuLine; index: number; shared: boolean; remove?: () => void }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<RowMode>(line.variantId ? 'existing' : line.needsMatch || !shared ? '' : 'new');
  const [target, setTarget] = useState(line.choices.find(choice => choice.id === line.variantId));
  const [name, setName] = useState(target?.name ?? line.name);

  return <article className="ai-review-line">
    <ReviewLineHeader name={line.name} status={mode === 'new' ? 'Thêm món mới'
      : mode === 'existing' && target ? 'Sửa món có sẵn' : 'Cần chọn món'} attention={!mode || mode === 'existing' && !target} remove={remove}/>
    <div className="ai-review-target">
      <label>{t("Xử lý")}<select value={mode} required onChange={event => {
        const next = event.target.value as RowMode;
        setMode(next);
        setName(next === 'existing' ? target?.name ?? line.name : line.name);
      }}>
        <option value="">{t("Chọn cách xử lý")}</option><option value="existing">{t("Sửa món có sẵn")}</option>
        {shared && <option value="new">{t("Thêm món mới")}</option>}
      </select></label>
      {mode === 'existing' && <MenuPicker line={line} value={target} fieldName={`variant-${index}`} select={choice => {
        setTarget(choice); setName(choice.name);
      }}/>}
    </div>
    <div className="ai-menu-values">
      <label>{t("Tên sau khi lưu")}<input name={`name-${index}`} value={name} onChange={event => setName(event.target.value)}
        maxLength={120} required readOnly={!shared}/></label>
      <label>{t("Giá bán (đ)")}<input name={`price-${index}`} type="number" min="0" max="1000000000000" step="1"
        defaultValue={line.price} required/></label>
    </div>
  </article>;
}

function MenuPicker({ line, value, fieldName, select }: {
  line: MenuLine; value?: MenuChoice; fieldName: string; select: (choice: MenuChoice) => void;
}) {
  const { t } = useLanguage();
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
      <label>{t("Tìm món")}<input value={q} onChange={event => { setQ(event.target.value); setPage(1); }} maxLength={100}/></label>
      <State query={matches}/>
    </> : <button type="button" className="plain" onClick={() => setSearch(true)}>{t("Tìm món khác")}</button>}
    <label>{t("Món và phiên bản")}<select name={fieldName} value={value?.id ?? ''} required onChange={event => {
      const choice = options.get(event.target.value);
      if (choice) select(choice);
    }}><option value="" disabled>{t("Chọn món")}</option>
      {[...options.values()].map(choice => <option key={choice.id} value={choice.id}>{choice.name} · {choice.label}</option>)}</select></label>
    {search && (page > 1 || matches.data?.length === 50) && <Pager page={page} onChange={setPage} full={matches.data?.length === 50}/>}
  </>;
}

export function ReviewIssue({ draft, close, done, photo }: { draft: IssueDraft } & ReviewProps) {
  const { t } = useLanguage();
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

  return <form onSubmit={commit} className="ai-review">
    <ReviewHeader title={t("Duyệt phiếu xuất kho")}>{t("Chọn mặt hàng trong kho và kiểm tra số lượng trước khi xác nhận.")}</ReviewHeader>
    {photo}
    <fieldset disabled={action.pending} className="ai-review-fields">
      <label>{t("Lý do xuất và số chứng từ")}<input name="note" defaultValue={draft.reference ? `Xuất theo chứng từ ${draft.reference}`.slice(0, 120) : ''}
        maxLength={120} required/></label>
      <div className="ai-review-list">
        <h3>{rows.length} {t("mặt hàng đề xuất")}</h3>
        {rows.map(({ line, index }) => <IssueRow key={index} line={line}
          remove={rows.length > 1 ? () => setRows(rows.filter(row => row.index !== index)) : undefined}/>)}
      </div>
    </fieldset>
    <ReviewActions pending={action.pending} confirm="Xác nhận xuất kho" close={close}/>
    {action.feedback}
  </form>;
}

function IssueRow({ line, remove }: { line: InvoiceLine; remove?: () => void }) {
  const { t } = useLanguage();
  const [item, setItem] = useState<{ unit: string; revision: number }>();
  return <article className="ai-review-line">
    <ReviewLineHeader name={line.name} unit={line.unit} status={item ? 'Xuất từ kho' : 'Cần chọn mặt hàng'} attention={!item} remove={remove}/>
    <WarehousePicker onSelect={setItem}/>
    <input type="hidden" name="revision" value={item?.revision ?? ''}/>
    <label>{t("Số lượng")}{item ? ` (${item.unit})` : ''}<input type="number" name="quantity" min="0.001" max="999999999.999" step="0.001"
      defaultValue={line.quantity ?? ''} required/></label>
  </article>;
}
