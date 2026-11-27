'use client';

import { useLanguage } from '@/i18n/language';
import { useEffect, useRef, useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Pager, Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, submit, value } from '@/lib/format';
import { salePrice } from '@/lib/sale-price';
import { foodVariantLabel, type Category, type Variant, type ModifierGroup, type Product } from '@/types/catalog';
import { WarehousePicker } from './warehouse';
import { DishIngredientsFields, DishRecipeForm, readDishIngredients } from './dish-recipe';

const maxImageSize = 4 * 1024 * 1024;

function ProductImageField({ current }: { current?: string }) {
  const { t } = useLanguage();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState('');
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const form = input.current?.form;
    const reset = () => { input.current?.setCustomValidity(''); setPreview(''); setRemove(false); setError(''); };
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const src = preview || (remove ? '' : current);
  return <>
    <label>{t("Ảnh sản phẩm")}<input ref={input} name="image" type="file" accept="image/jpeg,image/png,image/webp" className="product-image-input"
      onChange={event => {
        const field = event.currentTarget;
        const file = field.files?.[0];
        const message = file && file.size > maxImageSize ? t("Tệp ảnh vượt quá 4 MB.") : '';
        field.setCustomValidity(message);
        setError(message);
        setPreview(file && !message ? URL.createObjectURL(file) : '');
        if (file) setRemove(false);
      }}/><small>{t("JPG, PNG hoặc WebP, tối đa 4 MB.")}</small></label>
    {error && <p className="error" role="alert">{error}</p>}
    {src && <img className="product-image-preview" src={src} alt={t("Xem trước ảnh sản phẩm")}/>}
    {current && !preview && <label className="check"><input name="removeImage" type="checkbox" checked={remove}
      onChange={event => setRemove(event.target.checked)}/> {t("Xóa ảnh hiện tại")}</label>}
  </>;
}

function VariantFields({ variant, autoSku = false, food }: { variant?: Variant; autoSku?: boolean; food: boolean }) {
  const { t } = useLanguage();
  return <><div className="form-grid form-grid-business">
    {!food && <><label>SKU<input name="sku" required={!autoSku} maxLength={80} defaultValue={variant?.sku}
      placeholder={autoSku ? t("Để trống nếu dùng mã vạch làm SKU") : undefined}/></label>
    <label>{t("Mã vạch")}<input name="barcode" maxLength={80} autoComplete="off" defaultValue={variant?.barcode}
      onKeyDown={event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const price = event.currentTarget.form?.elements.namedItem('price');
        if (price instanceof HTMLInputElement) price.focus();
      }}/></label></>}
    <label>{t("Giá bán (đ)")}<input name="price" type="number" min="0" step="1" max="1000000000000" required defaultValue={variant?.basePrice}/></label>
    <label>{food ? t("Tên phiên bản (nếu có)") : t("Kích cỡ")}<input name="size" maxLength={120} defaultValue={variant?.attributes?.size}/></label>
    {!food && <label>{t("Màu")}<input name="color" maxLength={120} defaultValue={variant?.attributes?.color}/></label>}
  </div></>;
}

function variantInput(form: FormData, variant?: Variant) {
  const barcode = value(form, 'barcode');
  return { sku: value(form, 'sku') || barcode || undefined, barcode: barcode || undefined, basePrice: amount(form, 'price'),
    attributes: { size: value(form, 'size') || undefined, color: form.has('color') ? value(form, 'color') || undefined : variant?.attributes?.color } };
}

