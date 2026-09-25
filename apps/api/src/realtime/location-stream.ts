import { Injectable } from '@nestjs/common';
import type { DriverLocationEvent, ResumeResponse } from '@dispatch/shared';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';

export const LOCATION_STREAM_KEY = 'dispatch:locations';
const MAX_RESUME_PAGE = 2_000;

export type UnpublishedLocation = Omit<DriverLocationEvent, 'id' | 'publishedAt'>;

/**
 * The live location stream: a Redis stream holding the last few minutes of published fixes.
 *
 * Every fix is appended here before it is broadcast. Stream ids are assigned by Redis in append
 * order, which gives clients a cursor: after a reconnect they ask for everything after the
 * newest id they saw and nothing published in the meantime is lost.
 */
@Injectable()
export class LocationStream {
  private readonly retentionMs: number;

  constructor(
    private readonly redis: RedisService,
    @InjectConfig() config: AppConfig,
  ) {
    this.retentionMs = config.locations.streamRetentionMin * 60_000;
  }

  /** Appends fixes in order and returns them with their stream ids. */
  async append(locations: readonly UnpublishedLocation[]): Promise<DriverLocationEvent[]> {
    if (locations.length === 0) return [];
    const publishedAt = Date.now();
    // Approximate trimming (~) lets Redis drop whole macro-nodes, which is much cheaper.
    const minId = String(publishedAt - this.retentionMs);
    const pipeline = this.redis.client.pipeline();
    for (const location of locations) {
      pipeline.xadd(
        LOCATION_STREAM_KEY,
        'MINID',
        '~',
        minId,
        '*',
        'd',
        JSON.stringify({ ...location, publishedAt }),
      );
    }
    const results = (await pipeline.exec()) ?? [];
    return locations.map((location, index) => {
      const [error, id] = results[index] ?? [new Error('No reply from Redis'), null];
      if (error) throw error;
      return { ...location, id: String(id), publishedAt };
    });
  }

  /**
   * Events published after `since` (exclusive), oldest first, one page at a time.
   * `gap` is true when `since` is older than the retention window: events after it may have
   * been trimmed, so the client must reload the current state over HTTP.
   */
  async readAfter(since: string | null, limit = 500): Promise<ResumeResponse> {
    if (since === null) return { events: [], complete: true, gap: false };
    if (!/^\d{1,15}-\d{1,15}$/.test(since)) {
      return { events: [], complete: true, gap: true };
    }
    const count = Math.min(Math.max(limit, 1), MAX_RESUME_PAGE);
    const sinceMs = Number(since.split('-')[0]);
    const gap = sinceMs < Date.now() - this.retentionMs;
    const entries = (await this.redis.client.xrange(
      LOCATION_STREAM_KEY,
      `(${since}`,
      '+',
      'COUNT',
      count + 1,
    )) as [string, string[]][];
    const page = entries.slice(0, count);
    return {
      events: page.map(([id, fields]) => decode(id, fields)),
      complete: entries.length <= count,
      gap,
    };
  }
}

function decode(id: string, fields: string[]): DriverLocationEvent {
  const index = fields.indexOf('d');
  const body = index >= 0 ? fields[index + 1] : undefined;
  if (body === undefined) throw new Error(`Stream entry ${id} has no payload`);
  return { ...(JSON.parse(body) as Omit<DriverLocationEvent, 'id'>), id };
}
