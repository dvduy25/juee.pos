import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode,
  Param, Post, Query, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { hash, verify } from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { found, isDuplicate } from '../utils/db';
import { accountEmail as email, accountPassword as password, label, objectId, read } from '../validators/common';
import { transaction } from '../config/db';
import { AccountToken, Branch, PlatformGrant, User, UserSession } from '../models';
import { canAdmin, canManageBranches } from '../middleware/policy';
import { authenticate, sessionIssuer, sessionSurfaceFilter, signingSecret, verifyAdminOrigin, verifyOrigin, type SessionSurface } from '../middleware/auth';
import { requestAccountLink, requireAccountMail, signupNeedsVerification, tokenDigest, verificationDigest } from '../services/account-email';
import { requireBusinessAvailable, canSignIntoBusinessAccount, tenantMembership } from '../services/tenants';
import { beginGoogle, exchangeGoogleCode, googleConfig, googleDestination, googleFlowCookie, readGoogleFlow } from '../services/google-auth';

const accountToken = z.string().regex(/^[a-f0-9]{64}$/);
const authCookies = { customer: 'juee_refresh', admin: 'juee_admin_refresh' } as const;
const sessionLifetimes = { customer: 14 * 86400 * 1000, admin: 8 * 3600 * 1000 };
const cookieOptions = (surface: SessionSurface) => ({
  httpOnly: true, secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const, path: surface === 'admin' ? '/api/v1/admin-auth' : '/api/v1/auth',
});

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function requirePassword(hash: string | null | undefined): string {
  if (!hash) throw new ForbiddenException('Hãy đặt mật khẩu trong mục Bảo mật tài khoản để thực hiện thao tác này.');
  return hash;
}

