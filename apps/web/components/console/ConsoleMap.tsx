'use client';

import type { DeliveryDto, DriverDto, LatLng } from '@dispatch/shared';
import type { Feature, FeatureCollection } from 'geojson';
import { LngLatBounds, Popup, type GeoJSONSource, type Map as MaplibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MapCanvas, type BasemapKind } from '@/components/MapCanvas';
import { isStale } from '@/lib/console-state';
import { DRIVER_STATUS_LABEL } from '@/lib/format';

interface ConsoleMapProps {
  drivers: DriverDto[];
  selected: DeliveryDto | null;
  /** While placing a new delivery, map clicks pick points instead of selecting drivers. */
  placing: boolean;
  draft: { pickup: LatLng | null; dropoff: LatLng | null };
  onPick: (point: LatLng) => void;
  onBasemap: (kind: BasemapKind) => void;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function driverFeatures(drivers: DriverDto[], now: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: drivers
      .filter((driver) => driver.position)
      .map((driver) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [driver.position?.lng ?? 0, driver.position?.lat ?? 0],
        },
        properties: {
          id: driver.id,
          name: driver.name,
          status: driver.status,
          stale: isStale(driver, now),
        },
      })),
  };
}

function selectionFeatures(
  selected: DeliveryDto | null,
  drivers: DriverDto[],
  draft: ConsoleMapProps['draft'],
): FeatureCollection {
  const features: Feature[] = [];
  const point = (p: LatLng, role: string): Feature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: { role },
  });
  if (draft.pickup) features.push(point(draft.pickup, 'pickup'));
  if (draft.dropoff) features.push(point(draft.dropoff, 'dropoff'));
  if (selected) {
    features.push(point(selected.pickup, 'pickup'), point(selected.dropoff, 'dropoff'));
    const driver = drivers.find((d) => d.id === selected.driver?.id);
    const target =
      selected.status === 'assigned'
        ? selected.pickup
        : selected.status === 'picked_up'
          ? selected.dropoff
          : null;
    if (driver?.position && target) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [driver.position.lng, driver.position.lat],
            [target.lng, target.lat],
          ],
        },
        properties: { role: 'route' },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Driver markers coloured by status, the selected delivery and its driver's straight line to go. */
export function ConsoleMap({
  drivers,
  selected,
  placing,
  draft,
  onPick,
  onBasemap,
}: ConsoleMapProps) {
  const [map, setMap] = useState<MaplibreMap | null>(null);
  const placingRef = useRef(placing);
  const pickRef = useRef(onPick);
  const popup = useRef<Popup | null>(null);

  useEffect(() => {
    placingRef.current = placing;
    pickRef.current = onPick;
  }, [placing, onPick]);

  const handleReady = useCallback(
    (created: MaplibreMap, kind: BasemapKind) => {
      onBasemap(kind);
      created.addSource('selection', { type: 'geojson', data: EMPTY });
      created.addSource('drivers', { type: 'geojson', data: EMPTY });
      created.addLayer({
        id: 'selection-route',
        type: 'line',
        source: 'selection',
        filter: ['==', ['get', 'role'], 'route'],
        paint: { 'line-color': '#0b57d0', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      created.addLayer({
        id: 'selection-points',
        type: 'circle',
        source: 'selection',
        filter: ['!=', ['get', 'role'], 'route'],
        paint: {
          'circle-radius': 9,
          'circle-color': ['match', ['get', 'role'], 'pickup', '#6f42c1', '#d1242f'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      });
      created.addLayer({
        id: 'drivers',
        type: 'circle',
        source: 'drivers',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 7, 16, 10],
          'circle-color': [
            'match',
            ['get', 'status'],
            'available',
            '#1a7f37',
            'busy',
            '#bc4c00',
            '#6e7781',
          ],
          'circle-opacity': ['case', ['get', 'stale'], 0.35, 0.95],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      created.on('click', (event) => {
        if (placingRef.current) {
          pickRef.current({
            lat: Number(event.lngLat.lat.toFixed(6)),
            lng: Number(event.lngLat.lng.toFixed(6)),
          });
          return;
        }
        const [feature] = created.queryRenderedFeatures(event.point, { layers: ['drivers'] });
        const props = feature?.properties as
          { name?: string; status?: keyof typeof DRIVER_STATUS_LABEL } | undefined;
        if (!feature || !props?.name || !props.status) return;
        popup.current?.remove();
        const content = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = props.name;
        content.append(name, document.createElement('br'), DRIVER_STATUS_LABEL[props.status]);
        popup.current = new Popup({ closeButton: false })
          .setLngLat(event.lngLat)
          .setDOMContent(content)
          .addTo(created);
      });
      created.on('mouseenter', 'drivers', () => {
        created.getCanvas().style.cursor = 'pointer';
      });
      created.on('mouseleave', 'drivers', () => {
        created.getCanvas().style.cursor = '';
      });
      setMap(created);
    },
    [onBasemap],
  );

  useEffect(() => {
    (map?.getSource('drivers') as GeoJSONSource | undefined)?.setData(
      driverFeatures(drivers, Date.now()),
    );
  }, [map, drivers]);

  useEffect(() => {
    (map?.getSource('selection') as GeoJSONSource | undefined)?.setData(
      selectionFeatures(selected, drivers, draft),
    );
  }, [map, selected, drivers, draft]);

  useEffect(() => {
    if (map) map.getCanvas().style.cursor = placing ? 'crosshair' : '';
  }, [map, placing]);

  // Centre on a delivery when it is selected, not on every update it receives afterwards.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!map || !selected || fitted.current === selected.id) return;
    fitted.current = selected.id;
    const bounds = new LngLatBounds()
      .extend([selected.pickup.lng, selected.pickup.lat])
      .extend([selected.dropoff.lng, selected.dropoff.lat]);
    // The details panel covers the right-hand side of the map.
    map.fitBounds(bounds, {
      padding: { top: 80, bottom: 80, left: 80, right: 460 },
      maxZoom: 14,
      duration: 600,
    });
  }, [map, selected]);

  return (
    <MapCanvas
      className="console-map"
      ariaLabel="Live map of drivers and deliveries"
      onReady={handleReady}
    />
  );
}
