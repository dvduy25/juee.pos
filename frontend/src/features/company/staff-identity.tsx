'use client';

import { useLanguage } from '@/i18n/language';
import { useQuery } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useBusiness } from '@/hooks/use-business';
import { api, apiBlob } from '@/services/api-client';

const imageTypes = 'image/jpeg,image/png,image/webp';
type StaffDocument = { id: string; name: string };
type StaffIdentity = { citizenId?: string; documents: StaffDocument[] };

export function useStaffIdentity(id?: string) {
  const { root } = useBusiness();
  return useQuery({ queryKey: ['staff-identity', root, id], queryFn: () => api<StaffIdentity>(`${root}/staff/${id}/identity`),
    enabled: !!id, gcTime: 0 });
}

function useImageUrl(image?: Blob) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!image) { setUrl(''); return; }
    const next = URL.createObjectURL(image);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image]);
  return url;
}

export function StaffAvatar({ id, version }: { id?: string; version?: string }) {
  const { root } = useBusiness();
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const photo = useQuery({ queryKey: ['staff-avatar', root, id, version], queryFn: () => apiBlob(`${root}/staff/${id}/avatar`),
    enabled: !!id && !!version && visible, staleTime: 60_000, gcTime: 60_000, retry: false });
  const src = useImageUrl(photo.data);
  useEffect(() => {
    if (!ref.current || !version || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisible(true);
    }, { rootMargin: '120px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [version, visible]);
  return <span ref={ref} className="member-avatar" aria-hidden="true">
    {src ? <img src={src} alt=""/> : <UserRound size={22}/>}
  </span>;
}

export function StaffIdentityFields({ id, version, identity, required }: {
  id?: string; version?: string; identity?: StaffIdentity; required: boolean;
}) {
  const { t } = useLanguage();
  const [avatar, setAvatar] = useState<File>();
  const preview = useImageUrl(avatar);
  return <fieldset className="staff-identity-fields">
    <legend>{t("CCCD và ảnh hồ sơ")}</legend>
    <label>{t("Số CCCD")}<input name="citizenId" type="text" inputMode="numeric" autoComplete="off" maxLength={12} pattern="[0-9]{12}"
      title={t("Nhập 12 chữ số trên CCCD")} required={required} defaultValue={identity?.citizenId}/></label>
    <div className="staff-identity-avatar">
      {preview ? <span className="member-avatar"><img src={preview} alt={t("Ảnh đại diện đã chọn")}/></span> : <StaffAvatar id={id} version={version}/>}
      <label>{version ? t("Thay ảnh đại diện") : t("Ảnh đại diện")}
        <input name="avatar" type="file" accept={imageTypes} required={required && !version} onChange={event => setAvatar(event.target.files?.[0])}/></label>
    </div>
    <label>{t("Ảnh giấy tờ (nếu có)")}<input name="documents" type="file" accept={imageTypes} multiple/>
      <small>{t("JPG, PNG hoặc WebP. Tối đa 8 ảnh giấy tờ mỗi hồ sơ, 4 MB mỗi ảnh và 8 MB mỗi lần lưu.")}</small></label>
    {id && identity?.documents.map(document => <StaffDocumentRow key={document.id} staffId={id} document={document}/>)}
  </fieldset>;
}

function StaffDocumentRow({ staffId, document }: { staffId: string; document: StaffDocument }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return <div className="staff-document-row">
    <div className="list-row"><strong>{document.name}</strong><div className="actions">
      <button type="button" className="plain" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t("Ẩn ảnh") : t("Xem ảnh")}</button>
      <label className="check"><input name="removeDocumentId" type="checkbox" value={document.id}/> {t("Xóa khi lưu")}</label>
    </div></div>
    {open && <StaffDocumentPreview staffId={staffId} document={document}/>}
  </div>;
}

function StaffDocumentPreview({ staffId, document }: { staffId: string; document: StaffDocument }) {
  const { t } = useLanguage();
  const { root } = useBusiness();
  const image = useQuery({ queryKey: ['staff-document', root, staffId, document.id],
    queryFn: () => apiBlob(`${root}/staff/${staffId}/documents/${document.id}`), gcTime: 0, retry: false });
  const src = useImageUrl(image.data);
  if (image.error) return <p className="error" role="alert">{image.error.message}</p>;
  return src ? <img className="staff-document-preview" src={src} alt={document.name}/> : <p className="muted" role="status">{t("Đang tải ảnh…")}</p>;
}
