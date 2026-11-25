'use client';

import { useSyncExternalStore } from 'react';
import { Printer } from 'lucide-react';
import { useBusiness } from '@/hooks/use-business';

const preferenceChanged = 'juee:receipt-print';
const localValues = new Map<string, string>();
const preferenceKey = (scope: string) => `juee-receipt-print:${scope}`;

function read(key: string) {
  if (localValues.has(key)) return localValues.get(key);
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
    localValues.delete(key);
  } catch { localValues.set(key, value); }
}

function subscribe(listener: () => void) {
  window.addEventListener(preferenceChanged, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(preferenceChanged, listener);
    window.removeEventListener('storage', listener);
  };
}

export function AutoPrintSwitch() {
  const { root } = useBusiness();
  const key = preferenceKey(root);
  const enabled = useSyncExternalStore(subscribe, () => read(key) === 'on', () => false);
  return <label className="receipt-print-switch no-print">
    <Printer size={17} aria-hidden="true"/>
    <span>Tự động in hóa đơn</span>
    <input type="checkbox" role="switch" checked={enabled} onChange={event => {
      write(key, event.currentTarget.checked ? 'on' : 'off');
      window.dispatchEvent(new Event(preferenceChanged));
    }}/>
    <span className="receipt-print-track" aria-hidden="true"/>
  </label>;
}

export async function printPaidReceipt(scope: string, billId: string, print: () => Promise<void>) {
  if (read(preferenceKey(scope)) !== 'on') return;
  const historyKey = `juee-receipt-printed:${scope}`;
  async function printOnce() {
    if (read(preferenceKey(scope)) !== 'on') return;
    const printed = (read(historyKey) ?? '').split(',').filter(Boolean);
    if (printed.includes(billId)) return;
    await print();
    write(historyKey, [...printed.slice(-99), billId].join(','));
  }
  if (navigator.locks) await navigator.locks.request(historyKey, printOnce);
  else await printOnce();
}
