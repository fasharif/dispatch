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
  /** The name of driver i (0-based). */
  name: (index: number) => string;
  concurrency?: number;
  /**
   * A fleet file from an earlier run against the same API. A driver whose phone token still works
   * keeps it, so a second demo run enrols nobody (enrolment is rate limited, and every new phone
   * revokes the previous one).
   */
  reuse?: Fleet | null;
}

/** "Load Driver 0001", "Load Driver 0002", … */
export const numberedNames =
  (prefix: string) =>
  (index: number): string =>
    `${prefix} ${String(index + 1).padStart(4, '0')}`;

/** Fictional drivers for the demo; the tracking page shows the first name. */
const DEMO_NAMES = [
  'Omar Haddad',
  'Rahul Menon',
  'Imran Qureshi',
  'Joseph Mathew',
  'Ahmed Saeed',
  'Bilal Anwar',
  'Suresh Kumar',
  'Tariq Mahmood',
  'Vikram Nair',
  'Hassan Ali',
  'Arjun Pillai',
  'Faisal Karim',
] as const;

export function demoDriverName(index: number): string {
  const name = DEMO_NAMES[index % DEMO_NAMES.length] ?? 'Demo Driver';
  const round = Math.floor(index / DEMO_NAMES.length);
  return round === 0 ? name : `${name} ${String(round + 1)}`;
}

/**
 * Creates drivers the way a dispatcher would (console → new driver → enrolment code) and enrols
 * one simulated phone for each, then puts every driver on shift.
 *
 * Running it again is safe: a driver that already exists under the same name is reused instead of
 * being created twice. With `reuse`, a driver whose phone token still works keeps that phone;
 * otherwise the driver gets a new enrolment code and a new simulated phone, which revokes the old
 * one. After a network error on "create", the driver list is read again before trying once more,
 * because the first request may have reached the API.
 */
export async function seedFleet(options: SeedOptions): Promise<Fleet> {
  const anonymous = new ApiClient(options.api);
  const { accessToken } = await anonymous.login(options.email, options.password);
  const dispatcher = anonymous.withToken(accessToken);
  const known = new Map<string, string>();
  const refresh = async () => {
    for (const driver of await dispatcher.listDrivers()) known.set(driver.name, driver.id);
  };
  await refresh();

  const enrolmentCode = async (name: string, vehicle: string): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      const existing = known.get(name);
      try {
        if (existing) return (await dispatcher.newEnrolmentCode(existing)).code;
        const created = await dispatcher.createDriver(name, vehicle);
        known.set(name, created.driver.id);
        return created.enrolment.code;
      } catch (error) {
        if (error instanceof ApiError || attempt >= 3) throw error;
        await sleep(1000 * attempt);
        await refresh();
      }
    }
  };

  const previous = new Map(
    options.reuse?.api === options.api
      ? options.reuse.drivers.map((driver) => [driver.name, driver] as const)
      : [],
  );
  /** The earlier phone, if its token still works: it goes on shift with it. */
  const reusePhone = async (name: string): Promise<FleetDriver | null> => {
    const earlier = previous.get(name);
    if (!earlier) return null;
    try {
      const driver = await retry(() => anonymous.withToken(earlier.token).setShift(true));
      return driver.id === earlier.driverId ? earlier : null;
    } catch (error) {
      // 401: revoked, or the stack was created again. Enrol a new phone instead.
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  };

  const drivers: FleetDriver[] = [];
  const indexes = Array.from({ length: options.drivers }, (_, i) => i);
  const concurrency = options.concurrency ?? 8;
  for (let start = 0; start < indexes.length; start += concurrency) {
    const chunk = indexes.slice(start, start + concurrency);
    drivers.push(
      ...(await Promise.all(
        chunk.map(async (i) => {
          const name = options.name(i);
          const kept = await reusePhone(name);
          if (kept) return kept;
          // A code works once. If the answer to "enrol" is lost, the next attempt needs a new code.
          const device = await retry(async () =>
            anonymous.enrol(
              await enrolmentCode(name, `Van ${String(i + 1)}`),
              `${name} (simulated)`,
            ),
          );
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

/** Retries a call that is safe to repeat after a network error or a 5xx answer. */
async function retry<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const transient = !(error instanceof ApiError) || error.status >= 500;
      if (!transient || attempt >= attempts) throw error;
      await sleep(500 * attempt);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
