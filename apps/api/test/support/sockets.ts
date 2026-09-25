import {
  DISPATCH_NAMESPACE,
  TRACKING_NAMESPACE,
  type DispatchClientToServerEvents,
  type DispatchServerToClientEvents,
  type TrackingClientToServerEvents,
  type TrackingServerToClientEvents,
} from '@dispatch/shared';
import { io, type Socket } from 'socket.io-client';

export type DispatchSocket = Socket<DispatchServerToClientEvents, DispatchClientToServerEvents>;
export type TrackingSocket = Socket<TrackingServerToClientEvents, TrackingClientToServerEvents>;

/** Connects like the web console: WebSocket transport only, token in the handshake. */
export function connectDispatch(url: string, token: string): Promise<DispatchSocket> {
  const socket: DispatchSocket = io(`${url}${DISPATCH_NAMESPACE}`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    forceNew: true,
  });
  return connected(socket);
}

export function connectTracking(url: string, token: string): TrackingSocket {
  return io(`${url}${TRACKING_NAMESPACE}`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    forceNew: true,
  });
}

export function connected<S extends Socket>(socket: S): Promise<S> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('connect_error', (error: Error) => {
      socket.close();
      reject(error);
    });
  });
}

/** Collects every payload of one event name. */
export function collect<T>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (payload: T) => {
    items.push(payload);
  });
  return items;
}
