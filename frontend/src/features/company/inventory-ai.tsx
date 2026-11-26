'use client';

import { useLanguage } from '@/i18n/language';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, Camera, CheckCircle2, ChevronDown, FileImage, FileText, Images, Info, KeyRound, LoaderCircle, MapPin, Mic, PackageMinus,
  PackagePlus, ScanLine, Square, Utensils, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { usesTables } from '@/types/business';
import { ReviewIssue, ReviewMenu, ReviewReceipt, type IssueDraft, type MenuDraft, type ReceiptDraft } from './inventory-ai-review';
import './inventory-ai.css';

type Source = 'text' | 'image' | 'audio';
type Kind = 'receive' | 'issue' | 'menu';
type Draft = { kind: 'receive'; data: ReceiptDraft } | { kind: 'issue'; data: IssueDraft } | { kind: 'menu'; data: MenuDraft };
type AiProvider = 'openai' | 'gemini';
type AiSettings = { configured: boolean; provider?: AiProvider; available?: Record<AiProvider, boolean> };
const providerLabels = { openai: 'OpenAI', gemini: 'Gemini' };
const documentOptions = [
  { value: 'receive', label: 'Nhập hàng', Icon: PackagePlus },
  { value: 'menu', label: 'Thực đơn', Icon: Utensils },
  { value: 'issue', label: 'Xuất kho', Icon: PackageMinus },
] as const;
const sourceOptions = [
  { value: 'image', label: 'Ảnh', Icon: Camera },
  { value: 'text', label: 'Văn bản', Icon: FileText },
  { value: 'audio', label: 'Ghi âm', Icon: Mic },
] as const;
const photoLimit = 4 * 1024 * 1024;
const photoTypes = ['image/jpeg', 'image/png', 'image/webp'];

async function photoForUpload(file: File) {
  if (file.size <= photoLimit && photoTypes.includes(file.type)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.78]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= photoLimit) return new File([blob], 'chung-tu.jpg', { type: 'image/jpeg' });
    }
    throw new Error('Photo is too large');
  } finally {
    bitmap.close();
  }
}

export function InventoryAi() {
  const { t } = useLanguage();
  const { branch, role } = useBusiness();
  const query = useSearchParams();
  const initial = query.get('document') === 'menu' && usesTables(branch.mode) ? 'menu' : 'receive';
  const settings = useData<AiSettings>('/warehouse/ai/settings');
  const owner = role === 'OWNER';
  const config = settings.data;
  const connectionId = useId();
  return <div className="inventory-ai">
    <div className={owner && config ? 'ai-layout ai-layout-with-settings' : 'ai-layout'}>
      {config?.configured ? <InvoiceAssistant key={branch.id + initial} initial={initial} provider={config.provider}/> :
        <section className="card ai-workspace" aria-label={t("Đọc chứng từ")}>
          <State query={settings}/>
          {config && <div className="ai-empty">
            <span className="ai-icon"><ScanLine size={29} aria-hidden="true"/></span>
            <h2>{t("Đọc chứng từ")}</h2>
            <p>{owner ? t("Chọn nhà cung cấp và lưu khóa API để tạo bản nháp từ chứng từ.") :
              t("Chủ doanh nghiệp cần lưu khóa API để bật tính năng đọc chứng từ.")}</p>
            {owner && <a className="plain" href={`#${connectionId}`}>{t("Tới cài đặt khóa API")} <ArrowDown size={16} aria-hidden="true"/></a>}
          </div>}
        </section>}
      {owner && config && <aside className="card ai-connection" id={connectionId} aria-labelledby={connectionId + '-title'}>
        <div className="ai-connection-head">
          <span className="ai-icon"><KeyRound size={19} aria-hidden="true"/></span>
          <div>
            <h2 id={connectionId + '-title'}>{t("Khóa API của doanh nghiệp")}</h2>
            <p className="ai-connection-state" data-ready={config.configured}>
              {config.configured ? <><CheckCircle2 size={14} aria-hidden="true"/>{t("Đang dùng")} {providerLabels[config.provider ?? 'openai']}</> : t("Chưa cài khóa API")}
            </p>
          </div>
        </div>
        <details className="ai-connection-details" open={!config.configured}>
          <summary>{t("Cài đặt và cách lấy khóa")} <ChevronDown size={17} aria-hidden="true"/></summary>
          <ProviderSettings key={branch.id} settings={config}/>
        </details>
      </aside>}
    </div>
  </div>;
}

