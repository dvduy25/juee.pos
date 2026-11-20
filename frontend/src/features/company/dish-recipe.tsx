'use client';

import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useAction } from '@/hooks/use-business';
import { submit } from '@/lib/format';
import type { Product, RecipeIngredient } from '@/types/catalog';
import { WarehousePicker } from './warehouse';

export function readDishIngredients(form: FormData) {
  const quantities = form.getAll('ingredientQuantity');
  return form.getAll('ingredientId').map((id, index) => ({ itemId: String(id), quantity: String(quantities[index] ?? '') }));
}

function IngredientRow({ item, remove }: { item?: RecipeIngredient; remove?: () => void }) {
  const [unit, setUnit] = useState(item?.unit);
  return <div className="dish-ingredient-line">
    <WarehousePicker ingredient fieldName="ingredientId" onSelect={item => setUnit(item.unit)}
      initial={item && { id: item.itemId, name: item.name ?? 'Nguyên liệu', unit: item.unit ?? '' }}/>
    <label>Lượng cho một phần{unit ? ` (${unit})` : ''}<input name="ingredientQuantity" type="number"
      min="0.001" max="999999999.999" step="0.001" defaultValue={item ? item.quantity / 1000 : undefined} required/></label>
    {remove && <button type="button" className="plain" onClick={remove}><X size={15} aria-hidden="true"/> Bỏ nguyên liệu</button>}
  </div>;
}

export function DishIngredientsFields({ initial = [] }: { initial?: RecipeIngredient[] }) {
  const [rows, setRows] = useState(() => (initial.length ? initial : [undefined]).map((item, id) => ({ id, item })));
  const nextRow = useRef(rows.length);
  return <fieldset className="dish-ingredients">
    <legend>Định lượng nguyên liệu cho một phần</legend>
    {rows.map(({ id, item }) => <IngredientRow key={id} item={item}
      remove={rows.length > 1 ? () => setRows(current => current.filter(row => row.id !== id)) : undefined}/>)}
    <button type="button" className="plain" disabled={rows.length >= 30} onClick={() => {
      const id = nextRow.current++;
      setRows(current => [...current, { id, item: undefined }]);
    }}><Plus size={16} aria-hidden="true"/> Thêm nguyên liệu</button>
  </fieldset>;
}

export function DishRecipeForm({ product }: { product: Product }) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  return <details className="business-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Định lượng tại chi nhánh {product.ingredients?.length ? `· ${product.ingredients.length} nguyên liệu` : '· Chưa thiết lập'}</summary>
    {open && <form onSubmit={event => submit(event, form => void action.send(`/products/${product.id}/recipe`,
      { ingredients: readDishIngredients(form) }, { method: 'PATCH', message: 'Đã lưu định lượng cho chi nhánh.' }))}>
      <DishIngredientsFields initial={product.ingredients}/>
      <button className="button" disabled={action.pending}>Lưu định lượng</button>{action.feedback}
    </form>}
  </details>;
}
