import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { transaction } from '../config/db';
import { verifyOrigin } from '../middleware/auth';
import { access, assertRestaurantMode } from '../middleware/business-access';
import { BusinessAiSettings, WarehouseItem, inventoryAiProviders, retailBranchModes, type BranchMode, type InventoryAiProvider } from '../models';
import { scopedRoute } from '../routes/branch';
import { decryptAiKey, encryptAiKey, extractInvoice, extractMenu, extractRetailProducts } from '../services/inventory-ai';
import { aiMenuInput, aiReceiptInput, aiRetailInput, receiveAiPurchase, saveAiMenu, saveAiRetail, suggestMenuItems, suggestRetailItems, suggestWarehouseItems } from '../services/inventory-ai-import';
import { readProductImage } from '../services/product-image';
import { idempotent } from '../services/sales';
import { recordWarehouseMovement, warehouseQuantity } from '../services/warehouse';
import { found, isDuplicate } from '../utils/db';
import { label, objectId, read } from '../validators/common';

type Route = { tenantId: string; branchId: string };
const aiProvider = z.enum(inventoryAiProviders);
const keyFields = { openai: 'encryptedKey', gemini: 'encryptedGeminiKey' } as const;
const keySelection = '+encryptedKey +encryptedGeminiKey';
const keyPatterns = { openai: /^sk-[A-Za-z0-9_-]{20,300}$/, gemini: /^(?!sk-)(?:AQ\.)?[A-Za-z0-9_-]{20,300}$/ };

function settingsStatus(settings?: { provider?: InventoryAiProvider | null; encryptedKey?: string | null; encryptedGeminiKey?: string | null } | null) {
  const provider = settings?.provider ?? 'openai';
  const available = { openai: !!settings?.encryptedKey, gemini: !!settings?.encryptedGeminiKey };
  return { configured: available[provider], provider, available };
}

function assertRetailMode(mode: BranchMode) {
  if (!retailBranchModes.includes(mode)) throw new ConflictException('Chỉ đăng bán hàng kho tại quầy bán lẻ.');
}

@Controller(scopedRoute)
export class InventoryAiController {
  @Get('warehouse/ai/settings')
  async settings(@Req() req: Request, @Param() route: Route) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'purchases.manage');
    return settingsStatus(await BusinessAiSettings.findById(scope.tenantId).select(keySelection).lean());
  }

  @Patch('warehouse/ai/settings')
  async save(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    verifyOrigin(req);
    const { provider, apiKey } = read(z.object({ provider: aiProvider.default('openai'), apiKey: z.string().trim().max(305).optional() }).strict(), body);
    if (apiKey !== undefined && !keyPatterns[provider].test(apiKey)) {
      throw new BadRequestException(provider === 'gemini'
        ? 'Khóa Gemini không đúng định dạng. Hãy sao chép toàn bộ khóa từ Google AI Studio.'
        : 'Khóa API OpenAI không đúng định dạng.');
    }
    return transaction(async session => {
      const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.ai', session);
      const field = keyFields[provider];
      const filter = apiKey ? { _id: scope.tenantId } : { _id: scope.tenantId, [field]: { $type: 'string' } };
      const update = apiKey ? { provider, [field]: encryptAiKey(String(scope.tenantId), apiKey, provider) } : { provider };
      const settings = await BusinessAiSettings.findOneAndUpdate(filter, { $set: update },
        { session, upsert: !!apiKey, returnDocument: 'after' }).select(keySelection).lean();
      if (!settings) throw new BadRequestException('Hãy lưu khóa API của nhà cung cấp này trước.');
      return settingsStatus(settings);
    });
  }

  @Delete('warehouse/ai/settings')
  async remove(@Req() req: Request, @Param() route: Route, @Query('provider') rawProvider?: string) {
    verifyOrigin(req);
    const provider = read(aiProvider.optional(), rawProvider);
    return transaction(async session => {
      const { scope } = await access(req, route.tenantId, route.branchId, 'warehouse.ai', session);
      const current = await BusinessAiSettings.findById(scope.tenantId).select('provider').session(session).lean();
      const field = keyFields[provider ?? current?.provider ?? 'openai'];
      const settings = await BusinessAiSettings.findOneAndUpdate({ _id: scope.tenantId },
        { $unset: { [field]: 1 } }, { session, returnDocument: 'after' }).select(keySelection).lean();
      return settingsStatus(settings);
    });
  }

  @Post('warehouse/ai/extract')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 4, fieldSize: 30_000 } }))
  async extract(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    verifyOrigin(req);
    const input = read(z.object({ source: z.enum(['text', 'image']), kind: z.enum(['receive', 'issue', 'menu', 'retail']).default('issue'),
      text: z.string().trim().max(10_000).optional(), provider: aiProvider.optional() }).strict(), body);
    const permission = input.kind === 'menu' || input.kind === 'retail' ? 'catalog.branch-write' : input.kind === 'receive' ? 'purchases.manage' : 'warehouse.ai';
    const { scope, branch } = await access(req, route.tenantId, route.branchId, permission);
    if (input.kind === 'menu') {
      assertRestaurantMode(branch.mode);
      if (input.source !== 'image') throw new BadRequestException('Hãy chọn ảnh thực đơn.');
    }
    if (input.kind === 'retail') assertRetailMode(branch.mode);
    if (input.source === 'text' ? !input.text || !!file : !file?.buffer.length || !!input.text) {
      throw new BadRequestException('Chọn một nguồn chứng từ hợp lệ.');
    }
    const settings = await BusinessAiSettings.findById(scope.tenantId).select(keySelection).lean();
    const provider = settings?.provider ?? 'openai';
    if ((input.provider ?? 'openai') !== provider) {
      throw new ConflictException('Doanh nghiệp vừa đổi nhà cung cấp AI. Hãy tải lại trang để kiểm tra trước khi gửi chứng từ.');
    }
    const encryptedKey = settings?.[keyFields[provider]];
    if (!encryptedKey) throw new BadRequestException('Hãy cài khóa API của doanh nghiệp trước.');
    const credentials = { provider, key: decryptAiKey(String(scope.tenantId), encryptedKey, provider) };
    const image = input.source === 'image' ? readProductImage(file) : undefined;
    if (input.kind === 'menu' && image) {
      return { lines: await suggestMenuItems(scope, await extractMenu(credentials, image)) };
    }
    if (input.kind === 'retail') {
      return { lines: await suggestRetailItems(scope, await extractRetailProducts(credentials, { text: input.text, image })) };
    }
    const invoice = await extractInvoice(credentials, { text: input.text, image, purchasePhoto: input.kind === 'receive' });
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

  @Post('warehouse/ai/retail')
  async retail(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    verifyOrigin(req);
    const input = read(aiRetailInput, body);
    const { scope, actorId, branch } = await access(req, route.tenantId, route.branchId, 'catalog.branch-write');
    assertRetailMode(branch.mode);
    return idempotent(scope, 'AI_RETAIL_SAVE', key, { actorId, input }, async session => {
      const current = await access(req, route.tenantId, route.branchId, 'catalog.branch-write', session);
      assertRetailMode(current.branch.mode);
      if (input.lines.some(line => line.mode === 'new')) await access(req, route.tenantId, route.branchId, 'warehouse.write', session);
      return saveAiRetail(scope, actorId, input, session);
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mã hàng, mã vạch hoặc sản phẩm đã tồn tại. Hãy kiểm tra bảng duyệt.');
      throw error;
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
