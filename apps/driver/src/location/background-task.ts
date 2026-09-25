import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { recordFixes } from '../queue/instance';

export const LOCATION_TASK = 'dispatch-location-updates';

/**
 * Receives positions from the operating system while the driver is on shift, including when
 * the app is in the background. Each position goes into the SQLite queue first, then the queue
 * is sent; with no signal the positions simply wait in the queue.
 */
TaskManager.defineTask<{ locations: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data.locations.length) return;
  await recordFixes(
    data.locations.map((location) => ({
      lat: location.coords.latitude,
      lng: location.coords.longitude,
      recordedAt: new Date(location.timestamp),
      accuracyM: location.coords.accuracy,
      speedMps: location.coords.speed,
      headingDeg: location.coords.heading,
    })),
  );
});
