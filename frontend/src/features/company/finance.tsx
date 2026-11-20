'use client';

import { useState } from 'react';
import { Download, Plus, X } from 'lucide-react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { CsvExport, ReportPeriodFields, reportParams, type ReportPeriod } from '@/components/report-period';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, date, submit, value, vietnamDateTimeInput, vietnamLocalTime } from '@/lib/format';
import { downloadCsv, downloadFile } from '@/lib/csv';
import { BillDetail } from '@/features/dashboard/sales';
import { ServicePaymentField, paymentMethodLabels, type PaymentMethod } from '@/features/dashboard/service-payment';
import { apiBlob } from '@/services/api-client';
import type { Product } from '@/types/catalog';
import type { OperatingExpenses } from '@/types/finance';
import { usesMemberships, usesRetail, usesTables } from '@/types/business';
import { PayrollReceipt } from './payroll';
import { WarehouseCatalog, WarehousePicker } from './warehouse';

type Totals = { count: number; total: number; tax: number };
type AccountingRow = Pick<Totals, 'count' | 'total'> & { label: string; tax?: number };
type Receipt = { id: string; supplier: string; reference?: string; createdAt: string; method: PaymentMethod; totalAmount: number;
  subtotal: number; taxAmount: number; lines: { itemId: string; name: string; unit: string; quantity: number; unitCost: number; subtotal: number; taxAmount: number;
    expiresOn?: string | null }[] };
type Promotion = { id: string; name: string; kind: 'PERCENT' | 'FIXED'; value: number; minimum: number;
  startsAt: string; endsAt: string; enabled: boolean; productIds?: string[] };
type JournalEntry = { id: string; occurredAt: string; direction: 'IN' | 'OUT'; method?: PaymentMethod; amount: number;
  note: string; source: string; category?: string; billId?: string; payrollPaymentId?: string; payrollMembershipId?: string };
type Ledger = { opening: number; income: number; expenses: number; closing: number; items: JournalEntry[] };

const journalLabels: Record<string, string> = {
  MANUAL: 'Ghi thủ công', SALE: 'Thu hóa đơn', HOTEL: 'Thu tiền phòng',
  TICKET: 'Thu bán vé', TICKET_REFUND: 'Hoàn vé', MEMBER: 'Thu phí hội viên', PURCHASE: 'Chi nhập hàng', REFUND: 'Hoàn tiền', PAYROLL: 'Chi trả lương',
};
const expenseLabels = { STAFF: 'Tiền nhân viên', RENT: 'Tiền mặt bằng', UTILITIES: 'Điện nước', OTHER: 'Chi phí khác' };

function TaxField({ initial = 0, label = 'Thuế (%)' }: { initial?: number; label?: string }) {
  return <label>{label}<input name="tax" type="number" min={0} max={100} step={0.01} defaultValue={initial / 100} required/></label>;
}

function PurchaseLine({ trackExpiry, ingredient, remove }: { trackExpiry: boolean; ingredient: boolean; remove?: () => void }) {
  const [cost, setCost] = useState('');
  const [itemId, setItemId] = useState('');
  return <fieldset>
    <legend>{ingredient ? 'Nguyên liệu nhập' : 'Mặt hàng nhập'}</legend>
    <WarehousePicker ingredient={ingredient} onSelect={item => { setItemId(item.id); setCost(item.unitCost === undefined ? '' : String(item.unitCost)); }}/>
    <div className="form-grid form-grid-business">
      <label>Số lượng<input name="quantity" type="number" min="0.001" max="999999999.999" step="0.001" defaultValue="1" required/></label>
      <label>Giá nhập trước thuế (đ/đơn vị)<input name="unitCost" type="number" min="0" max="1000000000000"
        step="1" required value={cost} onChange={event => setCost(event.target.value)}/></label>
      <TaxField/>
      {trackExpiry && <label>Hạn sử dụng<input key={itemId} name="expiresOn" type="date" max="9999-12-31"/></label>}
    </div>
    {remove && <button className="plain" type="button" onClick={remove}><X size={15}/> Bỏ dòng</button>}
  </fieldset>;
}