function cookieToken(req: Request, surface: SessionSurface) {
  return req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${authCookies[surface]}=([a-f0-9]{64})(?:;|$)`))?.[1];
}

function accessResponse(sessionId: string, modeVersion?: string | null, surface: SessionSurface = 'customer') {
  return { accessToken: jwt.sign(modeVersion ? { modeVersion } : {}, signingSecret(), {
    subject: sessionId, expiresIn: '10m', algorithm: 'HS256', issuer: sessionIssuer(surface),
  }) };
}

function sessionResponse(res: Response, sessionId: string, refresh: string, expiresAt: Date, modeVersion?: string | null, surface: SessionSurface = 'customer') {
  res.cookie(authCookies[surface], refresh, { ...cookieOptions(surface), expires: expiresAt });
  return accessResponse(sessionId, modeVersion, surface);
}

async function loginSession(req: Request, res: Response, body: unknown, surface: SessionSurface) {
  const admin = surface === 'admin';
  if (admin) verifyAdminOrigin(req);
  else verifyOrigin(req);
  const credentials = z.object({ email, password });
  const otp = z.string().regex(/^\d{6}$/);
  const input = read(admin ? credentials.extend({ otp }).strict() : credentials.strict(), body);
  const user = await User.findOne({ email: input.email });
  if (!user?.passwordHash || user.locked || !await verify(user.passwordHash, input.password)) {
    throw new UnauthorizedException('Thông tin đăng nhập không hợp lệ');
  }
  const grant = await PlatformGrant.findOne({ userId: user._id });
  if (!admin && grant) throw new ForbiddenException('Hãy đăng nhập từ địa chỉ quản trị.');
  const code = 'otp' in input && typeof input.otp === 'string' ? input.otp : undefined;
  if (admin && (!grant || !canAdmin(true, grant.permissions, 'platform.read') || !code || !authenticator.check(code, grant.totpSecret))) {
    throw new UnauthorizedException('Thông tin đăng nhập hoặc mã xác thực không hợp lệ.');
  }
  if (user.emailVerificationRequired && !user.emailVerifiedAt) throw new ForbiddenException('Hãy xác minh email trước khi đăng nhập.');
  const refresh = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionLifetimes[surface]);
  const step = Math.floor(Date.now() / 30000);
  const session = await transaction(async session => {
    if (admin && grant) {
      const used = await PlatformGrant.updateOne({ _id: grant._id, totpSecret: grant.totpSecret,
        $or: [{ lastOtpStep: { $lt: step } }, { lastOtpStep: { $exists: false } }] }, { $set: { lastOtpStep: step } }, { session });
      if (!used.matchedCount) throw new UnauthorizedException('Mã xác thực đã được dùng hoặc đã thay đổi.');
    } else if (!await canSignIntoBusinessAccount(user._id, session)) {
      throw new ForbiddenException('Cửa hàng chỉ cấp quyền đăng nhập cho chủ doanh nghiệp và quản lý.');
    }
    const updated = await User.updateOne({ _id: user._id, locked: { $ne: true }, passwordHash: user.passwordHash },
      { $set: { lastLoginAt: new Date() } }, { session });
    if (!updated.matchedCount) throw new UnauthorizedException();
    return UserSession.insertOne({ userId: user._id, refreshHash: digest(refresh), expiresAt, mfa: admin, surface }, { session });
  });
  return sessionResponse(res, session.id, refresh, expiresAt, undefined, surface);
}

async function googleCustomer(profile: Awaited<ReturnType<typeof exchangeGoogleCode>>) {
  const refresh = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionLifetimes.customer);
  const complete = () => transaction(async session => {
    let user = await User.findOne({ googleSubject: profile.subject }).select('+managedByTenantId').session(session);
    if (!user) {
      if (await User.exists({ email: profile.email }).session(session)) throw new ConflictException();
      user = await User.insertOne({ email: profile.email, name: profile.name, googleSubject: profile.subject,
        emailVerificationRequired: true, emailVerifiedAt: new Date() }, { session });
    }
    if (user.locked || !user.emailVerifiedAt || user.managedByTenantId || await PlatformGrant.exists({ userId: user.id }).session(session) ||
        !await canSignIntoBusinessAccount(user._id, session)) throw new ForbiddenException();
    const authenticatedAt = new Date();
    const active = await User.updateOne({ _id: user.id, locked: { $ne: true } }, { $set: { lastLoginAt: authenticatedAt } }, { session });
    if (!active.matchedCount) throw new ForbiddenException();
    const loggedIn = await UserSession.insertOne({ userId: user._id, refreshHash: digest(refresh), expiresAt,
      surface: 'customer', mfa: false, googleAuthenticatedAt: authenticatedAt }, { session });
    return { sessionId: loggedIn.id, refresh, expiresAt };
  });
  try {
    return await complete();
  } catch (cause) {
    if (!isDuplicate(cause)) throw cause;
    return complete();
  }
}

async function refreshSession(req: Request, res: Response, surface: SessionSurface) {
  if (surface === 'admin') verifyAdminOrigin(req);
  else verifyOrigin(req);
  const token = cookieToken(req, surface);
  if (!token) throw new UnauthorizedException();
  const refreshHash = digest(token);
  const previous = await UserSession.findOne({ refreshHash, ...sessionSurfaceFilter(surface), expiresAt: { $gt: new Date() } });
  if (!previous || !await User.exists({ _id: previous.userId, locked: { $ne: true } })) throw new UnauthorizedException();
  const grant = await PlatformGrant.findOne({ userId: previous.userId }).select('permissions').lean();
  if (surface === 'admin' ? !canAdmin(previous.mfa, grant?.permissions ?? [], 'platform.read') : grant || !await canSignIntoBusinessAccount(previous.userId)) {
    throw new UnauthorizedException();
  }
  const refresh = randomBytes(32).toString('hex');
  const updated = await UserSession.findOneAndUpdate({ _id: previous._id, refreshHash }, { $set: { refreshHash: digest(refresh) } }, { returnDocument: 'after' });
  if (!updated) throw new UnauthorizedException();
  return sessionResponse(res, updated.id, refresh, updated.expiresAt, updated.modeVersion, surface);
}

async function logoutSession(req: Request, res: Response, surface: SessionSurface) {
  if (surface === 'admin') verifyAdminOrigin(req);
  else verifyOrigin(req);
  const token = cookieToken(req, surface);
  if (req.get('authorization')) {
    try {
      const session = await authenticate(req, { surface });
      await UserSession.deleteOne({ _id: session.id });
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
    }
  }
  if (token) await UserSession.deleteOne({ refreshHash: digest(token), ...sessionSurfaceFilter(surface) });
  res.clearCookie(authCookies[surface], cookieOptions(surface));
  return { ok: true };
}

@Controller('admin-auth')
export class AdminAuthController {
  @Post('login')
  login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return loginSession(req, res, body, 'admin');
  }

  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return refreshSession(req, res, 'admin');
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return logoutSession(req, res, 'admin');
  }

  @Get('me')
  async me(@Req() req: Request) {
    const { user, mfa } = await authenticate(req, { management: true, surface: 'admin' });
    return { id: user.id, name: user.name, email: user.email, platformAdmin: true,
      platformWrite: canAdmin(mfa, user.platformGrant?.permissions ?? [], 'platform.write') };
  }
}

@Controller('auth')
export class AuthController {
  @Get('providers')
  providers() {
    return { google: !!googleConfig() };
  }

  @Get('google/start')
  startGoogle(@Query('from') from: unknown, @Query('next') next: unknown, @Res() res: Response) {
    const entry = from === 'register' ? 'register' : 'login';
    const config = googleConfig();
    if (!config) return res.redirect(303, `/${entry}?google=unavailable`);
    const flow = beginGoogle(config, entry, typeof next === 'string' ? next : '');
    const cookie = googleFlowCookie();
    res.set('Referrer-Policy', 'no-referrer');
    res.cookie(cookie.name, flow.cookie, { ...cookie.options, maxAge: flow.maxAge });
    return res.redirect(303, flow.url);
  }

  @Get('google/callback')
  async finishGoogle(@Req() req: Request, @Query() query: unknown, @Res() res: Response) {
    const cookie = googleFlowCookie();
    const prefix = cookie.name + '=';
    const raw = req.headers.cookie?.split(/;\s*/).find(value => value.startsWith(prefix))?.slice(prefix.length);
    const flow = readGoogleFlow(raw);
    const entry = flow?.from ?? 'login';
    const config = googleConfig();
    const failure = (status: string) => res.redirect(303, `/${entry}?google=${status}`);
    res.set('Referrer-Policy', 'no-referrer');
    if (!config) return failure('unavailable');
    const result = z.object({ state: z.string().max(256), code: z.string().min(1).max(2048).optional(), error: z.string().max(100).optional() }).safeParse(query);
    if (!flow || !result.success || result.data.state !== flow.state) return failure('expired');
    res.clearCookie(cookie.name, cookie.options);
    if (result.data.error) return failure(result.data.error === 'access_denied' ? 'cancelled' : 'failed');
    if (!result.data.code) return failure('failed');
    try {
      const profile = await exchangeGoogleCode(config, flow, result.data.code);
      if (!profile.emailAuthoritative) return failure('unsupported_email');
      const customer = await googleCustomer(profile);
      sessionResponse(res, customer.sessionId, customer.refresh, customer.expiresAt);
      return res.redirect(303, googleDestination(flow.next, config.origin));
    } catch (cause) {
      if (cause instanceof ConflictException) return failure('existing');
      if (cause instanceof ForbiddenException) return failure('restricted');
      return failure('failed');
    }
  }

  @Post('register')
  async register(@Body() body: unknown, @Req() req: Request) {
    verifyOrigin(req);
    const input = read(z.object({ email, password, name: label }).strict(), body);
    const emailVerificationRequired = signupNeedsVerification();
    if (emailVerificationRequired) requireAccountMail();
    const passwordHash = await hash(input.password);
    let user;
    try {
      user = await User.create({ email: input.email, name: input.name, passwordHash, emailVerificationRequired });
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException('Email đã được sử dụng');
      throw error;
    }
    const verificationSent = emailVerificationRequired && await requestAccountLink(user, 'VERIFY_EMAIL');
    return { id: user.id, emailVerificationRequired, verificationSent };
  }

  @Post('login')
  login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return loginSession(req, res, body, 'customer');
  }

  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return refreshSession(req, res, 'customer');
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return logoutSession(req, res, 'customer');
  }

  @Get('me')
  async me(@Req() req: Request) {
    const { user, staffMode, selectedBranch } = await authenticate(req);
    if (!await canSignIntoBusinessAccount(user._id)) throw new UnauthorizedException();
    const hasPassword = !!await User.exists({ _id: user._id, passwordHash: { $type: 'string', $ne: '' } });
    return { id: user.id, name: user.name, email: user.email, hasPassword, staffMode, selectedBranch };
  }

  @Post('branch-access')
  @HttpCode(200)
  async branchAccess(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    const { tenantId, branchId, password: entered } = read(z.object({ tenantId: objectId, branchId: objectId, password }).strict(), body);
    const current = await authenticate(req, { management: true });
    const user = found(await User.findById(current.userId).select('passwordHash').lean());
    if (!(await verify(requirePassword(user.passwordHash), entered))) throw new ForbiddenException('Mật khẩu tài khoản đang đăng nhập chưa đúng.');
    return transaction(async session => {
      const current = await authenticate(req, { management: true, session });
      const { membership } = await tenantMembership(current.userId, tenantId, session);
      if (!canManageBranches(membership.role, membership.branchIds.map(String), branchId) ||
          !await Branch.exists({ _id: branchId, tenantId }).session(session)) {
        throw new ForbiddenException('Hãy đăng nhập bằng tài khoản chủ doanh nghiệp hoặc quản lý được giao chi nhánh này.');
      }
      const selectedBranch = { tenantId, branchId };
      await UserSession.updateOne({ _id: current.id }, { $set: { selectedBranch } }, { session });
      return selectedBranch;
    });
  }

  @Post('work-mode')
  @HttpCode(200)
  async workMode(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('STAFF'), tenantId: objectId, branchId: objectId }).strict(),
      z.object({ mode: z.literal('MANAGEMENT'), password }).strict(),
    ]), body);
    return transaction(async session => {
      const current = await authenticate(req, { session });
      const user = found(await User.findById(current.userId).session(session).select('passwordHash').lean());
      const confirmedHash = requirePassword(user.passwordHash);
      if (input.mode === 'STAFF') {
        if (current.staffMode) throw new ForbiddenException('Đang sử dụng chế độ Nhân viên.');
        const { membership } = await tenantMembership(current.userId, input.tenantId, session);
        if (!canManageBranches(membership.role, membership.branchIds.map(String), input.branchId)) throw new ForbiddenException();
        found(await Branch.exists({ _id: input.branchId, tenantId: input.tenantId }).session(session));
        await requireBusinessAvailable(input.tenantId, session);
      } else {
        if (!current.staffMode) throw new ConflictException('Đang sử dụng chế độ Quản lý.');
        if (!(await verify(confirmedHash, input.password))) throw new ForbiddenException('Mật khẩu tài khoản chưa đúng.');
      }
      const modeVersion = randomUUID();
      const update = input.mode === 'STAFF'
        ? { $set: { modeVersion, staffMode: { tenantId: input.tenantId, branchId: input.branchId } } }
        : { $set: { modeVersion }, $unset: { staffMode: 1 } };
      await UserSession.updateOne({ _id: current.id }, update, { session });
      return accessResponse(current.id, modeVersion);
    });
  }

  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    requireAccountMail();
    const input = read(z.object({ email }).strict(), body);
    const user = await User.findOne({ email: input.email });
    if (user && !user.locked && !user.emailVerifiedAt) await requestAccountLink(user, 'VERIFY_EMAIL');
    return { ok: true };
  }

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(z.union([
      z.object({ token: accountToken }).strict(),
      z.object({ email, code: z.string().regex(/^\d{6}$/) }).strict(),
    ]), body);
    const requestedDigest = 'token' in input ? tokenDigest(input.token) : verificationDigest(input.email, input.code);
    const now = new Date();
    if ('email' in input) {
      const user = await User.findOne({ email: input.email, locked: { $ne: true }, emailVerifiedAt: null }).select('_id').lean();
      if (!user) throw invalidAccountLink();
      const attempt = await AccountToken.findOneAndUpdate({ userId: user._id, kind: 'VERIFY_EMAIL', expiresAt: { $gt: now },
        $or: [{ attempts: { $exists: false } }, { attempts: { $lt: 5 } }] }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
      if (!attempt || attempt.digest !== requestedDigest) throw invalidAccountLink();
    }
    await transaction(async session => {
      const token = await AccountToken.findOne({ digest: requestedDigest }).session(session);
      if (!token || token.kind !== 'VERIFY_EMAIL' || token.expiresAt <= now) throw invalidAccountLink();
      const consumed = await AccountToken.deleteOne({ _id: token._id, digest: token.digest, expiresAt: { $gt: now } }, { session });
      if (!consumed.deletedCount) throw invalidAccountLink();
      const changed = await User.updateOne({ _id: token.userId, locked: { $ne: true } }, { $set: { emailVerifiedAt: now } }, { session });
      if (!changed.matchedCount) throw invalidAccountLink();
    });
    return { ok: true };
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    requireAccountMail();
    const input = read(z.object({ email }).strict(), body);
    const user = await User.findOne({ email: input.email });
    if (user && !user.locked && !await PlatformGrant.exists({ userId: user._id })) await requestAccountLink(user, 'RESET_PASSWORD');
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Req() req: Request, @Body() body: unknown) {
    verifyOrigin(req);
    const input = read(z.object({ token: accountToken, password }).strict(), body);
    const token = await AccountToken.findOne({ digest: tokenDigest(input.token) });
    if (!token || token.kind !== 'RESET_PASSWORD' || token.expiresAt <= new Date()) throw invalidAccountLink();
    const passwordHash = await hash(input.password);
    await transaction(async session => {
      if (await PlatformGrant.exists({ userId: token.userId }).session(session)) throw invalidAccountLink();
      const consumed = await AccountToken.deleteOne({ _id: token._id, digest: token.digest, expiresAt: { $gt: new Date() } }, { session });
      if (!consumed.deletedCount) throw invalidAccountLink();
      const changed = await User.updateOne({ _id: token.userId, locked: { $ne: true } }, { $set: { passwordHash } }, { session });
      if (!changed.matchedCount) throw invalidAccountLink();
      await UserSession.deleteMany({ userId: token.userId }, { session });
    });
    return { ok: true };
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    verifyOrigin(req);
    const session = await authenticate(req, { management: true });
    const input = read(z.object({ accountId: objectId.optional(), currentPassword: password, password }).strict(), body);
    if (input.accountId && input.accountId !== session.userId) throw new ForbiddenException('Chỉ đổi mật khẩu của tài khoản đang đăng nhập.');
    const user = await User.findById(session.userId).then(value => found(value));
    if (!(await verify(requirePassword(user.passwordHash), input.currentPassword))) throw new BadRequestException('Mật khẩu hiện tại không đúng.');
    const passwordHash = await hash(input.password);
    await transaction(async session => {
      await authenticate(req, { management: true, session });
      const changed = await User.updateOne({ _id: user._id, locked: { $ne: true }, passwordHash: user.passwordHash }, { $set: { passwordHash } }, { session });
      if (!changed.matchedCount) throw new ConflictException('Mật khẩu đã thay đổi. Hãy đăng nhập lại.');
      await UserSession.deleteMany({ userId: user._id }, { session });
      await AccountToken.deleteMany({ userId: user._id, kind: 'RESET_PASSWORD' }, { session });
    });
    res.clearCookie(authCookies.customer, cookieOptions('customer'));
    return { ok: true };
  }

  @Post('set-initial-password')
  @HttpCode(200)
  async setInitialPassword(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    verifyOrigin(req);
    const input = read(z.object({ password }).strict(), body);
    const current = await authenticate(req, { management: true });
    const now = Date.now();
    if (!current.googleAuthenticatedAt || +current.googleAuthenticatedAt > now || now - +current.googleAuthenticatedAt > 5 * 60 * 1000) {
      throw new ForbiddenException('Hãy đăng nhập lại bằng Google rồi đặt mật khẩu trong vòng 5 phút.');
    }
    const passwordHash = await hash(input.password);
    await transaction(async session => {
      await authenticate(req, { management: true, session });
      const updated = await User.updateOne({ _id: current.userId, googleSubject: { $type: 'string' }, locked: { $ne: true },
        passwordHash: { $in: [null, ''] } }, { $set: { passwordHash } }, { session });
      if (!updated.matchedCount) throw new ConflictException('Tài khoản đã có mật khẩu. Hãy dùng chức năng đổi mật khẩu.');
      await AccountToken.deleteMany({ userId: current.userId, kind: 'RESET_PASSWORD' }, { session });
      await UserSession.deleteMany({ userId: current.userId }, { session });
    });
    res.clearCookie(authCookies.customer, cookieOptions('customer'));
    return { ok: true };
  }

  @Get('sessions')
  async sessions(@Req() req: Request) {
    const current = await authenticate(req, { management: true });
    const sessions = await UserSession.find({ userId: current.userId, expiresAt: { $gt: new Date() } }).select('createdAt expiresAt').sort({ expiresAt: -1 }).lean();
    return sessions.map(session => ({ ...session, current: session._id.toString() === current.id }));
  }

  @Delete('sessions/:id')
  async revokeSession(@Req() req: Request, @Param('id') rawId: string, @Res({ passthrough: true }) res: Response) {
    verifyOrigin(req);
    const current = await authenticate(req, { management: true });
    const id = read(objectId, rawId);
    await UserSession.deleteOne({ _id: id, userId: current.userId });
    if (id === current.id) res.clearCookie(authCookies.customer, cookieOptions('customer'));
    return { ok: true };
  }
}

function invalidAccountLink() {
  return new BadRequestException('Liên kết không hợp lệ hoặc đã hết hạn.');
}
