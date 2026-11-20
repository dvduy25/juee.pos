import { Controller, Get, Headers, Param, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { access, restaurant } from '../middleware/business-access';
import { mongoId } from '../utils/db';
import { objectId, read } from '../validators/common';
import { OutboxEvent } from '../models';
import { scopedRoute } from '../routes/branch';

@Controller(scopedRoute)
export class RealtimeController {
  @Get('kitchen/stream')
  async kitchen(
    @Req() req: Request, @Res() res: Response,
    @Param() route: { tenantId: string; branchId: string },
    @Query('view') rawView?: string,
    @Headers('last-event-id') rawId?: string,
  ) {
    const view = read(z.enum(['kitchen', 'service']).default('kitchen'), rawView);
    const authenticate = async () => {
      const { scope, branch } = await access(req, route.tenantId, route.branchId, view === 'service' ? 'kitchen.serve' : 'kitchen.work');
      await restaurant(scope, branch.mode, 'kitchen');
      return scope;
    };
    const scope = await authenticate();
    const start = objectId.safeParse(rawId);
    let cursor = start.success ? mongoId(start.data) :
      (await OutboxEvent.findOne(scope).sort('-_id').select('_id').lean())?._id;
    if (res.destroyed) return;
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('event: sync\ndata: {}\n\n');
    let busy = false;
    let closed = false;
    let authorizedUntil = Date.now() + 5000;
    const tick = setInterval(async () => {
      if (busy || closed) return;
      busy = true;
      try {
        if (Date.now() >= authorizedUntil) {
          await authenticate();
          authorizedUntil = Date.now() + 5000;
          if (!closed) res.write(': connected\n\n');
        }
        const changes = await OutboxEvent.find({
          ...scope, type: { $in: ['order.accepted', 'order.cancelled', 'kitchen.updated'] },
          ...(cursor ? { _id: { $gt: cursor } } : {}),
        }).sort('_id').limit(100).select('type').lean();
        for (const change of changes) {
          if (closed) break;
          cursor = change._id;
          if (!res.write(`id: ${cursor}\nevent: sync\ndata: {}\n\n`)) {
            res.end();
            break;
          }
        }
      } catch {
        if (!closed) res.end();
      } finally { busy = false; }
    }, 1500);
    const timeout = setTimeout(() => res.end(), 55000);
    res.on('close', () => {
      closed = true;
      clearInterval(tick);
      clearTimeout(timeout);
    });
  }
}
