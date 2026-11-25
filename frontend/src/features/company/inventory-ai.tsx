'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Camera, Images } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { usesTables } from '@/types/business';
import { ReviewIssue, ReviewMenu, ReviewReceipt, type IssueDraft, type MenuDraft, type ReceiptDraft } from './inventory-ai-review';

type Source = 'text' | 'image' | 'audio';
type Kind = 'receive' | 'issue' | 'menu';
type Draft = { kind: 'receive'; data: ReceiptDraft } | { kind: 'issue'; data: IssueDraft } | { kind: 'menu'; data: MenuDraft };
type AiProvider = 'openai' | 'gemini';
type AiSettings = { configured: boolean; provider?: AiProvider; available?: Record<AiProvider, boolean> };
const providerLabels = { openai: 'OpenAI', gemini: 'Gemini' };
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
  const { branch, role } = useBusiness();
  const query = useSearchParams();
  const initial = query.get('document') === 'menu' && usesTables(branch.mode) ? 'menu' : 'receive';
  const settings = useData<AiSettings>('/warehouse/ai/settings');
  const provider = settings.data?.provider;
  return <>
    {settings.data?.configured && <InvoiceAssistant key={branch.id + initial} initial={initial} provider={provider}/>}
    {role === 'OWNER' ? <Panel title="Khóa API của doanh nghiệp">
      <State query={settings}/>
      {settings.data && <ProviderSettings key={branch.id} settings={settings.data}/>}
    </Panel> : !settings.data?.configured && <Panel title="Trợ lý kho AI">
      <State query={settings} />
      {settings.data && <p>Chủ doanh nghiệp cần cài khóa API và chọn nhà cung cấp để bật tính năng này.</p>}
    </Panel>}
  </>;
}

function ProviderSettings({ settings }: { settings: AiSettings }) {
  const action = useAction();
  const [provider, setProvider] = useState<AiProvider>(settings.provider ?? 'openai');
  const saved = settings.available?.[provider] ?? settings.configured;
  const active = settings.configured && (settings.provider ?? 'openai') === provider;
  const name = providerLabels[provider];
  const submitLabel = active ? 'Thay khóa' : `Sử dụng ${name}`;
  const path = '/warehouse/ai/settings';

  return <>
    <p className="muted">Khóa API riêng của doanh nghiệp được mã hóa khi lưu.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const apiKey = String(new FormData(form).get('apiKey') ?? '').trim() || undefined;
      void action.send(path, { ...(settings.provider ? { provider } : {}), apiKey },
        { method: 'PATCH', reset: form, message: `Đang dùng ${name} để đọc chứng từ.` });
    }}>
      <label>Nhà cung cấp AI<select value={provider} disabled={action.pending} onChange={event => setProvider(event.target.value as AiProvider)}>
        <option value="openai">OpenAI{settings.provider === 'openai' && settings.configured ? ' · Đang dùng' : ''}</option>
        {settings.available && <option value="gemini">Google Gemini{settings.provider === 'gemini' && settings.configured ? ' · Đang dùng' : ''}</option>}
      </select></label>
      <details className="ai-key-guide" open={!saved}>
        <summary>Cách lấy khóa API {name}</summary>
        <ol>
          {provider === 'gemini' ? <>
            <li>Mở <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">trang API Keys của Google AI Studio</a> và đăng nhập Google.</li>
            <li>Bấm <strong>Create API key</strong>, chọn dự án rồi sao chép toàn bộ khóa bằng <strong>Copy key</strong>.</li>
          </> : <>
            <li>Mở <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">trang API Keys của OpenAI</a> và đăng nhập.</li>
            <li>Bấm <strong>Create new secret key</strong>, chọn dự án rồi sao chép khóa ngay khi được hiển thị.</li>
          </>}
          <li>Quay lại JUEE POS, dán khóa vào ô <strong>Khóa API {name}</strong> và bấm <strong>{submitLabel}</strong>.</li>
        </ol>
      </details>
      <label>Khóa API {name}<input key={provider} name="apiKey" type="password" autoComplete="off" spellCheck={false}
        maxLength={305} placeholder={saved ? 'Đã lưu khóa' : undefined} required={!saved || active} disabled={action.pending}/></label>
      <div className="actions">
        <button type="submit" className="button" disabled={action.pending}>{submitLabel}</button>
        {saved && <button type="button" className="plain" disabled={action.pending} onClick={() => {
          void action.send(settings.provider ? `${path}?provider=${provider}` : path, undefined,
            { method: 'DELETE', message: `Đã xóa khóa API ${name}.` });
        }}>Xóa khóa</button>}
      </div>
    </form>
    {action.feedback}
  </>;
}

