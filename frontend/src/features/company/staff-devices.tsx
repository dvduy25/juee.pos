'use client';

import { useState } from 'react';
import { BusinessDialog } from '@/components/business-dialog';
import { Panel, State } from '@/components/business-ui';
import { useAction, useBusiness, useData } from '@/hooks/use-business';
import { submit, value } from '@/lib/format';
import { employeeName, type Employee } from './staff';

const deviceMethods = ['FINGERPRINT', 'CARD', 'FACE'] as const;
export type DeviceMethod = typeof deviceMethods[number];
export const staffClockLabels = { MANUAL: 'Thủ công', FINGERPRINT: 'Vân tay', CARD: 'Thẻ', FACE: 'Khuôn mặt' };
type Device = { id: string; name: string; methods: DeviceMethod[] };
type Credential = { method: DeviceMethod; code: string };

export function StaffDevices() {
  const { branch, root } = useBusiness();
  const devices = useData<Device[]>('/staff-clock-devices');
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<Device>();
  const [created, setCreated] = useState<{ id: string; name: string; key: string; url: string }>();
  const [search, setSearch] = useState('');
  const [employee, setEmployee] = useState<Employee>();
  const employees = useData<Employee[]>(`/staff?branch=${branch.id}&status=active&q=${encodeURIComponent(search)}`);
  return <>
    <Panel title="Máy chấm công" action={<button type="button" className="button" onClick={() => setAdding(true)}>Thêm máy</button>}>
      <State query={devices} empty={devices.data?.length === 0}/>
      {devices.data?.map(device => <div className="list-row" key={device.id}>
        <div><strong>{device.name}</strong><small>{device.methods.map(method => staffClockLabels[method]).join(' · ')}</small></div>
        <button type="button" className="plain" onClick={() => setRevoking(device)}>Thu hồi khóa</button>
      </div>)}
      {created && <div className="notice">
        <strong>{created.name} · Lưu khóa để cấu hình máy hoặc bộ kết nối</strong>
        <label>Địa chỉ gửi chấm công<input readOnly value={created.url} onFocus={event => event.currentTarget.select()}/></label>
        <label>Khóa máy<input readOnly value={created.key} onFocus={event => event.currentTarget.select()}/></label>
        <button type="button" className="plain" onClick={() => setCreated(undefined)}>Đã lưu khóa</button>
      </div>}
    </Panel>
    <Panel title="Liên kết mã nhân viên">
      <label>Tìm nhân viên<input type="search" maxLength={120} value={search} onChange={event => setSearch(event.target.value)}/></label>
      <State query={employees} empty={employees.data?.length === 0}/>
      {employees.data?.map(item => <div className="list-row" key={item.id}>
        <div><strong>{employeeName(item)}</strong>{item.position && <small>{item.position}</small>}</div>
        <button type="button" className="plain" onClick={() => setEmployee(item)}>Liên kết mã</button>
      </div>)}
    </Panel>
    {adding && <AddDevice close={() => setAdding(false)} saved={device => {
      setCreated({ id: device.id, name: device.name, key: device.key, url: `${window.location.origin}/api/v1${root}/staff-clock-events` });
      setAdding(false);
    }}/>}
    {revoking && <RevokeDevice device={revoking} close={() => setRevoking(undefined)} saved={() => {
      if (created?.id === revoking.id) setCreated(undefined);
      setRevoking(undefined);
    }}/>}
    {employee && <StaffCredentials key={employee.id} employee={employee} close={() => setEmployee(undefined)}/>}
  </>;
}

function AddDevice({ close, saved }: { close: () => void; saved: (device: Device & { key: string }) => void }) {
  const action = useAction();
  const [selected, setSelected] = useState<DeviceMethod[]>([]);
  return <BusinessDialog title="Thêm máy chấm công" close={close} pending={action.pending}>
    <form onSubmit={event => submit(event, form => {
      if (!selected.length) return;
      void action.send<Device & { key: string }>('/staff-clock-devices', { name: value(form, 'name'), methods: selected })
        .then(result => { if (result) saved(result); });
    })}>
      <label>Tên máy<input name="name" required maxLength={120} placeholder="Ví dụ: Máy cửa chính"/></label>
      <fieldset><legend>Phương thức máy sử dụng</legend>{deviceMethods.map(method => <label className="check" key={method}>
        <input type="checkbox" checked={selected.includes(method)} onChange={event =>
          setSelected(event.target.checked ? [...selected, method] : selected.filter(item => item !== method))}/>
        {staffClockLabels[method]}
      </label>)}</fieldset>
      <button type="submit" className="button" disabled={action.pending || !selected.length}>Tạo khóa máy</button>
    </form>{action.feedback}
  </BusinessDialog>;
}

function RevokeDevice({ device, close, saved }: { device: Device; close: () => void; saved: () => void }) {
  const action = useAction();
  return <BusinessDialog title="Thu hồi khóa máy" close={close} pending={action.pending}>
    <p>Thu hồi khóa của <strong>{device.name}</strong>? Máy cần khóa mới để gửi lượt chấm công.</p>
    <button type="button" className="button" disabled={action.pending} onClick={() =>
      void action.send(`/staff-clock-devices/${device.id}`, undefined, { method: 'DELETE' }).then(result => { if (result) saved(); })}>
      Xác nhận thu hồi</button>
    {action.feedback}
  </BusinessDialog>;
}

function StaffCredentials({ employee, close }: { employee: Employee; close: () => void }) {
  const action = useAction();
  const path = `/staff-clock-credentials/${employee.id}`;
  const credentials = useData<Credential[]>(path);
  return <BusinessDialog title={`Mã máy · ${employeeName(employee)}`} close={close} pending={action.pending}>
    <State query={credentials}/>
    <p className="muted">Nhập mã người dùng hoặc mã thẻ mà máy gửi cho từng phương thức. Xóa mã rồi lưu để ngắt liên kết.</p>
    {credentials.data && deviceMethods.map(method => {
      const initial = credentials.data?.find(item => item.method === method)?.code ?? '';
      return <form key={`${method}:${initial}`} onSubmit={event => submit(event, form => void action.send(
        `${path}/${method}`, { code: value(form, 'code') || null }, { method: 'PATCH' }))}>
        <div className="actions staff-week">
          <label>{staffClockLabels[method]}<input name="code" defaultValue={initial} autoComplete="off" maxLength={80}/></label>
          <button type="submit" className="plain" disabled={action.pending}>Lưu mã</button>
        </div>
      </form>;
    })}
    {action.feedback}
  </BusinessDialog>;
}
