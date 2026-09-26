import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  LocationBatch,
  LocationBatchResult,
  LocationPoint,
  LocationPointStatus,
} from '@dispatch/shared';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import type { DevicePrincipal } from '../common/request-context.js';
import { Database } from '../db/database.js';
import { LocationStream, type UnpublishedLocation } from '../realtime/location-stream.js';
import { RealtimePublisher } from '../realtime/realtime.publisher.js';
import { TrackingService } from '../tracking/tracking.service.js';

interface StoredFix {
  seq: number;
  idempotency_key: string;
  device_id: string;
  stream_id: string | null;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  recorded_at: Date;
  sent_at: Date | null;
}

/** A stored fix that is already on the live stream. */
type PublishedFix = StoredFix & { stream_id: string };

function unpublished(device: DevicePrincipal, fix: StoredFix): UnpublishedLocation {
  return {
    driverId: device.driverId,
    deviceId: device.deviceId,
    seq: fix.seq,
    lat: fix.lat,
    lng: fix.lng,
    accuracyM: fix.accuracy_m,
    speedMps: fix.speed_mps,
    headingDeg: fix.heading_deg,
    recordedAt: fix.recorded_at.toISOString(),
    sentAt: fix.sent_at ? fix.sent_at.getTime() : null,
  };
}

