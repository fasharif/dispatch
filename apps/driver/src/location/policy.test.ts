import { DEFAULT_DRIVER_STALE_AFTER_S } from '@dispatch/shared';
import { describe, expect, it } from 'vitest';
import { LOCATION_POLICY, heartbeatDue } from './policy';

describe('LOCATION_POLICY', () => {
  it('asks for time-based updates that do not wait for the driver to move', () => {
    expect(LOCATION_POLICY.distanceIntervalM).toBe(0);
    expect(LOCATION_POLICY.timeIntervalMs).toBe(5_000);
  });

  it('keeps a driver who stands still well inside the server staleness window', () => {
    const staleAfterMs = DEFAULT_DRIVER_STALE_AFTER_S * 1000;
    // Even if the operating system reported nothing, two heartbeats fit before a driver goes stale.
    expect(LOCATION_POLICY.heartbeatMs * 2).toBeLessThan(staleAfterMs);
    expect(LOCATION_POLICY.minSpacingMs).toBeLessThan(LOCATION_POLICY.timeIntervalMs);
  });
});

describe('heartbeatDue', () => {
  const now = Date.parse('2026-09-20T10:01:00Z');

  it('asks for a position when none was recorded recently, or ever', () => {
    expect(heartbeatDue(null, now)).toBe(true);
    expect(heartbeatDue(new Date('2026-09-20T10:00:30Z'), now)).toBe(true);
    expect(heartbeatDue(new Date('2026-09-20T10:00:45Z'), now)).toBe(false);
  });
});