function ProviderSettings({ settings }: { settings: AiSettings }) {
  const { t } = useLanguage();
  const action = useAction();
  const [provider, setProvider] = useState<AiProvider>(settings.provider ?? 'openai');
  const saved = settings.available?.[provider] ?? settings.configured;
  const active = settings.configured && (settings.provider ?? 'openai') === provider;
  const name = providerLabels[provider];
  const submitLabel = active ? 'Thay khóa' : `Sử dụng ${name}`;
  const path = '/warehouse/ai/settings';

  return <>
    <form className="ai-key-form" onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const apiKey = String(new FormData(form).get('apiKey') ?? '').trim() || undefined;
      void action.send(path, { ...(settings.provider ? { provider } : {}), apiKey },
        { method: 'PATCH', reset: form, message: t("Đang dùng {0} để đọc chứng từ.", name) });
    }}>
      <fieldset className="ai-choice-field" disabled={action.pending}>
        <legend>{t("Nhà cung cấp")}</legend>
        <div className="ai-provider-options">
          {(['openai', 'gemini'] as const).filter(option => option === 'openai' || !!settings.available).map(option => {
            const available = settings.available?.[option] ?? settings.configured;
            const inUse = settings.configured && (settings.provider ?? 'openai') === option;
            return <label className="ai-choice ai-provider-option" key={option}>
              <input type="radio" name="ai-provider" value={option} checked={provider === option} onChange={() => setProvider(option)}/>
              <span>{providerLabels[option]}</span><small>{inUse ? t("Đang dùng") : available ? t("Đã lưu khóa") : t("Chưa có khóa")}</small>
            </label>;
          })}
        </div>
      </fieldset>
      <details className="ai-key-guide" open={!saved}>
        <summary>{t("Cách lấy khóa API")} {name}</summary>
        <ol>
          {provider === 'gemini' ? <>
            <li>{t("Mở")} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">{t("trang API Keys của Google AI Studio")}</a> {t("và đăng nhập Google.")}</li>
            <li>{t("Bấm")} <strong>Create API key</strong>{t(", chọn dự án rồi sao chép toàn bộ khóa bằng")} <strong>Copy key</strong>.</li>
          </> : <>
            <li>{t("Mở")} <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">{t("trang API Keys của OpenAI")}</a> {t("và đăng nhập.")}</li>
            <li>{t("Bấm")} <strong>Create new secret key</strong>{t(", chọn dự án rồi sao chép khóa ngay khi được hiển thị.")}</li>
          </>}
          <li>{t("Quay lại JUEE POS, dán khóa vào ô")} <strong>{t("Khóa API")} {name}</strong> {t("và bấm")} <strong>{submitLabel}</strong>.</li>
        </ol>
      </details>
      <label>{t("Khóa API")} {name}<input key={provider} name="apiKey" type="password" autoComplete="off" spellCheck={false}
        maxLength={305} placeholder={saved ? t("Đã lưu khóa") : t("Dán khóa API")} required={!saved || active} disabled={action.pending}/></label>
      <div className="ai-key-actions">
        <button type="submit" className="button" disabled={action.pending}>{submitLabel}</button>
        {saved && <button type="button" className="plain" disabled={action.pending} onClick={() => {
          void action.send(settings.provider ? `${path}?provider=${provider}` : path, undefined,
            { method: 'DELETE', message: t("Đã xóa khóa API {0}.", name) });
        }}>{t("Xóa khóa")}</button>}
      </div>
    </form>
    {action.feedback}
  </>;
}

