import { ConflictException } from '@nestjs/common';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { logChange, requireSharedCatalog, type Scope } from '../middleware/business-access';
import { BranchProductPrice, Product, ProductVariant, WarehouseItem, type Role } from '../models';
import { found } from '../utils/db';
import { label, objectId, vnd } from '../validators/common';
import { listWarehouseProduct, productTypeFilter } from './catalog';
import { purchaseHeader, purchaseLine, savePurchase } from './purchases';

const unit = z.string().trim().min(1).max(32);
const receiptFields = purchaseLine.omit({ itemId: true }).extend({ unit });
const receiptLine = z.union([receiptFields.extend({ itemId: objectId }), receiptFields.extend({ name: label })]);
export const aiReceiptInput = purchaseHeader.extend({ lines: z.array(receiptLine).min(1).max(30) });
export const aiMenuInput = z.object({
  lines: z.array(z.object({ name: label, price: vnd, variantId: objectId.optional() }).strict()).min(1).max(30),
}).strict();

const retailCode = z.string().trim().min(1).max(60).transform(value => value.toUpperCase());
const retailBarcode = z.string().trim().min(1).max(80);
const retailLine = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), warehouseItemId: objectId, price: vnd }).strict(),
  z.object({ mode: z.literal('new'), name: label, unit, code: retailCode.optional(), barcode: retailBarcode.optional(), price: vnd }).strict(),
]);
export const aiRetailInput = z.object({ lines: z.array(retailLine).min(1).max(30) }).strict();

function normalized(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi');
}

async function warehouseNames(scope: Scope, names: string[], session?: ClientSession) {
  const wanted = new Set(names.map(normalized));
  const matches = new Map<string, { id: string; name: string; unit: string; code: string }[]>();
  if (!wanted.size) return matches;
  const rows = WarehouseItem.find(scope).select('_id name unit code').session(session ?? null).lean().cursor();
  for await (const item of rows) {
    const name = normalized(item.name);
    if (!wanted.has(name)) continue;
    const list = matches.get(name) ?? [];
    list.push({ id: String(item._id), name: item.name, unit: item.unit, code: item.code });
    matches.set(name, list);
  }
  return matches;
}

export async function suggestWarehouseItems<T extends { name: string; unit: string | null }>(scope: Scope, lines: T[]) {
  const matches = await warehouseNames(scope, lines.map(row => row.name));
  return lines.map(line => {
    const sameName = matches.get(normalized(line.name)) ?? [];
    const unitName = line.unit ? normalized(line.unit) : null;
    const exact = sameName.filter(item => normalized(item.unit) === unitName);
    return { ...line, item: exact.length === 1 ? exact[0] : null, needsMatch: sameName.length > 0 };
  });
}

export async function receiveAiPurchase(scope: Scope, actorId: string, input: z.output<typeof aiReceiptInput>, session: ClientSession) {
  const existingIds = input.lines.flatMap(line => 'itemId' in line ? [line.itemId] : []);
  const items = await WarehouseItem.find({ ...scope, _id: { $in: existingIds } }).select('_id unit').session(session).lean();
  const itemsById = new Map(items.map(item => [String(item._id), item]));
  const matchingNames = await warehouseNames(scope, input.lines.flatMap(line => 'name' in line ? [line.name] : []), session);
  const newItems = new Map<string, string>();
  const lines: z.output<typeof purchaseLine>[] = [];
  for (const line of input.lines) {
    let itemId: string;
    if ('itemId' in line) {
      const current = found(itemsById.get(line.itemId), 'Có mặt hàng không thuộc kho chi nhánh.');
      if (normalized(current.unit) !== normalized(line.unit)) {
        throw new ConflictException('Đơn vị mặt hàng vừa thay đổi. Hãy chọn lại mặt hàng và kiểm tra số lượng.');
      }
      itemId = line.itemId;
    } else {
      const name = normalized(line.name);
      const unitName = normalized(line.unit);
      if (matchingNames.get(name)?.some(item => normalized(item.unit) === unitName)) {
        throw new ConflictException(`Kho đã có “${line.name}” (${line.unit}). Chọn mặt hàng đó trong bảng duyệt.`);
      }
      const itemKey = JSON.stringify([name, unitName]);
      const previous = newItems.get(itemKey);
      if (previous) itemId = previous;
      else {
        const id = new Types.ObjectId();
        await new WarehouseItem({ _id: id, ...scope, code: `NK-${id.toHexString().toUpperCase()}`, name: line.name, unit: line.unit }).save({ session });
        await logChange(scope, actorId, 'WAREHOUSE_ITEM_CREATE', id, session);
        itemId = id.toHexString();
        newItems.set(itemKey, itemId);
      }
    }
    lines.push({ itemId, quantity: line.quantity, unitCost: line.unitCost, taxBps: line.taxBps, expiresOn: line.expiresOn });
  }
  return savePurchase(scope, actorId, { ...input, lines }, session);
}

