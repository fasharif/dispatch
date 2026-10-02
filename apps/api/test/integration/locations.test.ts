import type { DriverDto } from '@dispatch/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOCATION_STREAM_KEY, LocationStream } from '../../src/realtime/location-stream.js';
import {
  Api,
  enrolDriver,
  fix,
  resetState,
  sendFixes,
  startApp,
  type TestApp,
} from '../support/harness.js';

describe('location ingestion', () => {
  let t: TestApp;
  let dispatcher: Api;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetState(t.db, t.redis);
    dispatcher = await new Api(t.url).login();
  });

  const storedCount = async (deviceId: string): Promise<number> =>
    (
      await t.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM location_updates WHERE device_id = $1',
        [deviceId],
      )
    ).n;

  it('stores a replayed batch once and answers "duplicate" for the repeats', async () => {
    const driver = await enrolDriver(dispatcher, 'Omar Haddad');
    const points = [
      fix(driver, 25.2, 55.27),
      fix(driver, 25.201, 55.271),
      fix(driver, 25.202, 55.272),
    ];

    const first = await sendFixes(driver, points);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accepted: 3, duplicates: 0 });

    // The device lost the response and sends the whole batch again, plus one new fix.
    const next = fix(driver, 25.203, 55.273);
    const replay = await sendFixes(driver, [...points, next]);
    expect(replay.body).toMatchObject({ accepted: 1, duplicates: 3 });
    expect(replay.body.results.map((r) => r.status)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'accepted',
    ]);
    expect(await storedCount(driver.deviceId)).toBe(4);

    // Every stored fix reached the live stream exactly once.
    const published = await t.db.query<{ stream_id: string | null }>(
      'SELECT stream_id FROM location_updates WHERE device_id = $1',
      [driver.deviceId],
    );
    expect(published.every((row) => row.stream_id !== null)).toBe(true);
    expect(await t.redis.client.xlen(LOCATION_STREAM_KEY)).toBe(4);
  });

  it('flags a reused sequence number or key as a conflict instead of overwriting', async () => {
    const driver = await enrolDriver(dispatcher, 'Sara Ali');
    const original = fix(driver, 25.2, 55.27);
    await sendFixes(driver, [original]);

    const sameSeqNewKey = { ...original, idempotencyKey: randomUUID(), lat: 25.3 };
    const sameKeyNewSeq = { ...original, seq: 99 };
    const res = await sendFixes(driver, [sameSeqNewKey]);
    expect(res.body.results[0]).toMatchObject({ status: 'conflict' });
    const res2 = await sendFixes(driver, [sameKeyNewSeq]);
    expect(res2.body.results[0]).toMatchObject({ status: 'conflict' });

    const row = await t.db.one<{ lat: number }>(
      'SELECT ST_Y(location::geometry) AS lat FROM location_updates WHERE device_id = $1 AND seq = 0',
      [driver.deviceId],
    );
    expect(row.lat).toBeCloseTo(25.2, 6);
  });

  it('moves the driver only forward in time when fixes arrive out of order', async () => {
    const driver = await enrolDriver(dispatcher, 'Yusuf Khan');
    const now = Date.now();
    const newer = fix(driver, 25.25, 55.3, new Date(now - 1_000));
    const older = fix(driver, 25.1, 55.1, new Date(now - 60_000));
    await sendFixes(driver, [newer]);
    await sendFixes(driver, [older]);

    const drivers = (await dispatcher.get<DriverDto[]>('/v1/drivers')).body;
    const position = drivers.find((d) => d.id === driver.id)?.position;
    expect(position?.lat).toBeCloseTo(25.25, 6);
    expect(await storedCount(driver.deviceId)).toBe(2);
  });

  it('rejects fixes stamped in the future and validates the batch', async () => {
    const driver = await enrolDriver(dispatcher, 'Lina Saeed');
    const future = fix(driver, 25.2, 55.27, new Date(Date.now() + 3_600_000));
    const res = await sendFixes(driver, [future]);
    expect(res.body.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'recordedAt is in the future',
    });

    const invalid = await driver.api.post('/v1/driver/locations', { points: [{ seq: -1 }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('publishes on replay a fix that was stored but never published', async () => {
    const driver = await enrolDriver(dispatcher, 'Hamad Obaid');
    const point = fix(driver, 25.2, 55.27);
    await sendFixes(driver, [point]);
    // Simulate a crash between the commit and the stream append.
    await t.db.query('UPDATE location_updates SET stream_id = NULL WHERE device_id = $1', [
      driver.deviceId,
    ]);
    await t.redis.client.del(LOCATION_STREAM_KEY);

    const replay = await sendFixes(driver, [point]);
    expect(replay.body.results[0]?.status).toBe('duplicate');
    expect(await t.redis.client.xlen(LOCATION_STREAM_KEY)).toBe(1);
    const again = await sendFixes(driver, [point]);
    expect(again.body.results[0]?.status).toBe('duplicate');
    expect(await t.redis.client.xlen(LOCATION_STREAM_KEY)).toBe(1);
  });

  it('pages through the stream after a cursor and reports a gap beyond retention', async () => {
    const driver = await enrolDriver(dispatcher, 'Mariam Nasser');
    const points = Array.from({ length: 5 }, (_, i) => fix(driver, 25.2 + i / 1000, 55.27));
    await sendFixes(driver, points);
    const stream = t.app.get(LocationStream);

    const all = await t.redis.client.xrange(LOCATION_STREAM_KEY, '-', '+');
    const firstId = all[0]?.[0] ?? '';
    const page1 = await stream.readAfter(firstId, 2);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page1.complete).toBe(false);
    const page2 = await stream.readAfter(page1.events[1]?.id ?? '', 10);
    expect(page2.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(page2.complete).toBe(true);
    expect(page2.gap).toBe(false);

    const ancient = await stream.readAfter('1000-0', 10);
    expect(ancient.gap).toBe(true);
    expect((await stream.readAfter(null)).events).toEqual([]);
  });
});