function InvoiceAssistant({ initial, provider }: { initial: 'receive' | 'menu'; provider?: AiProvider }) {
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
  const photoId = useId();
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
  return <Panel title="Đọc chứng từ bằng AI">
    {notice && <p className="success" role="status">{notice}</p>}
    {!draft && <form onSubmit={extract}>
      <p className="muted">Chứng từ sẽ được gửi đến {providerLabels[provider ?? 'openai']} để đọc khi bạn bấm <strong>Đọc bằng AI</strong>.</p>
      <div className="columns">
        <label>Loại chứng từ<select value={kind} onChange={event => {
          const next = event.target.value as Kind;
          setKind(next); setNotice(''); setPhoto(undefined); setPhotoError(''); setShowFeedback(false);
          if (next === 'menu') setSource('image');
        }} disabled={recording || busy}>
          <option value="receive">Hóa đơn nhập hàng</option>
          {usesTables(branch.mode) && <option value="menu">Thực đơn</option>}
          {role === 'OWNER' && <option value="issue">Phiếu xuất kho</option>}
        </select></label>
        {kind !== 'menu' && <label>Nguồn hóa đơn<select value={source} onChange={event => {
          setSource(event.target.value as Source); setNotice(''); setPhotoError(''); setShowFeedback(false);
        }} disabled={recording || busy}>
          <option value="image">Ảnh</option><option value="text">Nhập nội dung</option><option value="audio">Ghi âm</option>
        </select></label>}
      </div>
      {source === 'image' && <>
        <div className="actions ai-photo-actions">
          {([{ id: 'camera', label: 'Chụp ảnh', Icon: Camera }, { id: 'gallery', label: 'Chọn từ thư viện', Icon: Images }]).map(({ id, label, Icon }) =>
            <label className="plain ai-photo-button" key={id} htmlFor={photoId + id}>
              <Icon size={17} aria-hidden="true"/>{label}
              <input id={photoId + id} type="file" accept="image/*" capture={id === 'camera' ? 'environment' : undefined}
                disabled={busy} onChange={event => {
                  const selected = event.currentTarget.files?.[0];
                  if (selected) { setPhoto(selected); setPhotoError(''); setNotice(''); setShowFeedback(false); }
                  event.currentTarget.value = '';
                }}/>
            </label>)}
        </div>
        {photo ? <p>Ảnh đã chọn <strong>{photo.name}</strong></p>
          : <p className="muted">Chụp đủ các cột, giữ ảnh thẳng và tránh bóng hoặc lóa.</p>}
        {photoError && <p role="alert" className="error">{photoError}</p>}
      </>}
      {source === 'text' && <label>Nội dung hóa đơn<textarea name="text" maxLength={10000} required rows={5}/></label>}
      {source === 'audio' && <>
        <button type="button" className="plain" disabled={busy} onClick={() => void toggleRecording()}>{recording ? 'Dừng ghi âm' : 'Ghi âm tối đa 1 phút'}</button>
        {audio ? <p>Đã có bản ghi âm. Bấm Đọc bằng AI để tiếp tục.</p> :
          <label>Hoặc tải bản ghi (tối đa 4 MB)<input name="file" type="file"
            accept={provider === 'gemini' ? '.webm,.m4a,.mp4,.mp3,.wav,.ogg,.aac,.flac' : 'audio/webm,audio/mp4,audio/mpeg,audio/wav,audio/ogg'}
            required disabled={recording || busy}/></label>}
        {recordError && <p role="alert" className="error">{recordError}</p>}
      </>}
      <button className="button" disabled={recording || busy || (source === 'image' && !photo)}>
        {preparing ? 'Đang chuẩn bị ảnh…' : action.pending ? 'Đang đọc…' : 'Đọc bằng AI'}
      </button>
    </form>}
    {!notice && showFeedback && action.feedback}
    {draft && readPhoto && <PhotoPreview file={readPhoto}/>}
    {draft?.kind === 'receive' && <ReviewReceipt draft={draft.data} close={close} done={finish}/>}
    {draft?.kind === 'menu' && <ReviewMenu draft={draft.data} close={close} done={finish}/>}
    {draft?.kind === 'issue' && <ReviewIssue draft={draft.data} close={close} done={finish}/>}
  </Panel>;
}

function PhotoPreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <details className="business-details ai-photo-preview">
    <summary>Xem ảnh để đối chiếu</summary>
    {url && <img src={url} alt="Ảnh chứng từ dùng để đối chiếu bản nháp"/>}
  </details>;
}
