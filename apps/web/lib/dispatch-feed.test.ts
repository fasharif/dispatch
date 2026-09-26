import type {
  DeliveryDto,
  DriverDto,
  DriverLocationEvent,
  ResumeRequest,
  ResumeResponse,
} from '@dispatch/shared';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { consoleReducer, initialConsoleState, type ConsoleAction } from './console-state';
import { startDispatchFeed, type DispatchSocket, type Snapshot } from './dispatch-feed';

/** Stands in for a socket.io client socket: records resume requests and answers them. */
class FakeSocket {
  private readonly events = new EventEmitter();
  readonly resumeRequests: ResumeRequest[] = [];
  resumeAnswers: ResumeResponse[] = [];
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  emit(event: string, request: ResumeRequest, ack: (response: ResumeResponse) => void): this {
    if (event === 'resume') {
      this.resumeRequests.push(request);
      ack(this.resumeAnswers.shift() ?? { events: [], complete: true, gap: false });
    }
    return this;
  }

  close(): this {
    this.closed = true;
    return this;
  }

  /** A connection event, or something the server sends. */
  receive(event: string, ...args: unknown[]): void {
    this.events.emit(event, ...args);
  }
}

const driver = (id: string, status: DriverDto['status'] = 'available'): DriverDto => ({
  id,
  name: id,
  phone: null,
  vehicle: null,
  status,
  position: { lat: 25, lng: 55, accuracyM: 5, recordedAt: '2026-09-20T10:00:00.000Z' },
  activeDeliveryId: null,
});

const delivery = (status: DeliveryDto['status'], updatedAt: string): DeliveryDto =>
  ({ id: 'd1', status, driver: null, updatedAt }) as DeliveryDto;

const location = (
  id: string,
  seq: number,
  recordedAt: string,
  lat: number,
): DriverLocationEvent => ({
  id,
  driverId: 'a',
  deviceId: 'phone-a',
  seq,
  lat,
  lng: 55.3,
  accuracyM: 5,
  speedMps: null,
  headingDeg: null,
  recordedAt,
  sentAt: null,
  publishedAt: 0,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(snapshots: (Snapshot | Error | Promise<Snapshot>)[]) {
  const socket = new FakeSocket();
  const actions: ConsoleAction[] = [];
  const delays: number[] = [];
  const onSessionEnded = vi.fn();
  const loadSnapshot = vi.fn(async () => {
    const next = snapshots.shift() ?? { drivers: [], deliveries: [] };
    if (next instanceof Error) throw next;
    return next;
  });
  const stop = startDispatchFeed({
    socket: socket as unknown as DispatchSocket,
    dispatch: (action) => actions.push(action),
    loadSnapshot,
    onSessionEnded,
    frame: (callback) => {
      queueMicrotask(callback);
      return () => undefined;
    },
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  const state = () => actions.reduce(consoleReducer, initialConsoleState);
  return { socket, actions, delays, onSessionEnded, loadSnapshot, stop, state };
}

describe('startDispatchFeed', () => {
  it('loads drivers and deliveries when it connects', async () => {
    const feed = setup([
      { drivers: [driver('a')], deliveries: [delivery('pending', '2026-09-20T10:00:00.000Z')] },
    ]);
    feed.socket.receive('connect');
    await settle();
    expect(feed.state()).toMatchObject({ connection: 'live', loadError: null });
    expect(Object.keys(feed.state().drivers)).toEqual(['a']);
    expect(feed.state().deliveries.d1?.status).toBe('pending');
    // Nothing to resume on the first connection.
    expect(feed.socket.resumeRequests).toEqual([]);
  });

  it('after a reconnect, reloads what changed meanwhile and resumes positions', async () => {
    const feed = setup([
      { drivers: [driver('a')], deliveries: [delivery('assigned', '2026-09-20T10:00:00.000Z')] },
      {
        drivers: [driver('a', 'available')],
        deliveries: [delivery('cancelled', '2026-09-20T10:01:00.000Z')],
      },
    ]);
    feed.socket.receive('connect');
    await settle();
    feed.socket.receive(
      'driver:location',
      location('1726826410000-0', 0, '2026-09-20T10:00:10.000Z', 25.1),
    );
    await settle();

    // While the console is disconnected, the delivery is cancelled and the driver moves on.
    feed.socket.receive('disconnect', 'transport close');
    expect(feed.state().connection).toBe('reconnecting');
    feed.socket.resumeAnswers = [
      {
        events: [location('1726826430000-0', 1, '2026-09-20T10:00:30.000Z', 25.3)],
        complete: true,
        gap: false,
      },
    ];
    feed.socket.receive('connect');
    await settle();

    expect(feed.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(feed.socket.resumeRequests).toEqual([{ since: '1726826405000-0', limit: 1_000 }]);
    const state = feed.state();
    expect(state.connection).toBe('live');
    expect(state.deliveries.d1?.status).toBe('cancelled');
    expect(state.drivers.a?.position?.lat).toBe(25.3);
    expect(state.lastResume).toEqual({ events: 1, gap: false });
  });

  it('keeps retrying a failed load with backoff and says so meanwhile', async () => {
    const feed = setup([
      new Error('ERR_CONNECTION_RESET'),
      new Error('ERR_CONNECTION_RESET'),
      { drivers: [driver('a')], deliveries: [] },
    ]);
    feed.socket.receive('connect');
    await settle();
    expect(feed.delays).toEqual([1_000, 2_000]);
    expect(feed.actions.filter((a) => a.type === 'snapshot/failed')).toHaveLength(2);
    expect(feed.state().loadError).toBeNull();
    expect(Object.keys(feed.state().drivers)).toEqual(['a']);
  });

  it('applies status and delivery events that arrive during a load again after it', async () => {
    let resolveLoad: (snapshot: Snapshot) => void = () => undefined;
    const slow = new Promise<Snapshot>((resolve) => {
      resolveLoad = resolve;
    });
    const feed = setup([slow]);
    feed.socket.receive('connect');
    feed.socket.receive('driver:status', { driverId: 'a', status: 'busy' });
    feed.socket.receive('delivery:updated', delivery('picked_up', '2026-09-20T10:02:00.000Z'));
    // The snapshot was read before those changes.
    resolveLoad({
      drivers: [driver('a', 'available')],
      deliveries: [delivery('assigned', '2026-09-20T10:01:00.000Z')],
    });
    await settle();
    expect(feed.state().drivers.a?.status).toBe('busy');
    expect(feed.state().deliveries.d1?.status).toBe('picked_up');
  });

  it('ends the session when the server closes the connection or refuses the token', () => {
    const feed = setup([]);
    feed.socket.receive('disconnect', 'io server disconnect');
    expect(feed.onSessionEnded).toHaveBeenCalledTimes(1);
    feed.socket.receive('connect_error', new Error('unauthorized'));
    expect(feed.onSessionEnded).toHaveBeenCalledTimes(2);
    expect(feed.socket.closed).toBe(true);
  });

  it('dispatches nothing after it is stopped', async () => {
    let resolveLoad: (snapshot: Snapshot) => void = () => undefined;
    const feed = setup([
      new Promise<Snapshot>((resolve) => {
        resolveLoad = resolve;
      }),
    ]);
    feed.socket.receive('connect');
    feed.stop();
    resolveLoad({ drivers: [driver('a')], deliveries: [] });
    await settle();
    expect(feed.socket.closed).toBe(true);
    expect(feed.actions.map((a) => a.type)).toEqual(['connection']);
  });
});
