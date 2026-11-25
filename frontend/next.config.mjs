import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @returns {import('next').NextConfig} */
export default function config(phase) {
  const origin = process.env.API_ORIGIN ?? 'http://127.0.0.1:5000';
  const api = URL.canParse(origin) ? new URL(origin) : undefined;
  const directAiOrigin = process.env.NETLIFY === 'true' && api?.protocol === 'https:' &&
    (origin === api.origin || origin === api.origin + '/') ? api.origin : '';
  return {
    poweredByHeader: false,
    env: { NEXT_PUBLIC_INVENTORY_AI_ORIGIN: directAiOrigin },
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    async headers() {
      return [{ source: '/:path*', headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'geolocation=(self)' },
      ] }];
    },
    async redirects() {
      return [
        { source: '/dashboard', has: [{ type: 'query', key: 'register' }], destination: '/register', permanent: false },
        { source: '/gioi-thieu', destination: '/', permanent: true },
        { source: '/gioi-thieu/index.html', destination: '/', permanent: true },
        { source: '/juee-site/index.html', destination: '/', permanent: true },
      ];
    },
    async rewrites() {
      return [
        { source: '/api/v1/:path*', destination: `${origin}/api/v1/:path*` },
        { source: '/docs/:path*', destination: `${origin}/docs/:path*` },
        { source: '/docs-json', destination: `${origin}/docs-json` },
      ];
    },
  };
}
