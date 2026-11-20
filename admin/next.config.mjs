import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import { fileURLToPath } from 'node:url';

export default function config(phase) {
  const development = phase === PHASE_DEVELOPMENT_SERVER;
  const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:5000';
  const origin = new URL(api);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== api || origin.username || origin.password) {
    throw new Error('API_ORIGIN must be the origin of the JUEE API.');
  }
  return {
    poweredByHeader: false,
    outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
    distDir: development ? '.next-dev' : '.next',
    async headers() {
      return [{ source: '/:path*', headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ] }];
    },
    async rewrites() {
      return [
        { source: '/api/v1/admin-auth/:path*', destination: `${origin.origin}/api/v1/admin-auth/:path*` },
        { source: '/api/v1/platform/:path*', destination: `${origin.origin}/api/v1/platform/:path*` },
      ];
    },
  };
}
