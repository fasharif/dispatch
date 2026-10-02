import * as Crypto from 'expo-crypto';
import { DriverApi } from '../api/client';
import { LOCATION_POLICY } from '../location/policy';
import { loadCredentials } from '../storage/credentials';
import { openExpoSqlite } from './expo-sqlite';
import { LocationQueue, type RawFix } from './location-queue';
import { replay, type ReplayResult } from './replay';

let opening: Promise<LocationQueue> | null = null;

/** The one queue of this JavaScript runtime, opened on first use. */
export function getQueue(): Promise<LocationQueue> {
  opening ??= (async () => {
    const queue = new LocationQueue(await openExpoSqlite(), {
      uuid: () => Crypto.randomUUID(),
      minSpacingMs: LOCATION_POLICY.minSpacingMs,
    });
    await queue.init();
    return queue;
  })();
  return opening;
}

let syncing: Promise<ReplayResult | null> | null = null;

/**
 * Sends what is queued, if the phone is enrolled. Concurrent calls share one run, so the
 * background task and the screen never send the same batch twice at the same moment.
 */
export function syncQueue(maxBatches = 20): Promise<ReplayResult | null> {
  syncing ??= (async () => {
    try {
      const credentials = await loadCredentials();
      if (!credentials) return null;
      const queue = await getQueue();
      return await replay(queue, new DriverApi(credentials.apiUrl, credentials.deviceToken), {
        batchSize: 100,
        maxBatches,
      });
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Records fixes from the location service and tries to send them straight away. */
export async function recordFixes(fixes: RawFix[]): Promise<void> {
  if (fixes.length === 0) return;
  const queue = await getQueue();
  await queue.enqueue(fixes);
  // A failed send is fine: the fixes stay queued for the next attempt.
  await syncQueue(5).catch(() => null);
}
