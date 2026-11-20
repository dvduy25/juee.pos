import { NotFoundException } from '@nestjs/common';
import mongoose, { Types } from 'mongoose';

export const mongoId = (value: string | Types.ObjectId) => new Types.ObjectId(value);
export const localFilter = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
export const isDuplicate = (error: unknown) => error instanceof mongoose.mongo.MongoServerError && error.code === 11000;

export function found<T>(value: T | null | undefined, message?: string): T {
  if (value == null) throw new NotFoundException(message);
  return value;
}

export function jsonTransform(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && '_id' in value && value._id instanceof Types.ObjectId) {
    const { _id, __v: _version, ...rest } = value as { _id: Types.ObjectId; __v?: number };
    return { id: _id.toHexString(), ...rest };
  }
  return value;
}

export function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, jsonTransform));
}
