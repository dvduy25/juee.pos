'use client';

import { useLanguage } from '@/i18n/language';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, submit, value } from '@/lib/format';
import { roomNextHourRate, roomStates, type HotelPackage, type Room } from '@/lib/hotel';

export function HotelSettings() {
  const { t } = useLanguage();
  const { branch } = useBusiness();
  const rooms = useData<Room[]>('/hotel-rooms');
  const packages = useData<HotelPackage[]>('/hotel-packages?view=manage');
  const [room, setRoom] = useState<Room | 'new'>();
  const [plan, setPlan] = useState<HotelPackage | 'new'>();
  return <div className="service-workspace">
    <Panel title={`Danh sách phòng · ${branch.name}`} action={<button className="button" type="button" onClick={() => setRoom('new')}>
      <Plus size={17}/> {t("Thêm phòng")}</button>}>
      <State query={rooms} empty={rooms.data?.length === 0}/>
      {rooms.data?.map(item => <div className="list-row service-list-row" key={item.id}>
        <div><strong>{item.code} · {item.category}</strong><small>{t("Tối đa")} {item.capacity} {t("khách ·")} {item.occupiedBy?.overdue ? t("Quá giờ") : item.occupiedBy ? t("Đang có khách") : roomStates[item.state]}</small>
          {item.hourlyRate != null && <small>{t("Giờ đầu")} {currency.format(item.hourlyRate)}</small>}
          <small>{t("Mỗi giờ tiếp theo / quá giờ")} {currency.format(roomNextHourRate(item))}</small>
          {item.nightlyRate != null && <small>{currency.format(item.nightlyRate)}{t("/đêm")}</small>}</div>
        <button type="button" className="plain" onClick={() => setRoom(item)}>{t("Sửa phòng")}</button>
      </div>)}
    </Panel>
    <Panel title={t("Gói lưu trú")} action={<button className="button" type="button" onClick={() => setPlan('new')}><Plus size={17}/> {t("Thêm gói")}</button>}>
      <State query={packages} empty={packages.data?.length === 0}/>
      {packages.data?.map(item => <div className="list-row service-list-row" key={item.id}>
        <div><strong>{item.name}</strong><small>{item.durationHours} {t("giờ ·")} {currency.format(item.price)} · {item.active ? t("Đang áp dụng") : t("Đã ngừng")}</small></div>
        <button type="button" className="plain" onClick={() => setPlan(item)}>{t("Sửa gói")}</button>
      </div>)}
    </Panel>
    {room && <RoomEditor room={room === 'new' ? undefined : room} close={() => setRoom(undefined)}/>}
    {plan && <PackageEditor plan={plan === 'new' ? undefined : plan} close={() => setPlan(undefined)}/>}
  </div>;
}

function RoomEditor({ room, close }: { room?: Room; close: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  return <BusinessDialog title={room ? `Sửa phòng ${room.code}` : t("Thêm phòng")} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      void action.send(room ? `/hotel-rooms/${room.id}` : '/hotel-rooms', {
        code: value(form, 'code'), category: value(form, 'category'), capacity: amount(form, 'capacity'),
        hourlyRate: value(form, 'hourlyRate') ? amount(form, 'hourlyRate') : null,
        hourlyNextRate: value(form, 'hourlyNextRate') ? amount(form, 'hourlyNextRate') : null,
        nightlyRate: value(form, 'nightlyRate') ? amount(form, 'nightlyRate') : null,
        ...(room && { state: room.occupiedBy ? room.state : value(form, 'state') }),
      }, { method: room ? 'PATCH' : 'POST' }).then(saved => { if (saved) close(); });
    })}>
      <div className="columns">
        <label>{t("Mã phòng")}<input name="code" defaultValue={room?.code} maxLength={30} required/></label>
        <label>{t("Hạng phòng")}<input name="category" defaultValue={room?.category} maxLength={120} required/></label>
      </div>
      <label>{t("Sức chứa")}<input name="capacity" type="number" min={1} max={100} defaultValue={room?.capacity ?? 2} required/></label>
      <div className="columns">
        <label>{t("Giá giờ đầu (đ)")}<input name="hourlyRate" type="number" min={0} max={1000000000000} defaultValue={room?.hourlyRate ?? undefined}/></label>
        <label>{t("Giá mỗi giờ tiếp theo (đ)")}<input name="hourlyNextRate" type="number" min={0} max={1000000000000} defaultValue={room?.hourlyNextRate ?? undefined}/></label>
        <label>{t("Giá một đêm (đ)")}<input name="nightlyRate" type="number" min={0} max={1000000000000} defaultValue={room?.nightlyRate ?? undefined}/></label>
      </div>
      <small>{t("Giá giờ tiếp theo cũng áp dụng khi quá giờ theo đêm hoặc theo gói. Để trống ô này thì dùng giá giờ đầu, hoặc 0 ₫ nếu phòng chưa có giá giờ đầu.")}</small>
      {room && <label>{t("Trạng thái")}<select name="state" defaultValue={room.state} disabled={!!room.occupiedBy}>
        {Object.entries(roomStates).map(([state, text]) => <option key={state} value={state}>{text}</option>)}
      </select></label>}
      <button type="submit" className="button" disabled={action.pending}>{t("Lưu phòng")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function PackageEditor({ plan, close }: { plan?: HotelPackage; close: () => void }) {
  const { t } = useLanguage();
  const action = useAction();
  return <BusinessDialog title={plan ? t("Sửa gói lưu trú") : t("Thêm gói lưu trú")} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      void action.send(plan ? `/hotel-packages/${plan.id}` : '/hotel-packages', {
        name: value(form, 'name'), durationHours: amount(form, 'durationHours'), price: amount(form, 'price'), active: form.has('active'),
      }, { method: plan ? 'PATCH' : 'POST' }).then(saved => { if (saved) close(); });
    })}>
      <label>{t("Tên gói")}<input name="name" defaultValue={plan?.name} placeholder={t("Ví dụ: Gói qua đêm")} maxLength={120} required/></label>
      <div className="columns">
        <label>{t("Thời lượng (giờ)")}<input name="durationHours" type="number" min={1} max={8760} defaultValue={plan?.durationHours} required/></label>
        <label>{t("Giá trọn gói (đ)")}<input name="price" type="number" min={0} max={1000000000000} defaultValue={plan?.price} required/></label>
      </div>
      <label className="check"><input name="active" type="checkbox" defaultChecked={plan?.active ?? true}/> {t("Áp dụng khi đặt phòng")}</label>
      <button type="submit" className="button" disabled={action.pending}>{t("Lưu gói")}</button>
    </form>{action.feedback}
  </BusinessDialog>;
}
