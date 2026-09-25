import { layers, namedFlavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';

/** MapLibre's public demo style: country outlines only, used when no extract is available. */
export const DEMO_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

export const PROTOMAPS_ATTRIBUTION =
  '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * The Protomaps "light" basemap over a local PMTiles extract. Labels follow the page language
 * (Arabic names on the Arabic tracking page). Fonts and sprites come from the Protomaps assets
 * repository.
 */
export function protomapsStyle(pmtilesUrl: string, lang: 'en' | 'ar'): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: PROTOMAPS_ATTRIBUTION,
      },
    },
    layers: layers('protomaps', namedFlavor('light'), { lang }),
  };
}

/** An absolute URL for the pmtiles protocol, which cannot resolve paths against the page. */
export function absoluteUrl(url: string, origin: string): string {
  return /^https?:\/\//.test(url) ? url : new URL(url, origin).toString();
}
