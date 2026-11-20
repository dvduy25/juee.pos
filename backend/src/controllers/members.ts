import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Header, Headers, Param, Patch, Post, Query, Req,
  StreamableFile, UnauthorizedException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { signingSecret } from '../middleware/auth';
import { access, logChange, type Scope } from '../middleware/business-access';
import { Branch, FacilityMember, MemberClass, MemberCredential, MemberPayment, MemberPlan, Membership, MemberVisit, Tenant, User, memberBranchModes, memberCheckInMethods,
  memberCredentialMethods, memberKioskMethods, memberPlanKinds, recordedPaymentMethods, type BranchMode } from '../models';
import { scopedRoute } from '../routes/branch';
import { transaction } from '../config/db';
import { found, isDuplicate, localFilter, mongoId } from '../utils/db';
import { label, objectId, read, vnd } from '../validators/common';
import { amount, pageSchema } from '../validators/sales';
import { facilityToday, memberAccessStates, memberAccessStatus, membershipStatusExpression, memberPlanDaysRemaining, nextMemberEnrollment, shiftDays } from '../services/membership-plans';
import { isStayDate } from '../services/hotel-stays';
import { idempotent } from '../services/sales';
import { activeSubscription } from '../services/tenants';
import { productImageLimits, readProductImage } from '../services/product-image';

const memberInput = z.object({ name: label, phone: z.string().trim().regex(/^\+?\d{7,15}$/, 'Số điện thoại không hợp lệ.') }).strict();
const paymentInput = z.object({ method: z.enum(recordedPaymentMethods), expectedAmount: amount }).strict();
const enrollmentPayment = paymentInput.extend({ method: paymentInput.shape.method.optional(), expectedAmount: vnd })
  .refine(({ method, expectedAmount }) => Boolean(method) === (expectedAmount > 0), 'Hãy chọn phương thức đã nhận tiền cho gói tính phí.');
const planInput = z.object({ name: label, kind: z.enum(memberPlanKinds), units: z.number().int().min(1).max(100000),
  price: vnd.default(0), validityMonths: z.number().int().min(1).max(120).nullable().default(null), active: z.boolean().default(true) })
  .strict().refine(plan => plan.kind !== 'MONTH' || plan.units <= 120, 'Gói tháng tối đa 120 tháng.')
  .refine(plan => plan.kind !== 'DAY' || plan.units <= 3650, 'Gói ngày tối đa 3650 ngày.')
  .refine(plan => plan.kind === 'VISITS' || plan.validityMonths === null, 'Hạn dùng theo tháng dành cho gói lượt.');
const credentialCode = z.string().trim().regex(/^[!-~]{1,80}$/, 'Mã chỉ gồm chữ, số hoặc ký tự in được, tối đa 80 ký tự.');
const credentialMethod = z.enum(memberCredentialMethods);
const checkInInput = z.object({ method: z.enum(memberCheckInMethods), code: credentialCode }).strict();
const methodSettings = z.object({ methods: z.array(z.enum(memberCheckInMethods)).max(memberCheckInMethods.length)
  .refine(items => new Set(items).size === items.length) }).strict();
const classDateTime = z.string().datetime({ offset: true }).transform(value => new Date(value));
const classInput = z.object({ name: label, instructor: z.string().trim().max(120).optional(), instructorId: objectId.optional(),
  startsAt: classDateTime, endsAt: classDateTime, capacity: z.number().int().min(1).max(100) }).strict();
const classAttendance = z.object({ attended: z.boolean() }).strict();
type CheckIn = z.output<typeof checkInInput>;
type Route = { tenantId: string; branchId: string; id: string };

function requireFacility(mode: BranchMode) {
  if (!memberBranchModes.includes(mode)) throw new ConflictException('Quản lý hội viên dành cho phòng gym và bể bơi.');
}

async function classInstructor(scope: Scope, instructorId: string, startsAt: Date, endsAt: Date, session: ClientSession, excludeId?: Types.ObjectId) {
  const coach = found(await Membership.findOne({ tenantId: scope.tenantId, _id: instructorId, role: 'COACH', branchIds: scope.branchId,
    disabled: { $ne: true }, archivedAt: null }).session(session).lean(), 'Huấn luyện viên chưa được phân công tại chi nhánh này.');
  const user = !coach.staffName && coach.userId ? await User.findById(coach.userId).select('name').session(session).lean() : null;
  if (await MemberClass.exists({ tenantId: scope.tenantId, instructorId: coach._id, canceledAt: null,
    startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt }, ...(excludeId && { _id: { $ne: excludeId } }) }).session(session)) {
    throw new ConflictException('Huấn luyện viên đã có lớp khác trùng giờ.');
  }
  return { instructorId: coach._id, instructor: coach.staffName ?? user?.name ?? 'Huấn luyện viên' };
}

function legacyCode(id: unknown) {
  return `HV-${String(id).toUpperCase()}`;
}

function memberConflict(error: unknown): never {
  if (isDuplicate(error)) throw new ConflictException('Số điện thoại hoặc mã hội viên đã được sử dụng tại chi nhánh.');
  throw error;
}

function memberBody(req: Request, body: unknown) {
  if (!req.is('multipart/form-data')) return body;
  const { member } = read(z.object({ member: z.string() }).strict(), body);
  try {
    return JSON.parse(member) as unknown;
  } catch {
    throw new BadRequestException('Thông tin hội viên không hợp lệ.');
  }
}