export function Categories() {
  const { t } = useLanguage();
  const categories = useData<Category[]>('/categories');
  const { role, membership } = useBusiness();
  const action = useAction();
  const [editing, setEditing] = useState<Category>();
  const [deleting, setDeleting] = useState<Category>();
  const canEdit = role === 'OWNER' || membership.canEditSharedCatalog;
  return <Panel title={t("Danh mục sản phẩm")}><State query={categories} empty={categories.data?.length === 0}/>
    {categories.data?.map(item => <div className="list-row" key={item.id}><strong>{item.name}</strong>
      {canEdit && <div className="actions">
        <button type="button" className="plain" disabled={action.pending} onClick={() => { setDeleting(undefined); setEditing(item); }}>{t("Sửa")}</button>
        <button type="button" className="plain" disabled={action.pending} onClick={() => { setEditing(undefined); setDeleting(item); }}>{t("Xóa")}</button>
      </div>}
    </div>)}
    {canEdit && (deleting ? <div className="notice">
      <p>{t("Xóa danh mục")} <strong>{deleting.name}</strong>{t("? Sản phẩm trong danh mục sẽ chuyển về chưa phân loại.")}</p>
      <div className="actions">
        <button type="button" className="plain" disabled={action.pending} onClick={() => setDeleting(undefined)}>{t("Hủy")}</button>
        <button type="button" className="button" disabled={action.pending} onClick={async () => {
          if (await action.send(`/categories/${deleting.id}`, undefined, { method: 'DELETE', message: 'Đã xóa danh mục.' })) setDeleting(undefined);
        }}>{t("Xác nhận xóa")}</button>
      </div>
    </div> : <form key={editing?.id ?? 'new'} onSubmit={event => submit(event, (form, element) => {
      const name = value(form, 'name');
      if (editing) {
        void action.send(`/categories/${editing.id}`, { name }, { method: 'PATCH', message: 'Đã sửa danh mục.' })
          .then(result => { if (result) setEditing(undefined); });
      } else {
        void action.send('/categories', { name }, { reset: element, message: 'Đã thêm danh mục.' });
      }
    })}>
      <label>{editing ? t("Đổi tên danh mục {0}", editing.name) : t("Tên danh mục mới")}<input name="name" defaultValue={editing?.name} required maxLength={120}/></label>
      <div className="actions">
        <button className="button" disabled={action.pending}>{editing ? t("Lưu tên mới") : t("Thêm danh mục")}</button>
        {editing && <button type="button" className="plain" disabled={action.pending} onClick={() => setEditing(undefined)}>{t("Hủy")}</button>}
      </div>
    </form>)}{action.feedback}
  </Panel>;
}

