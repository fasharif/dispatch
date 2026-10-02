import pg from 'pg';
import type { Fleet } from './fleet.js';
import type { ListenReport } from './listen.js';

export interface VerifyResult {
  devices: number;
  storedFixes: number;
  receivedFixes: number;
  lost: number;
  lostSample: string[];
  /** Received but not stored: should always be zero. */
  unexpected: number;
}

/**
 * Compares what the database stored for the fleet's devices with what the listener received.
 * The database is the ground truth: every fix acknowledged to a device is in it. A fix that is
 * stored but never reached the listener is lost.
 */
export async function verify(
  databaseUrl: string,
  fleet: Fleet,
  report: ListenReport,
): Promise<VerifyResult> {
  const devices = fleet.drivers.map((d) => d.deviceId);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ key: string }>(
      `SELECT device_id::text || ':' || seq::text AS key
         FROM location_updates WHERE device_id = ANY($1::uuid[])`,
      [devices],
    );
    const stored = new Set(rows.map((row) => row.key));
    // Keys are "<deviceId>:<seq>". A set lookup per key: 1,000 devices and 200,000 keys would
    // otherwise mean 200 million prefix comparisons.
    const fleetDevices = new Set(devices);
    const received = new Set(
      report.receivedKeys.filter((key) => fleetDevices.has(key.slice(0, key.lastIndexOf(':')))),
    );
    const lost = [...stored].filter((key) => !received.has(key));
    return {
      devices: devices.length,
      storedFixes: stored.size,
      receivedFixes: received.size,
      lost: lost.length,
      lostSample: lost.slice(0, 20),
      unexpected: [...received].filter((key) => !stored.has(key)).length,
    };
  } finally {
    await pool.end();
  }
}
