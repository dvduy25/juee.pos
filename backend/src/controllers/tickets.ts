import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange, type Scope } from '../middleware/business-access';
import { AdmissionTicket, TicketRefund, TicketSale, TicketType, recordedPaymentMethods } from '../models';
import { scopedRoute } from '../routes/branch';
import { idempotent } from '../services/sales';
import { ticketEntryQuantities, ticketIssueModes, ticketSalePrice, ticketWindowState } from '../services/ticket-rules';
import { found, isDuplicate, localFilter, mongoId } from '../utils/db';
import { qrImage } from '../utils/qr';
import { label, objectId, read, vnd } from '../validators/common';
import { pageSchema } from '../validators/sales';

type Route = { tenantId: string; branchId: string; id: string };
const dateTime = z.string().datetime({ offset: true }).transform(value => new Date(value)).nullable().optional();
const typeInput = z.object({ name: label, price: vnd, active: z.boolean().default(true),
  capacity: z.number().int().min(1).max(1000000).nullable().optional(),
  saleStartsAt: dateTime, saleEndsAt: dateTime, admissionStartsAt: dateTime, admissionEndsAt: dateTime,
  earlyPrice: vnd.nullable().optional(), earlyUntil: dateTime }).strict();
const saleInput = z.object({ typeId: objectId, quantity: z.number().int().min(1).max(50),
  buyerName: label.optional(), buyerPhone: z.string().trim().regex(/^\+?\d{7,15}$/).optional(),
  expectedPrice: vnd, paymentMethod: z.enum(recordedPaymentMethods), ticketMode: z.enum(ticketIssueModes).optional() }).strict();
const admissionCode = z.string().trim().toUpperCase().regex(/^VE-[0-9A-F]{20}$/, 'Mã vé không hợp lệ.');

async function ticketAccess(req: Request, route: Route, session?: ClientSession, manage = false) {
  const result = await access(req, route.tenantId, route.branchId, manage ? 'tickets.manage' : 'tickets.operate', session);
  if (result.branch.mode !== 'TICKETS') throw new ConflictException('Chi nhánh này chưa dùng mô hình Thu vé.');
  return result;
}

function soldByType(scope: Scope, typeId?: string, session?: ClientSession) {
  const query = TicketSale.aggregate<{ _id: { toString(): string }; sold: number }>([
    { $match: { ...scope, refundedAt: null, ...(typeId && { typeId: mongoId(typeId) }) } },
    { $group: { _id: '$typeId', sold: { $sum: '$quantity' } } },
  ]);
  return session ? query.session(session) : query;
}

@Controller(scopedRoute)
export class TicketsController {
  @Get('ticket-types')
  async types(@Req() req: Request, @Param() route: Route) {
    const { scope } = await ticketAccess(req, route);
    const [types, sales] = await Promise.all([TicketType.find(scope).sort('name _id').lean(), soldByType(scope)]);
    const now = new Date();
    const counts = new Map(sales.map(sale => [String(sale._id), sale.sold]));
    return types.map(type => {
      const sold = counts.get(String(type._id)) ?? 0;
      return { ...type, sold, remaining: type.capacity == null ? null : Math.max(0, type.capacity - sold),
        currentPrice: ticketSalePrice(type, now),
        saleState: type.active ? ticketWindowState(type.saleStartsAt, type.saleEndsAt ?? type.admissionEndsAt, now) : 'INACTIVE' };
    });
  }

  @Post('ticket-types')
  createType(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.saveType(req, route, body);
  }

  @Patch('ticket-types/:id')
  updateType(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.saveType(req, route, body, read(objectId, route.id));
  }

