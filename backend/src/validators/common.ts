import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i).transform(value => value.toLowerCase());
export const label = z.string().trim().min(1).max(120);
export const accountEmail = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const vietnamesePhone = /^(?:0|\+?84)([1-9]\d{8}|2\d{9})$/;
export const accountPhone = z.string({ required_error: 'Hãy nhập số điện thoại.' }).trim()
  .min(1, 'Hãy nhập số điện thoại.').max(32, 'Số điện thoại không hợp lệ.')
  .transform(value => {
    const compact = value.replace(/[\s().-]/g, '');
    const local = compact.match(vietnamesePhone);
    return local ? '+84' + local[1] : compact;
  })
  .refine(value => /^\+[1-9]\d{7,14}$/.test(value) && (!value.startsWith('+84') || vietnamesePhone.test(value)),
    'Số điện thoại không hợp lệ. Dùng dạng 09xxxxxxxx hoặc số có mã quốc gia.');
export const accountPassword = z.string().min(12).max(128);
export const vnd = z.number().int().min(0).max(1_000_000_000_000);

export function read<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}
