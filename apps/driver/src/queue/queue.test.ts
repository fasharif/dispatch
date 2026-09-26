import {
  locationBatchSchema,
  type LocationBatch,
  type LocationBatchResult,
} from '@dispatch/shared';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocationQueue, type RawFix } from './location-queue';
import { openNodeSqlite } from './node-sqlite';
import { TransportError, replay, type BatchTransport } from './replay';

const fixAt = (seconds: number, lat = 25.2): RawFix => ({
  lat,
  lng: 55.27,
  recordedAt: new Date(Date.UTC(2026, 8, 20, 10, 0, seconds)),
  accuracyM: 8,
  speedMps: 12,
  headingDeg: 90,
});

/**
 * An in-memory stand-in for the API's ingestion endpoint with the same rules: a fix is stored
 * once per (seq, key); a repeat is a duplicate; a reused seq with another key is a conflict.
 * It validates every batch with the shared schema, like the real endpoint.
 */
class FakeServer implements BatchTransport {
  readonly stored = new Map<number, string>();
  readonly batches: LocationBatch[] = [];
  /** Fail the next requests with these statuses (null = network error). */
  failures: (number | null)[] = [];
  /** Also store the batch before failing (the response is lost after the commit). */
  commitBeforeFailing = false;
  rejectSeq: number | null = null;

  send(batch: LocationBatch): Promise<LocationBatchResult> {
    this.batches.push(batch);
    const parsed = locationBatchSchema.safeParse(batch);
    if (!parsed.success) return Promise.reject(new TransportError(400, 'Bad Request'));
    if (this.rejectSeq !== null && batch.points.some((p) => p.seq === this.rejectSeq)) {
      return Promise.reject(new TransportError(400, 'Bad Request'));
    }
    const failure = this.failures.shift();
    if (failure !== undefined && !this.commitBeforeFailing) {
      return Promise.reject(new TransportError(failure, 'failed'));
    }
    const results = batch.points.map((point) => {
      const known = this.stored.get(point.seq);
      const status =
        known === undefined
          ? 'accepted'
          : known === point.idempotencyKey
            ? 'duplicate'
            : 'conflict';
      if (known === undefined) this.stored.set(point.seq, point.idempotencyKey);
      return { seq: point.seq, idempotencyKey: point.idempotencyKey, status } as const;
    });
    if (failure !== undefined) return Promise.reject(new TransportError(failure, 'lost response'));
    return Promise.resolve({
      accepted: results.filter((r) => r.status === 'accepted').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      results,
    });
  }
}

describe('LocationQueue', () => {
  let db: ReturnType<typeof openNodeSqlite>;
  let queue: LocationQueue;

  beforeEach(async () => {
    db = openNodeSqlite();
    queue = new LocationQueue(db, { uuid: randomUUID });
    await queue.init();
    await queue.bindDevice('device-1');
  });
  afterEach(() => {
    db.close();
  });

  it('numbers fixes 0, 1, 2… per device and gives each its own key', async () => {
    const first = await queue.enqueue([fixAt(0), fixAt(5)]);
    const second = await queue.enqueue([fixAt(10)]);
    expect([...first, ...second].map((p) => p.seq)).toEqual([0, 1, 2]);
    expect(new Set([...first, ...second].map((p) => p.idempotencyKey)).size).toBe(3);
    expect((await queue.peek(10)).map((p) => p.seq)).toEqual([0, 1, 2]);
  });

  it('never reuses a sequence number, even after fixes were sent and removed', async () => {
    const [sent] = await queue.enqueue([fixAt(0)]);
    await queue.acknowledge([
      { seq: 0, idempotencyKey: sent?.idempotencyKey ?? '', status: 'accepted' },
    ]);
    const [next] = await queue.enqueue([fixAt(5)]);
    expect(next?.seq).toBe(1);
  });

  it('keeps sequence numbers when concurrent enqueues race', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => queue.enqueue([fixAt(i)])),
    );
    const seqs = results
      .flat()
      .map((p) => p.seq)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('survives a restart: the queue and the next sequence number are on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-queue-'));
    const path = join(dir, 'queue.db');
    const before = openNodeSqlite(path);
    const q1 = new LocationQueue(before, { uuid: randomUUID });
    await q1.init();
    await q1.bindDevice('device-1');
    const recorded = await q1.enqueue([fixAt(0), fixAt(5)]);
    before.close();

    const after = openNodeSqlite(path);
    const q2 = new LocationQueue(after, { uuid: randomUUID });
    await q2.init();
    expect(await q2.bindDevice('device-1')).toBe(false);
    expect(await q2.peek(10)).toEqual(recorded);
    expect((await q2.enqueue([fixAt(10)]))[0]?.seq).toBe(2);
    after.close();
  });

  it('starts a new sequence and clears old fixes when the phone is enrolled again', async () => {
    await queue.enqueue([fixAt(0), fixAt(5)]);
    expect(await queue.bindDevice('device-2')).toBe(true);
    expect(await queue.stats()).toMatchObject({ queued: 0, nextSeq: 0 });
    expect((await queue.enqueue([fixAt(10)]))[0]?.seq).toBe(0);
  });

  it('keeps at most one fix per minSpacingMs and remembers when the last was recorded', async () => {
    const thinned = new LocationQueue(db, { uuid: randomUUID, minSpacingMs: 4_000 });
    // iOS can report a position every second; 0, 5, 9 and 13 s are kept.
    const kept = await thinned.enqueue([0, 1, 2, 3, 5, 6, 9, 10, 13].map((s) => fixAt(s)));
    expect(kept.map((p) => p.recordedAt.slice(17, 19))).toEqual(['00', '05', '09', '13']);
    expect(kept.map((p) => p.seq)).toEqual([0, 1, 2, 3]);
    // The spacing holds across calls, from the last recorded fix.
    expect(await thinned.enqueue([fixAt(15)])).toEqual([]);
    expect(await thinned.enqueue([fixAt(17)])).toHaveLength(1);
    expect(await thinned.lastRecordedAt()).toEqual(fixAt(17).recordedAt);
  });

  it('keeps every fix without a spacing', async () => {
    const all = await queue.enqueue([fixAt(0), fixAt(1), fixAt(2)]);
    expect(all).toHaveLength(3);
    expect(await queue.lastRecordedAt()).toEqual(fixAt(2).recordedAt);
  });

  it('drops the oldest fixes beyond its limit and counts them', async () => {
    const small = new LocationQueue(db, { uuid: randomUUID, maxQueued: 3 });
    await small.enqueue([fixAt(0), fixAt(1), fixAt(2), fixAt(3), fixAt(4)]);
    expect((await small.peek(10)).map((p) => p.seq)).toEqual([2, 3, 4]);
    expect(await small.stats()).toMatchObject({ queued: 3, dropped: 2, nextSeq: 5 });
  });

  it('leaves out readings the API would refuse instead of failing the whole fix', async () => {
    const [point] = await queue.enqueue([
      { ...fixAt(0), speedMps: -1, headingDeg: 400, accuracyM: null },
    ]);
    expect(point).not.toHaveProperty('speedMps');
    expect(point).not.toHaveProperty('headingDeg');
    expect(point).not.toHaveProperty('accuracyM');
  });
});