function InvoiceAssistant({ initial, provider }: { initial: 'receive' | 'menu'; provider?: AiProvider }) {
  const { t } = useLanguage();
  const { branch, role } = useBusiness();
  const action = useAction();
  const [source, setSource] = useState<Source>('image');
  const [kind, setKind] = useState<Kind>(initial);
  const [draft, setDraft] = useState<Draft>();
  const [photo, setPhoto] = useState<File>();
  const [readPhoto, setReadPhoto] = useState<File>();
  const [photoError, setPhotoError] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState('');
  const [audio, setAudio] = useState<File>();
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState('');
  const recorder = useRef<MediaRecorder>(undefined);
  const stream = useRef<MediaStream>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      stream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  async function toggleRecording() {
    if (recorder.current?.state === 'recording') { recorder.current.stop(); return; }
    setAudio(undefined); setRecordError(''); setRecording(true);
    let microphone: MediaStream | undefined;
    try {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream.current = microphone;
      const recording = new MediaRecorder(microphone);
      recorder.current = recording;
      const clips: Blob[] = [];
      recording.ondataavailable = event => { if (event.data.size) clips.push(event.data); };
      recording.onstop = () => {
        clearTimeout(timer.current);
        microphone?.getTracks().forEach(track => track.stop());
        if (!mounted.current) return;
        setRecording(false);
        if (clips.length) setAudio(new File(clips, 'ghi-am', { type: recording.mimeType || clips[0].type }));
      };
      recording.start();
      timer.current = setTimeout(() => { if (recording.state === 'recording') recording.stop(); }, 60_000);
    } catch {
      microphone?.getTracks().forEach(track => track.stop());
      if (mounted.current) { setRecording(false); setRecordError('Không mở được micro. Bạn có thể tải bản ghi có sẵn.'); }
    }
  }

  async function extract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setNotice('');
    setPhotoError('');
    setShowFeedback(false);
    setReadPhoto(undefined);
    data.set('source', source);
    data.set('kind', kind);
    if (provider) data.set('provider', provider);
    if (source === 'image') {
      if (!photo) return;
      setPreparing(true);
      try {
        const attachment = await photoForUpload(photo);
        data.set('file', attachment);
        setReadPhoto(attachment);
      } catch {
        setPhotoError('Không mở được ảnh hoặc ảnh quá lớn. Hãy chụp lại hoặc chọn ảnh JPG, PNG hay WebP rõ nét.');
        return;
      } finally {
        setPreparing(false);
      }
    }
    if (source === 'audio' && audio) data.set('file', audio);
    const path = '/warehouse/ai/extract';
    const options = { message: 'Đã đọc xong. Kiểm tra từng dòng trước khi xác nhận.' };
    setShowFeedback(true);
    if (kind === 'menu') {
      const next = await action.send<MenuDraft>(path, data, options);
      if (next) setDraft({ kind, data: next });
    } else if (kind === 'receive') {
      const next = await action.send<ReceiptDraft>(path, data, options);
      if (next) setDraft({ kind, data: next });
    } else {
      const next = await action.send<IssueDraft>(path, data, options);
      if (next) setDraft({ kind, data: next });
    }
  }

  function finish(message: string) {
    setDraft(undefined);
    setPhoto(undefined);
    setReadPhoto(undefined);
    setAudio(undefined);
    setNotice(message);
  }

  const busy = preparing || action.pending;
  const close = () => { setDraft(undefined); setReadPhoto(undefined); setShowFeedback(false); };
  function choosePhoto(next?: File) {
    if (busy) return;
    setPhoto(next);
    setPhotoError('');
    setNotice('');
    setShowFeedback(false);
  }
  const reviewPhoto = readPhoto && <details className="ai-review-photo">
    <summary><FileImage size={17} aria-hidden="true"/>{t("Xem ảnh để đối chiếu")} <ChevronDown size={17} aria-hidden="true"/></summary>
    <PhotoImage file={readPhoto} alt={t("Ảnh chứng từ dùng để đối chiếu bản nháp")}/>
  </details>;

  return <section className="card ai-workspace" aria-label={t("Đọc và duyệt chứng từ")}>
    {!draft && <header className="ai-workspace-head">
      <span className="ai-icon"><ScanLine size={25} aria-hidden="true"/></span>
      <div>
        <h2>{t("Đọc chứng từ")}</h2>
        <p className="ai-branch"><MapPin size={14} aria-hidden="true"/>{branch.name}</p>
      </div>
    </header>}
    {notice && <p className="success" role="status">{t(notice)}</p>}
    {!draft && <form className="ai-capture" onSubmit={extract} aria-busy={busy}>
      <fieldset className="ai-choice-field" disabled={recording || busy}>
        <legend>{t("Loại chứng từ")}</legend>
        <div className="ai-document-options">
          {documentOptions.filter(option => option.value === 'receive' || (option.value === 'menu' ? usesTables(branch.mode) : role === 'OWNER'))
            .map(({ value, label, Icon }) => <label className="ai-choice ai-document-option" key={value}>
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => {
                setKind(value); choosePhoto(undefined);
                if (value === 'menu') setSource('image');
              }}/>
              <Icon size={20} aria-hidden="true"/><span>{t(label)}</span>
            </label>)}
        </div>
      </fieldset>
      {kind !== 'menu' && <fieldset className="ai-choice-field" disabled={recording || busy}>
        <legend>{t("Nguồn chứng từ")}</legend>
        <div className="ai-source-options">
          {sourceOptions.map(({ value, label, Icon }) => <label className="ai-choice ai-source-option" key={value}>
            <input type="radio" name="source" value={value} checked={source === value} onChange={() => {
              setSource(value); setNotice(''); setPhotoError(''); setShowFeedback(false);
            }}/>
            <Icon size={16} aria-hidden="true"/><span>{t(label)}</span>
          </label>)}
        </div>
      </fieldset>}
      {source === 'image' && <>
        <PhotoInput photo={photo} busy={busy} choose={choosePhoto}
          hint={kind === 'menu' ? t("Chụp rõ tên và giá từng món.") : t("Chụp thẳng, đủ tên hàng và số lượng. Tránh bóng và lóa.")}/>
        {photoError && <p role="alert" className="error">{photoError}</p>}
      </>}
      {source === 'text' && <label>{t("Nội dung chứng từ")}<textarea name="text" maxLength={10000} required rows={6} disabled={busy}
        placeholder={t("Nhập tên hàng, đơn vị, số lượng và đơn giá…")}/></label>}
      {source === 'audio' && <div className="ai-audio">
        <button type="button" className="plain ai-secondary" disabled={busy} onClick={() => void toggleRecording()}>
          {recording ? <Square size={16} aria-hidden="true"/> : <Mic size={17} aria-hidden="true"/>}
          {recording ? t("Dừng ghi âm") : audio ? t("Ghi âm lại") : t("Ghi âm tối đa 1 phút")}
        </button>
        {audio ? <p className="ai-inline-note"><CheckCircle2 size={17} aria-hidden="true"/>{t("Đã có bản ghi âm")}</p> :
          <label>{t("Tải bản ghi (tối đa 4 MB)")}<input name="file" type="file"
            accept={provider === 'gemini' ? '.webm,.m4a,.mp4,.mp3,.wav,.ogg,.aac,.flac' : 'audio/webm,audio/mp4,audio/mpeg,audio/wav,audio/ogg'}
            required disabled={recording || busy}/></label>}
        {recordError && <p role="alert" className="error">{recordError}</p>}
      </div>}
      <footer className="ai-capture-footer">
        <button type="submit" className="button ai-main-action" disabled={recording || busy || (source === 'image' && !photo)}>
          {busy ? <LoaderCircle className="ai-spinner" size={18} aria-hidden="true"/> : <ScanLine size={18} aria-hidden="true"/>}
          {preparing ? t("Đang chuẩn bị ảnh…") : action.pending ? t("Đang đọc chứng từ…") : t("Đọc bằng AI")}
        </button>
        <p className="ai-inline-note"><Info size={15} aria-hidden="true"/>
          <span>{t("Chứng từ được gửi đến")} {providerLabels[provider ?? 'openai']} {t("để tạo bản nháp.")}</span>
        </p>
      </footer>
    </form>}
    {!notice && showFeedback && action.feedback}
    {draft?.kind === 'receive' && <ReviewReceipt draft={draft.data} close={close} done={finish} photo={reviewPhoto}/>}
    {draft?.kind === 'menu' && <ReviewMenu draft={draft.data} close={close} done={finish} photo={reviewPhoto}/>}
    {draft?.kind === 'issue' && <ReviewIssue draft={draft.data} close={close} done={finish} photo={reviewPhoto}/>}
  </section>;
}

