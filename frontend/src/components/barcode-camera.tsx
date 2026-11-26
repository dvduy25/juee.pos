'use client';

import { useEffect, useRef, useState } from 'react';
import { ScanBarcode } from 'lucide-react';
import type { IScannerControls } from '@zxing/browser';
import { useLanguage } from '@/i18n/language';
import { BusinessDialog } from './business-dialog';

export function BarcodeCamera({ onRead, disabled = false }: { onRead: (code: string) => void; disabled?: boolean }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="plain barcode-camera-button" aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
      <ScanBarcode size={17} aria-hidden="true"/> {t("Quét bằng camera")}
    </button>
    {open && <CameraDialog close={() => setOpen(false)} onRead={code => { setOpen(false); onRead(code); }}/>}
  </>;
}

function CameraDialog({ close, onRead }: { close: () => void; onRead: (code: string) => void }) {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const read = useRef(onRead);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { read.current = onRead; }, [onRead]);
  useEffect(() => {
    const preview = video.current;
    if (!preview) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    let controls: IScannerControls | undefined;

    function stop() {
      if (stopped) return;
      stopped = true;
      controls?.stop();
      stream?.getTracks().forEach(track => track.stop());
      if (preview) preview.srcObject = null;
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Mở trang bằng HTTPS trên trình duyệt hỗ trợ camera.');
        return;
      }
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        if (stopped || !preview) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (stopped) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        preview.srcObject = stream;
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
        controls = await reader.decodeFromVideoElement(preview, (result, _error, session) => {
          if (!result || stopped || !preview.closest('dialog')?.open) return;
          const code = result.getText().trim();
          if (!code || code.length > 80 || /[\x00-\x1f\x7f]/.test(code)) {
            setError('Mã này không hợp lệ. Hãy đưa mã khác vào khung.');
            return;
          }
          controls = session;
          stop();
          read.current(code);
        });
        if (stopped) controls.stop();
        else setReady(true);
      } catch (cause) {
        if (stopped) return;
        stop();
        const name = cause instanceof Error ? cause.name : '';
        setError(name === 'NotAllowedError' ? 'Chưa được cấp quyền camera. Hãy cho phép camera trong trình duyệt rồi thử lại.'
          : name === 'NotFoundError' ? 'Không tìm thấy camera. Bạn có thể nhập mã bằng bàn phím.'
          : 'Không mở được camera. Hãy kiểm tra camera rồi thử lại.');
      }
    }
    void start();
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, []);

  return <BusinessDialog title={t("Quét mã sản phẩm")} close={close} className="barcode-camera-dialog">
    <div className="barcode-camera-preview">
      <video ref={video} autoPlay muted playsInline aria-hidden="true"/>
      {ready && <div className="barcode-camera-guide" aria-hidden="true"/>}
    </div>
    {error ? <p className="error" role="alert">{t(error)}</p> :
      <p className="muted" role="status">{ready ? t("Đưa mã vạch vào khung và giữ yên.") : t("Đang mở camera…")}</p>}
  </BusinessDialog>;
}
