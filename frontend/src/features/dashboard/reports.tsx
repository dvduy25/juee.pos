'use client';

import { useLanguage } from '@/i18n/language';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Pager, Panel, State } from '@/components/business-ui';
import { reportDay, reportParams, ReportPeriodFields, type ReportPeriod } from '@/components/report-period';
import { useBusiness, useData } from '@/hooks/use-business';
import { downloadCsv } from '@/lib/csv';
import { currency } from '@/lib/format';
import { usesMemberships, usesRetail, usesTables, type Branch } from '@/types/business';
import type { OperatingExpenses } from '@/types/finance';
import { paymentMethodLabels, type PaymentMethod } from './service-payment';

type Profit = { salesBeforeTax: number; refundsBeforeTax: number; netSales: number; retailCost: number;
  buffetEstimate: number; restockedCost: number; invoiceCount: number };
type AdjustedProfit = { amount: number; margin: number | null; ingredientCost: number; missingCostLines: number;
  provisional: boolean; needsBuffetCount: boolean };
type ValuationStatus = 'RECORDED' | 'ESTIMATED' | 'PARTIAL' | 'MISSING';
type InventoryItem = { id: string; name: string; unit: string; sold: number; used: number; manualReceipts: number; shortage: number; excess: number;
  shortageValue: number | null; excessValue: number | null; shortageStatus: ValuationStatus; excessStatus: ValuationStatus; currentUnitCost?: number | null };
type Inventory = { checks: number; shortChecks: number; excessChecks: number; shortageValue: number | null; excessValue: number | null;
  unpricedCounts: number; estimatedCounts: number; items: InventoryItem[] };
type PurchaseReport = { count: number; subtotal: number; tax: number; total: number; items: {
  id: string; name: string; unit: string; quantity: number; subtotal: number; tax: number; total: number;
}[] };
type SaleItem = { id: string; name: string; unit: string; quantity: number; amount: number };
type CashRow = { source: string; direction: 'IN' | 'OUT'; method?: PaymentMethod; amount: number };
type Cash = { income: number; expenses: number; net: number; operatingExpenses: OperatingExpenses; breakdown: CashRow[];
  series: { _id: string; income: number; expenses: number }[] };
type Report = { start: string; end: string; gross: number; refunded: number; revenue: number; orders: number; processing: number;
  profit: Profit; adjustedProfit: AdjustedProfit; profitBeforeTax: number; recognizedRevenue: number; serviceRevenue: number; memberRevenue: number;
  inventory: Inventory; purchases: PurchaseReport; cash: Cash; salesItems: SaleItem[] };

const units = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 });
const percent = new Intl.NumberFormat('vi-VN', { style: 'percent', maximumFractionDigits: 1 });
const displayDay = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' });
const valuationLabels = { RECORDED: '', ESTIMATED: 'Có phần ước tính', PARTIAL: 'Thiếu một phần giá nhập', MISSING: 'Chưa có giá nhập' };
const sourceLabels: Record<string, string> = { SALE: 'Bán hàng', HOTEL: 'Tiền phòng', TICKET: 'Bán vé', MEMBER: 'Thu phí hội viên',
  PURCHASE: 'Nhập hàng', REFUND: 'Hoàn tiền', TICKET_REFUND: 'Hoàn vé' };
const money = (value: number | null) => value === null ? '—' : currency.format(value);
const pageSize = 25;

function cashLabel(row: CashRow) {
  return row.source === 'MANUAL' ? (row.direction === 'IN' ? 'Thu khác ghi sổ' : 'Chi khác ghi sổ') : sourceLabels[row.source] ?? row.source;
}

function quantities<T extends { unit: string }>(rows: T[], value: (item: T) => number) {
  const totals = new Map<string, number>();
  for (const item of rows) {
    const quantity = value(item);
    if (quantity > 0) totals.set(item.unit, (totals.get(item.unit) ?? 0) + quantity);
  }
  return [...totals];
}

function quantitySummary(totals: [string, number][], divisor = 1) {
  return totals.map(([unit, quantity]) => `${units.format(quantity / divisor)} ${unit}`).join(' · ') || '0';
}

