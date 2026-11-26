'use client';

import { useLanguage } from '@/i18n/language';
import { useState } from 'react';
import { LocateFixed, MapPin } from 'lucide-react';
import { currentPosition } from '@/lib/location';
import type { BranchLocation } from '@/types/business';

export function readBranchLocation(form: FormData): BranchLocation | undefined {
  const latitude = form.get('latitude');
  const longitude = form.get('longitude');
  if (!latitude && !longitude) return undefined;
  if (!latitude || !longitude) throw new Error('Hãy nhập cả vĩ độ và kinh độ của chi nhánh.');
  return { latitude: Number(latitude), longitude: Number(longitude), radiusMeters: Number(form.get('radiusMeters')) };
}

export function BranchLocationFields({ location, required = false }: { location?: BranchLocation; required?: boolean }) {
  const { t } = useLanguage();
  const [latitude, setLatitude] = useState(location?.latitude.toString() ?? '');
  const [longitude, setLongitude] = useState(location?.longitude.toString() ?? '');
  const [radius, setRadius] = useState(location?.radiusMeters.toString() ?? '100');
  const [map, setMap] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function locate() {
    setPending(true); setError(''); setMap('');
    try {
      const position = await currentPosition();
      setLatitude(position.latitude.toFixed(6));
      setLongitude(position.longitude.toFixed(6));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Chưa lấy được vị trí hiện tại.');
    } finally { setPending(false); }
  }

  const lat = Number(latitude), lng = Number(longitude), meters = Number(radius);
  const validPin = !!latitude && !!longitude && Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180;
  function preview() {
    const latSpan = Math.max(0.001, meters / 111000) * 1.5;
    const lonSpan = latSpan / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const bbox = [Math.max(-180, lng - lonSpan), Math.max(-85.05, lat - latSpan),
      Math.min(180, lng + lonSpan), Math.min(85.05, lat + latSpan)];
    const params = new URLSearchParams({ bbox: bbox.join(','), layer: 'mapnik', marker: `${lat},${lng}` });
    setMap(`https://www.openstreetmap.org/export/embed.html?${params}`);
  }

  return <fieldset className="branch-location">
    <legend><MapPin size={16} aria-hidden="true"/> {t("Vị trí chi nhánh")}</legend>
    <p className="muted">{t("Ghim tại cửa hàng bằng vị trí hiện tại hoặc nhập tọa độ. Bán kính tính từ ghim dùng để kiểm tra khách gọi món QR.")}</p>
    <div className="form-grid form-grid-business">
      <label>{t("Vĩ độ")}<input name="latitude" type="number" step="any" min={-90} max={90} required={required}
        value={latitude} onChange={event => { setLatitude(event.target.value); setMap(''); }}/></label>
      <label>{t("Kinh độ")}<input name="longitude" type="number" step="any" min={-180} max={180} required={required}
        value={longitude} onChange={event => { setLongitude(event.target.value); setMap(''); }}/></label>
      <label>{t("Bán kính (m)")}<input name="radiusMeters" type="number" min={20} max={2000} step={1} required
        value={radius} onChange={event => { setRadius(event.target.value); setMap(''); }}/></label>
    </div>
    <div className="actions business-filters">
      <button className="plain" type="button" onClick={() => void locate()} disabled={pending}><LocateFixed size={17} aria-hidden="true"/>
        {pending ? t("Đang lấy vị trí…") : t("Ghim vị trí hiện tại")}</button>
      <button className="plain" type="button" onClick={preview} disabled={!validPin || pending || Math.abs(lat) >= 85 || meters < 20 || meters > 2000}>
        {t("Xem ghim trên bản đồ")}</button>
    </div>
    {map && <iframe className="branch-location-map" title={t("Ghim vị trí chi nhánh trên OpenStreetMap")} src={map} loading="lazy"/>}
    {error && <p className="error" role="alert">{t(error)}</p>}
  </fieldset>;
}
