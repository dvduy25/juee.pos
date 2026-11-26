'use client';

import { useLanguage } from '@/i18n/language';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useRef, useState } from 'react';
import type { Branch, Membership, WorkspaceMode } from '@/types/business';
import { api, requestKey } from '@/services/api-client';

export type CompanySelection = { businesses: Membership[]; selectBusiness: (id: string) => void; selectBranch: (id: string, destination?: string) => void };
export const BusinessContext = createContext<{ tenantId: string; branch: Branch; branches: Branch[]; membership: Membership; role: string;
  root: string; mode: WorkspaceMode; staffMode: boolean; active: boolean;
  company?: CompanySelection & { membership: Membership; createBusiness?: () => void } } | null>(null);
export function useBusiness() {
  const value = useContext(BusinessContext);
  if (!value) throw new Error('Branch context missing');
  return value;
}

export function useData<T>(path: string, interval?: number, enabled = true) {
  const { root } = useBusiness();
  return useQuery({ queryKey: ['business', root, path], queryFn: () => api<T>(root + path), enabled, refetchInterval: interval });
}

export function useAction() {
  const { t } = useLanguage();
  const { root } = useBusiness();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const keys = useRef(new Map<string, string>());
  const active = useRef(false);

  async function send<T = unknown>(path: string, data: unknown, options: {
    method?: string; idempotent?: boolean; message?: string; reset?: HTMLFormElement; absolute?: boolean;
  } = {}): Promise<T | undefined> {
    if (active.current) return;
    active.current = true; setPending(true); setError(''); setNotice('');
    const signature = JSON.stringify([path, data]);
    let key = keys.current.get(signature);
    if (options.idempotent && !key) { key = requestKey(); keys.current.set(signature, key); }
    try {
      const result = await api<T>((options.absolute ? '' : root) + path, options.method ?? 'POST', data, key ? { 'Idempotency-Key': key } : undefined);
      keys.current.delete(signature);
      options.reset?.reset();
      setNotice(options.message ?? 'Đã lưu.');
      await client.invalidateQueries({ queryKey: ['business', root] });
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Yêu cầu chưa thành công.');
    } finally { active.current = false; setPending(false); }
  }

  return { send, pending, feedback: <>{error && <p className="error" role="alert">{t(error)}</p>}{notice && <p className="success" role="status">{t(notice)}</p>}</> };
}

