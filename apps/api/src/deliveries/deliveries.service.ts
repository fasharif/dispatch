import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ErrorCode,
  assertTransition,
  type AssignDeliveryInput,
  type CandidateDto,
  type CreateDeliveryInput,
  type DeliveryDetailDto,
  type DeliveryDto,
  type DeliveryListQuery,
  type DeliveryStatus,
  type DeliveryWebhookData,
  type DriverStatus,
  type WebhookEventType,
} from '@dispatch/shared';
import type pg from 'pg';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import type { DevicePrincipal, DispatcherPrincipal } from '../common/request-context.js';
import { Database, PgError, isPgError, maybeOne, one, rows } from '../db/database.js';
import { EtaService } from '../eta/eta.service.js';
import { OutboxQueue } from '../outbox/outbox.queue.js';
import { OutboxRepository } from '../outbox/outbox.repository.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { TrackingService } from '../tracking/tracking.service.js';
import {
  DELIVERY_SELECT,
  toDeliveryDto,
  toDeliveryEventDto,
  type DeliveryEventRow,
  type DeliveryRow,
} from './delivery.mapper.js';

export type Actor =
  | { type: 'dispatcher'; id: string }
  | { type: 'driver'; id: string }
  | { type: 'system'; id: null };

export const dispatcherActor = (d: DispatcherPrincipal): Actor => ({
  type: 'dispatcher',
  id: d.id,
});
export const driverActor = (d: DevicePrincipal): Actor => ({ type: 'driver', id: d.driverId });

interface LockedDelivery {
  id: string;
  status: DeliveryStatus;
  driver_id: string | null;
  order_reference: string;
  pickup_lat: number;
  pickup_lng: number;
}

/** How many of the nearest free drivers an automatic assignment tries to lock, in order. */
const NEAREST_CANDIDATES = 10;

interface NearbyDriverRow {
  id: string;
  name: string;
  status: DriverStatus;
  distance_m: number;
  lat: number;
  lng: number;
  location_recorded_at: Date;
  stale: boolean;
}

