import { Injectable } from '@nestjs/common';
import { RedisThrottlerStorage } from '../common/throttle.js';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';
import { sha256Hex } from './tokens.js';

const WINDOW_MS = 60_000;
/** Addresses remembered as blocked by one process; expired entries are dropped past this. */
const MAX_REMEMBERED = 10_000;

/**
 * Throttles failed device-token checks per client address, before the token is looked up.
 *
 * The per-caller rate limit runs after authentication, so without this a flood of invented device
 * tokens would cost one database lookup each and never be limited. Failures are counted in Redis,
 * shared by every instance; once an address exceeds AUTH_FAILURE_LIMIT in a minute it is blocked
 * for a minute. Each instance remembers the block in memory, so the check before the lookup costs
 * nothing on the normal path, and an instance learns of a block on the next failure it sees.
 */
@Injectable()
export class AuthFailures {
  private readonly storage: RedisThrottlerStorage;
  private readonly blockedUntil = new Map<string, number>();
  private readonly limit: number;

  constructor(redis: RedisService, @InjectConfig() config: AppConfig) {
    this.storage = new RedisThrottlerStorage(redis.client);
    this.limit = config.http.authFailureLimit;
  }

  /** Seconds until this address may present a device token again; 0 when it may now. */
  retryAfterSeconds(address: string, now: number = Date.now()): number {
    const until = this.blockedUntil.get(address);
    if (until === undefined) return 0;
    if (until <= now) {
      this.blockedUntil.delete(address);
      return 0;
    }
    return Math.ceil((until - now) / 1000);
  }

  /** Counts a failed check; returns the seconds to wait when the address is now blocked. */
  async record(address: string, now: number = Date.now()): Promise<number> {
    const result = await this.storage.increment(
      sha256Hex(address),
      WINDOW_MS,
      this.limit,
      WINDOW_MS,
      'auth-failures',
    );
    if (!result.isBlocked) return 0;
    if (this.blockedUntil.size >= MAX_REMEMBERED) this.forgetExpired(now);
    const seconds = Math.max(1, result.timeToBlockExpire);
    this.blockedUntil.set(address, now + seconds * 1000);
    return seconds;
  }

  private forgetExpired(now: number): void {
    for (const [address, until] of this.blockedUntil) {
      if (until <= now) this.blockedUntil.delete(address);
    }
    // Still full of live blocks: forget the oldest rather than grow without bound.
    while (this.blockedUntil.size >= MAX_REMEMBERED) {
      const oldest = this.blockedUntil.keys().next();
      if (oldest.done) break;
      this.blockedUntil.delete(oldest.value);
    }
  }
}
