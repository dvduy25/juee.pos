import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Header, Param, Patch, Post, Query, Req,
  StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { hash } from 'argon2';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { access, logChange, requireModule } from '../middleware/business-access';
import { verifyOrigin } from '../middleware/auth';
import { scopedRoute } from '../routes/branch';
import { found, isDuplicate, localFilter, mongoId } from '../utils/db';
import { accountEmail, accountPassword, label, objectId, read, vnd } from '../validators/common';
import { transaction } from '../config/db';
import { AccountToken, AuditLog, Branch, Customer, HotelBooking, MemberClass, MemberPayment, Membership, Payment, PlatformGrant, Refund, Register,
  Shift, StaffAttendance, StaffClockCredential, StaffDocument, StaffIdentity, StaffSchedule, TicketRefund, TicketSale, User, UserSession, roles } from '../models';
import { pageSchema } from '../validators/sales';
import { reportPeriodQuery, selectedReportRange } from '../validators/reports';
import { activePlan } from '../services/tenants';
import { reportPeriods, revenueRange } from '../services/revenue';
import { branchReport } from '../services/branch-report';
import { accountMailConfigured, requestAccountLink } from '../services/account-email';
import { readStaffImages, saveStaffIdentity, staffUploadFields, staffUploadOptions, type StaffFiles } from '../services/staff-identity';

type Route = { tenantId: string; branchId: string; id: string };
const identifier = (value: string) => read(objectId, value);
const pageQuery = z.object({ page: pageSchema });
const periodQuery = z.object({ period: z.enum(reportPeriods).default('today') });
const reportQuery = reportPeriodQuery.extend({ view: z.literal('company').optional() });
const staffRoles = z.enum(roles).refine(value => value !== 'OWNER');
const assignments = z.array(objectId).min(1).max(100).refine(value => new Set(value).size === value.length);
const staffProfile = z.object({ staffName: label.nullable().optional(), phone: z.string().trim().regex(/^\+?\d{7,15}$/).nullable().optional(),
  position: label.nullable().optional(), specialty: z.string().trim().min(1).max(200).nullable().optional(),
  certifications: z.string().trim().min(1).max(300).nullable().optional() }).strict();

const staffAccount = z.object({ name: label, password: accountPassword }).strict();
const citizenIdInput = z.string().trim().regex(/^\d{12}$/, 'Số CCCD phải có đúng 12 chữ số.');

function staffBody(req: Request, body: unknown) {
  if (!req.is('multipart/form-data')) return body;
  const { profile } = read(z.object({ profile: z.string() }).strict(), body);
  try {
    return JSON.parse(profile) as unknown;
  } catch {
    throw new BadRequestException('Thông tin hồ sơ nhân viên không hợp lệ.');
  }
}

function requireStaffProfileRights(actor: { role: string; branchIds: Types.ObjectId[] }, branchIds: (string | Types.ObjectId)[],
  accountChange: boolean, profile?: { role: string; userId?: Types.ObjectId | null; branchIds: Types.ObjectId[] }) {
  if (actor.role === 'OWNER') return;
  if (accountChange || profile?.userId || profile?.role === 'MANAGER' || profile?.role === 'OWNER') {
    throw new ForbiddenException('Chỉ chủ doanh nghiệp được quản lý tài khoản đăng nhập.');
  }
  const allowed = new Set(actor.branchIds.map(String));
  if (![...branchIds, ...(profile?.branchIds ?? [])].every(id => allowed.has(String(id)))) {
    throw new ForbiddenException('Hồ sơ có cửa hàng hoặc chi nhánh ngoài phạm vi bạn được giao.');
  }
}

async function prepareAccount(email: string | undefined, account: z.output<typeof staffAccount> | undefined) {
  if (!account || !email) return undefined;
  return { email, name: account.name, passwordHash: await hash(account.password),
    emailVerificationRequired: accountMailConfigured() };
}

async function linkedAccount(email: string, prepared: Awaited<ReturnType<typeof prepareAccount>>, tenantId: Types.ObjectId, session: ClientSession) {
  if (prepared) {
    if (await User.exists({ email }).session(session)) throw new ConflictException('Email đã có tài khoản. Hãy chọn Dùng tài khoản có sẵn.');
    return (await User.insertOne({ ...prepared, managedByTenantId: tenantId }, { session }))._id;
  }
  const user = await User.findOneAndUpdate({ email, locked: { $ne: true } }, { $set: { tenantWriteToken: randomUUID() } },
    { session, timestamps: false }).select('_id').lean();
  return found(user, 'Không tìm thấy tài khoản JUEE đang hoạt động.')._id;
}