function PurchaseForm({ close, trackExpiry, ingredient }: { close: () => void; trackExpiry: boolean; ingredient: boolean }) {
  const [lines, setLines] = useState([0]);
  const [number, setNumber] = useState(1);
  const action = useAction();
  return <BusinessDialog title="Lập phiếu nhập hàng" close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      const quantities = form.getAll('quantity');
      const costs = form.getAll('unitCost');
      const rates = form.getAll('tax');
      const expiryDates = form.getAll('expiresOn');
      void action.send('/purchases', {
        supplier: value(form, 'supplier'), reference: value(form, 'reference') || undefined, method: value(form, 'paymentMethod'),
        lines: form.getAll('warehouseItemId').map((itemId, index) => ({ itemId, quantity: String(quantities[index]),
          unitCost: Number(costs[index]), taxBps: Math.round(Number(rates[index]) * 100), expiresOn: expiryDates[index] || undefined })),
      }, { idempotent: true }).then(result => { if (result) close(); });
    })}>
      <div className="columns"><label>Nhà cung cấp<input name="supplier" maxLength={120} required/></label>
        <label>Số chứng từ<input name="reference" maxLength={120}/></label></div>
      <ServicePaymentField neutral/>
      {lines.map(line => <PurchaseLine key={line} trackExpiry={trackExpiry} ingredient={ingredient}
        remove={lines.length > 1 ? () => setLines(lines.filter(id => id !== line)) : undefined}/>)}
      <div className="actions business-filters">
        <button type="button" className="plain" disabled={lines.length >= 30} onClick={() => {
          setLines([...lines, number]); setNumber(number + 1);
        }}><Plus size={16}/> {ingredient ? 'Thêm dòng nguyên liệu' : 'Thêm mặt hàng'}</button>
        <button className="button" disabled={action.pending}>Ghi nhận nhập hàng và chi tiền</button>
      </div>
    </form>{action.feedback}
  </BusinessDialog>;
}

function PurchaseReceiptLines({ receipt }: { receipt: Receipt }) {
  return <>
    <p className="muted">{date(receipt.createdAt)} · {paymentMethodLabels[receipt.method]}{receipt.reference && ` · ${receipt.reference}`}</p>
    {receipt.lines.map(line => <div className="list-row" key={`${line.itemId}:${line.expiresOn ?? ''}`}><div>{line.name}<small>{line.quantity / 1000} {line.unit}</small>
      {line.expiresOn && <small>HSD {line.expiresOn.split('-').reverse().join('/')}</small>}</div>
      <div><strong>{currency.format(line.subtotal + line.taxAmount)}</strong><small>{currency.format(line.unitCost)}/{line.unit}</small>
        <small>Thuế {currency.format(line.taxAmount)}</small></div></div>)}
    <div className="list-row">Trước thuế <strong>{currency.format(receipt.subtotal)}</strong></div>
    <div className="list-row">Thuế nhập <strong>{currency.format(receipt.taxAmount)}</strong></div>
    <div className="list-row">Tổng chi <strong>{currency.format(receipt.totalAmount)}</strong></div>
  </>;
}

function PurchaseExpenseDetail({ id }: { id: string }) {
  const receipt = useData<Receipt>(`/purchases/${id}`);
  return <><State query={receipt}/>{receipt.data && <PurchaseReceiptLines receipt={receipt.data}/>}</>;
}

export function Purchases() {
  const { branch } = useBusiness();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [catalog, setCatalog] = useState(false);
  const inventory = usesRetail(branch.mode) || usesTables(branch.mode);
  const ingredient = usesTables(branch.mode) && branch.mode !== 'HYBRID';
  const query = useData<Receipt[]>(`/purchases?page=${page}`, undefined, !catalog);
  if (catalog) return <>
    <button type="button" className="plain" onClick={() => setCatalog(false)}>Về phiếu nhập hàng</button>
    <WarehouseCatalog/>
  </>;
  return <Panel title="Phiếu nhập hàng" action={<div className="actions business-filters">
    {inventory && <button type="button" className="plain" onClick={() => setCatalog(true)}>{ingredient ? 'Danh mục nguyên liệu' : 'Danh mục hàng kho'}</button>}
    <CsvExport path="/purchases/export" filename="juee-nhap-hang" label="Xuất nhập hàng CSV"/>
    <button type="button" className="button" onClick={() => setCreating(true)}><Plus size={17}/> Lập phiếu nhập</button>
  </div>}>
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => <details className="business-details" key={item.id}><summary>
      <strong>{item.supplier}</strong> · {currency.format(item.totalAmount)}
    </summary>
      <PurchaseReceiptLines receipt={item}/>
    </details>)}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
    {creating && <PurchaseForm trackExpiry={inventory} ingredient={ingredient} close={() => { setCreating(false); setPage(1); }}/>}
  </Panel>;
}

