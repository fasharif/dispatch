import type { LocationBatchResult, LocationPoint } from '@dispatch/shared';
import type { SqlDatabase, SqlExecutor } from './sql';

/** A position from the phone's location service, before it gets a sequence number. */
export interface RawFix {
  lat: number;
  lng: number;
  recordedAt: Date;
  accuracyM?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
}

interface QueueRow {
  seq: number;
  idempotency_key: string;
  recorded_at: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
}

export interface QueueOptions {
  /** Creates the idempotency key of each fix (expo-crypto's randomUUID in the app). */
  uuid: () => string;
  /**
   * Upper bound on stored fixes. At one fix every 5 seconds, 20 000 fixes is more than a day
   * offline. Beyond it the oldest fixes are dropped and counted, so storage cannot fill up.
   */
  maxQueued?: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS location_queue (
    seq             INTEGER PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    recorded_at     TEXT NOT NULL,
    lat             REAL NOT NULL,
    lng             REAL NOT NULL,
    accuracy_m      REAL,
    speed_mps       REAL,
    heading_deg     REAL
  );
  CREATE TABLE IF NOT EXISTS queue_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Speeds and headings the API accepts (see locationPointSchema). */
const clampOptional = (
  value: number | null | undefined,
  min: number,
  max: number,
): number | null =>
  value === null || value === undefined || !Number.isFinite(value) || value < min || value > max
    ? null
    : value;

/**
 * The driver app's offline queue, in SQLite so it survives the app being killed.
 *
 * Every fix gets the next sequence number of this device and a random idempotency key the
 * moment it is recorded, and keeps both until the server has answered for it. Replaying a batch
 * after a timeout, a crash or a day without signal therefore sends exactly the same fixes, and
 * the server stores each one once. The next sequence number lives in the same database and is
 * advanced in the same transaction as the insert, so it never repeats.
 */
export class LocationQueue {
  private readonly maxQueued: number;
  /** Serialises queue operations within this JavaScript runtime. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: SqlDatabase,
    private readonly options: QueueOptions,
  ) {
    this.maxQueued = options.maxQueued ?? 20_000;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async init(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  /**
   * Ties the queue to an enrolled device. Sequence numbers are per device, so enrolling the
   * phone again (a new device id) starts a new sequence and discards fixes that could only have
   * been sent with the old credentials. Returns true when that happened.
   */
  bindDevice(deviceId: string): Promise<boolean> {
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        const current = await meta(tx, 'device_id');
        if (current === deviceId) return false;
        await tx.run('DELETE FROM location_queue');
        await setMeta(tx, 'next_seq', '0');
        await setMeta(tx, 'device_id', deviceId);
        return current !== null;
      }),
    );
  }

  /** Stores fixes in order and gives each one its sequence number and idempotency key. */
  enqueue(fixes: readonly RawFix[]): Promise<LocationPoint[]> {
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        let next = Number((await meta(tx, 'next_seq')) ?? '0');
        const points: LocationPoint[] = [];
        for (const fix of fixes) {
          const point: LocationPoint = {
            seq: next,
            idempotencyKey: this.options.uuid(),
            recordedAt: fix.recordedAt.toISOString(),
            lat: fix.lat,
            lng: fix.lng,
            ...optional('accuracyM', clampOptional(fix.accuracyM, 0, 10_000)),
            ...optional('speedMps', clampOptional(fix.speedMps, 0, 100)),
            ...optional('headingDeg', clampOptional(fix.headingDeg, 0, 360)),
          };
          await tx.run(
            `INSERT INTO location_queue
               (seq, idempotency_key, recorded_at, lat, lng, accuracy_m, speed_mps, heading_deg)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              point.seq,
              point.idempotencyKey,
              point.recordedAt,
              point.lat,
              point.lng,
              point.accuracyM ?? null,
              point.speedMps ?? null,
              point.headingDeg ?? null,
            ],
          );
          points.push(point);
          next += 1;
        }
        await setMeta(tx, 'next_seq', String(next));

        const overflow = (await count(tx)) - this.maxQueued;
        if (overflow > 0) {
          await tx.run(
            'DELETE FROM location_queue WHERE seq IN (SELECT seq FROM location_queue ORDER BY seq LIMIT ?)',
            [overflow],
          );
          const dropped = Number((await meta(tx, 'dropped')) ?? '0') + overflow;
          await setMeta(tx, 'dropped', String(dropped));
        }
        return points;
      }),
    );
  }

  /** The oldest queued fixes, exactly as they were first recorded. */
  peek(limit: number): Promise<LocationPoint[]> {
    return this.serial(async () => {
      const rows = await this.db.all<QueueRow>(
        'SELECT * FROM location_queue ORDER BY seq LIMIT ?',
        [limit],
      );
      return rows.map(toPoint);
    });
  }

  /** Removes every fix the server answered for; each answer is final (see LocationPointStatus). */
  acknowledge(results: LocationBatchResult['results']): Promise<void> {
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        for (const result of results) {
          await tx.run('DELETE FROM location_queue WHERE seq = ? AND idempotency_key = ?', [
            result.seq,
            result.idempotencyKey,
          ]);
        }
      }),
    );
  }

  /** Drops fixes the server can never accept (a 400 for that fix on its own). */
  discard(points: readonly Pick<LocationPoint, 'seq'>[]): Promise<void> {
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        for (const point of points)
          await tx.run('DELETE FROM location_queue WHERE seq = ?', [point.seq]);
        const rejected = Number((await meta(tx, 'rejected')) ?? '0') + points.length;
        await setMeta(tx, 'rejected', String(rejected));
      }),
    );
  }

  stats(): Promise<{ queued: number; nextSeq: number; dropped: number; rejected: number }> {
    return this.serial(async () => ({
      queued: await count(this.db),
      nextSeq: Number((await meta(this.db, 'next_seq')) ?? '0'),
      dropped: Number((await meta(this.db, 'dropped')) ?? '0'),
      rejected: Number((await meta(this.db, 'rejected')) ?? '0'),
    }));
  }
}

async function meta(db: SqlExecutor, key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>('SELECT value FROM queue_meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

async function setMeta(db: SqlExecutor, key: string, value: string): Promise<void> {
  await db.run(
    'INSERT INTO queue_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

async function count(db: SqlExecutor): Promise<number> {
  const row = await db.get<{ n: number }>('SELECT count(*) AS n FROM location_queue');
  return row?.n ?? 0;
}

function optional<K extends string>(key: K, value: number | null): Partial<Record<K, number>> {
  return value === null ? {} : ({ [key]: value } as Record<K, number>);
}

function toPoint(row: QueueRow): LocationPoint {
  return {
    seq: row.seq,
    idempotencyKey: row.idempotency_key,
    recordedAt: row.recorded_at,
    lat: row.lat,
    lng: row.lng,
    ...optional('accuracyM', row.accuracy_m),
    ...optional('speedMps', row.speed_mps),
    ...optional('headingDeg', row.heading_deg),
  };
}
