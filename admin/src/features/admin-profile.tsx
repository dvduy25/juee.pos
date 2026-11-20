import Link from 'next/link';
import { Building2, ClipboardList, CreditCard, UserRound } from 'lucide-react';
import { branchNames, roleNames, auditLabels, dateTime, labels, vnd, type Profile, type Row } from './admin-data';

export function ContractBadge({ row }: { row: Row }) {
  const status = row.effectiveStatus ?? row.status;
  if (!status) return <>—</>;
  return <span className={`badge ${['EXPIRED', 'SUSPENDED', 'CANCELED', 'PENDING'].includes(status) ? 'warning' : ''}`}>
    {row.trial && status === 'ACTIVE' ? 'Đang dùng thử' : labels[status] ?? status}
  </span>;
}

function ContractInfo({ contract }: { contract: Row }) {
  const plan = contract.planVersion;
  const requested = contract.requestedPlanVersion;
  return <>
    <dl className="platform-facts">
      <div><dt>Gói hiện tại</dt><dd>{plan?.plan?.name ?? '—'}{plan && <small>Phiên bản {plan.version}</small>}</dd></div>
      <div><dt>Trạng thái dịch vụ</dt><dd><ContractBadge row={contract}/>{contract.simulated && <small>Đăng ký mô phỏng</small>}</dd></div>
      <div><dt>Bắt đầu</dt><dd>{contract.status === 'PENDING' ? '—' : dateTime(contract.startsAt)}</dd></div>
      <div><dt>Hết hạn</dt><dd>{contract.expiresAt ? dateTime(contract.expiresAt) : contract.status === 'PENDING' ? '—' : 'Không giới hạn'}</dd></div>
      {plan && <div><dt>Hạn mức</dt><dd>{contract.trial ? 1 : plan.maxBranches} chi nhánh · {plan.maxStaff} nhân sự · {plan.maxQrTables} bàn QR</dd></div>}
    </dl>
    {requested && <p className="notice">Đang chờ duyệt gói <strong>{requested.plan?.name}</strong> · {vnd.format(BigInt(requested.monthlyVnd))}/tháng
      {contract.requestedAt && <> · Gửi lúc {dateTime(contract.requestedAt)}</>}.</p>}
    {contract.rejectedRequest && <p className="notice"><strong>Yêu cầu gần nhất đã bị từ chối</strong> · {dateTime(contract.rejectedRequest.rejectedAt)}.
      {' '}{contract.rejectedRequest.reason}</p>}
  </>;
}