async function activeMemberPlan(scope: Scope, planId: string, session: ClientSession) {
  return found(await MemberPlan.findOne({ ...scope, _id: planId, active: true }).session(session).lean(),
    'Gói đã ngừng sử dụng hoặc không tồn tại.');
}

type PaymentMember = { id: Types.ObjectId; name: string };
type EnrollmentFee = { planId: Types.ObjectId; planName: string; price?: number | null };

async function recordMemberPayment(scope: Scope, member: PaymentMember,
  enrollment: EnrollmentFee, payment: z.output<typeof paymentInput>,
  actorId: string, paidAt: Date, session: ClientSession) {
  if (enrollment.price !== payment.expectedAmount) throw new ConflictException('Giá gói vừa thay đổi. Hãy kiểm tra lại số tiền.');
  return MemberPayment.insertOne({ ...scope, memberId: member.id, memberName: member.name, planId: enrollment.planId,
    planName: enrollment.planName, actorId, amount: payment.expectedAmount, method: payment.method, paidAt }, { session });
}

function collectEnrollmentFee(scope: Scope, member: PaymentMember, enrollment: EnrollmentFee,
  payment: z.output<typeof enrollmentPayment> | undefined, actorId: string, paidAt: Date, session: ClientSession) {
  if (!payment) return;
  if (payment.method) return recordMemberPayment(scope, member, enrollment, { ...payment, method: payment.method }, actorId, paidAt, session);
  if (enrollment.price) throw new ConflictException('Giá gói vừa thay đổi. Hãy kiểm tra lại số tiền.');
}

async function memberPhoto(scope: Scope, memberId: string | Types.ObjectId) {
  const member = found(await FacilityMember.findOne({ ...scope, _id: memberId, 'photo.version': { $exists: true } })
    .select('photo.contentType +photo.bytes'), 'Hội viên chưa có ảnh.');
  const photo = found(member.photo);
  return new StreamableFile(photo.bytes, { type: photo.contentType, length: photo.bytes.length });
}

const keyHash = (value: string) => createHash('sha256').update(value).digest('hex');
const kioskPhotoProof = (visitId: string, digest: string) =>
  createHmac('sha256', signingSecret()).update(`member-kiosk-photo:${visitId}:${digest}`).digest();
const automatedKeys = {
  DEVICE: { field: 'memberCheckInKeyHash', prefix: 'juee-checkin-' },
  KIOSK: { field: 'memberKioskKeyHash', prefix: 'juee-kiosk-' },
} as const;
type AutomatedSource = keyof typeof automatedKeys;

function enabledMethods(methods?: readonly string[] | null) {
  return memberCheckInMethods.filter(method => methods == null || methods.includes(method));
}

function requireMethod(methods: readonly string[] | null | undefined, method: CheckIn['method']) {
  if (!enabledMethods(methods).includes(method)) throw new ForbiddenException('Phương thức này đang tắt tại phòng.');
}

async function authorizeAutomatedCheckIn(route: Pick<Route, 'tenantId' | 'branchId'>, authorization: string | undefined, source: AutomatedSource) {
  const { field, prefix } = automatedKeys[source];
  const token = authorization?.match(/^Bearer (juee-(?:checkin|kiosk)-[a-f0-9]{64})$/)?.[1];
  if (!token?.startsWith(prefix)) throw new UnauthorizedException('Khóa check-in chưa được thiết lập hoặc đã hết hiệu lực.');
  const scope = { tenantId: mongoId(read(objectId, route.tenantId)), branchId: mongoId(read(objectId, route.branchId)) };
  const digest = keyHash(token);
  const branchFilter = { tenantId: scope.tenantId, _id: scope.branchId, mode: { $in: memberBranchModes }, [field]: digest };
  const tenantFilter = { _id: scope.tenantId, locked: { $ne: true } };
  const branch = await Branch.findOne(branchFilter).select('name mode memberCheckInMethods').lean();
  if (!branch || !await Tenant.exists(tenantFilter)) throw new UnauthorizedException('Khóa check-in chưa được thiết lập hoặc đã hết hiệu lực.');
  await activeSubscription(scope.tenantId);
  return { scope, branch, branchFilter, tenantFilter, digest };
}

async function automatedCheckIn(auth: Awaited<ReturnType<typeof authorizeAutomatedCheckIn>>, source: AutomatedSource, key: string | undefined, input: CheckIn) {
  requireMethod(auth.branch.memberCheckInMethods, input.method);
  const { scope, branchFilter, tenantFilter } = auth;
  return idempotent(scope, source === 'KIOSK' ? 'MEMBER_KIOSK_CHECK_IN' : 'MEMBER_DEVICE_CHECK_IN', key, input, async session => {
    await activeSubscription(scope.tenantId, session, true);
    const enabledTenant = await Tenant.updateOne(tenantFilter, { $set: { branchWriteToken: randomUUID() } }, { session });
    const branch = await Branch.findOneAndUpdate(branchFilter, { $set: { writeToken: randomUUID() } }, { session, returnDocument: 'after' })
      .select('memberCheckInMethods').lean();
    if (!enabledTenant.matchedCount || !branch) throw new UnauthorizedException();
    requireMethod(branch.memberCheckInMethods, input.method);
    const visit = await checkInMember(scope, session, input, source);
    return { id: visit._id, createdAt: visit.createdAt, remaining: visit.remaining,
      ...(source === 'KIOSK' && { progress: visit.progress }),
      ...(source === 'KIOSK' && visit.photoVersion && { photoProof: kioskPhotoProof(String(visit._id), auth.digest).toString('hex') }) };
  });
}

