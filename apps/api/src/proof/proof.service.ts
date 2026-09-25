import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  ErrorCode,
  assertTransition,
  type DeliveryDto,
  type ProofOfDeliveryInput,
} from '@dispatch/shared';
import type { ReadStream } from 'node:fs';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import type { DevicePrincipal } from '../common/request-context.js';
import { Database, one } from '../db/database.js';
import {
  DeliveriesService,
  driverActor,
  type ChangeEffects,
} from '../deliveries/deliveries.service.js';
import { PhotoStorage, detectImage } from './photo-storage.js';

export interface UploadedPhoto {
  buffer: Buffer;
  size: number;
}

interface GeofenceRow {
  distance_m: number;
  within: boolean;
}

/**
 * Completes a delivery with proof: a photo, the recipient's signature and the device's
 * position, which must lie within the geofence around the drop-off point (ST_DWithin on the
 * ellipsoid). The fence is GEOFENCE_RADIUS_M, widened by the fix's reported accuracy up to
 * GEOFENCE_ACCURACY_ALLOWANCE_M, so an honest but imprecise fix at the door is not refused.
 */
@Injectable()
export class ProofService {
  constructor(
    private readonly db: Database,
    private readonly deliveries: DeliveriesService,
    private readonly photos: PhotoStorage,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async complete(
    id: string,
    device: DevicePrincipal,
    proof: ProofOfDeliveryInput,
    photo: UploadedPhoto | undefined,
    idempotencyKey: string | null,
  ): Promise<DeliveryDto> {
    if (!photo || photo.size === 0) {
      throw new BadRequestException('Attach a photo of the delivered parcel (field "photo")');
    }
    if (photo.size > this.config.uploads.maxPhotoBytes) {
      throw new PayloadTooLargeException(
        `The photo is larger than ${String(Math.round(this.config.uploads.maxPhotoBytes / 1024 / 1024))} MB`,
      );
    }
    const image = detectImage(photo.buffer);
    if (!image) {
      throw new UnsupportedMediaTypeException({
        message: 'The photo must be a JPEG, PNG or WebP image',
        code: ErrorCode.UNSUPPORTED_MEDIA,
      });
    }

    // A retry of a completion that already succeeded returns the same result.
    if (idempotencyKey && (await this.alreadyCompleted(id, device, idempotencyKey))) {
      return this.deliveries.get(id);
    }

    const stored = await this.photos.save(id, photo.buffer, image.extension);
    let effects: ChangeEffects;
    try {
      effects = await this.db.tx(async (client) => {
        const delivery = await this.deliveries.lockForDriver(client, id, device);
        assertTransition(delivery.status, 'delivered');

        const radius =
          this.config.geofence.radiusM +
          Math.min(proof.accuracyM ?? 0, this.config.geofence.accuracyAllowanceM);
        const fence = await one<GeofenceRow>(
          client,
          `SELECT ST_Distance(dropoff, p.pt) AS distance_m, ST_DWithin(dropoff, p.pt, $4) AS within
             FROM deliveries,
                  LATERAL (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS pt) AS p
            WHERE id = $1`,
          [id, proof.position.lng, proof.position.lat, radius],
        );
        if (!fence.within) {
          throw new UnprocessableEntityException({
            message:
              `You are ${String(Math.round(fence.distance_m))} m from the drop-off point. ` +
              `Proof of delivery must be captured within ${String(Math.round(radius))} m of it.`,
            code: ErrorCode.GEOFENCE_VIOLATION,
          });
        }

        await client.query(
          `INSERT INTO proofs_of_delivery
             (delivery_id, idempotency_key, recipient_name, signature, photo_path, photo_content_type,
              photo_bytes, photo_sha256, location, accuracy_m, distance_m, geofence_radius_m,
              within_geofence, captured_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography, $11, $12, $13, true, $14)`,
          [
            id,
            idempotencyKey,
            proof.recipientName,
            JSON.stringify(proof.signature),
            stored.path,
            image.contentType,
            photo.size,
            stored.sha256,
            proof.position.lng,
            proof.position.lat,
            proof.accuracyM ?? null,
            fence.distance_m,
            radius,
            proof.capturedAt,
          ],
        );
        await client.query(
          `UPDATE deliveries SET status = 'delivered', completed_at = now(), updated_at = now()
            WHERE id = $1`,
          [id],
        );
        await client.query(
          `UPDATE drivers SET status = 'available' WHERE id = $1 AND status = 'busy'`,
          [device.driverId],
        );
        await this.deliveries.recordEvent(
          client,
          id,
          'delivered',
          delivery.status,
          'delivered',
          driverActor(device),
          `Signed by ${proof.recipientName}, ${String(Math.round(fence.distance_m))} m from the drop-off point`,
          { distanceMeters: fence.distance_m, radiusMeters: radius, photoSha256: stored.sha256 },
        );
        const outboxId = await this.deliveries.addOutbox(client, id, 'delivery.completed', {
          proof: {
            recipientName: proof.recipientName,
            capturedAt: new Date(proof.capturedAt).toISOString(),
            withinGeofence: true,
            distanceMeters: Math.round(fence.distance_m * 10) / 10,
            hasPhoto: true,
            hasSignature: true,
          },
        });
        return {
          deliveryId: id,
          outboxIds: [outboxId],
          driverStatuses: [{ driverId: device.driverId, status: 'available' as const }],
        };
      });
    } catch (error) {
      await this.photos.remove(stored.path).catch(() => undefined);
      throw error;
    }
    return this.deliveries.afterCommit(effects);
  }

  async photo(id: string): Promise<{ stream: ReadStream; contentType: string; bytes: number }> {
    const row = await this.db.maybeOne<{
      photo_path: string;
      photo_content_type: string;
      photo_bytes: number;
    }>(
      'SELECT photo_path, photo_content_type, photo_bytes FROM proofs_of_delivery WHERE delivery_id = $1',
      [id],
    );
    if (!row) throw new NotFoundException('This delivery has no proof of delivery');
    return {
      stream: this.photos.open(row.photo_path),
      contentType: row.photo_content_type,
      bytes: row.photo_bytes,
    };
  }

  private async alreadyCompleted(
    id: string,
    device: DevicePrincipal,
    idempotencyKey: string,
  ): Promise<boolean> {
    const row = await this.db.maybeOne<{
      idempotency_key: string | null;
      driver_id: string | null;
    }>(
      `SELECT p.idempotency_key, d.driver_id
         FROM proofs_of_delivery p JOIN deliveries d ON d.id = p.delivery_id
        WHERE p.delivery_id = $1`,
      [id],
    );
    if (!row) return false;
    if (row.driver_id !== device.driverId || row.idempotency_key !== idempotencyKey) {
      throw new ConflictException('This delivery has already been completed');
    }
    return true;
  }
}
