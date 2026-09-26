import type { DeliveryDto, DriverDto, DriverLocationEvent } from '@dispatch/shared';
import { describe, expect, it } from 'vitest';
import { consoleReducer, initialConsoleState, isStale } from './console-state';

const driver = (id: string, recordedAt: string | null = null): DriverDto => ({
  id,
  name: id,
  phone: null,
  vehicle: null,
  status: 'available',
  position: recordedAt ? { lat: 25, lng: 55, accuracyM: 5, recordedAt } : null,
  activeDeliveryId: null,
});

const fix = (driverId: string, recordedAt: string, lat: number): DriverLocationEvent => ({
  id: '1-0',
  driverId,
  deviceId: `${driverId}-phone`,
  seq: 1,
  lat,
  lng: 55.3,
  accuracyM: 5,
  speedMps: null,
  headingDeg: null,
  recordedAt,
  sentAt: null,
  publishedAt: 0,
});

describe('consoleReducer', () => {
  it('moves a driver only to a newer fix', () => {
    let state = consoleReducer(initialConsoleState, {
      type: 'snapshot/loaded',
      drivers: [driver('a', '2026-09-20T10:00:10.000Z')],
      deliveries: [],
    });
    state = consoleReducer(state, {
      type: 'driver/locations',
      events: [fix('a', '2026-09-20T10:00:05.000Z', 25.1)],
    });
    expect(state.drivers.a?.position?.lat).toBe(25);
    state = consoleReducer(state, {
      type: 'driver/locations',
      events: [fix('a', '2026-09-20T10:00:20.000Z', 25.2)],
    });
    expect(state.drivers.a?.position?.lat).toBe(25.2);
    expect(state.fixes).toBe(2);
  });

  it('ignores fixes for drivers it does not know yet', () => {
    const state = consoleReducer(initialConsoleState, {
      type: 'driver/locations',
      events: [fix('ghost', '2026-09-20T10:00:00.000Z', 25)],
    });
    expect(state.drivers).toEqual({});
  });

  it('keeps the active delivery of each driver in step with delivery updates', () => {
    let state = consoleReducer(initialConsoleState, {
      type: 'snapshot/loaded',
      drivers: [driver('a'), driver('b')],
      deliveries: [],
    });
    const delivery = {
      id: 'd1',
      status: 'assigned',
      driver: { id: 'a', name: 'a' },
      updatedAt: '2026-09-20T10:00:00.000Z',
    } as DeliveryDto;
    state = consoleReducer(state, { type: 'delivery/updated', delivery });
    expect(state.drivers.a?.activeDeliveryId).toBe('d1');
    state = consoleReducer(state, {
      type: 'delivery/updated',
      delivery: { ...delivery, driver: { id: 'b', name: 'b' } },
    });
    expect(state.drivers.a?.activeDeliveryId).toBeNull();
    expect(state.drivers.b?.activeDeliveryId).toBe('d1');
    state = consoleReducer(state, {
      type: 'delivery/updated',
      delivery: { ...delivery, status: 'delivered', driver: { id: 'b', name: 'b' } },
    });
    expect(state.drivers.b?.activeDeliveryId).toBeNull();
  });

  it('keeps the newer version of a delivery, whichever path brought it', () => {
    const v1 = {
      id: 'd1',
      status: 'assigned',
      driver: null,
      updatedAt: '2026-09-20T10:00:00.000Z',
    } as DeliveryDto;
    const v2 = { ...v1, status: 'cancelled', updatedAt: '2026-09-20T10:00:05.000Z' } as DeliveryDto;
    let state = consoleReducer(initialConsoleState, { type: 'delivery/updated', delivery: v2 });
    state = consoleReducer(state, { type: 'delivery/updated', delivery: v1 });
    expect(state.deliveries.d1?.status).toBe('cancelled');
    state = consoleReducer(state, { type: 'snapshot/loaded', drivers: [], deliveries: [v1] });
    expect(state.deliveries.d1?.status).toBe('cancelled');
  });

  it('does not move a driver back when a reload returns an older position', () => {
    let state = consoleReducer(initialConsoleState, {
      type: 'snapshot/loaded',
      drivers: [driver('a', '2026-09-20T10:00:00.000Z')],
      deliveries: [],
    });
    state = consoleReducer(state, {
      type: 'driver/locations',
      events: [fix('a', '2026-09-20T10:00:20.000Z', 25.2)],
    });
    state = consoleReducer(state, {
      type: 'snapshot/loaded',
      drivers: [{ ...driver('a', '2026-09-20T10:00:10.000Z'), status: 'busy' }],
      deliveries: [],
    });
    expect(state.drivers.a?.position?.lat).toBe(25.2);
    expect(state.drivers.a?.status).toBe('busy');
  });

  it('shows a load failure until the next successful load', () => {
    let state = consoleReducer(initialConsoleState, { type: 'snapshot/failed', message: 'down' });
    expect(state.loadError).toBe('down');
    state = consoleReducer(state, { type: 'snapshot/loaded', drivers: [], deliveries: [] });
    expect(state.loadError).toBeNull();
  });

  it('treats a driver without a recent fix as stale', () => {
    const now = Date.parse('2026-09-20T10:05:00Z');
    expect(isStale(driver('a', '2026-09-20T10:04:30Z'), now)).toBe(false);
    expect(isStale(driver('a', '2026-09-20T10:00:00Z'), now)).toBe(true);
    expect(isStale(driver('a'), now)).toBe(true);
  });
});
