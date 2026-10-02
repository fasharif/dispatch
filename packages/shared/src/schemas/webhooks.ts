import { z } from 'zod';
import { deliveryStatusSchema } from '../delivery.js';
import { isoDateTimeSchema } from './common.js';

/**
 * Webhooks sent to the order system (TopFlow Hub).
 *
 * Every request carries three headers:
 *   x-dispatch-event-id    the event id (same as `id` in the body)
 *   x-dispatch-event-type  the event type (same as `type` in the body)
 *   x-dispatch-signature   t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * Delivery is at least once and unordered, so receivers de-duplicate by event id.
 */
export const WEBHOOK_EVENT_ID_HEADER = 'x-dispatch-event-id';
export const WEBHOOK_EVENT_TYPE_HEADER = 'x-dispatch-event-type';
export const WEBHOOK_SIGNATURE_HEADER = 'x-dispatch-signature';

export const WEBHOOK_EVENT_TYPES = [
  'delivery.assigned',
  'delivery.picked_up',
  'delivery.completed',
  'delivery.failed',
  'delivery.cancelled',
] as const;
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;

export const deliveryWebhookDataSchema = z.object({
  deliveryId: z.uuid(),
  orderReference: z.string(),
  status: deliveryStatusSchema,
  occurredAt: isoDateTimeSchema,
  driver: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** Customer tracking link; present on delivery.assigned. */
  trackingUrl: z.string().optional(),
  /** Failure or cancellation reason. */
  reason: z.string().optional(),
  /** Proof of delivery; present on delivery.completed. */
  proof: z
    .object({
      recipientName: z.string(),
      capturedAt: isoDateTimeSchema,
      withinGeofence: z.boolean(),
      distanceMeters: z.number(),
      hasPhoto: z.boolean(),
      hasSignature: z.boolean(),
    })
    .optional(),
});
export type DeliveryWebhookData = z.infer<typeof deliveryWebhookDataSchema>;

export const webhookEnvelopeSchema = z.object({
  id: z.uuid(),
  type: webhookEventTypeSchema,
  createdAt: isoDateTimeSchema,
  data: deliveryWebhookDataSchema,
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

export const outboxStateSchema = z.enum(['pending', 'delivered', 'failed']);
export type OutboxState = z.infer<typeof outboxStateSchema>;

export const outboxEntrySchema = z.object({
  id: z.uuid(),
  type: webhookEventTypeSchema,
  deliveryId: z.uuid(),
  state: outboxStateSchema,
  attempts: z.int(),
  lastStatus: z.int().nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  deliveredAt: isoDateTimeSchema.nullable(),
  failedAt: isoDateTimeSchema.nullable(),
});
export type OutboxEntryDto = z.infer<typeof outboxEntrySchema>;
