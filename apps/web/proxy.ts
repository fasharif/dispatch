import { NextResponse, type NextRequest } from 'next/server';
import { API_URL, BASEMAP_URL } from '@/lib/config';
import { contentSecurityPolicy } from '@/lib/csp';

/**
 * Sets a Content-Security-Policy with a fresh nonce on every page. Next.js reads the nonce from
 * the request's policy and puts it on its own scripts, which is why the pages render per request.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  // Behind nginx the Host header carries the port the browser used (deploy/nginx.conf).
  const protocol = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol;
  const host = request.headers.get('host') ?? request.nextUrl.host;
  const policy = contentSecurityPolicy({
    nonce,
    apiUrl: API_URL,
    basemapUrl: BASEMAP_URL,
    pageOrigin: `${protocol.replace(/:$/, '')}://${host}`,
    development: process.env.NODE_ENV === 'development',
  });

  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not Next.js assets, the MapLibre worker and plugin, or the basemap extract.
      source: '/((?!_next/static|_next/image|vendor/|tiles/|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
