import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { reportPeriods, revenueRange, type ReportPeriod } from '../services/revenue';

export const reportPeriodQuery = z.object({ period: z.enum(reportPeriods).default('today'),
  on: z.string().date().refine(value => value >= '1970-01-01', 'Ngày trong kỳ không hợp lệ.').optional() });

export function selectedReportRange(period: ReportPeriod, on?: string) {
  const now = new Date();
  if (on && revenueRange('today', now, on).$gte > now) throw new BadRequestException('Hãy chọn ngày trong kỳ đến hôm nay.');
  return revenueRange(period, now, on);
}