type ManagerAccount = { _id: Types.ObjectId; userId: Types.ObjectId; managedByTenantId?: Types.ObjectId | null };

async function resettableManagers(tenantId: Types.ObjectId, managers: ManagerAccount[], session?: ClientSession) {
  const legacy = managers.filter(item => !item.managedByTenantId).map(item => item._id);
  const verifiedLegacy = legacy.length ? await AuditLog.distinct('targetId', { tenantId, targetId: { $in: legacy },
    action: { $in: ['STAFF_ADD', 'STAFF_UPDATE'] }, 'details.createdAccount': true }).session(session ?? null) : [];
  const verifiedIds = new Set(verifiedLegacy.map(String));
  const managed = managers.filter(item => item.managedByTenantId ? item.managedByTenantId.equals(tenantId) : verifiedIds.has(String(item._id)));
  if (!managed.length) return new Set<string>();
  const ids = managed.map(item => item.userId);
  const shared = await Membership.distinct('userId', { userId: { $in: ids }, tenantId: { $ne: tenantId } }).session(session ?? null);
  const admins = await PlatformGrant.distinct('userId', { userId: { $in: ids } }).session(session ?? null);
  const protectedIds = new Set([...shared, ...admins].map(String));
  return new Set(managed.filter(item => !protectedIds.has(String(item.userId))).map(item => String(item._id)));
}

async function accountResult<T extends { userId?: Types.ObjectId | null }>(profile: T, prepared: Awaited<ReturnType<typeof prepareAccount>>) {
  if (!prepared?.emailVerificationRequired || !profile.userId) return profile;
  const verificationSent = await requestAccountLink({ id: String(profile.userId), email: prepared.email }, 'VERIFY_EMAIL').catch(() => false);
  return { ...profile, verificationRequired: true, verificationSent };
}

async function removeFutureShifts(tenantId: Types.ObjectId, membershipId: Types.ObjectId, session: ClientSession, branches?: string[]) {
  const scope = { tenantId, membershipId, ...(branches && { branchId: { $nin: branches } }) };
  if (await StaffAttendance.exists({ ...scope, status: 'OPEN' }).session(session)) {
    throw new ConflictException('Hãy check-out cho nhân viên tại chi nhánh có ca chấm công đang mở trước.');
  }
  const now = new Date();
  return StaffSchedule.updateMany({ ...scope, startsAt: { $gte: now }, canceledAt: null },
    { $set: { canceledAt: now } }, { session });
}

async function releaseFutureClasses(tenantId: Types.ObjectId, instructorId: Types.ObjectId, session: ClientSession, branches?: string[]) {
  await MemberClass.updateMany({ tenantId, instructorId, canceledAt: null, startsAt: { $gt: new Date() },
    ...(branches && { branchId: { $nin: branches } }) }, { $unset: { instructorId: 1, instructor: 1 } }, { session });
}

