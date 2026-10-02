import { z } from 'zod';
import { driverStatusSchema } from '../delivery.js';
import { isoDateTimeSchema, latitudeSchema, longitudeSchema, phoneSchema } from './common.js';
import { deliverySchema } from './deliveries.js';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const dispatcherSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
});
export type DispatcherDto = z.infer<typeof dispatcherSchema>;

export const loginResultSchema = z.object({
  accessToken: z.string(),
  expiresAt: isoDateTimeSchema,
  dispatcher: dispatcherSchema,
});
export type LoginResult = z.infer<typeof loginResultSchema>;

export const driverPositionSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
  accuracyM: z.number().nullable(),
  recordedAt: isoDateTimeSchema,
});
export type DriverPosition = z.infer<typeof driverPositionSchema>;

export const driverSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  vehicle: z.string().nullable(),
  status: driverStatusSchema,
  position: driverPositionSchema.nullable(),
  activeDeliveryId: z.uuid().nullable(),
  /** Set when a dispatcher deactivated the driver: every phone is revoked and none can enrol. */
  deactivatedAt: isoDateTimeSchema.nullable(),
});
export type DriverDto = z.infer<typeof driverSchema>;

/** A phone enrolled for a driver. Its token is never shown again after enrolment. */
export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: isoDateTimeSchema,
  /** Updated at most once a minute while the phone calls the API. */
  lastSeenAt: isoDateTimeSchema.nullable(),
  /** A revoked phone's token is refused from then on. */
  revokedAt: isoDateTimeSchema.nullable(),
});
export type DeviceDto = z.infer<typeof deviceSchema>;

export const createDriverSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneSchema.optional(),
  vehicle: z.string().trim().max(60).optional(),
});
export type CreateDriverInput = z.infer<typeof createDriverSchema>;

export const enrolmentCodeSchema = z.object({
  driverId: z.uuid(),
  code: z.string(),
  expiresAt: isoDateTimeSchema,
});
export type EnrolmentCodeDto = z.infer<typeof enrolmentCodeSchema>;

/** Codes are 8 characters from an unambiguous alphabet (no 0/O or 1/I/L). */
export const ENROLMENT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ENROLMENT_CODE_LENGTH = 8;

export const enrolDeviceSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .transform((code) => code.replace(/[\s-]/g, ''))
    .pipe(z.string().length(ENROLMENT_CODE_LENGTH, 'The enrolment code has 8 characters')),
  deviceName: z.string().trim().min(1).max(80),
});
export type EnrolDeviceInput = z.input<typeof enrolDeviceSchema>;
export type EnrolDevice = z.output<typeof enrolDeviceSchema>;

export const enrolDeviceResultSchema = z.object({
  deviceId: z.uuid(),
  /** Shown once. The server keeps only its SHA-256 hash. */
  deviceToken: z.string(),
  driver: driverSchema,
});
export type EnrolDeviceResult = z.infer<typeof enrolDeviceResultSchema>;

export const shiftSchema = z.object({ onShift: z.boolean() });
export type ShiftInput = z.infer<typeof shiftSchema>;

export const driverHomeSchema = z.object({
  driver: driverSchema,
  activeDelivery: deliverySchema.nullable(),
});
export type DriverHomeDto = z.infer<typeof driverHomeSchema>;
