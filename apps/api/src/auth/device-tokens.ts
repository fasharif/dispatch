import { Injectable } from '@nestjs/common';
import type { DevicePrincipal } from '../common/request-context.js';
import { Database } from '../db/database.js';
import { sha256Hex } from './tokens.js';

/** Looks up enrolled devices by the SHA-256 of their bearer token. */
@Injectable()
export class DeviceTokens {
  constructor(private readonly db: Database) {}

  async resolve(token: string): Promise<DevicePrincipal | null> {
    const row = await this.db.maybeOne<{
      device_id: string;
      driver_id: string;
      driver_name: string;
      stale: boolean;
    }>(
      `SELECT dv.id AS device_id, dv.driver_id, d.name AS driver_name,
              (dv.last_seen_at IS NULL OR dv.last_seen_at < now() - interval '1 minute') AS stale
         FROM devices dv JOIN drivers d ON d.id = dv.driver_id
        WHERE dv.token_hash = $1 AND dv.revoked_at IS NULL`,
      [sha256Hex(token)],
    );
    if (!row) return null;
    if (row.stale) {
      // At most one write a minute per device; failure only delays the "last seen" time.
      void this.db
        .query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [row.device_id])
        .catch(() => undefined);
    }
    return {
      kind: 'device',
      deviceId: row.device_id,
      driverId: row.driver_id,
      driverName: row.driver_name,
    };
  }
}
