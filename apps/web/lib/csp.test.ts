import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './csp';

const directives = (policy: string): Record<string, string[]> =>
  Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name = '', ...values] = part.split(' ');
      return [name, values];
    }),
  );

describe('contentSecurityPolicy', () => {
  it('lets scripts run only with the nonce and nothing frame the page', () => {
    const policy = directives(
      contentSecurityPolicy({
        nonce: 'abc123',
        apiUrl: 'http://localhost:57100',
        basemapUrl: '/tiles/dubai.pmtiles',
        pageOrigin: 'http://localhost:57300',
        development: false,
      }),
    );
    expect(policy['script-src']).toEqual([
      "'self'",
      "'nonce-abc123'",
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
    ]);
    expect(policy['frame-ancestors']).toEqual(["'none'"]);
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['worker-src']).toEqual(["'self'", 'blob:']);
  });

  it('allows the API over HTTP and WebSocket, and the map asset origins', () => {
    const policy = directives(
      contentSecurityPolicy({
        nonce: 'n',
        apiUrl: 'https://api.example.test',
        basemapUrl: 'https://tiles.example.test/dubai.pmtiles',
        pageOrigin: 'https://console.example.test',
        development: false,
      }),
    );
    expect(policy['connect-src']).toEqual([
      "'self'",
      'wss://console.example.test',
      'https://api.example.test',
      'wss://api.example.test',
      'https://tiles.example.test',
      'https://protomaps.github.io',
      'https://demotiles.maplibre.org',
    ]);
  });

  it('uses the page origin for the API behind nginx, and allows eval only in development', () => {
    const policy = directives(
      contentSecurityPolicy({
        nonce: 'n',
        apiUrl: '',
        basemapUrl: '/tiles/dubai.pmtiles',
        pageOrigin: 'http://localhost:57080',
        development: true,
      }),
    );
    expect(policy['connect-src']?.slice(0, 3)).toEqual([
      "'self'",
      'ws://localhost:57080',
      'http://localhost:57080',
    ]);
    expect(policy['script-src']).toContain("'unsafe-eval'");
  });
});
