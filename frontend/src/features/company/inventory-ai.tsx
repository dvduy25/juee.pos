'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { ServicePaymentField } from '@/features/dashboard/service-payment';
import { WarehousePicker } from './warehouse';

type Source = 'text' | 'image' | 'audio';
type Draft = { supplier: string | null; reference: string | null; lines: {
  name: string; unit: string | null; quantity: number | null; unitCost: number | null; taxPercent: number | null;
}[] };

export function InventoryAi() {
  const { branch } = useBusiness();
  const settings = useData<{ configured: boolean }>('/warehouse/ai/settings');
  const action = useAction();
  return <>
    <Panel title="Khóa API của doanh nghiệp">
      <State query={settings}/>
      <p className="muted">Dùng khóa OpenAI của doanh nghiệp. Khóa được mã hóa khi lưu. Ảnh, văn bản hoặc ghi âm được gửi đến OpenAI khi bạn yêu cầu đọc hóa đơn.</p>
      <form onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        void action.send('/warehouse/ai/settings', { apiKey: new FormData(form).get('apiKey') },
          { method: 'PATCH', reset: form, message: 'Đã lưu khóa API.' });
      }}>
        <label>Khóa API OpenAI<input name="apiKey" type="password" autoComplete="off" spellCheck={false} maxLength={305} required/></label>
        <div className="actions"><button type="submit" className="button" disabled={action.pending}>{settings.data?.configured ? 'Thay khóa' : 'Lưu khóa'}</button>
          {settings.data?.configured && <button type="button" className="plain" disabled={action.pending}
            onClick={() => void action.send('/warehouse/ai/settings', undefined, { method: 'DELETE', message: 'Đã xóa khóa API.' })}>Xóa khóa</button>}</div>
      </form>
      {action.feedback}
    </Panel>
    {settings.data?.configured && <InvoiceAssistant key={branch.id}/>}
  </>;
}

function InvoiceAssistant() {
  const action = useAction();
  const [source, setSource] = useState<Source>('image');
  const [direction, setDirection] = useState('in');
  const [draft, setDraft] = useState<Draft>();
  const [draftVersion, setDraftVersion] = useState(0);
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
    data.set('source', source);
    if (source === 'audio' && audio) data.set('file', audio);
    const next = await action.send<Draft>('/warehouse/ai/extract', data, { message: 'Đã tạo phiếu nháp. Kiểm tra từng dòng trước khi ghi kho.' });
    if (next) { setDraft(next); setDraftVersion(value => value + 1); }
  }

  return <Panel title="Tạo phiếu kho từ hóa đơn">
    <form onSubmit={extract}>
      <div className="columns">
        <label>Loại phiếu<select value={direction} onChange={event => { setDirection(event.target.value); setDraft(undefined); }} disabled={action.pending}>
          <option value="in">Nhập kho</option><option value="out">Xuất kho</option>
        </select></label>
        <label>Nguồn hóa đơn<select value={source} onChange={event => setSource(event.target.value as Source)} disabled={recording || action.pending}>
          <option value="image">Chụp hoặc tải ảnh</option><option value="text">Nhập nội dung</option><option value="audio">Ghi âm</option>
        </select></label>
      </div>
      {source === 'image' && <label>Ảnh hóa đơn (tối đa 4 MB)<input name="file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required/></label>}
      {source === 'text' && <label>Nội dung hóa đơn<textarea name="text" maxLength={10000} required rows={5}/></label>}
      {source === 'audio' && <>
        <button type="button" className="plain" disabled={action.pending} onClick={() => void toggleRecording()}>{recording ? 'Dừng ghi âm' : 'Ghi âm tối đa 1 phút'}</button>
        {audio ? <p>Đã có bản ghi âm. Bấm Đọc hóa đơn bằng AI để tiếp tục.</p> :
          <label>Hoặc tải bản ghi (tối đa 4 MB)<input name="file" type="file" accept="audio/webm,audio/mp4,audio/mpeg,audio/wav,audio/ogg" required disabled={recording}/></label>}
        {recordError && <p role="alert" className="error">{recordError}</p>}
      </>}
      <button className="button" disabled={recording || action.pending}>{action.pending ? 'Đang đọc hóa đơn…' : 'Đọc hóa đơn bằng AI'}</button>
    </form>
    {action.feedback}
    {draft && <ReviewInvoice key={draftVersion} draft={draft} inbound={direction === 'in'} close={() => setDraft(undefined)}/>}
  </Panel>;
}