/** What a committed change produced, to broadcast and enqueue after the transaction. */
export interface ChangeEffects {
  deliveryId: string;
  outboxIds: string[];
  driverStatuses: { driverId: string; status: DriverStatus }[];
}

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly db: Database,
    private readonly outbox: OutboxRepository,
    private readonly queue: OutboxQueue,
    private readonly realtime: RealtimePublisher,
    private readonly tracking: TrackingService,
    private readonly eta: EtaService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  async list(query: DeliveryListQuery): Promise<DeliveryDto[]> {
    const statuses: DeliveryStatus[] | null =
      query.status === 'active'
        ? ['assigned', 'picked_up']
        : query.status === 'open'
          ? ['pending', 'assigned', 'picked_up']
          : query.status
            ? [query.status]
            : null;
    const found = await this.db.query<DeliveryRow>(
      `${DELIVERY_SELECT}
        WHERE ($1::delivery_status[] IS NULL OR dl.status = ANY($1::delivery_status[]))
        ORDER BY dl.created_at DESC
        LIMIT $2`,
      [statuses, query.limit],
    );
    return found.map(toDeliveryDto);
  }

  async get(id: string, client: pg.ClientBase | pg.Pool = this.db.pool): Promise<DeliveryDto> {
    const row = await maybeOne<DeliveryRow>(client, `${DELIVERY_SELECT} WHERE dl.id = $1`, [id]);
    if (!row) throw new NotFoundException('Delivery not found');
    return toDeliveryDto(row);
  }

  async detail(id: string): Promise<DeliveryDetailDto> {
    const delivery = await this.get(id);
    const events = await this.db.query<DeliveryEventRow>(
      `SELECT id, type, from_status, to_status, actor_type, note, created_at
         FROM delivery_events WHERE delivery_id = $1 ORDER BY id`,
      [id],
    );
    return { ...delivery, events: events.map(toDeliveryEventDto) };
  }

  /**
   * Free drivers nearest to the pickup point, nearest first, found with a KNN index scan
   * (ORDER BY location <-> point). Stale drivers are listed for manual override but flagged.
   */
  async candidates(id: string, limit = 5): Promise<CandidateDto[]> {
    const delivery = await this.get(id);
    const found = await this.nearbyDrivers(this.db.pool, delivery.pickup, limit, false);
    const etas = await this.eta.estimateMany(
      found.map((row) => ({ lat: row.lat, lng: row.lng })),
      delivery.pickup,
    );
    return found.map((row, index) => ({
      driverId: row.id,
      name: row.name,
      status: row.status,
      distanceMeters: Math.round(row.distance_m),
      eta: etas[index] ?? this.eta.straightLine({ lat: row.lat, lng: row.lng }, delivery.pickup),
      locationRecordedAt: row.location_recorded_at.toISOString(),
      stale: row.stale,
    }));
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  async create(input: CreateDeliveryInput, dispatcher: DispatcherPrincipal): Promise<DeliveryDto> {
    let id: string;
    try {
      id = await this.db.tx(async (client) => {
        const created = await one<{ id: string }>(
          client,
          `INSERT INTO deliveries
             (order_reference, recipient_name, recipient_phone, address, notes, pickup, dropoff, created_by)
           VALUES ($1, $2, $3, $4, $5,
                   ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography,
                   ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, $10)
           RETURNING id`,
          [
            input.orderReference,
            input.recipientName,
            input.recipientPhone ?? null,
            input.address,
            input.notes ?? null,
            input.pickup.lng,
            input.pickup.lat,
            input.dropoff.lng,
            input.dropoff.lat,
            dispatcher.id,
          ],
        );
        await this.recordEvent(
          client,
          created.id,
          'created',
          null,
          'pending',
          dispatcherActor(dispatcher),
          null,
        );
        return created.id;
      });
    } catch (error) {
      if (isPgError(error, PgError.UNIQUE_VIOLATION)) {
        throw new ConflictException(
          `Order ${input.orderReference} already has a delivery in progress or delivered`,
        );
      }
      throw error;
    }
    const created = await this.get(id);
    this.realtime.deliveryUpdated(created);
    if (!input.autoAssign) return created;
    try {
      return await this.assign(id, {}, dispatcher);
    } catch (error) {
      // The delivery exists either way: with no driver free it waits, pending, for one.
      if (errorCode(error) === ErrorCode.NO_DRIVER_AVAILABLE) return created;
      throw error;
    }
  }

  /**
   * Assigns a driver. Without a driverId, the nearest available driver with a fresh fix is
   * found with a KNN query and locked (FOR UPDATE SKIP LOCKED), so two dispatchers assigning at
   * once never get the same driver; the database also allows one active delivery per driver.
   * With a driverId, the dispatcher overrides the choice; before pickup this also re-assigns.
   */
  async assign(
    id: string,
    input: AssignDeliveryInput,
    dispatcher: DispatcherPrincipal,
  ): Promise<DeliveryDto> {
    const actor = dispatcherActor(dispatcher);
    const effects = await this.db
      .tx(async (client) => {
        const delivery = await this.lock(client, id);
        assertTransition(delivery.status, 'assigned');
        const driver = input.driverId
          ? await this.lockChosenDriver(client, input.driverId, delivery.driver_id)
          : await this.lockNearestDriver(client, {
              lat: delivery.pickup_lat,
              lng: delivery.pickup_lng,
            });

        const driverStatuses: ChangeEffects['driverStatuses'] = [];
        if (delivery.driver_id && delivery.driver_id !== driver.id) {
          // Re-assignment: the previous driver is free again.
          await client.query(
            `UPDATE drivers SET status = 'available' WHERE id = $1 AND status = 'busy'`,
            [delivery.driver_id],
          );
          driverStatuses.push({ driverId: delivery.driver_id, status: 'available' });
        }
        await client.query(`UPDATE drivers SET status = 'busy' WHERE id = $1`, [driver.id]);
        driverStatuses.push({ driverId: driver.id, status: 'busy' });
        const mode = input.driverId ? 'manual' : 'auto';
        await client.query(
          `UPDATE deliveries
            SET status = 'assigned', driver_id = $2, assignment_mode = $3,
                assigned_at = now(), updated_at = now()
          WHERE id = $1`,
          [id, driver.id, mode],
        );
        await this.recordEvent(
          client,
          id,
          delivery.status === 'assigned' ? 'reassigned' : 'assigned',
          delivery.status,
          'assigned',
          actor,
          `${mode === 'auto' ? 'Nearest free driver' : 'Chosen by dispatcher'}: ${driver.name}` +
            (driver.distanceMeters !== null
              ? ` (${String(Math.round(driver.distanceMeters))} m from pickup)`
              : ''),
        );
        const link = this.tracking.linkFor(id);
        const outboxId = await this.addOutbox(client, id, 'delivery.assigned', {
          trackingUrl: link.url,
        });
        return { deliveryId: id, outboxIds: [outboxId], driverStatuses };
      })
      .catch((error: unknown) => {
        if (isPgError(error, PgError.UNIQUE_VIOLATION)) {
          throw new ConflictException({
            message: 'That driver already has a delivery in progress',
            code: ErrorCode.DRIVER_BUSY,
          });
        }
        throw error;
      });
    return this.afterCommit(effects);
  }

  async pickUp(id: string, device: DevicePrincipal): Promise<DeliveryDto> {
    const effects = await this.db.tx(async (client) => {
      const delivery = await this.lockForDriver(client, id, device);
      assertTransition(delivery.status, 'picked_up');
      await client.query(
        `UPDATE deliveries SET status = 'picked_up', picked_up_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
      await this.recordEvent(
        client,
        id,
        'picked_up',
        delivery.status,
        'picked_up',
        driverActor(device),
        null,
      );
      const outboxId = await this.addOutbox(client, id, 'delivery.picked_up', {});
      return { deliveryId: id, outboxIds: [outboxId], driverStatuses: [] };
    });
    return this.afterCommit(effects);
  }

  async fail(id: string, reason: string, device: DevicePrincipal): Promise<DeliveryDto> {
    const effects = await this.db.tx(async (client) => {
      const delivery = await this.lockForDriver(client, id, device);
      assertTransition(delivery.status, 'failed');
      return this.close(client, delivery, 'failed', reason, driverActor(device));
    });
    return this.afterCommit(effects);
  }

  async cancel(id: string, reason: string, dispatcher: DispatcherPrincipal): Promise<DeliveryDto> {
    const effects = await this.db.tx(async (client) => {
      const delivery = await this.lock(client, id);
      assertTransition(delivery.status, 'cancelled');
      return this.close(client, delivery, 'cancelled', reason, dispatcherActor(dispatcher));
    });
    return this.afterCommit(effects);
  }

  // ─── Shared by the proof-of-delivery flow ────────────────────────────────

  async lockForDriver(
    client: pg.ClientBase,
    id: string,
    device: DevicePrincipal,
  ): Promise<LockedDelivery> {
    const delivery = await this.lock(client, id);
    if (delivery.driver_id !== device.driverId) {
      throw new ForbiddenException('This delivery is not assigned to you');
    }
    return delivery;
  }

  async recordEvent(
    client: pg.ClientBase,
    deliveryId: string,
    type: string,
    from: DeliveryStatus | null,
    to: DeliveryStatus,
    actor: Actor,
    note: string | null,
    details: Record<string, unknown> | null = null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO delivery_events (delivery_id, type, from_status, to_status, actor_type, actor_id, note, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        deliveryId,
        type,
        from,
        to,
        actor.type,
        actor.id,
        note,
        details ? JSON.stringify(details) : null,
      ],
    );
  }

  /** Builds the webhook payload from the committed-to-be state and writes it to the outbox. */
  async addOutbox(
    client: pg.ClientBase,
    deliveryId: string,
    type: WebhookEventType,
    extra: Partial<DeliveryWebhookData>,
  ): Promise<string> {
    const current = await this.get(deliveryId, client);
    return this.outbox.add(client, type, {
      deliveryId,
      orderReference: current.orderReference,
      status: current.status,
      occurredAt: new Date().toISOString(),
      driver: current.driver,
      ...extra,
    });
  }

  /** Broadcasts a committed change and hands its webhook events to the queue. */
  async afterCommit(effects: ChangeEffects): Promise<DeliveryDto> {
    this.queue.enqueueAfterCommit(effects.outboxIds);
    for (const change of effects.driverStatuses) this.realtime.driverStatus(change);
    const delivery = await this.get(effects.deliveryId);
    this.realtime.deliveryUpdated(delivery);
    const view = await this.tracking.view(effects.deliveryId);
    if (view) this.realtime.trackingUpdated(effects.deliveryId, view);
    return delivery;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async close(
    client: pg.ClientBase,
    delivery: LockedDelivery,
    status: 'failed' | 'cancelled',
    reason: string,
    actor: Actor,
  ): Promise<ChangeEffects> {
    await client.query(
      `UPDATE deliveries SET status = $2, failure_reason = $3, closed_at = now(), updated_at = now()
        WHERE id = $1`,
      [delivery.id, status, reason],
    );
    const driverStatuses: ChangeEffects['driverStatuses'] = [];
    if (delivery.driver_id && delivery.status !== 'pending') {
      await client.query(
        `UPDATE drivers SET status = 'available' WHERE id = $1 AND status = 'busy'`,
        [delivery.driver_id],
      );
      driverStatuses.push({ driverId: delivery.driver_id, status: 'available' });
    }
    await this.recordEvent(client, delivery.id, status, delivery.status, status, actor, reason);
    const outboxId = await this.addOutbox(
      client,
      delivery.id,
      status === 'failed' ? 'delivery.failed' : 'delivery.cancelled',
      { reason },
    );
    return { deliveryId: delivery.id, outboxIds: [outboxId], driverStatuses };
  }

  private async lock(client: pg.ClientBase, id: string): Promise<LockedDelivery> {
    const delivery = await maybeOne<LockedDelivery>(
      client,
      `SELECT id, status, driver_id, order_reference,
              ST_Y(pickup::geometry) AS pickup_lat, ST_X(pickup::geometry) AS pickup_lng
         FROM deliveries WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!delivery) throw new NotFoundException('Delivery not found');
    return delivery;
  }

  private async nearbyDrivers(
    client: pg.ClientBase | pg.Pool,
    point: { lat: number; lng: number },
    limit: number,
    freshOnly: boolean,
  ): Promise<NearbyDriverRow[]> {
    // ORDER BY location <-> point walks the partial GiST index on available drivers nearest first.
    return rows<NearbyDriverRow>(
      client,
      `SELECT d.id, d.name, d.status,
              ST_Distance(d.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m,
              ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng,
              d.location_recorded_at,
              d.location_recorded_at < now() - make_interval(secs => $3) AS stale
         FROM drivers d
        WHERE d.status = 'available'
          AND d.location IS NOT NULL
          ${freshOnly ? 'AND d.location_recorded_at >= now() - make_interval(secs => $3)' : ''}
        ORDER BY d.location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        LIMIT $4`,
      [point.lng, point.lat, this.config.drivers.staleAfterS, limit],
    );
  }

  /**
   * Finds the nearest free driver with the KNN query, then locks that driver by primary key with
   * FOR UPDATE SKIP LOCKED, re-checking that the driver is still free. If a concurrent assignment
   * took the driver, the next nearest is tried. Locking by key rather than inside the index-ordered
   * scan keeps the lock step simple and independent of the spatial index.
   */
  private async lockNearestDriver(
    client: pg.ClientBase,
    pickup: { lat: number; lng: number },
  ): Promise<{ id: string; name: string; distanceMeters: number | null }> {
    const candidates = await this.nearbyDrivers(client, pickup, NEAREST_CANDIDATES, true);
    for (const candidate of candidates) {
      const locked = await maybeOne<{ id: string }>(
        client,
        `SELECT id FROM drivers
          WHERE id = $1 AND status = 'available'
            AND location_recorded_at >= now() - make_interval(secs => $2)
          FOR UPDATE SKIP LOCKED`,
        [candidate.id, this.config.drivers.staleAfterS],
      );
      if (locked) {
        return { id: candidate.id, name: candidate.name, distanceMeters: candidate.distance_m };
      }
    }
    throw new ConflictException({
      message: 'No driver is available near the pickup point right now',
      code: ErrorCode.NO_DRIVER_AVAILABLE,
    });
  }

  private async lockChosenDriver(
    client: pg.ClientBase,
    driverId: string,
    currentDriverId: string | null,
  ): Promise<{ id: string; name: string; distanceMeters: number | null }> {
    const driver = await maybeOne<{ id: string; name: string; status: DriverStatus }>(
      client,
      'SELECT id, name, status FROM drivers WHERE id = $1 FOR UPDATE',
      [driverId],
    );
    if (!driver) throw new NotFoundException('Driver not found');
    if (driver.id === currentDriverId) {
      throw new ConflictException('This delivery is already assigned to that driver');
    }
    if (driver.status === 'offline') {
      throw new ConflictException(`${driver.name} is off shift`);
    }
    if (driver.status === 'busy') {
      throw new ConflictException({
        message: `${driver.name} already has a delivery in progress`,
        code: ErrorCode.DRIVER_BUSY,
      });
    }
    return { id: driver.id, name: driver.name, distanceMeters: null };
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ConflictException)) return undefined;
  const response = error.getResponse();
  return typeof response === 'object' ? (response as { code?: string }).code : undefined;
}