function incomingItems(purchases: PurchaseReport, inventory: Inventory) {
  const rows = new Map(purchases.items.map(item => [item.id, { ...item, manual: 0 }]));
  for (const item of inventory.items) {
    if (!item.manualReceipts) continue;
    const purchased = rows.get(item.id);
    if (purchased) purchased.manual = item.manualReceipts;
    else rows.set(item.id, { id: item.id, name: item.name, unit: item.unit, quantity: 0, subtotal: 0, tax: 0, total: 0, manual: item.manualReceipts });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

function Metrics({ items }: { items: readonly (readonly [string, string | number])[] }) {
  const { t } = useLanguage();
  return <div className="business-metrics">{items.map(([label, value]) => <div className="product-tile" key={label}>
    <small>{t(label)}</small><strong>{value}</strong>
  </div>)}</div>;
}

function Totals({ items }: { items: readonly (readonly [string, number | null])[] }) {
  return <Metrics items={items.map(([label, amount]) => [label, money(amount)])}/>;
}

function profitMetrics(report: Report, mode: Branch['mode']): [string, number | null][] {
  const { profit, adjustedProfit, inventory } = report;
  const provisional = adjustedProfit.provisional ? ' (tạm tính)' : '';
  return [['Tiền bán trước thuế', profit.salesBeforeTax], ['Hoàn tiền trước thuế', profit.refundsBeforeTax],
    ...(report.serviceRevenue ? [['Doanh thu phòng và vé', report.serviceRevenue] as [string, number]] : []),
    ...(usesMemberships(mode) || report.memberRevenue ? [['Doanh thu gói hội viên', report.memberRevenue] as [string, number]] : []),
    ['Doanh thu thuần ghi nhận', report.recognizedRevenue],
    ...(usesRetail(mode) || profit.retailCost ? [['Giá vốn hàng đã bán', profit.retailCost] as [string, number]] : []),
    ...(usesTables(mode) || adjustedProfit.ingredientCost ? [['Giá vốn nguyên liệu', adjustedProfit.ingredientCost] as [string, number]] : []),
    ['Trừ giá trị hụt', inventory.shortageValue], ['Cộng giá trị dư', inventory.excessValue],
    [`Lãi sau kiểm kê${provisional}`, adjustedProfit.amount], ['Chi phí vận hành', report.cash.operatingExpenses.total],
    [`Lợi nhuận trước thuế${provisional}`, report.profitBeforeTax]];
}

function reportRange(report: Report, period: ReportPeriod) {
  const end = displayDay.format(new Date(report.end));
  return period === 'all' ? `Toàn bộ đến ${end}` : `${displayDay.format(new Date(report.start))} – ${end}`;
}

function exportReport(report: Report, period: ReportPeriod, branch: Branch) {
  const incoming = incomingItems(report.purchases, report.inventory);
  const rows: (string | number)[][] = [['Nhóm', 'Nội dung', 'Chỉ số', 'Giá trị', 'Đơn vị'],
    ['Thông tin', branch.name, 'Khoảng thời gian', reportRange(report, period), ''],
    ['Bán hàng', 'Tổng hợp', 'Hóa đơn đã tất toán', report.profit.invoiceCount, 'hóa đơn'],
    ['Bán hàng', 'Tổng hợp', 'Đơn đã tạo', report.orders, 'đơn'],
    ['Bán hàng', 'Tổng hợp', 'Đơn còn xử lý', report.processing, 'đơn'],
    ['Bán hàng', 'Tổng hợp', 'Thu bán hàng và dịch vụ', report.gross, 'đ'],
    ['Bán hàng', 'Tổng hợp', 'Đã hoàn tiền', report.refunded, 'đ'],
    ['Bán hàng', 'Tổng hợp', 'Thực thu bán hàng sau hoàn', report.revenue, 'đ'],
    ...profitMetrics(report, branch.mode).map(([label, amount]) => ['Lợi nhuận', 'Tổng hợp', label, amount ?? 'Chưa có giá nhập', 'đ']),
    ['Lợi nhuận', 'Tổng hợp', 'Tỷ lệ lãi sau kiểm kê', report.adjustedProfit.margin === null ? '' : report.adjustedProfit.margin * 100, '%'],
    ['Lợi nhuận', 'Tổng hợp', 'Giá vốn buffet tham khảo', report.profit.buffetEstimate, 'đ'],
    ['Lợi nhuận', 'Tổng hợp', 'Giảm giá vốn do nhập lại hàng trả', report.profit.restockedCost, 'đ'],
    ['Lợi nhuận', 'Tổng hợp', 'Dòng chưa đủ giá vốn', report.adjustedProfit.missingCostLines, 'dòng'],
    ['Nhập hàng', 'Tổng hợp', 'Số phiếu', report.purchases.count, 'phiếu'],
    ['Nhập hàng', 'Tổng hợp', 'Trước thuế', report.purchases.subtotal, 'đ'],
    ['Nhập hàng', 'Tổng hợp', 'Thuế nhập', report.purchases.tax, 'đ'],
    ['Nhập hàng', 'Tổng hợp', 'Tổng tiền nhập', report.purchases.total, 'đ'],
    ['Kiểm kê', 'Tổng hợp', 'Lượt kiểm kê', report.inventory.checks, 'lượt'],
    ['Kiểm kê', 'Tổng hợp', 'Lượt hụt', report.inventory.shortChecks, 'lượt'],
    ['Kiểm kê', 'Tổng hợp', 'Lượt dư', report.inventory.excessChecks, 'lượt'],
    ['Kiểm kê', 'Tổng hợp', 'Lượt chưa có giá nhập', report.inventory.unpricedCounts, 'lượt'],
    ['Kiểm kê', 'Tổng hợp', 'Lượt dùng giá ước tính', report.inventory.estimatedCounts, 'lượt'],
    ['Dòng tiền', 'Tổng hợp', 'Tổng thu', report.cash.income, 'đ'],
    ['Dòng tiền', 'Tổng hợp', 'Tổng chi', report.cash.expenses, 'đ'],
    ['Dòng tiền', 'Tổng hợp', 'Chênh lệch thu chi', report.cash.net, 'đ'],
    ...report.cash.operatingExpenses.items.map(item => ['Chi phí vận hành', item.label, 'Tổng tiền chi', item.total, 'đ']),
    ...quantities(incoming, item => item.quantity + item.manual).map(([unit, value]) => ['Nhập hàng', 'Tổng hợp', 'Số lượng nhập', value / 1000, unit]),
    ...quantities(report.salesItems, item => item.quantity).map(([unit, value]) => ['Bán hàng', 'Tổng hợp', 'Số lượng bán', value, unit]),
    ...quantities(report.inventory.items, item => item.shortage).map(([unit, value]) => ['Kiểm kê', 'Tổng hợp', 'Số lượng hụt', value / 1000, unit]),
    ...quantities(report.inventory.items, item => item.excess).map(([unit, value]) => ['Kiểm kê', 'Tổng hợp', 'Số lượng dư', value / 1000, unit]),
    ...report.salesItems.flatMap(item => [['Bán hàng chi tiết', item.name, 'Số lượng bán', item.quantity, item.unit],
      ['Bán hàng chi tiết', item.name, 'Tiền theo dòng bán', item.amount, 'đ']]),
    ...incoming.flatMap(item => [['Nhập hàng chi tiết', item.name, 'Số lượng nhập theo phiếu', item.quantity / 1000, item.unit],
      ['Nhập hàng chi tiết', item.name, 'Số lượng nhập trực tiếp', item.manual / 1000, item.unit],
      ['Nhập hàng chi tiết', item.name, 'Trước thuế', item.subtotal, 'đ'], ['Nhập hàng chi tiết', item.name, 'Thuế', item.tax, 'đ'],
      ['Nhập hàng chi tiết', item.name, 'Thành tiền', item.total, 'đ']]),
    ...report.inventory.items.flatMap(item => [['Kho chi tiết', item.name, 'Đã xuất bán', item.sold / 1000, item.unit],
      ['Kho chi tiết', item.name, 'Đã xuất chế biến', item.used / 1000, item.unit],
      ['Kho chi tiết', item.name, 'Giá nhập bình quân hiện tại', item.currentUnitCost ?? '', `đ/${item.unit}`],
      ['Kho chi tiết', item.name, 'Hụt', item.shortage / 1000, item.unit], ['Kho chi tiết', item.name, 'Dư', item.excess / 1000, item.unit],
      ['Kho chi tiết', item.name, 'Giá trị hụt', item.shortageValue ?? '', 'đ'], ['Kho chi tiết', item.name, 'Giá trị dư', item.excessValue ?? '', 'đ'],
      ['Kho chi tiết', item.name, 'Tình trạng giá trị hụt', valuationLabels[item.shortageStatus], ''],
      ['Kho chi tiết', item.name, 'Tình trạng giá trị dư', valuationLabels[item.excessStatus], '']]),
    ...report.cash.breakdown.map(item => ['Chi tiết dòng tiền', cashLabel(item),
      `${item.direction === 'IN' ? 'Thu' : 'Chi'}${item.method ? ` · ${paymentMethodLabels[item.method]}` : ''}`, item.amount, 'đ']),
    ...report.cash.series.flatMap(item => [['Dòng tiền theo thời gian', item._id, 'Thu', item.income, 'đ'],
      ['Dòng tiền theo thời gian', item._id, 'Chi', item.expenses, 'đ']]),
  ];
  downloadCsv(rows, `juee-bao-cao-${branch.id.slice(-6)}-${period}-${reportDay.format(new Date(report.end))}`);
}

function ValuationCell({ amount, status }: { amount: number | null; status: ValuationStatus }) {
  return <td>{money(amount)}{valuationLabels[status] && <small>{valuationLabels[status]}</small>}</td>;
}

function InventoryReport({ inventory, mode }: { inventory: Inventory; mode: Branch['mode'] }) {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const items = inventory.items.filter(item => filter === 'short' ? item.shortage > 0 : filter === 'excess' ? item.excess > 0 : true);
  const rows = items.slice((page - 1) * pageSize, page * pageSize);
  const goods = usesRetail(mode) || inventory.items.some(item => item.sold > 0);
  const food = usesTables(mode) || inventory.items.some(item => item.used > 0);
  return <Panel title={t("Xuất kho và kiểm kê")} action={<label>{t("Chênh lệch")}<select value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>
    <option value="">{t("Tất cả")}</option><option value="short">{t("Mặt hàng bị hụt")}</option><option value="excess">{t("Mặt hàng bị dư")}</option>
  </select></label>}>
    <Metrics items={[
      ['Lượt kiểm kê', inventory.checks], ['Tổng lượng hụt', quantitySummary(quantities(inventory.items, item => item.shortage), 1000)],
      ['Tổng lượng dư', quantitySummary(quantities(inventory.items, item => item.excess), 1000)],
      ['Giá trị hụt', money(inventory.shortageValue)], ['Giá trị dư', money(inventory.excessValue)],
    ]}/>
    {inventory.estimatedCounts > 0 && <p className="muted">{inventory.estimatedCounts} {t("lượt dùng giá nhập hiện tại để ước tính.")}</p>}
    {inventory.unpricedCounts > 0 && <p className="muted">{inventory.unpricedCounts} {t("lượt chưa đủ giá nhập để tính giá trị.")}</p>}
    {rows.length ? <div className="table-wrap"><table className="company-table">
      <thead><tr><th scope="col">{t("Hàng hóa / nguyên liệu")}</th><th scope="col">{t("Giá nhập bình quân")}</th>
        {goods && <th scope="col">{t("Xuất bán")}</th>}{food && <th scope="col">{t("Xuất chế biến")}</th>}
        <th scope="col">{t("Hụt")}</th><th scope="col">{t("Dư")}</th><th scope="col">{t("Giá trị hụt")}</th><th scope="col">{t("Giá trị dư")}</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.id}>
        <th scope="row">{item.name}<small>{item.unit}</small></th>
        <td>{item.currentUnitCost != null ? `${currency.format(item.currentUnitCost)}/${item.unit}` : t("Chưa có giá nhập")}</td>
        {goods && <td>{units.format(item.sold / 1000)}</td>}{food && <td>{units.format(item.used / 1000)}</td>}
        <td>{units.format(item.shortage / 1000)}</td><td>{units.format(item.excess / 1000)}</td>
        <ValuationCell amount={item.shortageValue} status={item.shortageStatus}/><ValuationCell amount={item.excessValue} status={item.excessStatus}/>
      </tr>)}</tbody>
    </table></div> : <p className="muted">{t("Chưa có dữ liệu kho phù hợp trong kỳ.")}</p>}
    {(page > 1 || items.length > pageSize) && <Pager page={page} full={page * pageSize < items.length} onChange={setPage}/>}
  </Panel>;
}

