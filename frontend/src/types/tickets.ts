export type TicketType = { id: string; name: string; price: number; active: boolean; capacity?: number | null;
  sold: number; remaining: number | null; currentPrice: number; saleState: 'UPCOMING' | 'ENDED' | 'OPEN' | 'INACTIVE';
  saleStartsAt?: string | null; saleEndsAt?: string | null; admissionStartsAt?: string | null; admissionEndsAt?: string | null;
  earlyPrice?: number | null; earlyUntil?: string | null };
