import { z } from 'zod';
import { deliveryStatusSchema, driverStatusSchema } from '../delivery.js';
import { isoDateTimeSchema, latLngSchema, phoneSchema } from './common.js';

const reasonSchema = z
  .string()
  .trim()
  .min(3, 'Give a reason of at least 3 characters')
  .max(300, 'Keep the reason under 300 characters');

/** TopFlow order numbers look like TF-SO-2026-000123; other systems may use similar references. */
export const orderReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Use letters, digits, dots, dashes and slashes only');

export const createDeliverySchema = z.object({
  orderReference: orderReferenceSchema,
  recipientName: z.string().trim().min(1).max(120),
  recipientPhone: phoneSchema.optional(),
  address: z.string().trim().min(3).max(300),
  notes: z.string().trim().max(500).optional(),
  pickup: latLngSchema,
  dropoff: latLngSchema,
  /** Assign the nearest free driver straight away. */
  autoAssign: z.boolean().default(false),
});
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;

export const assignDeliverySchema = z.object({
  /** Omit for automatic assignment to the nearest free driver; set it to override manually. */
  driverId: z.uuid().optional(),
});
export type AssignDeliveryInput = z.infer<typeof assignDeliverySchema>;

export const reasonInputSchema = z.object({ reason: reasonSchema });
export type ReasonInput = z.infer<typeof reasonInputSchema>;

export const deliveryListQuerySchema = z.object({
  status: z
    .union([deliveryStatusSchema, z.literal('active'), z.literal('open')])
    .optional()
    .describe('active = assigned or picked up; open = pending, assigned or picked up'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;

export const signatureSchema = z
  .object({
    width: z.int().min(50).max(2000),
    height: z.int().min(50).max(2000),
    /** Each stroke is a flat list of coordinates: [x0, y0, x1, y1, …] in the pad's pixel space. */
    strokes: z
      .array(z.array(z.number().min(0).max(2000)).min(2).max(4000))
      .min(1)
      .max(200),
  })
  .refine((s) => s.strokes.every((stroke) => stroke.length % 2 === 0), {
    message: 'Every stroke needs x and y pairs',
    path: ['strokes'],
  })
  .refine((s) => s.strokes.reduce((sum, stroke) => sum + stroke.length / 2, 0) <= 5000, {
    message: 'The signature has too many points',
    path: ['strokes'],
  });
export type Signature = z.infer<typeof signatureSchema>;

/** The JSON part of a proof-of-delivery submission; the photo travels as a file in the same request. */
export const proofOfDeliverySchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  position: latLngSchema,
  accuracyM: z.number().min(0).max(10_000).optional(),
  capturedAt: isoDateTimeSchema,
  signature: signatureSchema,
});
export type ProofOfDeliveryInput = z.infer<typeof proofOfDeliverySchema>;

export const proofSummarySchema = z.object({
  recipientName: z.string(),
  capturedAt: isoDateTimeSchema,
  withinGeofence: z.boolean(),
  distanceMeters: z.number(),
  geofenceRadiusMeters: z.number(),
  hasPhoto: z.boolean(),
  signature: signatureSchema,
});
export type ProofSummary = z.infer<typeof proofSummarySchema>;

export const deliveryEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  fromStatus: deliveryStatusSchema.nullable(),
  toStatus: deliveryStatusSchema,
  actorType: z.enum(['dispatcher', 'driver', 'system']),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type DeliveryEventDto = z.infer<typeof deliveryEventSchema>;

export const deliverySchema = z.object({
  id: z.uuid(),
  orderReference: z.string(),
  status: deliveryStatusSchema,
  recipientName: z.string(),
  recipientPhone: z.string().nullable(),
  address: z.string(),
  notes: z.string().nullable(),
  pickup: latLngSchema,
  dropoff: latLngSchema,
  driver: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  assignmentMode: z.enum(['auto', 'manual']).nullable(),
  failureReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  assignedAt: isoDateTimeSchema.nullable(),
  pickedUpAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  proof: proofSummarySchema.nullable(),
});
export type DeliveryDto = z.infer<typeof deliverySchema>;

export const deliveryDetailSchema = deliverySchema.extend({
  events: z.array(deliveryEventSchema),
});
export type DeliveryDetailDto = z.infer<typeof deliveryDetailSchema>;

export const etaSchema = z.object({
  seconds: z.int().min(0),
  distanceMeters: z.int().min(0),
  source: z.enum(['osrm', 'straight_line']),
});

export const candidateSchema = z.object({
  driverId: z.uuid(),
  name: z.string(),
  status: driverStatusSchema,
  distanceMeters: z.number(),
  eta: etaSchema,
  locationRecordedAt: isoDateTimeSchema,
  /** No fix for longer than the staleness limit: shown for manual override, never auto-assigned. */
  stale: z.boolean(),
});
export type CandidateDto = z.infer<typeof candidateSchema>;

export const trackingLinkSchema = z.object({
  url: z.string(),
  token: z.string(),
  expiresAt: isoDateTimeSchema,
});
export type TrackingLinkDto = z.infer<typeof trackingLinkSchema>;

export const trackingLinkInputSchema = z.object({
  /** Link lifetime in hours (default from the server configuration). */
  ttlHours: z.int().min(1).max(168).optional(),
});
