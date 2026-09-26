/**
 * Glyphs and sprites for the Protomaps basemap come from the Protomaps assets site at runtime
 * (ADR-013), and the fallback style from MapLibre's demo tiles.
 */
export const MAP_ASSET_ORIGINS = ['https://protomaps.github.io', 'https://demotiles.maplibre.org'];

export interface CspOptions {
  /** A fresh random value per response; Next.js puts it on its own scripts. */
  nonce: string;
  /** NEXT_PUBLIC_API_URL; empty means the API is on the page's own origin (behind nginx). */
  apiUrl: string;
  /** NEXT_PUBLIC_BASEMAP_URL; only an absolute URL adds an origin. */
  basemapUrl: string;
  /** The origin the browser loaded the page from, e.g. http://localhost:57080. */
  pageOrigin: string;
  /** next dev: React needs eval for its error overlay. */
  development: boolean;
}

/** The WebSocket origin (ws: or wss:) for an http(s) origin. */
function socketOrigin(origin: URL): string {
  return `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
}

/**
 * The Content-Security-Policy for the console and the tracking page. Scripts run only with this
 * response's nonce (and what they load, 'strict-dynamic'); the page may talk only to itself, the
 * API (HTTP and WebSocket) and the map asset origins; nothing may frame it. The dispatcher's
 * session token lives in the console's memory, so this is the main defence if a script injection
 * is ever found.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const page = new URL(options.pageOrigin);
  const api = options.apiUrl ? new URL(options.apiUrl) : page;
  const connect = new Set(["'self'", socketOrigin(page), api.origin, socketOrigin(api)]);
  if (/^https?:\/\//.test(options.basemapUrl)) connect.add(new URL(options.basemapUrl).origin);
  for (const origin of MAP_ASSET_ORIGINS) connect.add(origin);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // wasm-unsafe-eval: the right-to-left text plugin for Arabic map labels is WebAssembly.
    'script-src': [
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
      ...(options.development ? ["'unsafe-eval'"] : []),
    ],
    // React renders style attributes, which a nonce cannot cover.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'blob:', 'data:'],
    'font-src': ["'self'"],
    'connect-src': [...connect],
    // MapLibre's worker (public/vendor) and the blob workers some browsers fall back to.
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
