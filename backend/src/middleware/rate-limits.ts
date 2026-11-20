import { rateLimit } from 'express-rate-limit';

type Limit = {
  windowMs: number;
  limit: number;
  message: string;
  postOnly?: boolean;
  skipSuccessfulRequests?: boolean;
};

export function apiRateLimit({ windowMs, limit, message, postOnly = false, skipSuccessfulRequests = false }: Limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    skip: request => request.method === 'OPTIONS' || (postOnly && request.method !== 'POST'),
    message: { statusCode: 429, message },
  });
}

export function authLimitWindow(mode: string | undefined, bindHost: string, webOrigin: URL) {
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  const localDevelopment = mode === 'development' &&
    ['127.0.0.1', '::1'].includes(bindHost) &&
    loopback.includes(webOrigin.hostname);
  return localDevelopment ? 60_000 : 900_000;
}