export async function suggestRetailItems(scope: Scope, lines: {
  name: string; unit: string | null; code: string | null; barcode: string | null; price: number | null;
}[]) {
  const codes = [...new Set(lines.flatMap(line => [line.barcode, line.code]).filter((value): value is string => !!value))];
  const [named, coded] = await Promise.all([
    warehouseNames(scope, lines.map(line => line.name)),
    codes.length ? WarehouseItem.find({ ...scope, $or: [{ code: { $in: codes.map(code => code.toUpperCase()) } },
      { barcode: { $in: codes } }] }).select('_id name code unit barcode').lean() : [],
  ]);
  return lines.map(line => {
    const identifiers = [line.code, line.barcode].filter((value): value is string => !!value);
    const exact = coded.filter(item => identifiers.some(code => item.barcode === code || item.code === code.toUpperCase()));
    const sameName = named.get(normalized(line.name)) ?? [];
    const unitName = line.unit && normalized(line.unit);
    const compatible = unitName ? sameName.filter(item => normalized(item.unit) === unitName) : sameName;
    const match = exact.length ? exact.length === 1 && exact[0] : !identifiers.length && compatible.length === 1 && compatible[0];
    return { ...line, item: match ? { id: String('_id' in match ? match._id : match.id), name: match.name, unit: match.unit, code: match.code } : null,
      needsMatch: !!(exact.length || sameName.length) };
  });
}

export async function saveAiRetail(scope: Scope, actorId: string, input: z.output<typeof aiRetailInput>, session: ClientSession) {
  const names = await warehouseNames(scope, input.lines.flatMap(line => line.mode === 'new' ? [line.name] : []), session);
  const createdNames = new Set<string>();
  for (const line of input.lines) {
    let warehouseItemId: string;
    if (line.mode === 'existing') warehouseItemId = line.warehouseItemId;
    else {
      const name = normalized(line.name);
      const unitName = normalized(line.unit);
      const nameKey = JSON.stringify([name, unitName]);
      if (createdNames.has(nameKey) || names.get(name)?.some(item => normalized(item.unit) === unitName)) {
        throw new ConflictException(`Kho đã có “${line.name}” (${line.unit}). Chọn mặt hàng đó trong bảng duyệt.`);
      }
      const identifiers = [line.code, line.barcode].filter((value): value is string => !!value);
      if (identifiers.length && await WarehouseItem.exists({ ...scope, $or: [{ code: { $in: identifiers.map(code => code.toUpperCase()) } },
        { barcode: { $in: identifiers } }] }).session(session)) {
        throw new ConflictException('Mã hàng hoặc mã vạch đã tồn tại.');
      }
      const id = new Types.ObjectId();
      await new WarehouseItem({ _id: id, ...scope, code: line.code ?? `AI-${id.toHexString().toUpperCase()}`,
        name: line.name, unit: line.unit, barcode: line.barcode }).save({ session });
      await logChange(scope, actorId, 'WAREHOUSE_ITEM_CREATE', id, session);
      warehouseItemId = id.toHexString();
      createdNames.add(nameKey);
    }
    await listWarehouseProduct(scope, actorId, { warehouseItemId, price: line.price, description: '' }, session);
  }
  return { count: input.lines.length };
}

function sharedMenu(scope: Scope) {
  return { tenantId: scope.tenantId, retailBranchId: null, warehouseItemId: null, status: 'ACTIVE' as const, ...productTypeFilter('FOOD') };
}

async function menuNames(scope: Scope, names: string[], session?: ClientSession) {
  const wanted = new Set(names.map(normalized));
  const matches = new Map<string, { id: string; name: string }[]>();
  if (!wanted.size) return matches;
  const products = Product.find(sharedMenu(scope)).select('_id name').session(session ?? null).lean().cursor();
  for await (const product of products) {
    const name = normalized(product.name);
    if (!wanted.has(name)) continue;
    const list = matches.get(name) ?? [];
    list.push({ id: String(product._id), name: product.name });
    matches.set(name, list);
  }
  return matches;
}

