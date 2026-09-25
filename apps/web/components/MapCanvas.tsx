'use client';

import {
  Map as MaplibreMap,
  NavigationControl,
  addProtocol,
  setRTLTextPlugin,
  setWorkerUrl,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { useEffect, useRef, useState } from 'react';
import { BASEMAP_URL, DUBAI_CENTRE } from '@/lib/config';
import { DEMO_STYLE_URL, absoluteUrl, protomapsStyle } from '@/lib/map-style';

let protocolRegistered = false;
let rtlPluginRequested = false;

function registerOnce(): void {
  if (!protocolRegistered) {
    // MapLibre's worker is served from public/vendor (scripts/copy-vendor.mjs).
    setWorkerUrl('/vendor/maplibre/maplibre-gl-worker.mjs');
    addProtocol('pmtiles', new Protocol().tile);
    protocolRegistered = true;
  }
  if (!rtlPluginRequested) {
    // Arabic labels need shaping; the plugin is served from this origin (public/vendor).
    rtlPluginRequested = true;
    void setRTLTextPlugin('/vendor/mapbox-gl-rtl-text.js', true).catch(() => undefined);
  }
}

/** Is the PMTiles extract on this server? A range request for its header is enough to know. */
async function basemapAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { range: 'bytes=0-126' } });
    return response.ok;
  } catch {
    return false;
  }
}

export type BasemapKind = 'protomaps' | 'demo';

interface MapCanvasProps {
  lang?: 'en' | 'ar';
  ariaLabel: string;
  className?: string;
  zoom?: number;
  onReady: (map: MaplibreMap, basemap: BasemapKind) => void;
}

/**
 * A MapLibre map in a div. It loads the Protomaps extract when the server has it, and otherwise
 * MapLibre's demo tiles (country outlines only), reporting which one it used.
 */
export function MapCanvas({
  lang = 'en',
  ariaLabel,
  className,
  zoom = 10.5,
  onReady,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);

  useEffect(() => {
    let map: MaplibreMap | undefined;
    let cancelled = false;
    registerOnce();
    void (async () => {
      const hasExtract = await basemapAvailable(BASEMAP_URL);
      if (cancelled || !container.current) return;
      const style: StyleSpecification | string = hasExtract
        ? protomapsStyle(absoluteUrl(BASEMAP_URL, window.location.origin), lang)
        : DEMO_STYLE_URL;
      let created: MaplibreMap;
      try {
        created = new MaplibreMap({
          container: container.current,
          style,
          center: DUBAI_CENTRE,
          zoom: hasExtract ? zoom : 6,
          attributionControl: { compact: true },
        });
      } catch {
        setFailed(true);
        return;
      }
      map = created;
      created.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      created.once('load', () => {
        if (cancelled) return;
        setLoaded(true);
        ready.current(created, hasExtract ? 'protomaps' : 'demo');
      });
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [lang, zoom]);

  return (
    <div
      className={className}
      role="region"
      aria-label={ariaLabel}
      data-map-ready={loaded ? 'true' : undefined}
    >
      {failed ? (
        <p className="map-error">
          The map could not be started in this browser (WebGL is required).
        </p>
      ) : (
        <div ref={container} className="map-canvas" />
      )}
    </div>
  );
}