/**
 * Ingests batches of fixes from drivers' devices.
 *
 * 1. Every fix is inserted with ON CONFLICT DO NOTHING against (device_id, seq) and the
 *    idempotency key, so replays after an offline period or a lost response are stored once.
 * 2. The driver's current position moves only forward in time (by recorded_at), whatever order
 *    fixes arrive in.
 * 3. New fixes are appended to the live stream and broadcast; the stream id is saved with the
 *    fix. The response is sent only after publishing, so a 2xx means "on the live stream".
 * 4. A replay means the device never saw the first answer, so this instance cannot know how far
 *    the first attempt got. A fix stored but never appended to the stream (stream_id still null)
 *    is published now. A fix already on the stream is broadcast again under its original stream
 *    id: the first instance may have died after saving the stream id but before the Redis adapter
 *    passed the broadcast on, and a console that stayed connected to another instance would never
 *    ask the stream for it. Consoles drop the repeat by device and sequence number.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly db: Database,
    private readonly stream: LocationStream,
    private readonly realtime: RealtimePublisher,
    private readonly tracking: TrackingService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async ingest(device: DevicePrincipal, batch: LocationBatch): Promise<LocationBatchResult> {
    const now = Date.now();
    const maxFuture = now + this.config.drivers.maxClockSkewS * 1000;
    const oldest = now - this.config.locations.historyDays * 86_400_000;
    const statuses = new Map<number, { status: LocationPointStatus; reason?: string }>();
    const candidates: LocationPoint[] = [];
    for (const point of batch.points) {
      const recordedAt = Date.parse(point.recordedAt);
      if (recordedAt > maxFuture) {
        statuses.set(point.seq, { status: 'rejected', reason: 'recordedAt is in the future' });
      } else if (recordedAt < oldest) {
        statuses.set(point.seq, {
          status: 'rejected',
          reason: 'recordedAt is older than the retained history',
        });
      } else {
        candidates.push(point);
      }
    }
    const sentAt = batch.sentAt ? new Date(batch.sentAt) : null;

    const { toPublish, toRebroadcast } = await this.db.tx(async (client) => {
      const inserted = new Set(
        candidates.length === 0
          ? []
          : (
              await client.query<{ seq: number }>(
                `INSERT INTO location_updates
                   (device_id, seq, idempotency_key, driver_id, location, accuracy_m, speed_mps,
                    heading_deg, recorded_at, sent_at)
                 SELECT $1, p.seq, p.key, $2,
                        ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography,
                        p.accuracy, p.speed, p.heading, p.recorded_at, $3
                   FROM unnest($4::bigint[], $5::uuid[], $6::float8[], $7::float8[], $8::real[],
                               $9::real[], $10::real[], $11::timestamptz[])
                        AS p(seq, key, lat, lng, accuracy, speed, heading, recorded_at)
                 ON CONFLICT DO NOTHING
                 RETURNING seq`,
                [
                  device.deviceId,
                  device.driverId,
                  sentAt,
                  candidates.map((p) => p.seq),
                  candidates.map((p) => p.idempotencyKey),
                  candidates.map((p) => p.lat),
                  candidates.map((p) => p.lng),
                  candidates.map((p) => p.accuracyM ?? null),
                  candidates.map((p) => p.speedMps ?? null),
                  candidates.map((p) => p.headingDeg ?? null),
                  candidates.map((p) => p.recordedAt),
                ],
              )
            ).rows.map((row) => row.seq),
      );

      // Everything stored under these seqs or keys: the new rows, and earlier copies of replays.
      const stored = await client.query<StoredFix>(
        `SELECT seq, idempotency_key, device_id, stream_id,
                ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
                accuracy_m, speed_mps, heading_deg, recorded_at, sent_at
           FROM location_updates
          WHERE (device_id = $1 AND seq = ANY($2::bigint[])) OR idempotency_key = ANY($3::uuid[])`,
        [device.deviceId, candidates.map((p) => p.seq), candidates.map((p) => p.idempotencyKey)],
      );
      const bySeq = new Map(
        stored.rows.filter((row) => row.device_id === device.deviceId).map((row) => [row.seq, row]),
      );

      const publish: StoredFix[] = [];
      const rebroadcast: PublishedFix[] = [];
      for (const point of candidates) {
        const row = bySeq.get(point.seq);
        if (inserted.has(point.seq) && row) {
          statuses.set(point.seq, { status: 'accepted' });
          publish.push(row);
        } else if (row && row.idempotency_key === point.idempotencyKey) {
          statuses.set(point.seq, { status: 'duplicate' });
          if (row.stream_id === null) publish.push(row);
          else rebroadcast.push({ ...row, stream_id: row.stream_id });
        } else {
          statuses.set(point.seq, {
            status: 'conflict',
            reason: row
              ? 'This seq was already used for a different fix'
              : 'This idempotencyKey was already used for a different fix',
          });
        }
      }

      const newest = publish.reduce<StoredFix | null>(
        (best, row) => (!best || row.recorded_at > best.recorded_at ? row : best),
        null,
      );
      if (newest) {
        await client.query(
          `UPDATE drivers
              SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
                  location_accuracy_m = $4, location_recorded_at = $5, location_updated_at = now()
            WHERE id = $1 AND (location_recorded_at IS NULL OR location_recorded_at <= $5)`,
          [device.driverId, newest.lng, newest.lat, newest.accuracy_m, newest.recorded_at],
        );
      }
      return {
        toPublish: publish.sort((a, b) => a.seq - b.seq),
        toRebroadcast: rebroadcast.sort((a, b) => a.seq - b.seq),
      };
    });

    if (toPublish.length > 0) await this.publish(device, toPublish);
    if (toRebroadcast.length > 0) {
      this.realtime.driverLocations(
        toRebroadcast.map((fix) => ({
          ...unpublished(device, fix),
          id: fix.stream_id,
          // The stream id starts with the Redis clock (ms) at the original append.
          publishedAt: Number(fix.stream_id.split('-')[0]),
        })),
      );
    }

    const results = batch.points.map((point) => {
      const outcome = statuses.get(point.seq) ?? { status: 'rejected' as const };
      return {
        seq: point.seq,
        idempotencyKey: point.idempotencyKey,
        status: outcome.status,
        ...(outcome.reason && { reason: outcome.reason }),
      };
    });
    return {
      accepted: results.filter((r) => r.status === 'accepted').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      results,
    };
  }

  private async publish(device: DevicePrincipal, fixes: StoredFix[]): Promise<void> {
    let events;
    try {
      events = await this.stream.append(fixes.map((fix) => unpublished(device, fix)));
    } catch (error) {
      // Stored but not published: the device keeps the batch and sends it again, and the
      // replay publishes these fixes (their stream_id is still null).
      this.logger.error(`Could not publish fixes: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Live updates are unavailable; the device will retry');
    }
    await this.db.query(
      `UPDATE location_updates AS l SET stream_id = v.stream_id
         FROM unnest($2::bigint[], $3::text[]) AS v(seq, stream_id)
        WHERE l.device_id = $1 AND l.seq = v.seq`,
      [device.deviceId, events.map((e) => e.seq), events.map((e) => e.id)],
    );
    this.realtime.driverLocations(events);

    // Customers following a delivery this driver is carrying see the new position and ETA.
    try {
      for (const { deliveryId, view } of await this.tracking.viewsForDriver(device.driverId)) {
        this.realtime.trackingUpdated(deliveryId, view);
      }
    } catch (error) {
      this.logger.warn(`Tracking update failed: ${(error as Error).message}`);
    }
  }
}
