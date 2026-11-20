'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

export function BusinessDialog({ title, close, children, pending = false, closeLabel = 'Đóng', className = '' }: {
  title: string; close: () => void; children: ReactNode; pending?: boolean; closeLabel?: string; className?: string;
}) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className={`card business-dialog ${className}`} aria-labelledby={heading} onClose={close}
    onCancel={event => { if (pending) event.preventDefault(); }}>
    <header className="desk-section-header"><h2 id={heading}>{title}</h2>
      <button type="button" className="plain" onClick={() => dialog.current?.close()} disabled={pending}>{closeLabel}</button></header>
    {children}
  </dialog>;
}
