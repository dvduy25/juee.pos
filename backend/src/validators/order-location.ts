import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';

const coordinates = { latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) };
export const branchLocation = z.object({ ...coordinates, radiusMeters: z.number().int().min(20).max(2000) }).strict();
export const guestLocation = z.object({ ...coordinates, accuracy: z.number().finite().positive(), measuredAt: z.number().int().positive().safe() }).strict();

export function distanceMeters(a: z.infer<typeof branchLocation>, b: z.infer<typeof guestLocation>) {
  const radians = Math.PI / 180;
  const latDistance = (b.latitude - a.latitude) * radians;
  const lonDistance = (b.longitude - a.longitude) * radians;
  const haversine = Math.sin(latDistance / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(lonDistance / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function requireGuestLocation(configured: z.infer<typeof branchLocation> | null | undefined,
  position: z.infer<typeof guestLocation>, now = Date.now()) {
  if (!configured) throw new ForbiddenException('Chi nhánh chưa ghim vị trí gọi món QR. Vui lòng gọi nhân viên.');
  if (position.measuredAt < now - 60000 || position.measuredAt > now + 10000) {
    throw new ForbiddenException('Vị trí đã hết hạn. Hãy cập nhật vị trí rồi thử lại.');
  }
  const distance = distanceMeters(configured, position);
  if (distance > configured.radiusMeters) throw new ForbiddenException('Bạn đang ngoài phạm vi gọi món của chi nhánh.');
  if (distance + position.accuracy > configured.radiusMeters) {
    throw new ForbiddenException('Vị trí chưa đủ chính xác. Bật vị trí chính xác và thử lại trong khu vực cửa hàng.');
  }
}
