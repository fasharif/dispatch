import { LiveFeed, fixKey, type DriverLocationEvent, type LocationPoint } from '@dispatch/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Api,
  enrolDriver,
  eventually,
  fix,
  resetState,
  startApp,
  type TestApp,
  type TestDriver,
} from '../support/harness.js';
import { collect, connectDispatch, type DispatchSocket } from '../support/sockets.js';

/**
 * Two API instances share PostgreSQL and Redis, as behind the nginx load balancer in the
 * compose stack. A position posted to one instance reaches consoles connected to the other
 * (Redis adapter), and when an instance goes away its consoles reconnect to the survivor and
 * resume from the stream without losing a fix.
 */
describe('two API instances (e2e)', () => {
  let a: TestApp;
  let b: TestApp;
  let aClosed = false;
  let dispatcher: Api;

  beforeAll(async () => {
    a = await startApp({}, { instanceId: 'api-a' });
    b = await startApp({}, { instanceId: 'api-b' });
    await resetState(a.db, a.redis);
    dispatcher = await new Api(a.url).login();
  });
  afterAll(async () => {
    await b.close();
    if (!aClosed) await a.close();
  });

  it('fans a position out to consoles on both instances', async () => {
    const onA = await connectDispatch(a.url, dispatcher.token ?? '');
    const onB = await connectDispatch(b.url, dispatcher.token ?? '');
    const seenA = collect<DriverLocationEvent>(onA, 'driver:location');
    const seenB = collect<DriverLocationEvent>(onB, 'driver:location');
    const driver = await enrolDriver(dispatcher, 'Omar Haddad');

    const viaA = await driver.api.post('/v1/driver/locations', {
      points: [fix(driver, 25.2, 55.27)],
    });
    const viaB = await new Api(b.url, driver.api.token).post('/v1/driver/locations', {
      points: [fix(driver, 25.21, 55.28)],
    });
    expect(viaA.headers.get('x-served-by')).toBe('api-a');
    expect(viaB.headers.get('x-served-by')).toBe('api-b');

    await eventually(() => seenA.length === 2 && seenB.length === 2);
    expect(seenA.map((e) => e.seq)).toEqual([0, 1]);
    expect(seenB.map((e) => e.seq)).toEqual([0, 1]);
    onA.close();
    onB.close();
  });

  it('loses no fix when the instance a console is connected to goes away', async () => {
    const drivers: TestDriver[] = [];
    for (let i = 0; i < 5; i += 1)
      drivers.push(await enrolDriver(dispatcher, `Driver ${String(i)}`));
    const token = dispatcher.token ?? '';

    // The console, connected to instance A, keeps the same bookkeeping as the web app.
    const feed = new LiveFeed();
    const received = new Set<string>();
    const track = (socket: DispatchSocket) => {
      socket.on('driver:location', (event) => {
        if (feed.accept(event)) received.add(fixKey(event));
      });
    };
    let socket = await connectDispatch(a.url, token);
    track(socket);

    // Every driver sends a fix a round, alternating instances like a load balancer would.
    // If an instance is gone, the device resends the same batch to the other one.
    const accepted = new Set<string>();
    const send = async (driver: TestDriver, point: LocationPoint, preferA: boolean) => {
      const targets = preferA ? [a.url, b.url] : [b.url, a.url];
      for (const url of targets) {
        try {
          const res = await new Api(url, driver.api.token).post<{ results: { status: string }[] }>(
            '/v1/driver/locations',
            { points: [point], sentAt: Date.now() },
          );
          if (res.status === 200) {
            if (['accepted', 'duplicate'].includes(res.body.results[0]?.status ?? '')) {
              accepted.add(`${driver.deviceId}:${String(point.seq)}`);
            }
            return;
          }
        } catch {
          // Connection refused: try the other instance.
        }
      }
      throw new Error('No instance accepted the fix');
    };

    let lat = 25.2;
    for (let round = 0; round < 12; round += 1) {
      lat += 0.0005;
      await Promise.all(
        drivers.map((driver, i) =>
          send(driver, fix(driver, lat, 55.27 + i / 100), (round + i) % 2 === 0),
        ),
      );
      if (round === 5) {
        // Instance A stops mid-test; its console is disconnected.
        const closed = new Promise<void>((resolve) =>
          socket.once('disconnect', () => {
            resolve();
          }),
        );
        await a.close();
        aClosed = true;
        await closed;
      }
      if (round === 7) {
        // The console reconnects to the surviving instance and asks for what it missed.
        socket = await connectDispatch(b.url, token);
        track(socket);
        let since = feed.resumeFrom();
        for (;;) {
          const page = await socket.emitWithAck('resume', { since, limit: 20 });
          expect(page.gap).toBe(false);
          for (const event of page.events) if (feed.accept(event)) received.add(fixKey(event));
          if (page.complete) break;
          since = page.events.at(-1)?.id ?? since;
        }
      }
    }

    await eventually(() => received.size >= accepted.size);
    const lost = [...accepted].filter((key) => !received.has(key));
    expect(accepted.size).toBe(60);
    expect(lost).toEqual([]);
    socket.close();
  });
});
