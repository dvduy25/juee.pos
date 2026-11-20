import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AccountToken, type AccountTokenKind } from '../models';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import nodemailer from 'nodemailer';
import { isDuplicate } from '../utils/db';

const logger = new Logger('AccountEmail');

export function accountMailConfigured(env = process.env) {
  return Boolean(env.SMTP_URL?.trim() && env.MAIL_FROM?.trim());
}

export function signupNeedsVerification(env = process.env) {
  if (accountMailConfigured(env)) return true;
  const host = env.BIND_HOST ?? '127.0.0.1';
  const origin = env.WEB_ORIGIN ?? '';
  const localWeb = URL.canParse(origin) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  const localSignup = (env.NODE_ENV === 'test' || (env.NODE_ENV === 'development' && env.ALLOW_UNVERIFIED_LOCAL_SIGNUP === 'true')) &&
    ['127.0.0.1', '::1'].includes(host) && localWeb;
  return !localSignup;
}

export function tokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function verificationDigest(email: string, code: string) {
  return createHmac('sha256', process.env.JWT_SECRET!).update(`verify-email:${email}:${code}`).digest('hex');
}

export function requireAccountMail() {
  if (!accountMailConfigured()) throw new ServiceUnavailableException('Dịch vụ email chưa được cấu hình.');
}

export async function requestAccountLink(user: { id: string; email: string }, kind: AccountTokenKind) {
  requireAccountMail();
  const verify = kind === 'VERIFY_EMAIL';
  const token = verify ? String(randomInt(100000, 1000000)) : randomBytes(32).toString('hex');
  const digest = verify ? verificationDigest(user.email, token) : tokenDigest(token);
  const issuedAt = new Date();
  const expiresAt = new Date(+issuedAt + (verify ? 10 : 30) * 60000);
  const cooldown = verify ? { $or: [{ issuedAt: null }, { issuedAt: { $lte: new Date(+issuedAt - 60000) } }] } : {};
  try {
    await AccountToken.updateOne({ userId: user.id, kind, ...cooldown }, { $set: { digest, expiresAt, issuedAt, attempts: 0 } },
      { upsert: true, runValidators: true });
  } catch (error) {
    if (verify && isDuplicate(error)) return false;
    throw error;
  }

  const url = new URL(verify ? '/verify-email' : '/reset-password', process.env.WEB_ORIGIN);
  url.hash = new URLSearchParams(verify ? { email: user.email } : { token }).toString();
  const smtp = new URL(process.env.SMTP_URL!);
  const secure = smtp.protocol === 'smtps:';
  const transport = nodemailer.createTransport({
    host: smtp.hostname, port: smtp.port ? Number(smtp.port) : secure ? 465 : 587, secure,
    requireTLS: !secure && process.env.NODE_ENV === 'production',
    auth: smtp.username ? { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) } : undefined,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
  });
  try {
    const result = await transport.sendMail({
      from: process.env.MAIL_FROM,
      to: user.email,
      subject: verify ? 'Xác minh email JUEE POS' : 'Đặt lại mật khẩu JUEE POS',
      text: verify ? `Mã xác minh JUEE POS của bạn là ${token}. Mã có hiệu lực trong 10 phút.\n\n${url}` :
        `Dùng liên kết sau trong vòng 30 phút để đặt lại mật khẩu.\n\n${url}`,
    });
    if (!result.accepted.length) throw new Error('No recipient accepted');
    return true;
  } catch {
    await AccountToken.deleteOne({ digest });
    logger.warn(`Không gửi được email loại ${kind}`);
    return false;
  } finally {
    transport.close();
  }
}
