/**
 * Where the browser reaches the API and its WebSockets. An empty value means the same origin as
 * the page (the compose stack serves both behind nginx).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:57100').replace(
  /\/+$/,
  '',
);

/** The Protomaps extract. When it cannot be loaded the map falls back to MapLibre's demo tiles. */
export const BASEMAP_URL = process.env.NEXT_PUBLIC_BASEMAP_URL ?? '/tiles/dubai.pmtiles';

/** The map opens on Dubai. */
export const DUBAI_CENTRE: [number, number] = [55.25, 25.16];
