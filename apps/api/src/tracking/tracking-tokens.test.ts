import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { TrackingTokens } from './tracking-tokens.js';

const env = {
  DATABASE_URL: 'postgresql://localhost/dispatch',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'unit-test-jwt-secret-unit-test-jwt-secret',
  TRACKING_TOKEN_SECRET: 'unit-test-tracking-secret-unit-test-000',
};
const tokens = new TrackingTokens(loadConfig(env));
const deliveryId = '3f1c2b9a-6d4e-4f8a-9b7c-1a2b3c4d5e6f';
const inOneHour = () => new Date(Date.now() + 3_600_000);

describe('tracking links', () => {
  it('round-trips the delivery id and expiry', () => {
    const expiresAt = inOneHour();
    const token = tokens.sign(deliveryId, expiresAt);
    expect(token).toMatch(/^v1\.[\w-]+\.[\w-]{43}$/);
    expect(tokens.verify(token)).toEqual({
      status: 'valid',
      deliveryId,
      expiresAt: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000),
    });
  });

  it('reports an expired link separately from a forged one', () => {
    const token = tokens.sign(deliveryId, new Date(Date.now() - 1000));
    expect(tokens.verify(token).status).toBe('expired');
  });

  it('rejects a payload changed to point at another delivery or a later expiry', () => {
    const token = tokens.sign(deliveryId, inOneHour());
    const [version, , signature] = token.split('.');
    const otherDelivery = Buffer.from(
      JSON.stringify({ d: '00000000-0000-4000-8000-000000000000', e: 4_102_444_800 }),
    ).toString('base64url');
    expect(tokens.verify(`${version ?? ''}.${otherDelivery}.${signature ?? ''}`)).toEqual({
      status: 'invalid',
    });
  });

  it('rejects links signed with another secret, and malformed input', () => {
    const other = new TrackingTokens(loadConfig({ ...env, TRACKING_TOKEN_SECRET: 'x'.repeat(40) }));
    expect(tokens.verify(other.sign(deliveryId, inOneHour()))).toEqual({ status: 'invalid' });
    for (const bad of ['', 'v1', 'v1..', 'v2.a.b', 'v1.e30.AAAA', 'v1.!!!.???', 'a.b.c.d']) {
      expect(tokens.verify(bad)).toEqual({ status: 'invalid' });
    }
  });

  it('rejects a correctly signed payload that is not a delivery reference', () => {
    const payload = Buffer.from(JSON.stringify({ d: 'not-a-uuid', e: 4_102_444_800 })).toString(
      'base64url',
    );
    const signature = createHmac('sha256', env.TRACKING_TOKEN_SECRET)
      .update(`v1.${payload}`)
      .digest('base64url');
    expect(tokens.verify(`v1.${payload}.${signature}`)).toEqual({ status: 'invalid' });
  });
});
