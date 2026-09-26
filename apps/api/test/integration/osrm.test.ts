import { haversineMeters } from '@dispatch/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { EtaService } from '../../src/eta/eta.service.js';

// Opt-in: runs only against a real OSRM server, for example the compose `osrm` profile after
// scripts/prepare-osrm.sh --bbox 25.08,55.17,25.16,55.25:
//   TEST_OSRM_URL=http://localhost:57500 npm run test:integration -w @dispatch/api
// CI does not prepare road data, so it skips this file.
const osrmUrl = process.env.TEST_OSRM_URL;

// Two points in Al Barsha / Al Sufouh, inside the small box above.
const from = { lat: 25.118, lng: 55.205 };
const to = { lat: 25.14, lng: 55.228 };

describe.skipIf(!osrmUrl)('EtaService against a real OSRM server', () => {
  const eta = new EtaService(
    loadConfig({
      DATABASE_URL: 'postgresql://localhost/dispatch',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'j'.repeat(40),
      TRACKING_TOKEN_SECRET: 't'.repeat(40),
      OSRM_URL: osrmUrl ?? '',
      OSRM_TIMEOUT_MS: '5000',
    }),
  );

  it('returns a road route that is longer than the straight line', async () => {
    const estimate = await eta.estimate(from, to);
    expect(estimate.source).toBe('osrm');
    expect(estimate.distanceMeters).toBeGreaterThan(haversineMeters(from, to));
    expect(estimate.seconds).toBeGreaterThan(0);
  });

  it('answers a table request for several drivers with one route each', async () => {
    const origins = [from, { lat: 25.125, lng: 55.21 }, { lat: 25.13, lng: 55.2 }];
    const estimates = await eta.estimateMany(origins, to);
    expect(estimates).toHaveLength(3);
    for (const [index, estimate] of estimates.entries()) {
      expect(estimate.source).toBe('osrm');
      expect(estimate.distanceMeters).toBeGreaterThan(haversineMeters(origins[index]!, to));
    }
  });
});
