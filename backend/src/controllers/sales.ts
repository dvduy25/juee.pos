import { Body, ConflictException, Controller, Get, Header, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { access, logChange, recordEvent } from '../middleware/business-access';
import { scopedRoute } from '../routes/branch';
import { found } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { transaction } from '../config/db';
import { collect, idempotent, makeBill, orderKitchen, placeOrder, restoreOrderIngredients, restoreOrderStock, sendToKitchen, stockReturnPlan, transferQr } from '../services/sales';
import { amount, discountCode, editRetailOrderInput, lines, orderRevision, pageSchema } from '../validators/sales';
import { AuditLog, Bill, DiningTable, IncomingTransfer, KitchenTicket, Order, Payment, PaymentIntent, Refund, TableSession, User, serviceCounterModes } from '../models';
import { retailPricing } from '../services/retail';
import { cancelRetailOrder, checkOrderRevision, editableRetailBill, isRetailOrder, retailOrderOpen, unpaidRetailBill, updateRetailOrder } from '../services/retail-order';
import { csvDate, csvFile } from '../services/csv';
import { reportPeriodQuery, selectedReportRange } from '../validators/reports';
import { refundBeforeTax } from '../services/revenue';
import type { ClientSession } from 'mongoose';
import type { Scope } from '../middleware/business-access';

const paramsId = (value: string) => read(objectId, value);
type Route = { tenantId: string; branchId: string; id: string };
const posOrderInput = z.object({ items: lines, discountAmount: vnd.default(0), customerId: objectId.optional(),
  productType: z.enum(['RETAIL', 'FOOD']).optional(), tableId: objectId.optional(), tableSessionId: objectId.optional(),
  promotionCode: discountCode.optional(), promotionId: objectId.optional(), expectedTotal: z.number().int().nonnegative().safe().optional() });
const canceledOrder = { status: 'CANCELED' as const };
const canceledItems = { 'items.cancelReason': { $type: 'string' as const } };
const hasCancellation = { $or: [canceledOrder, canceledItems] };

async function counterTable(scope: Scope, type: 'RETAIL' | 'FOOD', tableId: string | undefined, expectedSessionId: string | undefined, session: ClientSession) {
  if (type === 'RETAIL') {
    if (tableId || expectedSessionId) throw new ConflictException('Chỉ chọn bàn ở quầy nhà hàng.');
    return {};
  }
  if (!tableId) throw new ConflictException('Hãy chọn bàn trước khi tạo đơn.');
  const table = found(await DiningTable.findOne({ ...scope, _id: tableId }).session(session).lean(), 'Không tìm thấy bàn.');
  const service = table.sessionId && await TableSession.exists({ ...scope, _id: table.sessionId, tableIds: table._id, status: 'OPEN' }).session(session);
  if (!service) throw new ConflictException('Hãy mở lượt phục vụ cho bàn trước khi tạo đơn.');
  if (expectedSessionId && String(service._id) !== expectedSessionId) throw new ConflictException('Lượt phục vụ của bàn vừa thay đổi. Hãy kiểm tra lại bàn.');
  return { tableSessionId: service._id, tableName: table.name };
}

function posProductType(mode: string, requested?: 'RETAIL' | 'FOOD') {
  if (mode === 'HYBRID') return requested ?? 'RETAIL';
  const allowed = mode === 'RESTAURANT' || mode === 'CAFE' ? 'FOOD' : 'RETAIL';
  if (requested && requested !== allowed) throw new ConflictException('Loại sản phẩm không phù hợp với chế độ của chi nhánh.');
  return allowed;
}

async function requirePaymentTable(scope: Scope, billId: string, tableSessionId: string | undefined, session: ClientSession) {
  const bill = found(await Bill.findOne({ ...scope, _id: billId }).session(session).lean());
  const legacy = !bill.tableSessionId && await Order.findOne({ ...scope, _id: { $in: bill.orderIds }, tableSessionId: { $ne: null } })
    .select('tableSessionId').session(session).lean();
  const table = bill.tableSessionId ?? (legacy ? legacy.tableSessionId : undefined);
  if ((table && String(table) !== tableSessionId) || (!table && tableSessionId)) {
    throw new ConflictException('Hãy mở đúng lượt phục vụ để thu tiền hóa đơn này.');
  }
}

@Controller(scopedRoute)
export class SalesController {
  @Get('retail-pricing')
  async pricing(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'orders.create');
    if (posProductType(branch.mode) !== 'RETAIL') throw new ConflictException('Chỉ áp dụng tại quầy bán lẻ.');
    const { code } = read(z.object({ code: discountCode.optional() }), query);
    return retailPricing(scope, code);
  }

  @Get('orders')
  async orders(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'orders.read');
    const { page, tableSessionId, status, source, takeaway, standalone, view } = read(z.object({
      page: pageSchema, tableSessionId: objectId.optional(), source: z.enum(['POS', 'QR']).optional(), status: z.enum(['PLACED', 'ACCEPTED', 'CANCELED', 'COMPLETED']).optional(),
      takeaway: z.literal('true').optional(), standalone: z.literal('true').optional(), view: z.literal('management').optional(),
    }), query);
    const tableFilter = tableSessionId ? { tableSessionId } : standalone ? { tableSessionId: null } : {};
    const orders = await Order.find({ ...scope, ...tableFilter, ...(status ? { status } : {}),
      ...(source ? { source } : {}), ...(takeaway ? { takeaway: true } : {}) })
      .select('-guestSessionId').sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
    if (view && ['OWNER', 'MANAGER'].includes(membership.role)) {
      const pending = orders.filter(order => isRetailOrder(order) && retailOrderOpen(order));
      const billIds = pending.flatMap(order => order.billId ? [order.billId] : []);
      const [bills, paidBills] = billIds.length ? await Promise.all([
        Bill.find({ ...scope, _id: { $in: billIds } }).select('orderIds status paidAmount tableSessionId').lean(),
        Payment.distinct('billId', { ...scope, billId: { $in: billIds } }),
      ]) : [[], []];
      const byId = new Map(bills.map(bill => [String(bill._id), bill]));
      const withPayments = new Set(paidBills.map(String));
      return orders.map(order => {
        if (!isRetailOrder(order) || !retailOrderOpen(order)) return order;
        const bill = byId.get(String(order.billId));
        return { ...order, retailEditable: !order.billId || (!!bill && !withPayments.has(String(bill._id)) && editableRetailBill(bill, order._id)) };
      });
    }
    if (!takeaway || !orders.length) return orders;
    const kitchen = await orderKitchen(scope, orders.map(order => order._id));
    return orders.map(order => ({ ...order, kitchen: kitchen.get(String(order._id)) ?? [] }));
  }

  @Post('orders')
  async order(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(posOrderInput.extend({ takeaway: z.literal(true).optional(), serviceMode: z.literal('TAKEAWAY').optional() }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'orders.create');
    return idempotent(scope, 'POS_ORDER', key, { actorId, input }, async session => {
      const { branch } = await access(req, route.tenantId, route.branchId, 'orders.create', session);
      const productType = posProductType(branch.mode, input.productType);
      const takeaway = input.serviceMode === 'TAKEAWAY' || input.takeaway;
      if (takeaway && (productType !== 'FOOD' || input.tableId || (input.takeaway && input.tableSessionId))) {
        throw new ConflictException('Đơn mang về chỉ dùng thực đơn của nhà hàng hoặc quán nước và không gắn với bàn.');
      }
      if (productType === 'FOOD' && input.discountAmount) throw new ConflictException('Áp dụng giảm giá tại bước tính tiền của bàn.');
      const table = takeaway ? {} : await counterTable(scope, productType, input.tableId, input.tableSessionId, session);
      let tableSessionId = table.tableSessionId;
      if (input.serviceMode) {
        const service = input.tableSessionId ? found(await TableSession.findOne({ ...scope, _id: input.tableSessionId,
          status: 'OPEN', takeaway: true, checkoutBillId: null }).select('_id').session(session).lean(), 'Đơn mang về đã đổi hình thức hoặc đã chốt hóa đơn.') :
          await TableSession.insertOne({ ...scope, status: 'OPEN', tableIds: [], takeaway: true, openedBy: actorId,
            guestCount: 1 }, { session });
        tableSessionId = service._id;
      }
      const order = await placeOrder(scope, { ...input, localRetail: serviceCounterModes.includes(branch.mode), takeaway: takeaway || undefined, tableSessionId, tableName: table.tableName, productType, source: 'POS', actorId }, session);
      if (tableSessionId || takeaway) await sendToKitchen(scope, order, session);
      await logChange(scope, actorId, 'ORDER_CREATE', order._id, session);
      return order.toObject();
    });
  }

  @Post('checkout')
  async checkout(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(posOrderInput.extend({ registerId: objectId.optional(), method: z.literal('CASH') }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'payments.collect');
    return idempotent(scope, 'POS_CHECKOUT', key, { actorId, input }, async session => {
      const { membership, branch } = await access(req, route.tenantId, route.branchId, 'payments.collect', session);
      const productType = posProductType(branch.mode, input.productType);
      if (productType === 'FOOD') throw new ConflictException('Hãy thêm món vào bàn rồi mở bàn đó để tính tiền.');
      await counterTable(scope, productType, input.tableId, input.tableSessionId, session);
      const order = await placeOrder(scope, { items: input.items, discountAmount: input.discountAmount, customerId: input.customerId,
        promotionCode: input.promotionCode, promotionId: input.promotionId, expectedTotal: input.expectedTotal, productType, localRetail: serviceCounterModes.includes(branch.mode), source: 'POS', actorId }, session);
      const bill = await makeBill(scope, [order.id], session);
      await logChange(scope, actorId, 'CHECKOUT', order._id, session);
      const paid = bill.totalAmount ? await collect(scope, bill.id, actorId, { method: 'CASH', amount: bill.totalAmount, registerId: input.registerId, requireOwnShift: membership.role === 'CASHIER' }, session) : { bill: bill.toObject() };
      const completed = found(await Order.findOne({ ...scope, _id: order._id }).session(session).lean());
      return { order: completed, ...paid };
    });
  }

  @Post('orders/:id/accept')
  async accept(@Req() req: Request, @Param() route: Route) {
    const id = paramsId(route.id);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'orders.accept', session);
      const order = found(await Order.findOne({ ...scope, _id: id }).session(session));
      if (order.status !== 'PLACED') throw new ConflictException('Đơn không còn chờ xác nhận.');
      order.status = 'ACCEPTED';
      await order.save({ session });
      if (order.source === 'QR') await sendToKitchen(scope, order, session);
      else await recordEvent(scope, 'order.accepted', order._id, session);
      await logChange(scope, actorId, 'ORDER_ACCEPT', order._id, session);
      return order.toObject();
    });
  }

  @Patch('orders/:id')
  async editOrder(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = paramsId(route.id);
    const input = read(editRetailOrderInput, body);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, route.tenantId, route.branchId, 'orders.edit', session);
      const order = found(await Order.findOne({ ...scope, _id: id }).session(session));
      if (!isRetailOrder(order) || !retailOrderOpen(order)) throw new ConflictException('Chỉ sửa đơn bán lẻ còn chờ thanh toán.');
      checkOrderRevision(order, input.revision);
      const bill = await unpaidRetailBill(scope, order, session);
      return updateRetailOrder(scope, order, bill, actorId, input, session, serviceCounterModes.includes(branch.mode));
    });
  }

  @Post('orders/:id/cancel')
  async cancel(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = paramsId(route.id);
    // Older clients can still include the optional PIN field.
    const { reason, itemId, revision } = read(z.object({ reason: label, itemId: objectId.optional(), pin: z.string().optional(), revision: orderRevision.optional() }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'orders.cancel', session);
      const order = found(await Order.findOne({ ...scope, _id: id }).session(session));
      if (!retailOrderOpen(order)) throw new ConflictException('Đơn đã đóng. Nếu đã thu tiền, hãy vào Hóa đơn và hoàn tiền.');
      if (isRetailOrder(order) && !itemId) {
        checkOrderRevision(order, revision);
        const bill = await unpaidRetailBill(scope, order, session);
        await cancelRetailOrder(scope, order, bill, actorId, reason, session);
        return order.toObject();
      }
      if (order.billId) throw new ConflictException('Đơn đã có hóa đơn.');
      const food = !!(order.tableSessionId || order.takeaway);
      if (itemId && !food) throw new ConflictException('Chỉ hủy từng món cho đơn nhà hàng hoặc quán nước.');
      const items = order.items.filter(item => !item.cancelReason && (!itemId || item._id.equals(itemId)));
      if (!items.length) throw new ConflictException('Món đã hủy hoặc không thuộc đơn này.');
      const ticket = await KitchenTicket.findOne({ ...scope, orderId: order._id }).session(session);
      if (!food && ticket?.items.some(item => item.status !== 'NEW')) throw new ConflictException('Bếp đã xử lý món của đơn này.');
      const stages = new Map(ticket?.items.map(item => [String(item.orderItemId), item]));
      const toRestore = items.filter(item => {
        const stage = stages.get(String(item._id));
        return !food || order.status === 'PLACED' || stage?.status === 'NEW';
      });
      await restoreOrderStock(scope, [order], { note: itemId ? 'Hoàn tồn do hủy món' : 'Hoàn tồn do hủy đơn', actorId, referenceId: order._id,
        selected: toRestore.filter(item => item.warehouseItemId && item.quantity > (item.returnedQuantity ?? 0))
          .map(item => ({ lineId: String(item._id), quantity: item.quantity - (item.returnedQuantity ?? 0) })) }, session);
      await restoreOrderIngredients(scope, order, new Set(toRestore.map(item => String(item._id))), actorId, session);
      if (ticket) {
        for (const item of items) {
          const stage = stages.get(String(item._id));
          if (!stage) continue;
          if (stage.status === 'SERVED') stage.cancelConfirmedAt = new Date();
          stage.status = 'CANCELED';
          stage.cancelReason = reason;
        }
        await ticket.save({ session });
      }
      if (food) for (const item of items) item.cancelReason = reason;
      const remaining = order.items.filter(item => !item.cancelReason);
      if (!itemId || !remaining.length) {
        order.status = 'CANCELED';
        order.cancelReason = reason;
      }
      if (food) {
        order.subtotal = remaining.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
        order.totalAmount = order.subtotal;
      }
      await order.save({ session });
      await logChange(scope, actorId, itemId ? 'ORDER_ITEM_CANCEL' : 'ORDER_CANCEL', order._id, session, { reason, itemId });
      await recordEvent(scope, order.status === 'CANCELED' ? 'order.cancelled' : 'kitchen.updated', order._id, session);
      return order.toObject();
    });
  }

  @Get('company/cancellations')
  async cancellations(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'orders.cancellations');
    const { kind, page } = read(z.object({ kind: z.enum(['all', 'orders', 'items']).default('all'), page: pageSchema }), query);
    const filter = kind === 'orders' ? canceledOrder : kind === 'items' ? canceledItems : hasCancellation;
    const rows = await Order.find({ ...scope, ...filter })
      .select('status source tableName takeaway cancelReason createdAt items.name items.quantity items.cancelReason')
      .sort('-updatedAt -_id').skip((page - 1) * 50).limit(51).lean();
    return { hasMore: rows.length > 50, orders: rows.slice(0, 50).map(({ items, ...order }) => {
      const affected = order.status === 'CANCELED' ? items : items.filter(item => item.cancelReason);
      return { ...order, reason: order.cancelReason ?? (affected.length === 1 ? affected[0].cancelReason : undefined),
        names: [...new Set(affected.map(item => item.name))], quantity: affected.reduce((sum, item) => sum + item.quantity, 0) };
    }) };
  }

  @Get('company/cancellations/:id')
  async cancellationDetail(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'orders.cancellations');
    const order = found(await Order.findOne({ ...scope, _id: paramsId(route.id), ...hasCancellation })
      .select('status source tableName takeaway billId cancelReason createdAt totalAmount items').lean(), 'Không tìm thấy đơn có món hoặc giao dịch đã hủy.');
    const wholeOrder = order.status === 'CANCELED';
    const [actions, kitchen] = await Promise.all([
      AuditLog.find({ ...scope, $or: [
        { targetId: order._id, action: { $in: ['ORDER_CANCEL', 'ORDER_ITEM_CANCEL'] } },
        ...(wholeOrder && order.billId ? [{ targetId: order.billId, action: 'BILL_VOID' }] : []),
      ] }).select('action actorId createdAt details').sort('-createdAt -_id').lean(),
      orderKitchen(scope, [order._id]),
    ]);
    const actorIds = actions.flatMap(action => action.actorId ? [action.actorId] : []);
    const people = actorIds.length ? await User.find({ _id: { $in: actorIds } }).select('name').lean() : [];
    const names = new Map(people.map(person => [String(person._id), person.name]));
    const audit = (action: typeof actions[number] | undefined) => action && ({
      at: action.createdAt, by: action.actorId ? names.get(String(action.actorId)) : undefined,
    });
    const wholeAction = actions.find(action => action.action === 'ORDER_CANCEL' || action.action === 'BILL_VOID');
    const kitchenItems = new Map((kitchen.get(String(order._id)) ?? [])
      .filter(item => item.status === 'CANCELED' && item.cancelReason).map(item => [String(item.orderItemId), item]));
    return {
      id: order._id, status: order.status, source: order.source, tableName: order.tableName, takeaway: order.takeaway,
      createdAt: order.createdAt, totalAmount: order.totalAmount, reason: order.cancelReason, cancellation: audit(actions[0]),
      items: order.items.map(item => {
        const canceled = wholeOrder || !!item.cancelReason;
        const action = actions.find(action => action.action === 'ORDER_ITEM_CANCEL' && action.details?.itemId === String(item._id));
        const ticket = kitchenItems.get(String(item._id));
        return { id: item._id, name: item.name, quantity: item.quantity, unitPrice: item.unitPrice, note: item.note, modifiers: item.modifiers,
          canceled, reason: canceled ? item.cancelReason ?? order.cancelReason : undefined,
          cancellation: canceled ? audit(action ?? wholeAction) : undefined,
          kitchen: ticket && { confirmedAt: ticket.cancelConfirmedAt } };
      }),
    };
  }

  @Get('company/transactions/export')
  @Header('Cache-Control', 'no-store')
  async exportTransactions(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'reports.view');
    const { period, on } = read(reportPeriodQuery, query);
    const range = selectedReportRange(period, on);
    const orderLabels = { PLACED: 'Chờ xác nhận', ACCEPTED: 'Đã nhận', COMPLETED: 'Đã thanh toán', CANCELED: 'Đã hủy' };
    const billLabels = { OPEN: 'Chờ thu tiền', PAID: 'Đã thanh toán', VOID: 'Đã hủy', REFUNDED: 'Đã hoàn tiền' };
    const labelMethod = { CASH: 'Tiền mặt', TRANSFER: 'Chuyển khoản' };
    async function* rows() {
      const orders = Order.find({ ...scope, createdAt: range }).sort('-createdAt -_id').lean().cursor();
      try {
        for await (const order of orders) {
          const key = [csvDate.format(order.createdAt), order._id.toString(), order.billId?.toString() ?? ''];
          const location = order.takeaway ? 'Mang về' : order.tableName ?? (order.source === 'QR' ? 'Gọi món QR' : 'Tại quầy');
          yield ['Đơn hàng', ...key, orderLabels[order.status], location, '', '', order.status === 'CANCELED' ? 0 : order.totalAmount, '', order.cancelReason ?? ''];
          for (const line of order.items) {
            const canceled = order.status === 'CANCELED' || !!line.cancelReason;
            yield ['Dòng đơn hàng', ...key, canceled ? 'Đã hủy' : orderLabels[order.status], line.name, line.quantity, line.unitPrice,
              canceled ? 0 : line.unitPrice * line.quantity, '', line.cancelReason ?? line.note ?? ''];
          }
        }
      } finally { await orders.close(); }
      const bills = Bill.find({ ...scope, createdAt: range }).sort('-createdAt -_id').lean().cursor();
      try {
        for await (const bill of bills) yield ['Hóa đơn', csvDate.format(bill.createdAt), bill._id.toString(), '', billLabels[bill.status], '', '', '', bill.totalAmount, '', ''];
      } finally { await bills.close(); }
      const payments = Payment.find({ ...scope, paidAt: range }).sort('-paidAt -_id').lean().cursor();
      try {
        for await (const payment of payments) yield ['Thu tiền', csvDate.format(payment.paidAt), payment._id.toString(), payment.billId.toString(),
          '', '', '', '', payment.amount, labelMethod[payment.method], payment.reference ?? ''];
      } finally { await payments.close(); }
      const refunds = Refund.find({ ...scope, createdAt: range }).sort('-createdAt -_id').lean().cursor();
      try {
        for await (const refund of refunds) yield ['Hoàn tiền', csvDate.format(refund.createdAt), refund._id.toString(), refund.paymentId.toString(), '', '', '', '', refund.amount, '', refund.reason];
      } finally { await refunds.close(); }
    }
    return csvFile(`juee-giao-dich-${period}`, ['Loại bản ghi', 'Thời gian (Việt Nam)', 'Mã', 'Mã liên quan', 'Trạng thái',
      'Bàn / mặt hàng', 'Số lượng', 'Đơn giá (đ)', 'Số tiền (đ)', 'Phương thức', 'Ghi chú'], rows());
  }

  @Get('bills')
  async bills(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'bills.read');
    const { page } = read(z.object({ page: pageSchema }), query);
    const bills = await Bill.find(scope).sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
    const legacy = bills.filter(bill => !bill.tableSessionId && bill.orderIds.length).map(bill => bill.orderIds[0]);
    const orders = await Order.find({ ...scope, _id: { $in: legacy }, tableSessionId: { $ne: null } }).select('tableSessionId').lean();
    const tableSessions = new Map(orders.map(order => [String(order._id), order.tableSessionId]));
    return bills.map(bill => ({ ...bill, tableSessionId: bill.tableSessionId ?? tableSessions.get(String(bill.orderIds[0])) }));
  }

  @Get('transfer-review')
  async review(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'transfers.review');
    const { page } = read(z.object({ page: pageSchema }), query);
    return IncomingTransfer.find({ ...scope, status: 'REVIEW' }).select('reference amount createdAt status')
      .sort('-createdAt').skip((page - 1) * 50).limit(50).lean();
  }

  @Get('bills/:id')
  async bill(@Req() req: Request, @Param() route: Route, @Query('view') view?: string) {
    const cashbook = view === 'cashbook';
    const { scope } = await access(req, route.tenantId, route.branchId, cashbook ? 'finance.manage' : 'bills.read');
    const bill = found(await Bill.findOne({ ...scope, _id: paramsId(route.id) }).lean());
    const [orders, payments, transferIntents] = await Promise.all([
      Order.find({ ...scope, _id: { $in: bill.orderIds } }).select('items totalAmount discountAmount tableSessionId takeaway').lean(),
      Payment.find({ ...scope, billId: bill._id }).sort('paidAt').lean(),
      cashbook ? [] : PaymentIntent.find({ ...scope, billId: bill._id, status: 'PENDING', expiresAt: { $gt: new Date() } })
        .select('reference amount expiresAt').sort('-createdAt').limit(20).lean(),
    ]);
    const tableSessionId = bill.tableSessionId ?? orders.find(order => order.tableSessionId)?.tableSessionId;
    const service = tableSessionId && await TableSession.findOne({ ...scope, _id: tableSessionId }).select('status takeaway').lean();
    return { ...bill, orders, payments, transferIntents, tableSessionId, tableSessionClosed: !!service && service.status === 'CLOSED',
      takeaway: service ? !!service.takeaway : orders.some(order => order.takeaway) };
  }

  @Post('bills')
  async createBill(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const { orderIds } = read(z.object({ orderIds: z.array(objectId).min(1).max(50).refine(items => new Set(items).size === items.length) }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'payments.collect');
    return idempotent(scope, 'BILL_CREATE', key, { actorId, orderIds }, async session => {
      await access(req, route.tenantId, route.branchId, 'payments.collect', session);
      const bill = await makeBill(scope, orderIds, session);
      await logChange(scope, actorId, 'BILL_CREATE', bill._id, session);
      return bill.toObject();
    });
  }

  @Post('bills/:id/void')
  async voidBill(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = paramsId(route.id);
    const { reason } = read(z.object({ reason: label }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'refunds.approve', session);
      const bill = found(await Bill.findOne({ ...scope, _id: id }).session(session));
      if (bill.status !== 'OPEN' || bill.paidAmount !== 0) throw new ConflictException('Chỉ hủy được hóa đơn chưa thu tiền.');
      const retailOrder = !bill.tableSessionId && bill.orderIds.length === 1
        ? await Order.findOne({ ...scope, _id: bill.orderIds[0], billId: bill._id }).session(session) : null;
      if (retailOrder && isRetailOrder(retailOrder) && retailOrderOpen(retailOrder)) {
        if (await Payment.exists({ ...scope, billId: bill._id }).session(session)) {
          throw new ConflictException('Hóa đơn từng ghi nhận thanh toán. Xem chi tiết trong Hóa đơn và hoàn tiền.');
        }
        await cancelRetailOrder(scope, retailOrder, bill, actorId, reason, session);
        return bill.toObject();
      }
      bill.status = 'VOID';
      await bill.save({ session });
      await PaymentIntent.updateMany({ ...scope, billId: bill._id, status: 'PENDING' }, { $min: { expiresAt: new Date() } }, { session });
      const tableCheckout = { ...scope, _id: bill.tableSessionId, checkoutBillId: bill._id };
      const closedCheckout = bill.tableSessionId && await TableSession.exists({ ...tableCheckout, status: 'CLOSED' }).session(session);
      const trackedOrders = bill.tableSessionId ? [] : await Order.find({ ...scope, billId: bill._id, status: 'ACCEPTED',
        items: { $elemMatch: { warehouseItemId: { $type: 'objectId' } } } }).session(session);
      if (closedCheckout || trackedOrders.length) {
        if (trackedOrders.length) await restoreOrderStock(scope, trackedOrders,
          { note: 'Hoàn tồn do hủy hóa đơn', actorId, referenceId: bill._id }, session);
        await Order.updateMany({ ...scope, billId: bill._id, status: 'ACCEPTED' },
          { $set: { status: 'CANCELED', cancelReason: reason } }, { session });
      } else {
        if (bill.tableSessionId) await TableSession.updateOne(tableCheckout, { $unset: { checkoutBillId: 1 } }, { session });
        await Order.updateMany({ ...scope, billId: bill._id }, { $unset: { billId: 1 } }, { session });
      }
      await logChange(scope, actorId, 'BILL_VOID', bill._id, session, { reason });
      return bill.toObject();
    });
  }

  @Post('bills/:id/payment-intents')
  async transferIntent(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const billId = paramsId(route.id);
    const input = read(z.object({ amount, tableSessionId: objectId.optional() }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'payments.collect');
    return idempotent(scope, 'TRANSFER_INTENT', key, { actorId, billId, input }, async session => {
      const { branch } = await access(req, route.tenantId, route.branchId, 'payments.collect', session);
      await requirePaymentTable(scope, billId, input.tableSessionId, session);
      return transferQr(scope, billId, input.amount, branch.bankAccount, session, true);
    });
  }

  @Post('bills/:id/payments')
  async payment(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = paramsId(route.id);
    const input = read(z.discriminatedUnion('method', [
      z.object({ method: z.literal('CASH'), amount, registerId: objectId.optional(), tableSessionId: objectId.optional() }).strict(),
      z.object({ method: z.literal('TRANSFER'), intentId: objectId, bankReference: label, tableSessionId: objectId.optional() }).strict(),
    ]), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'payments.collect');
    return idempotent(scope, 'PAYMENT', key, { actorId, id, input }, async session => {
      const { membership } = await access(req, route.tenantId, route.branchId, 'payments.collect', session);
      await requirePaymentTable(scope, id, input.tableSessionId, session);
      if (input.method === 'CASH') return collect(scope, id, actorId, { method: input.method, amount: input.amount,
        registerId: input.registerId, requireOwnShift: membership.role === 'CASHIER' }, session);
      const intent = found(await PaymentIntent.findOneAndUpdate({
        ...scope, _id: input.intentId, billId: id, status: 'PENDING', expiresAt: { $gt: new Date() },
      }, { $set: { status: 'PAID' } }, { session }).lean(), 'Mã thanh toán đã dùng hoặc hết hạn.');
      return collect(scope, id, actorId, { method: 'TRANSFER', amount: intent.amount, reference: input.bankReference }, session);
    });
  }

  @Post('payments/:id/refunds')
  async refund(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = paramsId(route.id);
    // Preserve the request hash for retries from existing clients.
    const input = read(z.object({ amount, reason: label, restock: z.boolean().default(false),
      returnLines: z.array(z.object({ lineId: objectId, quantity: z.number().int().min(1).max(1000) }).strict()).min(1).max(50).optional(),
    }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'refunds.approve');
    return idempotent(scope, 'REFUND', key, { actorId, id, input }, async session => {
      await access(req, route.tenantId, route.branchId, 'refunds.approve', session);
      const payment = found(await Payment.findOne({ ...scope, _id: id }).session(session));
      const bill = found(await Bill.findOne({ ...scope, _id: payment.billId }).session(session));
      if (!['PAID', 'OPEN'].includes(bill.status) || input.amount > payment.amount - payment.refundedAmount || input.amount > bill.paidAmount) {
        throw new ConflictException('Số tiền hoàn không hợp lệ.');
      }
      const fullRefund = bill.status === 'PAID' && input.amount === bill.paidAmount;
      const salesBeforeTax = bill.status === 'PAID' ? refundBeforeTax(input.amount, bill.totalAmount, bill.taxAmount ?? 0,
        bill.totalAmount - bill.paidAmount) : undefined;
      const refund = new Refund({ ...scope, paymentId: id, actorId, amount: input.amount, reason: input.reason, salesBeforeTax });
      if (fullRefund || input.returnLines) {
        const orders = await Order.find({ ...scope, billId: bill._id, _id: { $in: bill.orderIds } }).session(session);
        if (fullRefund && input.returnLines) stockReturnPlan(orders.flatMap(order => order.items), input.returnLines);
        const returnLines = await restoreOrderStock(scope, orders, { note: 'Hoàn tồn do hoàn tiền', actorId, referenceId: refund._id,
          selected: fullRefund ? undefined : input.returnLines }, session);
        if (returnLines.length) refund.set('returnLines', returnLines);
      }
      payment.refundedAmount += input.amount;
      await payment.save({ session });
      bill.paidAmount -= input.amount;
      if (fullRefund) bill.status = 'REFUNDED';
      await bill.save({ session });
      await refund.save({ session });
      await logChange(scope, actorId, 'REFUND', refund._id, session);
      return refund.toObject();
    });
  }
}
