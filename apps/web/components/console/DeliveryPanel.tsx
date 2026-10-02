'use client';

import type {
  CandidateDto,
  DeliveryDetailDto,
  DeliveryDto,
  TrackingLinkDto,
} from '@dispatch/shared';
import { useEffect, useState } from 'react';
import { ApiRequestError, apiBlobUrl, apiFetch } from '@/lib/api';
import {
  DELIVERY_STATUS_LABEL,
  formatAge,
  formatDistance,
  formatShortDuration,
} from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { Signature } from './Signature';

interface DeliveryPanelProps {
  delivery: DeliveryDto;
  token: string;
  onClose: () => void;
}

/** Everything about one delivery: nearest drivers, assignment, tracking link and proof. */
export function DeliveryPanel({ delivery, token, onClose }: DeliveryPanelProps) {
  const [detail, setDetail] = useState<DeliveryDetailDto | null>(null);
  const [candidates, setCandidates] = useState<CandidateDto[] | null>(null);
  const [link, setLink] = useState<TrackingLinkDto | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const now = useNow();
  const assignable = delivery.status === 'pending' || delivery.status === 'assigned';

  // Reload the timeline and the nearest drivers whenever the delivery changes state or driver.
  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch<DeliveryDetailDto>(`/v1/deliveries/${delivery.id}`, { token }),
      assignable
        ? apiFetch<CandidateDto[]>(`/v1/deliveries/${delivery.id}/candidates?limit=5`, { token })
        : Promise.resolve(null),
    ]).then(
      ([nextDetail, nextCandidates]) => {
        if (!active) return;
        setDetail(nextDetail);
        setCandidates(nextCandidates);
      },
      () => {
        if (active) setMessage({ kind: 'error', text: 'Could not load this delivery.' });
      },
    );
    return () => {
      active = false;
    };
  }, [delivery.id, delivery.status, delivery.driver?.id, assignable, token]);

  useEffect(() => {
    if (!delivery.proof) return;
    let url: string | null = null;
    apiBlobUrl(`/v1/deliveries/${delivery.id}/proof/photo`, token)
      .then((created) => {
        url = created;
        setPhoto(created);
      })
      .catch(() => {
        setPhoto(null);
      });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [delivery.id, delivery.proof, token]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'info', text: success });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof ApiRequestError ? error.message : 'Something went wrong.',
      });
    } finally {
      setBusy(false);
    }
  }

  const assign = (driverId?: string) =>
    act(
      () =>
        apiFetch(`/v1/deliveries/${delivery.id}/assign`, {
          token,
          body: driverId ? { driverId } : {},
        }),
      driverId ? 'Driver assigned (manual override).' : 'Nearest free driver assigned.',
    );

  const cancel = () => {
    const reason = window.prompt('Why is this delivery cancelled?');
    if (!reason) return;
    void act(
      () => apiFetch(`/v1/deliveries/${delivery.id}/cancel`, { token, body: { reason } }),
      'Delivery cancelled.',
    );
  };

  const createLink = () =>
    act(async () => {
      const created = await apiFetch<TrackingLinkDto>(
        `/v1/deliveries/${delivery.id}/tracking-link`,
        { token, body: {} },
      );
      setLink(created);
      await navigator.clipboard?.writeText(created.url).catch(() => undefined);
    }, 'Tracking link created and copied.');

  return (
    <aside className="panel detail" aria-labelledby="delivery-title">
      <header className="panel-header">
        <div>
          <h2 id="delivery-title">{delivery.orderReference}</h2>
          <span className={`badge status-${delivery.status}`}>
            {DELIVERY_STATUS_LABEL[delivery.status]}
          </span>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={onClose}
          aria-label="Close delivery details"
        >
          ×
        </button>
      </header>

      <dl className="facts">
        <dt>Recipient</dt>
        <dd>
          {delivery.recipientName}
          {delivery.recipientPhone && <span className="muted"> · {delivery.recipientPhone}</span>}
        </dd>
        <dt>Address</dt>
        <dd>{delivery.address}</dd>
        <dt>Driver</dt>
        <dd>
          {delivery.driver?.name ?? '—'}
          {delivery.assignmentMode && (
            <span className="muted">
              {' '}
              ({delivery.assignmentMode === 'auto' ? 'nearest' : 'chosen'})
            </span>
          )}
        </dd>
        {delivery.failureReason && (
          <>
            <dt>Reason</dt>
            <dd>{delivery.failureReason}</dd>
          </>
        )}
      </dl>

      {message && (
        <p
          className={message.kind === 'error' ? 'error' : 'notice'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}

      {assignable && (
        <section aria-labelledby="candidates-title">
          <div className="section-title">
            <h3 id="candidates-title">Nearest free drivers</h3>
            <button type="button" className="primary" disabled={busy} onClick={() => void assign()}>
              Assign nearest
            </button>
          </div>
          {candidates && candidates.length === 0 && (
            <p className="muted">No driver is available right now.</p>
          )}
          <ol className="candidates">
            {candidates?.map((candidate) => (
              <li key={candidate.driverId}>
                <div>
                  <strong>{candidate.name}</strong>
                  {candidate.stale && <span className="badge stale">no recent fix</span>}
                  <div className="muted">
                    {formatDistance(candidate.distanceMeters)} away ·{' '}
                    {formatShortDuration(candidate.eta.seconds)} to pickup
                    {candidate.eta.source === 'straight_line' ? ' (straight-line estimate)' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy || candidate.driverId === delivery.driver?.id}
                  onClick={() => void assign(candidate.driverId)}
                >
                  {candidate.driverId === delivery.driver?.id ? 'Assigned' : 'Assign'}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {delivery.status !== 'cancelled' && delivery.status !== 'failed' && (
        <section aria-labelledby="tracking-title">
          <div className="section-title">
            <h3 id="tracking-title">Customer tracking link</h3>
            <button type="button" disabled={busy} onClick={() => void createLink()}>
              Create link
            </button>
          </div>
          {link && (
            <p className="link-box">
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.url}
              </a>
              <span className="muted">
                {' '}
                Expires {new Date(link.expiresAt).toLocaleString('en-GB')}
              </span>
            </p>
          )}
        </section>
      )}

      {delivery.proof && (
        <section aria-labelledby="proof-title">
          <h3 id="proof-title">Proof of delivery</h3>
          <p>
            Signed by <strong>{delivery.proof.recipientName}</strong>,{' '}
            {formatDistance(delivery.proof.distanceMeters)} from the drop-off point (geofence{' '}
            {formatDistance(delivery.proof.geofenceRadiusMeters)}):{' '}
            <span className={delivery.proof.withinGeofence ? 'ok' : 'error'}>
              {delivery.proof.withinGeofence ? 'inside' : 'outside'}
            </span>
          </p>
          <div className="proof">
            {photo && (
              // An object URL from an authenticated fetch, which next/image cannot load.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo}
                alt={`Photo of the delivered parcel for ${delivery.orderReference}`}
              />
            )}
            <Signature
              signature={delivery.proof.signature}
              label={`Signature of ${delivery.proof.recipientName}`}
            />
          </div>
        </section>
      )}

      {detail && (
        <section aria-labelledby="timeline-title">
          <h3 id="timeline-title">Timeline</h3>
          <ol className="timeline">
            {detail.events.map((event) => (
              <li key={event.id}>
                <span className="muted">{formatAge(event.createdAt, now)}</span>{' '}
                {DELIVERY_STATUS_LABEL[event.toStatus]}
                {event.note && <span className="muted"> · {event.note}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {(delivery.status === 'pending' ||
        delivery.status === 'assigned' ||
        delivery.status === 'picked_up') && (
        <button type="button" className="danger" disabled={busy} onClick={cancel}>
          Cancel delivery
        </button>
      )}
    </aside>
  );
}
