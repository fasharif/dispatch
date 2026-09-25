import { haversineMeters, type DeliveryDto, type LatLng } from '@dispatch/shared';
import { ApiClient } from './api-client.js';
import type { SimulatedDriver } from './driver-sim.js';
import { simulatedDrivers } from './drive.js';
import type { Fleet } from './fleet.js';
import { ROUTES, RouteWalker, TargetWalker } from './routes.js';
import { ApiError } from './api-client.js';

/** A 1×1 PNG stands in for the parcel photo a phone would take. */
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Demo depot in Al Quoz industrial area; drop-offs are spread around the simulated routes. */
const DEPOT: LatLng = { lat: 25.1415, lng: 55.2263 };
const RECIPIENTS = [
  'Aisha Rahman',
  'Omar Khalil',
  'Fatima Noor',
  'Yousef Haddad',
  'Mariam Saleh',
  'Khalid Aziz',
];
const AREAS = [
  'Al Barsha 2',
  'Jumeirah 3',
  'Business Bay',
  'Al Garhoud',
  'Umm Suqeim 1',
  'Dubai Marina',
];

export interface DemoOptions {
  dispatcher: ApiClient;
  intervalSeconds: number;
  durationSeconds: number;
  newDeliveryEverySeconds: number;
  log?: (line: string) => void;
}

interface DriverState {
  sim: SimulatedDriver;
  client: ApiClient;
  delivery: DeliveryDto | null;
  towards: TargetWalker | null;
  /** After a drop-off the driver heads back to the start of their route. */
  returning: TargetWalker | null;
  route: string;
}

/** About 50 km/h in town. */
const DELIVERY_SPEED_MPS = 14;

/** A random point 1.5–6 km from the depot, so a delivery takes minutes rather than an hour. */
function randomDropoff(): LatLng {
  const distance = 1_500 + Math.random() * 4_500;
  const bearing = Math.random() * 2 * Math.PI;
  const dLat = (distance * Math.cos(bearing)) / 111_320;
  const dLng = (distance * Math.sin(bearing)) / (111_320 * Math.cos((DEPOT.lat * Math.PI) / 180));
  return { lat: Number((DEPOT.lat + dLat).toFixed(6)), lng: Number((DEPOT.lng + dLng).toFixed(6)) };
}

/**
 * Runs deliveries end to end so the console has something to show: new orders appear, the
 * nearest driver is assigned, drives to the depot, picks up, drives to the customer and
 * completes with a photo and signature inside the geofence.
 */
export async function demo(fleet: Fleet, options: DemoOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const sims = simulatedDrivers(fleet);
  const states: DriverState[] = fleet.drivers.map((driver, index) => ({
    sim: sims[index] as SimulatedDriver,
    client: new ApiClient(fleet.api).withToken(driver.token),
    delivery: null,
    towards: null,
    returning: null,
    route: driver.route,
  }));
  const deadline = Date.now() + options.durationSeconds * 1000;
  let lastOrder = 0;
  let orderNumber = Math.floor(Math.random() * 900_000);
  /** Orders that found no free driver; one is offered again each tick. */
  const waiting: string[] = [];

  while (Date.now() < deadline) {
    const started = Date.now();
    if (started - lastOrder >= options.newDeliveryEverySeconds * 1000) {
      lastOrder = started;
      orderNumber += 1;
      const area = AREAS[orderNumber % AREAS.length] ?? 'Dubai';
      try {
        const delivery = await options.dispatcher.createDelivery({
          orderReference: `DEMO-${String(orderNumber).padStart(6, '0')}`,
          recipientName: RECIPIENTS[orderNumber % RECIPIENTS.length] ?? 'Customer',
          recipientPhone: '+971 50 000 0000',
          address: `Villa ${String(1 + (orderNumber % 40))}, ${area}, Dubai`,
          pickup: DEPOT,
          dropoff: randomDropoff(),
          autoAssign: true,
        });
        log(
          `order ${delivery.orderReference} → ${delivery.driver?.name ?? 'waiting for a driver'}`,
        );
        if (!delivery.driver) waiting.push(delivery.id);
      } catch (error) {
        log(`new order failed: ${(error as Error).message}`);
      }
    }
    const next = waiting[0];
    if (next) {
      try {
        const assigned = await options.dispatcher.request<DeliveryDto>(
          'POST',
          `/v1/deliveries/${next}/assign`,
          {},
        );
        waiting.shift();
        log(`order ${assigned.orderReference} → ${assigned.driver?.name ?? '?'}`);
      } catch (error) {
        // 409: still nobody free. Anything else: stop offering this order.
        if (!(error instanceof ApiError) || error.status !== 409) waiting.shift();
      }
    }

    await Promise.all(states.map((state) => step(state, options.intervalSeconds, log)));
    const wait = options.intervalSeconds * 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function step(
  state: DriverState,
  seconds: number,
  log: (line: string) => void,
): Promise<void> {
  if (state.returning?.arrived) {
    state.returning = null;
    state.sim.moveWith(new RouteWalker(ROUTES[state.route] ?? [], 10, 0));
  }
  if (!state.delivery) {
    const home = await state.client.me().catch(() => null);
    if (home?.activeDelivery) {
      state.delivery = home.activeDelivery;
      state.returning = null;
      const target =
        home.activeDelivery.status === 'assigned'
          ? home.activeDelivery.pickup
          : home.activeDelivery.dropoff;
      state.towards = new TargetWalker(state.sim.position, target, DELIVERY_SPEED_MPS);
      state.sim.moveWith(state.towards);
    }
  }

  state.sim.record(seconds);
  await state.sim.flush();

  const delivery = state.delivery;
  const towards = state.towards;
  if (!delivery || !towards?.arrived) return;
  try {
    if (delivery.status === 'assigned') {
      state.delivery = await state.client.pickUp(delivery.id);
      state.towards = new TargetWalker(state.sim.position, delivery.dropoff, DELIVERY_SPEED_MPS);
      state.sim.moveWith(state.towards);
      log(`${delivery.orderReference}: picked up`);
      return;
    }
    const position = state.sim.position;
    await state.client.complete(
      delivery.id,
      {
        recipientName: delivery.recipientName,
        position: { lat: position.lat, lng: position.lng },
        accuracyM: 6,
        capturedAt: new Date().toISOString(),
        signature: {
          width: 300,
          height: 120,
          strokes: [[12, 80, 60, 30, 110, 90, 170, 25, 240, 70]],
        },
      },
      PHOTO,
    );
    log(
      `${delivery.orderReference}: delivered ${String(Math.round(haversineMeters(position, delivery.dropoff)))} m from the door`,
    );
    state.delivery = null;
    state.towards = null;
    const start = ROUTES[state.route]?.[0] ?? DEPOT;
    state.returning = new TargetWalker(state.sim.position, start, 10);
    state.sim.moveWith(state.returning);
  } catch (error) {
    log(`${delivery.orderReference}: ${(error as Error).message}`);
  }
}
