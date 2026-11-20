import type { FormEvent } from 'react';

export const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
export const date = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
export const vietnamLocalTime = (value: string | number = Date.now()) =>
  new Date(new Date(value).getTime() + 7 * 3600000).toISOString().slice(0, 16);
export const vietnamDateTimeInput = (value: string) => value.length === 16 ? `${value}:00+07:00` : `${value}+07:00`;
export const value = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
export const amount = (form: FormData, name: string) => Number(value(form, name));

export async function printReceipt() {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  window.print();
}


export function submit(event: FormEvent<HTMLFormElement>, run: (form: FormData, element: HTMLFormElement) => void) {
  event.preventDefault();
  run(new FormData(event.currentTarget), event.currentTarget);
}