export function Promotions() {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('PERCENT');
  const [targeted, setTargeted] = useState(false);
  const [search, setSearch] = useState('');
  const [productPage, setProductPage] = useState(1);
  const [selected, setSelected] = useState(new Map<string, string>());
  const query = useData<Promotion[]>(`/retail-promotions?page=${page}`);
  const products = useData<Pick<Product, 'id' | 'name' | 'variants'>[]>(`/products?productType=RETAIL&page=${productPage}&q=${encodeURIComponent(search)}`, undefined, targeted);
  const action = useAction();

  function selectProduct(id: string, name?: string) {
    setSelected(previous => {
      const next = new Map(previous);
      if (name === undefined) next.delete(id);
      else next.set(id, name);
      return next;
    });
  }

  return <div className="service-split"><Panel title="Khuyến mãi bán lẻ">
    <State query={query} empty={query.data?.length === 0}/>
    {query.data?.map(item => <div className="list-row service-list-row" key={item.id}>
      <div><strong>{item.name}</strong>
        <small>{item.kind === 'PERCENT' ? `Giảm ${item.value}%` : `Giảm ${currency.format(item.value)}`} · Đơn từ {currency.format(item.minimum)}</small>
        <small>{item.productIds ? `Áp dụng cho ${item.productIds.length} sản phẩm` : 'Áp dụng toàn đơn'}</small>
        <small>{date(item.startsAt)} → {date(item.endsAt)}</small>
      </div>
      <button type="button" className="plain" disabled={action.pending} onClick={() => void action.send(`/retail-promotions/${item.id}`,
        { enabled: !item.enabled }, { method: 'PATCH' })}>{item.enabled ? 'Tắt' : 'Bật'}</button>
    </div>)}
    <Pager page={page} full={query.data?.length === 50} onChange={setPage}/>
  </Panel><Panel title="Tạo khuyến mãi">
    <form onSubmit={event => submit(event, (form, element) => {
      if (targeted && !selected.size) return;
      const startsAt = new Date(`${value(form, 'from')}+07:00`);
      const endsAt = new Date(`${value(form, 'to')}+07:00`);
      if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) return;
      void action.send('/retail-promotions', { name: value(form, 'name'), kind,
        value: amount(form, 'value'), minimum: amount(form, 'minimum'), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), enabled: true,
        ...(targeted ? { productIds: [...selected.keys()] } : {}) }, { reset: element }).then(result => {
        if (!result) return;
        setPage(1);
        setTargeted(false);
        setSelected(new Map());
        setSearch('');
        setProductPage(1);
      });
    })}>
      <label>Tên chương trình<input name="name" maxLength={120} required/></label>
      <div className="columns"><label>Loại giảm<select value={kind} onChange={event => setKind(event.target.value)}>
        <option value="PERCENT">Phần trăm</option><option value="FIXED">Tiền cố định</option>
      </select></label><label>Mức giảm ({kind === 'PERCENT' ? '%' : 'đ'})<input key={kind} name="value" type="number"
        min={1} max={kind === 'PERCENT' ? 100 : 1000000000000} step={1} required/></label></div>
      <label>Phạm vi áp dụng<select value={targeted ? 'PRODUCTS' : 'ORDER'} onChange={event => setTargeted(event.target.value === 'PRODUCTS')}>
        <option value="ORDER">Toàn đơn</option><option value="PRODUCTS">Sản phẩm được chọn</option>
      </select></label>
      {targeted && <fieldset><legend>Sản phẩm áp dụng · {selected.size} đã chọn</legend>
        {selected.size > 0 && <details className="business-details"><summary>Xem sản phẩm đã chọn</summary><div className="promotion-product-list">
          {[...selected].map(([id, name]) => <div className="list-row" key={id}><span>{name}</span>
            <button type="button" className="plain" onClick={() => selectProduct(id)}>Bỏ</button></div>)}
        </div></details>}
        <label>Tìm sản phẩm<input type="search" value={search} maxLength={100} onChange={event => { setSearch(event.target.value); setProductPage(1); }}/></label>
        <State query={products} empty={products.data?.length === 0}/>
        <div className="promotion-product-list">{products.data?.map(item => {
          const sku = item.variants[0]?.sku;
          const name = sku ? `${item.name} · ${sku}` : item.name;
          return <label className="check" key={item.id}>
            <input type="checkbox" checked={selected.has(item.id)} disabled={!selected.has(item.id) && selected.size >= 500}
              onChange={event => selectProduct(item.id, event.target.checked ? name : undefined)}/>{name}
          </label>;
        })}</div>
        {(productPage > 1 || products.data?.length === 50) && <Pager page={productPage} full={products.data?.length === 50} onChange={setProductPage}/>}
      </fieldset>}
      <label>Đơn tối thiểu (đ)<input name="minimum" type="number" min={0} max={1000000000000} step={1} defaultValue={0} required/></label>
      <label>Bắt đầu (giờ Việt Nam)<input name="from" type="datetime-local" required/></label>
      <label>Kết thúc (giờ Việt Nam)<input name="to" type="datetime-local" required/></label>
      <button className="button" disabled={action.pending || (targeted && !selected.size)}>Tạo khuyến mãi</button>
    </form>{action.feedback}
  </Panel></div>;
}

