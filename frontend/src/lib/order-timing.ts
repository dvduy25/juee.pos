'use client';

import { useEffect, useState } from 'react';

export type Preparation = { id: string; orderItemId: string; status: string; readyAt?: string; servedAt?: string;
  cancelReason?: string; cancelConfirmedAt?: string };

export function isWaitingForService(status: string) {
  return ['NEW', 'COOKING', 'READY'].includes(status);
}

export function useOrderClock(enabled = true) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function elapsedTime(start: string, end: number) {
  const seconds = Math.floor(Math.max(0, end - Date.parse(start)) / 1000);
  if (!end || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} phút ${seconds % 60} giây` : `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}

export function itemTiming(orderedAt: string, status: string, servedAt: string | undefined, now: number) {
  if (status === 'CANCELED') return '';
  if (status === 'SERVED') {
    const elapsed = servedAt && elapsedTime(orderedAt, Date.parse(servedAt));
    return elapsed ? `Đã ra món sau ${elapsed}` : 'Đã phục vụ';
  }
  const elapsed = elapsedTime(orderedAt, now);
  return elapsed ? `Đã chờ ${elapsed}` : '';
}
