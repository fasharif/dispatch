import type { LocationBatch, LocationBatchResult, LocationPoint } from '@dispatch/shared';
import type { LocationQueue } from './location-queue';

/** Raised by a transport when a batch got no usable answer. `status` is null for network errors. */
export class TransportError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface BatchTransport {
  send(batch: LocationBatch): Promise<LocationBatchResult>;
}

export type StopReason = 'empty' | 'offline' | 'server' | 'unauthorized' | 'limit';

export interface ReplayResult {
  batches: number;
  accepted: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  stoppedBy: StopReason;
}

export interface ReplayOptions {
  batchSize?: number;
  /** Stop after this many batches (a background task has only seconds to run). */
  maxBatches?: number;
  now?: () => number;
}

/**
 * Sends queued fixes, oldest first, until the queue is empty or the network or server says
 * stop. Fixes leave the queue only once the server has answered for them, so anything not
 * answered is sent again next time with the same sequence number and idempotency key.
 *
 * A 400 for a whole batch means some fix is malformed. The batch is then retried one fix at a
 * time, so one bad fix cannot block the queue and the good fixes around it still go through.
 */
export async function replay(
  queue: LocationQueue,
  transport: BatchTransport,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 50;
  const now = options.now ?? Date.now;
  const result: ReplayResult = {
    batches: 0,
    accepted: 0,
    duplicates: 0,
    conflicts: 0,
    rejected: 0,
    stoppedBy: 'empty',
  };

  const record = (answer: LocationBatchResult) => {
    for (const item of answer.results) {
      if (item.status === 'accepted') result.accepted += 1;
      else if (item.status === 'duplicate') result.duplicates += 1;
      else if (item.status === 'conflict') result.conflicts += 1;
      else result.rejected += 1;
    }
  };

  const send = async (points: LocationPoint[]): Promise<StopReason | 'bad-request' | null> => {
    try {
      const answer = await transport.send({ points, sentAt: now() });
      await queue.acknowledge(answer.results);
      record(answer);
      return null;
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      if (error.status === null) return 'offline';
      if (error.status === 401 || error.status === 403) return 'unauthorized';
      if (error.status === 400) return 'bad-request';
      return 'server';
    }
  };

  while (result.batches < maxBatches) {
    const points = await queue.peek(batchSize);
    if (points.length === 0) return { ...result, stoppedBy: 'empty' };
    result.batches += 1;

    const outcome = await send(points);
    if (outcome === null) continue;
    if (outcome !== 'bad-request') return { ...result, stoppedBy: outcome };

    // Isolate the malformed fix: send the batch one fix at a time.
    for (const point of points) {
      const single = await send([point]);
      if (single === 'bad-request') {
        await queue.discard([point]);
        result.rejected += 1;
      } else if (single !== null) {
        return { ...result, stoppedBy: single };
      }
    }
  }
  return { ...result, stoppedBy: 'limit' };
}
