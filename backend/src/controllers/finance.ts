import { Body, ConflictException, Controller, Get, Header, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Types, type PipelineStage } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange, type Scope } from '../middleware/business-access';
import { Bill, Branch, CashEntry, HotelBooking, MemberPayment, Product, PurchaseReceipt, RetailPromotion, StaffPayPayment, TicketRefund, TicketSale,
  WarehouseItem, expenseKinds, recordedPaymentMethods, retailBranchModes, serviceCounterModes } from '../models';
import { scopedRoute } from '../routes/branch';
import { productBranchFilter, productTypeFilter } from '../services/catalog';
import { retailPricing, roundedMoney } from '../services/retail';
import { reportPeriods } from '../services/revenue';
import { cashJournal } from '../services/cash-journal';
import { cashEntryRange, expenseGroup, expenseLabels, summarizeExpenses, type GroupedExpense } from '../services/operating-expenses';
import { csvDate, csvFile } from '../services/csv';
import { idempotent } from '../services/sales';
import { recordWarehouseMovement, warehouseExpiry, warehouseQuantity } from '../services/warehouse';
import { found, isDuplicate, mongoId } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { amount, discountCode, pageSchema } from '../validators/sales';
import { reportPeriodQuery, selectedReportRange } from '../validators/reports';

type Route = { tenantId: string; branchId: string; id: string };
const rate = z.number().int().min(0).max(10000);
const periodInput = reportPeriodQuery.extend({ period: z.enum(reportPeriods).default('month') });
const cashbookInput = periodInput.extend({ page: pageSchema,
  method: z.enum(recordedPaymentMethods).optional() });
const cashbookSort = { $sort: { occurredAt: -1, _id: -1 } } satisfies PipelineStage.Sort;
const dateInput = z.string().datetime({ offset: true }).transform(value => new Date(value));
const promoInput = z.object({ code: discountCode.optional(), name: label, kind: z.enum(['PERCENT', 'FIXED']), value: amount, minimum: vnd,
  productIds: z.array(objectId).min(1).max(500).refine(ids => new Set(ids).size === ids.length).optional(),
  startsAt: dateInput, endsAt: dateInput, enabled: z.boolean() }).strict()
  .refine(input => input.startsAt < input.endsAt && (input.kind !== 'PERCENT' || input.value <= 100), 'Kiểm tra kỳ áp dụng và mức giảm.');

const journalLabels = { MANUAL: 'Ghi thủ công', SALE: 'Thu hóa đơn', HOTEL: 'Thu tiền phòng',
  TICKET: 'Thu bán vé', TICKET_REFUND: 'Hoàn vé', MEMBER: 'Thu phí hội viên', PURCHASE: 'Chi nhập hàng', REFUND: 'Hoàn tiền', PAYROLL: 'Chi trả lương' };
const methodLabels = { CASH: 'Tiền mặt', TRANSFER: 'Chuyển khoản' };
type CashbookRow = { _id: Types.ObjectId; occurredAt: Date; source: keyof typeof journalLabels; direction: 'IN' | 'OUT';
  method?: keyof typeof methodLabels; category?: string; note?: string; billId?: Types.ObjectId; amount: number };

function linkCashbookPayroll(scope: Scope): PipelineStage.FacetPipelineStage[] {
  return [
    { $set: { payrollCashEntryId: { $cond: [{ $eq: ['$expenseKind', 'STAFF'] }, '$_id', null] } } },
    { $lookup: { from: StaffPayPayment.collection.name, localField: 'payrollCashEntryId', foreignField: 'cashEntryId',
      pipeline: [{ $match: scope }, { $project: { membershipId: 1 } }, { $limit: 1 }], as: 'payroll' } },
    { $set: { payrollPaymentId: { $first: '$payroll._id' }, payrollMembershipId: { $first: '$payroll.membershipId' },
      source: { $cond: [{ $gt: [{ $size: '$payroll' }, 0] }, 'PAYROLL', '$source'] } } },
    { $unset: ['payroll', 'payrollCashEntryId'] },
  ];
}

@Controller(scopedRoute)
export class FinanceController {
  @Get('purchases')
  async purchases(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    const { page } = read(z.object({ page: pageSchema }), query);
    return PurchaseReceipt.find(scope).sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
  }

