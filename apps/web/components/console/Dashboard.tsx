'use client';

import type { DeliveryDto, DispatcherDto, DriverDto, LatLng } from '@dispatch/shared';
import { useCallback, useMemo, useReducer, useState } from 'react';
import type { BasemapKind } from '@/components/MapCanvas';
import { apiFetch } from '@/lib/api';
import { consoleReducer, initialConsoleState } from '@/lib/console-state';
import { DELIVERY_STATUS_LABEL } from '@/lib/format';
import { useDispatchFeed } from '@/lib/use-dispatch-feed';
import { ConsoleMap } from './ConsoleMap';
import { DeliveryPanel } from './DeliveryPanel';
import { DriversPanel } from './DriversPanel';
import { NewDeliveryForm } from './NewDeliveryForm';
import { WebhooksPanel } from './WebhooksPanel';

type Tab = 'deliveries' | 'drivers' | 'webhooks';
type DeliveryFilter = 'open' | 'delivered' | 'all';

interface DashboardProps {
  token: string;
  dispatcher: DispatcherDto;
  onSignOut: () => void;
}

export function Dashboard({ token, dispatcher, onSignOut }: DashboardProps) {
  const [state, dispatch] = useReducer(consoleReducer, initialConsoleState);
  const [tab, setTab] = useState<Tab>('deliveries');
  const [filter, setFilter] = useState<DeliveryFilter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState<{ pickup: LatLng | null; dropoff: LatLng | null }>({
    pickup: null,
    dropoff: null,
  });
  const [basemap, setBasemap] = useState<BasemapKind | null>(null);

  // Drivers and deliveries are loaded on every connection of the live feed (the first, and after
  // each reconnect), so changes made while the console was disconnected are not missed.
  const loadSnapshot = useCallback(
    async (signal: AbortSignal) => {
      const [drivers, deliveries] = await Promise.all([
        apiFetch<DriverDto[]>('/v1/drivers', { token, signal }),
        apiFetch<DeliveryDto[]>('/v1/deliveries?limit=200', { token, signal }),
      ]);
      return { drivers, deliveries };
    },
    [token],
  );
  useDispatchFeed(token, dispatch, loadSnapshot, onSignOut);

  const drivers = useMemo(() => Object.values(state.drivers), [state.drivers]);
  // Deactivated drivers stay in the Drivers tab (their deliveries name them) but leave the map.
  const activeDrivers = useMemo(() => drivers.filter((d) => d.deactivatedAt === null), [drivers]);
  const deliveries = useMemo(
    () =>
      Object.values(state.deliveries)
        .filter((d) =>
          filter === 'all'
            ? true
            : filter === 'delivered'
              ? d.status === 'delivered'
              : d.status === 'pending' || d.status === 'assigned' || d.status === 'picked_up',
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.deliveries, filter],
  );
  const selected = selectedId ? (state.deliveries[selectedId] ?? null) : null;
  const counts = useMemo(() => {
    const byStatus = { available: 0, busy: 0, offline: 0 };
    for (const driver of activeDrivers) byStatus[driver.status] += 1;
    return byStatus;
  }, [activeDrivers]);

  const pick = useCallback((point: LatLng) => {
    setDraft((current) =>
      !current.pickup || current.dropoff
        ? { pickup: point, dropoff: null }
        : { ...current, dropoff: point },
    );
  }, []);

  const startNewDelivery = () => {
    setSelectedId(null);
    setDraft({ pickup: null, dropoff: null });
    setPlacing(true);
  };

  const connectionLabel =
    state.connection === 'live'
      ? 'Live'
      : state.connection === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…';

  return (
    <div className="console">
      <header className="topbar">
        <h1>dispatch</h1>
        <p className={`connection ${state.connection}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" /> {connectionLabel}
          {state.lastResume && state.lastResume.events > 0 && (
            <span className="muted">
              {' '}
              · caught up on {state.lastResume.events} missed positions
            </span>
          )}
        </p>
        <p className="fleet muted">
          {counts.available} available · {counts.busy} on a delivery · {counts.offline} off shift
        </p>
        <p className="who">
          {dispatcher.name}{' '}
          <button type="button" className="ghost" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </header>

      <nav className="sidebar" aria-label="Console">
        <div className="tabs" role="tablist">
          {(['deliveries', 'drivers', 'webhooks'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value[0]?.toUpperCase()}
              {value.slice(1)}
            </button>
          ))}
        </div>
        {state.loadError && (
          <p className="error" role="alert">
            {state.loadError}
          </p>
        )}
        {tab === 'deliveries' && (
          <section aria-label="Deliveries">
            <div className="section-title">
              <div className="filters" role="group" aria-label="Filter deliveries">
                {(['open', 'delivered', 'all'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </button>
                ))}
              </div>
              <button type="button" className="primary" onClick={startNewDelivery}>
                New delivery
              </button>
            </div>
            {deliveries.length === 0 && <p className="muted">No deliveries here yet.</p>}
            <ul className="list deliveries">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className={`row ${delivery.id === selectedId ? 'selected' : ''}`}
                    onClick={() => {
                      setPlacing(false);
                      setSelectedId(delivery.id);
                    }}
                  >
                    <strong>{delivery.orderReference}</strong>
                    <span className={`badge status-${delivery.status}`}>
                      {DELIVERY_STATUS_LABEL[delivery.status]}
                    </span>
                    <span className="muted">
                      {delivery.recipientName}
                      {delivery.driver ? ` · ${delivery.driver.name}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {tab === 'drivers' && (
          <DriversPanel
            drivers={drivers}
            token={token}
            onChanged={(driver) => dispatch({ type: 'driver/upserted', driver })}
          />
        )}
        {tab === 'webhooks' && <WebhooksPanel token={token} />}
      </nav>

      <main className="map-area">
        <ConsoleMap
          drivers={activeDrivers}
          selected={selected}
          placing={placing}
          draft={draft}
          onPick={pick}
          onBasemap={setBasemap}
        />
        {basemap === 'demo' && (
          <p className="map-notice" role="note">
            Street map not installed: showing MapLibre demo tiles. Run scripts/fetch-basemap.sh for
            the Dubai extract.
          </p>
        )}
        <div className="legend" aria-hidden="true">
          <span>
            <span className="dot driver-available" /> Available
          </span>
          <span>
            <span className="dot driver-busy" /> On a delivery
          </span>
          <span>
            <span className="dot pickup" /> Pickup
          </span>
          <span>
            <span className="dot dropoff" /> Drop-off
          </span>
        </div>
      </main>

      {placing && (
        <NewDeliveryForm
          token={token}
          draft={draft}
          onCancel={() => {
            setPlacing(false);
            setDraft({ pickup: null, dropoff: null });
          }}
          onCreated={(delivery) => {
            dispatch({ type: 'delivery/updated', delivery });
            setPlacing(false);
            setDraft({ pickup: null, dropoff: null });
            setSelectedId(delivery.id);
          }}
        />
      )}
      {selected && !placing && (
        <DeliveryPanel
          key={selected.id}
          delivery={selected}
          token={token}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
