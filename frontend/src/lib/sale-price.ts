import type { Variant } from '@/types/catalog';

export const salePrice = (variant: Variant, includedInBuffet = false) => includedInBuffet ? 0 : variant.branchPrice ?? variant.basePrice;
