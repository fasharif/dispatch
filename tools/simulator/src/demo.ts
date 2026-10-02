import {
  haversineMeters,
  type CreateDeliveryInput,
  type DeliveryDto,
  type LatLng,
} from '@dispatch/shared';
import { ApiClient } from './api-client.js';
import { demoParcelPhoto } from './demo-photo.js';
import type { SimulatedDriver } from './driver-sim.js';
import { simulatedDrivers } from './drive.js';
import type { Fleet } from './fleet.js';
import { ROUTES, RouteWalker, TargetWalker } from './routes.js';
import { ApiError } from './api-client.js';

/** A drawn parcel stands in for the photo a phone would take. */
const PHOTO = demoParcelPhoto();

/** Demo depot in Al Quoz Industrial 1; drop-offs are in the neighbourhoods around it. */
const DEPOT: LatLng = { lat: 25.1415, lng: 55.2263 };
const RECIPIENTS = [
  'Aisha Rahman',
  'Omar Khalil',
  'Fatima Noor',
  'Yousef Haddad',
  'Mariam Saleh',
  'Khalid Aziz',
];

/**
 * Neighbourhoods 1.5-6 km from the depot, at their OpenStreetMap place nodes (© OpenStreetMap
 * contributors, ODbL), so an order's address names the area its drop-off pin is in.
 */
const AREAS: readonly { name: string; centre: LatLng }[] = [
  { name: 'Al Safa 2', centre: { lat: 25.1598, lng: 55.2264 } },
  { name: 'Umm Suqeim 2', centre: { lat: 25.1501, lng: 55.2057 } },
  { name: 'Al Quoz Industrial 3', centre: { lat: 25.1251, lng: 55.2184 } },
  { name: 'Al Quoz 3', centre: { lat: 25.1588, lng: 55.2428 } },
  { name: 'Umm Suqeim 3', centre: { lat: 25.1375, lng: 55.1958 } },
  { name: 'Al Safa 1', centre: { lat: 25.1775, lng: 55.2389 } },
  { name: 'Jumeirah 3', centre: { lat: 25.1807, lng: 55.2282 } },
  { name: 'Al Barsha 2', centre: { lat: 25.1024, lng: 55.2161 } },
  { name: 'Al Barsha 1', centre: { lat: 25.1091, lng: 55.1955 } },
  { name: 'Business Bay', centre: { lat: 25.1795, lng: 55.2684 } },
  { name: 'Al Quoz 4', centre: { lat: 25.1509, lng: 55.2541 } },
];

/**
 * Creates an order, or finds it when the answer was lost (a timeout or a dropped connection): the
 * API may have created it anyway, and at most one open delivery exists per order reference, so a
 * lookup tells which. Only a definite refusal, or an order that is not there, is a failure.
 */
export async function createOrFind(
  dispatcher: ApiClient,
  input: CreateDeliveryInput,
  timeoutMs?: number,
): Promise<DeliveryDto> {
  try {
    return await dispatcher.createDelivery(input, timeoutMs);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const found = await dispatcher
      .listDeliveries()
      .then((list) => list.find((d) => d.orderReference === input.orderReference))
      .catch(() => undefined);
    if (found) return found;
    throw error;
  }
}

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

/** A random point between `min` and `max` metres from `centre`. */
export function randomPointNear(centre: LatLng, min: number, max: number): LatLng {
  const distance = min + Math.random() * (max - min);
  const bearing = Math.random() * 2 * Math.PI;
  const dLat = (distance * Math.cos(bearing)) / 111_320;
  const dLng = (distance * Math.sin(bearing)) / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  return {
    lat: Number((centre.lat + dLat).toFixed(6)),
    lng: Number((centre.lng + dLng).toFixed(6)),
  };
}

/** A drop-off within 500 m of an area's centre. */
const randomDropoff = (centre: LatLng): LatLng => randomPointNear(centre, 0, 500);

/**
 * Where the driver stops to hand the parcel over: 20-80 m from the drop-off pin, as a real
 * driver parks near the door rather than on the geocoded point. Inside the 150 m geofence.
 */
const doorstep = (dropoff: LatLng): LatLng => randomPointNear(dropoff, 20, 80);

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
      const area = AREAS[orderNumber % AREAS.length] ?? AREAS[0];
      try {
        const delivery = await createOrFind(options.dispatcher, {
          orderReference: `DEMO-${String(orderNumber).padStart(6, '0')}`,
          recipientName: RECIPIENTS[orderNumber % RECIPIENTS.length] ?? 'Customer',
          recipientPhone: '+971 50 000 0000',
          address: `Villa ${String(1 + (orderNumber % 40))}, ${area?.name ?? 'Al Quoz'}, Dubai`,
          pickup: DEPOT,
          dropoff: randomDropoff(area?.centre ?? DEPOT),
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
          : doorstep(home.activeDelivery.dropoff);
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
      state.towards = new TargetWalker(
        state.sim.position,
        doorstep(delivery.dropoff),
        DELIVERY_SPEED_MPS,
      );
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
      `${delivery.orderReference}: delivered ${String(Math.round(haversineMeters(position, delivery.dropoff)))} m from the drop-off pin`,
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
