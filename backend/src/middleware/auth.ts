import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { ClientSession } from 'mongoose';
import { objectId } from '../validators/common';
import { PlatformGrant, User, UserSession } from '../models';
import { canAdmin } from './policy';

const jueeWeb = ['https://juee-pos-web.netlify.app', 'https://juee-pos-web.onrender.com'];

export function customerWebOrigins(env = process.env) {
  const primary = env.WEB_ORIGIN;
  if (!primary) return [];
  const secondary = env.SECONDARY_WEB_ORIGIN?.trim() ?? (jueeWeb.includes(primary) ? jueeWeb.find(site => site !== primary) : undefined);
  return secondary && secondary !== primary ? [primary, secondary] : [primary];
}

export function signingSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-with')) {
    throw new Error('JWT_SECRET must be a random secret of at least 32 characters');
  }
  return secret;
}

export function verifyOrigin(req: Request) {
  const origin = req.get('origin');
  if (!origin || !customerWebOrigins().includes(origin)) throw new ForbiddenException();
}

export type SessionSurface = 'customer' | 'admin';
export const sessionIssuer = (surface: SessionSurface) => surface === 'admin' ? 'juee-pos-admin' : 'juee-pos';
export const sessionSurfaceFilter = (surface: SessionSurface) => surface === 'admin' ? { surface } : { surface: { $in: ['customer' as const, null] } };

export function adminWebOrigin(env = process.env) {
  return env.ADMIN_WEB_ORIGIN || (env.NODE_ENV === 'production' ? undefined : 'http://127.0.0.1:3002');
}

export function verifyAdminOrigin(req: Request) {
  const origin = adminWebOrigin();
  if (!origin || req.get('origin') !== origin) throw new ForbiddenException('Hãy đăng nhập từ địa chỉ quản trị.');
}

type AuthOptions = { management?: boolean; session?: ClientSession; surface?: SessionSurface };

export function authenticate(req: Request, options?: AuthOptions) {
  return authenticateToken(req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1], options);
}

export async function authenticateToken(token?: string, options: AuthOptions = {}) {
  if (!token) throw new UnauthorizedException();
  const surface = options.surface ?? 'customer';
  let sessionId: string;
  let modeVersion: string | undefined;
  try {
    const payload = jwt.verify(token, signingSecret(), { algorithms: ['HS256'], issuer: sessionIssuer(surface) });
    if (typeof payload === 'string') throw new Error();
    sessionId = objectId.parse(payload.sub);
    modeVersion = typeof payload.modeVersion === 'string' ? payload.modeVersion : undefined;
  } catch {
    throw new UnauthorizedException();
  }
  const filter = { _id: sessionId, ...sessionSurfaceFilter(surface), modeVersion: modeVersion ?? null, expiresAt: { $gt: new Date() } };
  const session = options.session
    ? await UserSession.findOneAndUpdate(filter, { $set: { workWriteToken: randomUUID() } }, { session: options.session, timestamps: false }).lean()
    : await UserSession.findOne(filter).lean();
  if (!session) throw new UnauthorizedException();
  if (options.management && session.staffMode) throw new ForbiddenException('Hãy chuyển về chế độ Quản lý để thực hiện thao tác này.');
  const user = await User.findOne({ _id: session.userId, locked: { $ne: true } }).session(options.session ?? null).select('email name').lean();
  if (!user) throw new UnauthorizedException();
  const grant = !session.staffMode && await PlatformGrant.findOne({ userId: user._id }).session(options.session ?? null).select('permissions').lean();
  if (surface === 'admin' ? !canAdmin(session.mfa, grant ? grant.permissions : [], 'platform.read') : grant) throw new UnauthorizedException();
  return { ...session, id: session._id.toString(), userId: session.userId.toString(),
    user: { ...user, id: user._id.toString(), platformGrant: grant || null } };
}

export async function platformActor(req: Request, permission: string) {
  const session = await authenticate(req, { management: true, surface: 'admin' });
  if (!canAdmin(session.mfa, session.user.platformGrant?.permissions ?? [], permission)) {
    throw new ForbiddenException();
  }
  return session.user.id;
}