export function AdminProfile({ section, profile }: { section: string; profile: Profile }) {
  const isUser = section === 'users';
  const isTenant = section === 'tenants';
  const contract = isTenant ? profile.subscriptions?.[0] : section === 'subscriptions' ? profile : undefined;
  return <div className="platform-profile">
    {isUser && <>
      <dl className="platform-facts">
        <div><dt>Email</dt><dd>{profile.email}<small>{profile.emailVerifiedAt ? `Đã xác minh ${dateTime(profile.emailVerifiedAt)}` : 'Chưa xác minh'}</small></dd></div>
        <div><dt>Điện thoại</dt><dd>{profile.phone ?? '—'}</dd></div>
        <div><dt>Trạng thái tài khoản</dt><dd>{profile.locked ? 'Đã khóa' : 'Hoạt động'}{profile.platformAccount && <small>Quản trị nền tảng</small>}</dd></div>
        <div><dt>Đăng ký</dt><dd>{dateTime(profile.createdAt)}</dd></div>
        <div><dt>Đăng nhập gần nhất</dt><dd>{dateTime(profile.lastLoginAt)}</dd></div>
        <div><dt>Phiên chưa hết hạn</dt><dd>{profile.sessions ?? 0}</dd></div>
      </dl>
      <section><h3><Building2 size={17} aria-hidden="true"/> Doanh nghiệp tham gia</h3>
        {!profile.memberships?.length && <p className="muted">Tài khoản chưa tham gia doanh nghiệp.</p>}
        {profile.memberships?.map(member => member.tenant && <div className="list-row" key={member.id}>
          <Link className="platform-link" href={`/super-admin/tenants?id=${member.tenant.id}`}>{member.tenant.name}</Link>
          <span>{roleNames[member.role ?? ''] ?? member.role}{member.archivedAt ? ' · Đã lưu trữ' : member.disabled ? ' · Đã khóa' : ''}</span>
        </div>)}
      </section>
    </>}
    {isTenant && <>
      <dl className="platform-facts">
        <div><dt>Trạng thái doanh nghiệp</dt><dd>{profile.locked ? 'Đã khóa' : 'Hoạt động'}</dd></div>
        <div><dt>Ngày đăng ký</dt><dd>{dateTime(profile.createdAt)}</dd></div>
        <div><dt>Chi nhánh</dt><dd>{profile._count?.branches ?? 0}</dd></div>
        <div><dt>Thành viên</dt><dd>{profile._count?.memberships ?? 0}</dd></div>
      </dl>
      <section><h3><UserRound size={17} aria-hidden="true"/> Chủ doanh nghiệp</h3>
        {!profile.memberships?.length && <p className="muted">Chưa tìm thấy tài khoản chủ doanh nghiệp.</p>}
        {profile.memberships?.map(({ user }) => user && <div className="list-row" key={user.id}>
          <div><Link className="platform-link" href={`/super-admin/users?id=${user.id}`}>{user.name}</Link>
            <small>{user.email}{user.phone ? ` · ${user.phone}` : ''}</small></div>
          {user.locked && <span className="badge warning">Đã khóa</span>}
        </div>)}
      </section>
      <section><h3><Building2 size={17} aria-hidden="true"/> Chi nhánh</h3>
        {!profile.branches?.length && <p className="muted">Chưa có chi nhánh.</p>}
        {profile.branches?.map(branch => <div className="list-row" key={branch.id}>
          <strong>{branch.name}</strong><span>{branchNames[branch.mode as keyof typeof branchNames] ?? branch.mode}</span>
        </div>)}
      </section>
    </>}
    {contract && <section>
      <h3><CreditCard size={17} aria-hidden="true"/> Gói dịch vụ</h3>
      {profile.tenant?.locked && <p className="notice">Doanh nghiệp đang bị khóa.</p>}
      <ContractInfo contract={contract}/>
      {isTenant && <Link className="platform-link" href={`/super-admin/subscriptions?tenantId=${profile.id}`}>Mở quản lý thuê bao</Link>}
      {!isTenant && profile.tenant && <Link className="platform-link" href={`/super-admin/tenants?id=${profile.tenant.id}`}>Xem doanh nghiệp</Link>}
    </section>}
    {isTenant && !contract && <p className="notice">Doanh nghiệp chưa có thuê bao.</p>}
    {!!profile.transferReviews?.length && <section>
      <h3><CreditCard size={17} aria-hidden="true"/> Chuyển khoản cần đối soát</h3>
      {profile.transferReviews.map(transfer => <div className="list-row" key={transfer.id}>
        <div><strong>{transfer.bankReference ?? transfer.reference}</strong>
          <small>{transfer.reference} · {dateTime(transfer.createdAt)}</small>
          <small>{transfer.reviewReason}</small>
        </div>
        <strong>{vnd.format(transfer.amount)}</strong>
      </div>)}
    </section>}
    {!isUser && <section><h3><CreditCard size={17} aria-hidden="true"/> Lịch sử thực thu</h3>
      {!profile.invoices?.length && <p className="muted">Chưa ghi nhận thanh toán.</p>}
      {profile.invoices?.map(payment => <div className="list-row" key={payment.id}>
        <div><strong>{payment.reference}</strong><small>{dateTime(payment.paidAt)}</small></div>
        <strong>{vnd.format(BigInt(payment.amountVnd))}</strong>
      </div>)}
      {contract && <Link className="platform-link" href={`/super-admin/invoices?subscriptionId=${contract.id}`}>Xem toàn bộ khoản thu</Link>}
    </section>}
    <section><h3><ClipboardList size={17} aria-hidden="true"/> Nhật ký gần đây</h3>
      {!profile.history.length && <p className="muted">Chưa có thao tác quản trị.</p>}
      {profile.history.map(item => <div className="list-row" key={item.id}>
        <div><strong>{auditLabels[item.action] ?? item.action}</strong><small>{item.reason}</small></div>
        <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
      </div>)}
    </section>
  </div>;
}
