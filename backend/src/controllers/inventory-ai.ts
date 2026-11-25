import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { transaction } from '../config/db';
import { verifyOrigin } from '../middleware/auth';
import { access, assertRestaurantMode } from '../middleware/business-access';
import { BusinessAiSettings, WarehouseItem } from '../models';
import { scopedRoute } from '../routes/branch';
import { decryptAiKey, encryptAiKey, extractInvoice, extractMenu, transcribeInvoice } from '../services/inventory-ai';
import { aiMenuInput, aiReceiptInput, receiveAiPurchase, saveAiMenu, suggestMenuItems, suggestWarehouseItems } from '../services/inventory-ai-import';
import { readProductImage } from '../services/product-image';
import { idempotent } from '../services/sales';
import { recordWarehouseMovement, warehouseQuantity } from '../services/warehouse';
import { found } from '../utils/db';
import { label, objectId, read } from '../validators/common';

type Route = { tenantId: string; branchId: string };

@Controller(scopedRoute)
export class InventoryAiController {
  @Get('warehouse/ai/settings')
  async settings(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    return { configured: !!await BusinessAiSettings.exists({ _id: scope.tenantId }) };
  }

  @Patch('warehouse/ai/settings')
  async save(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    verifyOrigin(req);
    const { apiKey } = read(z.object({ apiKey: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{20,300}$/, 'Khóa API OpenAI không hợp lệ.') }).strict(), body);
    return transaction(async session => {
      const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.ai', session);
      await BusinessAiSettings.updateOne({ _id: scope.tenantId }, { $set: { encryptedKey: encryptAiKey(String(scope.tenantId), apiKey) } }, { upsert: true, session });
      return { configured: true };
    });
  }

  @Delete('warehouse/ai/settings')
  async remove(@Req() req: Request, @Param() route: Route) {
    verifyOrigin(req);
    return transaction(async session => {
      const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.ai', session);
      await BusinessAiSettings.deleteOne({ _id: scope.tenantId }, { session });
      return { configured: false };
    });
  }

  @Post('warehouse/ai/extract')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 3, fieldSize: 30_000 } }))
  async extract(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    verifyOrigin(req);
    const input = read(z.object({ source: z.enum(['text', 'image', 'audio']), kind: z.enum(['receive', 'issue', 'menu']).default('issue'),
      text: z.string().trim().max(10_000).optional() }).strict(), body);
    const permission = input.kind === 'menu' ? 'catalog.branch-write' : input.kind === 'receive' ? 'purchases.manage' : 'warehouse.ai';
    const { scope, branch } = await access(req, route.tenantId, route.branchId, permission);
    if (input.kind === 'menu') {
      assertRestaurantMode(branch.mode);
      if (input.source !== 'image') throw new BadRequestException('Hãy chọn ảnh thực đơn.');
    }
    if (input.source === 'text' ? !input.text || !!file : !file?.buffer.length || !!input.text) {
      throw new BadRequestException('Chọn một nguồn chứng từ hợp lệ.');
    }
    const settings = await BusinessAiSettings.findById(scope.tenantId).select('+encryptedKey').lean();
    if (!settings) throw new BadRequestException('Hãy cài khóa API OpenAI của doanh nghiệp trước.');
    const key = decryptAiKey(String(scope.tenantId), settings.encryptedKey);
    const image = input.source === 'image' ? readProductImage(file) : undefined;
    if (input.kind === 'menu' && image) {
      return { lines: await suggestMenuItems(scope, await extractMenu(key, image)) };
    }
    const transcript = input.source === 'audio' && file ? await transcribeInvoice(key, file) : input.text;
    const invoice = await extractInvoice(key, transcript || '', image, input.kind === 'receive');
    if (input.kind !== 'receive') return invoice;
    return { ...invoice, lines: await suggestWarehouseItems(scope, invoice.lines) };
  }

  @Post('warehouse/ai/receive')
  async receive(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    verifyOrigin(req);
    const input = read(aiReceiptInput, body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    return idempotent(scope, 'AI_WAREHOUSE_RECEIVE', key, { actorId, input }, async session => {
      await access(req, route.tenantId, route.branchId, 'purchases.manage', session);
      const receipt = await receiveAiPurchase(scope, actorId, input, session);
      return { id: receipt._id };
    });
  }

  @Post('warehouse/ai/menu')
  async menu(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    verifyOrigin(req);
    const input = read(aiMenuInput, body);
    const { scope, actorId, branch } = await access(req, route.tenantId, route.branchId, 'catalog.branch-write');
    assertRestaurantMode(branch.mode);
    return idempotent(scope, 'AI_MENU_SAVE', key, { actorId, input }, async session => {
      const current = await access(req, route.tenantId, route.branchId, 'catalog.branch-write', session);
      assertRestaurantMode(current.branch.mode);
      return saveAiMenu(scope, actorId, current.membership, input, session);
    });
  }

  @Post('warehouse/ai/issue')
  async issue(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    verifyOrigin(req);
    const line = z.object({ itemId: objectId, quantity: warehouseQuantity.refine(value => value > 0), revision: z.number().int().nonnegative() }).strict();
    const input = read(z.object({ note: label, lines: z.array(line).min(1).max(30)
      .refine(items => new Set(items.map(item => item.itemId)).size === items.length, 'Gộp các dòng trùng mặt hàng trước khi lưu.') }).strict(), body);
    const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'warehouse.ai');
    return idempotent(scope, 'AI_WAREHOUSE_ISSUE', key, { actorId, input }, async session => {
      await access(req, route.tenantId, route.branchId, 'warehouse.ai', session);
      const items = await WarehouseItem.find({ ...scope, _id: { $in: input.lines.map(item => item.itemId) } }).session(session);
      const byId = new Map(items.map(item => [String(item._id), item]));
      for (const line of input.lines) {
        const item = found(byId.get(line.itemId), 'Mặt hàng không thuộc kho chi nhánh.');
        if (item.revision !== line.revision) throw new BadRequestException('Tồn kho vừa thay đổi. Chọn lại mặt hàng và kiểm tra số lượng.');
        await recordWarehouseMovement(scope, item, { operation: 'ISSUE', quantity: line.quantity, note: input.note, actorId }, session);
      }
      return { ok: true };
    });
  }
}
