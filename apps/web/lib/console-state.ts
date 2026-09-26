import {
  DEFAULT_DRIVER_STALE_AFTER_S,
  type DeliveryDto,
  type DriverDto,
  type DriverLocationEvent,
  type DriverPosition,
  type DriverStatusEvent,
} from '@dispatch/shared';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface ConsoleState {
  drivers: Record<string, DriverDto>;
  deliveries: Record<string, DeliveryDto>;
  connection: ConnectionState;
  /** Fixes recovered by the last resume after a reconnect. */
  lastResume: { events: number; gap: boolean } | null;
  /** Fixes applied since the page loaded (live and resumed). */
  fixes: number;
  /** Set while drivers and deliveries cannot be loaded; the console keeps retrying. */
  loadError: string | null;
}

export type ConsoleAction =
  | { type: 'snapshot/loaded'; drivers: DriverDto[]; deliveries: DeliveryDto[] }
  | { type: 'snapshot/failed'; message: string }
  | { type: 'driver/upserted'; driver: DriverDto }
  | { type: 'driver/locations'; events: DriverLocationEvent[] }
  | { type: 'driver/status'; event: DriverStatusEvent }
  | { type: 'delivery/updated'; delivery: DeliveryDto }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'resumed'; events: number; gap: boolean };

export const initialConsoleState: ConsoleState = {
  drivers: {},
  deliveries: {},
  connection: 'connecting',
  lastResume: null,
  fixes: 0,
  loadError: null,
};

/** The newer of two positions (by when the phone recorded them). */
function newerPosition(a: DriverPosition | null, b: DriverPosition | null): DriverPosition | null {
  if (!a) return b;
  if (!b) return a;
  return b.recordedAt > a.recordedAt ? b : a;
}

/** Applies fixes to drivers; a fix older than the position already shown is ignored. */
function applyLocations(
  drivers: Record<string, DriverDto>,
  events: readonly DriverLocationEvent[],
): Record<string, DriverDto> {
  const next = { ...drivers };
  for (const event of events) {
    const driver = next[event.driverId];
    if (!driver) continue;
    if (driver.position && driver.position.recordedAt >= event.recordedAt) continue;
    next[event.driverId] = {
      ...driver,
      position: {
        lat: event.lat,
        lng: event.lng,
        accuracyM: event.accuracyM,
        recordedAt: event.recordedAt,
      },
    };
  }
  return next;
}

/**
 * Applies a delivery unless the console already shows a newer version of it. Updates reach the
 * console over two paths (live events and HTTP reloads), so an older copy can arrive last.
 */
function applyDelivery(state: ConsoleState, delivery: DeliveryDto): ConsoleState {
  const current = state.deliveries[delivery.id];
  if (current && current.updatedAt > delivery.updatedAt) return state;
  const drivers = { ...state.drivers };
  // Keep each driver's active delivery in step with the delivery itself.
  for (const driver of Object.values(drivers)) {
    const carries = driver.activeDeliveryId === delivery.id;
    const shouldCarry =
      delivery.driver?.id === driver.id &&
      (delivery.status === 'assigned' || delivery.status === 'picked_up');
    if (carries && !shouldCarry) drivers[driver.id] = { ...driver, activeDeliveryId: null };
    if (!carries && shouldCarry) drivers[driver.id] = { ...driver, activeDeliveryId: delivery.id };
  }
  return { ...state, drivers, deliveries: { ...state.deliveries, [delivery.id]: delivery } };
}

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'snapshot/loaded': {
      // The server's view replaces the console's, except for positions the live feed has
      // already moved further, and deliveries it already shows in a newer version.
      const drivers: Record<string, DriverDto> = { ...state.drivers };
      for (const driver of action.drivers) {
        drivers[driver.id] = {
          ...driver,
          position: newerPosition(state.drivers[driver.id]?.position ?? null, driver.position),
        };
      }
      const deliveries = { ...state.deliveries };
      for (const delivery of action.deliveries) {
        const current = deliveries[delivery.id];
        if (!current || current.updatedAt <= delivery.updatedAt) deliveries[delivery.id] = delivery;
      }
      return { ...state, drivers, deliveries, loadError: null };
    }
    case 'snapshot/failed':
      return { ...state, loadError: action.message };
    case 'driver/upserted':
      return { ...state, drivers: { ...state.drivers, [action.driver.id]: action.driver } };
    case 'driver/locations':
      return {
        ...state,
        drivers: applyLocations(state.drivers, action.events),
        fixes: state.fixes + action.events.length,
      };
    case 'driver/status': {
      const driver = state.drivers[action.event.driverId];
      if (!driver) return state;
      return {
        ...state,
        drivers: { ...state.drivers, [driver.id]: { ...driver, status: action.event.status } },
      };
    }
    case 'delivery/updated':
      return applyDelivery(state, action.delivery);
    case 'connection':
      return { ...state, connection: action.state };
    case 'resumed':
      return { ...state, lastResume: { events: action.events, gap: action.gap } };
  }
}

/** Is the driver's last fix too old to trust for assignment? */
export function isStale(
  driver: DriverDto,
  now: number,
  staleAfterMs = DEFAULT_DRIVER_STALE_AFTER_S * 1000,
): boolean {
  return !driver.position || now - new Date(driver.position.recordedAt).getTime() > staleAfterMs;
}
