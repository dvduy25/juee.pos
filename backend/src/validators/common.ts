import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i).transform(value => value.toLowerCase());
export const label = z.string().trim().min(1).max(120);
export const accountEmail = z.string().trim().email().max(254).transform(value => value.toLowerCase());
export const accountPassword = z.string().min(12).max(128);
export const vnd = z.number().int().min(0).max(1_000_000_000_000);

export function read<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}
