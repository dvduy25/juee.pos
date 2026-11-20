'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ClipboardCheck, Plus } from 'lucide-react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { CsvExport } from '@/components/report-period';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, date, submit, value } from '@/lib/format';
import type { Category } from '@/types/catalog';
import { usesRetail, usesTables } from '@/types/business';

type Lot = { expiresOn?: string | null; quantity: number };
type Item = { id: string; code: string; name: string; unit: string; onHand: number; minimum: number; revision: number; lots?: Lot[]; available?: number;
  barcode?: string; categoryId?: string; size?: string; color?: string; unitCost?: number; expiresOn?: string | null; countBasis?: CountBasis };
type WarehouseList = { items: Item[]; total: number; low: number; empty: number; soon: number; expired: number; today: string; soonUntil: string };
type CountBasis = { soldQuantity: number; previousCountId?: string; previousCountAt?: string; previousCountQuantity?: number };
const operations = { RECEIPT: 'Nhập kho', ISSUE: 'Xuất kho', COUNT: 'Kiểm kê' } as const;
type Operation = keyof typeof operations;
type Movement = { id: string; itemId: string; itemCode: string; itemName: string; unit: string; operation: Operation;
  correctedQuantity?: number; correctedAt?: string; referenceId?: string; unitCost?: number;
  lotsAfter?: Lot[]; correctedLots?: Lot[]; lotAllocation?: Lot[];
  before: number; after: number; note: string; actorName?: string; createdAt: string; expiresOn?: string | null; countBasis?: CountBasis };
type Selection = { item: Item; kind: 'edit' | 'move'; operation?: Operation };
const formatter = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 });
const quantity = (amount: number) => formatter.format(amount / 1000);
const expiry = (day: string) => day.split('-').reverse().join('/');
const stockLabels = { LOW: 'Sắp hết', EMPTY: 'Hết hàng', AVAILABLE: 'Còn hàng' };

function CountDifference({ difference, unit }: { difference: number; unit: string }) {
  return <span className={difference === 0 ? 'badge' : 'badge warning'}>
    {difference === 0 ? 'Khớp tồn' : `${difference < 0 ? 'Hụt' : 'Dư'} ${quantity(Math.abs(difference))} ${unit}`}
  </span>;
}

function readLotCount(form: FormData) {
  const dates = form.getAll('lotExpiry');
  const countedLots = form.getAll('lotQuantity').map((value, index) => ({ expiresOn: String(dates[index] ?? '') || null, quantity: String(value) }));
  if (!countedLots.every(lot => /^\d{1,9}(?:\.\d{1,3})?$/.test(lot.quantity))) return;
  const total = countedLots.reduce((sum, lot) => sum + Math.round(Number(lot.quantity) * 1000), 0);
  if (total <= 999_999_999_999) return { countedLots, total };
}

function LotCountFields({ lots, unit, correction = false, onTotal }: {
  lots: Lot[]; unit: string; correction?: boolean; onTotal?: (total: number | undefined) => void;
}) {
  const [rows, setRows] = useState(() => lots.map((lot, index) => ({ ...lot, key: index })));
  const nextKey = useRef(lots.length);
  const fields = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    const form = fields.current?.form;
    if (form && onTotal) onTotal(readLotCount(new FormData(form))?.total);
  }, [rows, onTotal]);
  return <fieldset ref={fields} className="warehouse-lot-count" onChange={() => {
    const form = fields.current?.form;
    if (form && onTotal) onTotal(readLotCount(new FormData(form))?.total);
  }}><legend>Kiểm kê theo hạn sử dụng</legend>
    {rows.map(lot => <div key={lot.key} className="form-grid">
      <label>Hạn sử dụng<input name="lotExpiry" type="date" max="9999-12-31" defaultValue={lot.expiresOn ?? ''}/></label>
      <label>Số đếm ({unit}){!correction && lot.quantity > 0 && <small>Tồn hệ thống {quantity(lot.quantity)}</small>}
        <input name="lotQuantity" type="number" min="0" max="999999999.999" step="0.001"
          defaultValue={correction ? lot.quantity / 1000 : undefined} required/></label>
      {lot.key >= lots.length && <button type="button" className="plain" onClick={() => setRows(current => current.filter(row => row.key !== lot.key))}>Bỏ dòng</button>}
    </div>)}
    <button type="button" className="plain" disabled={rows.length >= 500} onClick={() => {
      const key = nextKey.current++;
      setRows(previous => [...previous, { key, quantity: 0 }]);
    }}><Plus size={15}/> Thêm dòng hạn sử dụng</button>
  </fieldset>;
}

