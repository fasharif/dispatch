import {
  MAX_LOCATION_BATCH,
  type LocationBatch,
  type LocationBatchResult,
  type LocationPoint,
} from '@dispatch/shared';
import { randomUUID } from 'node:crypto';
import type { Mover } from './routes.js';

export interface FixSender {
  send(batch: LocationBatch): Promise<LocationBatchResult>;
}

export interface FlushResult {
  sent: number;
  accepted: number;
  duplicates: number;
  failed: boolean;
}

/**
 * One simulated phone. It records a fix every tick into a local queue, like the driver app's
 * SQLite queue, and sends the queue when online. A failed send keeps the fixes, and the next
 * flush sends them again with the same sequence numbers and idempotency keys.
 */
export class SimulatedDriver {
  private seq = 0;
  private readonly pending: LocationPoint[] = [];
  private offlineUntil = 0;
  accepted = 0;
  duplicates = 0;

  constructor(
    readonly name: string,
    private readonly sender: FixSender,
    private walker: Mover,
  ) {}

  get position(): Mover['position'] {
    return this.walker.position;
  }

  /** Switches to another way of moving, for example towards a pickup point. */
  moveWith(walker: Mover): void {
    this.walker = walker;
  }

  get queued(): number {
    return this.pending.length;
  }

  get nextSeq(): number {
    return this.seq;
  }

  /** Moves along the route and records one fix. */
  record(elapsedSeconds: number, now: Date = new Date()): LocationPoint {
    const position = this.walker.advance(elapsedSeconds);
    const point: LocationPoint = {
      seq: this.seq,
      idempotencyKey: randomUUID(),
      recordedAt: now.toISOString(),
      lat: Number(position.lat.toFixed(6)),
      lng: Number(position.lng.toFixed(6)),
      accuracyM: 5 + Math.round(Math.random() * 10),
      speedMps: this.walker.speedMps,
      headingDeg: position.headingDeg,
    };
    this.seq += 1;
    this.pending.push(point);
    return point;
  }

  /** Simulates a dead zone (a tunnel, a car park) until the given time. */
  goOffline(untilMs: number): void {
    this.offlineUntil = untilMs;
  }

  isOffline(nowMs: number = Date.now()): boolean {
    return nowMs < this.offlineUntil;
  }

  /** Sends queued fixes, oldest first. Every answered fix leaves the queue. */
  async flush(nowMs: number = Date.now()): Promise<FlushResult> {
    if (this.pending.length === 0 || this.isOffline(nowMs)) {
      return { sent: 0, accepted: 0, duplicates: 0, failed: false };
    }
    const points = this.pending.slice(0, MAX_LOCATION_BATCH);
    try {
      const result = await this.sender.send({ points, sentAt: Date.now() });
      const answered = new Set(result.results.map((r) => r.seq));
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        const point = this.pending[i];
        if (point && answered.has(point.seq)) this.pending.splice(i, 1);
      }
      this.accepted += result.accepted;
      this.duplicates += result.duplicates;
      return {
        sent: points.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        failed: false,
      };
    } catch {
      return { sent: points.length, accepted: 0, duplicates: 0, failed: true };
    }
  }
}
