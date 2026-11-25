import Link from 'next/link';
import { Layers3 } from 'lucide-react';
import { FullscreenButton } from '@/components/fullscreen-button';

export default function Pricing() {
  return <div className="landing">
    <nav><Link className="brand" href="/"><Layers3/> JUEE POS</Link><div className="actions"><Link className="button" href="/login">Đăng nhập</Link><FullscreenButton/></div></nav>
    <main className="pricing">
      <div className="page-heading"><div><h1>Bảng giá</h1></div></div>
      <div className="pricing-grid"><section className="card">
        <h2>Miễn phí</h2>
        <p>Dùng toàn bộ tính năng JUEE POS cho mọi doanh nghiệp và chi nhánh.</p>
        <Link className="button" href="/register">Bắt đầu miễn phí</Link>
      </section></div>
    </main>
  </div>;
}
