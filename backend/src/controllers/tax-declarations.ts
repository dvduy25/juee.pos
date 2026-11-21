import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { transaction } from '../config/db';
import { verifyOrigin } from '../middleware/auth';
import { access, logChange, requireModule } from '../middleware/business-access';
import { TaxDeclaration } from '../models';
import { scopedRoute } from '../routes/branch';
import { found } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { pageSchema } from '../validators/sales';

const draft = z.object({
  name: label, taxId: z.string().trim().regex(/^(?:\d{10}(?:-?\d{3})?|\d{12})$/, 'Kiểm tra lại mã số thuế.'),
  startsOn: z.string().date(), endsOn: z.string().date(),
  taxableRevenue: vnd, outputTax: vnd, inputTax: vnd, payableTax: vnd,
  note: z.string().trim().max(1500).optional(),
}).strict().refine(item => item.startsOn <= item.endsOn, 'Ngày kết thúc phải từ ngày bắt đầu trở đi.');
type Route = { tenantId: string; branchId: string; id: string };

@Controller(scopedRoute)
export class TaxDeclarationsController {
  @Get('tax-declarations')
  async list(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'tax.manage');
    await requireModule(scope, 'tax-declarations');
    const { page } = read(z.object({ page: pageSchema }), query);
    return TaxDeclaration.find({ tenantId: scope.tenantId }).sort('-endsOn -createdAt -_id').skip((page - 1) * 50).limit(50).lean();
  }

  @Post('tax-declarations')
  async create(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(draft, body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'tax.manage', session);
      await requireModule(scope, 'tax-declarations', session);
      const declaration = await TaxDeclaration.insertOne({ tenantId: scope.tenantId, ...input }, { session });
      await logChange(scope, actorId, 'TAX_DRAFT_CREATE', declaration._id, session);
      return declaration.toObject();
    });
  }

  @Patch('tax-declarations/:id')
  async edit(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(draft, body);
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'tax.manage', session);
      await requireModule(scope, 'tax-declarations', session);
      const entry = found(await TaxDeclaration.findOneAndUpdate({ _id: id, tenantId: scope.tenantId, receipt: null },
        { $set: { ...input, note: input.note ?? '' } }, { session, returnDocument: 'after' }).lean(), 'Không tìm thấy bản nháp có thể sửa.');
      await logChange(scope, actorId, 'TAX_DRAFT_UPDATE', entry._id, session);
      return entry;
    });
  }

  @Patch('tax-declarations/:id/filing')
  async recordFiling(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(z.object({ receipt: label, filedOn: z.string().date() }).strict(), body);
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'tax.manage', session);
      await requireModule(scope, 'tax-declarations', session);
      const entry = found(await TaxDeclaration.findOneAndUpdate({ _id: id, tenantId: scope.tenantId, receipt: null },
        { $set: input }, { session, returnDocument: 'after' }).lean(), 'Không tìm thấy bản nháp có thể ghi nhận đã nộp.');
      await logChange(scope, actorId, 'TAX_FILING_RECORDED', entry._id, session);
      return entry;
    });
  }
}
