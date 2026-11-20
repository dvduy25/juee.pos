export const ticketIssueModes = ['GROUP', 'SEPARATE'] as const;
export type TicketIssueMode = typeof ticketIssueModes[number];

export function ticketEntryQuantities(quantity: number, mode: TicketIssueMode) {
  return mode === 'GROUP' ? [quantity] : Array.from({ length: quantity }, () => 1);
}

export function ticketSalePrice(type: { price: number; earlyPrice?: number | null; earlyUntil?: Date | null }, now: Date) {
  return type.earlyPrice != null && type.earlyUntil && now < type.earlyUntil ? type.earlyPrice : type.price;
}

export function ticketWindowState(startsAt: Date | null | undefined, endsAt: Date | null | undefined, now: Date) {
  if (startsAt && now < startsAt) return 'UPCOMING';
  if (endsAt && now >= endsAt) return 'ENDED';
  return 'OPEN';
}