function PurchasesReport({ purchases, inventory }: { purchases: PurchaseReport; inventory: Inventory }) {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const items = incomingItems(purchases, inventory);
  return <Panel title={t("Nhập hàng trong kỳ")}>
    <Metrics items={[[ 'Số phiếu nhập', purchases.count], ['Tổng số lượng nhập', quantitySummary(quantities(items, item => item.quantity + item.manual), 1000)],
      ['Trước thuế', currency.format(purchases.subtotal)], ['Thuế nhập', currency.format(purchases.tax)], ['Tổng tiền nhập', currency.format(purchases.total)]]}/>
    {items.length ? <div className="table-wrap"><table className="company-table">
      <thead><tr><th scope="col">{t("Mặt hàng")}</th><th scope="col">{t("Theo phiếu nhập")}</th><th scope="col">{t("Nhập trực tiếp vào kho")}</th>
        <th scope="col">{t("Trước thuế")}</th><th scope="col">{t("Thuế")}</th><th scope="col">{t("Tổng tiền theo phiếu")}</th></tr></thead>
      <tbody>{items.slice((page - 1) * pageSize, page * pageSize).map(item => <tr key={item.id}><th scope="row">{item.name}<small>{item.unit}</small></th>
        <td>{units.format(item.quantity / 1000)}</td><td>{units.format(item.manual / 1000)}</td>
        <td>{item.quantity ? currency.format(item.subtotal) : '—'}</td><td>{item.quantity ? currency.format(item.tax) : '—'}</td>
        <td>{item.quantity ? currency.format(item.total) : '—'}</td></tr>)}</tbody>
    </table></div> : <p className="muted">{t("Chưa có nhập hàng trong kỳ.")}</p>}
    {items.length > pageSize && <Pager page={page} full={page * pageSize < items.length} onChange={setPage}/>}
  </Panel>;
}