async function checkInMember(scope: Scope, session: ClientSession, identity: { id: string } | CheckIn, source: 'STAFF' | AutomatedSource, actorId?: string) {
  const method = 'method' in identity ? identity.method : 'MEMBER_CODE';
  let memberFilter;
  if ('id' in identity) {
    memberFilter = { _id: identity.id };
  } else if (identity.method === 'MEMBER_CODE') {
    const code = identity.code.toUpperCase();
    const legacy = code.match(/^HV-([A-F0-9]{24})$/)?.[1];
    memberFilter = legacy ? { _id: legacy, code: { $exists: false } } : { code };
  } else {
    const credential = found(await MemberCredential.findOne({ ...scope, method: identity.method, code: identity.code }).select('memberId')
      .session(session).lean(), 'Mã này chưa liên kết với hội viên tại chi nhánh.');
    memberFilter = { _id: credential.memberId };
  }
  const member = found(await FacilityMember.findOne({ ...scope, ...memberFilter }).session(session), 'Không tìm thấy hội viên.');
  const now = new Date();
  const today = facilityToday(now.getTime());
  const status = memberAccessStatus(member, today);
  if (status !== 'ACTIVE') {
    const messages = { PAUSED: 'Hội viên đang tạm dừng.', FROZEN: 'Gói hội viên đang bảo lưu.', NO_PLAN: 'Hội viên chưa được gán gói.',
      PENDING: 'Gói hội viên chưa bắt đầu.', NO_VISITS: 'Gói hội viên đã hết lượt.', EXPIRED: 'Gói hội viên đã hết hạn.' };
    throw new ConflictException(messages[status]);
  }
  if (await MemberVisit.exists({ ...scope, memberId: member._id, createdAt: { $gte: new Date(now.getTime() - 60_000) } }).session(session)) {
    throw new ConflictException('Hội viên vừa check-in trong vòng 1 phút.');
  }
  const [history] = await MemberVisit.aggregate<{ first: string; latest: string; days: number }>([
    { $match: { ...scope, memberId: member._id, createdAt: { $lte: now } } },
    { $group: { _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: 'Asia/Ho_Chi_Minh' } } } },
    { $group: { _id: null, first: { $min: '$_id' }, latest: { $max: '$_id' }, days: { $sum: 1 } } },
  ]).session(session);
  if (member.enrollment?.kind === 'VISITS') {
    member.enrollment.remaining = (member.enrollment.remaining ?? 0) - 1;
    await member.save({ session });
  }
  const expiresOn = member.enrollment?.expiresOn ?? member.expiresOn;
  const progress = {
    registeredOn: member.createdAt ? facilityToday(member.createdAt.getTime()) : undefined,
    firstVisitedOn: history?.first ?? today,
    attendedDays: (history?.days ?? 0) + (history?.latest === today ? 0 : 1),
    expiresOn: expiresOn ?? undefined,
    remainingDays: memberPlanDaysRemaining(expiresOn, today),
  };
  const visit = await MemberVisit.insertOne({ ...scope, actorId, method, source, memberId: member._id, memberName: member.name,
    planName: member.enrollment?.planName ?? member.plan, remaining: member.enrollment?.remaining, progress, createdAt: now }, { session });
  return { ...visit.toObject(), progress, photoVersion: member.photo?.version };
}