export function WarehousePicker({ onSelect, initial, fieldName = 'warehouseItemId', ingredient = false }: {
  onSelect?: (item: Item) => void; initial?: Pick<Item, 'id' | 'name' | 'unit'>; fieldName?: string; ingredient?: boolean;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(initial);
  const matches = useData<WarehouseList>(`/warehouse/items?page=${page}&q=${encodeURIComponent(q)}`);
  const items = matches.data?.items ?? [];
  return <div className="warehouse-picker">
    <label>{ingredient ? 'Tìm nguyên liệu' : 'Tìm trong kho'}<input value={q} placeholder={ingredient ? 'Tên hoặc mã nguyên liệu' : 'Tên, mã hàng hoặc mã vạch'} maxLength={120}
      onChange={event => { setQ(event.target.value); setPage(1); }}/></label>
    <State query={matches}/>
    <label>{ingredient ? 'Nguyên liệu' : 'Mặt hàng kho'}<select name={fieldName} required value={selected?.id ?? ''} onChange={event => {
      const item = items.find(item => item.id === event.target.value);
      if (item) { setSelected(item); onSelect?.(item); }
    }}><option value="" disabled>{ingredient ? 'Chọn nguyên liệu' : 'Chọn mặt hàng'}</option>
      {selected && !items.some(item => item.id === selected.id) && <option value={selected.id}>{selected.name}</option>}
      {items.map(item => <option value={item.id} key={item.id}>{item.name} · {item.code} · {quantity(item.onHand)} {item.unit}</option>)}
    </select></label>
    {(page > 1 || items.length === 50) && <Pager page={page} full={items.length === 50} onChange={setPage}/>}
  </div>;
}

export function WarehouseDashboard() {
  const { branch } = useBusiness();
  return <WarehouseWorkspace key={branch.mode} purpose={branch.mode === 'RETAIL' || usesTables(branch.mode) ? 'count' : 'general'}/>;
}

export function WarehouseCatalog() {
  return <WarehouseWorkspace purpose="catalog"/>;
}

export function WarehouseItemCreate({ close }: { close: () => void }) {
  return <ItemForm close={close} save={close} dialog/>;
}

function WarehouseWorkspace({ purpose }: { purpose: 'count' | 'catalog' | 'general' }) {
  const { branch } = useBusiness();
  const countOnly = purpose === 'count';
  const catalogOnly = purpose === 'catalog';
  const ingredient = usesTables(branch.mode) && branch.mode !== 'HYBRID';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Selection>();
  const [historyItem, setHistoryItem] = useState<Pick<Item, 'id' | 'name'>>();
  const [viewingHistory, setViewingHistory] = useState(false);
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams({ page: String(page), ...(!catalogOnly ? { alerts: 'yes' } : {}),
    ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { stock: status } : {}) });
  const query = useData<WarehouseList>(`/warehouse/items?${params}`, !catalogOnly ? 30000 : undefined, !countOnly || !viewingHistory);

  function select(item: Item, kind: Selection['kind'], operation?: Operation) {
    setSelected({ item, kind, operation });
  }

  const title = catalogOnly ? (ingredient ? 'Danh mục nguyên liệu' : 'Danh mục hàng kho') : (ingredient ? 'Kho nguyên liệu' : 'Kho hàng');
  const header = <header className="company-section-head"><div><h2>{title}</h2><p>{branch.name}</p></div>
      {countOnly ? <div className="actions business-filters" role="group" aria-label={title}>
        <button type="button" className={viewingHistory ? 'plain' : 'button'} aria-pressed={!viewingHistory} onClick={() => setViewingHistory(false)}>Kiểm kê</button>
        <button type="button" className={viewingHistory ? 'button' : 'plain'} aria-pressed={viewingHistory} onClick={() => {
          setHistoryItem(undefined); setViewingHistory(true);
        }}>Lịch sử</button>
        <button type="button" className="plain" onClick={() => setCreating(true)}><Plus size={17}/> {ingredient ? 'Thêm nguyên liệu' : 'Thêm mặt hàng'}</button>
      </div> : <button className="button" type="button" onClick={() => setSelected(undefined)}><Plus size={17}/> {ingredient ? 'Thêm nguyên liệu' : 'Thêm mặt hàng'}</button>}
    </header>;
  const addItem = creating && <WarehouseItemCreate close={() => setCreating(false)}/>;
  if (countOnly && viewingHistory) return <>{header}
    <MovementHistory key={historyItem?.id ?? 'all'} item={historyItem} clear={() => setHistoryItem(undefined)} showCountDetails/>
    {addItem}
  </>;
  return <>{header}
    {!catalogOnly && query.data && <div className="warehouse-alerts" aria-label="Cảnh báo kho">
      {([['LOW', 'Sắp hết hàng', query.data.low], ['EMPTY', 'Hết hàng còn hạn', query.data.empty],
        ['SOON', 'Sắp hết hạn · 7 ngày', query.data.soon], ['EXPIRED', 'Đã hết hạn', query.data.expired]] as const).map(([filter, label, total]) =>
        <button type="button" key={filter} aria-pressed={status === filter} onClick={() => {
          setStatus(previous => previous === filter ? '' : filter); setPage(1); setQ('');
        }}><small>{label}</small><strong>{total}</strong></button>)}
    </div>}
    <div className="company-split">
      <Panel title={countOnly ? (ingredient ? 'Nguyên liệu kiểm kê' : 'Mặt hàng kiểm kê') : 'Tồn kho'}
        action={!catalogOnly && <CsvExport path="/warehouse/export-stock" filename="juee-ton-kho" label="Xuất tồn kho CSV" snapshot/>}>
        <div className="company-filters">
          <label>Tìm mặt hàng<input value={q} maxLength={120} placeholder="Tên hoặc mã hàng kho" onChange={event => { setQ(event.target.value); setPage(1); }}/></label>
          <label>Lọc tồn kho<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
            <option value="">Tất cả</option><option value="LOW">Sắp hết</option><option value="EMPTY">Hết hàng</option>
            <option value="SOON">Sắp hết hạn</option><option value="EXPIRED">Đã hết hạn</option>
          </select></label>
        </div>
        <State query={query} empty={query.data?.items.length === 0}/>
        {query.data?.items.map(item => {
          const available = item.available ?? item.onHand;
          const stock = available === 0 ? 'EMPTY' : available <= item.minimum ? 'LOW' : 'AVAILABLE';
          return <div className="company-stock-item" key={item.id}>
            <div className="list-row"><div className="company-item"><strong>{item.name}</strong><small>{item.code}{item.barcode && ` · ${item.barcode}`}</small></div>
              <div><strong>{quantity(item.onHand)} {item.unit}</strong>
                <small>{item.unitCost != null ? `Giá nhập bình quân ${currency.format(item.unitCost)}/${item.unit}` : 'Chưa có giá nhập'}</small>
                {available !== item.onHand && <small>Còn hạn {quantity(available)} {item.unit}</small>}
                {!countOnly && <small>Ngưỡng cảnh báo {quantity(item.minimum)}</small>}</div>
              {(!countOnly || stock !== 'AVAILABLE') && <span className={stock === 'AVAILABLE' ? 'badge' : 'badge warning'}>
                {stock === 'EMPTY' && item.onHand > 0 ? 'Hết hàng còn hạn' : stockLabels[stock]}</span>}
            </div>
            {item.lots?.some(lot => lot.expiresOn) && <ul className="warehouse-lots">{item.lots.map(lot => {
              const warning = lot.expiresOn && query.data && (lot.expiresOn < query.data.today ? 'Đã hết hạn' : lot.expiresOn <= query.data.soonUntil ? 'Sắp hết hạn' : '');
              return <li key={lot.expiresOn ?? 'undated'}><span>{lot.expiresOn ? `HSD ${expiry(lot.expiresOn)}` : 'Chưa có HSD'}</span>
                <strong>{quantity(lot.quantity)} {item.unit}</strong>{warning && <span className="badge warning">{warning}</span>}</li>;
            })}</ul>}
            <div className="actions business-filters company-stock-actions">
              {purpose === 'general' && <>
                <button className="plain" type="button" onClick={() => select(item, 'move', 'RECEIPT')}><ArrowDownToLine size={15}/> Nhập</button>
                <button className="plain" type="button" onClick={() => select(item, 'move', 'ISSUE')}><ArrowUpFromLine size={15}/> Xuất</button>
              </>}
              {!catalogOnly && <button className="plain" type="button" onClick={() => select(item, 'move', 'COUNT')}><ClipboardCheck size={15}/> Kiểm kê</button>}
              {!countOnly && <button className="plain" type="button" onClick={() => select(item, 'edit')}>Sửa</button>}
              {!catalogOnly && <button className="plain" type="button" onClick={() => { setHistoryItem(item); setViewingHistory(true); }}>Lịch sử</button>}
            </div>
          </div>;
        })}
        <Pager page={page} full={query.data?.items.length === 50} onChange={setPage}/>
      </Panel>

      {selected ? <WarehouseItemAction key={`${selected.item.id}:${selected.kind}:${selected.operation}`}
        selection={selected} countOnly={countOnly} close={() => setSelected(undefined)}/> : countOnly ?
        <Panel title="Kiểm kê"><p className="muted">{ingredient ? 'Chọn nguyên liệu để đối chiếu lượng dùng chế biến và lượng thực tế.' : 'Chọn mặt hàng để đối chiếu số đã xuất và số lượng thực tế.'}</p></Panel> :
        <ItemForm close={() => setSelected(undefined)}/>}
    </div>
    {purpose === 'general' && <MovementHistory key={historyItem?.id ?? 'all'} item={historyItem} clear={() => setHistoryItem(undefined)}/>}
    {addItem}
  </>;
}

