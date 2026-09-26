import {
  LiveFeed,
  type DeliveryDto,
  type DispatchClientToServerEvents,
  type DispatchServerToClientEvents,
  type DriverDto,
  type DriverLocationEvent,
  type ResumeResponse,
} from '@dispatch/shared';
import type { Socket } from 'socket.io-client';
import type { ConsoleAction } from './console-state';

export type DispatchSocket = Socket<DispatchServerToClientEvents, DispatchClientToServerEvents>;

export interface Snapshot {
  drivers: DriverDto[];
  deliveries: DeliveryDto[];
}

export interface DispatchFeedOptions {
  socket: DispatchSocket;
  dispatch: (action: ConsoleAction) => void;
  /** Loads drivers and deliveries over HTTP. */
  loadSnapshot: (signal: AbortSignal) => Promise<Snapshot>;
  /** The server refused the token or closed the connection because the session ended. */
  onSessionEnded: () => void;
  /** Waits between snapshot attempts, in order; the last value repeats. */
  retryDelaysMs?: readonly number[];
  /** Test seams: batching of fixes per animation frame, and waiting. */
  frame?: (callback: () => void) => () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function animationFrame(callback: () => void): () => void {
  const id = requestAnimationFrame(callback);
  return () => {
    cancelAnimationFrame(id);
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function resumePage(socket: DispatchSocket, since: string): Promise<ResumeResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('resume timed out'));
    }, 10_000);
    socket.emit('resume', { since, limit: 1_000 }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/**
 * The console's live connection, without React (the hook in use-dispatch-feed.ts wraps it).
 *
 * On every connection, first or after a reconnect, it does two things:
 * - reloads drivers and deliveries over HTTP, retrying with backoff until it succeeds. Delivery
 *   changes and driver status changes are not kept in the stream, so this is how the console
 *   learns what changed while it was disconnected. Status and delivery events that arrive during
 *   the reload are applied again after it, so an older snapshot cannot hide them.
 * - after a reconnect, asks the server for every fix published since the newest one it saw
 *   (LiveFeed keeps that cursor and drops repeats).
 * Fixes are applied at most once per animation frame, so a busy fleet does not re-render per fix.
 * Returns a function that stops the feed and closes the socket.
 */
export function startDispatchFeed(options: DispatchFeedOptions): () => void {
  const { socket, dispatch } = options;
  const frame = options.frame ?? animationFrame;
  const sleep = options.sleep ?? abortableSleep;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const feed = new LiveFeed();
  const stopped = new AbortController();
  /** Increases on every connection; work started for an older connection stops. */
  let connection = 0;
  /** Status and delivery events received while a snapshot is loading. */
  let heldBack: ConsoleAction[] | null = null;

  let pending: DriverLocationEvent[] = [];
  let cancelFrame: (() => void) | null = null;
  const flush = () => {
    cancelFrame = null;
    if (pending.length === 0) return;
    dispatch({ type: 'driver/locations', events: pending });
    pending = [];
  };
  const accept = (event: DriverLocationEvent) => {
    if (!feed.accept(event)) return;
    pending.push(event);
    cancelFrame ??= frame(flush);
  };
  const apply = (action: ConsoleAction) => {
    dispatch(action);
    heldBack?.push(action);
  };

  const reload = async (current: number) => {
    const held: ConsoleAction[] = [];
    heldBack = held;
    for (let attempt = 0; ; attempt += 1) {
      const aborted = new AbortController();
      const onStop = () => {
        aborted.abort();
      };
      stopped.signal.addEventListener('abort', onStop, { once: true });
      try {
        const snapshot = await options.loadSnapshot(aborted.signal);
        if (current !== connection || stopped.signal.aborted) return;
        dispatch({ type: 'snapshot/loaded', ...snapshot });
        for (const action of held) dispatch(action);
        heldBack = null;
        return;
      } catch {
        if (current !== connection || stopped.signal.aborted) return;
        dispatch({
          type: 'snapshot/failed',
          message: 'Drivers and deliveries could not be loaded. Retrying…',
        });
        await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 30_000, stopped.signal);
        if (current !== connection || stopped.signal.aborted) return;
      } finally {
        stopped.signal.removeEventListener('abort', onStop);
      }
    }
  };

  const resume = async (current: number) => {
    let since = feed.resumeFrom();
    if (since === null) return;
    let recovered = 0;
    let gap = false;
    try {
      for (;;) {
        const page = await resumePage(socket, since);
        if (current !== connection) return;
        gap ||= page.gap;
        recovered += page.events.length;
        page.events.forEach(accept);
        const last = page.events.at(-1);
        if (page.complete || !last) break;
        since = last.id;
      }
    } catch {
      // The drivers' positions come back with the snapshot, which is loaded on every connection.
      gap = true;
    }
    dispatch({ type: 'resumed', events: recovered, gap });
  };

  socket.on('driver:location', accept);
  socket.on('driver:status', (event) => {
    apply({ type: 'driver/status', event });
  });
  socket.on('delivery:updated', (delivery) => {
    apply({ type: 'delivery/updated', delivery });
  });
  socket.on('connect', () => {
    connection += 1;
    dispatch({ type: 'connection', state: 'live' });
    void reload(connection);
    void resume(connection);
  });
  socket.on('disconnect', (reason) => {
    // The server closes a console's connection only when its session has ended.
    if (reason === 'io server disconnect') {
      options.onSessionEnded();
      return;
    }
    dispatch({ type: 'connection', state: 'reconnecting' });
  });
  socket.on('connect_error', (error) => {
    if (error.message === 'unauthorized') {
      socket.close();
      options.onSessionEnded();
      return;
    }
    dispatch({ type: 'connection', state: 'reconnecting' });
  });

  return () => {
    stopped.abort();
    cancelFrame?.();
    socket.close();
  };
}
