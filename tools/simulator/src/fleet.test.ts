import { haversineMeters } from '@dispatch/shared';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomPointNear } from './demo.js';
import { demoDriverName, numberedNames, seedFleet } from './fleet.js';

/**
 * The few dispatch API routes seeding uses, in memory. `dropNextCreate` makes the server store
 * the next driver and then drop the connection, as when a response is lost on the way back.
 */
class FakeApi {
  readonly drivers = new Map<string, { id: string; name: string }>();
  readonly calls: string[] = [];
  dropNextCreate = false;
  private readonly codes = new Map<string, string>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private issueCode(driverId: string): { driverId: string; code: string; expiresAt: string } {
    const code = randomUUID().slice(0, 8).toUpperCase();
    this.codes.set(code, driverId);
    return { driverId, code, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown) : null;
    const route = `${request.method ?? ''} ${request.url ?? ''}`;
    this.calls.push(route.replace(/[0-9a-f-]{36}/g, ':id'));
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const driverDto = (driver: { id: string; name: string }) => ({
      ...driver,
      phone: null,
      vehicle: null,
      status: 'available',
      position: null,
      activeDeliveryId: null,
      deactivatedAt: null,
    });

    if (route === 'POST /v1/auth/login') {
      send(200, { accessToken: 'dispatcher-token' });
    } else if (route === 'GET /v1/drivers') {
      send(200, [...this.drivers.values()].map(driverDto));
    } else if (route === 'POST /v1/drivers') {
      const driver = { id: randomUUID(), name: (body as { name: string }).name };
      this.drivers.set(driver.id, driver);
      if (this.dropNextCreate) {
        this.dropNextCreate = false;
        request.socket.destroy();
        return;
      }
      send(201, { driver: driverDto(driver), enrolment: this.issueCode(driver.id) });
    } else if (/^POST \/v1\/drivers\/[0-9a-f-]{36}\/enrolment-codes$/.test(route)) {
      send(201, this.issueCode(route.split('/')[3] ?? ''));
    } else if (route === 'POST /v1/devices/enrol') {
      const driverId = this.codes.get((body as { code: string }).code);
      const driver = driverId ? this.drivers.get(driverId) : undefined;
      if (!driver) {
        send(401, { message: 'invalid code' });
        return;
      }
      send(201, {
        deviceId: randomUUID(),
        deviceToken: `dvc_${randomUUID()}`,
        driver: driverDto(driver),
      });
    } else if (route === 'POST /v1/driver/shift') {
      send(200, {});
    } else {
      send(404, { message: route });
    }
  }
}

describe('seedFleet', () => {
  let api: FakeApi;
  const options = () => ({
    api: api.url,
    email: 'dispatcher@dispatch.local',
    password: 'dispatch-demo-2026',
    drivers: 3,
    name: demoDriverName,
  });

  beforeEach(async () => {
    api = new FakeApi();
    await api.start();
  });
  afterEach(async () => {
    await api.stop();
  });

  it('reuses drivers that already exist under the same name when run again', async () => {
    const first = await seedFleet(options());
    const second = await seedFleet(options());
    expect(api.drivers.size).toBe(3);
    expect(second.drivers.map((d) => d.driverId)).toEqual(first.drivers.map((d) => d.driverId));
    expect(second.drivers.map((d) => d.deviceId)).not.toEqual(first.drivers.map((d) => d.deviceId));
    expect(api.calls.filter((c) => c === 'POST /v1/drivers/:id/enrolment-codes')).toHaveLength(3);
  });

  it('looks before creating again when the answer to "create" is lost', async () => {
    api.dropNextCreate = true;
    const fleet = await seedFleet({ ...options(), drivers: 1 });
    expect(api.drivers.size).toBe(1);
    expect(fleet.drivers[0]?.name).toBe('Omar Haddad');
    // The retry found the driver the lost request had created and asked for a new code.
    expect(api.calls.filter((c) => c === 'POST /v1/drivers')).toHaveLength(1);
    expect(api.calls).toContain('POST /v1/drivers/:id/enrolment-codes');
  });
});

describe('driver names', () => {
  it('gives demo drivers distinct, realistic names', () => {
    const names = Array.from({ length: 30 }, (_, i) => demoDriverName(i));
    expect(new Set(names).size).toBe(30);
    expect(names[0]).toBe('Omar Haddad');
    expect(names[12]).toBe('Omar Haddad 2');
    expect(numberedNames('Load Driver')(0)).toBe('Load Driver 0001');
  });
});

describe('randomPointNear', () => {
  it('stays within the requested ring', () => {
    const centre = { lat: 25.1501, lng: 55.2057 };
    for (let i = 0; i < 200; i += 1) {
      const distance = haversineMeters(centre, randomPointNear(centre, 20, 80));
      expect(distance).toBeGreaterThanOrEqual(19.5);
      expect(distance).toBeLessThanOrEqual(80.5);
    }
  });
});