  private saveType(req: Request, route: Route, body: unknown, id?: string) {
    const input = read(typeInput, body);
    return transaction(async session => {
      const { scope, actorId } = await ticketAccess(req, route, session, true);
      const previous = id ? found(await TicketType.findOne({ ...scope, _id: id }).session(session).lean(), 'Không tìm thấy loại vé.') : undefined;
      const terms = { ...previous, ...input };
      if ((terms.saleStartsAt && terms.saleEndsAt && terms.saleStartsAt >= terms.saleEndsAt) ||
          (terms.admissionStartsAt && terms.admissionEndsAt && terms.admissionStartsAt >= terms.admissionEndsAt) ||
          (terms.saleEndsAt && terms.admissionEndsAt && terms.saleEndsAt > terms.admissionEndsAt) ||
          (terms.saleStartsAt && terms.admissionEndsAt && terms.saleStartsAt >= terms.admissionEndsAt)) {
        throw new BadRequestException('Giờ kết thúc phải sau giờ bắt đầu. Ngừng bán chậm nhất khi hết giờ vào cửa.');
      }
      if ((terms.earlyPrice != null) !== Boolean(terms.earlyUntil) ||
          (terms.earlyPrice != null && terms.earlyPrice >= terms.price) ||
          (terms.earlyUntil && ((terms.saleStartsAt && terms.earlyUntil <= terms.saleStartsAt) ||
            (terms.saleEndsAt && terms.earlyUntil > terms.saleEndsAt)))) {
        throw new BadRequestException('Giá mua sớm phải thấp hơn giá thường và có mốc kết thúc trong khung giờ bán.');
      }
      if (id && terms.capacity != null) {
        const [sales] = await soldByType(scope, id, session);
        if (terms.capacity < (sales?.sold ?? 0)) throw new ConflictException('Số vé tối đa không thể thấp hơn số vé đã bán.');
      }
      const type = id ? found(await TicketType.findOneAndUpdate({ ...scope, _id: id }, { $set: input },
        { session, runValidators: true, returnDocument: 'after' }).lean(), 'Không tìm thấy loại vé.') :
        (await TicketType.insertOne({ ...scope, ...input }, { session })).toObject();
      await logChange(scope, actorId, id ? 'TICKET_TYPE_UPDATE' : 'TICKET_TYPE_CREATE', type._id, session);
      return type;
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tên loại vé đã được sử dụng tại chi nhánh.');
      throw error;
    });
  }

  @Get('ticket-sales')
  async sales(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await ticketAccess(req, route);
    const { page, q } = read(z.object({ page: pageSchema, q: z.string().trim().max(120).optional() }), query);
    const filter = q && localFilter(q);
    const ticket = q && /^VE-[0-9A-F]{20}$/i.test(q) ?
      await AdmissionTicket.findOne({ ...scope, code: q.toUpperCase() }).select('saleId').lean() : undefined;
    return TicketSale.find({ ...scope, ...(filter && { $or: [
      { typeName: filter }, { buyerName: filter }, { buyerPhone: filter }, ...(ticket ? [{ _id: ticket.saleId }] : []),
    ] }) }).sort('-paidAt -_id').skip((page - 1) * 50).limit(50).lean();
  }

  @Get('ticket-sales/:id')
  async sale(@Req() req: Request, @Param() route: Route) {
    const { scope } = await ticketAccess(req, route);
    const id = read(objectId, route.id);
    const sale = found(await TicketSale.findOne({ ...scope, _id: id }).lean(), 'Không tìm thấy lượt bán vé.');
    const [tickets, refund] = await Promise.all([
      AdmissionTicket.find({ ...scope, saleId: sale._id }).sort('_id').select('code entryQuantity usedAt admissionStartsAt admissionEndsAt').lean(),
      sale.refundedAt ? TicketRefund.findOne({ ...scope, saleId: sale._id }).select('amount reason method createdAt').lean() : undefined,
    ]);
    return { ...sale, refund, tickets: tickets.map(ticket => ({ ...ticket, entryQuantity: ticket.entryQuantity ?? 1, qr: qrImage(ticket.code) })) };
  }

  @Post('ticket-sales/:id/refund')
  async refund(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = read(objectId, route.id);
    const { reason, method } = read(z.object({ reason: label, method: z.enum(recordedPaymentMethods) }).strict(), body);
    const { scope, actorId } = await ticketAccess(req, route, undefined, true);
    return idempotent(scope, 'TICKET_REFUND', key, { id, actorId, reason, method }, async session => {
      await ticketAccess(req, route, session, true);
      const sale = found(await TicketSale.findOne({ ...scope, _id: id }).session(session), 'Không tìm thấy lượt bán vé.');
      if (sale.refundedAt) throw new ConflictException('Lượt bán vé này đã được hoàn.');
      if (await AdmissionTicket.exists({ ...scope, saleId: sale._id, usedAt: { $type: 'date' } }).session(session)) {
        throw new ConflictException('Chỉ hoàn lượt bán khi tất cả vé trong lượt bán đều chưa soát.');
      }
      const refund = await TicketRefund.insertOne({ ...scope, saleId: sale._id, actorId, reason, method,
        amount: sale.amount, quantity: sale.quantity, typeName: sale.typeName }, { session });
      sale.refundedAt = refund.createdAt;
      await sale.save({ session });
      await logChange(scope, actorId, 'TICKET_REFUND', sale._id, session, { refundId: refund._id });
      return refund.toObject();
    });
  }

