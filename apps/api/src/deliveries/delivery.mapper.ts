import type {
  DeliveryDto,
  DeliveryEventDto,
  DeliveryStatus,
  DriverDto,
  DriverStatus,
  Signature,
} from '@dispatch/shared';

/** Columns shared by every delivery read, so all endpoints return the same DeliveryDto. */
export const DELIVERY_SELECT = `
  SELECT dl.id, dl.order_reference, dl.status, dl.recipient_name, dl.recipient_phone,
         dl.address, dl.notes,
         ST_Y(dl.pickup::geometry) AS pickup_lat, ST_X(dl.pickup::geometry) AS pickup_lng,
         ST_Y(dl.dropoff::geometry) AS dropoff_lat, ST_X(dl.dropoff::geometry) AS dropoff_lng,
         dl.driver_id, dr.name AS driver_name, dl.assignment_mode, dl.failure_reason,
         dl.created_at, dl.updated_at, dl.assigned_at, dl.picked_up_at, dl.completed_at, dl.closed_at,
         p.recipient_name AS proof_recipient_name, p.captured_at AS proof_captured_at,
         p.within_geofence AS proof_within_geofence, p.distance_m AS proof_distance_m,
         p.geofence_radius_m AS proof_radius_m, p.signature AS proof_signature
    FROM deliveries dl
    LEFT JOIN drivers dr ON dr.id = dl.driver_id
    LEFT JOIN proofs_of_delivery p ON p.delivery_id = dl.id`;

export interface DeliveryRow {
  id: string;
  order_reference: string;
  status: DeliveryStatus;
  recipient_name: string;
  recipient_phone: string | null;
  address: string;
  notes: string | null;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  driver_id: string | null;
  driver_name: string | null;
  assignment_mode: 'auto' | 'manual' | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  assigned_at: Date | null;
  picked_up_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  proof_recipient_name: string | null;
  proof_captured_at: Date | null;
  proof_within_geofence: boolean | null;
  proof_distance_m: number | null;
  proof_radius_m: number | null;
  proof_signature: Signature | null;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toDeliveryDto(row: DeliveryRow): DeliveryDto {
  return {
    id: row.id,
    orderReference: row.order_reference,
    status: row.status,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    address: row.address,
    notes: row.notes,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng },
    driver: row.driver_id && row.driver_name ? { id: row.driver_id, name: row.driver_name } : null,
    assignmentMode: row.assignment_mode,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    assignedAt: iso(row.assigned_at),
    pickedUpAt: iso(row.picked_up_at),
    completedAt: iso(row.completed_at),
    closedAt: iso(row.closed_at),
    proof:
      row.proof_captured_at && row.proof_signature
        ? {
            recipientName: row.proof_recipient_name ?? '',
            capturedAt: row.proof_captured_at.toISOString(),
            withinGeofence: row.proof_within_geofence ?? false,
            distanceMeters: Math.round((row.proof_distance_m ?? 0) * 10) / 10,
            geofenceRadiusMeters: row.proof_radius_m ?? 0,
            hasPhoto: true,
            signature: row.proof_signature,
          }
        : null,
  };
}

export interface DeliveryEventRow {
  id: number;
  type: string;
  from_status: DeliveryStatus | null;
  to_status: DeliveryStatus;
  actor_type: 'dispatcher' | 'driver' | 'system';
  note: string | null;
  created_at: Date;
}

export function toDeliveryEventDto(row: DeliveryEventRow): DeliveryEventDto {
  return {
    id: String(row.id),
    type: row.type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorType: row.actor_type,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

export const DRIVER_SELECT = `
  SELECT d.id, d.name, d.phone, d.vehicle, d.status,
         ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
         d.location_accuracy_m, d.location_recorded_at,
         (SELECT x.id FROM deliveries x
           WHERE x.driver_id = d.id AND x.status IN ('assigned', 'picked_up')) AS active_delivery_id
    FROM drivers d`;

export interface DriverRow {
  id: string;
  name: string;
  phone: string | null;
  vehicle: string | null;
  status: DriverStatus;
  lat: number | null;
  lng: number | null;
  location_accuracy_m: number | null;
  location_recorded_at: Date | null;
  active_delivery_id: string | null;
}

export function toDriverDto(row: DriverRow): DriverDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    vehicle: row.vehicle,
    status: row.status,
    position:
      row.lat !== null && row.lng !== null && row.location_recorded_at
        ? {
            lat: row.lat,
            lng: row.lng,
            accuracyM: row.location_accuracy_m,
            recordedAt: row.location_recorded_at.toISOString(),
          }
        : null,
    activeDeliveryId: row.active_delivery_id,
  };
}

/** `ST_Point(lng, lat)` as geography: PostGIS takes longitude first. */
export const GEOGRAPHY_POINT = (lngParam: number, latParam: number): string =>
  `ST_SetSRID(ST_MakePoint($${String(lngParam)}, $${String(latParam)}), 4326)::geography`;