@Controller(scopedRoute)
export class OperationsController {
  @Get('customers')
  async customers(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope } = await access(req, route.tenantId, route.branchId, 'customers.manage');
    const { q, page } = read(pageQuery.extend({ q: z.string().trim().max(80).optional() }), query);
    const filter = q ? localFilter(q) : undefined;
    return Customer.find({ tenantId: scope.tenantId, ...(filter ? { $or: [{ name: filter }, { phone: filter }] } : {}) })
      .sort('name _id').skip((page - 1) * 50).limit(50).lean();
  }

  @Post('customers')
  async customer(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.object({ name: label, phone: z.string().trim().regex(/^\+?\d{7,15}$/) }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'customers.manage', session);
      const item = await Customer.insertOne({ tenantId: scope.tenantId, ...input }, { session });
      await logChange(scope, actorId, 'CUSTOMER_CREATE', item._id, session);
      return item.toObject();
    });
  }

  @Get('staff')
  async staff(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const { page, q, branch, status, role, accountActions } = read(pageQuery.extend({ q: z.string().trim().max(120).optional(), branch: objectId.optional(),
      status: z.enum(['active', 'disabled']).optional(), role: z.enum(roles).optional(), accountActions: z.literal('true').optional() }), query);
    if (membership.role !== 'OWNER' && branch && !scope.branchId.equals(branch)) throw new ForbiddenException();
    const branchId = membership.role === 'OWNER' ? branch && mongoId(branch) : scope.branchId;
    const match = q ? localFilter(q) : undefined;
    const includeActions = accountActions === 'true' && membership.role === 'OWNER';
    const items = await Membership.aggregate<{ _id: Types.ObjectId; role: string; userId?: Types.ObjectId;
      user?: { name: string; email: string; locked?: boolean; managedByTenantId?: Types.ObjectId } }>([
      { $match: { tenantId: scope.tenantId, archivedAt: null, ...(role && { role }),
        ...(branchId ? { $or: [{ branchIds: branchId }, ...(membership.role === 'OWNER' ? [{ role: 'OWNER' }] : [])] } : {}),
        ...(status ? { disabled: status === 'disabled' ? true : { $ne: true } } : {}) } },
      { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id',
        pipeline: [{ $project: { _id: 0, name: 1, email: 1, locked: 1, ...(includeActions && { managedByTenantId: 1 }) } }], as: 'user' } },
      { $set: { user: { $first: '$user' } } },
      ...(match ? [{ $match: { $or: [{ staffName: match }, { position: match }, { specialty: match },
        { 'user.name': match }, { 'user.email': match }] } }] : []),
      ...(membership.role === 'OWNER' ? [] : [{ $set: {
        canEditProfile: { $and: [{ $ne: ['$role', 'MANAGER'] }, { $eq: [{ $ifNull: ['$userId', null] }, null] },
          { $setIsSubset: ['$branchIds', membership.branchIds] }] },
        branchIds: { $setIntersection: ['$branchIds', membership.branchIds] },
      } }]),
      { $sort: { role: 1, _id: 1 } }, { $skip: (page - 1) * 50 }, { $limit: 50 },
    ]);
    if (!includeActions) return items;
    const eligible = await resettableManagers(scope.tenantId, items.flatMap(item => item.role === 'MANAGER' && item.user && !item.user.locked && item.userId ?
      [{ _id: item._id, userId: item.userId, managedByTenantId: item.user.managedByTenantId }] : []));
    return items.map(({ user, ...item }) => ({ ...item, ...(user && { user: { name: user.name, email: user.email, locked: user.locked } }),
      canResetPassword: eligible.has(String(item._id)) }));
  }

  @Post('staff')
  @UseInterceptors(FileFieldsInterceptor(staffUploadFields, staffUploadOptions))
  async addStaff(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @UploadedFiles() files?: StaffFiles) {
    const { email, role, branchIds, account, citizenId, ...profile } = read(staffProfile.extend({
      email: accountEmail.optional(), role: staffRoles, branchIds: assignments, account: staffAccount.optional(), citizenId: citizenIdInput.optional(),
    }).strict(), staffBody(req, body));
    if (role === 'MANAGER' ? !email : (!!email || !!account || !profile.staffName)) {
      throw new BadRequestException(role === 'MANAGER' ? 'Hãy nhập email đăng nhập của quản lý.' :
        'Hãy nhập họ tên nhân viên. Chỉ quản lý được cấp tài khoản đăng nhập.');
    }
    const accountChange = role === 'MANAGER' || !!account || !!email;
    if (accountChange) await access(req, route.tenantId, route.branchId, 'staff.manage');
    if (!citizenId) throw new BadRequestException('Hãy nhập số CCCD của nhân viên.');
    const images = readStaffImages(files);
    const avatar = images.avatar;
    if (!avatar) throw new BadRequestException('Hãy chọn ảnh đại diện của nhân viên.');
    const prepared = await prepareAccount(email, account);
    const member = await transaction(async session => {
      const { scope, actorId, membership } = await access(req, route.tenantId, route.branchId, 'staff.profiles', session);
      requireStaffProfileRights(membership, branchIds, accountChange);
      const plan = await activePlan(scope.tenantId, session, true);
      if (await Membership.countDocuments({ tenantId: scope.tenantId, role: { $ne: 'OWNER' }, disabled: { $ne: true } }).session(session) >= (plan.maxStaff ?? 0)) {
        throw new ConflictException('Đã đạt giới hạn nhân viên của gói.');
      }
      if (await Branch.countDocuments({ tenantId: scope.tenantId, _id: { $in: branchIds } }).session(session) !== branchIds.length) throw new ForbiddenException();
      const userId = email ? await linkedAccount(email, prepared, scope.tenantId, session) : undefined;
      const previous = userId ? await Membership.findOne({ tenantId: scope.tenantId, userId }).session(session) : null;
      if (previous && !previous.archivedAt) {
        throw new ConflictException('Tài khoản đã có hồ sơ trong doanh nghiệp. Hãy sửa hồ sơ đó.');
      }
      const item = previous ?? new Membership({ tenantId: scope.tenantId, userId });
      item.set({ staffName: undefined, phone: undefined, position: undefined, specialty: undefined, certifications: undefined,
        ...profile, role, branchIds: branchIds.map(mongoId), archivedAt: undefined, disabled: false, staffAvatarVersion: avatar.version });
      await item.save({ session });
      await saveStaffIdentity(scope, item._id, { ...images, citizenId }, session);
      await logChange(scope, actorId, 'STAFF_ADD', item._id, session, { role, branchIds, createdAccount: !!prepared });
      return item.toObject();
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tài khoản đã được cấp quyền hoặc dữ liệu vừa thay đổi. Hãy tải lại danh sách.');
      throw error;
    });
    return accountResult(member, prepared);
  }

  @Patch('staff/:id')
  @UseInterceptors(FileFieldsInterceptor(staffUploadFields, staffUploadOptions))
  async updateStaff(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @UploadedFiles() files?: StaffFiles) {
    const id = identifier(route.id);
    const images = readStaffImages(files);
    const { email, account, citizenId, removeDocumentIds, ...input } = read(staffProfile.extend({ role: staffRoles.optional(), branchIds: assignments.optional(),
      disabled: z.boolean().optional(), email: accountEmail.optional(), account: staffAccount.optional(), citizenId: citizenIdInput.optional(),
      removeDocumentIds: z.array(objectId).max(8).optional() })
      .strict().refine(value => !!images.avatar || images.documents.length > 0 || Object.keys(value).length > 0), staffBody(req, body));
    if (account && !email) throw new BadRequestException('Hãy nhập email đăng nhập.');
    if (account) await access(req, route.tenantId, route.branchId, 'staff.manage');
    const prepared = await prepareAccount(email, account);
    const updated = await transaction(async session => {
      const { scope, actorId, membership } = await access(req, route.tenantId, route.branchId, 'staff.profiles', session);
      const filter = { tenantId: scope.tenantId, _id: id, archivedAt: null, role: { $ne: 'OWNER' as const } };
      const member = found(await Membership.findOne(filter).session(session).lean());
      const role = input.role ?? member.role;
      requireStaffProfileRights(membership, input.branchIds ?? [], role === 'MANAGER' || !!email || !!account, member);
      if (role === 'MANAGER' && member.role !== 'MANAGER') {
        if (!citizenId && !await StaffIdentity.exists({ tenantId: scope.tenantId, membershipId: member._id, citizenId: { $type: 'string' } }).session(session)) {
          throw new BadRequestException('Hãy bổ sung số CCCD trước khi cấp quyền quản lý.');
        }
        if (!images.avatar && !member.staffAvatarVersion) throw new BadRequestException('Hãy bổ sung ảnh đại diện trước khi cấp quyền quản lý.');
      }
      if (email && role !== 'MANAGER') throw new BadRequestException('Chỉ quản lý được cấp tài khoản đăng nhập.');
      if (email && member.userId) throw new ConflictException('Hồ sơ đã liên kết với một tài khoản.');
      const userId = email ? await linkedAccount(email, prepared, scope.tenantId, session) : member.userId;
      if (role === 'MANAGER' && !userId) throw new BadRequestException('Hãy cấp tài khoản đăng nhập cho quản lý.');
      if (!userId && !(input.staffName === undefined ? member.staffName : input.staffName)) {
        throw new BadRequestException('Hãy nhập họ tên nhân viên.');
      }
      if (email && userId && await Membership.exists({ tenantId: scope.tenantId, userId, _id: { $ne: member._id } }).session(session)) {
        throw new ConflictException('Tài khoản đã liên kết với hồ sơ khác trong doanh nghiệp.');
      }
      if (input.branchIds && await Branch.countDocuments({ tenantId: scope.tenantId, _id: { $in: input.branchIds } }).session(session) !== input.branchIds.length) throw new ForbiddenException();
      if (input.disabled === false && member.disabled) {
        const plan = await activePlan(scope.tenantId, session, true);
        if (await Membership.countDocuments({ tenantId: scope.tenantId, role: { $ne: 'OWNER' }, disabled: { $ne: true } }).session(session) >= (plan.maxStaff ?? 0)) {
          throw new ConflictException('Đã đạt giới hạn nhân viên của gói.');
        }
      }
      const branchIds = input.branchIds;
      const removedBranches = branchIds && member.branchIds.some(branchId => !branchIds.includes(String(branchId)));
      if (input.disabled || removedBranches) {
        await removeFutureShifts(scope.tenantId, member._id, session, input.disabled ? undefined : branchIds);
        await StaffClockCredential.deleteMany({ tenantId: scope.tenantId, membershipId: member._id,
          ...(!input.disabled && { branchId: { $nin: branchIds } }) }).session(session);
      }
      if (member.role === 'COACH') {
        if (input.disabled || (input.role && input.role !== 'COACH')) await releaseFutureClasses(scope.tenantId, member._id, session);
        else if (removedBranches) await releaseFutureClasses(scope.tenantId, member._id, session, branchIds);
      }
      await saveStaffIdentity(scope, member._id, { ...images, citizenId, removeDocumentIds }, session);
      const updated = found(await Membership.findOneAndUpdate(filter, { $set: { ...input, ...(email && { userId }),
        ...(images.avatar && { staffAvatarVersion: images.avatar.version }) } }, { session, returnDocument: 'after', runValidators: true }).lean());
      await logChange(scope, actorId, 'STAFF_UPDATE', updated._id, session, { ...input, createdAccount: !!prepared });
      return updated;
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tài khoản vừa được liên kết với hồ sơ khác.');
      throw error;
    });
    return accountResult(updated, prepared);
  }

  @Get('staff/:id/avatar')
  @Header('Cache-Control', 'private, no-store')
  async staffAvatar(@Req() req: Request, @Param() route: Route) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.schedule');
    const member = found(await Membership.findOne({ _id: identifier(route.id), tenantId: scope.tenantId, archivedAt: null,
      ...(membership.role !== 'OWNER' && { branchIds: scope.branchId }) }).select('staffAvatarVersion').lean(), 'Không tìm thấy hồ sơ.');
    const record = await StaffIdentity.findOne({ tenantId: scope.tenantId, membershipId: member._id })
      .select('avatar.contentType +avatar.bytes');
    const avatar = found(record?.avatar, 'Hồ sơ chưa có ảnh đại diện.');
    return new StreamableFile(avatar.bytes, { type: avatar.contentType, length: avatar.bytes.length });
  }

  @Get('staff/:id/identity')
  @Header('Cache-Control', 'private, no-store')
  async staffIdentity(@Req() req: Request, @Param() route: Route) {
    const filter = await this.staffIdentityScope(req, route);
    const [identity, documents] = await Promise.all([
      StaffIdentity.findOne(filter).select('citizenId').lean(), StaffDocument.find(filter).select('name').sort('_id').lean(),
    ]);
    return { citizenId: identity?.citizenId, documents };
  }

  @Get('staff/:id/documents/:documentId')
  @Header('Cache-Control', 'private, no-store')
  async staffDocument(@Req() req: Request, @Param() route: Route & { documentId: string }) {
    const filter = await this.staffIdentityScope(req, route);
    const document = found(await StaffDocument.findOne({ ...filter, _id: identifier(route.documentId) })
      .select('contentType +bytes'), 'Không tìm thấy ảnh giấy tờ.');
    return new StreamableFile(document.bytes, { type: document.contentType, length: document.bytes.length });
  }

  private async staffIdentityScope(req: Request, route: Route) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'staff.profiles');
    const member = found(await Membership.findOne({ _id: identifier(route.id), tenantId: scope.tenantId,
      role: { $ne: 'OWNER' }, archivedAt: null }).select('role branchIds userId').lean(), 'Không tìm thấy hồ sơ.');
    requireStaffProfileRights(membership, [], false, member);
    return { tenantId: scope.tenantId, membershipId: member._id };
  }

  @Post('staff/:id/reset-password')
  async resetManagerPassword(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    verifyOrigin(req);
    const id = identifier(route.id);
    const { password } = read(z.object({ password: accountPassword }).strict(), body);
    await access(req, route.tenantId, route.branchId, 'staff.manage');
    const passwordHash = await hash(password);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'staff.manage', session);
      const manager = found(await Membership.findOne({ tenantId: scope.tenantId, _id: id, role: 'MANAGER', archivedAt: null })
        .select('userId').session(session).lean(), 'Không tìm thấy tài khoản quản lý trong doanh nghiệp.');
      if (!manager.userId || manager.userId.equals(actorId)) throw new ForbiddenException('Chọn tài khoản quản lý do doanh nghiệp cấp.');
      const user = found(await User.findOneAndUpdate({ _id: manager.userId, locked: { $ne: true } },
        { $set: { tenantWriteToken: randomUUID() } }, { session, timestamps: false }).select('+managedByTenantId').lean(),
      'Tài khoản quản lý không còn hoạt động.');
      const eligible = await resettableManagers(scope.tenantId, [{ _id: manager._id, userId: user._id, managedByTenantId: user.managedByTenantId }], session);
      if (!eligible.has(id)) throw new ForbiddenException('Chỉ đặt lại mật khẩu tài khoản quản lý do doanh nghiệp này cấp và chỉ dùng tại đây.');
      await User.updateOne({ _id: user._id }, { $set: { passwordHash } }, { session });
      await UserSession.deleteMany({ userId: user._id }, { session });
      await AccountToken.deleteMany({ userId: user._id, kind: 'RESET_PASSWORD' }, { session });
      await logChange(scope, actorId, 'STAFF_PASSWORD_RESET', manager._id, session);
      return { ok: true };
    });
  }

  @Delete('staff/:id')
  async archiveStaff(@Req() req: Request, @Param() route: Route) {
    const id = identifier(route.id);
    return transaction(async session => {
      const { scope, actorId, membership } = await access(req, route.tenantId, route.branchId, 'staff.profiles', session);
      const member = found(await Membership.findOne({ tenantId: scope.tenantId, _id: id, role: { $ne: 'OWNER' }, archivedAt: null })
        .session(session), 'Không tìm thấy nhân viên.');
      requireStaffProfileRights(membership, [], false, member);
      await removeFutureShifts(scope.tenantId, member._id, session);
      await StaffClockCredential.deleteMany({ tenantId: scope.tenantId, membershipId: member._id }).session(session);
      if (member.role === 'COACH') await releaseFutureClasses(scope.tenantId, member._id, session);
      member.set({ disabled: true, archivedAt: new Date() });
      await member.save({ session });
      await logChange(scope, actorId, 'STAFF_ARCHIVE', member._id, session);
      return { id };
    });
  }

  @Get('registers')
  async registers(@Req() req: Request, @Param() route: Route) {
    const { scope, actorId, membership } = await access(req, route.tenantId, route.branchId, 'registers.read');
    await requireModule(scope, 'registers');
    const registers = await Register.find(scope).sort('name').lean();
    if (membership.role !== 'CASHIER') return registers;
    const owned = await Shift.find({ ...scope, openedBy: actorId, status: 'OPEN' }).select('_id').lean();
    const byId = new Set(owned.map(item => String(item._id)));
    return registers.map(item => ({ ...item, ownShift: !!item.shiftId && byId.has(String(item.shiftId)) }));

  }

  @Post('registers')
  async register(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.object({ name: label }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'registers.manage', session);
      await requireModule(scope, 'registers', session);
      const item = await Register.insertOne({ ...scope, ...input }, { session });
      await logChange(scope, actorId, 'REGISTER_CREATE', item._id, session);
      return item.toObject();
    });
  }

  @Get('shifts')
  async shifts(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership, actorId } = await access(req, route.tenantId, route.branchId, 'shifts.manage');
    await requireModule(scope, 'registers');
    const { page } = read(pageQuery, query);
    return Shift.find({ ...scope, ...(membership.role === 'CASHIER' ? { openedBy: actorId } : {}) }).sort('-createdAt').skip((page - 1) * 50).limit(50).lean();
  }

  @Post('shifts')
  async openShift(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.object({ registerId: objectId, openingCash: vnd }).strict(), body);
    return transaction(async session => {
      const { scope, actorId } = await access(req, route.tenantId, route.branchId, 'shifts.manage', session);
      await requireModule(scope, 'registers', session);
      const register = found(await Register.findOne({ ...scope, _id: input.registerId }).session(session));
      if (register.shiftId) throw new ConflictException('Quầy đã mở ca.');
      const shift = await Shift.insertOne({ ...scope, ...input, openedBy: actorId, status: 'OPEN' }, { session });
      register.shiftId = shift._id;
      await register.save({ session });
      await logChange(scope, actorId, 'SHIFT_OPEN', shift._id, session);
      return shift.toObject();
    });
  }

  @Post('shifts/:id/close')
  async closeShift(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = identifier(route.id);
    const { closingCash } = read(z.object({ closingCash: vnd }).strict(), body);
    return transaction(async session => {
      const { scope, actorId, membership } = await access(req, route.tenantId, route.branchId, 'shifts.manage', session);
      await requireModule(scope, 'registers', session);
      const shift = found(await Shift.findOne({ ...scope, _id: id, status: 'OPEN' }).session(session));
      if (membership.role === 'CASHIER' && String(shift.openedBy) !== actorId) throw new ForbiddenException();
      const [total] = await Payment.aggregate<{ amount: number }>([
        { $match: { ...scope, shiftId: shift._id, method: 'CASH' } }, { $group: { _id: null, amount: { $sum: '$amount' } } },
      ]).session(session);
      shift.cashSales = total?.amount ?? 0;
      shift.cashDifference = closingCash - shift.openingCash - shift.cashSales;
      shift.closingCash = closingCash;
      shift.closedBy = mongoId(actorId);
      shift.closedAt = new Date();
      shift.status = 'CLOSED';
      await shift.save({ session });
      await Register.updateOne({ ...scope, _id: shift.registerId, shiftId: shift._id }, { $unset: { shiftId: 1 } }, { session });
      await logChange(scope, actorId, 'SHIFT_CLOSE', shift._id, session);
      return shift.toObject();
    });
  }

  @Get('reports')
  async report(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { period, view, on } = read(reportQuery, query);
    const { scope } = await access(req, route.tenantId, route.branchId, view ? 'company.report' : 'reports.view');
    return branchReport(scope, selectedReportRange(period, on), period);
  }

  @Get('company/revenue')
  async companyRevenue(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, membership } = await access(req, route.tenantId, route.branchId, 'company.revenue');
    const { period } = read(periodQuery, query);
    const branches = await Branch.find({ tenantId: scope.tenantId, ...(membership.role !== 'OWNER' && { _id: { $in: membership.branchIds } }) })
      .select('name mode').sort('name _id').lean();
    const branchFilter = { tenantId: scope.tenantId, branchId: { $in: branches.map(branch => branch._id) } };
    const range = revenueRange(period);
    const sumByBranch = { $group: { _id: '$branchId', amount: { $sum: '$amount' } } };
    type Total = { _id: unknown; amount: number };
    const [payments, refunds, stays, tickets, ticketRefunds, memberships] = await Promise.all([
      Payment.aggregate<{ _id: unknown; amount: number }>([{ $match: { ...branchFilter, paidAt: range } }, sumByBranch]),
      Refund.aggregate<{ _id: unknown; amount: number }>([{ $match: { ...branchFilter, createdAt: range } }, sumByBranch]),
      HotelBooking.aggregate<Total>([{ $match: { ...branchFilter, status: 'CHECKED_OUT', paidAt: range } }, sumByBranch]),
      TicketSale.aggregate<Total>([{ $match: { ...branchFilter, paidAt: range } }, sumByBranch]),
      TicketRefund.aggregate<Total>([{ $match: { ...branchFilter, createdAt: range } }, sumByBranch]),
      MemberPayment.aggregate<Total>([{ $match: { ...branchFilter, paidAt: range } }, sumByBranch]),
    ]);
    const cashIn = new Map<string, number>();
    for (const row of [...payments, ...stays, ...tickets, ...memberships]) {
      const id = String(row._id);
      cashIn.set(id, (cashIn.get(id) ?? 0) + row.amount);
    }
    const cashOut = new Map<string, number>();
    for (const row of [...refunds, ...ticketRefunds]) {
      const id = String(row._id);
      cashOut.set(id, (cashOut.get(id) ?? 0) + row.amount);
    }
    const rows = branches.map(branch => {
      const gross = cashIn.get(String(branch._id)) ?? 0;
      const refunded = cashOut.get(String(branch._id)) ?? 0;
      return { ...branch, gross, refunded, revenue: gross - refunded };
    });
    const gross = rows.reduce((sum, row) => sum + row.gross, 0);
    const refunded = rows.reduce((sum, row) => sum + row.refunded, 0);
    return { gross, refunded, revenue: gross - refunded, branches: rows };
  }
}
