import { NextResponse } from 'next/server';

export function middleware() {
  return new NextResponse(null, { status: 404 });
}

export const config = { matcher: ['/api/v1/admin-auth/:path*', '/api/v1/platform/:path*'] };
