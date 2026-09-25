import type { DeliveryStatus, DriverStatus } from '@dispatch/shared';

/** "850 m" or "12.4 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${String(Math.round(meters))} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

/** "45 s", "12 min", "1 h 05 min". */
export function formatShortDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.max(0, Math.round(seconds)))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "just now", "40 s ago", "3 min ago", "2 h ago". */
export function formatAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${String(seconds)} s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  return `${String(Math.floor(seconds / 3600))} h ago`;
}

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  picked_up: 'Picked up',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const DRIVER_STATUS_LABEL: Record<DriverStatus, string> = {
  offline: 'Off shift',
  available: 'Available',
  busy: 'On a delivery',
};

/** Signature strokes ([x0, y0, x1, y1, …]) as SVG path data. */
export function signaturePath(strokes: readonly (readonly number[])[]): string {
  return strokes
    .map((stroke) => {
      const parts: string[] = [];
      for (let i = 0; i + 1 < stroke.length; i += 2) {
        parts.push(`${i === 0 ? 'M' : 'L'}${String(stroke[i])} ${String(stroke[i + 1])}`);
      }
      return parts.join(' ');
    })
    .join(' ');
}
