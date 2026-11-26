import { ConflictException } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { logChange, type Scope } from '../middleware/business-access';
import { found, localFilter } from '../utils/db';
import { BranchProductPrice, DishRecipe, Product, ProductVariant, UnavailableProduct, WarehouseItem } from '../models';
import { buffetMenuFilter } from './buffet';
import { availableStock } from './stock-lots';
import { facilityToday } from './membership-plans';
import { productImagePath, type readProductImage } from './product-image';

export function productTypeFilter(type: 'RETAIL' | 'FOOD') {
  // Older catalogs have no productType and are available in both modes.
  return { productType: { $in: [type, 'BOTH', null] as const } };
}

export function productBranchFilter(scope: Scope, localRetail = false) {
  if (localRetail) return { tenantId: scope.tenantId, retailBranchId: scope.branchId, warehouseItemId: { $ne: null } };
  return { tenantId: scope.tenantId, retailBranchId: { $in: [null, scope.branchId] } };
}

export async function catalog(scope: Scope, opts: {
  q?: string; code?: string; categoryId?: string; productId?: string; page?: number; productType?: 'RETAIL' | 'FOOD'; includeArchived?: boolean; showCost?: boolean;
  status?: 'ACTIVE' | 'ARCHIVED'; showRecipes?: boolean; ignoreRecipeStock?: boolean; localRetail?: boolean;
  menuFilter?: ReturnType<typeof buffetMenuFilter>;
} = {}) {
  const { tenantId } = scope;
  const branchProducts = productBranchFilter(scope, opts.localRetail);
  const lookup = !opts.code && opts.q && localFilter(opts.q);
  const status = opts.includeArchived ? opts.status : 'ACTIVE';
  const codeItem = opts.code && opts.productType !== 'FOOD' ?
    await WarehouseItem.findOne({ ...scope, barcode: opts.code }).select('_id').lean() ??
    await WarehouseItem.findOne({ ...scope, code: opts.code.toUpperCase() }).select('_id').lean() : undefined;
  const linked = codeItem && await Product.findOne({ ...branchProducts, warehouseItemId: codeItem._id,
    ...(status ? { status } : {}) }).select('_id').lean();
  const exact = opts.code && !linked ? await ProductVariant.findOne({ tenantId, barcode: opts.code }).select('productId').lean()
    ?? await ProductVariant.findOne({ tenantId, sku: opts.code.toUpperCase() }).select('productId').lean() : undefined;
  const exactId = linked?._id ?? exact?.productId;
  if (opts.code && !exactId) return [];
  const matchingVariants = lookup && opts.productType !== 'FOOD' ? await ProductVariant.distinct('productId', { tenantId, $or: [{ sku: lookup }, { barcode: lookup }] }) : [];
  const matchingItems = lookup && opts.productType !== 'FOOD' ?
    (await WarehouseItem.find({ ...scope, $or: [{ code: lookup }, { barcode: lookup }] }).select('_id').lean()).map(item => item._id) : [];
  const products = await Product.find({ ...branchProducts,
    ...(status ? { status } : {}),
    ...(exactId ? { _id: exactId } : opts.productId ? { _id: opts.productId } : {}),
    ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
    ...(opts.productType ? productTypeFilter(opts.productType) : {}),
    ...(lookup ? { $or: [{ name: lookup }, { _id: { $in: matchingVariants } }, { warehouseItemId: { $in: matchingItems } }] } : {}),
    ...(opts.menuFilter ? { $and: [opts.menuFilter] } : {}),
  }).sort('name _id').skip(((opts.page ?? 1) - 1) * 50).limit(50).lean();
  const recipes = opts.productType === 'FOOD' && products.length ?
    await DishRecipe.find({ ...scope, productId: { $in: products.map(item => item._id) } }).select('productId ingredients').lean() : [];
  const recipeByProduct = new Map(recipes.map(item => [String(item.productId), item.ingredients]));
  const warehouseIds = [...products.flatMap(item => item.warehouseItemId ? [item.warehouseItemId] : []),
    ...recipes.flatMap(recipe => recipe.ingredients.map(item => item.itemId))];
  const variants = await ProductVariant.find({ tenantId, productId: { $in: products.map(item => item._id) } })
    .select(opts.showCost ? 'productId sku barcode attributes basePrice costPrice' : 'productId sku barcode attributes basePrice').sort('sku').lean();
  const [branchPrices, unavailable, warehouse] = await Promise.all([
    BranchProductPrice.find({ ...scope, variantId: { $in: variants.map(item => item._id) } }).select('variantId price paused').lean(),
    opts.productType === 'FOOD' ? UnavailableProduct.find({ ...scope, productId: { $in: products.map(item => item._id) } }).select('productId').lean() : [],
    warehouseIds.length ? WarehouseItem.find({ ...scope, _id: { $in: warehouseIds } })
      .select('name code barcode size color unit onHand expiresOn lots').lean() : [],
  ]);
  const unavailableIds = new Set(unavailable.map(item => String(item.productId)));
  const branchSettings = new Map(branchPrices.map(item => [String(item.variantId), item]));
  const byProduct = new Map<string, (typeof variants[number] & { branchPrice?: number; paused?: boolean })[]>();
  for (const variant of variants) {
    const key = String(variant.productId);
    const items = byProduct.get(key) ?? [];
    const id = String(variant._id);
    const settings = branchSettings.get(id);
    items.push({ ...variant, branchPrice: settings?.price ?? undefined, paused: settings?.paused === true || unavailableIds.has(key) || undefined });
    byProduct.set(key, items);
  }
  const stockById = new Map(warehouse.map(item => [String(item._id), item]));
  const today = facilityToday();
  const availableById = new Map(warehouse.map(item => [String(item._id), availableStock(item, today)]));
  return products.map(item => {
    const stock = stockById.get(String(item.warehouseItemId));
    const available = availableById.get(String(item.warehouseItemId)) ?? 0;
    const variants = byProduct.get(String(item._id)) ?? [];
    const recipe = recipeByProduct.get(String(item._id));
    const recipeStatus = opts.productType !== 'FOOD' || opts.ignoreRecipeStock ? undefined : !recipe?.length ? (item.recipeRequired ? 'MISSING' : undefined) :
      recipe.some(line => (availableById.get(String(line.itemId)) ?? 0) < line.quantity) ? 'LOW' : undefined;
    const ingredients = opts.showRecipes ? recipe?.map(line => {
      const ingredient = stockById.get(String(line.itemId));
      return { itemId: line.itemId, quantity: line.quantity, name: ingredient?.name, unit: ingredient?.unit };
    }) : undefined;
    return { ...item, recipeStatus, ingredients, ...(stock ? { name: stock.name, stock: available, unit: stock.unit } : {}),
      paused: unavailableIds.has(String(item._id)) || undefined, productType: item.productType ?? 'BOTH', images: item.images ?? [],
      modifierGroups: item.modifierGroups ?? [], variants: item.warehouseItemId ? variants.map(variant => ({ ...variant,
        sku: stock?.code ?? variant.sku, barcode: stock?.barcode ?? undefined,
        attributes: { size: stock?.size, color: stock?.color }, paused: variant.paused || (!opts.ignoreRecipeStock && available < 1000),
      })) : recipeStatus ? variants.map(variant => ({ ...variant, paused: true })) : variants };
  });
}