function WarehouseItemAction({ selection, countOnly, close }: { selection: Selection; countOnly: boolean; close: () => void }) {
  const [item, setItem] = useState(selection.item);
  const current = useData<Item>(`/warehouse/items/${item.id}${countOnly ? '?view=count' : ''}`, countOnly ? 8000 : undefined);
  const newer = current.data && current.data.revision > item.revision ? current.data : undefined;
  const reviewed = current.data?.revision === item.revision ? current.data : item;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (countOnly && window.matchMedia('(max-width: 790px)').matches) {
      panel.current?.scrollIntoView({ block: 'start' });
    }
  }, [countOnly]);

  return <div ref={panel} className={countOnly ? 'warehouse-count-panel' : undefined}>
    {countOnly && <State query={current}/>}
    {newer && <div className="notice company-refresh" role="status">Số liệu kho đã thay đổi.
      <button className="plain" type="button" onClick={() => setItem(newer)}>Dùng số liệu mới</button>
    </div>}
    {selection.kind === 'edit' ? <ItemForm key={item.revision} item={item} save={setItem} close={close}/> :
      <MovementForm item={reviewed} initial={selection.operation ?? 'RECEIPT'} countOnly={countOnly} stale={!!newer} save={movement =>
        setItem(previous => ({ ...previous, onHand: movement.after, revision: previous.revision + 1,
          expiresOn: undefined, lots: movement.lotsAfter,
          countBasis: countOnly ? { soldQuantity: 0, previousCountId: movement.id, previousCountAt: movement.createdAt, previousCountQuantity: movement.after } : undefined,
        }))} reload={() => void current.refetch()} close={close}/>}
  </div>;
}

