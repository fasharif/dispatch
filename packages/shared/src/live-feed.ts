import { compareStreamIds, fixKey, type DriverLocationEvent } from './realtime.js';

export interface LiveFeedOptions {
  /**
   * How far before the newest seen event a resume starts, in milliseconds. Events published by
   * different API instances can reach a client slightly out of stream order, so resuming from
   * the newest id alone could skip an event that was still in flight. The overlap is re-read and
   * the duplicates are dropped.
   */
  resumeOverlapMs?: number;
  /** Maximum number of fix keys remembered for de-duplication. */
  maxRemembered?: number;
}

/**
 * Client-side bookkeeping for the dispatcher live feed: drops duplicate fixes and works out where
 * to resume after a reconnect. Used by the web console and by the load-test listener, so the
 * test measures exactly what the console does.
 */
export class LiveFeed {
  private readonly seen = new Map<string, true>();
  private newestId: string | null = null;
  private readonly overlapMs: number;
  private readonly maxRemembered: number;

  constructor(options: LiveFeedOptions = {}) {
    this.overlapMs = options.resumeOverlapMs ?? 5_000;
    this.maxRemembered = options.maxRemembered ?? 250_000;
  }

  /** Records an event; returns false when the same fix was already seen. */
  accept(event: DriverLocationEvent): boolean {
    if (this.newestId === null || compareStreamIds(event.id, this.newestId) > 0) {
      this.newestId = event.id;
    }
    const key = fixKey(event);
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    if (this.seen.size > this.maxRemembered) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  /** The `since` value for a resume request, or null when nothing has been received yet. */
  resumeFrom(): string | null {
    if (this.newestId === null) return null;
    const [ms = '0'] = this.newestId.split('-');
    const from = Math.max(0, Number(ms) - this.overlapMs);
    return `${String(from)}-0`;
  }

  get newest(): string | null {
    return this.newestId;
  }

  get size(): number {
    return this.seen.size;
  }
}
