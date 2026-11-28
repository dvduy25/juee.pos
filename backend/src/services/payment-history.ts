import type { PipelineStage } from 'mongoose';
import type { Scope } from '../middleware/business-access';
import { Bill, HotelBooking, MemberPayment, TicketSale, memberBranchModes, type BranchMode } from '../models';

export const paymentSources = ['GOODS', 'MEMBER', 'HOTEL', 'TICKET'] as const;
type PaymentSource = typeof paymentSources[number];

const sources = {
  GOODS: { model: Bill, time: 'createdAt', filter: {}, fields: { amount: '$totalAmount', status: 1 } },
  MEMBER: { model: MemberPayment, time: 'paidAt', filter: {}, fields: { amount: 1, status: { $literal: 'PAID' },
    title: '$planName', customer: '$memberName', method: 1 } },
  HOTEL: { model: HotelBooking, time: 'paidAt', filter: { status: 'CHECKED_OUT' }, fields: { amount: 1, status: { $literal: 'PAID' },
    title: '$roomCode', packageName: 1, customer: '$guestName', method: '$paymentMethod' } },
  TICKET: { model: TicketSale, time: 'paidAt', filter: {}, fields: { amount: 1,
    status: { $cond: [{ $ifNull: ['$refundedAt', false] }, 'REFUNDED', 'PAID'] },
    title: '$typeName', customer: '$buyerName', method: '$paymentMethod', quantity: 1 } },
};

function serviceSource(mode: BranchMode): PaymentSource | undefined {
  if (memberBranchModes.includes(mode)) return 'MEMBER';
  if (mode === 'HOTEL') return 'HOTEL';
  if (mode === 'TICKETS') return 'TICKET';
}

export async function paymentHistory(scope: Scope, mode: BranchMode, page: number, source?: PaymentSource) {
  const service = serviceSource(mode);
  if (source && source !== 'GOODS' && source !== service) return { items: [], hasMore: false };
  const first = source ?? 'GOODS';
  const merge = !source && service;
  const size = 50;
  const skip = (page - 1) * size;
  const limit = size + 1;

  function rows(kind: PaymentSource) {
    const { time, filter, fields } = sources[kind];
    return [
      { $match: { ...scope, ...filter, [time]: { $type: 'date' } } },
      { $sort: { [time]: -1, _id: -1 } },
      ...(!merge && skip ? [{ $skip: skip }] : []),
      { $limit: merge ? skip + limit : limit },
      { $project: { ...fields, source: { $literal: kind }, occurredAt: `$${time}` } },
    ] satisfies PipelineStage[];
  }

  const items = await sources[first].model.aggregate([
    ...rows(first),
    ...(merge ? [
      { $unionWith: { coll: sources[merge].model.collection.name, pipeline: rows(merge) } },
      { $sort: { occurredAt: -1, _id: -1, source: 1 } },
      { $skip: skip }, { $limit: limit },
    ] satisfies PipelineStage[] : []),
  ]);
  return { items: items.slice(0, size), hasMore: items.length > size };
}