export function Accounting() {
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [on, setOn] = useState('');
  const { branch } = useBusiness();
  const retail = usesRetail(branch.mode);
  const membership = usesMemberships(branch.mode);
  type ServiceTotals = Pick<Totals, 'count' | 'total'>;
  const query = useData<{ sales: Totals; purchases: Totals; memberPayments: ServiceTotals;
    hotelPayments: ServiceTotals; ticketPayments: ServiceTotals; ticketRefunds: ServiceTotals; payrollPayments: ServiceTotals;
    operatingExpenses: OperatingExpenses; taxBps: number }>(
    `/accounting?${reportParams(period, on)}`);
  const profitQuery = useData<{ profitBeforeTax: number; adjustedProfit: { amount: number; provisional: boolean };
    cash: { operatingExpenses: OperatingExpenses } }>(`/reports?${reportParams(period, on)}&view=company`);
  const action = useAction();
  const report = query.data;
  const profit = profitQuery.data;
  const profitLabel = profit?.adjustedProfit.provisional ? 'Lợi nhuận trước thuế (tạm tính)' : 'Lợi nhuận trước thuế';
  const showMemberPayments = !!report && (membership || report.memberPayments.count > 0);
  const rows: AccountingRow[] = report ? [
    { label: 'Hóa đơn POS chưa hủy', ...report.sales },
    ...(showMemberPayments ? [{ label: 'Phiếu thu gói hội viên', ...report.memberPayments }] : []),
    ...(branch.mode === 'HOTEL' || report.hotelPayments.count ? [{ label: 'Phiếu thu tiền phòng', ...report.hotelPayments }] : []),
    ...(branch.mode === 'TICKETS' || report.ticketPayments.count ? [{ label: 'Phiếu thu bán vé', ...report.ticketPayments }] : []),
    ...(branch.mode === 'TICKETS' || report.ticketRefunds.count ? [{ label: 'Phiếu chi hoàn vé', ...report.ticketRefunds }] : []),
    { label: 'Phiếu nhập hàng', ...report.purchases },
    ...report.operatingExpenses.items.flatMap(item => {
      if (item.kind !== 'STAFF' || !report.payrollPayments?.count) return [item];
      const payroll = report.payrollPayments;
      const otherStaff = { label: 'Chi phí nhân viên khác', count: item.count - payroll.count, total: item.total - payroll.total };
      return [{ label: 'Lương nhân viên đã trả', ...payroll }, ...(otherStaff.count ? [otherStaff] : [])];
    }),
  ] : [];
  function download() {
    downloadCsv([['Chứng từ', 'Số lượng', 'Trước thuế', 'Thuế', 'Tổng'],
      ...rows.map(row => [row.label, row.count, row.tax === undefined ? '' : row.total - row.tax, row.tax ?? '', row.total]),
      ...(profit ? [[], ['Chỉ tiêu', 'Số tiền (đ)'], ['Lãi sau kiểm kê', profit.adjustedProfit.amount],
        ['Chi phí vận hành', profit.cash.operatingExpenses.total], [profitLabel, profit.profitBeforeTax]] : []),
    ], `juee-ke-toan-${period}${on && period !== 'all' ? `-${on}` : ''}`);
  }
  return <div className={retail ? 'service-split' : undefined}><Panel title="Tổng hợp chứng từ" action={<div className="actions business-filters">
    <ReportPeriodFields period={period} on={on} setPeriod={setPeriod} setOn={setOn}/>
    <button className="plain" type="button" disabled={!report || profitQuery.isLoading} onClick={download}><Download size={16} aria-hidden="true"/> Xuất CSV</button>
  </div>}>
    <State query={query}/>
    {report && <div className="table-wrap"><table><thead><tr><th>Chứng từ</th><th>Số lượng</th><th>Trước thuế</th><th>Thuế</th><th>Tổng</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.count}</td>
        <td>{row.tax === undefined ? '—' : currency.format(row.total - row.tax)}</td>
        <td>{row.tax === undefined ? '—' : currency.format(row.tax)}</td><td>{currency.format(row.total)}</td></tr>)}</tbody></table></div>}
    {report && <div className="list-row"><strong>Tổng chi phí vận hành</strong><strong>{currency.format(report.operatingExpenses.total)}</strong></div>}
    <State query={profitQuery}/>
    {profit && <div className="list-row"><div><strong>{profitLabel}</strong>
      <small>{currency.format(profit.adjustedProfit.amount)} lãi sau kiểm kê − {currency.format(profit.cash.operatingExpenses.total)} chi phí vận hành</small>
    </div><strong>{currency.format(profit.profitBeforeTax)}</strong></div>}
    <p className="muted">Chi phí vận hành tính theo ngày thực chi và được trừ khi tính lợi nhuận. Cột thuế để trống với các phiếu chưa tách thuế.</p>
    <p className="muted">Hóa đơn POS tính theo ngày lập và giá trị trước hoàn tiền.</p>
  </Panel>{retail && <Panel title="Thuế bán lẻ">
    {report && <form key={report.taxBps} onSubmit={event => submit(event, form => void action.send('/accounting/tax',
      { taxBps: Math.round(amount(form, 'tax') * 100) }, { method: 'PATCH' }))}>
      <TaxField initial={report.taxBps} label="Thuế cộng sau giảm giá (%)"/>
      <button className="button" disabled={action.pending}>Lưu mức thuế</button>
    </form>}{action.feedback}
  </Panel>}
  </div>;
}

