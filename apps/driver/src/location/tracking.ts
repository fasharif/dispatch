import * as Location from 'expo-location';
import { LOCATION_TASK } from './background-task';
import { LOCATION_POLICY } from './policy';

export type PermissionProblem = 'foreground-denied' | 'background-denied' | null;

/** Asks for location "while using" and then "always", which background updates need. */
export async function requestLocationPermissions(): Promise<PermissionProblem> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== Location.PermissionStatus.GRANTED) return 'foreground-denied';
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== Location.PermissionStatus.GRANTED) return 'background-denied';
  return null;
}

export async function startTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    // Time-based updates whether or not the driver moves (see policy.ts).
    timeInterval: LOCATION_POLICY.timeIntervalMs,
    distanceInterval: LOCATION_POLICY.distanceIntervalM,
    // Android: a visible notification keeps the service alive in the background.
    foregroundService: {
      notificationTitle: 'On shift',
      notificationBody: 'Your position is shared with dispatch until you end your shift.',
    },
    // iOS: show the blue bar and keep updating while the app is in the background.
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation,
  });
}

export async function stopTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

/** One fresh position, for the proof-of-delivery geofence check. */
export async function currentPosition(): Promise<{
  lat: number;
  lng: number;
  accuracyM: number | null;
}> {
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyM: position.coords.accuracy,
  };
}
