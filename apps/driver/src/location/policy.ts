/**
 * How often the driver app records a position while on shift. Kept free of Expo imports so the
 * values and the rules can be unit-tested under Node.
 *
 * - distanceIntervalM is 0. expo-location treats timeInterval and distanceInterval as minimums
 *   that must both be met, so any distance would stop updates for a driver waiting at the
 *   warehouse. After the API's DRIVER_STALE_AFTER_S (120 s by default) without a fix, that driver
 *   would no longer be offered deliveries automatically.
 * - timeIntervalMs is honoured on Android. iOS ignores it and reports positions as Core Location
 *   produces them, up to about one a second, so the queue keeps at most one per minSpacingMs.
 * - heartbeatMs: while the app is open on shift, it asks for a position itself when none has been
 *   recorded for this long, in case the operating system reports nothing for a driver standing
 *   still.
 */
export const LOCATION_POLICY = {
  timeIntervalMs: 5_000,
  distanceIntervalM: 0,
  minSpacingMs: 4_000,
  heartbeatMs: 30_000,
} as const;

/** True when the newest recorded fix is older than the heartbeat interval (or there is none). */
export function heartbeatDue(
  lastRecordedAt: Date | null,
  now: number,
  heartbeatMs: number = LOCATION_POLICY.heartbeatMs,
): boolean {
  return lastRecordedAt === null || now - lastRecordedAt.getTime() >= heartbeatMs;
}
