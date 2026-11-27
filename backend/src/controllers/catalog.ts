import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Query, Req, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { verifyOrigin } from '../middleware/auth';
import { access, logChange, requireSharedCatalog } from '../middleware/business-access';
import { found, isDuplicate } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { transaction } from '../config/db';
import { BranchProductPrice, Category, Product, ProductVariant, TableSession, UnavailableProduct, WarehouseItem, retailBranchModes, serviceCounterModes, tableBranchModes, type BranchMode } from '../models';

import { scopedRoute } from '../routes/branch';
import { catalog, listWarehouseProduct, productBranchFilter, productTypeFilter, saveRetailSize } from '../services/catalog';
import { dishRecipeInput, saveDishRecipe } from '../services/dish-recipes';
import { buffetMenuFilter } from '../services/buffet';
import { idempotent } from '../services/sales';
import { optimizeProductImage, productImageLimits, productImagePath, readProductImage } from '../services/product-image';

const variantSchema = z.object({
  sku: z.string().trim().min(1).max(80).transform(value => value.toUpperCase()).optional(),
  barcode: z.string().trim().min(1).max(80).optional(),
  attributes: z.object({ size: label.optional(), color: label.optional() }).strict().optional(),
  basePrice: vnd, costPrice: vnd.default(0),
}).strict();
const categoryInput = z.object({ name: label }).strict().transform(({ name }) => ({
  name, slug: name.toLowerCase().normalize('NFKC').replace(/\s+/g, '-'),
}));
const retailDiscountPercent = z.number().int().min(0).max(100).optional();
const productSchema = z.object({
  name: label, description: z.string().trim().max(2000).optional(),
  images: z.array(z.string().url().refine(value => /^https?:\/\//i.test(value))).max(8).default([]),
  categoryId: objectId.optional(), productType: z.enum(['RETAIL', 'FOOD', 'BOTH']).default('BOTH'),
  buffetExtra: z.boolean().optional(),
  retailDiscountPercent,
  modifierGroups: z.array(z.object({
    name: label, minSelect: z.number().int().min(0).max(10), maxSelect: z.number().int().min(1).max(10),
    options: z.array(z.object({ name: label, additionalPrice: vnd }).strict()).min(1).max(30),
  }).strict().refine(group => group.minSelect <= group.maxSelect && group.maxSelect <= group.options.length)).max(10).default([]),
}).strict();
type ProductInput = z.output<typeof productSchema>;
const retailListing = z.object({ description: z.string().trim().max(2000), price: vnd, retailDiscountPercent, removeImage: z.literal(true).optional() }).strict();

const retailSize = z.object({ size: label, price: vnd }).strict();

function variantSku(sku: string | undefined, mode: BranchMode, type?: string | null) {
  if (sku) return sku;
  if (!tableBranchModes.includes(mode) || type === 'RETAIL') throw new BadRequestException('Hãy nhập SKU cho sản phẩm bán lẻ.');
  return `FOOD-${randomUUID().toUpperCase()}`;
}

function productBody(req: Request, body: unknown) {
  if (!req.is('multipart/form-data')) return body;
  const { product } = read(z.object({ product: z.string() }).strict(), body);
  try {
    return JSON.parse(product) as unknown;
  } catch {
    throw new BadRequestException('Thông tin sản phẩm không hợp lệ.');
  }
}

async function validateCategory(tenantId: Types.ObjectId, categoryId: string | null | undefined, session: ClientSession) {
  if (categoryId) found(await Category.exists({ _id: categoryId, tenantId }).session(session), 'Danh mục không tồn tại.');
}

@Controller(scopedRoute)
export class CatalogController {
  private async uploadImage(req: Request, params: { tenantId: string; branchId: string },
    permission: 'products.write' | 'catalog.branch-write', file?: { buffer: Buffer }) {
    const image = readProductImage(file);
    if (!image) return undefined;
    await access(req, params.tenantId, params.branchId, permission);
    return optimizeProductImage(image);
  }

  @Get('categories')
  async categories(@Req() req: Request, @Param() params: { tenantId: string; branchId: string }) {
    const { scope } = await access(req, params.tenantId, params.branchId, 'catalog.read');
    return Category.find({ tenantId: scope.tenantId }).sort('name').lean();
  }

  @Post('categories')
  async category(@Req() req: Request, @Param() params: { tenantId: string; branchId: string }, @Body() body: unknown) {
    const fields = read(categoryInput, body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'products.write', session);
      const item = await Category.insertOne({ tenantId: scope.tenantId, ...fields }, { session });
      await logChange(scope, actorId, 'CATEGORY_CREATE', item._id, session);
      return item.toObject();
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tên danh mục đã được sử dụng.');
      throw error;
    });
  }

  @Patch('categories/:id')
  async updateCategory(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }, @Body() body: unknown) {
    const id = read(objectId, params.id);
    const fields = read(categoryInput, body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'products.write', session);
      const item = found(await Category.findOneAndUpdate({ _id: id, tenantId: scope.tenantId }, { $set: fields },
        { session, returnDocument: 'after', runValidators: true }).lean(), 'Danh mục không tồn tại.');
      await logChange(scope, actorId, 'CATEGORY_UPDATE', item._id, session);
      return item;
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tên danh mục đã được sử dụng.');
      throw error;
    });
  }

  @Delete('categories/:id')
  async deleteCategory(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }) {
    const id = read(objectId, params.id);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'products.write', session);
      const item = found(await Category.findOneAndDelete({ _id: id, tenantId: scope.tenantId }, { session }).lean(), 'Danh mục không tồn tại.');
      const result = await Product.updateMany({ tenantId: scope.tenantId, categoryId: item._id }, { $unset: { categoryId: 1 } }, { session });
      await WarehouseItem.updateMany({ tenantId: scope.tenantId, categoryId: item._id },
        { $unset: { categoryId: 1 }, $inc: { revision: 1 } }, { session });
      await logChange(scope, actorId, 'CATEGORY_DELETE', item._id, session, { productsDetached: result.modifiedCount });
      return { ok: true };
    });
  }

  @Get('products')
  async products(@Req() req: Request, @Param() params: { tenantId: string; branchId: string }, @Query() query: unknown) {
    const { scope, membership, branch } = await access(req, params.tenantId, params.branchId, 'catalog.read');
    const input = read(z.object({ q: z.string().trim().max(100).optional(), code: z.string().trim().min(1).max(80).optional(), categoryId: objectId.optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(), archived: z.enum(['yes']).optional(),
      status: z.enum(['ACTIVE', 'ARCHIVED']).optional(), productType: z.enum(['RETAIL', 'FOOD']).optional(),
      tableSessionId: objectId.optional(), buffetSection: z.enum(['included', 'extra']).default('included') }), query);
    const showCost = ['OWNER', 'MANAGER', 'INVENTORY', 'ACCOUNTANT'].includes(membership.role);
    const localRetail = serviceCounterModes.includes(branch.mode);
    if (localRetail && (input.productType === 'FOOD' || input.tableSessionId)) {
      throw new ConflictException('Chi nhánh này bán hàng hóa tại quầy.');
    }
    const service = input.productType === 'FOOD' && input.tableSessionId ? await TableSession.findOne({ ...scope, _id: input.tableSessionId, status: 'OPEN' })
      .select('buffet buffetProductIds').lean() : undefined;
    return catalog(scope, { ...input, localRetail, showCost, showRecipes: membership.role === 'OWNER' || membership.role === 'MANAGER',
      includeArchived: showCost && input.archived === 'yes', menuFilter: buffetMenuFilter(service, input.buffetSection),
      ignoreRecipeStock: !!service?.buffet && input.buffetSection === 'included' });
  }

  @Get('products/:id')
  async product(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }) {
    const { scope, membership, branch } = await access(req, params.tenantId, params.branchId, 'catalog.read');
    const showCost = ['OWNER', 'MANAGER', 'INVENTORY', 'ACCOUNTANT'].includes(membership.role);
    return found((await catalog(scope, { productId: read(objectId, params.id), localRetail: serviceCounterModes.includes(branch.mode), showCost, includeArchived: showCost }))[0]);
  }

  @Post('products')
  @UseInterceptors(FileInterceptor('image', { limits: productImageLimits }))
  async create(@Req() req: Request, @Param() params: { tenantId: string; branchId: string }, @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer }) {
    const { variants, ingredients, ...input } = read(productSchema.extend({ variants: z.array(variantSchema).min(1).max(30),
      ingredients: dishRecipeInput.optional() }), productBody(req, body));
    const imageFile = await this.uploadImage(req, params, 'products.write', file);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, params.tenantId, params.branchId, 'products.write', session);
      if (serviceCounterModes.includes(branch.mode)) {
        throw new ConflictException('Hãy tạo mặt hàng trong kho chi nhánh rồi đăng bán tại quầy.');
      }
      const recipeRequired = tableBranchModes.includes(branch.mode) && input.productType !== 'RETAIL';
      if (recipeRequired && !ingredients) throw new ConflictException('Hãy nhập định lượng nguyên liệu cho món mới.');
      if (!recipeRequired && ingredients) throw new ConflictException('Định lượng chỉ áp dụng cho món trong thực đơn.');
      await validateCategory(scope.tenantId, input.categoryId, session);
      const product = new Product({ tenantId: scope.tenantId, ...input, recipeRequired: recipeRequired || undefined });
      if (imageFile) {
        product.images = [productImagePath(product.id, imageFile.version), ...input.images].slice(0, 8);
        product.imageFile = imageFile;
      }
      await product.save({ session });
      if (ingredients) await saveDishRecipe(scope, product._id, ingredients, session);
      const items = await ProductVariant.insertMany(variants.map(variant => ({ tenantId: scope.tenantId, productId: product._id,
        ...variant, sku: variantSku(variant.sku, branch.mode, input.productType) })), { session });
      await logChange(scope, actorId, 'PRODUCT_CREATE', product._id, session);
      return { ...product.toObject({ useProjection: true }), variants: items.map(item => item.toObject({ flattenMaps: true })) };
    });
  }

  @Patch('products/:id/recipe')
  async recipe(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }, @Body() body: unknown) {
    const id = read(objectId, params.id);
    const { ingredients } = read(z.object({ ingredients: dishRecipeInput }).strict(), body);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      if (!tableBranchModes.includes(branch.mode)) throw new ConflictException('Định lượng chỉ áp dụng tại chi nhánh phục vụ món.');
      const product = found(await Product.exists({ ...productBranchFilter(scope), ...productTypeFilter('FOOD'),
        warehouseItemId: null, _id: id }).session(session), 'Không tìm thấy món.');
      await saveDishRecipe(scope, product._id, ingredients, session);
      await logChange(scope, actorId, 'DISH_RECIPE_UPDATE', product._id, session);
      return { id };
    });
  }

  @Post('retail-products')
  @UseInterceptors(FileInterceptor('image', { limits: productImageLimits }))
  async listWarehouseProduct(@Req() req: Request, @Param() params: { tenantId: string; branchId: string }, @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer }) {
    const input = read(retailListing.extend({ warehouseItemId: objectId, size: label.optional() }), productBody(req, body));
    const image = await this.uploadImage(req, params, 'catalog.branch-write', file);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      if (!retailBranchModes.includes(branch.mode)) throw new ConflictException('Chỉ đăng bán hàng kho tại quầy bán lẻ.');
      return { _id: await listWarehouseProduct(scope, actorId, input, session, image) };
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mặt hàng đã có trong danh sách sản phẩm.');
      throw error;
    });
  }

  @Patch('retail-products/:id')
  @UseInterceptors(FileInterceptor('image', { limits: productImageLimits }))
  async editWarehouseProduct(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string },
    @Body() body: unknown, @UploadedFile() file?: { buffer: Buffer }) {
    const id = read(objectId, params.id);
    const input = read(retailListing, productBody(req, body));
    const image = await this.uploadImage(req, params, 'catalog.branch-write', file);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      const product = found(await Product.findOne({ tenantId: scope.tenantId, retailBranchId: scope.branchId, _id: id }).session(session));
      product.description = input.description;
      if (input.retailDiscountPercent !== undefined) product.retailDiscountPercent = input.retailDiscountPercent;
      if (image || input.removeImage) {
        product.images = image ? [productImagePath(id, image.version)] : [];
        product.imageFile = image;
      }
      await product.save({ session });
      const variants = { tenantId: scope.tenantId, productId: product._id };
      const variant = found(await ProductVariant.findOne({ ...variants, sku: `WH-${product.warehouseItemId}` }).session(session) ??
        await ProductVariant.findOne(variants).sort('_id').session(session));
      variant.basePrice = input.price;
      await variant.save({ session });
      await logChange(scope, actorId, 'PRODUCT_UPDATE', product._id, session);
      return { _id: product._id };
    });
  }

  @Post('retail-products/:id/sizes')
  async addRetailSize(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string },
    @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    verifyOrigin(req);
    const productId = read(objectId, params.id);
    const input = read(retailSize, body);
    const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write');
    return idempotent(scope, 'RETAIL_SIZE_CREATE', key, { actorId, productId, input }, async session => {
      await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      return saveRetailSize(scope, actorId, productId, input, session);
    });
  }

  @Patch('retail-products/:id/sizes/:variantId')
  async updateRetailSize(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string; variantId: string },
    @Body() body: unknown) {
    verifyOrigin(req);
    const productId = read(objectId, params.id);
    const variantId = read(objectId, params.variantId);
    const input = read(retailSize, body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      return saveRetailSize(scope, actorId, productId, { ...input, variantId }, session);
    });
  }

  @Patch('products/:id')
  @UseInterceptors(FileInterceptor('image', { limits: productImageLimits }))
  async update(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }, @Body() body: unknown,
    @UploadedFile() file?: { buffer: Buffer }) {
    const id = read(objectId, params.id);
    const imageFile = await this.uploadImage(req, params, 'catalog.branch-write', file);
    const { categoryId, removeImage, ...input } = read(productSchema.partial().extend({
      categoryId: objectId.nullable().optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional(), removeImage: z.literal(true).optional(),
    }).refine(value => !!imageFile || Object.keys(value).length > 0), productBody(req, body));
    return transaction(async session => {
      const { scope, actorId, membership } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      const filter = { ...productBranchFilter(scope), _id: id };
      const current = found(await Product.findOne(filter).select('images warehouseItemId retailBranchId').session(session).lean());
      if (!current.retailBranchId) await requireSharedCatalog(scope.tenantId, membership, session);
      await validateCategory(scope.tenantId, categoryId, session);
      if (current.warehouseItemId && (input.name !== undefined || categoryId !== undefined || input.productType !== undefined ||
        input.modifierGroups !== undefined || input.buffetExtra !== undefined)) {
        throw new ConflictException('Đổi thông tin mặt hàng tại Kho hàng.');
      }
      const fields: Partial<ProductInput> & { status?: string; imageFile?: typeof imageFile } = { ...input, categoryId: categoryId ?? undefined };
      const unset: Record<string, 1> = {};
      if (categoryId === null) unset.categoryId = 1;
      if (imageFile || removeImage) {
        const remaining = (input.images ?? current.images ?? []).slice(1);
        fields.images = imageFile ? [productImagePath(id, imageFile.version), ...remaining] : remaining;
      }
      if (imageFile) fields.imageFile = imageFile;
      else if (fields.images) unset.imageFile = 1;
      const product = found(await Product.findOneAndUpdate(filter, { $set: fields, $unset: unset },
        { session, returnDocument: 'after', runValidators: true }).lean());
      await logChange(scope, actorId, 'PRODUCT_UPDATE', product._id, session);
      return product;
    });
  }

  @Delete('products/:id')
  async archive(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }) {
    const id = read(objectId, params.id);
    return transaction(async session => {
      const { scope, actorId, membership } = await access(req, params.tenantId, params.branchId, 'catalog.branch-write', session);
      const filter = { ...productBranchFilter(scope), _id: id };
      const product = found(await Product.findOne(filter).select('status retailBranchId').session(session).lean(), 'Không tìm thấy sản phẩm.');
      if (!product.retailBranchId) await requireSharedCatalog(scope.tenantId, membership, session);
      if (product.status !== 'ARCHIVED') {
        await Product.updateOne(filter, { $set: { status: 'ARCHIVED' } }, { session });
        await logChange(scope, actorId, 'PRODUCT_ARCHIVE', product._id, session);
      }
      return { id, status: 'ARCHIVED' };
    });
  }

  @Post('products/:id/variants')
  async addVariant(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }, @Body() body: unknown) {
    const input = read(variantSchema, body);
    const productId = read(objectId, params.id);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, params.tenantId, params.branchId, 'products.write', session);
      const product = found(await Product.findOne({ ...productBranchFilter(scope), _id: productId }).select('productType warehouseItemId').session(session).lean());
      if (product.warehouseItemId) throw new ConflictException('Mỗi mặt hàng kho có một đơn vị bán.');
      const variant = await ProductVariant.insertOne({ tenantId: scope.tenantId, productId, ...input, sku: variantSku(input.sku, branch.mode, product.productType) }, { session });
      await logChange(scope, actorId, 'VARIANT_CREATE', variant._id, session);
      return variant.toObject({ flattenMaps: true });
    });
  }

  @Patch('products/:id/variants/:variantId')
  async updateVariant(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string; variantId: string }, @Body() body: unknown) {
    const input = read(variantSchema.partial().refine(value => Object.keys(value).length > 0), body);
    const productId = read(objectId, params.id);
    const variantId = read(objectId, params.variantId);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'products.write', session);
      const product = found(await Product.findOne({ ...productBranchFilter(scope), _id: productId }).select('warehouseItemId').session(session).lean());
      if (product.warehouseItemId) throw new ConflictException('Sửa giá trong sản phẩm bán lẻ và sửa thông tin hàng tại Kho hàng.');
      const variant = found(await ProductVariant.findOneAndUpdate({ _id: variantId, productId, tenantId: scope.tenantId },
        { $set: input }, { session, returnDocument: 'after', runValidators: true }).select('-tracked').lean());
      await logChange(scope, actorId, 'VARIANT_UPDATE', variant._id, session);
      return variant;
    });
  }

  @Patch('products/:id/variants/:variantId/branch-price')
  async price(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string; variantId: string }, @Body() body: unknown) {
    const { price } = read(z.object({ price: vnd.nullable() }).strict(), body);
    const productId = read(objectId, params.id);
    const variantId = read(objectId, params.variantId);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'branch-prices.write', session);
      found(await Product.exists({ ...productBranchFilter(scope), _id: productId }).session(session));
      const variant = found(await ProductVariant.exists({ _id: variantId, productId, tenantId: scope.tenantId }).session(session));
      const filter = { ...scope, variantId: variant._id };
      if (price === null) {
        await BranchProductPrice.updateOne(filter, { $unset: { price: 1 } }, { session });
        await BranchProductPrice.deleteOne({ ...filter, paused: { $ne: true } }, { session });
      }
      else await BranchProductPrice.updateOne(filter, { $set: { price } }, { upsert: true, runValidators: true, session });
      await logChange(scope, actorId, 'BRANCH_PRICE_SET', variant._id, session, { price });
      return { price };
    });
  }

  @Patch('products/:id/variants/:variantId/availability')
  async availability(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string; variantId: string }, @Body() body: unknown) {
    const { paused } = read(z.object({ paused: z.boolean() }).strict(), body);
    const productId = read(objectId, params.id);
    const variantId = read(objectId, params.variantId);
    return transaction(async session => {
      const { scope, actorId } = await access(req, params.tenantId, params.branchId, 'catalog.availability', session);
      found(await Product.exists({ ...productBranchFilter(scope), _id: productId }).session(session));
      const variant = found(await ProductVariant.exists({ _id: variantId, productId, tenantId: scope.tenantId }).session(session));
      const filter = { ...scope, variantId: variant._id };
      if (paused) await BranchProductPrice.updateOne(filter, { $set: { paused } }, { upsert: true, session });
      else {
        await BranchProductPrice.updateOne(filter, { $unset: { paused: 1 } }, { session });
        await BranchProductPrice.deleteOne({ ...filter, price: null }, { session });
      }
      await logChange(scope, actorId, 'BRANCH_AVAILABILITY_SET', variant._id, session, { paused });
      return { paused };
    });
  }

  @Patch('products/:id/availability')
  async dishAvailability(@Req() req: Request, @Param() params: { tenantId: string; branchId: string; id: string }, @Body() body: unknown) {
    const { paused } = read(z.object({ paused: z.boolean() }).strict(), body);
    const productId = read(objectId, params.id);
    return transaction(async session => {
      const { scope, actorId, branch } = await access(req, params.tenantId, params.branchId, 'catalog.availability', session);
      if (!tableBranchModes.includes(branch.mode)) throw new ConflictException('Thao tác này chỉ áp dụng cho thực đơn tại bàn.');
      const product = found(await Product.exists({ tenantId: scope.tenantId, _id: productId, status: 'ACTIVE', ...productTypeFilter('FOOD') }).session(session));
      const filter = { ...scope, productId: product._id };
      if (paused) await UnavailableProduct.updateOne(filter, { $setOnInsert: filter }, { upsert: true, session });
      else {
        await UnavailableProduct.deleteOne(filter, { session });
        const items = await ProductVariant.find({ tenantId: scope.tenantId, productId }).select('_id').session(session).lean();
        const variants = { ...scope, variantId: { $in: items.map(item => item._id) }, paused: true };
        if (items.length && await BranchProductPrice.countDocuments(variants).session(session) === items.length) {
          await BranchProductPrice.updateMany(variants, { $unset: { paused: 1 } }, { session });
        }
      }
      await logChange(scope, actorId, 'DISH_AVAILABILITY_SET', product._id, session, { paused });
      return { paused };
    });
  }

}

@Controller('product-images')
export class ProductImagesController {
  @Get(':id/:version')
  @Header('Cache-Control', 'public, max-age=300')
  async image(@Param('id') rawId: string, @Param('version') rawVersion: string) {
    const id = read(objectId, rawId);
    const version = read(z.string().regex(/^[a-f0-9]{32}$/), rawVersion);
    const product = found(await Product.findOne({ _id: id, 'imageFile.version': version }).select('imageFile'));
    const image = found(product.imageFile);
    return new StreamableFile(image.bytes, { type: image.contentType, length: image.bytes.length });
  }
}