function ItemForm({ item, save, close, dialog = false }: { item?: Item; save?: (item: Item) => void; close: () => void; dialog?: boolean }) {
  const action = useAction();
  const { branch } = useBusiness();
  const retail = usesRetail(branch.mode);
  const ingredient = !retail && usesTables(branch.mode);
  const categories = useData<Category[]>('/categories', undefined, retail);
  const title = item ? `Sửa · ${item.name}` : ingredient ? 'Thêm nguyên liệu' : 'Thêm mặt hàng kho';
  const fields = <>
    <form onSubmit={event => submit(event, (form, element) => {
      const payload = { name: value(form, 'name'), code: value(form, 'code'), unit: value(form, 'unit'), minimum: value(form, 'minimum'),
        ...(retail ? { barcode: value(form, 'barcode') || null, categoryId: value(form, 'category') || null,
          size: value(form, 'size') || null, color: value(form, 'color') || null } : {}),
        ...(form.has('expiresOn') ? { expiresOn: value(form, 'expiresOn') || null } : {}),
        unitCost: value(form, 'unitCost') ? amount(form, 'unitCost') : undefined };
      void action.send<Item>(item ? `/warehouse/items/${item.id}` : '/warehouse/items', { ...payload, ...(item ? { revision: item.revision } : {}) },
        { method: item ? 'PATCH' : 'POST', idempotent: !item, reset: item ? undefined : element, message: 'Đã lưu mặt hàng.' }).then(result => {
          if (result) save?.(result);
        });
    })}>
      <label>{ingredient ? 'Tên nguyên liệu' : 'Tên mặt hàng'}<input name="name" defaultValue={item?.name} maxLength={120} required/></label>
      <label>{ingredient ? 'Mã nguyên liệu' : 'Mã hàng kho'}<input name="code" defaultValue={item?.code} maxLength={60} required/></label>
      <label>Đơn vị tính<input name="unit" defaultValue={item?.unit} maxLength={32} placeholder="Ví dụ: kg, lít, hộp" required/></label>
      {retail && <><label>Mã vạch<input name="barcode" defaultValue={item?.barcode} maxLength={80} autoComplete="off"/></label>
        <label>Danh mục<select name="category" defaultValue={item?.categoryId ?? ''}><option value="">Chưa phân loại</option>
          {categories.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="columns"><label>Kích cỡ<input name="size" defaultValue={item?.size} maxLength={120}/></label>
          <label>Màu<input name="color" defaultValue={item?.color} maxLength={120}/></label></div></>}
      {(retail || ingredient) && !item?.onHand && <label>Hạn sử dụng<input name="expiresOn" type="date" max="9999-12-31" defaultValue={item?.expiresOn ?? ''}/></label>}
      <label>Giá nhập bình quân (đ/đơn vị)<input name="unitCost" type="number" min="0" max="1000000000000" step="1" defaultValue={item?.unitCost}/></label>
      <label>Ngưỡng cảnh báo<input name="minimum" type="number" min="0" max="999999999.999" step="0.001" defaultValue={(item?.minimum ?? 0) / 1000} required/></label>
      <div className="actions business-filters"><button className="button" disabled={action.pending}>Lưu mặt hàng</button>
        {item && <button className="plain" type="button" onClick={close}>Đóng</button>}</div>
    </form>{action.feedback}
  </>;
  return dialog ? <BusinessDialog title={title} close={close} pending={action.pending}>{fields}</BusinessDialog> : <Panel title={title}>{fields}</Panel>;
}

function MovementForm({ item, initial, countOnly, stale, save, reload, close }: {
  item: Item; initial: Operation; countOnly: boolean; stale: boolean; save: (movement: Movement) => void; reload: () => void; close: () => void;
}) {
  const [operation, setOperation] = useState(initial);
  const [count, setCount] = useState<number>();
  const [saved, setSaved] = useState<Movement>();
  const action = useAction();
  const { branch } = useBusiness();
  const usedLabel = branch.mode === 'HYBRID' ? 'Đã xuất bán / chế biến' : usesTables(branch.mode) ? 'Đã xuất chế biến' : 'Đã xuất bán';
  const basis = item.countBasis;
  const difference = count === undefined ? undefined : count - item.onHand;
  const isCount = operation === 'COUNT';
  const lots = item.lots?.length ? item.lots : [{ expiresOn: item.expiresOn, quantity: item.onHand }];
  return <Panel title={`${operations[operation]} · ${item.name}`}>
    {countOnly ? <dl className="warehouse-count-totals">
      {basis?.previousCountAt && basis.previousCountQuantity !== undefined && <div>
        <dt>Kiểm kê trước<small>{date(basis.previousCountAt)}</small></dt><dd>{quantity(basis.previousCountQuantity)} {item.unit}</dd>
      </div>}
      {basis && <div><dt>{usedLabel} {basis.previousCountAt ? 'từ lần kiểm kê trước' : 'từ khi theo dõi kho'}</dt>
        <dd>{quantity(basis.soldQuantity)} {item.unit}</dd></div>}
      <div><dt>Tồn theo hệ thống</dt><dd>{quantity(item.onHand)} {item.unit}</dd></div>
      <div><dt>Giá nhập bình quân</dt><dd>{item.unitCost != null ? `${currency.format(item.unitCost)}/${item.unit}` : 'Chưa có giá nhập'}</dd></div>
    </dl> : <p>Tồn đang xem <strong>{quantity(item.onHand)} {item.unit}</strong></p>}
    <form onSubmit={event => submit(event, (form, element) => {
      if (countOnly && (!basis || stale)) return;
      const counted = isCount ? readLotCount(form) : undefined;
      if (isCount && !counted) return;
      void action.send<Movement>('/warehouse/movements', { itemId: item.id, operation,
        quantity: counted ? (counted.total / 1000).toFixed(3) : value(form, 'quantity'), countedLots: counted?.countedLots,
        revision: item.revision, note: value(form, 'note') || (isCount ? 'Kiểm kê' : ''),
      }, { idempotent: true, reset: element, message: countOnly ? 'Đã lưu kiểm kê.' : 'Đã ghi nhận giao dịch kho.' })
        .then(result => { if (result) { setCount(undefined); setSaved(result); save(result); } });
    })}>
      {!countOnly && <label>Loại giao dịch<select value={operation} onChange={event => setOperation(event.target.value as Operation)}>
        {Object.entries(operations).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>}
      {isCount ? <LotCountFields key={item.revision} lots={lots} unit={item.unit} onTotal={setCount}/> : <label>Số lượng ({item.unit})
        <input name="quantity" key={operation} type="number" min="0.001" max="999999999.999" step="0.001" required/>
      </label>}
      {countOnly && <div className="warehouse-count-result" aria-live="polite">
        {difference !== undefined && !stale && <CountDifference difference={difference} unit={item.unit}/>}
      </div>}
      <label>Ghi chú<input name="note" maxLength={120} required={!countOnly}/></label>
      <div className="actions business-filters"><button className="button" disabled={action.pending || (countOnly && (!basis || stale || difference === undefined))}>
        {countOnly ? 'Lưu kiểm kê' : 'Lưu giao dịch'}</button>
        <button className="plain" type="button" disabled={action.pending} onClick={reload}>Kiểm tra tồn mới</button>
        <button className="plain" type="button" onClick={close}>Đóng</button></div>
    </form>{action.feedback}
    {countOnly && saved && <div className="notice warehouse-saved-count" role="status">
      <strong>Kết quả vừa lưu</strong><CountDifference difference={saved.after - saved.before} unit={saved.unit}/>
      <small>Tồn hệ thống {quantity(saved.before)} · Đếm thực tế {quantity(saved.after)} {saved.unit}</small>
    </div>}
  </Panel>;
}

function CountCorrection({ entry, close, save }: { entry: Movement; close: () => void; save: (entry: Movement) => void }) {
  const action = useAction();
  const current = useData<Item>(`/warehouse/items/${entry.itemId}?view=count`);
  const item = current.data;
  const editable = item?.countBasis?.previousCountId === entry.id && item.unit === entry.unit;
  const savedLots = entry.correctedLots ?? entry.lotsAfter;
  return <BusinessDialog title={`Sửa kiểm kê · ${entry.itemName}`} close={close} pending={action.pending}>
    <State query={current}/>
    {item && !editable && <p className="muted">Chỉ sửa được lần kiểm kê gần nhất theo đơn vị tính hiện tại.</p>}
    {editable && <form onSubmit={event => submit(event, form => {
      const counted = readLotCount(form);
      if (!counted) return;
      void action.send<Movement>(`/warehouse/movements/${entry.id}/count`, { quantity: (counted.total / 1000).toFixed(3), countedLots: counted.countedLots,
        note: value(form, 'note') || 'Kiểm kê', revision: item.revision }, { method: 'PATCH', idempotent: true })
        .then(result => { if (result) save(result); else void current.refetch(); });
    })}>
      <p>Tồn hệ thống lúc kiểm kê <strong>{quantity(entry.before)} {entry.unit}</strong></p>
      <LotCountFields lots={savedLots?.length ? savedLots : [{ expiresOn: entry.expiresOn, quantity: entry.correctedQuantity ?? entry.after }]}
        unit={item.unit} correction/>
      <label>Ghi chú<input name="note" defaultValue={entry.note} maxLength={120}/></label>
      <button className="button" disabled={action.pending}>Lưu số đếm</button>
    </form>}
    {action.feedback}
  </BusinessDialog>;
}

function MovementHistory({ item, clear, showCountDetails = false }: { item?: Pick<Item, 'id' | 'name'>; clear: () => void; showCountDetails?: boolean }) {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Movement>();
  const [corrected, setCorrected] = useState<Movement>();
  const { branch } = useBusiness();
  const usedLabel = branch.mode === 'HYBRID' ? 'Đã xuất bán / chế biến' : usesTables(branch.mode) ? 'Đã xuất chế biến' : 'Đã xuất bán';
  const query = useData<Movement[]>(`/warehouse/movements?page=${page}${item ? `&itemId=${item.id}` : ''}${filter ? `&count=${filter}` : ''}`);
  const exportParams = new URLSearchParams({ ...(item ? { itemId: item.id } : {}), ...(filter ? { count: filter } : {}) });
  return <Panel title={item ? `Lịch sử kho · ${item.name}` : 'Lịch sử kho'} action={<CsvExport
    path={`/warehouse/export-movements${exportParams.size ? `?${exportParams}` : ''}`} filename="juee-lich-su-kho" label="Xuất lịch sử kho CSV"/>}>
    {showCountDetails && <div className="company-filters"><label>Lọc giao dịch<select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>
      <option value="">Tất cả giao dịch</option><option value="COUNT">Mọi lần kiểm kê</option>
      <option value="SHORT">Kiểm kê hụt</option><option value="EXCESS">Kiểm kê dư</option><option value="MATCH">Kiểm kê khớp tồn</option>
    </select></label></div>}
    {item && <button className="plain" type="button" onClick={clear}>Xem tất cả mặt hàng</button>}
    {corrected && <div className="notice warehouse-saved-count" role="status"><strong>Đã sửa kiểm kê · {corrected.itemName}</strong>
      <CountDifference difference={(corrected.correctedQuantity ?? corrected.after) - corrected.before} unit={corrected.unit}/></div>}
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(entry => <div className="list-row" key={entry.id}>
      <div className="company-item"><strong>{entry.itemName}</strong><small>{entry.itemCode} · {entry.note}</small></div>
      <div><span className="badge">{entry.referenceId && entry.note === 'Điều chỉnh kiểm kê' ? entry.note : operations[entry.operation]}</span>
        {showCountDetails && entry.operation === 'COUNT' ? <>
          {entry.countBasis && <small>{usedLabel} trong kỳ {quantity(entry.countBasis.soldQuantity)} {entry.unit}</small>}
          <small>Tồn hệ thống {quantity(entry.before)} · Đếm thực tế {quantity(entry.correctedQuantity ?? entry.after)} {entry.unit}</small>
          {entry.unitCost != null && <small>Giá lúc kiểm kê {currency.format(entry.unitCost)}/{entry.unit}</small>}
          <CountDifference difference={(entry.correctedQuantity ?? entry.after) - entry.before} unit={entry.unit}/>
          {entry.correctedAt && <small>Đã sửa {date(entry.correctedAt)}</small>}
        </> : <small>{quantity(entry.before)} → {quantity(entry.after)} {entry.unit}</small>}
        {(entry.correctedLots ?? entry.lotsAfter ?? entry.lotAllocation)?.filter(lot => lot.expiresOn).map((lot, index) =>
          <small key={index}>HSD {expiry(lot.expiresOn!)} · {quantity(lot.quantity)} {entry.unit}</small>)}
        {!entry.correctedLots && !entry.lotsAfter && !entry.lotAllocation && entry.expiresOn && <small>HSD {expiry(entry.expiresOn)}</small>}</div>
      <div><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>{entry.actorName && <small>{entry.actorName}</small>}
        {showCountDetails && entry.operation === 'COUNT' && <button type="button" className="plain" onClick={() => setEditing(entry)}>Sửa số đếm</button>}</div>
    </div>)}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    {editing && <CountCorrection entry={editing} close={() => setEditing(undefined)} save={entry => { setCorrected(entry); setEditing(undefined); }}/>}
  </Panel>;
}
