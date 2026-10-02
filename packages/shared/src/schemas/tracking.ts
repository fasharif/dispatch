import { z } from 'zod';
import { deliveryStatusSchema } from '../delivery.js';
import { isoDateTimeSchema, latLngSchema } from './common.js';
import { etaSchema } from './deliveries.js';

/**
 * What a customer sees through a tracking link. It leaves out the driver's phone, surname and
 * vehicle, and shows the driver's position only while the parcel is on its way.
 */
export const trackingViewSchema = z.object({
  orderReference: z.string(),
  status: deliveryStatusSchema,
  dropoff: latLngSchema,
  driver: z
    .object({
      firstName: z.string(),
      position: latLngSchema.nullable(),
      positionAt: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  eta: etaSchema.extend({ arrivalAt: isoDateTimeSchema }).nullable(),
  completedAt: isoDateTimeSchema.nullable(),
});
export type TrackingView = z.infer<typeof trackingViewSchema>;

/** GET /v1/tracking/:token: the view plus the expiry of the link that was used. */
export const trackingResponseSchema = trackingViewSchema.extend({
  linkExpiresAt: isoDateTimeSchema,
});
export type TrackingResponse = z.infer<typeof trackingResponseSchema>;
