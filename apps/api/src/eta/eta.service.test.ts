import { afterEach, describe, expect, it } from 'vitest';
import { localServer, type LocalServer } from '../../test/support/local-server.js';
import { loadConfig } from '../config/env.js';
import { EtaService } from './eta.service.js';

const from = { lat: 25.1425, lng: 55.2275 };
const to = { lat: 25.0971, lng: 55.2019 };

function service(osrmUrl = '', timeoutMs = 1000): EtaService {
  return new EtaService(
    loadConfig({
      DATABASE_URL: 'postgresql://localhost/dispatch',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'j'.repeat(40),
      TRACKING_TOKEN_SECRET: 't'.repeat(40),
      OSRM_URL: osrmUrl,
      OSRM_TIMEOUT_MS: String(timeoutMs),
    }),
  );
}

describe('EtaService', () => {
  let osrm: LocalServer | undefined;
  afterEach(async () => {
    await osrm?.close();
    osrm = undefined;
  });

  it('uses the straight-line estimate when no routing engine is configured', async () => {
    const eta = service();
    expect(eta.routingEnabled).toBe(false);
    const estimate = await eta.estimate(from, to);
    expect(estimate.source).toBe('straight_line');
    // 5.67 km as the crow flies × 1.4 at 30 km/h ≈ 15.9 minutes.
    expect(estimate.distanceMeters).toBeGreaterThan(7_800);
    expect(estimate.distanceMeters).toBeLessThan(8_100);
    expect(estimate.seconds).toBe(Math.round(estimate.distanceMeters / (30_000 / 3600)));
  });

  it('asks OSRM for a driving route (longitude first) and uses its duration and distance', async () => {
    osrm = await localServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          code: 'Ok',
          routes: [{ duration: 612.4, distance: 8123.9, weight: 612.4 }],
        }),
      );
    });
    const estimate = await service(osrm.url).estimate(from, to);
    expect(estimate).toEqual({ seconds: 612, distanceMeters: 8124, source: 'osrm' });
    expect(osrm.requests[0]?.url).toBe(
      '/route/v1/driving/55.227500,25.142500;55.201900,25.097100?overview=false&alternatives=false&steps=false',
    );
  });

  it('falls back to the straight line when OSRM fails, answers "NoRoute" or is too slow', async () => {
    const replies = [
      (res: import('node:http').ServerResponse) => {
        res.statusCode = 500;
        res.end('boom');
      },
      (res: import('node:http').ServerResponse) => {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: 'NoRoute', message: 'Impossible route between points' }));
      },
      () => {
        // No reply: the request times out.
      },
    ];
    osrm = await localServer((_req, res) => {
      replies.shift()?.(res);
    });
    const eta = service(osrm.url, 300);
    for (let i = 0; i < 3; i += 1) {
      expect((await eta.estimate(from, to)).source).toBe('straight_line');
    }
  });

  it('estimates several origins in one table request and falls back per unreachable origin', async () => {
    osrm = await localServer((_req, res) => {
      res.end(
        JSON.stringify({ code: 'Ok', durations: [[300.2], [null]], distances: [[2500.4], [null]] }),
      );
    });
    const [first, second] = await service(osrm.url).estimateMany(
      [from, { lat: 25.2, lng: 55.28 }],
      to,
    );
    expect(first).toEqual({ seconds: 300, distanceMeters: 2500, source: 'osrm' });
    expect(second?.source).toBe('straight_line');
    expect(osrm.requests[0]?.url).toBe(
      '/table/v1/driving/55.227500,25.142500;55.280000,25.200000;55.201900,25.097100' +
        '?sources=0;1&destinations=2&annotations=duration,distance',
    );
    expect(await service(osrm.url).estimateMany([], to)).toEqual([]);
  });
});