function SalesReport({ report }: { report: Report }) {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  return <Panel title={t("Mặt hàng đã bán trong kỳ")}>
    <Metrics items={[
      ['Đơn đã tạo', report.orders], ['Đơn còn xử lý', report.processing], ['Hóa đơn đã tất toán', report.profit.invoiceCount],
      ['Tổng số lượng bán', quantitySummary(quantities(report.salesItems, item => item.quantity))],
      ['Thu bán hàng và dịch vụ', currency.format(report.gross)], ['Đã hoàn tiền', currency.format(report.refunded)],
      ['Thực thu bán hàng sau hoàn', currency.format(report.revenue)],
    ]}/>
    {report.salesItems.length ? <><div className="table-wrap"><table className="company-table">
      <thead><tr><th scope="col">{t("Mặt hàng / dịch vụ")}</th><th scope="col">{t("Số lượng bán")}</th><th scope="col">{t("Tiền theo dòng bán")}</th></tr></thead>
      <tbody>{report.salesItems.slice((page - 1) * pageSize, page * pageSize).map(item => <tr key={item.id}><th scope="row">{item.name}</th>
        <td>{units.format(item.quantity)} {item.unit}</td><td>{currency.format(item.amount)}</td></tr>)}</tbody>
    </table></div><p className="muted">{t("Số lượng lấy từ hóa đơn đã tất toán và dịch vụ đã thu tiền. Tiền theo dòng bán tính trước giảm giá chung, thuế và hoàn tiền.")}</p></>
      : <p className="muted">{t("Chưa có mặt hàng hoặc dịch vụ đã bán trong kỳ.")}</p>}
    {report.salesItems.length > pageSize && <Pager page={page} full={page * pageSize < report.salesItems.length} onChange={setPage}/>}
  </Panel>;
}

