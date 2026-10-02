import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ErrorCode,
  type DeliveryStatus,
  type EtaEstimate,
  type TrackingLinkDto,
  type TrackingResponse,
  type TrackingView,
} from '@dispatch/shared';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { Database, type Queryable, maybeOne } from '../db/database.js';
import { EtaService } from '../eta/eta.service.js';
import { RedisService } from '../redis/redis.service.js';
import { TrackingTokens } from './tracking-tokens.js';

interface TrackingRow {
  id: string;
  order_reference: string;
  status: DeliveryStatus;
  dropoff_lat: number;
  dropoff_lng: number;
  completed_at: Date | null;
  driver_name: string | null;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_recorded_at: Date | null;
}

const TRACKING_SELECT = `
  SELECT dl.id, dl.order_reference, dl.status,
         ST_Y(dl.dropoff::geometry) AS dropoff_lat, ST_X(dl.dropoff::geometry) AS dropoff_lng,
         dl.completed_at, dr.name AS driver_name,
         ST_Y(dr.location::geometry) AS driver_lat, ST_X(dr.location::geometry) AS driver_lng,
         dr.location_recorded_at AS driver_recorded_at
    FROM deliveries dl
    LEFT JOIN drivers dr ON dr.id = dl.driver_id`;

/** Routed ETAs are cached per delivery for this long, so OSRM sees one request per window. */
const ROUTED_ETA_CACHE_S = 15;

@Injectable()
export class TrackingService {
  constructor(
    private readonly db: Database,
    private readonly tokens: TrackingTokens,
    private readonly eta: EtaService,
    private readonly redis: RedisService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  /** A signed link for the customer; any number can be issued for the same delivery. */
  linkFor(deliveryId: string, ttlHours: number = this.config.tracking.ttlHours): TrackingLinkDto {
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    const token = this.tokens.sign(deliveryId, expiresAt);
    return {
      token,
      url: `${this.config.tracking.publicWebUrl}/track/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Resolves a link to its delivery id, or explains why it cannot be used. */
  resolve(token: string): { deliveryId: string; expiresAt: Date } {
    const result = this.tokens.verify(token);
    if (result.status === 'invalid') {
      throw new NotFoundException('This tracking link is not valid');
    }
    if (result.status === 'expired') {
      throw new GoneException({
        message: 'This tracking link has expired. Ask the sender for a new one.',
        code: ErrorCode.TRACKING_LINK_EXPIRED,
      });
    }
    return { deliveryId: result.deliveryId, expiresAt: result.expiresAt };
  }

  async viewByToken(token: string): Promise<TrackingResponse> {
    const { deliveryId, expiresAt } = this.resolve(token);
    const view = await this.view(deliveryId);
    if (!view) throw new NotFoundException('This tracking link is not valid');
    return { ...view, linkExpiresAt: expiresAt.toISOString() };
  }

  async view(deliveryId: string, client: Queryable = this.db.pool): Promise<TrackingView | null> {
    const row = await maybeOne<TrackingRow>(client, `${TRACKING_SELECT} WHERE dl.id = $1`, [
      deliveryId,
    ]);
    return row ? this.toView(row) : null;
  }

  /** Views for the delivery a driver is carrying right now (at most one), after the driver moved. */
  async viewsForDriver(driverId: string): Promise<{ deliveryId: string; view: TrackingView }[]> {
    const found = await this.db.query<TrackingRow>(
      `${TRACKING_SELECT} WHERE dl.driver_id = $1 AND dl.status = 'picked_up'`,
      [driverId],
    );
    return Promise.all(
      found.map(async (row) => ({ deliveryId: row.id, view: await this.toView(row) })),
    );
  }

  private async toView(row: TrackingRow): Promise<TrackingView> {
    const dropoff = { lat: row.dropoff_lat, lng: row.dropoff_lng };
    const onTheWay = row.status === 'picked_up';
    const position =
      onTheWay && row.driver_lat !== null && row.driver_lng !== null
        ? { lat: row.driver_lat, lng: row.driver_lng }
        : null;
    let eta: TrackingView['eta'] = null;
    if (position) {
      const estimate = await this.cachedEta(row.id, position, dropoff);
      eta = {
        ...estimate,
        arrivalAt: new Date(Date.now() + estimate.seconds * 1000).toISOString(),
      };
    }
    return {
      orderReference: row.order_reference,
      status: row.status,
      dropoff,
      driver: row.driver_name
        ? {
            firstName: row.driver_name.trim().split(/\s+/)[0] ?? row.driver_name,
            position,
            positionAt:
              position && row.driver_recorded_at ? row.driver_recorded_at.toISOString() : null,
          }
        : null,
      eta,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    };
  }

  private async cachedEta(
    deliveryId: string,
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
  ): Promise<EtaEstimate> {
    if (!this.eta.routingEnabled) return this.eta.straightLine(from, to);
    const key = `eta:${deliveryId}`;
    const cached = await this.redis.client.get(key);
    if (cached) {
      // Count down the cached travel time by the seconds since it was computed.
      const { estimate, at } = JSON.parse(cached) as { estimate: EtaEstimate; at: number };
      const elapsed = Math.round((Date.now() - at) / 1000);
      return { ...estimate, seconds: Math.max(0, estimate.seconds - elapsed) };
    }
    const estimate = await this.eta.estimate(from, to);
    if (estimate.source === 'osrm') {
      await this.redis.client.set(
        key,
        JSON.stringify({ estimate, at: Date.now() }),
        'EX',
        ROUTED_ETA_CACHE_S,
      );
    }
    return estimate;
  }
}
