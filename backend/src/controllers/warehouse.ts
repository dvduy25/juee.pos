import { Body, ConflictException, Controller, Get, Header, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { transaction } from '../config/db';
import { access, logChange } from '../middleware/business-access';
import { Category, DishRecipe, Product, User, WarehouseItem, WarehouseMovement, warehouseOperations } from '../models';
import { scopedRoute } from '../routes/branch';
import { idempotent } from '../services/sales';
import { csvDate, csvFile } from '../services/csv';
import { latestWarehouseCount, recordWarehouseMovement, warehouseCorrectionNote, warehouseCountBasis, warehouseCountFilter,
  warehouseCountFilters, warehouseCountLots, warehouseExpiry, warehouseQuantity, warehouseRecipeNote } from '../services/warehouse';
import { applyStockLotChanges, availableStock, stockLotChanges, stockLots } from '../services/stock-lots';
import { facilityToday } from '../services/membership-plans';
import { found, isDuplicate, localFilter } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { pageSchema } from '../validators/sales';
import { reportPeriodQuery, selectedReportRange } from '../validators/reports';

type Route = { tenantId: string; branchId: string; id: string };
const code = z.string().trim().min(1).max(60).transform(value => value.toUpperCase());
const fields = z.object({ code, name: label, unit: z.string().trim().min(1).max(32), minimum: warehouseQuantity,
  barcode: z.string().trim().min(1).max(80).nullable().optional(), categoryId: objectId.nullable().optional(),
  size: label.nullable().optional(), color: label.nullable().optional(), unitCost: vnd.optional(), expiresOn: warehouseExpiry }).strict();
const revision = z.number().int().nonnegative().safe();

function duplicateItem(error: unknown): never {
  if (isDuplicate(error)) throw new ConflictException('Mã hàng hoặc mã vạch đã được dùng trong kho của chi nhánh này.');
  throw error;
}

@Controller(scopedRoute)
export class WarehouseController {
  @Get('warehouse/items')
  async items(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.read');
    const { page, q, code, stock, alerts } = read(z.object({ page: pageSchema, q: z.string().trim().max(120).optional(),
      code: z.string().trim().min(1).max(80).optional(), stock: z.enum(['LOW', 'EMPTY', 'SOON', 'EXPIRED']).optional(), alerts: z.literal('yes').optional() }), query);
    const search = q ? localFilter(q) : undefined;
    const byCode = code ? { $or: [{ barcode: code }, { code: code.toUpperCase() }] } : undefined;
    const now = Date.now();
    const today = facilityToday(now);
    const soonUntil = facilityToday(now + 7 * 86400000);
    const lots = { $ifNull: ['$lots', [{ expiresOn: { $ifNull: ['$expiresOn', null] }, quantity: '$onHand' }]] };
    const available = { $sum: { $map: { input: lots, as: 'lot', in: { $cond: [{ $or: [
      { $eq: [{ $ifNull: ['$$lot.expiresOn', null] }, null] }, { $gte: ['$$lot.expiresOn', today] },
    ] }, '$$lot.quantity', 0] } } } };
    const low = { $expr: { $and: [{ $gt: [available, 0] }, { $lte: [available, '$minimum'] }] } };
    const empty = { $expr: { $eq: [available, 0] } };
    const expires = (condition: object) => ({ $expr: { $gt: [{ $size: { $filter: { input: lots, as: 'lot', cond: { $and: [
      { $gt: ['$$lot.quantity', 0] }, { $ne: [{ $ifNull: ['$$lot.expiresOn', null] }, null] }, condition,
    ] } } } }, 0] } });
    const soon = expires({ $and: [{ $gte: ['$$lot.expiresOn', today] }, { $lte: ['$$lot.expiresOn', soonUntil] }] });
    const expired = expires({ $lt: ['$$lot.expiresOn', today] });
    const filters = { LOW: low, EMPTY: empty, SOON: soon, EXPIRED: expired };
    const [items, total, lowStock, emptyStock, soonStock, expiredStock] = await Promise.all([
      WarehouseItem.find({ ...scope, ...(byCode ?? (search ? { $or: [{ name: search }, { code: search }, { barcode: search }] } : {})),
        ...(stock ? filters[stock] : {}) }).sort('name _id').skip((page - 1) * 50).limit(50).lean(),
      WarehouseItem.countDocuments(scope), WarehouseItem.countDocuments({ ...scope, ...low }), WarehouseItem.countDocuments({ ...scope, ...empty }),
      alerts ? WarehouseItem.countDocuments({ ...scope, ...soon }) : 0,
      alerts ? WarehouseItem.countDocuments({ ...scope, ...expired }) : 0,
    ]);
    return { items: items.map(item => ({ ...item, lots: stockLots(item), available: availableStock(item, today) })),
      total, low: lowStock, empty: emptyStock, soon: soonStock, expired: expiredStock, today, soonUntil };
  }

  @Get('warehouse/items/:id')
  async item(@Req() req: Request, @Param() route: Route, @Query('view') view?: string) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.read');
    const filter = { ...scope, _id: read(objectId, route.id) };
    if (view === 'count') return transaction(async session => {
      const item = found(await WarehouseItem.findOne(filter).session(session).lean(), 'Không tìm thấy mặt hàng trong kho.');
      return { ...item, lots: stockLots(item), countBasis: await warehouseCountBasis(scope, item._id, session) };
    });
    return found(await WarehouseItem.findOne(filter).lean(), 'Không tìm thấy mặt hàng trong kho.');
  }

  @Get('warehouse/export-stock')
  @Header('Cache-Control', 'no-store')
  async exportStock(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.read');
    const today = facilityToday();
    async function* rows() {
      const items = WarehouseItem.find(scope).sort('name _id').lean().cursor();
      try {
        for await (const item of items) {
          const lots = stockLots(item);
          for (const lot of lots.length ? lots : [{ quantity: 0, expiresOn: null }]) {
            const expired = !!lot.expiresOn && lot.expiresOn < today;
            yield [today, item.code, item.name, item.unit, lot.expiresOn ?? '', lot.quantity / 1000,
              expired ? 0 : lot.quantity / 1000, expired ? 'Hết hạn' : '', item.unitCost ?? ''];
          }
        }
      } finally {
        await items.close();
      }
    }
    return csvFile(`juee-ton-kho-${today}`, ['Ngày chốt', 'Mã mặt hàng', 'Tên', 'Đơn vị', 'Hạn sử dụng', 'Tồn theo lô',
      'Tồn còn hạn', 'Trạng thái hạn', 'Giá nhập bình quân (đ/đơn vị)'], rows());
  }

  @Post('warehouse/items')
  async createItem(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(fields, body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'warehouse.write');
    return idempotent(scope, 'WAREHOUSE_ITEM_CREATE', key, { actorId, ...input }, async session => {
      await access(req, route.tenantId, route.branchId, 'warehouse.write', session);
      if (input.categoryId) found(await Category.exists({ tenantId: scope.tenantId, _id: input.categoryId }).session(session), 'Danh mục không tồn tại.');
      if (await WarehouseItem.exists({ ...scope, $or: [{ code: input.code }, ...(input.barcode ? [{ barcode: input.barcode }] : [])] }).session(session)) {
        throw new ConflictException('Mã hàng hoặc mã vạch đã tồn tại.');
      }
      const item = await WarehouseItem.insertOne({ ...scope, ...input }, { session });
      await logChange(scope, actorId, 'WAREHOUSE_ITEM_CREATE', item._id, session);
      return item.toObject();
    }).catch(duplicateItem);
  }

  @Patch('warehouse/items/:id')
  async updateItem(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const { revision: expected, ...input } = read(fields.extend({ revision }), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'warehouse.write', session);
      const item = found(await WarehouseItem.findOne({ ...scope, _id: id }).session(session), 'Không tìm thấy mặt hàng trong kho.');
      if (item.revision !== expected) throw new ConflictException('Mặt hàng vừa thay đổi. Hãy kiểm tra lại.');
      if (item.lots?.length && input.expiresOn !== undefined) throw new ConflictException('Hãy dùng kiểm kê để sửa hạn sử dụng theo từng lô.');
      if (item.onHand > 0 && item.unit !== input.unit) throw new ConflictException('Đơn vị tính có thể đổi khi hết tồn.');
      if (item.unit !== input.unit && (await DishRecipe.exists({ ...scope, 'ingredients.itemId': item._id }).session(session) ||
        await WarehouseMovement.exists({ ...scope, itemId: item._id, note: warehouseRecipeNote }).session(session))) {
        throw new ConflictException('Nguyên liệu đã dùng trong định lượng. Hãy tạo nguyên liệu mới nếu cần đổi đơn vị.');
      }
      if (await WarehouseItem.exists({ ...scope, code: input.code, _id: { $ne: item._id } }).session(session)) {
        throw new ConflictException('Mã hàng đã tồn tại.');
      }
      if (input.barcode && await WarehouseItem.exists({ ...scope, barcode: input.barcode, _id: { $ne: item._id } }).session(session)) {
        throw new ConflictException('Mã vạch đã tồn tại.');
      }
      if (input.categoryId) found(await Category.exists({ tenantId: scope.tenantId, _id: input.categoryId }).session(session), 'Danh mục không tồn tại.');
      item.set(input);
      item.revision += 1;
      await item.save({ session });
      await Product.updateOne({ tenantId: scope.tenantId, retailBranchId: scope.branchId, warehouseItemId: item._id },
        { $set: { name: item.name, categoryId: item.categoryId ?? null } }, { session });
      await logChange(scope, actorId, 'WAREHOUSE_ITEM_UPDATE', item._id, session);
      return item.toObject();
    }).catch(duplicateItem);
  }

  @Get('warehouse/movements')
  async movements(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.read');
    const { page, itemId, count } = read(z.object({ page: pageSchema, itemId: objectId.optional(), count: z.enum(warehouseCountFilters).optional() }), query);
    const movements = await WarehouseMovement.find({ ...scope, ...(itemId ? { itemId } : {}), ...warehouseCountFilter(count) })
      .sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
    const people = await User.find({ _id: { $in: movements.flatMap(item => item.actorId ? [item.actorId] : []) } }).select('name').lean();
    const names = new Map(people.map(person => [String(person._id), person.name]));
    return movements.map(item => ({ ...item, actorName: !item.actorId && item.note === warehouseRecipeNote ? 'Khách gọi món QR' : names.get(String(item.actorId)) }));
  }

  @Get('warehouse/export-movements')
  @Header('Cache-Control', 'no-store')
  async exportMovements(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.read');
    const { period, on, itemId, count } = read(reportPeriodQuery.extend({ itemId: objectId.optional(), count: z.enum(warehouseCountFilters).optional() }), query);
    const range = selectedReportRange(period, on);
    const operationLabels = { RECEIPT: 'Nhập kho', ISSUE: 'Xuất kho', COUNT: 'Kiểm kê' };
    async function* rows() {
      const movements = WarehouseMovement.find({ ...scope, createdAt: range, ...(itemId ? { itemId } : {}), ...warehouseCountFilter(count) })
        .sort('-createdAt -_id').lean().cursor();
      try {
        for await (const item of movements) {
          const after = item.correctedQuantity ?? item.after;
          const delta = after - item.before;
          const count = item.operation === 'COUNT';
          const lots = item.correctedLots ?? item.lotsAfter ?? item.lotAllocation;
          const expiries = lots?.filter(lot => lot.expiresOn).map(lot => `${lot.expiresOn} (${lot.quantity / 1000})`).join(' · ');
          yield [csvDate.format(item.createdAt), item._id.toString(), item.itemCode, item.itemName, item.unit, operationLabels[item.operation],
            item.before / 1000, after / 1000, delta / 1000, count ? Math.max(0, -delta) / 1000 : '',
            count ? Math.max(0, delta) / 1000 : '', item.unitCost ?? '', expiries || item.expiresOn || '',
            item.correctedAt ? csvDate.format(item.correctedAt) : '', item.note];
        }
      } finally {
        await movements.close();
      }
    }
    return csvFile(`juee-lich-su-kho-${period}`, ['Thời gian (Việt Nam)', 'Mã giao dịch', 'Mã hàng', 'Mặt hàng', 'Đơn vị', 'Loại',
      'Tồn trước', 'Tồn sau / số đếm', 'Chênh lệch', 'Hụt', 'Dư', 'Giá lưu (đ/đơn vị)', 'Hạn sử dụng', 'Sửa lúc', 'Nội dung'], rows());
  }

  @Post('warehouse/movements')
  async move(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(z.object({ itemId: objectId, operation: z.enum(warehouseOperations), quantity: warehouseQuantity,
      revision, note: label, expiresOn: warehouseExpiry, countedLots: warehouseCountLots }).strict()
      .refine(input => input.operation === 'COUNT' || (input.expiresOn === undefined && input.countedLots === undefined),
        'Thông tin kiểm kê chỉ được dùng khi lưu kiểm kê.'), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'warehouse.write');
    return idempotent(scope, 'WAREHOUSE_MOVEMENT', key, { actorId, ...input }, async session => {
      await access(req, route.tenantId, route.branchId, 'warehouse.write', session);
      const item = found(await WarehouseItem.findOne({ ...scope, _id: input.itemId }).session(session), 'Không tìm thấy mặt hàng trong kho.');
      if (item.revision !== input.revision) throw new ConflictException('Tồn kho vừa thay đổi. Hãy kiểm tra lại trước khi lưu.');
      const countBasis = input.operation === 'COUNT' ?
        await warehouseCountBasis(scope, item._id, session) : undefined;
      const movement = await recordWarehouseMovement(scope, item,
        { operation: input.operation, quantity: input.quantity, note: input.note, actorId, expiresOn: input.expiresOn,
          countedLots: input.countedLots, countBasis }, session);
      return { ...movement.toObject(), lotsAfter: stockLots(item) };
    });
  }

  @Patch('warehouse/movements/:id/count')
  async correctCount(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const id = read(objectId, route.id);
    const input = read(z.object({ quantity: warehouseQuantity, note: label, revision, countedLots: warehouseCountLots }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'warehouse.write');
    return idempotent(scope, 'WAREHOUSE_COUNT_CORRECTION', key, { actorId, id, ...input }, async session => {
      await access(req, route.tenantId, route.branchId, 'warehouse.write', session);
      const count = found(await WarehouseMovement.findOne({ ...scope, _id: id, operation: 'COUNT' }).session(session), 'Không tìm thấy lần kiểm kê.');
      const latest = await latestWarehouseCount(scope, count.itemId, session);
      if (!latest?._id.equals(count._id)) throw new ConflictException('Chỉ sửa được lần kiểm kê gần nhất của mặt hàng.');
      const item = found(await WarehouseItem.findOne({ ...scope, _id: count.itemId }).session(session));
      if (item.revision !== input.revision) throw new ConflictException('Tồn kho vừa thay đổi. Hãy tải lại số liệu trước khi lưu.');
      if (item.unit !== count.unit) throw new ConflictException('Đơn vị tính đã thay đổi. Hãy kiểm kê lại theo đơn vị hiện tại.');

      const previous = count.correctedQuantity ?? count.after;
      const previousLots = count.correctedLots ?? count.lotsAfter ?? stockLots({ onHand: previous, expiresOn: count.expiresOn });
      if (!input.countedLots && previousLots.length > 1) throw new ConflictException('Hãy nhập số lượng kiểm kê theo từng hạn sử dụng.');
      const correctedLots = applyStockLotChanges([], input.countedLots ?? [{ expiresOn: previousLots[0]?.expiresOn, quantity: input.quantity }]);
      if (correctedLots.reduce((sum, lot) => sum + lot.quantity, 0) !== input.quantity) throw new ConflictException('Tổng số lượng theo hạn sử dụng không khớp.');
      const changes = stockLotChanges(previousLots, correctedLots);
      if (changes.length) {
        applyStockLotChanges(stockLots(item), changes);
        for (const operation of ['ISSUE', 'RECEIPT'] as const) {
          const allocation = changes.filter(lot => operation === 'ISSUE' ? lot.quantity < 0 : lot.quantity > 0)
            .map(lot => ({ ...lot, quantity: Math.abs(lot.quantity) }));
          if (allocation.length) await recordWarehouseMovement(scope, item, { operation, quantity: allocation.reduce((sum, lot) => sum + lot.quantity, 0),
            lotAllocation: allocation, note: warehouseCorrectionNote, actorId, referenceId: count._id }, session);
        }
      } else if (count.note !== input.note) {
        item.revision += 1;
        await item.save({ session });
      } else {
        return count.toObject();
      }
      await logChange(scope, actorId, 'WAREHOUSE_COUNT_CORRECTION', count._id, session,
        { previousQuantity: previous, quantity: input.quantity, previousNote: count.note, note: input.note });
      count.correctedQuantity = input.quantity;
      count.set('correctedLots', correctedLots);
      count.correctedAt = new Date();
      count.note = input.note;
      await count.save({ session });
      return count.toObject();
    });
  }
}
