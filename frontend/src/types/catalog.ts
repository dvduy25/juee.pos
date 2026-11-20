export type Category = { id: string; name: string };
export type Variant = { id: string; sku: string; barcode?: string; attributes?: { size?: string; color?: string }; basePrice: number; branchPrice?: number; paused?: boolean };
export type ModifierGroup = { id: string; name: string; minSelect: number; maxSelect: number; options: { id: string; name: string; additionalPrice: number }[] };
export type RecipeIngredient = { itemId: string; quantity: number; name?: string; unit?: string };
export type Product = { id: string; name: string; description?: string; images: string[]; categoryId?: string; variants: Variant[];
  productType: 'RETAIL' | 'FOOD' | 'BOTH'; status: string; modifierGroups: ModifierGroup[]; paused?: boolean; buffetExtra?: boolean;
  warehouseItemId?: string; stock?: number; unit?: string; ingredients?: RecipeIngredient[]; recipeStatus?: 'MISSING' | 'LOW' };

export function foodVariantLabel(variant: Variant, index: number) {
  return variant.attributes?.size || (index === 0 ? 'Phần tiêu chuẩn' : `Phiên bản ${index + 1}`);
}