function PhotoInput({ photo, busy, choose, hint }: { photo?: File; busy: boolean; choose: (file?: File) => void; hint: string }) {
  const { t } = useLanguage();
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  return <div className="ai-photo-stage" data-selected={!!photo} data-dragging={dragging && !busy}
    onDragOver={event => {
      if (busy || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setDragging(true);
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }}
    onDrop={event => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      if (!busy) choose(event.dataTransfer.files[0]);
    }}>
    {photo ? <div className="ai-selected-photo">
      <div className="ai-photo-thumb"><PhotoImage key={photo.name + photo.lastModified} file={photo} alt={t("Ảnh chứng từ đã chọn")}/></div>
      <div className="ai-selected-file"><strong>{photo.name}</strong><small>{t("Ảnh đã chọn")}</small></div>
      <button type="button" className="icon ai-remove-photo" aria-label={t("Bỏ ảnh đã chọn")} disabled={busy}
        onClick={() => choose(undefined)}><X size={19} aria-hidden="true"/></button>
    </div> : <div className="ai-photo-intro">
      <span className="ai-scan-frame"><FileImage size={27} aria-hidden="true"/></span>
      <div><strong>{t("Chụp hoặc tải ảnh chứng từ")}</strong><p>{hint}</p></div>
    </div>}
    <div className="ai-file-actions">
      {([{ id: 'camera', label: photo ? 'Chụp lại' : 'Chụp ảnh', Icon: Camera },
        { id: 'gallery', label: photo ? 'Đổi ảnh' : 'Chọn từ thư viện', Icon: Images }]).map(({ id, label, Icon }) =>
        <label className={id === 'camera' ? 'ai-file-button ai-file-primary' : 'ai-file-button'} key={id} htmlFor={inputId + id}>
          <Icon size={18} aria-hidden="true"/>{t(label)}
          <input id={inputId + id} type="file" accept="image/*" capture={id === 'camera' ? 'environment' : undefined}
            disabled={busy} onChange={event => {
              const selected = event.currentTarget.files?.[0];
              if (selected) choose(selected);
              event.currentTarget.value = '';
            }}/>
        </label>)}
    </div>
  </div>;
}

function PhotoImage({ file, alt }: { file: File; alt: string }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setFailed(false);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url && !failed ? <img src={url} alt={alt} onError={() => setFailed(true)}/>
    : <FileImage size={24} aria-label={alt}/>;
}
