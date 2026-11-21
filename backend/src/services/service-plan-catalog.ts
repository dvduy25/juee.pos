import { transaction } from '../config/db';
import { Plan, PlanVersion } from '../models';
import { revisions } from './plans';

export const freePlanCode = 'FREE';
export const basicSales = 'basic-sales';
const catalogRevision = 1;

const plans = [
  { code: freePlanCode, name: 'Miễn phí', description: 'Một doanh nghiệp đầu tiên, một chi nhánh bán lẻ. Có bán hàng, đơn hàng, thanh toán, sản phẩm và nhập kho.',
    monthlyVnd: 0n, yearlyVnd: 0n, maxBranches: 1, maxStaff: 0, maxQrTables: 0, features: ['pos', 'inventory', basicSales] },
  { code: 'PLUS', name: 'Nâng cao', description: 'Thêm doanh nghiệp, mở thêm chi nhánh và dùng đầy đủ tính năng quản lý. Giá tính theo từng doanh nghiệp.',
    monthlyVnd: 99000n, yearlyVnd: 1188000n, maxBranches: 20, maxStaff: 200, maxQrTables: 1000,
    features: ['pos', 'inventory', 'qr', 'kitchen', 'registers', 'chain', 'ai-inventory', 'tax-declarations'] },
];

export async function syncServicePlans() {
  await transaction(async session => {
    let updated = false;
    for (const { code, name, description, ...version } of plans) {
      const current = await Plan.findOne({ code }).session(session).lean();
      if ((current?.catalogRevision ?? 0) >= catalogRevision) continue;
      const plan = await Plan.findOneAndUpdate({ code }, { $set: { name, description, published: true, catalogRevision } },
        { upsert: true, new: true, session }).orFail();
      const [latest] = await revisions(plan._id, session);
      await PlanVersion.insertOne({ ...version, planId: plan._id, version: (latest?.version ?? 0) + 1 }, { session });
      updated = true;
    }
    if (updated) await Plan.updateMany({ code: { $in: ['TRIAL', 'MINI', 'STANDARD', 'PRO', 'BUSINESS'] }, published: true },
      { $set: { published: false } }, { session });
  });
}
