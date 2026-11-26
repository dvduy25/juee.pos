'use client';

import { useLanguage } from '@/i18n/language';
import { useEffect, useState } from 'react';
import { Maximize, Minimize } from 'lucide-react';

const wideViewChange = 'juee-wide-view-change';

function setWideView(enabled: boolean) {
  document.documentElement.toggleAttribute('data-wide-view', enabled);
  document.dispatchEvent(new Event(wideViewChange));
}

export function FullscreenButton({ className = 'plain' }: { className?: string }) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const sync = () => setExpanded(!!document.fullscreenElement || document.documentElement.hasAttribute('data-wide-view'));
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && document.documentElement.hasAttribute('data-wide-view')) setWideView(false);
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener(wideViewChange, sync);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener(wideViewChange, sync);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  async function toggle() {
    const root = document.documentElement;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (root.hasAttribute('data-wide-view')) {
      setWideView(false);
    } else {
      if (root.requestFullscreen && document.fullscreenEnabled) {
        try { await root.requestFullscreen(); return; }
        catch { /* Embedded browsers can block fullscreen requests. */ }
      }
      setWideView(true);
    }
  }

  const label = expanded ? t("Thoát toàn màn hình") : t("Toàn màn hình");
  return <button type="button" className={className} aria-label={label} title={label} onClick={() => void toggle()}>
    {expanded ? <Minimize size={18} aria-hidden="true"/> : <Maximize size={18} aria-hidden="true"/>}
  </button>;
}
