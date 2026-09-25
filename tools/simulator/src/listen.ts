import {
  DISPATCH_NAMESPACE,
  LiveFeed,
  fixKey,
  type DispatchClientToServerEvents,
  type DispatchServerToClientEvents,
  type DriverLocationEvent,
  type ResumeResponse,
} from '@dispatch/shared';
import { io, type Socket } from 'socket.io-client';
import { summarise, type LatencySummary } from './stats.js';

export interface ListenOptions {
  api: string;
  token: string;
  durationSeconds: number;
  log?: (line: string) => void;
}

export interface ListenReport {
  startedAt: string;
  endedAt: string;
  connects: number;
  disconnects: number;
  resumes: number;
  resumedEvents: number;
  gaps: number;
  eventsReceived: number;
  duplicatesDropped: number;
  uniqueFixes: number;
  /** Driver update to console, from the device's sentAt to receipt, for fixes seen live. */
  latencyLiveMs: LatencySummary;
  /** The same, including fixes recovered by a resume after a reconnect. */
  latencyAllMs: LatencySummary;
  receivedKeys: string[];
}

type DispatchSocket = Socket<DispatchServerToClientEvents, DispatchClientToServerEvents>;

/**
 * A dispatcher console without the map: connects over WebSocket only, reconnects with backoff,
 * resumes from the newest stream id it saw, and records which fixes arrived and how late.
 * Latency is measured with the sender's clock, so sender and listener must share a clock (same
 * host or synchronised hosts).
 */
export async function listen(options: ListenOptions): Promise<ListenReport> {
  const log = options.log ?? (() => undefined);
  const feed = new LiveFeed();
  const keys = new Set<string>();
  const live: number[] = [];
  const all: number[] = [];
  const report = {
    connects: 0,
    disconnects: 0,
    resumes: 0,
    resumedEvents: 0,
    gaps: 0,
    events: 0,
    duplicates: 0,
  };
  const startedAt = new Date();

  const record = (event: DriverLocationEvent, resumed: boolean) => {
    report.events += 1;
    if (!feed.accept(event)) {
      report.duplicates += 1;
      return;
    }
    keys.add(fixKey(event));
    if (event.sentAt !== null) {
      const latency = Date.now() - event.sentAt;
      all.push(latency);
      if (!resumed) live.push(latency);
    }
  };

  const socket: DispatchSocket = io(`${options.api}${DISPATCH_NAMESPACE}`, {
    transports: ['websocket'],
    auth: { token: options.token },
    reconnection: true,
    reconnectionDelay: 250,
    reconnectionDelayMax: 2_000,
  });
  socket.on('driver:location', (event) => {
    record(event, false);
  });
  socket.on('disconnect', (reason) => {
    report.disconnects += 1;
    log(`disconnected: ${reason}`);
  });
  socket.on('connect_error', (error) => {
    log(`connect error: ${error.message}`);
  });

  let resuming: Promise<void> = Promise.resolve();
  socket.on('connect', () => {
    report.connects += 1;
    log(`connected (${String(report.connects)})`);
    resuming = resuming
      .then(async () => {
        let since = feed.resumeFrom();
        if (since === null) return;
        report.resumes += 1;
        for (;;) {
          const page = await resumePage(socket, since);
          if (page.gap) report.gaps += 1;
          for (const event of page.events) {
            report.resumedEvents += 1;
            record(event, true);
          }
          const last: DriverLocationEvent | undefined = page.events.at(-1);
          if (page.complete || !last) break;
          since = last.id;
        }
      })
      .catch((error: unknown) => {
        log(`resume failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  await new Promise((resolve) => setTimeout(resolve, options.durationSeconds * 1000));
  await resuming;
  socket.close();

  return {
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    connects: report.connects,
    disconnects: report.disconnects,
    resumes: report.resumes,
    resumedEvents: report.resumedEvents,
    gaps: report.gaps,
    eventsReceived: report.events,
    duplicatesDropped: report.duplicates,
    uniqueFixes: keys.size,
    latencyLiveMs: summarise(live),
    latencyAllMs: summarise(all),
    receivedKeys: [...keys],
  };
}

function resumePage(socket: DispatchSocket, since: string): Promise<ResumeResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('resume request timed out'));
    }, 10_000);
    socket.emit('resume', { since, limit: 1_000 }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}
