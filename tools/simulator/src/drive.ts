import { ApiClient } from './api-client.js';
import { SimulatedDriver } from './driver-sim.js';
import type { Fleet } from './fleet.js';
import { ROUTES, RouteWalker } from './routes.js';

export interface DriveOptions {
  intervalSeconds: number;
  durationSeconds: number;
  /** Chance per driver and tick of entering a dead zone. */
  offlineRate: number;
  offlineSeconds: number;
  log?: (line: string) => void;
}

export interface DriveSummary {
  drivers: number;
  recorded: number;
  accepted: number;
  duplicates: number;
  failedSends: number;
  stillQueued: number;
}

export function simulatedDrivers(fleet: Fleet): SimulatedDriver[] {
  return fleet.drivers.map((driver, index) => {
    const client = new ApiClient(fleet.api).withToken(driver.token);
    const route = ROUTES[driver.route] ?? ROUTES.sheikhZayed ?? [];
    // 8–17 m/s (about 30–60 km/h), varied so drivers spread out along shared routes.
    const speed = 8 + (index % 10);
    return new SimulatedDriver(
      driver.name,
      { send: (batch) => client.sendFixes(batch) },
      new RouteWalker(route, speed, driver.startFraction),
    );
  });
}

/**
 * Moves every driver along its route and sends a fix every interval. Some drivers drop into
 * dead zones and replay their queue when they come back, which exercises idempotent replay.
 */
export async function drive(fleet: Fleet, options: DriveOptions): Promise<DriveSummary> {
  const drivers = simulatedDrivers(fleet);
  const log = options.log ?? (() => undefined);
  const deadline = Date.now() + options.durationSeconds * 1000;
  let recorded = 0;
  let failedSends = 0;
  let tick = 0;

  while (Date.now() < deadline) {
    const started = Date.now();
    await Promise.all(
      drivers.map(async (driver) => {
        driver.record(options.intervalSeconds);
        recorded += 1;
        if (!driver.isOffline() && Math.random() < options.offlineRate) {
          driver.goOffline(Date.now() + options.offlineSeconds * 1000);
        }
        const result = await driver.flush();
        if (result.failed) failedSends += 1;
      }),
    );
    tick += 1;
    if (tick % 10 === 0) {
      const queued = drivers.reduce((sum, d) => sum + d.queued, 0);
      const offline = drivers.filter((d) => d.isOffline()).length;
      log(
        `tick ${String(tick)}: ${String(recorded)} fixes recorded, ${String(offline)} offline, ${String(queued)} queued`,
      );
    }
    const wait = options.intervalSeconds * 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  // Come back online and drain every queue, as phones do when they regain signal.
  for (let attempt = 0; attempt < 5 && drivers.some((d) => d.queued > 0); attempt += 1) {
    await Promise.all(
      drivers.map(async (driver) => {
        driver.goOffline(0);
        const result = await driver.flush();
        if (result.failed) failedSends += 1;
      }),
    );
  }
  return {
    drivers: drivers.length,
    recorded,
    accepted: drivers.reduce((sum, d) => sum + d.accepted, 0),
    duplicates: drivers.reduce((sum, d) => sum + d.duplicates, 0),
    failedSends,
    stillQueued: drivers.reduce((sum, d) => sum + d.queued, 0),
  };
}
