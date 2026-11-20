import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, Header, Headers, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { access, logChange, recordEvent, requireModule, restaurant, type Scope } from '../middleware/business-access';
import { catalog, productTypeFilter } from '../services/catalog';
import { buffetMenuFilter } from '../services/buffet';
import { scopedRoute } from '../routes/branch';
import { found, mongoId } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { transaction } from '../config/db';
import { Bill, BuffetPackage, Category, DiningArea, DiningTable, GuestSession, KitchenTicket, Order, Product, TableSession, Tenant, Branch, OutboxEvent } from '../models';
import { finishPaidTable, idempotent, makeBill, orderKitchen, placeOrder, releaseTables, transferQr } from '../services/sales';
import { amount, discountCode, lineSchema, pageSchema } from '../validators/sales';
import { guestLocation, requireGuestLocation } from '../validators/order-location';
import { requireReviewedTable, tableDiscountAmount, tableTotals, unservedQuantity } from '../services/table-checkout';
import { activePlan } from '../services/tenants';
import { qrImage } from '../utils/qr';

type Route = { tenantId: string; branchId: string; id: string };
const identifier = (value: string) => read(objectId, value);
const qrToken = z.string().regex(/^[a-f0-9]{40}$/);
const guestToken = z.string().regex(/^[a-f0-9]{64}$/);
const waitingKitchenStatuses = ['NEW', 'COOKING', 'READY'] as const;
const kitchenView = z.enum(['kitchen', 'service']).default('kitchen');
const buffetGuestFields = { adults: z.number().int().min(0).max(1000), children: z.number().int().min(0).max(1000) };
const validateBuffetGuests = ({ adults, children }: { adults: number; children: number }) => adults + children >= 1 && adults + children <= 1000;
const buffetGuests = z.object(buffetGuestFields).strict().refine(validateBuffetGuests, 'Buffet cần từ 1 đến 1000 khách.');
const buffetPackageInput = z.object({ name: label, adultPrice: vnd.refine(price => price > 0), childPrice: vnd,
  productIds: z.array(objectId).min(1).max(500).refine(ids => new Set(ids).size === ids.length), enabled: z.boolean() }).strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function tableQr(tenantId: string, token: string) {
  const url = new URL(`/order/${tenantId}/${token}`, process.env.PUBLIC_ORDER_ORIGIN || process.env.WEB_ORIGIN).toString();
  return { url, image: qrImage(url) };
}

async function tableCart(scope: Scope, service: Pick<InstanceType<typeof TableSession>, '_id' | 'buffet'>, session?: ClientSession) {
  const orders = await Order.find({ ...scope, tableSessionId: service._id }).select('-guestSessionId').sort('createdAt _id').session(session ?? null).lean();
  const billIds = orders.flatMap(order => order.billId ? [order.billId] : []);
  const billFilter = service.buffet ? { $or: [{ _id: { $in: billIds } }, { tableSessionId: service._id }] } : { _id: { $in: billIds } };
  const bills = await Bill.find({ ...scope, ...billFilter }).sort('createdAt _id').session(session ?? null).lean();
  return { orders, bills, ...tableTotals(orders, bills, service.buffet) };
}

async function tableContext(tenantId: string, token: string) {
  const table = found(await DiningTable.findOne({ tenantId: identifier(tenantId), qrToken: read(qrToken, token) }).lean());
  const scope = { tenantId: table.tenantId, branchId: table.branchId };
  const tenant = found(await Tenant.findOne({ _id: table.tenantId, locked: { $ne: true } }).select('name').lean());
  const branch = found(await Branch.findOne({ _id: table.branchId, tenantId: table.tenantId }).select('name mode location').lean());
  await restaurant(scope, branch.mode, 'qr');
  return { table, tenant, branch, scope };
}

