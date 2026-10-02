import { bearingDegrees, haversineMeters, interpolate, type LatLng } from '@dispatch/shared';

/**
 * Loops across Dubai for simulated drivers. Each is a list of hand-picked points near major
 * roads, joined by straight segments, so a simulated van moves plausibly on the map without
 * following every bend of the road. They are not routing data.
 */
export const ROUTES: Record<string, LatLng[]> = {
  sheikhZayed: [
    { lat: 25.0805, lng: 55.1403 }, // Dubai Marina
    { lat: 25.1181, lng: 55.2006 }, // Mall of the Emirates
    { lat: 25.1535, lng: 55.2315 }, // Al Quoz
    { lat: 25.186, lng: 55.264 }, // Business Bay
    { lat: 25.211, lng: 55.28 }, // DIFC
    { lat: 25.2285, lng: 55.287 }, // Trade Centre
  ],
  alKhail: [
    { lat: 25.06, lng: 55.21 }, // Al Barsha South
    { lat: 25.1, lng: 55.235 }, // Al Barsha 3
    { lat: 25.14, lng: 55.26 }, // Al Quoz 4
    { lat: 25.175, lng: 55.3 }, // Ras Al Khor road junction
    { lat: 25.19, lng: 55.33 }, // Nad Al Hamar
  ],
  jumeirah: [
    { lat: 25.23, lng: 55.26 }, // Jumeirah 1
    { lat: 25.205, lng: 55.24 }, // Jumeirah 2
    { lat: 25.175, lng: 55.215 }, // Umm Suqeim 1
    { lat: 25.14, lng: 55.19 }, // Umm Suqeim 3
    { lat: 25.105, lng: 55.16 }, // Al Sufouh
  ],
  deira: [
    { lat: 25.27, lng: 55.305 }, // Deira
    { lat: 25.262, lng: 55.33 }, // Port Saeed
    { lat: 25.25, lng: 55.35 }, // Al Garhoud
    { lat: 25.235, lng: 55.37 }, // Airport Terminal 3
    { lat: 25.22, lng: 55.39 }, // Rashidiya
  ],
  barshaLoop: [
    { lat: 25.1124, lng: 55.2006 },
    { lat: 25.1045, lng: 55.2081 },
    { lat: 25.0971, lng: 55.2019 },
    { lat: 25.1003, lng: 55.1912 },
    { lat: 25.1088, lng: 55.1925 },
  ],
};

export const ROUTE_NAMES = Object.keys(ROUTES);

/** Anything that moves a simulated phone: a route loop or a straight run to a target. */
export interface Mover {
  readonly speedMps: number;
  readonly position: LatLng & { headingDeg: number };
  advance(seconds: number): LatLng & { headingDeg: number };
}

/**
 * Walks back and forth along a polyline at a given speed. `advance` moves the walker and returns
 * its new position with heading, which is what a phone's GPS would report.
 */
export class RouteWalker implements Mover {
  private readonly points: LatLng[];
  private readonly lengths: number[];
  private readonly total: number;
  private travelled: number;

  constructor(
    points: readonly LatLng[],
    readonly speedMps: number,
    startFraction = 0,
  ) {
    if (points.length < 2) throw new Error('A route needs at least two points');
    // Out and back, so the walker never jumps from the last point to the first.
    this.points = [...points, ...[...points].reverse().slice(1)];
    this.lengths = this.points
      .slice(1)
      .map((point, i) => haversineMeters(this.points[i] ?? point, point));
    this.total = this.lengths.reduce((sum, length) => sum + length, 0);
    this.travelled = (startFraction % 1) * this.total;
  }

  get position(): LatLng & { headingDeg: number } {
    let remaining = this.travelled % this.total;
    for (let i = 0; i < this.lengths.length; i += 1) {
      const length = this.lengths[i] ?? 0;
      const from = this.points[i];
      const to = this.points[i + 1];
      if (!from || !to) break;
      if (remaining <= length || i === this.lengths.length - 1) {
        return {
          ...interpolate(from, to, length === 0 ? 0 : remaining / length),
          headingDeg: Math.round(bearingDegrees(from, to)),
        };
      }
      remaining -= length;
    }
    const first = this.points[0] as LatLng;
    return { ...first, headingDeg: 0 };
  }

  advance(seconds: number): LatLng & { headingDeg: number } {
    this.travelled += this.speedMps * seconds;
    return this.position;
  }
}

/** Drives straight towards a target and stops there (used to reach a pickup or drop-off). */
export class TargetWalker implements Mover {
  private current: LatLng;
  private heading = 0;

  constructor(
    from: LatLng,
    readonly target: LatLng,
    readonly speedMps: number,
  ) {
    this.current = from;
  }

  get position(): LatLng & { headingDeg: number } {
    return { ...this.current, headingDeg: this.heading };
  }

  get arrived(): boolean {
    return haversineMeters(this.current, this.target) < 1;
  }

  advance(seconds: number): LatLng & { headingDeg: number } {
    const remaining = haversineMeters(this.current, this.target);
    if (remaining >= 1) {
      this.heading = Math.round(bearingDegrees(this.current, this.target));
      this.current = interpolate(
        this.current,
        this.target,
        Math.min(1, (this.speedMps * seconds) / remaining),
      );
    }
    return this.position;
  }
}
