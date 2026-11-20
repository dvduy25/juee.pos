'use client';

import { Activity, Braces, Clock3, Database, RefreshCw, Server } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { dateTime } from './admin-data';
import { api } from '@/services/api-client';

type Diagnostics = {
  api: 'up';
  database: 'up' | 'down';
  checkedAt: string;
  environment: string;
  node: string;
  uptimeSeconds: number;
};

function uptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours} giờ ${minutes} phút` : `${minutes} phút ${seconds % 60} giây`;
}

export function DeveloperConsole() {
  const query = useQuery({ queryKey: ['platform', 'developer'], queryFn: () => api<Diagnostics>('/platform/developer') });
  const data = query.data;

  return <>
    <div className="page-heading"><div><h1>Nhà phát triển</h1><p>Kiểm tra kết nối dịch vụ và thông tin môi trường.</p></div>
      <button className="button" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={16}/> Kiểm tra lại</button>
    </div>
    {query.isLoading && <div className="skeleton" aria-label="Đang tải"/>}
    {query.error && <p className="error" role="alert">{query.error.message}</p>}
    {data && <>
      <div className="desk-stat-grid developer-status">
        <article className="card desk-stat"><span className="desk-shortcut-icon"><Activity size={19}/></span><small>API</small><strong>Đang hoạt động</strong></article>
        <article className="card desk-stat"><span className="desk-shortcut-icon"><Database size={19}/></span><small>MongoDB</small>
          <strong className={data.database === 'down' ? 'service-down' : ''}>{data.database === 'up' ? 'Đã kết nối' : 'Gián đoạn'}</strong></article>
        <article className="card desk-stat"><span className="desk-shortcut-icon"><Clock3 size={19}/></span><small>Thời gian chạy</small><strong>{uptime(data.uptimeSeconds)}</strong></article>
      </div>
      <div className="columns developer-details">
        <section className="card"><h2><Server size={20}/> Môi trường API</h2>
          <div className="list-row"><span>Chế độ</span><code>{data.environment}</code></div>
          <div className="list-row"><span>Node.js</span><code>{data.node}</code></div>
          <div className="list-row"><span>Kiểm tra lúc</span><time dateTime={data.checkedAt}>{dateTime(data.checkedAt)}</time></div>
        </section>
        <section className="card"><h2><Braces size={20}/> Endpoint quản trị</h2>
          <div className="list-row"><code>/api/v1/platform/developer</code><span>Yêu cầu phiên quản trị</span></div>
        </section>
      </div>
    </>}
  </>;
}