  @Get('purchases/export')
  @Header('Cache-Control', 'no-store')
  async exportPurchases(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    const { period, on } = read(reportPeriodQuery, query);
    const range = selectedReportRange(period, on);
    async function* rows() {
      const receipts = PurchaseReceipt.find({ ...scope, createdAt: range }).sort('-createdAt -_id').lean().cursor();
      try {
        for await (const receipt of receipts) {
          for (const line of receipt.lines) {
            yield [csvDate.format(receipt.createdAt), receipt._id.toString(), receipt.supplier, receipt.reference ?? '', methodLabels[receipt.method],
              line.code, line.name, line.unit, line.quantity / 1000, line.expiresOn ?? '', line.unitCost, line.subtotal, line.taxAmount, line.subtotal + line.taxAmount];
          }
        }
      } finally {
        await receipts.close();
      }
    }
    return csvFile(`juee-nhap-hang-${period}`, ['Thời gian (Việt Nam)', 'Mã phiếu nhập', 'Nhà cung cấp', 'Số chứng từ', 'Phương thức',
      'Mã hàng', 'Mặt hàng', 'Đơn vị', 'Số lượng', 'Hạn sử dụng', 'Đơn giá (đ)', 'Trước thuế (đ)', 'Thuế (đ)', 'Thành tiền (đ)'], rows());
  }

  @Get('purchases/:id')
  async purchaseDetail(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    return found(await PurchaseReceipt.findOne({ ...scope, _id: read(objectId, route.id) }).lean(), 'Không tìm thấy phiếu nhập hàng.');
  }

