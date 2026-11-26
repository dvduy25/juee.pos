'use client';

import { useLanguage } from '@/i18n/language';
import { useEffect, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { LanguageSwitch } from '@/components/language-switch';
import { FullscreenButton } from '@/components/fullscreen-button';
import { date, submit, value } from '@/lib/format';
import { api, apiBlob, ApiError, requestKey } from '@/services/api-client';
import type { KioskMethod, VisitProgress } from '@/types/member-check-in';
import { VisitProgressFields } from './visit-progress';

type Settings = { name: string; mode?: string; methods: KioskMethod[] };
type CheckInResult = { id: string; createdAt: string; remaining?: number; photoProof?: string; progress?: VisitProgress };
type Feedback = { text: string; visit?: CheckInResult };

function KioskPhoto({ path, authorization, proof }: { path: string; authorization: string; proof: string }) {
  const { t } = useLanguage();
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    let url = '';
    void apiBlob(path, { Authorization: authorization, 'X-Member-Photo-Proof': proof }).then(image => {
      if (active) {
        url = URL.createObjectURL(image);
        setSrc(url);
      }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [path, authorization, proof]);
  return src ? <img className="member-photo" src={src} alt={t("Ảnh hội viên vừa check-in")}/> : null;
}

export function MemberKiosk({ tenantId, branchId, preferredMethod }: { tenantId: string; branchId: string; preferredMethod?: KioskMethod }) {
  const { t } = useLanguage();
  const path = `/member-kiosk/${tenantId}/${branchId}`;
  const storageKey = `juee-kiosk:${tenantId}:${branchId}`;
  const [key, setKey] = useState<string>();
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback>();
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const retry = useRef<{ key: string; method: KioskMethod; code: string } | undefined>(undefined);
  const method = preferredMethod && settings?.methods.includes(preferredMethod) ? preferredMethod :
    preferredMethod ? undefined : settings?.methods[0];

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const keyFromLink = fragment.get('key');
    const entered = keyFromLink && /^juee-kiosk-[a-f0-9]{64}$/.test(keyFromLink) ? keyFromLink : '';
    if (fragment.has('key')) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    try {
      if (entered) window.localStorage.setItem(storageKey, entered);
      setKey(entered || window.localStorage.getItem(storageKey) || '');
    } catch {
      setKey(entered);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!key) return;
    let current = true;
    let loading = false;
    async function fetchSettings() {
      if (loading) return;
      loading = true;
      try {
        const result = await api<Settings>(path, 'GET', undefined, { Authorization: `Bearer ${key}` });
        if (current) { setSettings(result); setError(''); }
      } catch (cause) {
        if (current) {
          setSettings(undefined);
          setError(cause instanceof ApiError && cause.status === 401 ? 'Màn hình đã mất kết nối. Hãy mở lại link do quản lý cấp.' :
            cause instanceof Error ? cause.message : 'Không tải được cài đặt check-in.');
        }
      } finally {
        loading = false;
      }
    }
    void fetchSettings();
    const poll = window.setInterval(() => void fetchSettings(), 10000);
    return () => { current = false; window.clearInterval(poll); };
  }, [key, path]);

  useEffect(() => {
    if (!method) return;
    const focusInput = () => input.current?.focus();
    focusInput();
    window.addEventListener('focus', focusInput);
    document.addEventListener('fullscreenchange', focusInput);
    return () => { window.removeEventListener('focus', focusInput); document.removeEventListener('fullscreenchange', focusInput); };
  }, [method]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), feedback.visit ? 10000 : 6000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function checkIn(form: FormData, element: HTMLFormElement) {
    const code = value(form, 'code');
    if (!method || !code || !key || sending.current) return;
    sending.current = true;
    setPending(true);
    setFeedback(undefined);
    if (retry.current?.code !== code || retry.current?.method !== method) retry.current = { code, method, key: requestKey() };
    try {
      const result = await api<CheckInResult>(`${path}/check-ins`, 'POST', { code, method },
        { Authorization: `Bearer ${key}`, 'Idempotency-Key': retry.current.key });
      retry.current = undefined;
      setFeedback({ text: 'Đã check-in. Mời bạn vào.', visit: result });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) retry.current = undefined;
      setFeedback({ text: cause instanceof Error ? cause.message : 'Chưa ghi nhận được. Hãy thử lại.' });
    } finally {
      sending.current = false;
      setPending(false);
      element.reset();
      input.current?.focus();
    }
  }

  return <main className="member-kiosk-page" data-theme={settings?.mode === 'POOL' ? 'POOL' : 'GYM'}><section className="card member-kiosk-card">
    <header className="guest-section-head"><div><small>{settings?.name ?? 'JUEE POS'}</small><h1>{t("Check-in hội viên")}</h1></div><div className="access-header-tools"><LanguageSwitch/><FullscreenButton/></div></header>
    {key === '' && <p className="notice">{t("Hãy mở link tự check-in từ cài đặt của phòng.")}</p>}
    {key && !settings && !error && <p role="status">{t("Đang tải cài đặt phòng…")}</p>}
    {error && <p className="error" role="alert">{t(error)}</p>}
    {settings && !method && <p className="notice">{t("Phương thức check-in của màn hình này đang tắt.")}</p>}
    {method && <form onSubmit={event => submit(event, (form, element) => void checkIn(form, element))}>
      <label>{method === 'CARD' ? t("Quét thẻ hội viên") : t("Nhập hoặc quét mã hội viên")}
        <input ref={input} name="code" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={80} required
          readOnly={pending} placeholder={method === 'CARD' ? t("Đưa thẻ vào đầu đọc") : t("Mã hội viên")}/>
      </label>
      <button type="submit" className="button" disabled={pending}><ScanLine size={18}/> {pending ? t("Đang check-in…") : 'Check-in'}</button>
    </form>}
    {feedback?.visit ? <div className="success member-kiosk-result" role="status">
      {key && feedback.visit.photoProof && <KioskPhoto key={feedback.visit.id} path={`${path}/check-ins/${feedback.visit.id}/photo`}
        authorization={`Bearer ${key}`} proof={feedback.visit.photoProof}/>}
      <div>{feedback.text}<br/>{t("Giờ check-in")} <time dateTime={feedback.visit.createdAt}>{date(feedback.visit.createdAt)}</time></div>
      {(feedback.visit.progress || typeof feedback.visit.remaining === 'number') && <dl className="member-visit-details member-progress">
        <VisitProgressFields progress={feedback.visit.progress} remaining={feedback.visit.remaining}/>
      </dl>}
    </div> : feedback && <p className="error" role="alert">{feedback.text}</p>}
  </section></main>;
}
