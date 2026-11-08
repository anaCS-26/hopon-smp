// Per-request CSP nonce (Next.js 16 "proxy", formerly middleware). Auth is NOT done here:
// every page and route handler checks the session itself (see ADR 0001, CVE-2025-29927).
import { NextRequest, NextResponse } from 'next/server';

function originOf(url: string | undefined) {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const uploadOrigin = originOf(process.env.NEXT_PUBLIC_AGENT_UPLOAD_ORIGIN);
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // React renders some style="" attributes; style injection is low risk next to script injection.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https://cdn.modrinth.com https://cdn.discordapp.com`,
    `font-src 'self'`,
    `connect-src 'self'${uploadOrigin ? ` ${uploadOrigin}` : ''}${isDev ? ' ws:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self' https://discord.com`,
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