@Controller(scopedRoute)
export class MembersController {
  @Get('member-classes')
  async classes(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'member-classes.read');
    requireFacility(branch.mode);
    const { day, page } = read(z.object({ day: z.string().refine(isStayDate).default(facilityToday()), page: pageSchema }), query);
    return MemberClass.find({ ...scope, startsAt: {
      $gte: new Date(`${day}T00:00:00+07:00`), $lt: new Date(`${shiftDays(day, 14)}T00:00:00+07:00`),
    } }).sort('startsAt _id').skip((page - 1) * 50).limit(50).lean();
  }

  @Get('member-class-coaches')
  async coaches(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.write');
    requireFacility(branch.mode);
    return Membership.aggregate([
      { $match: { tenantId: scope.tenantId, role: 'COACH', branchIds: scope.branchId, disabled: { $ne: true }, archivedAt: null } },
      { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id',
        pipeline: [{ $project: { name: 1 } }], as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { name: { $ifNull: ['$staffName', '$user.name', 'Huấn luyện viên'] }, specialty: 1 } },
      { $sort: { name: 1, _id: 1 } },
    ]);
  }

  @Post('member-classes')
  async createClass(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const input = read(classInput, body);
    const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write');
    requireFacility(branch.mode);
    return idempotent(scope, 'MEMBER_CLASS_CREATE', key, { ...input, actorId }, async session => {
      const current = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(current.branch.mode);
      if (input.startsAt <= new Date() || input.endsAt <= input.startsAt || +input.endsAt - +input.startsAt > 86_400_000) {
        throw new BadRequestException('Chọn thời gian lớp sắp tới, kết thúc sau khi bắt đầu và tối đa 24 giờ.');
      }
      const { instructorId, ...fields } = input;
      const instructor = instructorId ? await classInstructor(scope, instructorId, input.startsAt, input.endsAt, session) : {};
      const item = await MemberClass.insertOne({ ...scope, ...fields, ...instructor }, { session });
      await logChange(scope, actorId, 'MEMBER_CLASS_CREATE', item._id, session);
      return item.toObject();
    });
  }

  @Patch('member-classes/:id/instructor')
  updateClassInstructor(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const { instructorId } = read(z.object({ instructorId: objectId.nullable() }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(branch.mode);
      const item = found(await MemberClass.findOne({ ...scope, _id: id, canceledAt: null, startsAt: { $gt: new Date() } }).session(session),
        'Chỉ đổi huấn luyện viên cho lớp chưa bắt đầu.');
      item.set(instructorId ? await classInstructor(scope, instructorId, item.startsAt, item.endsAt, session, item._id) :
        { instructorId: undefined, instructor: undefined });
      await item.save({ session });
      await logChange(scope, actorId, 'MEMBER_CLASS_COACH', item._id, session, { instructorId });
      return item.toObject();
    });
  }

  @Post('member-classes/:id/cancel')
  cancelClass(@Req() req: Request, @Param() route: Route) {
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(branch.mode);
      const now = new Date();
      const item = found(await MemberClass.findOneAndUpdate({ ...scope, _id: id, startsAt: { $gt: now }, canceledAt: null },
        { $set: { canceledAt: now } }, { session, returnDocument: 'after' }).lean(), 'Chỉ hủy lớp chưa bắt đầu.');
      await logChange(scope, actorId, 'MEMBER_CLASS_CANCEL', item._id, session);
      return item;
    });
  }

  @Post('member-classes/:id/seats')
  bookSeat(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const { memberId } = read(z.object({ memberId: objectId }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.create', session);
      requireFacility(branch.mode);
      const now = new Date();
      const item = found(await MemberClass.findOne({ ...scope, _id: id, canceledAt: null, startsAt: { $gt: now } }).session(session),
        'Lớp đã bắt đầu, đã hủy hoặc không tồn tại.');
      const existing = item.seats.find(seat => seat.memberId.equals(memberId));
      if (existing) return { status: existing.status };
      const member = found(await FacilityMember.findOne({ ...scope, _id: memberId }).session(session).lean(), 'Không tìm thấy hội viên.');
      if (memberAccessStatus(member, facilityToday(+item.startsAt)) !== 'ACTIVE') {
        throw new ConflictException('Gói hội viên không còn hiệu lực vào ngày lớp diễn ra.');
      }
      if (await MemberClass.exists({ ...scope, _id: { $ne: item._id }, 'seats.memberId': member._id, canceledAt: null,
        startsAt: { $lt: item.endsAt }, endsAt: { $gt: item.startsAt } }).session(session)) {
        throw new ConflictException('Hội viên đã đăng ký lớp khác trùng giờ.');
      }
      if (item.seats.length >= item.capacity + 100) throw new ConflictException('Danh sách chờ đã đủ 100 người.');
      const status = item.seats.filter(seat => seat.status === 'BOOKED').length < item.capacity ? 'BOOKED' : 'WAITING';
      item.seats.push({ memberId: member._id, memberName: member.name, status, createdAt: now });
      await item.save({ session });
      await logChange(scope, actorId, 'MEMBER_CLASS_BOOK', item._id, session, { memberId, status });
      return { status };
    });
  }

  @Delete('member-classes/:id/seats/:memberId')
  async cancelSeat(@Req() req: Request, @Param() route: Route & { memberId: string }) {
    const id = read(objectId, route.id);
    const memberId = read(objectId, route.memberId);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.create', session);
      requireFacility(branch.mode);
      const item = found(await MemberClass.findOne({ ...scope, _id: id, canceledAt: null, startsAt: { $gt: new Date() } }).session(session),
        'Chỉ bỏ chỗ khi lớp chưa bắt đầu.');
      const index = item.seats.findIndex(seat => seat.memberId.equals(memberId));
      if (index === -1) return { memberId };
      const [removed] = item.seats.splice(index, 1);
      let promoted;
      if (removed.status === 'BOOKED') {
        const waiting = item.seats.filter(seat => seat.status === 'WAITING');
        const members = await FacilityMember.find({ ...scope, _id: { $in: waiting.map(seat => seat.memberId) } }).session(session).lean();
        const eligible = new Set(members.filter(member => memberAccessStatus(member, facilityToday(+item.startsAt)) === 'ACTIVE')
          .map(member => String(member._id)));
        promoted = waiting.find(seat => eligible.has(String(seat.memberId)));
        if (promoted) promoted.status = 'BOOKED';
      }
      await item.save({ session });
      await logChange(scope, actorId, 'MEMBER_CLASS_SEAT_CANCEL', item._id, session, { memberId, promoted: promoted?.memberId });
      return { memberId, promoted: promoted?.memberName };
    });
  }

  @Patch('member-classes/:id/seats/:memberId/attendance')
  markClassAttendance(@Req() req: Request, @Param() route: Route & { memberId: string }, @Body() body: unknown) {
    const id = read(objectId, route.id);
    const memberId = read(objectId, route.memberId);
    const { attended } = read(classAttendance, body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'member-classes.attendance', session);
      requireFacility(branch.mode);
      const now = new Date();
      const item = found(await MemberClass.findOne({ ...scope, _id: id, canceledAt: null, startsAt: { $lte: now } }).session(session),
        'Chỉ điểm danh từ giờ bắt đầu của lớp.');
      const seat = found(item.seats.find(seat => seat.memberId.equals(memberId) && seat.status === 'BOOKED'), 'Hội viên chưa có chỗ trong lớp.');
      if (Boolean(seat.attendedAt) !== attended) {
        seat.set('attendedAt', attended ? now : undefined);
        await item.save({ session });
        await logChange(scope, actorId, 'MEMBER_CLASS_ATTENDANCE', item._id, session, { memberId, attended });
      }
      return { memberId, attendedAt: seat.attendedAt };
    });
  }

  @Get('members')
  async list(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.read');
    requireFacility(branch.mode);
    const { q, page, status } = read(z.object({ q: z.string().trim().max(120).optional(), page: pageSchema,
      status: z.enum(memberAccessStates).optional() }), query);
    const filter = q && localFilter(q);
    const today = facilityToday();
    const statusExpression = membershipStatusExpression(today);
    const legacy = q?.match(/^HV-([A-F0-9]{24})$/i)?.[1];
    const [members, activeMembers, visitsToday] = await Promise.all([
      FacilityMember.find({ ...scope, ...(status && { $expr: { $eq: [statusExpression, status] } }),
        ...(filter ? { $or: [{ name: filter }, { phone: filter }, { code: q?.toUpperCase() },
        ...(legacy ? [{ _id: legacy, code: { $exists: false } }] : [])] } : {}) }).sort('name _id').skip((page - 1) * 50).limit(50).lean(),
      FacilityMember.countDocuments({ ...scope, active: true, $expr: { $eq: [statusExpression, 'ACTIVE'] } }),
      MemberVisit.countDocuments({ ...scope, createdAt: { $gte: new Date(`${today}T00:00:00+07:00`) } }),
    ]);
    return { members: members.map(member => ({ ...member, code: member.code || legacyCode(member._id), accessStatus: memberAccessStatus(member, today) })),
      activeMembers, visitsToday, today };
  }

  @Get('members/:id')
  @Header('Cache-Control', 'private, no-store')
  async detail(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.read');
    requireFacility(branch.mode);
    const member = found(await FacilityMember.findOne({ ...scope, _id: read(objectId, route.id) }).lean(), 'Không tìm thấy hội viên.');
    return { ...member, code: member.code || legacyCode(member._id), accessStatus: memberAccessStatus(member, facilityToday()) };
  }

  @Get('members/:id/history')
  async history(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.write');
    requireFacility(branch.mode);
    const memberId = read(objectId, route.id);
    const { kind, page } = read(z.object({ kind: z.enum(['visits', 'payments']), page: pageSchema }), query);
    found(await FacilityMember.exists({ ...scope, _id: memberId }), 'Không tìm thấy hội viên.');
    if (kind === 'visits') return MemberVisit.find({ ...scope, memberId }).sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
    return MemberPayment.find({ ...scope, memberId }).sort('-paidAt -_id').skip((page - 1) * 50).limit(50).lean();
  }

  @Post('members/:id/freeze')
  freezePlan(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const input = read(z.object({ resumesOn: z.string().refine(isStayDate), reason: label }).strict(), body);
    return this.changeFreeze(req, route, input);
  }

  @Post('members/:id/resume')
  resumePlan(@Req() req: Request, @Param() route: Route) {
    return this.changeFreeze(req, route);
  }

  private changeFreeze(req: Request, route: Route, input?: { resumesOn: string; reason: string }) {
    const memberId = read(objectId, route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(branch.mode);
      const member = found(await FacilityMember.findOne({ ...scope, _id: memberId }).session(session), 'Không tìm thấy hội viên.');
      const today = facilityToday();
      const expiry = member.enrollment?.expiresOn ?? member.expiresOn;
      if (input) {
        if (memberAccessStatus(member, today) !== 'ACTIVE') throw new ConflictException('Chỉ bảo lưu gói đang có hiệu lực.');
        if (input.resumesOn <= today || input.resumesOn > shiftDays(today, 365)) {
          throw new BadRequestException('Chọn ngày mở lại trong vòng 365 ngày kể từ ngày mai.');
        }
        if (await MemberClass.exists({ ...scope, 'seats.memberId': member._id, canceledAt: null,
          startsAt: { $gte: new Date(), $lt: new Date(`${input.resumesOn}T00:00:00+07:00`) } }).session(session)) {
          throw new ConflictException('Hãy bỏ chỗ các lớp đã đăng ký trong thời gian bảo lưu trước.');
        }
        const frozenDays = (Date.parse(input.resumesOn) - Date.parse(today)) / 86_400_000;
        if (expiry) member.set(member.enrollment?.expiresOn ? 'enrollment.expiresOn' : 'expiresOn', shiftDays(expiry, frozenDays));
        member.set('freeze', { startsOn: today, ...input });
      } else {
        if (!member.freeze || member.freeze.resumesOn <= today) throw new ConflictException('Hội viên hiện không có gói đang bảo lưu.');
        const unusedDays = (Date.parse(member.freeze.resumesOn) - Date.parse(today)) / 86_400_000;
        if (expiry) member.set(member.enrollment?.expiresOn ? 'enrollment.expiresOn' : 'expiresOn', shiftDays(expiry, -unusedDays));
        member.set('freeze', undefined);
      }
      await member.save({ session });
      await logChange(scope, actorId, input ? 'MEMBER_PLAN_FREEZE' : 'MEMBER_PLAN_RESUME', member._id, session, input);
      return { memberId };
    });
  }

  @Post('members')
  @UseInterceptors(FileInterceptor('image', { limits: productImageLimits }))
  async create(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @UploadedFile() file?: { buffer: Buffer },
    @Headers('idempotency-key') key?: string) {
    const { planId, payment, ...input } = read(memberInput.extend({ planId: objectId.optional(), payment: enrollmentPayment.optional() }), memberBody(req, body));
    if (!planId) throw new BadRequestException('Hãy chọn gói hội viên.');
    const photo = readProductImage(file);
    if (!photo) throw new BadRequestException('Hãy chọn ảnh hội viên.');
    const save = async (session: ClientSession) => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.create', session);
      requireFacility(branch.mode);
      const plan = await activeMemberPlan(scope, planId, session);
      const now = new Date();
      const enrollment = nextMemberEnrollment(plan, undefined, facilityToday(now.getTime()));
      const code = `HV-${randomBytes(5).toString('hex').toUpperCase()}`;
      const member = new FacilityMember({ ...scope, ...input, code, enrollment: { ...enrollment, chargeId: new Types.ObjectId() }, photo });
      const receipt = await collectEnrollmentFee(scope, { id: member._id, name: member.name }, enrollment, payment, actorId, now, session);
      if (receipt) member.set('enrollment.paymentId', receipt._id);
      await member.save({ session });
      await logChange(scope, actorId, 'MEMBER_CREATE', member._id, session, { planId, paymentId: receipt?._id });
      return member.toObject({ useProjection: true });
    };
    if (!key) return transaction(save).catch(memberConflict);
    const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.create');
    requireFacility(branch.mode);
    const imageHash = createHash('sha256').update(photo.bytes).digest('hex');
    return idempotent(scope, 'MEMBER_CREATE', key, { ...input, planId, payment, actorId, imageHash }, save).catch(memberConflict);
  }

  @Patch('members/:id')
  @UseInterceptors(FileInterceptor('image', { limits: productImageLimits }))
  async update(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @UploadedFile() file?: { buffer: Buffer }) {
    const id = read(objectId, route.id);
    const photo = readProductImage(file);
    const input = read(memberInput.extend({ active: z.boolean() }).partial().refine(fields => !!photo || Object.keys(fields).length > 0),
      memberBody(req, body));
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(branch.mode);
      const member = found(await FacilityMember.findOneAndUpdate({ ...scope, _id: id }, { $set: { ...input, ...(photo && { photo }) } },
        { session, returnDocument: 'after', runValidators: true }).lean(), 'Không tìm thấy hội viên.');
      await logChange(scope, actorId, 'MEMBER_UPDATE', member._id, session);
      return member;
    }).catch(memberConflict);
  }

  @Get('members/:id/photo')
  @Header('Cache-Control', 'private, no-store')
  async photo(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.read');
    requireFacility(branch.mode);
    return memberPhoto(scope, read(objectId, route.id));
  }

  @Delete('members/:id')
  async remove(@Req() req: Request, @Param() route: Route) {
    const id = read(objectId, route.id);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(branch.mode);
      if (await MemberClass.exists({ ...scope, 'seats.memberId': id, canceledAt: null, startsAt: { $gte: new Date() } }).session(session)) {
        throw new ConflictException('Hãy bỏ chỗ các lớp sắp tới trước khi xoá hội viên.');
      }
      const member = found(await FacilityMember.findOneAndDelete({ ...scope, _id: id }, { session }).select('_id').lean(),
        'Không tìm thấy hội viên.');
      await MemberCredential.deleteMany({ ...scope, memberId: member._id }, { session });
      await logChange(scope, actorId, 'MEMBER_DELETE', member._id, session);
      return { id: String(member._id) };
    });
  }

  @Get('member-plans')
  async listPlans(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.read');
    requireFacility(branch.mode);
    return MemberPlan.find(scope).sort('name _id').lean();
  }

  @Post('member-plans')
  createPlan(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.savePlan(req, route, body);
  }

  @Patch('member-plans/:id')
  updatePlan(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.savePlan(req, route, body, read(objectId, route.id));
  }

  private savePlan(req: Request, route: Route, body: unknown, id?: string) {
    const input = read(planInput, body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'member-plans.manage', session);
      requireFacility(branch.mode);
      if (await MemberPlan.exists({ ...scope, name: input.name, ...(id ? { _id: { $ne: id } } : {}) }).session(session)) {
        throw new ConflictException('Tên gói đã được sử dụng tại chi nhánh.');
      }
      const plan = id ? found(await MemberPlan.findOneAndUpdate({ ...scope, _id: id }, { $set: input },
        { session, returnDocument: 'after', runValidators: true }).lean()) : (await MemberPlan.insertOne({ ...scope, ...input }, { session })).toObject();
      await logChange(scope, actorId, id ? 'MEMBER_PLAN_UPDATE' : 'MEMBER_PLAN_CREATE', plan._id, session);
      return plan;
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Tên gói đã được sử dụng tại chi nhánh.');
      throw error;
    });
  }

  @Post('members/:id/plan')
  async assignPlan(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const memberId = read(objectId, route.id);
    const { planId, payment } = read(z.object({ planId: objectId, payment: enrollmentPayment.optional() }).strict(), body);
    const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write');
    requireFacility(branch.mode);
    return idempotent(scope, 'MEMBER_PLAN_ASSIGN', key, { memberId, planId, actorId, payment }, async session => {
      const current = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(current.branch.mode);
      const member = found(await FacilityMember.findOne({ ...scope, _id: memberId }).session(session), 'Không tìm thấy hội viên.');
      const plan = await activeMemberPlan(scope, planId, session);
      const now = new Date();
      if (member.freeze && member.freeze.resumesOn > facilityToday(now.getTime())) {
        throw new ConflictException('Hãy mở lại gói đang bảo lưu trước khi đổi hoặc gia hạn gói.');
      }
      const terms = nextMemberEnrollment(plan, member.enrollment, facilityToday(now.getTime()));
      const receipt = await collectEnrollmentFee(scope, { id: member._id, name: member.name }, terms, payment, actorId, now, session);
      const enrollment = { ...terms, chargeId: new Types.ObjectId(), paymentId: receipt?._id };
      member.set({ enrollment, plan: undefined, expiresOn: undefined, freeze: undefined });
      await member.save({ session });
      await logChange(scope, actorId, 'MEMBER_PLAN_ASSIGN', member._id, session, { planId, paymentId: receipt?._id });
      return enrollment;
    });
  }

  @Post('members/:id/plan-payment')
  async receivePlanPayment(@Req() req: Request, @Param() route: Route, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const memberId = read(objectId, route.id);
    const { chargeId, paidAt, ...payment } = read(paymentInput.extend({
      chargeId: objectId.nullable(), paidAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
    }), body);
    if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() < 0 || paidAt > new Date()) {
      throw new BadRequestException('Thời điểm thu tiền phải là ngày giờ đã qua hoặc hiện tại.');
    }
    const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write');
    requireFacility(branch.mode);
    return idempotent(scope, 'MEMBER_PLAN_PAYMENT', key, { memberId, chargeId, paidAt, payment, actorId }, async session => {
      const current = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(current.branch.mode);
      const member = found(await FacilityMember.findOne({ ...scope, _id: memberId }).session(session), 'Không tìm thấy hội viên.');
      const enrollment = member.enrollment;
      if (!enrollment?.price || (enrollment.chargeId?.toString() ?? null) !== chargeId) {
        throw new ConflictException('Gói hiện tại đã thay đổi hoặc không có giá đã lưu. Hãy tải lại hồ sơ.');
      }
      if (enrollment.paymentId) throw new ConflictException('Khoản thu của gói hiện tại đã được ghi nhận.');
      const receipt = await recordMemberPayment(scope, { id: member._id, name: member.name }, enrollment, payment, actorId, paidAt, session);
      enrollment.paymentId = receipt._id;
      await member.save({ session });
      await logChange(scope, actorId, 'MEMBER_PLAN_PAYMENT', member._id, session, { paymentId: receipt._id });
      return receipt.toObject();
    });
  }

  @Get('members/:id/credentials')
  async credentials(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.write');
    requireFacility(branch.mode);
    const memberId = read(objectId, route.id);
    return MemberCredential.find({ ...scope, memberId }).select('method code').lean();
  }

  @Patch('members/:id/credentials')
  async linkCredential(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const memberId = read(objectId, route.id);
    const { method, code } = read(z.object({ method: credentialMethod, code: credentialCode.nullable() }).strict(), body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.write', session);
      requireFacility(branch.mode);
      const member = found(await FacilityMember.exists({ ...scope, _id: memberId }).session(session), 'Không tìm thấy hội viên.');
      const filter = { ...scope, memberId: member._id, method };
      if (code === null) await MemberCredential.deleteOne(filter, { session });
      else {
        if (await MemberCredential.exists({ ...scope, method, code, memberId: { $ne: member._id } }).session(session)) {
          throw new ConflictException('Mã này đã liên kết với hội viên khác tại chi nhánh.');
        }
        await MemberCredential.updateOne(filter, { $set: { code } }, { upsert: true, runValidators: true, session });
      }
      await logChange(scope, actorId, 'MEMBER_CREDENTIAL_SET', member._id, session, { method, linked: code !== null });
      return { method, code };
    }).catch(error => {
      if (isDuplicate(error)) throw new ConflictException('Mã này đã liên kết với hội viên khác tại chi nhánh.');
      throw error;
    });
  }

  @Get('member-visits')
  async visits(@Req() req: Request, @Param() route: Route, @Query() query: unknown) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.read');
    requireFacility(branch.mode);
    const { page } = read(z.object({ page: pageSchema }), query);
    const visits = await MemberVisit.find(scope).sort('-createdAt -_id').skip((page - 1) * 50).limit(50).lean();
    if (!visits.length) return visits;
    const members = await FacilityMember.find({ ...scope, _id: { $in: visits.map(visit => visit.memberId) } }).select('photo.version').lean();
    const photos = new Map(members.map(member => [String(member._id), member.photo?.version]));
    return visits.map(visit => ({ ...visit, photoVersion: photos.get(String(visit.memberId)) }));
  }

  @Post('members/:id/check-in')
  checkInById(@Req() req: Request, @Param() route: Route) {
    return this.manualCheckIn(req, route, { id: read(objectId, route.id) });
  }

  @Post('member-check-ins')
  checkInByCode(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    return this.manualCheckIn(req, route, read(checkInInput, body));
  }

  private manualCheckIn(req: Request, route: Route, source: { id: string } | CheckIn) {
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'members.read', session);
      requireFacility(branch.mode);
      requireMethod(branch.memberCheckInMethods, 'method' in source ? source.method : 'MEMBER_CODE');
      return checkInMember(scope, session, source, 'STAFF', actorId);
    });
  }

  @Get('member-check-in-settings')
  @Header('Cache-Control', 'no-store')
  async checkInSettings(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'members.read');
    requireFacility(branch.mode);
    const kioskEnabled = !!await Branch.exists({ tenantId: scope.tenantId, _id: scope.branchId, memberKioskKeyHash: { $type: 'string' } });
    return { methods: enabledMethods(branch.memberCheckInMethods), kioskEnabled };
  }

  @Patch('member-check-in-settings')
  async configureCheckIn(@Req() req: Request, @Param() route: Route, @Body() body: unknown) {
    const { methods } = read(methodSettings, body);
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'member-check-in.manage', session);
      requireFacility(branch.mode);
      await Branch.updateOne({ tenantId: scope.tenantId, _id: scope.branchId }, { $set: { memberCheckInMethods: methods } }, { session });
      await logChange(scope, actorId, 'MEMBER_CHECK_IN_SETTINGS', scope.branchId, session, { methods });
      return { methods };
    });
  }

  @Get('member-device-key')
  @Header('Cache-Control', 'no-store')
  async deviceKey(@Req() req: Request, @Param() route: Route) {
    const { scope, branch } = await access(req, route.tenantId, route.branchId, 'member-check-in.manage');
    requireFacility(branch.mode);
    return { enabled: !!await Branch.exists({ tenantId: scope.tenantId, _id: scope.branchId, memberCheckInKeyHash: { $type: 'string' } }) };
  }

  @Post('member-device-key')
  @Header('Cache-Control', 'no-store')
  rotateDeviceKey(@Req() req: Request, @Param() route: Route) {
    return this.changeAutomatedKey(req, route, 'DEVICE', true);
  }

  @Delete('member-device-key')
  revokeDeviceKey(@Req() req: Request, @Param() route: Route) {
    return this.changeAutomatedKey(req, route, 'DEVICE', false);
  }

  @Post('member-kiosk-key')
  @Header('Cache-Control', 'no-store')
  rotateKioskKey(@Req() req: Request, @Param() route: Route) {
    return this.changeAutomatedKey(req, route, 'KIOSK', true);
  }

  @Delete('member-kiosk-key')
  revokeKioskKey(@Req() req: Request, @Param() route: Route) {
    return this.changeAutomatedKey(req, route, 'KIOSK', false);
  }

  private changeAutomatedKey(req: Request, route: Route, source: AutomatedSource, rotate: boolean) {
    const { prefix, field } = automatedKeys[source];
    const key = rotate ? prefix + randomBytes(32).toString('hex') : undefined;
    return transaction(async session => {
      const { scope, branch, actorId } = await access(req, route.tenantId, route.branchId, 'member-check-in.manage', session);
      requireFacility(branch.mode);
      await Branch.updateOne({ tenantId: scope.tenantId, _id: scope.branchId },
        key ? { $set: { [field]: keyHash(key) } } : { $unset: { [field]: 1 } }, { session });
      await logChange(scope, actorId, key ? 'MEMBER_CHECK_IN_KEY_SET' : 'MEMBER_CHECK_IN_KEY_REVOKE', scope.branchId, session, { source });
      return { key, enabled: !!key };
    });
  }

  @Post('member-device-check-ins')
  @Header('Cache-Control', 'no-store')
  async deviceCheckIn(@Param() route: Route, @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const auth = await authorizeAutomatedCheckIn(route, authorization, 'DEVICE');
    return automatedCheckIn(auth, 'DEVICE', key, read(checkInInput.extend({ method: credentialMethod }), body));
  }
}

