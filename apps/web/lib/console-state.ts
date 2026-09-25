import type {
  DeliveryDto,
  DriverDto,
  DriverLocationEvent,
  DriverStatusEvent,
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
}

export type ConsoleAction =
  | { type: 'drivers/loaded'; drivers: DriverDto[] }
  | { type: 'deliveries/loaded'; deliveries: DeliveryDto[] }
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
};

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

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'drivers/loaded':
      return { ...state, drivers: Object.fromEntries(action.drivers.map((d) => [d.id, d])) };
    case 'deliveries/loaded':
      return {
        ...state,
        deliveries: {
          ...state.deliveries,
          ...Object.fromEntries(action.deliveries.map((d) => [d.id, d])),
        },
      };
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
    case 'delivery/updated': {
      const { delivery } = action;
      const drivers = { ...state.drivers };
      // Keep each driver's active delivery in step with the delivery itself.
      for (const driver of Object.values(drivers)) {
        const carries = driver.activeDeliveryId === delivery.id;
        const shouldCarry =
          delivery.driver?.id === driver.id &&
          (delivery.status === 'assigned' || delivery.status === 'picked_up');
        if (carries && !shouldCarry) drivers[driver.id] = { ...driver, activeDeliveryId: null };
        if (!carries && shouldCarry)
          drivers[driver.id] = { ...driver, activeDeliveryId: delivery.id };
      }
      return { ...state, drivers, deliveries: { ...state.deliveries, [delivery.id]: delivery } };
    }
    case 'connection':
      return { ...state, connection: action.state };
    case 'resumed':
      return { ...state, lastResume: { events: action.events, gap: action.gap } };
  }
}

/** Is the driver's last fix too old to trust for assignment? */
export function isStale(driver: DriverDto, now: number, staleAfterMs = 120_000): boolean {
  return !driver.position || now - new Date(driver.position.recordedAt).getTime() > staleAfterMs;
}
