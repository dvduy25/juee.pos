import type { ClientSession, Types } from 'mongoose';
import { Plan, PlanVersion } from '../models';

export async function revisions(planId: Types.ObjectId, session?: ClientSession) {
  return PlanVersion.find({ planId }).sort('-version').limit(1).session(session ?? null).setOptions({ useBigInt64: true }).lean();
}

export async function publishedPlans() {
  const plans = await Plan.find({ published: true, code: { $ne: 'TRIAL' } }).lean();
  const items = await Promise.all(plans.map(async plan => {
    const [revision] = await revisions(plan._id);
    return revision && { code: plan.code, name: plan.name, description: plan.description,
      monthlyVnd: revision.monthlyVnd, yearlyVnd: revision.yearlyVnd ?? revision.monthlyVnd * 12n,
      maxBranches: revision.maxBranches, maxStaff: revision.maxStaff, maxQrTables: revision.maxQrTables,
      features: revision.features.filter(feature => feature !== 'inventory') };
  }));
  return items.filter(Boolean).sort((a, b) => a.monthlyVnd === b.monthlyVnd
    ? a.code.localeCompare(b.code) : a.monthlyVnd < b.monthlyVnd ? -1 : 1);
}