@Controller('member-kiosk/:tenantId/:branchId')
export class MemberKioskController {
  @Get()
  @Header('Cache-Control', 'no-store')
  async settings(@Param() route: Pick<Route, 'tenantId' | 'branchId'>, @Headers('authorization') authorization?: string) {
    const { branch } = await authorizeAutomatedCheckIn(route, authorization, 'KIOSK');
    const enabled = enabledMethods(branch.memberCheckInMethods);
    return { name: branch.name, mode: branch.mode, methods: memberKioskMethods.filter(method => enabled.includes(method)) };
  }

  @Post('check-ins')
  @Header('Cache-Control', 'no-store')
  async checkIn(@Param() route: Pick<Route, 'tenantId' | 'branchId'>, @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    const auth = await authorizeAutomatedCheckIn(route, authorization, 'KIOSK');
    return automatedCheckIn(auth, 'KIOSK', key, read(checkInInput.extend({ method: z.enum(memberKioskMethods) }), body));
  }

  @Get('check-ins/:id/photo')
  @Header('Cache-Control', 'private, no-store')
  async photo(@Param() route: Route, @Headers('authorization') authorization?: string, @Headers('x-member-photo-proof') proof?: string) {
    const { scope, digest } = await authorizeAutomatedCheckIn(route, authorization, 'KIOSK');
    const id = read(objectId, route.id);
    if (!proof || !/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(kioskPhotoProof(id, digest), Buffer.from(proof, 'hex'))) {
      throw new ForbiddenException('Không có quyền xem ảnh của lượt check-in này.');
    }
    const visit = found(await MemberVisit.findOne({ ...scope, _id: id, source: 'KIOSK',
      createdAt: { $gte: new Date(Date.now() - 30_000) } }).select('memberId').lean(), 'Ảnh check-in không còn khả dụng.');
    return memberPhoto(scope, visit.memberId);
  }
}
