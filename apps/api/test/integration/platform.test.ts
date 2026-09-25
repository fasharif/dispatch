import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrator.js';
import { RedisThrottlerStorage } from '../../src/common/throttle.js';
import {
  Api,
  DISPATCHER_EMAIL,
  enrolDriver,
  resetState,
  startApp,
  type TestApp,
} from '../support/harness.js';

describe('platform', () => {
  let t: TestApp;
  let anonymous: Api;

  beforeAll(async () => {
    t = await startApp();
    anonymous = new Api(t.url);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetState(t.db, t.redis);
  });

  it('reports liveness and readiness with the instance that answered', async () => {
    const ready = await anonymous.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      status: 'ok',
      database: 'up',
      redis: 'up',
      instance: 'test',
    });
    expect(ready.headers.get('x-served-by')).toBe('test');
  });

  it('returns one error envelope with a request id', async () => {
    const res = await anonymous.post<{ statusCode: number; requestId: string; details: unknown[] }>(
      '/v1/auth/login',
      { email: 'not-an-email' },
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(res.headers.get('x-request-id')).toBe(res.body.requestId);
  });

  describe('authentication', () => {
    it('signs a dispatcher in and refuses a wrong password with the same message as an unknown email', async () => {
      const ok = await anonymous.post<{ accessToken: string; dispatcher: { email: string } }>(
        '/v1/auth/login',
        {
          email: DISPATCHER_EMAIL.toUpperCase(),
          password: 'correct horse battery staple',
        },
      );
      expect(ok.status).toBe(200);
      expect(ok.body.dispatcher.email).toBe(DISPATCHER_EMAIL);

      const wrong = await anonymous.post<{ message: string }>('/v1/auth/login', {
        email: DISPATCHER_EMAIL,
        password: 'wrong',
      });
      const unknown = await anonymous.post<{ message: string }>('/v1/auth/login', {
        email: 'nobody@test.local',
        password: 'wrong',
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('keeps each kind of credential to its own routes', async () => {
      const dispatcher = await anonymous.login();
      const driver = await enrolDriver(dispatcher, 'Omar');

      expect((await anonymous.get('/v1/deliveries')).status).toBe(401);
      expect((await anonymous.as('not-a-token').get('/v1/deliveries')).status).toBe(401);
      // A device token cannot act as a dispatcher, nor a dispatcher token as a device.
      expect((await driver.api.get('/v1/deliveries')).status).toBe(401);
      expect((await dispatcher.get('/v1/driver/me')).status).toBe(401);
      expect((await driver.api.get('/v1/driver/me')).status).toBe(200);
    });

    it('uses an enrolment code once, and stops a revoked device', async () => {
      const dispatcher = await anonymous.login();
      const created = await dispatcher.post<{ enrolment: { code: string } }>('/v1/drivers', {
        name: 'Sara',
      });
      const code = created.body.enrolment.code;
      const first = await anonymous.post<{ deviceId: string; deviceToken: string }>(
        '/v1/devices/enrol',
        {
          code: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`,
          deviceName: 'Pixel',
        },
      );
      expect(first.status).toBe(201);
      expect(
        (await anonymous.post('/v1/devices/enrol', { code, deviceName: 'Pixel' })).status,
      ).toBe(401);

      const device = anonymous.as(first.body.deviceToken);
      expect((await device.get('/v1/driver/me')).status).toBe(200);
      await t.db.query('UPDATE devices SET revoked_at = now() WHERE id = $1', [
        first.body.deviceId,
      ]);
      expect((await device.get('/v1/driver/me')).status).toBe(401);
      const stored = await t.db.one<{ token_hash: string }>(
        'SELECT token_hash FROM devices WHERE id = $1',
        [first.body.deviceId],
      );
      expect(stored.token_hash).not.toContain(first.body.deviceToken);
      expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('rate limiting in Redis', () => {
    it('counts per key across a window and blocks above the limit', async () => {
      const storage = new RedisThrottlerStorage(t.redis.client);
      const hits = [];
      for (let i = 0; i < 4; i += 1) hits.push(await storage.increment('k', 60_000, 3, 0, 'test'));
      expect(hits.map((h) => h.totalHits)).toEqual([1, 2, 3, 4]);
      expect(hits.map((h) => h.isBlocked)).toEqual([false, false, false, true]);
      expect(hits[3]?.timeToBlockExpire).toBeGreaterThan(0);
      expect((await storage.increment('other', 60_000, 3, 0, 'test')).isBlocked).toBe(false);
    });

    it('answers 429 once a caller exceeds the login limit', async () => {
      const strict = await startApp({ AUTH_THROTTLE_LIMIT: '3' }, { instanceId: 'strict' });
      const previous = process.env.AUTH_THROTTLE_LIMIT;
      process.env.AUTH_THROTTLE_LIMIT = '3';
      try {
        const api = new Api(strict.url);
        const statuses = [];
        for (let i = 0; i < 5; i += 1) {
          statuses.push(
            (await api.post('/v1/auth/login', { email: 'x@test.local', password: 'x' })).status,
          );
        }
        expect(statuses).toEqual([401, 401, 401, 429, 429]);
      } finally {
        process.env.AUTH_THROTTLE_LIMIT = previous;
        await strict.close();
      }
    });
  });
});

describe('database', () => {
  it('measures distances on the ellipsoid (reference value used by the unit tests)', async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const { rows } = await pool.query<{ d: number }>(
        `SELECT ST_Distance('POINT(55.274376 25.197197)'::geography,
                            'POINT(55.14065 25.07625)'::geography) AS d`,
      );
      expect(Math.round(rows[0]?.d ?? 0)).toBe(19_009);
    } finally {
      await pool.end();
    }
  });

  it('applies migrations once and refuses an applied migration that was edited', async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      expect(await migrate(pool)).toEqual([]);

      const edited = mkdtempSync(join(tmpdir(), 'dispatch-migrations-'));
      cpSync(MIGRATIONS_DIR, edited, { recursive: true });
      writeFileSync(join(edited, '0001_init.sql'), '-- edited after release\n');
      await expect(migrate(pool, edited)).rejects.toThrow(/was changed after it was applied/);

      const applied = await pool.query('SELECT version FROM schema_migrations');
      expect(applied.rows).toEqual([{ version: '0001' }]);
    } finally {
      await pool.end();
    }
  });
});
