'use client';

import {
  TRACKING_NAMESPACE,
  type TrackingClientToServerEvents,
  type TrackingResponse,
  type TrackingServerToClientEvents,
  type TrackingView,
} from '@dispatch/shared';
import type { Feature, FeatureCollection } from 'geojson';
import { LngLatBounds, type GeoJSONSource, type Map as MaplibreMap } from 'maplibre-gl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { MapCanvas } from '@/components/MapCanvas';
import { ApiRequestError, apiFetch } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { LOCALE_COOKIE, MESSAGES, fill, formatDuration, formatTime, type Locale } from '@/lib/i18n';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; reason: 'expired' | 'invalid' | 'failed' }
  | { kind: 'ready'; view: TrackingView; linkExpiresAt: string };

const STEPS = ['assigned', 'picked_up', 'delivered'] as const;

function stepIndex(status: TrackingView['status']): number {
  if (status === 'delivered') return 2;
  if (status === 'picked_up') return 1;
  if (status === 'assigned') return 0;
  return -1;
}

function features(view: TrackingView): FeatureCollection {
  const list: Feature[] = [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [view.dropoff.lng, view.dropoff.lat] },
      properties: { role: 'dropoff' },
    },
  ];
  const position = view.driver?.position;
  if (position) {
    list.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [position.lng, position.lat] },
      properties: { role: 'driver' },
    });
  }
  return { type: 'FeatureCollection', features: list };
}

/** The customer's view of one delivery, live, in English or Arabic. */
export function TrackingPage({ token, locale }: { token: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [connected, setConnected] = useState(false);
  const [map, setMap] = useState<MaplibreMap | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<TrackingResponse>(`/v1/tracking/${encodeURIComponent(token)}`, {
      signal: controller.signal,
    })
      .then(({ linkExpiresAt, ...view }) => {
        setState({ kind: 'ready', view, linkExpiresAt });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const status = error instanceof ApiRequestError ? error.status : 0;
        setState({
          kind: 'error',
          reason: status === 410 ? 'expired' : status === 404 ? 'invalid' : 'failed',
        });
      });
    return () => {
      controller.abort();
    };
  }, [token]);

  const ready = state.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    const socket: Socket<TrackingServerToClientEvents, TrackingClientToServerEvents> = io(
      `${API_URL}${TRACKING_NAMESPACE}`,
      { transports: ['websocket'], auth: { token } },
    );
    socket.on('connect', () => {
      setConnected(true);
    });
    socket.on('disconnect', () => {
      setConnected(false);
    });
    socket.on('tracking:update', (view) => {
      setState((current) => (current.kind === 'ready' ? { ...current, view } : current));
    });
    return () => {
      socket.close();
    };
  }, [ready, token]);

  const view = state.kind === 'ready' ? state.view : null;

  const onReady = useCallback((created: MaplibreMap) => {
    created.addSource('tracking', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    created.addLayer({
      id: 'tracking-points',
      type: 'circle',
      source: 'tracking',
      paint: {
        'circle-radius': ['match', ['get', 'role'], 'driver', 9, 11],
        'circle-color': ['match', ['get', 'role'], 'driver', '#0b57d0', '#d1242f'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    });
    setMap(created);
  }, []);

  useEffect(() => {
    if (!map || !view) return;
    (map.getSource('tracking') as GeoJSONSource | undefined)?.setData(features(view));
    const bounds = new LngLatBounds().extend([view.dropoff.lng, view.dropoff.lat]);
    if (view.driver?.position) bounds.extend([view.driver.position.lng, view.driver.position.lat]);
    map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 500 });
  }, [map, view]);

  const switchLanguage = () => {
    const next: Locale = locale === 'ar' ? 'en' : 'ar';
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };

  return (
    <div className="tracking">
      <header className="tracking-header">
        <div>
          <p className="brand">dispatch</p>
          <h1>{t.title}</h1>
        </div>
        <button
          type="button"
          className="language"
          onClick={switchLanguage}
          lang={locale === 'ar' ? 'en' : 'ar'}
        >
          {t.switchTo}
        </button>
      </header>

      {state.kind === 'loading' && <p className="card">{t.loading}</p>}
      {state.kind === 'error' && (
        <p className="card error" role="alert">
          {state.reason === 'expired'
            ? t.expired
            : state.reason === 'invalid'
              ? t.invalid
              : t.failedToLoad}
        </p>
      )}

      {view && (
        <>
          <section className="card status-card" aria-live="polite">
            <p className="muted">
              {t.order} <bdi>{view.orderReference}</bdi>
            </p>
            <h2>{t.status[view.status]}</h2>
            {view.eta && view.status === 'picked_up' && (
              <p className="eta">
                {fill(t.arriving, { duration: formatDuration(view.eta.seconds, locale) })}{' '}
                <span className="muted">
                  ({fill(t.around, { time: formatTime(view.eta.arrivalAt, locale) })})
                </span>
                <br />
                <small className="muted">
                  {view.eta.source === 'osrm' ? t.sourceOsrm : t.sourceStraight}
                </small>
              </p>
            )}
            {view.status === 'delivered' && view.completedAt && (
              <p>{fill(t.deliveredAt, { time: formatTime(view.completedAt, locale) })}</p>
            )}
            {view.driver && (
              <p>
                {t.driver}: <strong>{view.driver.firstName}</strong>
              </p>
            )}
            {view.status === 'assigned' && <p className="muted">{t.positionLater}</p>}
            <ol className="steps">
              {STEPS.map((step, index) => (
                <li key={step} className={index <= stepIndex(view.status) ? 'done' : ''}>
                  {t.steps[step]}
                </li>
              ))}
            </ol>
            <p className="muted small">
              <span className={`dot ${connected ? 'live' : ''}`} aria-hidden="true" />{' '}
              {connected ? t.live : t.reconnecting}
              {view.driver?.positionAt && (
                <> · {fill(t.updated, { time: formatTime(view.driver.positionAt, locale) })}</>
              )}
            </p>
          </section>
          <MapCanvas
            className="tracking-map"
            lang={locale}
            zoom={13}
            ariaLabel={t.mapLabel}
            onReady={onReady}
          />
        </>
      )}
      <footer className="muted small">{t.footer}</footer>
    </div>
  );
}
