import type { Types } from 'mongoose';

export type BuffetSection = 'included' | 'extra';
type BuffetMenu = { buffet?: unknown; buffetProductIds?: Types.ObjectId[] | null };

export function buffetMenuFilter(service: BuffetMenu | null | undefined, section: BuffetSection) {
  if (!service?.buffet) return {};
  const included = section === 'included';
  if (service.buffetProductIds) {
    return { _id: included ? { $in: service.buffetProductIds } : { $nin: service.buffetProductIds } };
  }
  return { buffetExtra: included ? { $ne: true } : true };
}

export function isBuffetIncluded(service: BuffetMenu | undefined, product: { _id: Types.ObjectId; buffetExtra?: boolean | null }) {
  if (!service?.buffet) return false;
  return service.buffetProductIds ? service.buffetProductIds.some(item => item.equals(product._id)) : !product.buffetExtra;
}