  @Post('purchases')
  async purchase(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const line = z.object({ itemId: objectId, quantity: warehouseQuantity.refine(q => q > 0), unitCost: vnd,
      taxBps: rate, expiresOn: warehouseExpiry }).strict();
    const input = read(z.object({ supplier: label, reference: label.optional(), method: z.enum(recordedPaymentMethods),
      lines: z.array(line).min(1).max(30).refine(lines => new Set(lines.map(item => `${item.itemId}:${item.expiresOn ?? ''}`)).size === lines.length,
        'Mỗi mặt hàng và hạn sử dụng chỉ nhập một dòng.') }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    return idempotent(scope, 'PURCHASE', key, { actorId, input }, async session => {
      await access(req, route.tenantId, route.branchId, 'purchases.manage', session);
      const items = await WarehouseItem.find({ ...scope, _id: { $in: input.lines.map(item => item.itemId) } }).session(session);
      const byId = new Map(items.map(item => [item.id, item]));
      const lines = input.lines.map(line => {
        const item = found(byId.get(line.itemId), 'Có mặt hàng không thuộc kho chi nhánh.');
        const subtotal = roundedMoney(BigInt(line.quantity) * BigInt(line.unitCost), 1000n);
        const taxAmount = roundedMoney(BigInt(subtotal) * BigInt(line.taxBps), 10000n);
        return { ...line, itemId: item._id, name: item.name, code: item.code, unit: item.unit, subtotal, taxAmount };
      });
      const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
      const taxAmount = lines.reduce((sum, line) => sum + line.taxAmount, 0);
      const totalAmount = subtotal + taxAmount;
      if (!Number.isSafeInteger(totalAmount)) throw new ConflictException('Tổng giá trị phiếu nhập vượt giới hạn.');
      const receipt = await PurchaseReceipt.insertOne({ ...scope, actorId, ...input, lines, subtotal, taxAmount, totalAmount }, { session });
      for (const line of lines) {
        const item = byId.get(String(line.itemId))!;
        item.unitCost = roundedMoney(BigInt(item.onHand) * BigInt(item.unitCost ?? line.unitCost) +
          BigInt(line.quantity) * BigInt(line.unitCost), BigInt(item.onHand + line.quantity));
        await recordWarehouseMovement(scope, item, { operation: 'RECEIPT', quantity: line.quantity,
          actorId, note: `Nhập hàng · ${input.supplier}`, referenceId: receipt._id, expiresOn: line.expiresOn ?? null }, session);
      }
      await logChange(scope, actorId, 'PURCHASE_CREATE', receipt._id, session);
      return receipt.toObject();
    });
  }

  @Get('retail-promotions')
  async promotions(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'finance.manage');
    const { page } = read(z.object({ page: pageSchema }), query);
    return RetailPromotion.find(scope).sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
  }

  @Post('retail-promotions')
  async promotion(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(promoInput, body);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, route.tenantId, route.branchId, 'finance.manage', session);
      if (!retailBranchModes.includes(branch.mode)) throw new ConflictException('Khuyến mãi này áp dụng cho quầy bán lẻ.');
      if (input.code && await RetailPromotion.exists({ ...scope, code: input.code }).session(session)) throw new ConflictException('Mã khuyến mãi đã tồn tại.');
      if (input.productIds) {
        const count = await Product.countDocuments({ ...productBranchFilter(scope, serviceCounterModes.includes(branch.mode)), ...productTypeFilter('RETAIL'),
          status: 'ACTIVE', _id: { $in: input.productIds } }).session(session);
        if (count !== input.productIds.length) throw new ConflictException('Có sản phẩm không còn bán tại chi nhánh này.');
      }
      const promotion = await RetailPromotion.insertOne({ ...scope, ...input,
        code: input.code ?? `PROMO-${new Types.ObjectId().toHexString().toUpperCase()}` }, { session });
      await logChange(scope, actorId, 'PROMOTION_CREATE', promotion._id, session);
      return promotion.toObject();
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mã khuyến mãi đã tồn tại.');
      throw error;
    });
  }

  @Patch('retail-promotions/:id')
  async promotionStatus(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { enabled } = read(z.object({ enabled: z.boolean() }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'finance.manage', session);
      const promotion = found(await RetailPromotion.findOneAndUpdate({ ...scope, _id: read(objectId, route.id) },
        { $set: { enabled } }, { session, returnDocument: 'after' }).lean());
      await logChange(scope, actorId, 'PROMOTION_STATUS', promotion._id, session, { enabled });
      return promotion;
    });
  }

  @Patch('accounting/tax')
  async tax(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { taxBps } = read(z.object({ taxBps: rate }).strict(), body);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, route.tenantId, route.branchId, 'finance.manage', session);
      if (!retailBranchModes.includes(branch.mode)) throw new ConflictException('Cấu hình này áp dụng cho quầy bán lẻ.');
      await Branch.updateOne({ _id: scope.branchId, tenantId: scope.tenantId }, { $set: { retailTaxBps: taxBps } }, { session });
      await logChange(scope, actorId, 'RETAIL_TAX_UPDATE', scope.branchId, session, { taxBps });
      return { taxBps };
    });
  }

  @Get('accounting')
  async accounting(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'finance.manage');
    const { period, on } = read(periodInput, query);
    const range = selectedReportRange(period, on);
    const aggregate = { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalAmount' }, tax: { $sum: '$taxAmount' } } };
    type Totals = { count: number; total: number; tax: number };
    const serviceTotals = { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } };
    const stripId = { $project: { _id: 0 } };
    type ServiceTotals = { count: number; total: number };
    const [sales, purchases, [memberPayments], [hotelPayments], [ticketPayments], [ticketRefunds], [expenseSummary], current] = await Promise.all([
      Bill.aggregate<Totals>([{ $match: { ...scope, createdAt: range, status: { $ne: 'VOID' } } }, aggregate]),
      PurchaseReceipt.aggregate<Totals>([{ $match: { ...scope, createdAt: range } }, aggregate]),
      MemberPayment.aggregate<ServiceTotals>([{ $match: { ...scope, paidAt: range } }, serviceTotals, stripId]),
      HotelBooking.aggregate<ServiceTotals>([{ $match: { ...scope, status: 'CHECKED_OUT', paidAt: range } }, serviceTotals, stripId]),
      TicketSale.aggregate<ServiceTotals>([{ $match: { ...scope, paidAt: range } }, serviceTotals, stripId]),
      TicketRefund.aggregate<ServiceTotals>([{ $match: { ...scope, createdAt: range } }, serviceTotals, stripId]),
      CashEntry.aggregate<{ categories: GroupedExpense[]; payroll: ServiceTotals[] }>([
        { $match: { ...cashEntryRange(scope, range), direction: 'OUT' } }, ...linkCashbookPayroll(scope),
        { $facet: { categories: [expenseGroup], payroll: [{ $match: { source: 'PAYROLL' } }, serviceTotals, stripId] } },
      ]),
      retailPricing(scope),
    ]);
    const empty = { count: 0, total: 0, tax: 0 };
    const emptyService = { count: 0, total: 0 };
    return { sales: sales[0] ?? empty, purchases: purchases[0] ?? empty, memberPayments: memberPayments ?? emptyService,
      hotelPayments: hotelPayments ?? emptyService, ticketPayments: ticketPayments ?? emptyService, ticketRefunds: ticketRefunds ?? emptyService,
      payrollPayments: expenseSummary?.payroll[0] ?? emptyService,
      operatingExpenses: summarizeExpenses(expenseSummary?.categories ?? []), taxBps: current.taxBps };
  }

  @Get('cashbook')
  async cashbook(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'finance.manage');
    const { period, on, page, method } = read(cashbookInput, query);
    const range = selectedReportRange(period, on);
    const [result] = await CashEntry.aggregate([
      ...cashJournal(scope, { $lte: range.$lte }),
      ...(method ? [{ $match: { method } }] : []),
      { $facet: {
        items: [{ $match: { occurredAt: range } }, cashbookSort, { $skip: (page - 1) * 50 }, { $limit: 50 }, ...linkCashbookPayroll(scope)],
        totals: [{ $group: { _id: { direction: '$direction', opening: { $lt: ['$occurredAt', range.$gte] } }, amount: { $sum: '$amount' } } }],
      } },
    ]);
    let opening = 0, income = 0, expenses = 0;
    for (const total of (result?.totals ?? []) as { _id: { opening: boolean; direction: 'IN' | 'OUT' }; amount: number }[]) {
      if (total._id.opening) opening += total._id.direction === 'IN' ? total.amount : -total.amount;
      else if (total._id.direction === 'IN') income += total.amount;
      else expenses += total.amount;
    }
    return { items: result?.items ?? [], opening, income, expenses, closing: opening + income - expenses };
  }

  @Get('cashbook/export')
  @Header('Cache-Control', 'no-store')
  async exportCashbook(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'finance.manage');
    const { period, on, method } = read(cashbookInput.omit({ page: true }), query);
    const range = selectedReportRange(period, on);
    async function* rows() {
      const cursor = CashEntry.aggregate<CashbookRow>([
        ...cashJournal(scope, range),
        ...(method ? [{ $match: { method } }] : []),
        cashbookSort,
        ...linkCashbookPayroll(scope),
      ]).allowDiskUse(true).cursor({ batchSize: 250 });
      try {
        let row: CashbookRow | null = await cursor.next();
        while (row) {
          yield [csvDate.format(row.occurredAt), row._id.toString(), journalLabels[row.source], row.category ?? '', row.note ?? '',
            row.method ? methodLabels[row.method] : '', row.billId?.toString() ?? '',
            row.direction === 'IN' ? row.amount : '', row.direction === 'OUT' ? row.amount : ''];
          row = await cursor.next();
        }
      } finally {
        await cursor.close();
      }
    }
    return csvFile(`juee-so-quy-${period}`, ['Thời gian (Việt Nam)', 'Mã giao dịch', 'Nguồn', 'Nhóm thu chi', 'Nội dung', 'Phương thức',
      'Mã hóa đơn', 'Thu (đ)', 'Chi (đ)'], rows());
  }

  @Post('cashbook')
  async cashEntry(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(z.object({ direction: z.enum(['IN', 'OUT']), amount, method: z.enum(recordedPaymentMethods), note: label,
      category: label.optional(), expenseKind: z.enum(expenseKinds).optional(), occurredAt: dateInput.optional() }).strict()
      .refine(item => !!item.category || !!item.expenseKind, 'Chọn hoặc nhập nhóm thu chi.')
      .refine(item => !item.expenseKind || item.direction === 'OUT', 'Nhóm chi phí chỉ áp dụng cho phiếu chi.')
      .refine(item => !item.occurredAt || (Number.isFinite(+item.occurredAt) && +item.occurredAt >= 0 && item.occurredAt <= new Date()),
        'Thời điểm thực thu hoặc thực chi phải là hiện tại hoặc đã qua.'), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'finance.manage');
    return idempotent(scope, 'CASH_ENTRY', key, { actorId, input }, async session => {
      await access(req, route.tenantId, route.branchId, 'finance.manage', session);
      const category = input.expenseKind ? expenseLabels[input.expenseKind] : input.category;
      const entry = await CashEntry.insertOne({ ...scope, actorId: mongoId(actorId), ...input, category }, { session });
      await logChange(scope, actorId, 'CASH_ENTRY_CREATE', entry._id, session);
      return entry.toObject();
    });
  }
}
