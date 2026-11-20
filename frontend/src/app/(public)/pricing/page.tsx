'use client';

import Link from 'next/link';
import { Layers3 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/services/api-client';
import { FullscreenButton } from '@/components/fullscreen-button';

type Plan = { code: string; name: string; description: string; monthlyVnd: string; yearlyVnd: string; maxBranches: number; maxStaff: number; maxQrTables: number };
const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });

export default function Pricing() {
  const [plans, setPlans] = useState<Plan[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    api<Plan[]>('/plans').then(data => { if (mounted) setPlans(data); })
      .catch(() => { if (mounted) setError('Không tải được bảng giá. Vui lòng tải lại trang.'); });
    return () => { mounted = false; };
  }, []);

  return <div className="landing">
    <nav><Link className="brand" href="/"><Layers3/> JUEE POS</Link><div className="actions"><Link className="button" href="/login">Đăng nhập</Link><FullscreenButton/></div></nav>
    <main className="pricing"><div className="page-heading"><div><h1>Bảng giá</h1><p>Giá gói theo tháng và giới hạn sử dụng.</p></div></div>
      {error && <p className="error" role="alert">{error}</p>}
      {!plans && !error && <div className="skeleton" role="status" aria-label="Đang tải bảng giá"/>}
      {plans?.length === 0 && <p className="muted">Chưa có gói dịch vụ được công bố.</p>}
      {plans && <div className="pricing-grid">{plans.map(plan => <section className="card" key={plan.code}>
        <h2>{plan.name}</h2><strong>{money.format(BigInt(plan.monthlyVnd))} <small>mỗi tháng</small></strong>
        {plan.description && <p>{plan.description}</p>}
        <p>{plan.maxBranches} chi nhánh</p><p>{plan.maxStaff} nhân viên</p><p>Tối đa {plan.maxQrTables} bàn QR theo tính năng của gói</p>
        {plan.yearlyVnd && plan.code !== 'FREE' && <p>{money.format(BigInt(plan.yearlyVnd))} mỗi năm</p>}
        {plan.code === 'FREE' ? <small>Áp dụng cho cửa hàng đã có gói Free.</small> : <Link className="button" href="/register">Đăng ký cửa hàng</Link>}
      </section>)}</div>}
    </main>
  </div>;
}
