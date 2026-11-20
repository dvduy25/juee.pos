import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import type { Scope } from '../middleware/business-access';
import { StaffDocument, StaffIdentity } from '../models';
import { productImageLimits, readProductImage } from './product-image';

const maxDocuments = 8;
export const staffUploadFields = [{ name: 'avatar', maxCount: 1 }, { name: 'documents', maxCount: maxDocuments }];
export const staffUploadOptions = { limits: { ...productImageLimits, files: maxDocuments + 1, fieldSize: 16_384 } };
export type StaffFiles = { avatar?: { buffer: Buffer }[]; documents?: { buffer: Buffer; originalname: string }[] };

export function readStaffImages(files?: StaffFiles) {
  const avatar = readProductImage(files?.avatar?.[0]);
  const uploads = files?.documents ?? [];
  const total = uploads.reduce((size, file) => size + file.buffer.length, avatar?.bytes.length ?? 0);
  if (total > 8 * 1024 * 1024) throw new PayloadTooLargeException('Tổng dung lượng ảnh mỗi lần lưu tối đa 8 MB.');
  const documents = uploads.map(file => {
    const { contentType, bytes } = readProductImage(file)!;
    const name = file.originalname.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Ảnh giấy tờ';
    return { name, contentType, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  });
  return { avatar, documents };
}

export async function saveStaffIdentity(scope: Scope, membershipId: Types.ObjectId, changes: ReturnType<typeof readStaffImages> & {
  citizenId?: string; removeDocumentIds?: string[];
}, session: ClientSession) {
  const { citizenId, avatar, documents, removeDocumentIds } = changes;
  const filter = { tenantId: scope.tenantId, membershipId };
  if (citizenId || avatar) {
    await StaffIdentity.updateOne(filter, { $set: { ...(citizenId && { citizenId }), ...(avatar && { avatar }) } },
      { upsert: true, session, runValidators: true });
  }
  if (removeDocumentIds?.length) await StaffDocument.deleteMany({ ...filter, _id: { $in: removeDocumentIds } }, { session });
  if (!documents.length) return;
  const saved = await StaffDocument.distinct('digest', filter).session(session);
  const known = new Set(saved);
  const pending = [];
  for (const document of documents) {
    if (known.has(document.digest)) continue;
    known.add(document.digest);
    pending.push({ ...filter, ...document });
  }
  if (known.size > maxDocuments) throw new BadRequestException('Mỗi hồ sơ lưu tối đa 8 ảnh giấy tờ.');
  if (pending.length) await StaffDocument.insertMany(pending, { session });
}