async function authorizedGuest(rawAuthorization: string | undefined, session?: ClientSession, allowCheckedOut = false) {
  const token = rawAuthorization?.match(/^Guest ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new UnauthorizedException('Hãy xác nhận vị trí tại bàn để gọi món.');
  const guest = await GuestSession.findOne({ tokenHash: hash(read(guestToken, token)), expiresAt: { $gt: new Date() } }).session(session ?? null).lean();
  if (!guest) throw new UnauthorizedException('Phiên gọi món đã hết hạn.');
  const scope = { tenantId: guest.tenantId, branchId: guest.branchId };
  const serviceFilter = { ...scope, _id: guest.tableSessionId, ...(allowCheckedOut ?
    { $or: [{ status: 'OPEN' as const }, { status: 'CLOSED' as const, checkoutBillId: { $ne: null } }] } : { status: 'OPEN' as const, checkoutBillId: null }) };
  const tableSession = session
    ? await TableSession.findOneAndUpdate(serviceFilter, { $set: { writeToken: randomUUID() } }, { session }).lean()
    : await TableSession.findOne(serviceFilter).lean();
  if (!tableSession) throw new UnauthorizedException('Lượt phục vụ đã đóng.');
  const tenant = session
    ? await Tenant.findOneAndUpdate({ _id: scope.tenantId, locked: { $ne: true } }, { $set: { branchWriteToken: randomUUID() } }, { session }).lean()
    : await Tenant.findOne({ _id: scope.tenantId, locked: { $ne: true } }).lean();
  if (!tenant) throw new ForbiddenException();
  const branch = found(await Branch.findOne({ tenantId: scope.tenantId, _id: scope.branchId }).session(session ?? null).lean());
  await restaurant(scope, branch.mode, 'qr', session);
  return { guest, tableSession, scope, branch };
}

@Controller(scopedRoute)
export class RestaurantController {
  @Get('tables')
  async tables(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'tables.serve');
    await restaurant(scope, branch.mode, 'qr');
    const [tables, areas, sessions, buffetPackages] = await Promise.all([
      DiningTable.find(scope).sort('name').lean(), DiningArea.find(scope).sort('name').lean(),
      TableSession.find({ ...scope, status: 'OPEN', takeaway: { $ne: true } }).select('tableIds paymentRequestedAt checkoutBillId guestCount buffet buffetProductIds createdAt').lean(),
      BuffetPackage.find({ ...scope, enabled: true }).select('name adultPrice childPrice').sort('name _id').lean(),
    ]);
    return { tables, areas, sessions, buffetPackages };
  }

  @Get('takeaway-sessions')
  async takeawaySessions(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'tables.serve');
    await restaurant(scope, branch.mode, 'pos');
    return TableSession.find({ ...scope, status: 'OPEN', takeaway: true })
      .select('tableIds checkoutBillId guestCount buffet buffetProductIds createdAt').sort('-createdAt -_id').lean();
  }

  @Get('buffet-packages')
  async buffetPackages(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'buffet.manage');
    await restaurant(scope, branch.mode, 'qr');
    const packages = await BuffetPackage.find(scope).sort('name _id').lean();
    const productIds = [...new Set(packages.flatMap(pack => pack.productIds.map(String)))];
    const products = await Product.find({ tenantId: scope.tenantId, _id: { $in: productIds } }).select('name status productType').lean();
    return { packages, products, previousRates: branch.buffetRates };
  }

  @Post('buffet-packages')
  createBuffetPackage(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.saveBuffetPackage(req, route, body);
  }

  @Patch('buffet-packages/:id')
  editBuffetPackage(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.saveBuffetPackage(req, route, body, identifier(route.id));
  }

  private saveBuffetPackage(req: Request, route: Route, body: unknown, id?: string) {
    const input = read(buffetPackageInput, body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'buffet.manage', session);
      await restaurant(scope, branch.mode, 'qr', session);
      if (await Product.countDocuments({ tenantId: scope.tenantId, status: 'ACTIVE', ...productTypeFilter('FOOD'),
        _id: { $in: input.productIds } }).session(session) !== input.productIds.length) {
        throw new ConflictException('Có món không còn trong thực đơn. Hãy bỏ món đó khỏi gói rồi lưu lại.');
      }
      if (await BuffetPackage.exists({ ...scope, name: input.name, ...(id ? { _id: { $ne: id } } : {}) }).session(session)) {
        throw new ConflictException('Chi nhánh đã có gói buffet trùng tên.');
      }
      const pack = id ? found(await BuffetPackage.findOneAndUpdate({ ...scope, _id: id }, { $set: input },
        { session, returnDocument: 'after', runValidators: true }).lean()) : (await BuffetPackage.insertOne({ ...scope, ...input }, { session })).toObject();
      await logChange(scope, actorId, id ? 'BUFFET_PACKAGE_UPDATE' : 'BUFFET_PACKAGE_CREATE', pack._id, session);
      return pack;
    });
  }

  @Get('table-sessions/:id/cart')
  async cart(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'tables.serve');
    const service = found(await TableSession.findOne({ ...scope, _id: identifier(route.id),
      $or: [{ status: 'OPEN' }, { status: 'CLOSED', checkoutBillId: { $ne: null } }] }).lean(), 'Không tìm thấy lượt phục vụ.');
    await restaurant(scope, branch.mode, service.takeaway ? 'pos' : 'qr');
    const { orders, bills, due, subtotal, revision, pending } = await tableCart(scope, service);
    const kitchen = await orderKitchen(scope, orders.map(order => order._id));
    return { orders: orders.map(order => ({ ...order, kitchen: kitchen.get(String(order._id)) ?? [] })), bills, due, subtotal, revision, pending,
      status: service.status, guestCount: service.guestCount, buffet: service.buffet, takeaway: service.takeaway,
      unservedQuantity: unservedQuantity(orders, kitchen), paymentRequestedAt: service.paymentRequestedAt, checkoutBillId: service.checkoutBillId };
  }

  @Get('table-discounts')
  async discounts(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'table-discounts.manage');
    await restaurant(scope, branch.mode, 'qr');
    const settings = found(await Branch.findOne({ _id: scope.branchId, tenantId: scope.tenantId }).select('+tableDiscounts').lean());
    return settings.tableDiscounts ?? [];
  }

  @Post('table-discounts')
  async saveDiscount(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.object({ code: discountCode, kind: z.enum(['PERCENT', 'FIXED']), value: amount, enabled: z.boolean().default(true) })
      .strict().refine(item => item.kind !== 'PERCENT' || item.value <= 100, 'Tỷ lệ giảm tối đa là 100%.'), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'table-discounts.manage', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const settings = found(await Branch.findOne({ _id: scope.branchId, tenantId: scope.tenantId }).select('+tableDiscounts').session(session));
      const codes = (settings.tableDiscounts ?? []).filter(item => item.code !== input.code);
      if (codes.length >= 100) throw new ConflictException('Chi nhánh đã có tối đa 100 mã giảm giá.');
      await settings.updateOne({ $set: { tableDiscounts: [...codes, input] } }, { session });
      await logChange(scope, actorId, 'TABLE_DISCOUNT_SAVE', branch._id, session, input);
      return { ok: true };
    });
  }

  @Post('table-sessions/:id/checkout')
  async checkout(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = identifier(route.id);
    const input = read(z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), discountCode: discountCode.optional() }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'payments.collect');
    return idempotent(scope, 'TABLE_CHECKOUT', key, { actorId, id, input }, async session => {
      const { branch } = await access(req, route.tenantId, route.branchId, 'payments.collect', session);
      // Guest orders and table checkout use the same session write lock.
      const service = found(await TableSession.findOneAndUpdate({ ...scope, _id: id, status: 'OPEN' },
        { $set: { writeToken: randomUUID() } }, { session }).lean(), 'Lượt phục vụ đã đóng.');
      await restaurant(scope, branch.mode, service.takeaway ? 'pos' : 'qr', session);
      if (service.checkoutBillId) throw new ConflictException('Lượt phục vụ đã có hóa đơn. Hãy mở hóa đơn để tiếp tục thanh toán.');
      const cart = await tableCart(scope, service, session);
      requireReviewedTable(cart.revision, input.revision);
      if (cart.pending) throw new ConflictException('Hãy nhận hoặc xử lý các món khách vừa gửi trước khi chốt hóa đơn.');
      if (!cart.unpaid.length && !cart.unbilledBuffet) throw new ConflictException('Lượt phục vụ này không có món hoặc suất buffet cần lập hóa đơn.');
      if (cart.bills.some(bill => bill.status === 'OPEN')) throw new ConflictException('Hãy xử lý hóa đơn còn mở trước.');
      const remaining = unservedQuantity(cart.orders, await orderKitchen(scope, cart.orders.map(order => order._id), session));
      if (remaining) throw new ConflictException(`Còn ${remaining} phần chưa xác nhận ra món. Hãy xác nhận đủ trước khi chốt hóa đơn.`);
      if (!Number.isSafeInteger(cart.subtotal)) throw new ConflictException('Hóa đơn vượt giới hạn số tiền.');
      const settings = input.discountCode && await Branch.findOne({ _id: scope.branchId, tenantId: scope.tenantId }).select('+tableDiscounts').session(session).lean();
      const discount = settings && settings.tableDiscounts?.find(item => item.code === input.discountCode && item.enabled);
      if (input.discountCode && !discount) throw new ConflictException('Mã giảm giá không hợp lệ hoặc đã tắt.');
      const discountAmount = discount ? tableDiscountAmount(cart.subtotal, discount) : 0;
      const bill = await makeBill(scope, cart.unpaid.map(order => String(order._id)), session,
        { tableSessionId: service._id, discountCode: input.discountCode, discountAmount, buffet: cart.unbilledBuffet });
      await TableSession.updateOne({ ...scope, _id: id }, { $set: { checkoutBillId: bill._id } }, { session });
      if (bill.status === 'PAID') await finishPaidTable(scope, bill, session);
      else await recordEvent(scope, 'table.updated', service._id, session);
      await logChange(scope, actorId, 'TABLE_CHECKOUT', bill._id, session, { tableSessionId: id, discountCode: input.discountCode, discountAmount });
      return bill.toObject();
    });
  }

  @Post('table-areas')
  async createArea(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { name } = read(z.object({ name: label }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.configure', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const area = await DiningArea.insertOne({ ...scope, name }, { session });
      await logChange(scope, actorId, 'TABLE_AREA_CREATE', area._id, session);
      return area.toObject();
    });
  }

  @Post('tables')
  async createTable(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.object({ name: label, areaId: objectId.optional() }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.configure', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const plan = await activePlan(scope.tenantId, session, true);
      if (await DiningTable.countDocuments({ tenantId: scope.tenantId }).session(session) >= (plan.maxQrTables ?? 0)) throw new ConflictException('Đã đạt giới hạn bàn QR của gói.');
      if (input.areaId) found(await DiningArea.exists({ ...scope, _id: input.areaId }).session(session));
      const table = await DiningTable.insertOne({ ...scope, ...input, qrToken: randomBytes(20).toString('hex') }, { session });
      await logChange(scope, actorId, 'TABLE_CREATE', table._id, session);
      await recordEvent(scope, 'table.updated', table._id, session);
      return { ...table.toObject(), qr: tableQr(String(scope.tenantId), table.qrToken) };
    });
  }

  @Get('tables/:id/qr')
  async image(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'tables.serve');
    await restaurant(scope, branch.mode, 'qr');
    const table = found(await DiningTable.findOne({ ...scope, _id: identifier(route.id) }).lean());
    return tableQr(String(scope.tenantId), table.qrToken);
  }

  @Patch('tables/:id')
  async editTable(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = identifier(route.id);
    const { name, areaId } = read(z.object({ name: label, areaId: objectId.nullable() }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.configure', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const table = found(await DiningTable.findOne({ ...scope, _id: id }).session(session));
      if (table.sessionId) throw new ConflictException('Hãy kết thúc lượt phục vụ trước khi sửa bàn.');
      const area = areaId && found(await DiningArea.exists({ ...scope, _id: areaId }).session(session));
      table.name = name;
      table.areaId = area ? area._id : undefined;
      await table.save({ session });
      await logChange(scope, actorId, 'TABLE_UPDATE', table._id, session);
      await recordEvent(scope, 'table.updated', table._id, session);
      return table.toObject();
    });
  }

  @Delete('tables/:id')
  async deleteTable(@Req() req: Request, @Param() route: Route) {
    const id = identifier(route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.configure', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const table = found(await DiningTable.findOne({ ...scope, _id: id }).session(session));
      if (table.sessionId || table.reserved) throw new ConflictException('Hãy kết thúc lượt phục vụ hoặc bỏ đặt trước rồi mới xóa bàn.');
      await table.deleteOne({ session });
      await logChange(scope, actorId, 'TABLE_DELETE', table._id, session);
      await recordEvent(scope, 'table.updated', table._id, session);
      return { ok: true };
    });
  }

  @Post('table-sessions')
  async open(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { tableId, guestCount, buffet: guests } = read(z.object({ tableId: objectId, guestCount: z.number().int().min(1).max(1000).optional(),
      buffet: z.object({ ...buffetGuestFields, packageId: objectId }).strict()
        .refine(validateBuffetGuests, 'Buffet cần từ 1 đến 1000 khách.').optional() }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.serve', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const table = found(await DiningTable.findOne({ ...scope, _id: tableId }).session(session));
      if (table.sessionId) throw new ConflictException('Bàn đang phục vụ.');
      const pack = guests && await BuffetPackage.findOne({ ...scope, _id: guests.packageId, enabled: true }).session(session).lean();
      if (guests && !pack) throw new ConflictException('Gói buffet này đã ngừng sử dụng hoặc không có tại chi nhánh.');
      const buffet = guests && pack && { adults: guests.adults, children: guests.children, adultPrice: pack.adultPrice,
        childPrice: pack.childPrice, packageName: pack.name };
      const service = await TableSession.insertOne({ ...scope, tableIds: [table._id], status: 'OPEN', openedBy: actorId,
        guestCount: buffet ? buffet.adults + buffet.children : guestCount ?? table.reservation?.guests ?? 1,
        buffet, buffetProductIds: pack?.productIds }, { session });
      table.sessionId = service._id;
      table.reserved = false;
      table.reservation = undefined;
      await table.save({ session });
      await logChange(scope, actorId, 'TABLE_OPEN', service._id, session);
      await recordEvent(scope, 'table.updated', table._id, session);
      return { id: service.id };
    });
  }

  @Patch('tables/:id/reservation')
  async reserveTable(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { reserved, reservation } = read(z.object({ reserved: z.boolean(), reservation: z.object({
      guestName: label, phone: z.string().trim().regex(/^[+\d][\d .-]{6,17}$/).optional(), guests: z.number().int().min(1).max(1000),
      arrivesAt: z.string().datetime({ offset: true }).transform(value => new Date(value)), note: z.string().trim().max(240).optional(),
    }).strict().optional() }).strict().refine(item => item.reserved || !item.reservation), body);
    const id = identifier(route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.manage', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const table = found(await DiningTable.findOne({ ...scope, _id: id }).session(session));
      if (table.sessionId) throw new ConflictException('Bàn đang phục vụ.');
      table.reserved = reserved;
      if (reservation || !reserved) table.reservation = reservation;
      await table.save({ session });
      await logChange(scope, actorId, 'TABLE_RESERVATION', table._id, session, { reserved });
      return table.toObject();
    });
  }

  @Patch('table-sessions/:id/guests')
  async guests(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.union([z.object({ guestCount: z.number().int().min(1).max(1000) }).strict(),
      z.object({ buffet: buffetGuests }).strict()]), body);
    const id = identifier(route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.serve', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const service = found(await TableSession.findOne({ ...scope, _id: id, status: 'OPEN', takeaway: { $ne: true } }).session(session));
      if (service.checkoutBillId) throw new ConflictException('Bàn đã chốt hóa đơn. Hãy thanh toán trước.');
      if ('buffet' in input) {
        if (!service.buffet) throw new ConflictException('Bàn này chưa chọn gói buffet.');
        service.buffet.adults = input.buffet.adults;
        service.buffet.children = input.buffet.children;
        service.guestCount = input.buffet.adults + input.buffet.children;
      } else {
        if (service.buffet) throw new ConflictException('Hãy nhập số khách lớn và trẻ em của bàn buffet.');
        service.guestCount = input.guestCount;
      }
      await service.save({ session });
      const guestCount = service.guestCount;
      await logChange(scope, actorId, 'TABLE_GUESTS_SET', service._id, session, { guestCount });
      return { guestCount };
    });
  }

  @Post('table-sessions/:id/tables')
  async changeTables(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = identifier(route.id);
    const { tableId } = read(z.object({ tableId: objectId, action: z.literal('MOVE') }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.manage', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const service = found(await TableSession.findOne({ ...scope, _id: id, status: 'OPEN', takeaway: { $ne: true } }).session(session));
      if (service.checkoutBillId) throw new ConflictException('Bàn đã chốt hóa đơn. Hãy thanh toán trước.');
      const table = found(await DiningTable.findOne({ ...scope, _id: tableId }).session(session));
      if (table.sessionId || table.reserved) throw new ConflictException('Hãy chọn bàn trống.');
      await DiningTable.updateMany({ ...scope, sessionId: service._id }, { $unset: { sessionId: 1 } }, { session });
      service.tableIds = [table._id];
      await service.save({ session });
      table.sessionId = service._id;
      await table.save({ session });
      await logChange(scope, actorId, 'TABLE_MOVE', service._id, session, { tableId });
      await recordEvent(scope, 'table.updated', table._id, session);
      return { ok: true };
    });
  }

  @Post('service-mode')
  async changeService(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(z.union([
      z.object({ mode: z.literal('TAKEAWAY'), tableId: objectId, sessionId: objectId }).strict(),
      z.object({ mode: z.literal('TABLE'), tableId: objectId, sessionId: objectId }).strict(),
      z.object({ mode: z.literal('TABLE'), tableId: objectId, orderId: objectId }).strict(),
    ]), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'tables.serve');
    return idempotent(scope, 'SERVICE_MODE_CHANGE', key, { actorId, input }, async session => {
      const { branch } = await access(req, route.tenantId, route.branchId, 'tables.serve', session);
      await restaurant(scope, branch.mode, 'qr', session);
      const takeaway = input.mode === 'TAKEAWAY';
      if (takeaway) await requireModule(scope, 'pos', session);
      const table = found(await DiningTable.findOne({ ...scope, _id: input.tableId }).session(session));
      if (!takeaway && (table.sessionId || table.reserved)) throw new ConflictException('Hãy chọn bàn trống.');

      let service;
      let orderFilter;
      if ('sessionId' in input) {
        service = found(await TableSession.findOne({ ...scope, _id: input.sessionId, status: 'OPEN' }).session(session), 'Lượt phục vụ đã đóng.');
        if (service.checkoutBillId) throw new ConflictException('Hãy đổi hình thức phục vụ trước khi chốt hóa đơn.');
        if (takeaway ? service.takeaway || !table.sessionId?.equals(service._id) : !service.takeaway) {
          throw new ConflictException('Lượt phục vụ vừa đổi hình thức. Hãy mở lại đơn hiện tại.');
        }
        orderFilter = { tableSessionId: service._id };
      } else {
        const order = found(await Order.findOne({ ...scope, _id: input.orderId, takeaway: true, tableSessionId: null,
          billId: null, status: 'ACCEPTED' }).session(session), 'Đơn mang về đã đổi hình thức, chốt hóa đơn hoặc đã đóng.');
        service = new TableSession({ ...scope, tableIds: [], status: 'OPEN', openedBy: actorId, guestCount: 1, createdAt: order.createdAt });
        orderFilter = { _id: order._id };
      }
      const orders = await Order.find({ ...scope, ...orderFilter }).select('_id billId').session(session).lean();
      if (orders.some(order => order.billId)) throw new ConflictException('Hãy đổi hình thức phục vụ trước khi chốt hóa đơn.');

      service.takeaway = takeaway;
      service.tableIds = takeaway ? [] : [table._id];
      service.paymentRequestedAt = undefined;
      await service.save({ session });
      if (takeaway) {
        await releaseTables(scope, service._id, session);
        await GuestSession.deleteMany({ ...scope, tableSessionId: service._id }, { session });
      } else {
        table.sessionId = service._id;
        await table.save({ session });
        await recordEvent(scope, 'table.updated', table._id, session);
      }

      const orderIds = orders.map(order => order._id);
      const destination = takeaway ? { $set: { takeaway: true }, $unset: { tableName: 1 } } :
        { $set: { tableName: table.name }, $unset: { takeaway: 1 } };
      await Order.updateMany({ ...scope, _id: { $in: orderIds } },
        { ...destination, $set: { ...destination.$set, tableSessionId: service._id } }, { session });
      await KitchenTicket.updateMany({ ...scope, orderId: { $in: orderIds } }, destination, { session });
      await recordEvent(scope, 'kitchen.updated', service._id, session);
      await logChange(scope, actorId, 'SERVICE_MODE_CHANGE', service._id, session, { mode: input.mode, tableId: table.id });
      return { id: service.id, tableId: takeaway ? undefined : table.id };
    });
  }

  @Post('table-sessions/:id/close')
  async close(@Req() req: Request, @Param() route: Route) {
    const id = identifier(route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'tables.serve', session);
      const service = found(await TableSession.findOne({ ...scope, _id: id, status: 'OPEN' }).session(session));
      await restaurant(scope, branch.mode, service.takeaway ? 'pos' : 'qr', session);
      if (service.checkoutBillId) throw new ConflictException('Hãy thanh toán hóa đơn trước khi đóng lượt.');
      if (await Order.exists({ ...scope, tableSessionId: service._id, status: { $in: ['PLACED', 'ACCEPTED'] } }).session(session)) {
        throw new ConflictException('Hãy xử lý và thanh toán các đơn của bàn trước khi đóng lượt.');
      }
      if (service.buffet) {
        throw new ConflictException('Hãy thanh toán hóa đơn buffet trước khi đóng lượt.');
      }
      const orders = await Order.find({ ...scope, tableSessionId: service._id }).select('_id').session(session).lean();
      if (await KitchenTicket.exists({ ...scope, orderId: { $in: orders.map(order => order._id) },
        'items.status': { $in: waitingKitchenStatuses } }).session(session)) {
        throw new ConflictException('Bếp còn món chưa phục vụ.');
      }
      service.status = 'CLOSED';
      service.closedAt = new Date();
      await service.save({ session });
      await releaseTables(scope, service._id, session);
      await GuestSession.deleteMany({ ...scope, tableSessionId: service._id }, { session });
      await logChange(scope, actorId, 'TABLE_CLOSE', service._id, session);
      return { ok: true };
    });
  }

  @Get('kitchen/tickets')
  async tickets(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { page, view, queue } = read(z.object({ page: pageSchema, view: kitchenView,
      queue: z.enum(['active', 'history']).optional() }), query);
    const { scope, branch } = await access(req, route.tenantId, route.branchId, view === 'service' ? 'kitchen.serve' : 'kitchen.work');
    await restaurant(scope, branch.mode, 'kitchen');
    const recent = { createdAt: { $gt: new Date(Date.now() - 86400000) } };
    const active = { $or: [{ 'items.status': { $in: waitingKitchenStatuses } },
      { items: { $elemMatch: { status: 'CANCELED', cancelReason: { $ne: null }, cancelConfirmedAt: null } } }] };
    const history = { ...recent, $nor: [active] };
    const filter = queue === 'active' ? active : queue === 'history' ? history : { $or: [active, recent] };
    const offset = (page - 1) * 100;
    if (queue === 'history') {
      return KitchenTicket.find({ ...scope, ...filter }).sort('-createdAt -_id').skip(offset).limit(100).lean();
    }
    return KitchenTicket.aggregate([
      { $match: { ...scope, ...filter } },
      { $set: { legacyOrderId: { $cond: [{ $ifNull: ['$orderedAt', false] }, null, '$orderId'] } } },
      { $lookup: { from: Order.collection.name, localField: 'legacyOrderId', foreignField: '_id',
        pipeline: [{ $match: scope }, { $project: { createdAt: 1 } }], as: 'legacyOrder' } },
      { $set: { orderedAt: { $ifNull: ['$orderedAt', { $first: '$legacyOrder.createdAt' }, '$createdAt'] } } },
      { $sort: { orderedAt: 1, orderId: 1 } }, { $skip: offset }, { $limit: 100 },
      { $unset: ['legacyOrderId', 'legacyOrder'] },
    ]);
  }

  @Get('kitchen/preparation-summary')
  async preparationSummary(@Req() req: Request, @Param() route: Route, @Query('view') rawView?: string) {
    const view = read(kitchenView, rawView);
    const { scope, branch } = await access(req, route.tenantId, route.branchId, view === 'service' ? 'kitchen.serve' : 'kitchen.work');
    await restaurant(scope, branch.mode, 'kitchen');
    const waiting = { 'items.status': { $in: waitingKitchenStatuses } };
    const dishes = await KitchenTicket.aggregate<{ name: string; quantity: number }>([
      { $match: { ...scope, ...waiting } },
      { $unwind: '$items' },
      { $match: waiting },
      { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' } } },
      { $sort: { quantity: -1, _id: 1 } },
      { $project: { _id: 0, name: '$_id', quantity: 1 } },
    ]).collation({ locale: 'vi' });
    return { dishes, totalQuantity: dishes.reduce((total, dish) => total + dish.quantity, 0) };
  }

  @Post('kitchen/items/:id/transition')
  async transition(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const itemId = identifier(route.id);
    const { status } = read(z.object({ status: z.enum(['COOKING', 'READY', 'SERVED']) }).strict(), body);
    const previous = { COOKING: ['NEW'], READY: ['COOKING'], SERVED: waitingKitchenStatuses } as const;
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId,
        status === 'SERVED' ? 'kitchen.serve' : 'kitchen.work', session);
      const ticket = found(await KitchenTicket.findOne({ ...scope, 'items._id': itemId }).session(session));
      if (ticket.takeaway && status === 'SERVED') await requireModule(scope, 'pos', session);
      else await restaurant(scope, branch.mode, 'kitchen', session);
      const item = found(ticket.items.id(itemId));
      if (!(previous[status] as readonly string[]).includes(item.status)) throw new ConflictException('Trạng thái món đã thay đổi.');
      item.status = status;
      const now = new Date();
      if (status === 'COOKING') item.cookingAt = now;
      if (status === 'READY') item.readyAt = now;
      if (status === 'SERVED') { item.servedAt = now; item.servedBy = mongoId(actorId); }
      await ticket.save({ session });
      await logChange(scope, actorId, 'KITCHEN_TRANSITION', ticket._id, session, { itemId, status });
      await recordEvent(scope, 'kitchen.updated', ticket._id, session);
      return ticket.toObject();
    });
  }

  @Post('kitchen/items/:id/confirm-cancel')
  async confirmCancellation(@Req() req: Request, @Param() route: Route) {
    const itemId = identifier(route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'kitchen.serve', session);
      const ticket = found(await KitchenTicket.findOne({ ...scope, 'items._id': itemId }).session(session));
      await restaurant(scope, branch.mode, ticket.takeaway ? 'pos' : 'kitchen', session);
      const item = found(ticket.items.id(itemId));
      if (item.status !== 'CANCELED' || !item.cancelReason) throw new ConflictException('Món chưa có yêu cầu hủy.');
      if (!item.cancelConfirmedAt) {
        item.cancelConfirmedAt = new Date();
        await ticket.save({ session });
        await logChange(scope, actorId, 'KITCHEN_CANCEL_CONFIRM', ticket._id, session, { itemId });
        await recordEvent(scope, 'kitchen.updated', ticket._id, session);
      }
      return { cancelConfirmedAt: item.cancelConfirmedAt };
    });
  }

  @Get('events')
  async events(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'kitchen.work');
    await restaurant(scope, branch.mode, 'kitchen');
    const { after } = read(z.object({ after: objectId.optional() }), query);
    return OutboxEvent.find({ ...scope, ...(after ? { _id: { $gt: after } } : {}) }).select('type resourceId').sort('_id').limit(100).lean();
  }
}

