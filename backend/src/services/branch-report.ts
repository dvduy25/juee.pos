import type { Scope } from '../middleware/business-access';
import { CashEntry, HotelBooking, MemberPayment, Order, PurchaseReceipt, TicketRefund, TicketSale } from '../models';
import { cashJournal } from './cash-journal';
import { cashEntryRange, expenseGroup, summarizeExpenses, type GroupedExpense } from './operating-expenses';
import { inventoryReport, profitAfterInventory, profitReport } from './profit-report';
import type { ReportPeriod, revenueRange } from './revenue';

type Range = ReturnType<typeof revenueRange>;
type CashGroup = { source: string; direction: 'IN' | 'OUT'; method?: string };
type PurchaseTotals = { count: number; subtotal: number; tax: number; total: number };
type PurchaseLine = { _id: { item: unknown; unit: string }; name: string; quantity: number; subtotal: number; tax: number };
type ServiceSale = { _id: string; quantity: number; amount: number };
const revenueSources = ['SALE', 'HOTEL', 'TICKET', 'MEMBER'];

async function purchaseReport(scope: Scope, range: Range) {
  const match = { $match: { ...scope, createdAt: range } };
  const [[totals], rows] = await Promise.all([
    PurchaseReceipt.aggregate<PurchaseTotals>([match, { $group: { _id: null, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' },
      tax: { $sum: '$taxAmount' }, total: { $sum: '$totalAmount' } } }, { $project: { _id: 0 } }]),
    PurchaseReceipt.aggregate<PurchaseLine>([match, { $sort: { createdAt: 1, _id: 1 } }, { $unwind: '$lines' },
      { $group: { _id: { item: '$lines.itemId', unit: '$lines.unit' }, name: { $last: '$lines.name' }, quantity: { $sum: '$lines.quantity' },
        subtotal: { $sum: '$lines.subtotal' }, tax: { $sum: '$lines.taxAmount' } } }, { $sort: { name: 1, '_id.item': 1, '_id.unit': 1 } },
    ]).allowDiskUse(true),
  ]);
  return { ...(totals ?? { count: 0, subtotal: 0, tax: 0, total: 0 }),
    items: rows.map(({ _id, ...item }) => ({ ...item, id: `${_id.item}:${_id.unit}`, unit: _id.unit, total: item.subtotal + item.tax })) };
}

async function cashReport(scope: Scope, range: Range, period: ReportPeriod) {
  const received = { $eq: ['$direction', 'IN'] };
  const paidOut = { $eq: ['$direction', 'OUT'] };
  const format = period === 'today' ? '%H:00' : period === 'year' || period === 'all' ? '%Y-%m' : '%Y-%m-%d';
  const [rows] = await CashEntry.aggregate<{
    groups: { _id: CashGroup; amount: number }[];
    operating: GroupedExpense[];
    series: { _id: string; income: number; expenses: number; amount: number }[];
  }>([...cashJournal(scope, range), { $facet: {
    groups: [{ $group: { _id: { source: '$source', direction: '$direction', method: '$method' }, amount: { $sum: '$amount' } } },
      { $sort: { '_id.direction': 1, '_id.source': 1, '_id.method': 1 } }],
    operating: [{ $match: { source: 'MANUAL', direction: 'OUT' } }, expenseGroup],
    series: [{ $group: { _id: { $dateToString: { date: '$occurredAt', timezone: 'Asia/Ho_Chi_Minh', format } },
      income: { $sum: { $cond: [received, '$amount', 0] } }, expenses: { $sum: { $cond: [paidOut, '$amount', 0] } },
      amount: { $sum: { $cond: [{ $in: ['$source', revenueSources] }, '$amount', 0] } } } }, { $sort: { _id: 1 } }],
  } }]);
  const breakdown = (rows?.groups ?? []).map(({ _id, amount }) => ({ ..._id, amount }));
  const income = breakdown.filter(row => row.direction === 'IN').reduce((total, row) => total + row.amount, 0);
  const expenses = breakdown.filter(row => row.direction === 'OUT').reduce((total, row) => total + row.amount, 0);
  const operatingExpenses = summarizeExpenses(rows?.operating ?? []);
  return { income, expenses, net: income - expenses, otherExpenses: operatingExpenses.total, operatingExpenses, breakdown, series: rows?.series ?? [] };
}

