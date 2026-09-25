import { z } from 'zod';

export const DELIVERY_STATUSES = [
  'pending',
  'assigned',
  'picked_up',
  'delivered',
  'failed',
  'cancelled',
] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/**
 * Delivery lifecycle:
 *
 *   pending ─► assigned ─► picked_up ─► delivered
 *      │          │  ▲         │
 *      │          └──┘ (re-assign before pickup)
 *      │          │            │
 *      │          ├────────────┴──► failed
 *      └──────────┴────────────┴──► cancelled
 *
 * A driver carries one active delivery (assigned or picked up) at a time.
 */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['assigned', 'picked_up', 'failed', 'cancelled'],
  picked_up: ['delivered', 'failed', 'cancelled'],
  delivered: [],
  failed: [],
  cancelled: [],
};

export const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = ['assigned', 'picked_up'];

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DeliveryStatus,
    readonly to: DeliveryStatus,
  ) {
    super(`A delivery cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const DRIVER_STATUSES = ['offline', 'available', 'busy'] as const;
export const driverStatusSchema = z.enum(DRIVER_STATUSES);
export type DriverStatus = z.infer<typeof driverStatusSchema>;
