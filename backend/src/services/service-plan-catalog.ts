import { transaction } from '../config/db';
import { Plan, PlanVersion } from '../models';
import { revisions } from './plans';

export const freePlanCode = 'FREE';
const catalogRevision = 2;
const freePlan = {
  name: 'Miễn phí',
  description: 'Dùng miễn phí tất cả tính năng JUEE POS cho mọi doanh nghiệp và chi nhánh.',
  published: true,
  catalogRevision,
};
export const freeRevision = {
  monthlyVnd: 0n, yearlyVnd: 0n, maxBranches: 10000, maxStaff: 100000, maxQrTables: 100000,
  features: ['pos', 'inventory', 'qr', 'kitchen', 'registers', 'chain', 'ai-inventory', 'tax-declarations'],
};

export async function syncServicePlans() {
  if (await Plan.exists({ code: freePlanCode, catalogRevision })) return;
  await transaction(async session => {
    const current = await Plan.findOne({ code: freePlanCode }).session(session).lean();
    if ((current?.catalogRevision ?? 0) >= catalogRevision) return;
    const plan = await Plan.findOneAndUpdate({ code: freePlanCode }, { $set: freePlan },
      { upsert: true, new: true, session }).orFail();
    const [latest] = await revisions(plan._id, session);
    await PlanVersion.insertOne({ ...freeRevision, planId: plan._id, version: (latest?.version ?? 0) + 1 }, { session });
    await Plan.updateMany({ code: { $ne: freePlanCode }, published: true }, { $set: { published: false } }, { session });
  });
}