@Controller('guest')
export class GuestController {
  @Get('menu/:tenantId/:token')
  @Header('Cache-Control', 'no-store')
  async menu(@Param() route: { tenantId: string; token: string }, @Query() query: unknown) {
    const { table, tenant, branch, scope } = await tableContext(route.tenantId, route.token);
    const { page, categoryId, q, section } = read(z.object({ page: pageSchema, categoryId: objectId.optional(), q: z.string().trim().max(100).optional(),
      section: z.enum(['included', 'extra']).default('included') }), query);
    const service = table.sessionId ? await TableSession.findOne({ ...scope, _id: table.sessionId, status: 'OPEN', tableIds: table._id })
      .select('buffet buffetProductIds checkoutBillId').lean() : undefined;
    const [products, categories] = await Promise.all([
      catalog(scope, { page, categoryId, q, productType: 'FOOD', menuFilter: buffetMenuFilter(service, section),
        ignoreRecipeStock: !!service?.buffet && section === 'included' }),
      Category.find({ tenantId: scope.tenantId }).select('name').sort('name').lean(),
    ]);
    const included = !!service?.buffet && section === 'included';
    const menu = products.map(product => ({ ...product, variants: product.variants.map(variant => ({ ...variant,
      sku: undefined, barcode: undefined, attributes: { size: variant.attributes?.size },
      basePrice: included ? 0 : variant.basePrice, branchPrice: included ? undefined : variant.branchPrice,
    })) }));
    return { tenant: tenant.name, branch: branch.name, mode: branch.mode, table: table.name, categories, products: menu,
      buffet: !!service?.buffet, buffetName: service?.buffet?.packageName, section,
      orderState: !branch.location ? 'UNCONFIGURED' : !service ? 'WAITING' : service.checkoutBillId ? 'PAYMENT' : 'READY',
      serviceId: service?._id.toString() };
  }