describe('replay', () => {
  let db: ReturnType<typeof openNodeSqlite>;
  let queue: LocationQueue;
  let server: FakeServer;

  beforeEach(async () => {
    db = openNodeSqlite();
    queue = new LocationQueue(db, { uuid: randomUUID });
    await queue.init();
    await queue.bindDevice('device-1');
    server = new FakeServer();
  });
  afterEach(() => {
    db.close();
  });

  it('sends everything in batches, oldest first, and empties the queue', async () => {
    await queue.enqueue(Array.from({ length: 250 }, (_, i) => fixAt(i)));
    const result = await replay(queue, server, { batchSize: 100 });
    expect(result).toMatchObject({ batches: 3, accepted: 250, duplicates: 0, stoppedBy: 'empty' });
    expect(server.batches.map((b) => b.points.length)).toEqual([100, 100, 50]);
    expect(server.batches[0]?.points[0]?.seq).toBe(0);
    expect((await queue.stats()).queued).toBe(0);
  });

  it('keeps the queue while offline, then replays the same fixes exactly once', async () => {
    await queue.enqueue([fixAt(0), fixAt(5), fixAt(10)]);
    server.failures = [null];
    expect((await replay(queue, server)).stoppedBy).toBe('offline');
    expect((await queue.stats()).queued).toBe(3);

    await queue.enqueue([fixAt(15)]);
    const result = await replay(queue, server);
    expect(result).toMatchObject({ accepted: 4, duplicates: 0, stoppedBy: 'empty' });
    expect([...server.stored.keys()]).toEqual([0, 1, 2, 3]);
  });

  it('turns a lost response into duplicates on the next attempt, not new fixes', async () => {
    const recorded = await queue.enqueue([fixAt(0), fixAt(5)]);
    server.failures = [504];
    server.commitBeforeFailing = true;
    expect((await replay(queue, server)).stoppedBy).toBe('server');
    expect(server.stored.size).toBe(2);

    const result = await replay(queue, server);
    expect(result).toMatchObject({ accepted: 0, duplicates: 2, stoppedBy: 'empty' });
    // The replay carried the original keys and sequence numbers.
    expect(server.batches[1]?.points).toEqual(recorded);
    expect(server.stored.size).toBe(2);
  });

  it('stops without losing anything when the device is no longer authorised', async () => {
    await queue.enqueue([fixAt(0)]);
    server.failures = [401];
    expect((await replay(queue, server)).stoppedBy).toBe('unauthorized');
    expect((await queue.stats()).queued).toBe(1);
  });

  it('isolates one malformed fix so the rest of the batch still goes through', async () => {
    await queue.enqueue([fixAt(0), fixAt(5), fixAt(10)]);
    server.rejectSeq = 1;
    const result = await replay(queue, server);
    expect(result).toMatchObject({ accepted: 2, rejected: 1, stoppedBy: 'empty' });
    expect([...server.stored.keys()].sort()).toEqual([0, 2]);
    expect(await queue.stats()).toMatchObject({ queued: 0, rejected: 1 });
  });

  it('stops after the batch limit a background task can afford', async () => {
    await queue.enqueue(Array.from({ length: 30 }, (_, i) => fixAt(i)));
    const result = await replay(queue, server, { batchSize: 10, maxBatches: 2 });
    expect(result).toMatchObject({ batches: 2, accepted: 20, stoppedBy: 'limit' });
    expect((await queue.stats()).queued).toBe(10);
  });

  it('sends batches the API contract accepts', async () => {
    await queue.enqueue([fixAt(0), fixAt(5)]);
    await replay(queue, server, { now: () => 1_790_000_000_000 });
    const batch = server.batches[0];
    expect(locationBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch?.sentAt).toBe(1_790_000_000_000);
  });
});
