import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { customerWebOrigins, signingSecret } from '../middleware/auth';
import { accountEmail, label } from '../validators/common';

const authorizeEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const keysEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const stateIssuer = 'juee-pos-google-state';
const signupIssuer = 'juee-pos-google-signup';
const transactionLifetime = 600;
const random = () => randomBytes(32).toString('base64url');
const challenge = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);

export function googleFlowCookie() {
  const secure = process.env.NODE_ENV === 'production';
  return {
    name: secure ? '__Host-juee_google_flow' : 'juee_google_flow',
    options: { httpOnly: true, secure, sameSite: 'lax' as const, path: secure ? '/' : '/api/v1/auth/google' },
  };
}

export function googleSignupCookie() {
  const secure = process.env.NODE_ENV === 'production';
  return {
    name: secure ? '__Host-juee_google_signup' : 'juee_google_signup',
    options: { httpOnly: true, secure, sameSite: 'strict' as const, path: secure ? '/' : '/api/v1/auth/google' },
  };
}

const googleEntry = z.enum(['login', 'register']);
const flowOrigin = z.string().max(512).optional();
const flowSchema = z.object({ state: challenge, nonce: challenge, verifier: challenge, from: googleEntry,
  next: z.string().max(1500), origin: flowOrigin });
type Flow = z.infer<typeof flowSchema>;
const googleSubject = z.string().regex(/^[!-~]{1,255}$/);
const signupSchema = z.object({ subject: googleSubject, email: accountEmail, name: label, next: z.string().max(1500), origin: flowOrigin });
type Signup = z.infer<typeof signupSchema>;
const googleClaims = z.object({
  sub: googleSubject, email: accountEmail, email_verified: z.union([z.literal(true), z.literal('true')]),
  nonce: challenge, exp: z.number().int(), iat: z.number().int(), aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(), hd: z.string().trim().min(1).max(253).optional(), name: z.string().optional(),
});
const publicKeys = z.object({ keys: z.array(z.object({
  kty: z.literal('RSA'), kid: z.string().min(1).max(128), n: z.string().min(1), e: z.string().min(1),
})) });

export function googleConfig(env = process.env, origin: unknown = env.WEB_ORIGIN) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || typeof origin !== 'string' || !customerWebOrigins(env).includes(origin)) return undefined;
  return { clientId, clientSecret, callback: new URL('/api/v1/auth/google/callback', origin).href, origin };
}

type Config = NonNullable<ReturnType<typeof googleConfig>>;

export function googleDestination(value: string, origin: string) {
  if (value.length <= 1500 && /^\/dashboard(?:[/?#]|$)/.test(value)) {
    const target = new URL(value, origin);
    if (target.origin === origin && /^\/dashboard(?:\/|$)/.test(target.pathname)) {
      return target.pathname + target.search + target.hash;
    }
  }
  return '/dashboard';
}

export function beginGoogle(config: Config, from: Flow['from'], next: string) {
  const flow: Flow = { state: random(), nonce: random(), verifier: random(), from,
    next: googleDestination(next, config.origin), origin: config.origin };
  const cookie = jwt.sign(flow, signingSecret(), { issuer: stateIssuer, expiresIn: transactionLifetime, algorithm: 'HS256' });
  const url = new URL(authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.callback, response_type: 'code',
    scope: 'openid email profile', state: flow.state, nonce: flow.nonce,
    code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256',
    prompt: 'select_account', hl: 'vi',
  }).toString();
  return { cookie, url: url.href, maxAge: transactionLifetime * 1000 };
}

export function readGoogleFlow(raw: string | undefined): Flow | undefined {
  if (!raw || raw.length > 3500) return undefined;
  try {
    return flowSchema.parse(jwt.verify(raw, signingSecret(), { issuer: stateIssuer, algorithms: ['HS256'] }));
  } catch {
    return undefined;
  }
}

export function beginGoogleSignup({ subject, email, name, next, origin }: Signup) {
  const cookie = jwt.sign({ subject, email, name, next, origin }, signingSecret(), { issuer: signupIssuer, expiresIn: transactionLifetime, algorithm: 'HS256' });
  return { cookie, maxAge: transactionLifetime * 1000 };
}

export function readGoogleSignup(raw: string | undefined): Signup | undefined {
  if (!raw || raw.length > 3500) return undefined;
  try {
    return signupSchema.parse(jwt.verify(raw, signingSecret(), { issuer: signupIssuer, algorithms: ['HS256'] }));
  } catch {
    return undefined;
  }
}

let cachedKeys: { keys: Map<string, KeyObject>; expiresAt: number; loadedAt: number } | undefined;
let fetchingKeys: Promise<NonNullable<typeof cachedKeys>> | undefined;

async function loadKeys() {
  const response = await fetch(keysEndpoint, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Google identity keys unavailable');
  const { keys } = publicKeys.parse(await response.json());
  const loadedAt = Date.now();
  const seconds = Number(response.headers.get('cache-control')?.match(/(?:^|[, ])max-age=(\d+)/i)?.[1] ?? 60);
  return {
    keys: new Map(keys.map(({ kid, ...key }) => [kid, createPublicKey({ key, format: 'jwk' })])),
    loadedAt, expiresAt: loadedAt + Math.min(seconds, 21600) * 1000,
  };
}

async function googleKey(keyId: string) {
  const now = Date.now();
  if (!cachedKeys || now >= cachedKeys.expiresAt || (!cachedKeys.keys.has(keyId) && now - cachedKeys.loadedAt >= 30000)) {
    fetchingKeys ??= loadKeys().finally(() => { fetchingKeys = undefined; });
    cachedKeys = await fetchingKeys;
  }
  const key = cachedKeys.keys.get(keyId);
  if (!key) throw new Error('Google identity key not found');
  return key;
}

export async function exchangeGoogleCode(config: Config, flow: Flow, code: string) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: config.callback,
      client_id: config.clientId, client_secret: config.clientSecret, code_verifier: flow.verifier,
    }),
  });
  if (!response.ok) throw new Error('Google authorization could not be completed');
  const { id_token: token } = z.object({ id_token: z.string().max(16000) }).parse(await response.json());
  const header = jwt.decode(token, { complete: true })?.header;
  if (header?.alg !== 'RS256' || !header.kid || header.kid.length > 128) throw new Error('Invalid Google token header');
  const key = await googleKey(header.kid);
  const claims = googleClaims.parse(jwt.verify(token, key, {
    algorithms: ['RS256'], audience: config.clientId,
    issuer: ['https://accounts.google.com', 'accounts.google.com'], maxAge: '10m', clockTolerance: 5,
  }));
  if (claims.nonce !== flow.nonce || claims.iat > Math.floor(Date.now() / 1000) + 5 ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId)) {
    throw new Error('Invalid Google token claims');
  }
  return {
    subject: claims.sub, email: claims.email,
    name: claims.name?.trim().slice(0, 120) || claims.email.split('@', 1)[0].slice(0, 120),
    emailAuthoritative: claims.email.endsWith('@gmail.com') || !!claims.hd,
  };
}