  @Post('sessions/:tenantId/:token')
  async join(@Param() route: { tenantId: string; token: string }, @Body() body: unknown) {
    const { position } = read(z.object({ position: guestLocation }).strict(), body);
    const { table, scope, branch } = await tableContext(route.tenantId, route.token);
    requireGuestLocation(branch.location, position);
    if (!table.sessionId) throw new UnauthorizedException('Bàn chưa mở lượt phục vụ.');
    const service = await TableSession.findOne({ ...scope, _id: table.sessionId, status: 'OPEN', checkoutBillId: null, tableIds: table._id,
      takeaway: { $ne: true } }).lean();
    if (!service) throw new UnauthorizedException('Bàn chưa có lượt gọi món hoặc đã chốt hóa đơn.');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 2 * 3600000);
    await GuestSession.create({ ...scope, tableSessionId: service._id, tokenHash: hash(token), expiresAt });
    return { token, expiresAt, serviceId: service._id.toString() };
  }

  @Post('orders')
  async order(@Headers('authorization') authorization: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const { items, position } = read(z.object({ items: z.array(lineSchema).min(1).max(50), position: guestLocation }).strict(), body);
    const { guest, scope, branch } = await authorizedGuest(authorization, undefined, true);
    requireGuestLocation(branch.location, position);
    return idempotent(scope, 'GUEST_ORDER', key, { guestId: String(guest._id), items }, async session => {
      const { tableSession, branch } = await authorizedGuest(authorization, session, true);
      requireGuestLocation(branch.location, position);
      if (tableSession.checkoutBillId) throw new ConflictException('Bàn đã chốt hóa đơn. Hãy mở lượt mới để gọi món.');
      const table = found(await DiningTable.findOne({ ...scope, _id: { $in: tableSession.tableIds }, sessionId: tableSession._id })
        .sort('_id').session(session).lean());
      const order = await placeOrder(scope, { items, source: 'QR', tableSessionId: tableSession._id, guestSessionId: guest._id, tableName: table.name }, session);
      return { id: order.id, totalAmount: order.totalAmount, status: order.status };
    });
  }

  @Get('orders')
  async orders(@Headers('authorization') authorization?: string) {
    const { guest, scope } = await authorizedGuest(authorization, undefined, true);
    const orders = await Order.find({ ...scope, tableSessionId: guest.tableSessionId }).select('items totalAmount status createdAt').sort('createdAt _id').lean();
    const tickets = await KitchenTicket.find({ ...scope, orderId: { $in: orders.map(order => order._id) } })
      .select('orderId items.orderItemId items.status items.readyAt items.servedAt').lean();
    const byOrder = new Map(tickets.map(ticket => [String(ticket.orderId), ticket.items.map(({ orderItemId, status, readyAt, servedAt }) =>
      ({ orderItemId, status, readyAt, servedAt }))]));
    return orders.map(order => ({ ...order, items: order.items.map(({ ingredients, stockLots, ingredientCost, ingredientCostIncomplete, unitCost, ...item }) => ({ ...item, sku: undefined })),
      kitchen: byOrder.get(String(order._id)) ?? [] }));
  }

  @Get('table-payment')
  async tablePayment(@Headers('authorization') authorization?: string) {
    const { scope, tableSession, branch } = await authorizedGuest(authorization, undefined, true);
    const cart = await tableCart(scope, tableSession);
    const bill = cart.bills.find(item => item._id.equals(tableSession.checkoutBillId));
    return { requested: !!tableSession.paymentRequestedAt, due: cart.due, status: bill?.status, billId: bill?._id.toString(), buffet: bill?.buffet ?? tableSession.buffet,
      qrAvailable: bill?.status === 'OPEN' && !!branch.bankAccount?.bank && !!branch.bankAccount.account };
  }

  @Post('table-payment/request')
  async requestPayment(@Headers('authorization') authorization?: string) {
    return transaction(async session => {
      const { scope, tableSession } = await authorizedGuest(authorization, session);
      if (!tableSession.buffet && !await Order.exists({ ...scope, tableSessionId: tableSession._id, status: { $in: ['PLACED', 'ACCEPTED'] } }).session(session)) {
        throw new ConflictException('Bàn không có món hoặc suất buffet đang chờ thanh toán.');
      }
      if (!tableSession.paymentRequestedAt) await TableSession.updateOne({ ...scope, _id: tableSession._id },
        { $set: { paymentRequestedAt: new Date() } }, { session });
      return { ok: true };
    });
  }

  @Post('table-payment/qr')
  async tablePaymentQr(@Headers('authorization') authorization?: string) {
    return transaction(async session => {
      const { scope, branch, tableSession } = await authorizedGuest(authorization, session, true);
      return this.checkoutQr(scope, tableSession.checkoutBillId, branch.bankAccount, session);
    });
  }

  @Post('orders/:id/payment-qr')
  async paymentQr(@Headers('authorization') authorization: string | undefined, @Param('id') rawId: string) {
    const id = identifier(rawId);
    return transaction(async session => {
      const { guest, scope, branch, tableSession } = await authorizedGuest(authorization, session, true);
      const order = found(await Order.findOne({ ...scope, guestSessionId: guest._id, tableSessionId: tableSession._id, _id: id }).session(session).lean());
      if (order.status === 'COMPLETED') return { paid: true as const };
      if (!order.billId || !order.billId.equals(tableSession.checkoutBillId)) {
        throw new ConflictException('Hãy yêu cầu nhân viên kiểm món và chốt hóa đơn của bàn.');
      }
      return this.checkoutQr(scope, tableSession.checkoutBillId, branch.bankAccount, session);
    });
  }

  private async checkoutQr(scope: Scope, billId: { toString(): string } | null | undefined,
    account: Parameters<typeof transferQr>[3], session: ClientSession) {
    if (!billId) throw new ConflictException('Hãy yêu cầu nhân viên kiểm món và chốt hóa đơn của bàn.');
    const bill = found(await Bill.findOne({ ...scope, _id: String(billId) }).session(session).lean());
    if (bill.status === 'PAID') return { paid: true as const };
    const intent = await transferQr(scope, String(bill._id), bill.totalAmount - bill.paidAmount, account, session, true);
    return { paid: false as const, billId: String(bill._id), qrUrl: intent.qrUrl, amount: intent.amount, reference: intent.reference,
      bankAccount: intent.bankAccount, expiresAt: intent.expiresAt };
  }
}
