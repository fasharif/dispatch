import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://localhost/dispatch',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(40),
  TRACKING_TOKEN_SECRET: 'b'.repeat(40),
};

describe('loadConfig', () => {
  it('fails fast with every missing setting named', () => {
    expect(() => loadConfig({})).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL|REDIS_URL[\s\S]*DATABASE_URL/,
    );
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET must be at least 32 characters/,
    );
  });

  it('applies documented defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      env: 'development',
      port: 3000,
      role: 'all',
      geofence: { radiusM: 150, accuracyAllowanceM: 50 },
      drivers: { staleAfterS: 120 },
      webhooks: { url: undefined, maxAttempts: 8, backoffMs: 2000 },
      eta: { osrmUrl: undefined, speedKmh: 30, detourFactor: 1.4 },
    });
  });

  it('requires a webhook secret whenever a webhook URL is set', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_URL: 'https://topflow.example/hooks' })).toThrow(
      /WEBHOOK_SECRET/,
    );
    const config = loadConfig({
      ...base,
      WEBHOOK_URL: 'https://topflow.example/hooks',
      WEBHOOK_SECRET: 'c'.repeat(32),
    });
    expect(config.webhooks.url).toBe('https://topflow.example/hooks');
  });

  it('treats empty optional URLs as unset', () => {
    const config = loadConfig({ ...base, WEBHOOK_URL: '', OSRM_URL: '' });
    expect(config.webhooks.url).toBeUndefined();
    expect(config.eta.osrmUrl).toBeUndefined();
  });

  it('refuses published example secrets in production unless explicitly allowed', () => {
    const example = {
      ...base,
      NODE_ENV: 'production',
      JWT_SECRET: 'change-me-dispatcher-session-secret-000000000000',
    };
    expect(() => loadConfig(example)).toThrow(/JWT_SECRET is a published example value/);
    // Allowed for a local stack, but named so the process can warn about them.
    expect(
      loadConfig({ ...example, ALLOW_INSECURE_LOCAL_SECRETS: 'true' }).exampleSecretsAllowed,
    ).toEqual(['JWT_SECRET']);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).exampleSecretsAllowed).toEqual([]);
    expect(
      loadConfig({ ...base, JWT_SECRET: example.JWT_SECRET, ALLOW_INSECURE_LOCAL_SECRETS: 'true' })
        .exampleSecretsAllowed,
    ).toEqual([]);
  });

  it('parses lists and strips trailing slashes', () => {
    const config = loadConfig({
      ...base,
      CORS_ORIGINS: 'http://a.test, http://b.test',
      PUBLIC_WEB_URL: 'https://track.example/',
      OSRM_URL: 'http://osrm:5000/',
    });
    expect(config.http.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(config.tracking.publicWebUrl).toBe('https://track.example');
    expect(config.eta.osrmUrl).toBe('http://osrm:5000');
  });
});
