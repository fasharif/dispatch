import { z } from 'zod';

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const latLngSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});

export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** E.164-style phone numbers with optional spaces, e.g. "+971 50 123 4567". */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ]{7,20}$/, 'Enter a phone number with digits, spaces and an optional +');

/** Uniform error envelope returned by every API failure. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  details?: { path: string; message: string }[];
  requestId?: string;
}

/** Stable machine-readable error codes that clients branch on. */
export const ErrorCode = {
  GEOFENCE_VIOLATION: 'GEOFENCE_VIOLATION',
  NO_DRIVER_AVAILABLE: 'NO_DRIVER_AVAILABLE',
  DRIVER_BUSY: 'DRIVER_BUSY',
  TRACKING_LINK_EXPIRED: 'TRACKING_LINK_EXPIRED',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
