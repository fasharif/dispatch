'use client';

import {
  DISPATCH_NAMESPACE,
  LiveFeed,
  type DispatchClientToServerEvents,
  type DispatchServerToClientEvents,
  type DriverLocationEvent,
  type ResumeResponse,
} from '@dispatch/shared';
import { useEffect, type Dispatch } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './config';
import type { ConsoleAction } from './console-state';

type DispatchSocket = Socket<DispatchServerToClientEvents, DispatchClientToServerEvents>;

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
 * The console's live connection: WebSocket only, reconnecting with backoff. After a reconnect it
 * asks for every fix published since the newest one it saw (LiveFeed keeps that cursor and drops
 * repeats). If the gap is older than the server keeps, it reloads the drivers over HTTP.
 * Fixes are applied at most once per animation frame, so a busy fleet does not re-render per fix.
 */
export function useDispatchFeed(
  token: string | null,
  dispatch: Dispatch<ConsoleAction>,
  onGap: () => void,
  onUnauthorized: () => void,
): void {
  useEffect(() => {
    if (!token) return;
    const feed = new LiveFeed();
    let pending: DriverLocationEvent[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      if (pending.length === 0) return;
      dispatch({ type: 'driver/locations', events: pending });
      pending = [];
    };
    const accept = (event: DriverLocationEvent) => {
      if (!feed.accept(event)) return;
      pending.push(event);
      frame ??= requestAnimationFrame(flush);
    };

    const socket: DispatchSocket = io(`${API_URL}${DISPATCH_NAMESPACE}`, {
      transports: ['websocket'],
      auth: { token },
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    socket.on('driver:location', accept);
    socket.on('driver:status', (event) => {
      dispatch({ type: 'driver/status', event });
    });
    socket.on('delivery:updated', (delivery) => {
      dispatch({ type: 'delivery/updated', delivery });
    });
    socket.on('disconnect', () => {
      dispatch({ type: 'connection', state: 'reconnecting' });
    });
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') {
        socket.close();
        onUnauthorized();
        return;
      }
      dispatch({ type: 'connection', state: 'reconnecting' });
    });
    socket.on('connect', () => {
      dispatch({ type: 'connection', state: 'live' });
      let since = feed.resumeFrom();
      if (since === null) return;
      void (async () => {
        let recovered = 0;
        let gap = false;
        try {
          for (;;) {
            const page = await resumePage(socket, since);
            gap ||= page.gap;
            recovered += page.events.length;
            page.events.forEach(accept);
            const last = page.events.at(-1);
            if (page.complete || !last) break;
            since = last.id;
          }
        } catch {
          gap = true;
        }
        dispatch({ type: 'resumed', events: recovered, gap });
        if (gap) onGap();
      })();
    });

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      socket.close();
    };
  }, [token, dispatch, onGap, onUnauthorized]);
}
