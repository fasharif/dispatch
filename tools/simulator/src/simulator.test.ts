import { haversineMeters, type LocationBatch, type LocationBatchResult } from '@dispatch/shared';
import { describe, expect, it } from 'vitest';
import { SimulatedDriver, type FixSender } from './driver-sim.js';
import { ROUTES, RouteWalker, TargetWalker } from './routes.js';
import { percentile, summarise } from './stats.js';

const line = [
  { lat: 25, lng: 55 },
  { lat: 25.01, lng: 55 },
];

describe('RouteWalker', () => {
  it('moves at the given speed and turns back at the end of the route', () => {
    const walker = new RouteWalker(line, 10);
    const length = haversineMeters(line[0]!, line[1]!);
    const after100s = walker.advance(100);
    expect(haversineMeters(line[0]!, after100s)).toBeCloseTo(1000, -1);
    expect(after100s.headingDeg).toBe(0);

    walker.advance((length - 1000) / 10 + 50);
    const back = walker.position;
    expect(haversineMeters(line[1]!, back)).toBeCloseTo(500, -1);
    expect(back.headingDeg).toBe(180);
  });

  it('keeps every predefined route inside the Dubai area', () => {
    for (const points of Object.values(ROUTES)) {
      for (const point of points) {
        expect(point.lat).toBeGreaterThan(24.9);
        expect(point.lat).toBeLessThan(25.4);
        expect(point.lng).toBeGreaterThan(55);
        expect(point.lng).toBeLessThan(55.5);
      }
    }
  });
});

describe('TargetWalker', () => {
  it('drives straight to the target and stops there', () => {
    const walker = new TargetWalker(line[0]!, line[1]!, 100);
    walker.advance(5);
    expect(walker.arrived).toBe(false);
    walker.advance(60);
    expect(walker.arrived).toBe(true);
    expect(walker.advance(60)).toMatchObject(line[1]!);
  });
});

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 30)).toBe(20);
    expect(percentile(values, 40)).toBe(20);
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile([], 95)).toBeNull();
  });

  it('summarises large samples without overflowing the stack', () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i + 1);
    expect(summarise(values)).toEqual({
      count: 200_000,
      p50: 100_000,
      p95: 190_000,
      p99: 198_000,
      max: 200_000,
    });
  });
});

/** A fake API that stores fixes by seq, answering "duplicate" for repeats, and can fail. */
class FakeApi implements FixSender {
  readonly stored = new Map<number, string>();
  failNext = 0;
  requests = 0;

  send(batch: LocationBatch): Promise<LocationBatchResult> {
    this.requests += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('502 Bad Gateway'));
    }
    const results = batch.points.map((point) => {
      const known = this.stored.get(point.seq);
      if (known === undefined) this.stored.set(point.seq, point.idempotencyKey);
      return {
        seq: point.seq,
        idempotencyKey: point.idempotencyKey,
        status: known === undefined ? ('accepted' as const) : ('duplicate' as const),
      };
    });
    return Promise.resolve({
      accepted: results.filter((r) => r.status === 'accepted').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      results,
    });
  }
}

describe('SimulatedDriver', () => {
  it('keeps fixes while offline or failing, then replays them once with the same keys', async () => {
    const api = new FakeApi();
    const driver = new SimulatedDriver('Test', api, new RouteWalker(line, 10));

    driver.record(3);
    driver.goOffline(Date.now() + 60_000);
    driver.record(3);
    expect(await driver.flush()).toMatchObject({ sent: 0 });
    expect(driver.queued).toBe(2);

    driver.goOffline(0);
    api.failNext = 1;
    expect(await driver.flush()).toMatchObject({ failed: true, sent: 2 });
    expect(driver.queued).toBe(2);

    driver.record(3);
    expect(await driver.flush()).toMatchObject({ accepted: 3, duplicates: 0, failed: false });
    expect(driver.queued).toBe(0);
    expect([...api.stored.keys()]).toEqual([0, 1, 2]);
    expect(driver.nextSeq).toBe(3);
  });
});
