import { describe, expect, it } from 'vitest';
import { bearingDegrees, haversineMeters, interpolate, straightLineEta } from './geo.js';

// Reference points: Burj Khalifa, Dubai Marina Mall and Dubai International Airport Terminal 3.
const burjKhalifa = { lat: 25.197197, lng: 55.274376 };
const marinaMall = { lat: 25.07625, lng: 55.14065 };
const dxbT3 = { lat: 25.24877, lng: 55.35276 };

describe('haversineMeters', () => {
  it('is zero for the same point and symmetric', () => {
    expect(haversineMeters(burjKhalifa, burjKhalifa)).toBe(0);
    expect(haversineMeters(burjKhalifa, marinaMall)).toBeCloseTo(
      haversineMeters(marinaMall, burjKhalifa),
      6,
    );
  });

  it('agrees with the PostGIS ellipsoidal distance within 0.5 %', () => {
    // Reference value from PostGIS 3.6 (see the integration test "measures distances on the
    // ellipsoid"): ST_Distance of these two points as geography.
    const postgisMeters = 19_009;
    const distance = haversineMeters(burjKhalifa, marinaMall);
    expect(Math.abs(distance - postgisMeters) / postgisMeters).toBeLessThan(0.005);
  });

  it('measures one degree of latitude as about 111 km', () => {
    expect(haversineMeters({ lat: 25, lng: 55 }, { lat: 26, lng: 55 })).toBeCloseTo(111_195, -2);
  });
});

describe('straightLineEta', () => {
  it('applies the detour factor and the average speed', () => {
    const eta = straightLineEta(burjKhalifa, dxbT3, { speedKmh: 36, detourFactor: 1.5 });
    const straight = haversineMeters(burjKhalifa, dxbT3);
    expect(eta.source).toBe('straight_line');
    expect(eta.distanceMeters).toBe(Math.round(straight * 1.5));
    // 36 km/h is 10 m/s.
    expect(eta.seconds).toBe(Math.round((straight * 1.5) / 10));
  });

  it('rejects impossible assumptions', () => {
    expect(() => straightLineEta(burjKhalifa, dxbT3, { speedKmh: 0, detourFactor: 1.4 })).toThrow(
      RangeError,
    );
    expect(() => straightLineEta(burjKhalifa, dxbT3, { speedKmh: 30, detourFactor: 0.9 })).toThrow(
      RangeError,
    );
  });
});

describe('interpolate and bearingDegrees', () => {
  it('clamps the fraction and returns the end points', () => {
    expect(interpolate(burjKhalifa, marinaMall, 0)).toEqual(burjKhalifa);
    expect(interpolate(burjKhalifa, marinaMall, 2)).toEqual(marinaMall);
    expect(interpolate({ lat: 0, lng: 0 }, { lat: 2, lng: 4 }, 0.5)).toEqual({ lat: 1, lng: 2 });
  });

  it('points north, east, south and west', () => {
    const origin = { lat: 25, lng: 55 };
    expect(bearingDegrees(origin, { lat: 25.1, lng: 55 })).toBeCloseTo(0, 5);
    expect(bearingDegrees(origin, { lat: 25, lng: 55.1 })).toBeCloseTo(90, 0);
    expect(bearingDegrees(origin, { lat: 24.9, lng: 55 })).toBeCloseTo(180, 5);
    expect(bearingDegrees(origin, { lat: 25, lng: 54.9 })).toBeCloseTo(270, 0);
  });
});
