'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { amount, currency, submit, value } from '@/lib/format';
import { roomNextHourRate, roomStates, type HotelPackage, type Room } from '@/lib/hotel';

export function HotelSettings() {
  const { branch } = useBusiness();
  const rooms = useData<Room[]>('/hotel-rooms');
  const packages = useData<HotelPackage[]>('/hotel-packages?view=manage');
  const [room, setRoom] = useState<Room | 'new'>();
  const [plan, setPlan] = useState<HotelPackage | 'new'>();
  return <div className="service-workspace">
    <Panel title={`Danh sách phòng · ${branch.name}`} action={<button className="button" type="button" onClick={() => setRoom('new')}>
      <Plus size={17}/> Thêm phòng</button>}>
      <State query={rooms} empty={rooms.data?.length === 0}/>
      {rooms.data?.map(item => <div className="list-row service-list-row" key={item.id}>
        <div><strong>{item.code} · {item.category}</strong><small>Tối đa {item.capacity} khách · {item.occupiedBy?.overdue ? 'Quá giờ' : item.occupiedBy ? 'Đang có khách' : roomStates[item.state]}</small>
          {item.hourlyRate != null && <small>Giờ đầu {currency.format(item.hourlyRate)}</small>}
          <small>Mỗi giờ tiếp theo / quá giờ {currency.format(roomNextHourRate(item))}</small>
          {item.nightlyRate != null && <small>{currency.format(item.nightlyRate)}/đêm</small>}</div>
        <button type="button" className="plain" onClick={() => setRoom(item)}>Sửa phòng</button>
      </div>)}
    </Panel>
    <Panel title="Gói lưu trú" action={<button className="button" type="button" onClick={() => setPlan('new')}><Plus size={17}/> Thêm gói</button>}>
      <State query={packages} empty={packages.data?.length === 0}/>
      {packages.data?.map(item => <div className="list-row service-list-row" key={item.id}>
        <div><strong>{item.name}</strong><small>{item.durationHours} giờ · {currency.format(item.price)} · {item.active ? 'Đang áp dụng' : 'Đã ngừng'}</small></div>
        <button type="button" className="plain" onClick={() => setPlan(item)}>Sửa gói</button>
      </div>)}
    </Panel>
    {room && <RoomEditor room={room === 'new' ? undefined : room} close={() => setRoom(undefined)}/>}
    {plan && <PackageEditor plan={plan === 'new' ? undefined : plan} close={() => setPlan(undefined)}/>}
  </div>;
}

function RoomEditor({ room, close }: { room?: Room; close: () => void }) {
  const action = useAction();
  return <BusinessDialog title={room ? `Sửa phòng ${room.code}` : 'Thêm phòng'} close={close} pending={action.pending}>
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
        <label>Mã phòng<input name="code" defaultValue={room?.code} maxLength={30} required/></label>
        <label>Hạng phòng<input name="category" defaultValue={room?.category} maxLength={120} required/></label>
      </div>
      <label>Sức chứa<input name="capacity" type="number" min={1} max={100} defaultValue={room?.capacity ?? 2} required/></label>
      <div className="columns">
        <label>Giá giờ đầu (đ)<input name="hourlyRate" type="number" min={0} max={1000000000000} defaultValue={room?.hourlyRate ?? undefined}/></label>
        <label>Giá mỗi giờ tiếp theo (đ)<input name="hourlyNextRate" type="number" min={0} max={1000000000000} defaultValue={room?.hourlyNextRate ?? undefined}/></label>
        <label>Giá một đêm (đ)<input name="nightlyRate" type="number" min={0} max={1000000000000} defaultValue={room?.nightlyRate ?? undefined}/></label>
      </div>
      <small>Giá giờ tiếp theo cũng áp dụng khi quá giờ theo đêm hoặc theo gói. Để trống ô này thì dùng giá giờ đầu, hoặc 0 ₫ nếu phòng chưa có giá giờ đầu.</small>
      {room && <label>Trạng thái<select name="state" defaultValue={room.state} disabled={!!room.occupiedBy}>
        {Object.entries(roomStates).map(([state, text]) => <option key={state} value={state}>{text}</option>)}
      </select></label>}
      <button type="submit" className="button" disabled={action.pending}>Lưu phòng</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function PackageEditor({ plan, close }: { plan?: HotelPackage; close: () => void }) {
  const action = useAction();
  return <BusinessDialog title={plan ? 'Sửa gói lưu trú' : 'Thêm gói lưu trú'} close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      void action.send(plan ? `/hotel-packages/${plan.id}` : '/hotel-packages', {
        name: value(form, 'name'), durationHours: amount(form, 'durationHours'), price: amount(form, 'price'), active: form.has('active'),
      }, { method: plan ? 'PATCH' : 'POST' }).then(saved => { if (saved) close(); });
    })}>
      <label>Tên gói<input name="name" defaultValue={plan?.name} placeholder="Ví dụ: Gói qua đêm" maxLength={120} required/></label>
      <div className="columns">
        <label>Thời lượng (giờ)<input name="durationHours" type="number" min={1} max={8760} defaultValue={plan?.durationHours} required/></label>
        <label>Giá trọn gói (đ)<input name="price" type="number" min={0} max={1000000000000} defaultValue={plan?.price} required/></label>
      </div>
      <label className="check"><input name="active" type="checkbox" defaultChecked={plan?.active ?? true}/> Áp dụng khi đặt phòng</label>
      <button type="submit" className="button" disabled={action.pending}>Lưu gói</button>
    </form>{action.feedback}
  </BusinessDialog>;
}