export async function listWarehouseProduct(scope: Scope, actorId: string,
  input: { warehouseItemId: string; price: number; description: string }, session: ClientSession,
  image?: NonNullable<ReturnType<typeof readProductImage>>) {
  const item = found(await WarehouseItem.findOne({ ...scope, _id: input.warehouseItemId }).session(session).lean(), 'Mặt hàng không thuộc kho chi nhánh.');
  if (await Product.exists({ warehouseItemId: item._id }).session(session)) {
    throw new ConflictException('Mặt hàng đã có trong danh sách sản phẩm. Kiểm tra cả hàng ngừng bán.');
  }
  const product = new Product({ tenantId: scope.tenantId, retailBranchId: scope.branchId, warehouseItemId: item._id,
    productType: 'RETAIL', name: item.name, description: input.description, categoryId: item.categoryId });
  if (image) {
    product.images = [productImagePath(product.id, image.version)];
    product.imageFile = image;
  }
  await product.save({ session });
  await ProductVariant.insertOne({ tenantId: scope.tenantId, productId: product._id,
    sku: `WH-${item._id}`, basePrice: input.price, costPrice: 0 }, { session });
  await logChange(scope, actorId, 'PRODUCT_CREATE', product._id, session, { warehouseItemId: item._id });
  return product._id;
}
