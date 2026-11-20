import type { ReactNode } from 'react';

export function Panel({ title, children, className = '', action, id }: { title: string; children: ReactNode; className?: string; action?: ReactNode; id?: string }) {
  return <section id={id} className={`card business-panel ${className}`}>
    {action ? <header className="desk-section-header"><h2>{title}</h2>{action}</header> : <h2>{title}</h2>}
    {children}
  </section>;
}

export function State({ query, empty }: { query: { isLoading: boolean; error: Error | null }; empty?: boolean }) {
  if (query.isLoading) return <div className="skeleton" aria-label="Đang tải"/>;
  if (query.error) return <p className="error" role="alert">{query.error.message}</p>;
  return empty ? <p className="muted">Chưa có dữ liệu.</p> : null;
}

export function StatusFilters({ items, value, onChange, label }: {
  items: { key: string; label: string; count: number }[]; value: string;
  onChange: (value: string) => void; label: string;
}) {
  return <div className="status-filters" role="group" aria-label={label}>
    {items.map(item => <button key={item.key} type="button" className="plain" aria-label={`${item.label} (${item.count})`}
      aria-pressed={value === item.key} onClick={() => onChange(item.key)}>{item.label}<span>{item.count}</span></button>)}
  </div>;
}

export function Pager({ page, full, onChange }: { page: number; full: boolean; onChange: (page: number) => void }) {
  return <div className="actions business-pager">
    <button type="button" className="plain" disabled={page <= 1} onClick={() => onChange(page - 1)}>Trang trước</button>
    <span>Trang {page}</span><button type="button" className="plain" disabled={!full} onClick={() => onChange(page + 1)}>Trang sau</button>
  </div>;
}