function CashReport({ cash }: { cash: Cash }) {
  const { t } = useLanguage();
  return <Panel title={t("Thu chi trong kỳ")}>
    <Totals items={[[ 'Tổng thu', cash.income], ['Tổng chi', cash.expenses], ['Chênh lệch thu chi', cash.net]]}/>
    {cash.series.length > 0 && <div className="business-chart"><ResponsiveContainer width="100%" height={250}>
      <BarChart data={cash.series}><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="_id"/><YAxis width={80}/>
        <Tooltip formatter={value => currency.format(Number(value ?? 0))}/><Legend/>
        <Bar dataKey="income" name="Thu" fill="#147e67" radius={[5, 5, 0, 0]}/><Bar dataKey="expenses" name="Chi" fill="#a34c3c" radius={[5, 5, 0, 0]}/>
      </BarChart></ResponsiveContainer></div>}
    {cash.breakdown.length ? <div className="table-wrap"><table className="company-table">
      <thead><tr><th scope="col">{t("Nguồn")}</th><th scope="col">{t("Phương thức")}</th><th scope="col">{t("Tiền thu")}</th><th scope="col">{t("Tiền chi")}</th></tr></thead>
      <tbody>{cash.breakdown.map(item => <tr key={`${item.direction}:${item.source}:${item.method ?? ''}`}>
        <th scope="row">{cashLabel(item)}</th><td>{item.method ? t(paymentMethodLabels[item.method]) : '—'}</td>
        <td>{item.direction === 'IN' ? currency.format(item.amount) : '—'}</td><td>{item.direction === 'OUT' ? currency.format(item.amount) : '—'}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">{t("Chưa có giao dịch thu chi trong kỳ.")}</p>}
  </Panel>;
}

export function Reports({ company = false }: { company?: boolean }) {
  const { t } = useLanguage();
  const { branch } = useBusiness();
  const [period, setPeriod] = useState<ReportPeriod>('today');
  const [on, setOn] = useState('');
  const params = reportParams(period, on);
  if (company) params.set('view', 'company');
  const query = useData<Report>(`/reports?${params}`);
  const report = query.data;
  const scopeKey = params.toString();
  const provisional = report?.adjustedProfit.provisional ? ' (tạm tính)' : '';

  return <>
    <Panel title={t("Báo cáo · {0}", branch.name)} action={<div className="actions business-filters">
      <ReportPeriodFields period={period} on={on} setPeriod={setPeriod} setOn={setOn}/>
      <button className="plain" type="button" disabled={!report} onClick={() => { if (report) exportReport(report, period, branch); }}>
        <Download size={16} aria-hidden="true"/> {t("Xuất báo cáo CSV")}</button>
    </div>}>
      <State query={query}/>
      {report && <><p className="muted">{reportRange(report, period)}</p><Totals items={[
        ['Doanh thu thuần ghi nhận', report.recognizedRevenue], [`Lãi sau kiểm kê${provisional}`, report.adjustedProfit.amount],
        [`Lợi nhuận trước thuế${provisional}`, report.profitBeforeTax],
        ['Tổng thu', report.cash.income], ['Tổng chi', report.cash.expenses], ['Tổng chi nhập hàng', report.purchases.total],
      ]}/></>}
    </Panel>
    {report && <>
      <SalesReport key={`sales:${scopeKey}`} report={report}/>
      <PurchasesReport key={`purchases:${scopeKey}`} purchases={report.purchases} inventory={report.inventory}/>
      <InventoryReport key={`inventory:${scopeKey}`} inventory={report.inventory} mode={branch.mode}/>
      <CashReport cash={report.cash}/>
      <Panel title={t("Chi tiết lợi nhuận")}>
        <Totals items={profitMetrics(report, branch.mode)}/>
        <p className="muted">{t("Lợi nhuận trước thuế bằng lãi sau kiểm kê trừ chi phí vận hành đã ghi nhận trong kỳ.")}</p>
        <div className="table-wrap"><table className="company-table">
          <thead><tr><th scope="col">{t("Chi phí vận hành")}</th><th scope="col">{t("Phiếu chi")}</th><th scope="col">{t("Tổng")}</th></tr></thead>
          <tbody>{report.cash.operatingExpenses.items.map(item => <tr key={item.kind}>
            <th scope="row">{t(item.label)}</th><td>{item.count}</td><td>{currency.format(item.total)}</td>
          </tr>)}</tbody>
        </table></div>
        {report.adjustedProfit.margin !== null && <p className="muted">{t("Tỷ lệ lãi sau kiểm kê")} {percent.format(report.adjustedProfit.margin)}.</p>}
        {report.profit.buffetEstimate > 0 && <p className="muted">{t("Giá vốn buffet tham khảo")} {currency.format(report.profit.buffetEstimate)}{t(". Chênh lệch nguyên liệu buffet được phản ánh qua kiểm kê.")}</p>}
        {report.profit.restockedCost > 0 && <p className="muted">{t("Giá vốn hàng hóa đã giảm")} {currency.format(report.profit.restockedCost)} {t("do nhận hàng trả lại.")}</p>}
        {report.adjustedProfit.provisional && <div className="notice">
          {report.adjustedProfit.missingCostLines > 0 && <p>{report.adjustedProfit.missingCostLines} {t("dòng bán chưa đủ giá vốn.")}</p>}
          {report.inventory.unpricedCounts > 0 && <p>{report.inventory.unpricedCounts} {t("lượt chênh lệch chưa có giá nhập.")}</p>}
          {report.inventory.estimatedCounts > 0 && <p>{report.inventory.estimatedCounts} {t("lượt chênh lệch dùng giá nhập hiện tại để ước tính.")}</p>}
          {report.adjustedProfit.needsBuffetCount && <p>{t("Chưa có kết quả kiểm kê trong kỳ để ghi nhận chênh lệch nguyên liệu buffet.")}</p>}
        </div>}
      </Panel>
    </>}
  </>;
}
