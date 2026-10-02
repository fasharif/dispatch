'use client';

import { DISPATCH_NAMESPACE } from '@dispatch/shared';
import { useEffect, type Dispatch } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from './config';
import type { ConsoleAction } from './console-state';
import { startDispatchFeed, type DispatchSocket, type Snapshot } from './dispatch-feed';

/**
 * Connects the console to the live feed while it has a token: WebSocket only, reconnecting with
 * backoff. What happens on each connection is described in dispatch-feed.ts.
 */
export function useDispatchFeed(
  token: string | null,
  dispatch: Dispatch<ConsoleAction>,
  loadSnapshot: (signal: AbortSignal) => Promise<Snapshot>,
  onSessionEnded: () => void,
): void {
  useEffect(() => {
    if (!token) return;
    const socket: DispatchSocket = io(`${API_URL}${DISPATCH_NAMESPACE}`, {
      transports: ['websocket'],
      auth: { token },
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    return startDispatchFeed({ socket, dispatch, loadSnapshot, onSessionEnded });
  }, [token, dispatch, loadSnapshot, onSessionEnded]);
}