export function Cashbook() {
  const { root } = useBusiness();
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [on, setOn] = useState('');
  const [page, setPage] = useState(1);
  const [method, setMethod] = useState('');
  const [selected, setSelected] = useState<JournalEntry>();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const filters = reportParams(period, on);
  if (method) filters.set('method', method);
  const query = useData<Ledger>(`/cashbook?${filters}&page=${page}`);
  const ledger = query.data;

  async function download() {
    setExporting(true);
    setExportError('');
    try {
      const file = await apiBlob(`${root}/cashbook/export?${filters}`);
      downloadFile(file, `juee-so-quy-${period}${on && period !== 'all' ? `-${on}` : ''}${method ? `-${method.toLowerCase()}` : ''}.csv`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Chưa tải được sổ quỹ.');
    } finally {
      setExporting(false);
    }
  }

  return <div className="service-split"><Panel title="Sổ quỹ" action={<div className="actions business-filters">
    <ReportPeriodFields period={period} on={on} setPeriod={value => { setPeriod(value); setPage(1); }} setOn={value => { setOn(value); setPage(1); }}/>
    <label>Quỹ<select value={method} onChange={event => { setMethod(event.target.value); setPage(1); }}>
      <option value="">Tất cả</option><option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option>
    </select></label>
    <button className="plain" type="button" onClick={() => void download()} disabled={!ledger || exporting}>
      <Download size={16} aria-hidden="true"/>{exporting ? 'Đang xuất…' : 'Xuất CSV'}</button>
  </div>}>
    <State query={query} empty={ledger?.items.length === 0}/>
    {exportError && <p className="error" role="alert">{exportError}</p>}
    {ledger && <div className="company-metrics">
      <div><small>Đầu kỳ</small><strong>{currency.format(ledger.opening)}</strong></div>
      <div><small>Tổng thu</small><strong>{currency.format(ledger.income)}</strong></div>
      <div><small>Tổng chi</small><strong>{currency.format(ledger.expenses)}</strong></div>
      <div><small>Cuối kỳ</small><strong>{currency.format(ledger.closing)}</strong></div>
    </div>}
    {ledger?.items.map(item => <div className="list-row service-list-row" key={`${item.source}:${item.id}`}>
      <div><strong>{item.note}</strong><small>{item.category ?? journalLabels[item.source]} · {date(item.occurredAt)}</small>
        <small>{item.method ? paymentMethodLabels[item.method] : 'Không rõ phương thức'}</small></div>
      <div className="actions">
        <strong>{item.direction === 'IN' ? '+' : '−'}{currency.format(item.amount)}</strong>
        {item.billId && <button type="button" className="plain" onClick={() => setSelected(item)}
          aria-label={`Xem hóa đơn ${item.billId.slice(-8).toUpperCase()}`}>Xem hóa đơn</button>}
        {item.source === 'MEMBER' && <button type="button" className="plain" onClick={() => setSelected(item)}>Xem phiếu thu</button>}
        {item.direction === 'OUT' && !item.billId && <button type="button" className="plain" onClick={() => setSelected(item)}>
          {item.source === 'PURCHASE' ? 'Xem phiếu nhập' : item.source === 'PAYROLL' ? 'Xem phiếu lương' : 'Xem phiếu chi'}</button>}
      </div>
    </div>)}
    <Pager page={page} full={ledger?.items.length === 50} onChange={setPage}/>
    {selected && <BusinessDialog title={selected.source === 'MANUAL' ? `Phiếu chi #${selected.id.slice(-8).toUpperCase()}` : journalLabels[selected.source]}
      close={() => setSelected(undefined)}>
      <div className="list-row"><div><strong>{selected.note}</strong>{selected.source !== 'PURCHASE' && selected.source !== 'PAYROLL' && <small>{date(selected.occurredAt)}</small>}
        {selected.category && <small>{selected.category}</small>}
        {selected.source !== 'PURCHASE' && selected.source !== 'PAYROLL' && selected.method && <small>{paymentMethodLabels[selected.method]}</small>}</div>
        {selected.source !== 'PAYROLL' && <strong>{selected.direction === 'IN' ? '+' : '−'}{currency.format(selected.amount)}</strong>}</div>
      {selected.billId && <BillDetail key={selected.billId} id={selected.billId} cashbook/>}
      {selected.source === 'PURCHASE' && <PurchaseExpenseDetail id={selected.id}/>}
      {selected.payrollMembershipId && selected.payrollPaymentId &&
        <PayrollReceipt path={`/payroll/${selected.payrollMembershipId}/payments/${selected.payrollPaymentId}`}/>}
    </BusinessDialog>}
  </Panel><Panel title="Ghi phiếu thu hoặc chi">
    <CashEntryForm saved={occurredAt => {
      if (period !== 'all') setOn(vietnamLocalTime(occurredAt).slice(0, 10));
      setPage(1);
    }}/>
  </Panel></div>;
}

function CashEntryForm({ saved }: { saved: (occurredAt: string) => void }) {
  const action = useAction();
  const [direction, setDirection] = useState('IN');
  const isExpense = direction === 'OUT';
  return <>
    <form onSubmit={event => submit(event, (form, element) => {
      const occurredAt = value(form, 'occurredAt');
      void action.send<{ occurredAt?: string; createdAt: string }>('/cashbook', { direction,
        method: value(form, 'paymentMethod'), amount: amount(form, 'amount'), note: value(form, 'note'),
        ...(isExpense ? { expenseKind: value(form, 'expenseKind') } : { category: value(form, 'category') }),
        ...(occurredAt && { occurredAt: vietnamDateTimeInput(occurredAt) }),
      }, { idempotent: true, reset: element, message: 'Đã ghi sổ.' }).then(result => {
        if (result) saved(result.occurredAt ?? result.createdAt);
      });
    })}>
      <label>Loại phiếu<select value={direction} onChange={event => setDirection(event.target.value)}>
        <option value="IN">Thu</option><option value="OUT">Chi</option></select></label>
      <ServicePaymentField neutral/>
      <label>Số tiền (đ)<input name="amount" type="number" min={1} max={1000000000000} step={1} required/></label>
      {isExpense ? <label>Nhóm chi phí<select name="expenseKind" defaultValue="OTHER" required>
        <option value="" disabled>Chọn nhóm chi phí</option>
        {Object.entries(expenseLabels).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}
      </select></label> :
        <label>Nhóm thu<input name="category" placeholder="Ví dụ: Tiền mặt đầu kỳ" maxLength={120} required/></label>}
      <label>{isExpense ? 'Thời điểm thực chi' : 'Thời điểm thực thu'} (giờ Việt Nam)
        <input type="datetime-local" name="occurredAt" min="1970-01-01T07:00"/><small>Để trống để ghi nhận theo giờ hiện tại.</small></label>
      <label>Nội dung<input name="note" maxLength={120} required/></label>
      <button className="button" disabled={action.pending}>Ghi sổ</button>
    </form>{action.feedback}
  </>;
}
