'use client';

import { useQuery } from '@tanstack/react-query';
import { State } from '@/components/business-ui';
import { currency } from '@/lib/format';
import { api } from '@/services/api-client';
import { usesTables, type Branch, type ServicePlan } from '@/types/business';

export function suitablePlans(plans: ServicePlan[], modes: Branch['mode'][]) {
  const needsTables = modes.some(usesTables);
  return plans.filter(plan => BigInt(plan.monthlyVnd) > 0n && plan.maxBranches >= modes.length &&
    plan.features.includes('pos') && (!needsTables || (plan.features.includes('qr') && plan.features.includes('kitchen'))));
}

export function useServicePlans(enabled: boolean) {
  return useQuery({ queryKey: ['plans'], queryFn: () => api<ServicePlan[]>('/plans'), enabled });
}

export function PlanOptions({ plans, choices, selected, onSelect }: {
  plans: ReturnType<typeof useServicePlans>; choices: ServicePlan[]; selected: string; onSelect: (code: string) => void;
}) {
  return <><State query={plans}/>
    {plans.isSuccess && !choices.length && <p className="muted">Chưa có gói phù hợp với mô hình và số chi nhánh.</p>}
    {!!choices.length && <fieldset className="branch-models setup-plans"><legend>Gói dịch vụ theo tháng</legend>
      {choices.map(plan => <label className="branch-model" key={plan.code}>
        <input type="radio" name="plan" value={plan.code} checked={selected === plan.code} onChange={() => onSelect(plan.code)} required/>
        <strong>{plan.name}</strong><span>{currency.format(BigInt(plan.monthlyVnd))} / tháng</span>
        <small>{plan.maxBranches} chi nhánh · {plan.maxStaff} nhân viên</small>
        {plan.features.includes('qr') && <small>Tối đa {plan.maxQrTables} bàn QR</small>}
      </label>)}
    </fieldset>}
  </>;
}