function serviceSales(scope: Scope, range: Range) {
  return Promise.all([
    HotelBooking.aggregate<ServiceSale>([{ $match: { ...scope, status: 'CHECKED_OUT', paidAt: range } },
      { $group: { _id: '$roomCode', quantity: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    TicketSale.aggregate<ServiceSale>([{ $match: { ...scope, paidAt: range } },
      { $group: { _id: '$typeName', quantity: { $sum: '$quantity' }, amount: { $sum: '$amount' } } }]),
    TicketRefund.aggregate<ServiceSale>([{ $match: { ...scope, createdAt: range } },
      { $group: { _id: '$typeName', quantity: { $sum: '$quantity' }, amount: { $sum: '$amount' } } }]),
    MemberPayment.aggregate<ServiceSale>([{ $match: { ...scope, paidAt: range } },
      { $group: { _id: '$planName', quantity: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
  ]);
}

function serviceAmounts([rooms, tickets, ticketRefunds, memberPlans]: Awaited<ReturnType<typeof serviceSales>>) {
  const sum = (rows: ServiceSale[]) => rows.reduce((total, row) => total + row.amount, 0);
  return { serviceRevenue: sum(rooms) + sum(tickets) - sum(ticketRefunds), memberRevenue: sum(memberPlans) };
}

function financialTotals(profit: Parameters<typeof profitAfterInventory>[0], inventory: Parameters<typeof profitAfterInventory>[1],
  services: Awaited<ReturnType<typeof serviceSales>>, expenses: number) {
  const { serviceRevenue, memberRevenue } = serviceAmounts(services);
  const recognizedRevenue = profit.netSales + serviceRevenue + memberRevenue;
  const adjustedProfit = profitAfterInventory({ ...profit, netSales: recognizedRevenue }, inventory);
  return { recognizedRevenue, serviceRevenue, memberRevenue, adjustedProfit, profitBeforeTax: adjustedProfit.amount - expenses };
}

export async function branchPerformance(scope: Scope, range: Range) {
  const [sales, inventory, services, [costs]] = await Promise.all([
    profitReport(scope, range, false), inventoryReport(scope, range, true), serviceSales(scope, range),
    CashEntry.aggregate<{ total: number }>([{ $match: { ...cashEntryRange(scope, range), direction: 'OUT' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  const operatingExpenses = costs?.total ?? 0;
  const { recognizedRevenue, adjustedProfit, profitBeforeTax } = financialTotals(sales, inventory, services, operatingExpenses);
  return { revenue: recognizedRevenue, operatingExpenses, profitBeforeTax, provisional: adjustedProfit.provisional };
}

export async function branchReport(scope: Scope, range: Range, period: ReportPeriod) {
  const [sales, inventory, purchases, cash, orders, processing, serviceRows] = await Promise.all([
    profitReport(scope, range), inventoryReport(scope, range), purchaseReport(scope, range), cashReport(scope, range, period),
    Order.countDocuments({ ...scope, createdAt: range }),
    Order.countDocuments({ ...scope, createdAt: range, status: { $in: ['PLACED', 'ACCEPTED'] } }),
    serviceSales(scope, range),
  ]);
  const [rooms, tickets, ticketRefunds, memberPlans] = serviceRows;

  const services = [...rooms.map(item => ({ ...item, unit: 'lượt trả phòng', name: `Phòng ${item._id}`, id: `room:${item._id}` })),
    ...tickets.map(item => ({ ...item, unit: 'vé', name: item._id, id: `ticket:${item._id}` })),
    ...ticketRefunds.map(item => ({ ...item, quantity: -item.quantity, amount: -item.amount,
      unit: 'vé', name: `Hoàn vé · ${item._id}`, id: `ticket-refund:${item._id}` }))];
  const paidPlans = memberPlans.map(({ _id, ...item }) => ({ ...item, unit: 'gói hội viên', name: _id, id: `member:${_id}` }));
  const { soldItems, ...profit } = sales;
  const salesItems = [...soldItems.map(item => ({ ...item, unit: 'hàng/món' })),
    ...services.map(({ _id, ...item }) => item), ...paidPlans].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'vi'));
  const financial = financialTotals(profit, inventory, serviceRows, cash.operatingExpenses.total);
  const collected = cash.breakdown.filter(row => revenueSources.includes(row.source));
  const gross = collected.reduce((total, row) => total + row.amount, 0);
  const refunded = cash.breakdown.filter(row => row.source === 'REFUND' || row.source === 'TICKET_REFUND')
    .reduce((total, row) => total + row.amount, 0);
  const totalsByMethod = new Map<string | undefined, number>();
  for (const row of collected) totalsByMethod.set(row.method, (totalsByMethod.get(row.method) ?? 0) + row.amount);
  const byMethod = [...totalsByMethod].map(([_id, amount]) => ({ _id, amount }));
  return {
    start: range.$gte, end: range.$lte, gross, refunded, revenue: gross - refunded, orders, processing,
    byMethod, top: soldItems.slice(0, 5).map(({ name, quantity }) => ({ _id: name, quantity })),
    series: cash.series.filter(row => row.amount > 0).map(({ _id, amount }) => ({ _id: period === 'month' ? `${_id.slice(8)}/${_id.slice(5, 7)}` : _id, amount })),
    profit, inventory, purchases, cash, salesItems, ...financial, operatingProfit: financial.profitBeforeTax,
  };
}