function ReviewInvoice({ draft, inbound, close }: { draft: Draft; inbound: boolean; close: () => void }) {
  const [lines, setLines] = useState(draft.lines.map((line, index) => ({ ...line, index })));
  const action = useAction();

  async function commit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const items = form.getAll('warehouseItemId');
    const quantities = form.getAll('quantity');
    const reference = String(form.get('reference') || '');
    const base = items.map((itemId, index) => ({ itemId, quantity: String(quantities[index]) }));
    const result = inbound
      ? await action.send('/purchases', { supplier: form.get('supplier'), reference: reference || undefined, method: form.get('paymentMethod'),
        lines: base.map((item, index) => ({ ...item, unitCost: Number(form.getAll('unitCost')[index]),
          taxBps: Math.round(Number(form.getAll('tax')[index]) * 100), expiresOn: form.getAll('expiresOn')[index] || undefined })) }, { idempotent: true })
      : await action.send('/warehouse/ai/issue', { note: form.get('note'),
        lines: base.map((item, index) => ({ ...item, revision: Number(form.getAll('revision')[index]) })) }, { idempotent: true });
    if (result) close();
  }

  return <form onSubmit={commit}>
    <h3>{inbound ? 'Duyệt phiếu nhập kho' : 'Duyệt phiếu xuất kho'}</h3>
    <p className="muted">Đối chiếu đơn vị, số lượng và giá trên chứng từ rồi chọn mặt hàng tương ứng trong kho.</p>
    {inbound ? <>
      <div className="columns">
        <label>Nhà cung cấp<input name="supplier" defaultValue={draft.supplier ?? ''} maxLength={120} required/></label>
        <label>Số chứng từ<input name="reference" defaultValue={draft.reference ?? ''} maxLength={120}/></label>
      </div>
      <ServicePaymentField neutral/>
    </> : <label>Lý do xuất và số chứng từ<input name="note" defaultValue={draft.reference ? `Xuất theo chứng từ ${draft.reference}`.slice(0, 120) : ''} maxLength={120} required/></label>}
    {lines.map(line => <InvoiceLine key={line.index} line={line} inbound={inbound}
      remove={lines.length > 1 ? () => setLines(items => items.filter(item => item.index !== line.index)) : undefined}/>)}
    <div className="actions">
      <button type="submit" className="button" disabled={action.pending}>{inbound ? 'Xác nhận nhập kho và ghi chi' : 'Xác nhận xuất kho'}</button>
      <button type="button" className="plain" onClick={close} disabled={action.pending}>Bỏ phiếu nháp</button>
    </div>
    {action.feedback}
  </form>;
}

function InvoiceLine({ line, inbound, remove }: { line: Draft['lines'][number]; inbound: boolean; remove?: () => void }) {
  const [selected, setSelected] = useState<{ revision: number; unit: string }>();
  return <fieldset>
    <legend>{line.name}{line.unit ? ` · ${line.unit}` : ''}</legend>
    <WarehousePicker onSelect={setSelected}/>
    <input type="hidden" name="revision" value={selected?.revision ?? ''}/>
    <div className="form-grid form-grid-business">
      <label>Số lượng{selected ? ` (${selected.unit})` : ''}<input type="number" name="quantity" min="0.001" max="999999999.999" step="0.001" defaultValue={line.quantity ?? ''} required/></label>
      {inbound && <>
        <label>Đơn giá trước thuế (đ)<input type="number" name="unitCost" min="0" max="1000000000000" step="1" defaultValue={line.unitCost ?? ''} required/></label>
        <label>Thuế (%)<input type="number" name="tax" min="0" max="100" step="0.01" defaultValue={line.taxPercent ?? ''} required/></label>
        <label>Hạn sử dụng<input type="date" name="expiresOn"/></label>
      </>}
    </div>
    {remove && <button type="button" className="plain" onClick={remove}>Bỏ dòng</button>}
  </fieldset>;
}
