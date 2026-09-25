import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { sha256Hex } from '../auth/tokens.js';
import type { AppRequest } from './request-context.js';

/** Stricter limit for unauthenticated endpoints that check secrets (login, device enrolment). */
export const strictThrottle = {
  default: {
    limit: () => Number(process.env.AUTH_THROTTLE_LIMIT ?? 10),
    ttl: 60_000,
  },
};

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

// Fixed-window counter plus a block key, in one round trip. Returns hits, window TTL and block TTL (ms).
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blocked = redis.call('PTTL', KEYS[2])
if blocked <= 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blocked = tonumber(ARGV[3])
end
return {hits, ttl, blocked}
`;

/**
 * Rate-limit counters in Redis, so the limits hold across every API instance behind the load
 * balancer rather than per process.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    const [hits, windowMs, blockMs] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${base}:hits`,
      `${base}:blocked`,
      String(ttl),
      String(limit),
      String(blockDuration > 0 ? blockDuration : ttl),
    )) as [number, number, number];
    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil(windowMs / 1000)),
      isBlocked: blockMs > 0,
      timeToBlockExpire: Math.max(0, Math.ceil(blockMs / 1000)),
    };
  }
}

/**
 * Tracks authenticated callers by credential and anonymous callers by address. Hundreds of
 * drivers can share one carrier-grade NAT address, so a per-address limit would throttle them
 * together; each device token gets its own budget instead.
 */
@Injectable()
export class CallerThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: Record<string, unknown>): Promise<string> {
    const req = request as unknown as AppRequest;
    const principal = req.principal;
    if (principal?.kind === 'device') return Promise.resolve(`device:${principal.deviceId}`);
    if (principal?.kind === 'dispatcher') return Promise.resolve(`dispatcher:${principal.id}`);
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }

  protected override generateKey(context: ExecutionContext, tracker: string, name: string): string {
    return sha256Hex(`${context.getClass().name}:${context.getHandler().name}:${name}:${tracker}`);
  }
}
