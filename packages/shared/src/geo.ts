/** A WGS 84 position in decimal degrees. */
export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres (haversine formula on a spherical Earth).
 * The error against the WGS 84 ellipsoid is below 0.5 %, which is plenty for ETAs and previews.
 * Geofence decisions are made in PostGIS on the ellipsoid, not with this function.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface StraightLineEtaOptions {
  /** Assumed average road speed. */
  speedKmh: number;
  /** Road distance divided by straight-line distance. Roads are never straight, so this is > 1. */
  detourFactor: number;
}

/**
 * Default assumptions for the straight-line fallback, used when no routing engine is configured.
 * They are planning assumptions, not measurements: 30 km/h average urban speed including stops,
 * and roads 1.4 times longer than the straight line.
 */
export const DEFAULT_STRAIGHT_LINE_ETA: StraightLineEtaOptions = {
  speedKmh: 30,
  detourFactor: 1.4,
};

export interface EtaEstimate {
  /** Estimated travel time in whole seconds. */
  seconds: number;
  /** Estimated road distance in metres. */
  distanceMeters: number;
  source: 'osrm' | 'straight_line';
}

/** Straight-line ETA: haversine distance × detour factor ÷ average speed. */
export function straightLineEta(
  from: LatLng,
  to: LatLng,
  options: StraightLineEtaOptions = DEFAULT_STRAIGHT_LINE_ETA,
): EtaEstimate {
  if (options.speedKmh <= 0 || options.detourFactor < 1) {
    throw new RangeError('speedKmh must be positive and detourFactor at least 1');
  }
  const distanceMeters = haversineMeters(from, to) * options.detourFactor;
  const metresPerSecond = (options.speedKmh * 1000) / 3600;
  return {
    seconds: Math.round(distanceMeters / metresPerSecond),
    distanceMeters: Math.round(distanceMeters),
    source: 'straight_line',
  };
}

/** Linear interpolation between two positions; good enough for the short legs the simulator drives. */
export function interpolate(a: LatLng, b: LatLng, fraction: number): LatLng {
  const t = Math.min(1, Math.max(0, fraction));
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Initial bearing from a to b in degrees clockwise from north (0–360). */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const phi1 = toRadians(a.lat);
  const phi2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
