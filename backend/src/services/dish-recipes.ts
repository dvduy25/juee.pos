import { ConflictException } from '@nestjs/common';
import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import type { Scope } from '../middleware/business-access';
import { DishRecipe, WarehouseItem } from '../models';
import { objectId } from '../validators/common';
import { warehouseQuantity } from './warehouse';

export const dishRecipeInput = z.array(z.object({ itemId: objectId, quantity: warehouseQuantity.refine(quantity => quantity > 0) }).strict())
  .min(1, 'Hãy thêm ít nhất một nguyên liệu.').max(30)
  .refine(items => new Set(items.map(item => item.itemId)).size === items.length, 'Mỗi nguyên liệu chỉ nhập một dòng.');

export async function saveDishRecipe(scope: Scope, productId: Types.ObjectId, ingredients: z.output<typeof dishRecipeInput>, session: ClientSession) {
  const count = await WarehouseItem.countDocuments({ ...scope, _id: { $in: ingredients.map(item => item.itemId) } }).session(session);
  if (count !== ingredients.length) throw new ConflictException('Có nguyên liệu không thuộc kho của chi nhánh này.');
  await DishRecipe.updateOne({ ...scope, productId }, { $set: { ingredients } }, { upsert: true, session, runValidators: true });
}

export function addIngredientUsage(used: Map<string, number>, ingredients: readonly { itemId: Types.ObjectId; quantity: number }[], servings: number) {
  for (const { itemId, quantity } of ingredients) {
    const id = String(itemId);
    used.set(id, (used.get(id) ?? 0) + servings * quantity);
  }
}
