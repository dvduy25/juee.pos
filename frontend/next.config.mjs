import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @returns {import('next').NextConfig} */
export default function config(phase) {
  return {
    poweredByHeader: false,
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
      return [{ source: '/dashboard', has: [{ type: 'query', key: 'register' }], destination: '/register', permanent: false }];
    },
    async rewrites() {
      const origin = process.env.API_ORIGIN ?? 'http://127.0.0.1:5000';
      return [
        { source: '/gioi-thieu', destination: '/gioi-thieu/index.html' },
        { source: '/api/v1/:path*', destination: `${origin}/api/v1/:path*` },
        { source: '/docs/:path*', destination: `${origin}/docs/:path*` },
        { source: '/docs-json', destination: `${origin}/docs-json` },
      ];
    },
  };
}
