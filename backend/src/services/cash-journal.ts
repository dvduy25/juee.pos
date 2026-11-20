import type { PipelineStage } from 'mongoose';
import type { Scope } from '../middleware/business-access';
import { HotelBooking, MemberPayment, Payment, PurchaseReceipt, Refund, TicketRefund, TicketSale } from '../models';
import { cashEntryRange } from './operating-expenses';

export function cashJournal(scope: Scope, dates: { $lte: Date; $gte?: Date }): PipelineStage[] {
  const literal = (text: string) => ({ $literal: text });
  const sources = [
    { coll: Payment.collection.name, date: 'paidAt', method: '$method', amount: '$amount', note: literal('Thu hóa đơn'), direction: 'IN', source: 'SALE', billId: 1 },
    { coll: HotelBooking.collection.name, date: 'paidAt', method: '$paymentMethod', amount: '$amount', note: '$roomCode', direction: 'IN', source: 'HOTEL' },
    { coll: TicketSale.collection.name, date: 'paidAt', method: '$paymentMethod', amount: '$amount', note: '$typeName', direction: 'IN', source: 'TICKET' },
    { coll: TicketRefund.collection.name, date: 'createdAt', method: '$method', amount: '$amount',
      note: { $concat: ['$typeName', ' · ', '$reason'] }, direction: 'OUT', source: 'TICKET_REFUND' },
    { coll: MemberPayment.collection.name, date: 'paidAt', method: '$method', amount: '$amount',
      note: { $concat: ['$memberName', ' · ', '$planName'] }, direction: 'IN', source: 'MEMBER' },
    { coll: PurchaseReceipt.collection.name, date: 'createdAt', method: '$method', amount: '$totalAmount', note: '$supplier', direction: 'OUT', source: 'PURCHASE' },
  ];
  return [
    { $match: cashEntryRange(scope, dates) },
    { $project: { occurredAt: { $ifNull: ['$occurredAt', '$createdAt'] }, method: 1, amount: 1, note: 1, category: 1,
      expenseKind: 1, direction: 1, source: literal('MANUAL') } },
    ...sources.map(({ coll, date, method, amount, note, direction, source, billId }) => ({
      $unionWith: { coll, pipeline: [
        { $match: { ...scope, [date]: { $type: 'date', ...dates } } },
        { $project: { occurredAt: `$${date}`, method, amount, note, direction: literal(direction), source: literal(source), ...(billId ? { billId } : {}) } },
      ] },
    })),
    { $unionWith: { coll: Refund.collection.name, pipeline: [
      { $match: { ...scope, createdAt: dates } },
      { $lookup: { from: Payment.collection.name, localField: 'paymentId', foreignField: '_id', pipeline: [{ $match: scope }], as: 'payment' } },
      { $project: { occurredAt: '$createdAt', method: { $first: '$payment.method' }, amount: 1, note: '$reason',
        billId: { $first: '$payment.billId' }, source: literal('REFUND'), direction: literal('OUT') } },
    ] } },
  ];
}
