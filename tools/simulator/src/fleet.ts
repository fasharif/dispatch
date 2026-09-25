import { readFile, writeFile } from 'node:fs/promises';
import { ApiClient, ApiError } from './api-client.js';
import { ROUTE_NAMES } from './routes.js';

export interface FleetDriver {
  driverId: string;
  deviceId: string;
  name: string;
  /** Device bearer token. The fleet file is a local test artefact; keep it out of version control. */
  token: string;
  route: string;
  startFraction: number;
}

export interface Fleet {
  api: string;
  createdAt: string;
  drivers: FleetDriver[];
}

export interface SeedOptions {
  api: string;
  email: string;
  password: string;
  drivers: number;
  prefix: string;
  concurrency?: number;
}

/**
 * Creates drivers the way a dispatcher would (console → new driver → enrolment code) and enrols
 * one simulated phone for each, then puts every driver on shift.
 */
export async function seedFleet(options: SeedOptions): Promise<Fleet> {
  const anonymous = new ApiClient(options.api);
  const { accessToken } = await anonymous.login(options.email, options.password);
  const dispatcher = anonymous.withToken(accessToken);
  const drivers: FleetDriver[] = [];
  const indexes = Array.from({ length: options.drivers }, (_, i) => i);
  const concurrency = options.concurrency ?? 8;

  for (let start = 0; start < indexes.length; start += concurrency) {
    const chunk = indexes.slice(start, start + concurrency);
    drivers.push(
      ...(await Promise.all(
        chunk.map(async (i) => {
          const name = `${options.prefix} ${String(i + 1).padStart(4, '0')}`;
          const { enrolment } = await dispatcher.createDriver(name, `Van ${String(i + 1)}`);
          const device = await anonymous.enrol(enrolment.code, `${name} (simulated)`);
          await retry(() => anonymous.withToken(device.deviceToken).setShift(true));
          return {
            driverId: device.driver.id,
            deviceId: device.deviceId,
            name,
            token: device.deviceToken,
            route: ROUTE_NAMES[i % ROUTE_NAMES.length] ?? 'sheikhZayed',
            startFraction: (i * 0.618_034) % 1,
          };
        }),
      )),
    );
  }
  return { api: options.api, createdAt: new Date().toISOString(), drivers };
}

export async function writeFleet(path: string, fleet: Fleet): Promise<void> {
  await writeFile(path, `${JSON.stringify(fleet, null, 2)}\n`, { mode: 0o600 });
}

export async function readFleet(path: string): Promise<Fleet> {
  return JSON.parse(await readFile(path, 'utf8')) as Fleet;
}

/** Retries an idempotent call after a network error or a 5xx answer. */
async function retry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const transient = !(error instanceof ApiError) || error.status >= 500;
      if (!transient || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}