export async function suggestMenuItems(scope: Scope, lines: { name: string; price: number }[]) {
  const matches = await menuNames(scope, lines.map(line => line.name));
  const products = [...matches.values()].flat();
  const variants = await ProductVariant.find({ tenantId: scope.tenantId, productId: { $in: products.map(product => product.id) } })
    .select('_id productId attributes sku').sort('_id');
  const variantsByProduct = new Map<string, typeof variants>();
  for (const variant of variants) {
    const id = String(variant.productId);
    const list = variantsByProduct.get(id) ?? [];
    list.push(variant);
    variantsByProduct.set(id, list);
  }
  return lines.map(line => {
    const sameName = matches.get(normalized(line.name)) ?? [];
    const choices = sameName.flatMap(product => (variantsByProduct.get(product.id) ?? []).map(variant => ({
      id: String(variant._id), name: product.name, label: variant.attributes?.get('size') || variant.sku,
    })));
    return { ...line, choices: choices.slice(0, 12), variantId: sameName.length === 1 && choices.length === 1 ? choices[0].id : null,
      needsMatch: sameName.length > 0 };
  });
}

export async function saveAiMenu(scope: Scope, actorId: string, membership: { role: Role; branchIds: Types.ObjectId[] },
  input: z.output<typeof aiMenuInput>, session: ClientSession) {
  const variantIds = input.lines.flatMap(line => line.variantId ? [line.variantId] : []);
  if (new Set(variantIds).size !== variantIds.length) throw new ConflictException('Mỗi phiên bản món chỉ được sửa trong một dòng.');
  const variants = await ProductVariant.find({ tenantId: scope.tenantId, _id: { $in: variantIds } }).select('_id productId').session(session).lean();
  const byVariant = new Map(variants.map(variant => [String(variant._id), variant]));
  const products = await Product.find({ ...sharedMenu(scope), _id: { $in: variants.map(variant => variant.productId) } })
    .select('_id name').session(session).lean();
  const byProduct = new Map(products.map(product => [String(product._id), product]));
  const edits = input.lines.map(line => {
    const variant = line.variantId ? found(byVariant.get(line.variantId), 'Không tìm thấy phiên bản món.') : undefined;
    const product = variant ? found(byProduct.get(String(variant.productId)), 'Món không còn trong thực đơn.') : undefined;
    return { ...line, variant, product };
  });
  const nameEdits = edits.filter(line => !line.product || line.name !== line.product.name);
  if (nameEdits.length) await requireSharedCatalog(scope.tenantId, membership, session);
  const matchingNames = await menuNames(scope, nameEdits.map(line => line.name), session);
  const targetNames = new Map<string, string>();
  const namesByProduct = new Map<string, string>();
  for (const [index, line] of edits.entries()) {
    const productId = line.product ? String(line.product._id) : undefined;
    const name = normalized(line.name);
    if (!line.product || line.name !== line.product.name) {
      const target = productId ?? String(index);
      if (matchingNames.get(name)?.some(match => match.id !== productId) ||
        (targetNames.has(name) && targetNames.get(name) !== target)) {
        throw new ConflictException(`Thực đơn đã có “${line.name}”. Chọn đúng món hoặc sửa tên trên bảng duyệt.`);
      }
      targetNames.set(name, target);
    }
    if (productId) {
      if (namesByProduct.has(productId) && namesByProduct.get(productId) !== line.name) {
        throw new ConflictException('Các phiên bản của cùng một món phải có chung tên.');
      }
      namesByProduct.set(productId, line.name);
    }
  }

  for (const line of edits) {
    if (line.product && line.variant) {
      if (line.name !== line.product.name) {
        await Product.updateOne({ _id: line.product._id }, { $set: { name: line.name } }, { session });
        await logChange(scope, actorId, 'PRODUCT_UPDATE', line.product._id, session);
        line.product.name = line.name;
      }
      await BranchProductPrice.updateOne({ ...scope, variantId: line.variant._id }, { $set: { price: line.price } }, { upsert: true, session });
      await logChange(scope, actorId, 'BRANCH_PRICE_SET', line.variant._id, session, { price: line.price });
    } else {
      const product = await Product.insertOne({ tenantId: scope.tenantId, name: line.name, productType: 'FOOD', recipeRequired: true, buffetExtra: true }, { session });
      await ProductVariant.insertOne({ tenantId: scope.tenantId, productId: product._id, sku: `MON-${product.id.toUpperCase()}`,
        basePrice: line.price, costPrice: 0 }, { session });
      await logChange(scope, actorId, 'PRODUCT_CREATE', product._id, session);
    }
  }
  return { count: edits.length };
}
