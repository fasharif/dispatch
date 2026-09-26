import type { DriverStatus } from './delivery.js';
import type { DeliveryDto } from './schemas/deliveries.js';
import type { TrackingView } from './schemas/tracking.js';

/** Socket.IO namespaces. Both accept the WebSocket transport only (no long-polling). */
export const DISPATCH_NAMESPACE = '/dispatch';
export const TRACKING_NAMESPACE = '/tracking';

/**
 * A driver position as broadcast to dispatcher consoles.
 *
 * `id` is the Redis stream entry id ("<ms>-<n>"). Clients remember the newest id they have seen
 * and send it back in a `resume` request after reconnecting, so no position is lost while a
 * connection is down. `deviceId` + `seq` identify the fix itself; clients drop repeats of it.
 */
export interface DriverLocationEvent {
  id: string;
  driverId: string;
  deviceId: string;
  seq: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  recordedAt: string;
  /** Sender clock (Unix ms) when the batch left the device, if the device sent it. */
  sentAt: number | null;
  /** Server clock (Unix ms) when the fix was published. */
  publishedAt: number;
}

export interface DriverStatusEvent {
  driverId: string;
  status: DriverStatus;
}

/**
 * Sent to a dispatcher console once it is connected: which API instance serves the connection
 * (for diagnostics and the scale test) and when its session ends. At that moment the server
 * closes the connection, and the console must sign in again.
 */
export interface DispatchSession {
  instanceId: string;
  expiresAt: string;
}

export interface ResumeRequest {
  /** Newest stream id the client has seen, or null for "only what is new from now on". */
  since: string | null;
  /** Page size; the server caps it. */
  limit?: number;
}

export interface ResumeResponse {
  events: DriverLocationEvent[];
  /** False when more events are waiting: ask again with `since` set to the last id received. */
  complete: boolean;
  /**
   * True when `since` is older than the retained history. The client should reload the full
   * driver list over HTTP before relying on the live stream again.
   */
  gap: boolean;
}

export interface DispatchServerToClientEvents {
  session: (session: DispatchSession) => void;
  'driver:location': (event: DriverLocationEvent) => void;
  'driver:status': (event: DriverStatusEvent) => void;
  'delivery:updated': (delivery: DeliveryDto) => void;
}

export interface DispatchClientToServerEvents {
  resume: (request: ResumeRequest, ack: (response: ResumeResponse) => void) => void;
}

export interface TrackingServerToClientEvents {
  'tracking:update': (view: TrackingView) => void;
}

export type TrackingClientToServerEvents = Record<string, never>;

/** Unique key of a fix, used by clients to drop duplicates after a resume. */
export const fixKey = (event: Pick<DriverLocationEvent, 'deviceId' | 'seq'>): string =>
  `${event.deviceId}:${String(event.seq)}`;

/**
 * Stream ids are "<unix ms>-<sequence>". Comparing them needs both parts, as numbers.
 * Returns a negative number when a < b, zero when equal and positive when a > b.
 */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const byTime = Number(aMs) - Number(bMs);
  return byTime !== 0 ? byTime : Number(aSeq) - Number(bSeq);
}