  @Post('ticket-sales')
  async sell(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const { expectedPrice, ...input } = read(saleInput, body);
    const { scope, actorId } = await ticketAccess(req, route);
    return idempotent(scope, 'TICKET_SELL', key, { actorId, expectedPrice, ...input }, async session => {
      await ticketAccess(req, route, session);
      // Serialize capacity checks and changes to the same ticket type.
      const type = found(await TicketType.findOneAndUpdate({ ...scope, _id: input.typeId, active: true },
        { $inc: { salesRevision: 1 } }, { session, timestamps: false }).lean(),
        'Loại vé đã ngừng bán hoặc không tồn tại.');
      const now = new Date();
      if (ticketWindowState(type.saleStartsAt, type.saleEndsAt, now) !== 'OPEN' ||
          (type.admissionEndsAt && now >= type.admissionEndsAt)) {
        throw new ConflictException('Loại vé này nằm ngoài khung giờ bán.');
      }
      const price = ticketSalePrice(type, now);
      if (expectedPrice !== price) throw new ConflictException('Giá vé vừa thay đổi. Hãy kiểm tra lại số tiền đã nhận.');
      if (type.capacity != null) {
        const [sales] = await soldByType(scope, input.typeId, session);
        const remaining = Math.max(0, type.capacity - (sales?.sold ?? 0));
        if (input.quantity > remaining) throw new ConflictException(`Loại vé này chỉ còn ${remaining} vé.`);
      }
      const ticketMode = input.ticketMode ?? 'SEPARATE';
      const sale = await TicketSale.insertOne({ ...scope, ...input, ticketMode, typeName: type.name, unitPrice: price,
        amount: price * input.quantity, paidAt: now, actorId }, { session });
      await AdmissionTicket.insertMany(ticketEntryQuantities(input.quantity, ticketMode).map(entryQuantity => ({ ...scope, saleId: sale._id, entryQuantity,
        typeName: type.name, admissionStartsAt: type.admissionStartsAt, admissionEndsAt: type.admissionEndsAt,
        code: `VE-${randomBytes(10).toString('hex').toUpperCase()}` })), { session });
      await logChange(scope, actorId, 'TICKET_SELL', sale._id, session);
      return sale.toObject();
    });
  }

  @Get('ticket-admissions')
  async admissions(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await ticketAccess(req, route);
    const { page } = read(z.object({ page: pageSchema }), query);
    const tickets = await AdmissionTicket.find({ ...scope, usedAt: { $type: 'date' } }).sort('-usedAt -_id').skip((page - 1) * 50).limit(50).lean();
    return tickets.map(ticket => ({ ...ticket, entryQuantity: ticket.entryQuantity ?? 1 }));
  }

  @Post('ticket-admissions')
  async admit(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const { code } = read(z.object({ code: admissionCode }).strict(), body);
    const { scope, actorId } = await ticketAccess(req, route);
    return idempotent(scope, 'TICKET_ADMIT', key, { actorId, code }, async session => {
      await ticketAccess(req, route, session);
      const ticket = found(await AdmissionTicket.findOne({ ...scope, code }).session(session), 'Không tìm thấy vé tại chi nhánh.');
      if (ticket.usedAt) throw new ConflictException('Vé này đã được soát.');
      // A scan and a refund both write to the sale so they cannot commit together.
      const sale = found(await TicketSale.findOneAndUpdate({ ...scope, _id: ticket.saleId },
        { $inc: { admissionRevision: 1 } }, { session, timestamps: false }).select('refundedAt').lean(),
        'Không tìm thấy lượt bán của vé.');
      if (sale.refundedAt) throw new ConflictException('Vé đã được hoàn.');
      const now = new Date();
      const state = ticketWindowState(ticket.admissionStartsAt, ticket.admissionEndsAt, now);
      if (state === 'UPCOMING') throw new ConflictException('Vé chưa đến giờ vào cửa.');
      if (state === 'ENDED') throw new ConflictException('Vé đã hết giờ vào cửa.');
      ticket.set({ usedAt: now, usedBy: actorId });
      await ticket.save({ session });
      await logChange(scope, actorId, 'TICKET_ADMIT', ticket._id, session, { entryQuantity: ticket.entryQuantity });
      return ticket.toObject();
    });
  }
}
