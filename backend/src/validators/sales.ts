import { z } from 'zod';
import { objectId, read, vnd } from './common';

const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/);
export const readIdempotencyKey = (input: unknown) => read(idempotencyKey, input);

export const lineSchema = z.object({
  variantId: objectId, quantity: z.number().int().min(1).max(1000),
  modifierIds: z.array(objectId).max(50).default([]),
  note: z.string().trim().max(500).optional(),
}).strict().refine(line => new Set(line.modifierIds).size === line.modifierIds.length);
export const lines = z.array(lineSchema).min(1).max(50);
export const amount = vnd.refine(value => value > 0);
export const pageSchema = z.coerce.number().int().min(1).max(10000).default(1);
export const discountCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/, 'Mã giảm giá chỉ gồm chữ, số, dấu gạch ngang hoặc gạch dưới.');

const quantity = z.number().int().min(1).max(1000);
const editLine = z.union([z.object({ lineId: objectId, quantity }).strict(), z.object({ variantId: objectId, quantity }).strict()]);
export const orderRevision = z.string().datetime({ offset: true });
export const editRetailOrderInput = z.object({
  revision: orderRevision, items: z.array(editLine).min(1).max(50), discountAmount: vnd.default(0), promotionId: objectId.optional(), promotionCode: discountCode.optional(),
  expectedTotal: z.number().int().nonnegative().safe().optional(),
}).strict().refine(({ items }) => new Set(items.map(item => 'lineId' in item ? `line:${item.lineId}` : `variant:${item.variantId}`)).size === items.length,
  'Mỗi dòng sửa hoặc sản phẩm thêm mới chỉ được gửi một lần.');
