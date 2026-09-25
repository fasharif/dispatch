import { ENROLMENT_CODE_ALPHABET } from '@dispatch/shared';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { bearerToken } from './auth.decorators.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import {
  AccessTokens,
  InvalidAccessToken,
  newDeviceToken,
  newEnrolmentCode,
  sha256Hex,
} from './tokens.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://localhost/dispatch',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'unit-test-jwt-secret-unit-test-jwt-secret',
  TRACKING_TOKEN_SECRET: 'unit-test-tracking-secret-unit-test-000',
});
const dispatcher = {
  kind: 'dispatcher' as const,
  id: '8e0b6b8e-2b4e-4d7e-9f3a-0c1d2e3f4a5b',
  email: 'd@test.local',
  name: 'D',
};

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', hash)).toBe(false);
  });

  it('salts every hash and never matches a malformed one', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('keeps one dummy hash per process for unknown accounts', async () => {
    const dummy = await dummyPasswordHash();
    expect(await dummyPasswordHash()).toBe(dummy);
    expect(await verifyPassword('anything', dummy)).toBe(false);
  });
});

describe('dispatcher access tokens', () => {
  const tokens = new AccessTokens(config);

  it('round-trips the dispatcher identity', async () => {
    const { token, expiresAt } = await tokens.issue(dispatcher);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 3_600_000);
    expect(await tokens.verify(token)).toEqual(dispatcher);
  });

  it('rejects tampered, foreign and expired tokens', async () => {
    const { token } = await tokens.issue(dispatcher);
    const [header, payload, signature] = token.split('.');
    const forged = `${header ?? ''}.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.${signature ?? ''}`;
    await expect(tokens.verify(forged)).rejects.toThrow(InvalidAccessToken);
    expect(payload).toBeDefined();

    const key = new TextEncoder().encode('unit-test-jwt-secret-unit-test-jwt-secret');
    const wrongAudience = await new SignJWT({ email: 'x', name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(dispatcher.id)
      .setIssuer('dispatch-api')
      .setAudience('someone-else')
      .setExpirationTime('1h')
      .sign(key);
    await expect(tokens.verify(wrongAudience)).rejects.toThrow(InvalidAccessToken);

    const expired = await new SignJWT({ email: 'x', name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(dispatcher.id)
      .setIssuer('dispatch-api')
      .setAudience('dispatch-console')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(key);
    await expect(tokens.verify(expired)).rejects.toThrow(InvalidAccessToken);
  });
});

describe('device credentials', () => {
  it('creates 256-bit device tokens and hashes them with SHA-256', () => {
    const token = newDeviceToken();
    expect(token).toMatch(/^dvc_[\w-]{43}$/);
    expect(newDeviceToken()).not.toBe(token);
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('draws enrolment codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newEnrolmentCode();
      expect(code).toHaveLength(8);
      for (const char of code) expect(ENROLMENT_CODE_ALPHABET).toContain(char);
    }
  });

  it('reads bearer tokens only from a well-formed header', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
