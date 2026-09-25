import { Injectable, Logger } from '@nestjs/common';
import { straightLineEta, type EtaEstimate, type LatLng } from '@dispatch/shared';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

interface OsrmRouteResponse {
  code: string;
  routes?: { duration: number; distance: number }[];
}

interface OsrmTableResponse {
  code: string;
  durations?: (number | null)[][];
  distances?: (number | null)[][];
}

/**
 * Travel-time estimates. With OSRM_URL set, the road network decides (OSRM route and table
 * services, driving profile). Without it, or when OSRM is slow or down, a straight-line
 * estimate is used: haversine distance × detour factor ÷ average speed (see
 * docs/decisions.md, ADR-008). Every estimate says which method produced it.
 */
@Injectable()
export class EtaService {
  private readonly logger = new Logger(EtaService.name);
  private lastWarning = 0;

  constructor(@InjectConfig() private readonly config: AppConfig) {}

  get routingEnabled(): boolean {
    return this.config.eta.osrmUrl !== undefined;
  }

  straightLine(from: LatLng, to: LatLng): EtaEstimate {
    return straightLineEta(from, to, {
      speedKmh: this.config.eta.speedKmh,
      detourFactor: this.config.eta.detourFactor,
    });
  }

  async estimate(from: LatLng, to: LatLng): Promise<EtaEstimate> {
    if (!this.config.eta.osrmUrl) return this.straightLine(from, to);
    const url =
      `${this.config.eta.osrmUrl}/route/v1/driving/${coordinates([from, to])}` +
      '?overview=false&alternatives=false&steps=false';
    try {
      const body = await this.fetchJson<OsrmRouteResponse>(url);
      const route = body.code === 'Ok' ? body.routes?.[0] : undefined;
      if (!route) throw new Error(`OSRM answered ${body.code}`);
      return {
        seconds: Math.round(route.duration),
        distanceMeters: Math.round(route.distance),
        source: 'osrm',
      };
    } catch (error) {
      this.warn(error);
      return this.straightLine(from, to);
    }
  }

  /** Estimates from several origins to one destination in a single OSRM table request. */
  async estimateMany(origins: readonly LatLng[], to: LatLng): Promise<EtaEstimate[]> {
    if (origins.length === 0) return [];
    if (!this.config.eta.osrmUrl) return origins.map((from) => this.straightLine(from, to));
    const sources = origins.map((_, index) => index).join(';');
    const url =
      `${this.config.eta.osrmUrl}/table/v1/driving/${coordinates([...origins, to])}` +
      `?sources=${sources}&destinations=${String(origins.length)}&annotations=duration,distance`;
    try {
      const body = await this.fetchJson<OsrmTableResponse>(url);
      if (body.code !== 'Ok' || !body.durations) throw new Error(`OSRM answered ${body.code}`);
      return origins.map((from, index) => {
        const seconds = body.durations?.[index]?.[0];
        const meters = body.distances?.[index]?.[0];
        // null means OSRM found no route (for example an origin off the road network).
        if (seconds === null || seconds === undefined) return this.straightLine(from, to);
        return {
          seconds: Math.round(seconds),
          distanceMeters: Math.round(meters ?? this.straightLine(from, to).distanceMeters),
          source: 'osrm' as const,
        };
      });
    } catch (error) {
      this.warn(error);
      return origins.map((from) => this.straightLine(from, to));
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.config.eta.osrmTimeoutMs),
    });
    if (!response.ok && response.status !== 400) {
      throw new Error(`OSRM responded with HTTP ${String(response.status)}`);
    }
    return (await response.json()) as T;
  }

  private warn(error: unknown): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      `OSRM unavailable, using straight-line ETAs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function coordinates(points: readonly LatLng[]): string {
  return points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}
