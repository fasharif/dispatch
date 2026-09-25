import { z } from 'zod';
import { isoDateTimeSchema, latitudeSchema, longitudeSchema } from './common.js';

/** Largest batch a device may send in one request (a few minutes of offline history per call). */
export const MAX_LOCATION_BATCH = 500;

/**
 * One position fix from a driver's device.
 *
 * `seq` increases by one for every fix a device records, and never repeats for that device.
 * `idempotencyKey` is a random UUID created with the fix. Together they let the server accept a
 * replayed fix exactly once, however many times the device sends it.
 */
export const locationPointSchema = z.object({
  seq: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z.uuid(),
  recordedAt: isoDateTimeSchema,
  lat: latitudeSchema,
  lng: longitudeSchema,
  accuracyM: z.number().min(0).max(10_000).optional(),
  speedMps: z.number().min(0).max(100).optional(),
  headingDeg: z.number().min(0).max(360).optional(),
});
export type LocationPoint = z.infer<typeof locationPointSchema>;

export const locationBatchSchema = z
  .object({
    points: z.array(locationPointSchema).min(1).max(MAX_LOCATION_BATCH),
    /**
     * The sender's clock (Unix milliseconds) when this request left the device. It is carried to
     * dispatcher clients so end-to-end latency can be measured; it is never trusted for ordering.
     */
    sentAt: z.int().positive().optional(),
  })
  .refine((batch) => new Set(batch.points.map((p) => p.seq)).size === batch.points.length, {
    message: 'Each point in a batch needs a different seq',
    path: ['points'],
  })
  .refine(
    (batch) => new Set(batch.points.map((p) => p.idempotencyKey)).size === batch.points.length,
    { message: 'Each point in a batch needs a different idempotencyKey', path: ['points'] },
  );
export type LocationBatch = z.infer<typeof locationBatchSchema>;

/**
 * accepted: stored now. duplicate: stored before (a replay). conflict: the seq or key was already
 * used for a different fix. rejected: failed a server-side check (for example a future timestamp).
 * Every status is final: the device drops the point from its queue whatever the answer.
 */
export const locationPointStatusSchema = z.enum(['accepted', 'duplicate', 'conflict', 'rejected']);
export type LocationPointStatus = z.infer<typeof locationPointStatusSchema>;

export const locationBatchResultSchema = z.object({
  accepted: z.int().min(0),
  duplicates: z.int().min(0),
  results: z.array(
    z.object({
      seq: z.int(),
      idempotencyKey: z.uuid(),
      status: locationPointStatusSchema,
      reason: z.string().optional(),
    }),
  ),
});
export type LocationBatchResult = z.infer<typeof locationBatchResultSchema>;
