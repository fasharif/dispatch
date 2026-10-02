import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTokens } from '../../src/auth/device-tokens.js';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrator.js';
import { RedisThrottlerStorage } from '../../src/common/throttle.js';
import type { DeviceDto, DriverDto } from '@dispatch/shared';
import {
  Api,
  DISPATCHER_EMAIL,
  createDelivery,
  enrolDriver,
  fix,
  moveTo,
  resetState,
  sendFixes,
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

    it('uses an enrolment code once', async () => {
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
      expect((await anonymous.as(first.body.deviceToken).get('/v1/driver/me')).status).toBe(200);
      const stored = await t.db.one<{ token_hash: string }>(
        'SELECT token_hash FROM devices WHERE id = $1',
        [first.body.deviceId],
      );
      expect(stored.token_hash).not.toContain(first.body.deviceToken);
      expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('lost phones and drivers who leave', () => {
    it('revokes a phone from the console: its token is refused and the driver goes off shift', async () => {
      const dispatcher = await anonymous.login();
      const driver = await enrolDriver(dispatcher, 'Omar');
      await moveTo(driver, 25.14, 55.22);
      expect((await driver.api.get('/v1/driver/me')).status).toBe(200);

      const listed = await dispatcher.get<DeviceDto[]>(`/v1/drivers/${driver.id}/devices`);
      expect(listed.body).toEqual([
        expect.objectContaining({ id: driver.deviceId, name: "Omar's phone", revokedAt: null }),
      ]);
      // A device token cannot manage devices, not even its own.
      expect(
        (await driver.api.post(`/v1/drivers/${driver.id}/devices/${driver.deviceId}/revoke`))
          .status,
      ).toBe(401);

      const revoked = await dispatcher.post<DeviceDto>(
        `/v1/drivers/${driver.id}/devices/${driver.deviceId}/revoke`,
      );
      expect(revoked.status).toBe(200);
      expect(revoked.body.revokedAt).not.toBeNull();
      const me = await driver.api.get<{ message: string }>('/v1/driver/me');
      expect(me.status).toBe(401);
      expect(me.body.message).toMatch(/revoked/);
      expect((await sendFixes(driver, [fix(driver, 25.15, 55.23)])).status).toBe(401);

      // Without a working phone the driver is not offered for automatic assignment.
      const drivers = await dispatcher.get<DriverDto[]>('/v1/drivers');
      expect(drivers.body.find((d) => d.id === driver.id)?.status).toBe('offline');
      const delivery = await createDelivery(dispatcher);
      expect((await dispatcher.post(`/v1/deliveries/${delivery.id}/assign`, {})).status).toBe(409);

      // Revoking again changes nothing; another driver's phone is not found under this driver.
      const again = await dispatcher.post<DeviceDto>(
        `/v1/drivers/${driver.id}/devices/${driver.deviceId}/revoke`,
      );
      expect(again.body.revokedAt).toBe(revoked.body.revokedAt);
      const other = await enrolDriver(dispatcher, 'Sara');
      expect(
        (await dispatcher.post(`/v1/drivers/${driver.id}/devices/${other.deviceId}/revoke`)).status,
      ).toBe(404);
      expect((await other.api.get('/v1/driver/me')).status).toBe(200);
    });

    it('keeps a driver with a delivery in hand busy when the phone is revoked', async () => {
      const dispatcher = await anonymous.login();
      const driver = await enrolDriver(dispatcher, 'Omar');
      await moveTo(driver, 25.1415, 55.2263);
      const delivery = await createDelivery(dispatcher);
      expect((await dispatcher.post(`/v1/deliveries/${delivery.id}/assign`, {})).status).toBe(200);
      await dispatcher.post(`/v1/drivers/${driver.id}/devices/${driver.deviceId}/revoke`);
      const drivers = await dispatcher.get<DriverDto[]>('/v1/drivers');
      expect(drivers.body.find((d) => d.id === driver.id)).toMatchObject({
        status: 'busy',
        activeDeliveryId: delivery.id,
      });
      // The phone cannot act on the delivery any more; the dispatcher cancels or reassigns it.
      expect((await driver.api.post(`/v1/driver/deliveries/${delivery.id}/pickup`)).status).toBe(
        401,
      );
    });

    it('revokes the old phone when the driver enrols a new one', async () => {
      const dispatcher = await anonymous.login();
      const driver = await enrolDriver(dispatcher, 'Omar');
      const code = await dispatcher.post<{ code: string }>(
        `/v1/drivers/${driver.id}/enrolment-codes`,
      );
      const second = await anonymous.post<{ deviceId: string; deviceToken: string }>(
        '/v1/devices/enrol',
        { code: code.body.code, deviceName: 'New phone' },
      );
      expect(second.status).toBe(201);
      expect((await driver.api.get('/v1/driver/me')).status).toBe(401);
      expect((await anonymous.as(second.body.deviceToken).get('/v1/driver/me')).status).toBe(200);
      const devices = await dispatcher.get<DeviceDto[]>(`/v1/drivers/${driver.id}/devices`);
      expect(devices.body.map((d) => [d.name, d.revokedAt === null])).toEqual([
        ['New phone', true],
        ["Omar's phone", false],
      ]);
    });

    it('deactivates a driver who has left: phones and codes stop working, and no assignment', async () => {
      const dispatcher = await anonymous.login();
      const driver = await enrolDriver(dispatcher, 'Omar');
      await moveTo(driver, 25.1415, 55.2263);
      const unused = await dispatcher.post<{ code: string }>(
        `/v1/drivers/${driver.id}/enrolment-codes`,
      );

      // Refused while the driver carries a delivery.
      const delivery = await createDelivery(dispatcher);
      await dispatcher.post(`/v1/deliveries/${delivery.id}/assign`, {});
      const refused = await dispatcher.post<{ message: string }>(
        `/v1/drivers/${driver.id}/deactivate`,
      );
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/reassign or cancel it first/);
      await dispatcher.post(`/v1/deliveries/${delivery.id}/cancel`, { reason: 'Test' });

      const deactivated = await dispatcher.post<DriverDto>(`/v1/drivers/${driver.id}/deactivate`);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body).toMatchObject({ status: 'offline', activeDeliveryId: null });
      expect(deactivated.body.deactivatedAt).not.toBeNull();
      expect((await driver.api.get('/v1/driver/me')).status).toBe(401);
      expect(
        (
          await anonymous.post('/v1/devices/enrol', {
            code: unused.body.code,
            deviceName: 'Spare phone',
          })
        ).status,
      ).toBe(401);
      expect((await dispatcher.post(`/v1/drivers/${driver.id}/enrolment-codes`)).status).toBe(409);
      const next = await createDelivery(dispatcher);
      expect((await dispatcher.post(`/v1/deliveries/${next.id}/assign`, {})).status).toBe(409);
      expect(
        (await dispatcher.post(`/v1/deliveries/${next.id}/assign`, { driverId: driver.id })).status,
      ).toBe(409);
      // Deactivating twice is harmless.
      expect((await dispatcher.post(`/v1/drivers/${driver.id}/deactivate`)).status).toBe(200);
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

    it('refuses an address that keeps sending invalid device tokens, before looking them up', async () => {
      const strict = await startApp({ AUTH_FAILURE_LIMIT: '3' }, { instanceId: 'strict' });
      try {
        await resetState(strict.db, strict.redis);
        const lookups = vi.spyOn(strict.app.get(DeviceTokens), 'resolve');
        const api = new Api(strict.url);
        const dispatcher = await api.login();
        const driver = await enrolDriver(dispatcher, 'Omar', false);
        // A token that is not even shaped like one is refused without a database lookup.
        expect((await api.as('not-a-device-token').get('/v1/driver/me')).status).toBe(401);
        expect(lookups).not.toHaveBeenCalled();

        const invalid = `dvc_${'A'.repeat(43)}`;
        const statuses = [];
        for (let i = 0; i < 3; i += 1) {
          statuses.push((await api.as(invalid).get('/v1/driver/me')).status);
        }
        // Four failures in the minute, one more than the limit: the address is blocked.
        expect(statuses).toEqual([401, 401, 429]);
        expect(lookups).toHaveBeenCalledTimes(3);

        // Blocked: even a valid token from this address waits, and nothing is looked up.
        lookups.mockClear();
        const blocked = await api
          .as(driver.api.token ?? '')
          .get<{ message: string }>('/v1/driver/me');
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(blocked.body.message).toMatch(/invalid device token/);
        expect(lookups).not.toHaveBeenCalled();
      } finally {
        await strict.close();
      }
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
      expect(applied.rows).toEqual([{ version: '0001' }, { version: '0002' }]);
    } finally {
      await pool.end();
    }
  });
});