function ProductFields({ product, categories, type, imageFieldVersion }: {
  product?: Product; categories?: Category[]; type?: Product['productType']; imageFieldVersion?: number;
}) {
  const { t } = useLanguage();
  return <><label>{type === 'FOOD' ? t("Tên món") : t("Tên sản phẩm")}<input name="name" required maxLength={120} defaultValue={product?.name}/></label>
    <label>{t("Danh mục")}<select name="category" defaultValue={product?.categoryId ?? ''}><option value="">{t("Chọn danh mục")}</option>
      {categories?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {type === 'FOOD' ? <input type="hidden" name="type" value={product?.productType ?? 'FOOD'}/> :
      <label>{t("Loại sản phẩm")}<select name="type" defaultValue={product?.productType ?? type ?? 'BOTH'}><option value="BOTH">{t("Bán lẻ và nhà hàng")}</option>
        <option value="RETAIL">{t("Bán lẻ")}</option><option value="FOOD">{t("Nhà hàng")}</option></select></label>}
    <label>{t("Mô tả")}<textarea name="description" maxLength={2000} defaultValue={product?.description}/></label>
    <ProductImageField key={imageFieldVersion} current={product?.images[0]}/></>;
}

function productInput(form: FormData) {
  return { name: value(form, 'name'), categoryId: value(form, 'category') || undefined,
    productType: value(form, 'type'), description: value(form, 'description') };
}

function withProductImage(form: FormData, product: object) {
  const image = form.get('image');
  if (!(image instanceof File) || !image.name) return product;
  const body = new FormData();
  body.set('product', JSON.stringify(product));
  body.set('image', image);
  return body;
}

export function RetailCatalog() {
  const { t } = useLanguage();
  const { role, membership } = useBusiness();
  const canEditShared = role === 'OWNER' || membership.canEditSharedCatalog;
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Product>();
  const [sizeProductId, setSizeProductId] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Product>();
  const action = useAction();
  const categories = useData<Category[]>('/categories');
  const products = useData<Product[]>(`/products?productType=RETAIL&page=${page}&q=${encodeURIComponent(q)}${archived ? '&archived=yes&status=ARCHIVED' : ''}`);
  const sizing = products.data?.find(item => item.id === sizeProductId);
  return <Panel title={t("Sản phẩm bán lẻ")} action={<button className="button" onClick={() => setCreating(true)}>{t("Đăng bán từ kho")}</button>}>
    <div className="company-filters">
      <label>{t("Tìm sản phẩm")}<input value={q} maxLength={100} onChange={event => { setQ(event.target.value); setPage(1); }}/></label>
      <label>{t("Trạng thái")}<select value={String(archived)} onChange={event => { setArchived(event.target.value === 'true'); setPage(1); }}>
        <option value="false">{t("Đang bán")}</option><option value="true">{t("Ngừng bán")}</option>
      </select></label>
    </div>
    <State query={products} empty={products.data?.length === 0}/>{action.feedback}
    {products.data?.map(item => <div key={item.id}>
      <div className="list-row service-list-row">
        <div className="catalog-product-label">{item.images[0] && <img src={item.images[0]} alt="" loading="lazy"/>}
          <div><strong>{item.name}</strong>
            <small>{item.warehouseItemId ? t("{0} · Tồn {1} {2}", item.variants[0]?.sku ?? '', (item.stock ?? 0) / 1000, item.unit ?? '') : t("Sản phẩm cũ · Chưa liên kết kho")}</small>
            {!!item.retailDiscountPercent && <small>{t("Giảm giá sản phẩm {0}%", item.retailDiscountPercent)}</small>}
            {item.variants.map(variant => <small key={variant.id}>{item.variants.length > 1 || variant.attributes?.size
              ? `${variant.attributes?.size || t("Mặc định")} · ` : ''}{currency.format(salePrice(variant))}</small>)}
          </div>
        </div>
        <div className="actions member-row-actions">
          {item.warehouseItemId && <button className="plain" type="button" onClick={() => setEditing(item)}>{t("Sửa thông tin bán")}</button>}
          {item.warehouseItemId && item.status === 'ACTIVE' && <button className="plain" type="button" aria-haspopup="dialog"
            onClick={() => setSizeProductId(item.id)}>{t("Cài size và giá")}</button>}
          {(item.warehouseItemId || canEditShared) && (item.status === 'ACTIVE' ? <button className="plain" type="button" onClick={() => setDeleting(item)}>{t("Ngừng bán")}</button> :
            <button className="plain" type="button" disabled={action.pending} onClick={() => void action.send(`/products/${item.id}`,
              { status: 'ACTIVE' }, { method: 'PATCH', message: 'Đã bán lại.' })}>{t("Bán lại")}</button>)}
        </div>
      </div>
      {!item.warehouseItemId && (canEditShared ? <EditProduct product={item} categories={categories.data} food={false}/> :
        item.status === 'ACTIVE' && <RetailBranchSettings product={item}/>)}
    </div>)}
    <Pager page={page} full={products.data?.length === 50} onChange={setPage}/>
    {(creating || editing) && <RetailListingForm key={editing?.id ?? 'new'} product={editing}
      close={() => { setEditing(undefined); setCreating(false); }}/>}
    {sizing && <RetailSizes product={sizing} close={() => setSizeProductId('')}/>}
    {deleting && <ArchiveProduct product={deleting} food={false} close={() => setDeleting(undefined)} removed={() => {
      if (page > 1 && products.data?.length === 1) setPage(page - 1);
      setDeleting(undefined);
    }}/>}
  </Panel>;
}

function RetailSizes({ product, close }: { product: Product; close: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  const [editing, setEditing] = useState<Variant>();
  const endpoint = `/retail-products/${product.id}/sizes`;
  return <BusinessDialog title={t("Cài size và giá · {0}", product.name)} close={close} pending={action.pending}>
    <p className="muted">{t("Mỗi size có giá riêng và dùng chung tồn kho của sản phẩm.")}</p>
    {product.variants.map(variant => <div className="list-row" key={variant.id}>
      <div><strong>{variant.attributes?.size || t("Mặc định")}</strong><small>{currency.format(salePrice(variant))}</small></div>
      <button type="button" className="plain" disabled={action.pending}
        aria-label={t("Sửa size {0}", variant.attributes?.size || t("Mặc định"))} onClick={() => setEditing(variant)}>{t("Sửa")}</button>
    </div>)}
    {(editing || product.variants.length < 30) && <form key={editing?.id ?? 'new'} onSubmit={event => submit(event, (form, element) => {
      void action.send(editing ? `${endpoint}/${editing.id}` : endpoint, { size: value(form, 'size'), price: amount(form, 'price') },
        editing ? { method: 'PATCH', message: 'Đã lưu size.' } : { idempotent: true, reset: element, message: 'Đã thêm size.' })
        .then(result => { if (result) setEditing(undefined); });
    })}>
      <div className="columns">
        <label>{t("Kích cỡ")}<input name="size" placeholder="S, M, L" maxLength={120} defaultValue={editing?.attributes?.size} required/></label>
        <label>{t("Giá bán trước thuế (đ)")}<input name="price" type="number" min="0" max="1000000000000" step="1"
          defaultValue={editing && (editing.branchPrice ?? editing.basePrice)} required/></label>
      </div>
      <div className="actions">
        <button type="submit" className="button" disabled={action.pending}>{editing ? t("Lưu size") : t("Thêm size")}</button>
        {editing && <button type="button" className="plain" onClick={() => setEditing(undefined)} disabled={action.pending}>{t("Hủy")}</button>}
      </div>
    </form>}
    {action.feedback}
  </BusinessDialog>;
}

function RetailBranchSettings({ product }: { product: Product }) {
  const { t } = useLanguage();
  const action = useAction();
  return <details className="business-details"><summary>{t("Giá và tình trạng bán tại chi nhánh")}</summary>
    {product.variants.map(variant => <div key={variant.id}>
      <div className="list-row"><span>{variant.sku}</span><button type="button" className="plain" disabled={action.pending}
        onClick={() => void action.send(`/products/${product.id}/variants/${variant.id}/availability`, { paused: !variant.paused }, { method: 'PATCH' })}>
        {variant.paused ? t("Bán lại") : t("Tạm ngừng bán")}</button></div>
      <BranchPrice product={product} item={variant}/>
    </div>)}
    {action.feedback}
  </details>;
}

function RetailListingForm({ product, close }: { product?: Product; close: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  return <BusinessDialog title={product ? t("Sửa thông tin bán · {0}", product.name) : t("Đăng bán từ kho")} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      const body = withProductImage(form, {
        ...(product ? {} : { warehouseItemId: value(form, 'warehouseItemId'), size: value(form, 'size') || undefined }),
        description: value(form, 'description'), price: amount(form, 'price'), retailDiscountPercent: amount(form, 'retailDiscountPercent'),
        ...(form.has('removeImage') ? { removeImage: true } : {}),
      });
      void action.send(product ? `/retail-products/${product.id}` : '/retail-products', body,
        { method: product ? 'PATCH' : 'POST' }).then(result => { if (result) close(); });
    })}>
      {!product && <><WarehousePicker/>
        <label>{t("Kích cỡ (nếu có)")}<input name="size" maxLength={120} placeholder="S, M, L"/></label>
      </>}
      <label>{t("Mô tả")}<textarea name="description" maxLength={2000} defaultValue={product?.description}/></label>
      <label>{product && product.variants.length > 1 ? t("Giá bán trước thuế · {0} (đ)", product.variants[0]?.attributes?.size || t("Mặc định"))
        : t("Giá bán trước thuế (đ)")}<input name="price" type="number" min="0" max="1000000000000" step="1" required
          defaultValue={product?.variants[0]?.basePrice}/></label>
      <RetailDiscountField product={product}/>
      <ProductImageField current={product?.images[0]}/>
      <button className="button" disabled={action.pending}>{product ? t("Lưu thông tin bán") : t("Đăng bán")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function RetailDiscountField({ product }: { product?: Product }) {
  const { t } = useLanguage();
  return <label>{t("Giảm giá sản phẩm (%)")}
    <input name="retailDiscountPercent" type="number" min={0} max={100} step={1} defaultValue={product?.retailDiscountPercent ?? 0} required/>
    <small>{t("Tự áp dụng khi bán lẻ cho mọi size. Nhập 0 để tắt.")}</small>
  </label>;
}

function BranchPrice({ product, item }: { product: Product; item: Variant }) {
  const { t } = useLanguage();
  const action = useAction();
  return <form onSubmit={event => submit(event, form => void action.send(`/products/${product.id}/variants/${item.id}/branch-price`,
    { price: value(form, 'branchPrice') ? amount(form, 'branchPrice') : null }, { method: 'PATCH' }))}>
    <label>{t("Giá riêng tại chi nhánh (đ)")}<input name="branchPrice" type="number" min="0" max="1000000000000" step="1" defaultValue={item.branchPrice}
      placeholder={t("Dùng giá chung")}/></label>
    <button className="plain" disabled={action.pending}>{t("Lưu giá chi nhánh")}</button>{action.feedback}
  </form>;
}

function EditProduct({ product, categories, food }: { product: Product; categories?: Category[]; food: boolean }) {
  const { t } = useLanguage();
  const action = useAction();
  const [imageFieldVersion, setImageFieldVersion] = useState(0);
  return <details className="business-details"><summary>{t("Chỉnh sửa")} {product.name}</summary>
    <form onSubmit={event => submit(event, form => {
      const patch = productInput(form);
      const body = withProductImage(form, { ...patch, categoryId: patch.categoryId ?? null,
        ...(food ? {} : { retailDiscountPercent: amount(form, 'retailDiscountPercent') }),
        status: value(form, 'status'), removeImage: form.has('removeImage') ? true : undefined });
      void action.send(`/products/${product.id}`, body, { method: 'PATCH' }).then(result => {
        if (result) setImageFieldVersion(version => version + 1);
      });
    })}><ProductFields product={product} categories={categories} type={food ? 'FOOD' : undefined} imageFieldVersion={imageFieldVersion}/>
      {!food && <RetailDiscountField product={product}/>}
      <label>{t("Trạng thái")}<select name="status" defaultValue={product.status}><option value="ACTIVE">{t("Đang bán")}</option><option value="ARCHIVED">{t("Ngừng bán")}</option></select></label>
      <button className="button" disabled={action.pending}>{food ? t("Lưu món") : t("Lưu sản phẩm")}</button></form>
    {product.variants.map((item, index) => <details className="business-details" key={item.id}><summary>{food ? foodVariantLabel(item, index) : t("Biến thể {0}", item.sku)}</summary>
      <form onSubmit={event => submit(event, form => void action.send(`/products/${product.id}/variants/${item.id}`,
        variantInput(form, item), { method: 'PATCH' }))}>
        <VariantFields variant={item} food={food}/><button className="button" disabled={action.pending}>{t("Lưu phiên bản")}</button>
      </form><BranchPrice product={product} item={item}/></details>)}
    <details className="business-details"><summary>{t("Thêm biến thể hoặc size")}</summary><form onSubmit={event => submit(event, (form, element) => {
      void action.send(`/products/${product.id}/variants`, variantInput(form), { reset: element });
    })}><VariantFields food={food}/><button className="button" disabled={action.pending}>{t("Thêm phiên bản")}</button></form></details>
    {product.productType === 'FOOD' && <details className="business-details"><summary>Topping ({product.modifierGroups.length})</summary>
      {product.modifierGroups.map(group => <div className="list-row" key={group.id}><div><strong>{group.name}</strong>
        <small>{group.options.map(option => `${option.name} +${currency.format(option.additionalPrice)}`).join(', ')}</small></div>
        <button className="plain" disabled={action.pending} onClick={() => void action.send(`/products/${product.id}`,
          { modifierGroups: product.modifierGroups.filter(item => item.id !== group.id).map(groupInput) }, { method: 'PATCH' })}>{t("Bỏ nhóm")}</button>
      </div>)}
      <form onSubmit={event => submit(event, (form, element) => {
        const options = value(form, 'options').split('\n').filter(Boolean).map(line => {
          const [name, price] = line.split('|');
          return { name: name.trim(), additionalPrice: Number(price ?? 0) };
        });
        const group = { name: value(form, 'group'), minSelect: amount(form, 'min'), maxSelect: amount(form, 'max'), options };
        void action.send(`/products/${product.id}`, { modifierGroups: [...product.modifierGroups.map(groupInput), group] }, { method: 'PATCH', reset: element });
      })}><label>{t("Tên nhóm")}<input name="group" maxLength={120} required/></label><div className="form-grid">
        <label>{t("Chọn tối thiểu")}<input name="min" type="number" min="0" max="10" defaultValue="0" required/></label>
        <label>{t("Chọn tối đa")}<input name="max" type="number" min="1" max="10" defaultValue="1" required/></label></div>
        <label>{t("Mỗi dòng một topping theo mẫu Tên | Giá thêm")}<textarea name="options" required rows={3} placeholder={t("Trân châu | 5000")}/></label>
        <button className="button" disabled={action.pending}>{t("Thêm nhóm topping")}</button></form></details>}
    {action.feedback}
  </details>;
}

function groupInput(group: ModifierGroup) {
  return { name: group.name, minSelect: group.minSelect, maxSelect: group.maxSelect,
    options: group.options.map(option => ({ name: option.name, additionalPrice: option.additionalPrice })) };
}

export function Catalog({ type }: { type: 'FOOD' | 'RETAIL' }) {
  const { t } = useLanguage();
  const [q, setQ] = useState('');
  const [code, setCode] = useState('');
  const [scannedBarcode, setScannedBarcode] = useState('');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('active');
  const [deleting, setDeleting] = useState<Product>();
  const [notice, setNotice] = useState('');
  const newProduct = useRef<HTMLFormElement>(null);
  const [recipeVersion, setRecipeVersion] = useState(0);
  const { role, membership } = useBusiness();
  const canEdit = role === 'OWNER' || membership.canEditSharedCatalog;
  const food = type === 'FOOD';
  const products = useData<Product[]>(!food && code ? `/products?archived=yes&productType=RETAIL&code=${encodeURIComponent(code)}` :
    `/products?productType=${type}&page=${page}&q=${encodeURIComponent(q)}${status === 'archived' ? '&archived=yes&status=ARCHIVED' : ''}`);
  const categories = useData<Category[]>('/categories');
  const action = useAction();
  return <div className={canEdit ? 'columns' : ''}><Panel title={type === 'FOOD' ? t("Danh sách món") : t("Danh sách sản phẩm")}>
    {notice && <p className="success" role="status">{notice}</p>}
    <div className="form-grid form-grid-business">
      <label>{food ? t("Tìm món") : t("Tìm sản phẩm")}<input value={q} maxLength={100} autoComplete="off" onChange={event => { setQ(event.target.value); setCode(''); setPage(1); }}
        placeholder={food ? t("Tên món") : t("Tên, SKU hoặc mã vạch")}/></label>
      <label>{t("Trạng thái")}<select value={status} onChange={event => { setStatus(event.target.value); setCode(''); setPage(1); }}>
        <option value="active">{t("Đang bán")}</option><option value="archived">{t("Đã xóa hoặc ngừng bán")}</option>
      </select></label>
    </div>
    {!food && <form onSubmit={event => submit(event, (form, element) => {
      const scanned = value(form, 'code');
      if (!scanned) return;
      setQ(''); setPage(1); setCode(scanned); element.reset();
    })}><div className="actions scan-controls"><label>{t("Quét mã vạch hoặc SKU")}<input name="code" maxLength={80} autoComplete="off" placeholder={t("Đặt con trỏ ở đây rồi quét")} required/></label>
      <button className="button">{t("Tra mã")}</button></div></form>}
    {!food && code && <div className="actions"><span>{t("Đang tra mã")} <strong>{code}</strong></span><button type="button" className="plain" onClick={() => setCode('')}>{t("Hiện tất cả")}</button></div>}
    {!food && code && products.data?.length === 0 && canEdit && <button type="button" className="plain" disabled={action.pending} onClick={() => {
      const form = newProduct.current;
      if (!form) return;
      for (const key of ['barcode', 'sku']) {
        const field = form.elements.namedItem(key);
        if (field instanceof HTMLInputElement && (key === 'barcode' || !field.value || field.value === scannedBarcode)) field.value = code;
      }
      const name = form.elements.namedItem('name');
      if (name instanceof HTMLInputElement) name.focus();
      setScannedBarcode(code);
    }}>{t("Thêm sản phẩm với mã")} {code}</button>}
    <State query={products} empty={products.data?.length === 0}/>{products.data?.map(item => {
      const soldOut = item.paused || (item.variants.length > 0 && item.variants.every(variant => variant.paused));
      return <div key={item.id}>
      <div className="list-row"><div className="catalog-product-label">{item.images[0] && <img src={item.images[0]} alt="" loading="lazy"/>}
        <div><strong>{item.name}</strong>{item.variants.map((variant, index) => <small key={variant.id}>{food ? foodVariantLabel(variant, index) : variant.sku} · {currency.format(salePrice(variant))}
          {!food && variant.barcode && <> {t("· Mã vạch")} {variant.barcode}</>}{variant.paused && !soldOut && <> {t("· Tạm ngừng bán tại đây")}</>}</small>)}</div></div>
        <div className="actions"><span className={`badge${food && soldOut && item.status === 'ACTIVE' ? ' warning' : ''}`}>
          {item.status !== 'ACTIVE' ? t("Ngừng bán") : item.recipeStatus === 'MISSING' ? t("Chưa có định lượng") :
            item.recipeStatus === 'LOW' ? t("Thiếu nguyên liệu") : food && soldOut ? t("Hết món") : t("Đang bán")}</span>
          {food && (!item.recipeStatus || item.paused) && ['OWNER', 'MANAGER'].includes(role) && item.status === 'ACTIVE' && <button type="button" className="plain" disabled={action.pending}
            onClick={() => void action.send(`/products/${item.id}/availability`, { paused: !soldOut },
              { method: 'PATCH', message: soldOut ? 'Đã bán lại món.' : 'Đã đánh dấu hết món.' })}>{soldOut ? t("Bán lại") : t("Đánh dấu hết món")}</button>}
          {canEdit && item.status === 'ACTIVE' && <button type="button" className="plain member-delete" disabled={action.pending}
            aria-label={t("Xóa {0}", item.name)} onClick={() => { setNotice(''); setDeleting(item); }}>{t("Xóa")}</button>}
          {canEdit && item.status === 'ARCHIVED' && <button type="button" className="plain" disabled={action.pending}
            onClick={() => void action.send(`/products/${item.id}`, { status: 'ACTIVE' },
              { method: 'PATCH', message: t("Đã khôi phục {0}.", item.name) })}>{t("Khôi phục")}</button>}
        </div></div>
      {canEdit && <EditProduct product={item} categories={categories.data} food={food}/>}
      {(role === 'OWNER' || role === 'MANAGER') && food && !item.warehouseItemId && <DishRecipeForm product={item}/>}
      {!food && ['OWNER', 'MANAGER'].includes(role) && item.status === 'ACTIVE' && <details className="business-details"><summary>{t("Tình trạng bán tại chi nhánh")}</summary>
        {item.variants.map(variant => <div className="list-row" key={variant.id}><span>{variant.sku}</span><button type="button" className="plain" disabled={action.pending}
          onClick={() => void action.send(`/products/${item.id}/variants/${variant.id}/availability`, { paused: !variant.paused },
            { method: 'PATCH', message: variant.paused ? 'Đã bán lại tại chi nhánh.' : 'Đã tạm ngừng bán tại chi nhánh.' })}>{variant.paused ? t("Bán lại") : t("Tạm ngừng bán")}</button></div>)}
      </details>}
      {role === 'MANAGER' && !canEdit && item.variants.map((variant, index) => <details className="business-details" key={variant.id}>
        <summary>{t("Giá tại chi nhánh ·")} {food ? foodVariantLabel(variant, index) : variant.sku}</summary><BranchPrice product={item} item={variant}/></details>)}</div>;
    })}
    {(food || !code) && <Pager page={page} full={products.data?.length === 50} onChange={setPage}/>}{action.feedback}
    {deleting && <ArchiveProduct product={deleting} food={food} close={() => setDeleting(undefined)} removed={() => {
      if (!code && page > 1 && (products.data?.length ?? 0) <= 1) setPage(page - 1);
      setNotice(`Đã xóa ${deleting.name} khỏi danh sách đang bán.`);
      setDeleting(undefined);
    }}/>}
  </Panel>{canEdit && <Panel title={type === 'FOOD' ? t("Thêm món") : t("Thêm sản phẩm")}><form ref={newProduct} onSubmit={event => submit(event, (form, element) => {
    if (!food && !value(form, 'sku') && !value(form, 'barcode')) {
      const sku = element.elements.namedItem('sku');
      if (sku instanceof HTMLInputElement) { sku.setCustomValidity('Hãy nhập SKU hoặc quét mã vạch.'); sku.reportValidity(); sku.setCustomValidity(''); }
      return;
    }
    void action.send('/products', withProductImage(form, { ...productInput(form), variants: [variantInput(form)],
      ...(food ? { ingredients: readDishIngredients(form) } : {}) }), { reset: element }).then(result => {
        if (result) {
          setScannedBarcode(''); setStatus('active'); setCode(''); setQ(''); setPage(1);
          setRecipeVersion(version => version + 1);
        }
      });
  })}><ProductFields categories={categories.data} type={type}/><VariantFields autoSku food={food}/>
    {food && <DishIngredientsFields key={recipeVersion}/>}
    <button className="button" disabled={action.pending}>{type === 'FOOD' ? t("Thêm món") : t("Thêm sản phẩm")}</button></form></Panel>}</div>;
}

function ArchiveProduct({ product, food, close, removed }: { product: Product; food: boolean; close: () => void; removed: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  return <BusinessDialog title={food ? t("Xóa món") : t("Xóa sản phẩm")} close={close} pending={action.pending} closeLabel="Hủy">
    <p>{t("Xóa")} <strong>{product.name}</strong> {t("khỏi danh sách bán ở mọi chi nhánh của doanh nghiệp?")}</p>
    <p className="muted">{t("Các hóa đơn đã lập vẫn giữ thông tin của mặt hàng. Có thể mở lại để bán từ danh sách đã xóa hoặc ngừng bán.")}</p>
    {action.feedback}
    <button type="button" className="button member-delete-confirm" disabled={action.pending} onClick={async () => {
      if (await action.send(`/products/${product.id}`, undefined, { method: 'DELETE' })) removed();
    }}>{action.pending ? t("Đang xóa…") : food ? t("Xác nhận xóa món") : t("Xác nhận xóa sản phẩm")}</button>
  </BusinessDialog>;
}

