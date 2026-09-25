// k6: every virtual user is one driver's phone. It records a fix every INTERVAL_S seconds and
// sends its queue to the API through nginx. When a request fails (for example while an API
// instance is being killed) the same fixes, with the same sequence numbers and idempotency keys,
// are sent again, exactly as the driver app does.
//
// Run by load/run-scale-test.sh inside the grafana/k6 image on the compose network. The fleet
// file (device tokens) comes from `dispatch-sim seed`.
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

// k6 provides the Web Crypto API as a global.
declare const crypto: { randomUUID(): string };

interface FleetDriver {
  driverId: string;
  deviceId: string;
  token: string;
}

interface Point {
  seq: number;
  idempotencyKey: string;
  recordedAt: string;
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps: number;
}

interface BatchResult {
  results: { seq: number; status: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }[];
}

const fleet = new SharedArray<FleetDriver>('fleet', () => {
  const file = JSON.parse(open(__ENV.FLEET ?? '/results/fleet.json')) as { drivers: FleetDriver[] };
  return file.drivers;
});
const API = __ENV.API_URL ?? 'http://nginx';
const INTERVAL_S = Number(__ENV.INTERVAL_S ?? '3');

export const options = {
  scenarios: {
    drivers: {
      executor: 'constant-vus',
      vus: fleet.length,
      duration: __ENV.DURATION ?? '120s',
      gracefulStop: '30s',
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const recorded = new Counter('fixes_recorded');
const accepted = new Counter('fixes_accepted');
const duplicate = new Counter('fixes_duplicate');
const refused = new Counter('fixes_refused');
const retries = new Counter('batch_retries');
const failedBatches = new Counter('batches_failed');

// Module state is per virtual user: each VU runs in its own JavaScript runtime.
let seq = 0;
let pending: Point[] = [];
let position: { lat: number; lng: number; heading: number } | null = null;

function move(): { lat: number; lng: number } {
  // A random walk at about 10 m/s around Dubai; positions matter little for this test.
  position ??= {
    lat: 25.05 + Math.random() * 0.2,
    lng: 55.1 + Math.random() * 0.3,
    heading: Math.random() * 2 * Math.PI,
  };
  position.heading += (Math.random() - 0.5) * 0.6;
  const step = (10 * INTERVAL_S) / 111_320;
  position.lat += Math.cos(position.heading) * step;
  position.lng += Math.sin(position.heading) * step;
  return { lat: Number(position.lat.toFixed(6)), lng: Number(position.lng.toFixed(6)) };
}

function flush(driver: FleetDriver): void {
  for (let attempt = 0; attempt < 6 && pending.length > 0; attempt += 1) {
    if (attempt > 0) {
      retries.add(1);
      sleep(0.25 * attempt);
    }
    const response = http.post(
      `${API}/v1/driver/locations`,
      JSON.stringify({ points: pending, sentAt: Date.now() }),
      {
        headers: { authorization: `Bearer ${driver.token}`, 'content-type': 'application/json' },
        timeout: '10s',
        tags: { name: 'locations' },
      },
    );
    if (response.status !== 200) continue;
    const body = response.json() as unknown as BatchResult;
    const answered = new Set<number>();
    for (const result of body.results) {
      answered.add(result.seq);
      if (result.status === 'accepted') accepted.add(1);
      else if (result.status === 'duplicate') duplicate.add(1);
      else refused.add(1);
    }
    pending = pending.filter((point) => !answered.has(point.seq));
    return;
  }
  if (pending.length > 0) failedBatches.add(1);
}

export default function (): void {
  const driver = fleet[(exec.vu.idInTest - 1) % fleet.length];
  if (!driver) return;
  const { lat, lng } = move();
  pending.push({
    seq,
    idempotencyKey: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    lat,
    lng,
    accuracyM: 8,
    speedMps: 10,
  });
  seq += 1;
  recorded.add(1);
  flush(driver);
  sleep(INTERVAL_S);
}

/** Only machine-readable output: the run script stores it next to the listener's report. */
export function handleSummary(data: {
  metrics: Record<string, { values: Record<string, number> }>;
}) {
  const count = (name: string) => data.metrics[name]?.values.count ?? 0;
  const duration = data.metrics.http_req_duration?.values ?? {};
  const summary = {
    fixesRecorded: count('fixes_recorded'),
    fixesAccepted: count('fixes_accepted'),
    fixesDuplicate: count('fixes_duplicate'),
    fixesRefused: count('fixes_refused'),
    fixesUnacknowledged:
      count('fixes_recorded') -
      count('fixes_accepted') -
      count('fixes_duplicate') -
      count('fixes_refused'),
    batchRetries: count('batch_retries'),
    batchesFailed: count('batches_failed'),
    httpRequests: count('http_reqs'),
    httpFailedRate: data.metrics.http_req_failed?.values.rate ?? 0,
    httpDurationMs: duration,
  };
  return { stdout: `${JSON.stringify(summary)}\n` };
}
