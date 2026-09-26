import type { CandidateDto, DeliveryDetailDto, DeliveryDto, DriverDto } from '@dispatch/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Api,
  createDelivery,
  enrolDriver,
  eventually,
  moveTo,
  resetState,
  startApp,
  type TestApp,
} from '../support/harness.js';

// Pickup used by deliveryInput(): Al Quoz, Dubai (25.1415, 55.2263).
const NEAR = { lat: 25.1425, lng: 55.2275 }; // about 170 m away
const MIDDLE = { lat: 25.155, lng: 55.24 }; // about 2 km away
const FAR = { lat: 25.2, lng: 55.28 }; // about 8.5 km away

describe('driver assignment', () => {
  let t: TestApp;
  let dispatcher: Api;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetState(t.db, t.redis);
    dispatcher = await new Api(t.url).login();
  });

  it('lists free drivers nearest first and assigns the nearest automatically', async () => {
    const far = await enrolDriver(dispatcher, 'Far Driver');
    const near = await enrolDriver(dispatcher, 'Near Driver');
    const middle = await enrolDriver(dispatcher, 'Middle Driver');
    const offShift = await enrolDriver(dispatcher, 'Off Shift', false);
    await moveTo(far, FAR.lat, FAR.lng);
    await moveTo(near, NEAR.lat, NEAR.lng);
    await moveTo(middle, MIDDLE.lat, MIDDLE.lng);
    await moveTo(offShift, NEAR.lat, NEAR.lng);

    const delivery = await createDelivery(dispatcher);
    const candidates = (
      await dispatcher.get<CandidateDto[]>(`/v1/deliveries/${delivery.id}/candidates`)
    ).body;
    expect(candidates.map((c) => c.name)).toEqual(['Near Driver', 'Middle Driver', 'Far Driver']);
    expect(candidates[0]?.distanceMeters).toBeGreaterThan(100);
    expect(candidates[0]?.distanceMeters).toBeLessThan(250);
    expect(candidates[0]?.eta.source).toBe('straight_line');

    const assigned = await dispatcher.post<DeliveryDto>(`/v1/deliveries/${delivery.id}/assign`, {});
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({
      status: 'assigned',
      driver: { id: near.id, name: 'Near Driver' },
      assignmentMode: 'auto',
    });
    const drivers = (await dispatcher.get<DriverDto[]>('/v1/drivers')).body;
    expect(drivers.find((d) => d.id === near.id)).toMatchObject({
      status: 'busy',
      activeDeliveryId: delivery.id,
    });
  });

  it('keeps a delivery pending when nobody is free to take it at creation', async () => {
    const created = await dispatcher.post<DeliveryDto>('/v1/deliveries', {
      orderReference: 'TF-SO-2026-000901',
      recipientName: 'Aisha Rahman',
      address: 'Villa 12, Al Barsha 2, Dubai',
      pickup: { lat: 25.1415, lng: 55.2263 },
      dropoff: { lat: 25.0971, lng: 55.2019 },
      autoAssign: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', driver: null });
  });

  it('never auto-assigns a driver whose last fix is stale', async () => {
    const stale = await enrolDriver(dispatcher, 'Stale Driver');
    const fresh = await enrolDriver(dispatcher, 'Fresh Driver');
    await moveTo(stale, NEAR.lat, NEAR.lng);
    await moveTo(fresh, FAR.lat, FAR.lng);
    await t.db.query(
      `UPDATE drivers SET location_recorded_at = now() - interval '10 minutes' WHERE id = $1`,
      [stale.id],
    );
    const delivery = await createDelivery(dispatcher);
    const candidates = (
      await dispatcher.get<CandidateDto[]>(`/v1/deliveries/${delivery.id}/candidates`)
    ).body;
    expect(candidates[0]).toMatchObject({ name: 'Stale Driver', stale: true });

    const assigned = await dispatcher.post<DeliveryDto>(`/v1/deliveries/${delivery.id}/assign`, {});
    expect(assigned.body.driver?.name).toBe('Fresh Driver');
  });

  it('gives one driver to only one of two deliveries assigned at the same moment', async () => {
    const only = await enrolDriver(dispatcher, 'Only Driver');
    await moveTo(only, NEAR.lat, NEAR.lng);
    const a = await createDelivery(dispatcher);
    const b = await createDelivery(dispatcher);

    const results = await Promise.all([
      dispatcher.post<DeliveryDto & { code?: string }>(`/v1/deliveries/${a.id}/assign`, {}),
      dispatcher.post<DeliveryDto & { code?: string }>(`/v1/deliveries/${b.id}/assign`, {}),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('NO_DRIVER_AVAILABLE');
  });

  it('lets a dispatcher override the choice and re-assign before pickup', async () => {
    const near = await enrolDriver(dispatcher, 'Near Driver');
    const far = await enrolDriver(dispatcher, 'Far Driver');
    await moveTo(near, NEAR.lat, NEAR.lng);
    await moveTo(far, FAR.lat, FAR.lng);
    const delivery = await createDelivery(dispatcher, { autoAssign: true });
    expect(delivery.driver?.id).toBe(near.id);

    const overridden = await dispatcher.post<DeliveryDto>(`/v1/deliveries/${delivery.id}/assign`, {
      driverId: far.id,
    });
    expect(overridden.status).toBe(200);
    expect(overridden.body).toMatchObject({ driver: { id: far.id }, assignmentMode: 'manual' });
    const drivers = (await dispatcher.get<DriverDto[]>('/v1/drivers')).body;
    expect(drivers.find((d) => d.id === near.id)?.status).toBe('available');
    expect(drivers.find((d) => d.id === far.id)?.status).toBe('busy');

    const detail = (await dispatcher.get<DeliveryDetailDto>(`/v1/deliveries/${delivery.id}`)).body;
    expect(detail.events.map((e) => e.type)).toEqual(['created', 'assigned', 'reassigned']);

    // After pickup the delivery stays with its driver.
    await far.api.post(`/v1/driver/deliveries/${delivery.id}/pickup`);
    const late = await dispatcher.post(`/v1/deliveries/${delivery.id}/assign`, {
      driverId: near.id,
    });
    expect(late.status).toBe(409);
  });

  it('refuses a busy or off-shift driver for manual assignment', async () => {
    const busy = await enrolDriver(dispatcher, 'Busy Driver');
    const resting = await enrolDriver(dispatcher, 'Resting Driver', false);
    await moveTo(busy, NEAR.lat, NEAR.lng);
    await createDelivery(dispatcher, { autoAssign: true });
    const second = await createDelivery(dispatcher);

    const toBusy = await dispatcher.post<{ code?: string }>(`/v1/deliveries/${second.id}/assign`, {
      driverId: busy.id,
    });
    expect(toBusy.status).toBe(409);
    expect(toBusy.body.code).toBe('DRIVER_BUSY');
    const toResting = await dispatcher.post<{ message: string }>(
      `/v1/deliveries/${second.id}/assign`,
      {
        driverId: resting.id,
      },
    );
    expect(toResting.status).toBe(409);
    expect(toResting.body.message).toBe('Resting Driver is off shift');
  });

  it('frees the driver when a delivery is cancelled, and keeps one open delivery per order', async () => {
    const driver = await enrolDriver(dispatcher, 'Omar');
    await moveTo(driver, NEAR.lat, NEAR.lng);
    const delivery = await createDelivery(dispatcher, {
      orderReference: 'TF-SO-2026-000777',
      autoAssign: true,
    });

    const duplicate = await dispatcher.post('/v1/deliveries', {
      ...{ orderReference: 'TF-SO-2026-000777' },
      recipientName: 'Aisha',
      address: 'Villa 12, Al Barsha',
      pickup: { lat: 25.14, lng: 55.22 },
      dropoff: { lat: 25.09, lng: 55.2 },
    });
    expect(duplicate.status).toBe(409);

    const cancelled = await dispatcher.post<DeliveryDto>(`/v1/deliveries/${delivery.id}/cancel`, {
      reason: 'Customer asked to deliver next week',
    });
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      failureReason: 'Customer asked to deliver next week',
    });
    const drivers = (await dispatcher.get<DriverDto[]>('/v1/drivers')).body;
    expect(drivers[0]?.status).toBe('available');

    // A cancelled attempt does not block a new delivery for the same order.
    const retry = await createDelivery(dispatcher, { orderReference: 'TF-SO-2026-000777' });
    expect(retry.status).toBe('pending');
    const again = await dispatcher.post(`/v1/deliveries/${delivery.id}/cancel`, {
      reason: 'twice',
    });
    expect(again.status).toBe(409);
  });

  it('keeps drivers to their own deliveries and blocks going off shift mid-delivery', async () => {
    const mine = await enrolDriver(dispatcher, 'Assigned Driver');
    const other = await enrolDriver(dispatcher, 'Other Driver');
    await moveTo(mine, NEAR.lat, NEAR.lng);
    const delivery = await createDelivery(dispatcher, { autoAssign: true });

    const stolen = await other.api.post(`/v1/driver/deliveries/${delivery.id}/pickup`);
    expect(stolen.status).toBe(403);
    const offShift = await mine.api.post('/v1/driver/shift', { onShift: false });
    expect(offShift.status).toBe(409);

    const failed = await mine.api.post<DeliveryDto>(`/v1/driver/deliveries/${delivery.id}/fail`, {
      reason: 'Nobody at the address',
    });
    expect(failed.body.status).toBe('failed');
    expect((await mine.api.post('/v1/driver/shift', { onShift: false })).status).toBe(200);
  });

  it('refuses to end a shift when an assignment commits while the request waits for the driver', async () => {
    const driver = await enrolDriver(dispatcher, 'Racing Driver');
    await moveTo(driver, NEAR.lat, NEAR.lng);
    const delivery = await createDelivery(dispatcher);

    // An assignment in progress holds the driver's row lock, as DeliveriesService.assign does.
    const assignment = await t.db.pool.connect();
    try {
      await assignment.query('BEGIN');
      await assignment.query('SELECT id FROM drivers WHERE id = $1 FOR UPDATE', [driver.id]);
      await assignment.query(
        `UPDATE deliveries SET status = 'assigned', driver_id = $2, assignment_mode = 'manual',
                assigned_at = now(), updated_at = now() WHERE id = $1`,
        [delivery.id, driver.id],
      );
      await assignment.query(`UPDATE drivers SET status = 'busy' WHERE id = $1`, [driver.id]);

      // Meanwhile the driver ends the shift; the request waits for the lock.
      const ending = driver.api.post<{ message: string }>('/v1/driver/shift', { onShift: false });
      await eventually(async () => {
        const waiting = await t.db.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return waiting.n > 0;
      });
      await assignment.query('COMMIT');

      const answer = await ending;
      expect(answer.status).toBe(409);
      expect(answer.body.message).toMatch(/current delivery/);
    } finally {
      assignment.release();
    }
    const drivers = (await dispatcher.get<DriverDto[]>('/v1/drivers')).body;
    expect(drivers.find((d) => d.id === driver.id)).toMatchObject({
      status: 'busy',
      activeDeliveryId: delivery.id,
    });
  });
});
