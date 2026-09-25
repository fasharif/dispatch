'use client';

import type { DeliveryDto, LatLng } from '@dispatch/shared';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '@/lib/api';

interface NewDeliveryFormProps {
  token: string;
  draft: { pickup: LatLng | null; dropoff: LatLng | null };
  onCreated: (delivery: DeliveryDto) => void;
  onCancel: () => void;
}

const coordinates = (point: LatLng | null) =>
  point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : 'click the map';

/** A delivery for an order: pickup and drop-off are chosen by clicking the map. */
export function NewDeliveryForm({ token, draft, onCreated, onCancel }: NewDeliveryFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.pickup || !draft.dropoff) {
      setError('Click the map to place the pickup point, then the drop-off point.');
      return;
    }
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<DeliveryDto>('/v1/deliveries', {
        token,
        body: {
          orderReference: text('orderReference'),
          recipientName: text('recipientName'),
          recipientPhone: text('recipientPhone'),
          address: text('address'),
          notes: text('notes'),
          pickup: draft.pickup,
          dropoff: draft.dropoff,
          autoAssign: form.get('autoAssign') === 'on',
        },
      });
      onCreated(created);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The delivery could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="panel new-delivery"
      onSubmit={(event) => void submit(event)}
      aria-labelledby="new-delivery-title"
    >
      <h2 id="new-delivery-title">New delivery</h2>
      <p className="muted">
        Click the map once for the pickup point and again for the drop-off point.
      </p>
      <p>
        <span className="dot pickup" aria-hidden="true" /> Pickup: {coordinates(draft.pickup)}
      </p>
      <p>
        <span className="dot dropoff" aria-hidden="true" /> Drop-off: {coordinates(draft.dropoff)}
      </p>
      <label>
        Order reference
        <input name="orderReference" required maxLength={64} placeholder="TF-SO-2026-000123" />
      </label>
      <label>
        Recipient
        <input name="recipientName" required maxLength={120} />
      </label>
      <label>
        Phone
        <input name="recipientPhone" type="tel" maxLength={20} placeholder="+971 50 123 4567" />
      </label>
      <label>
        Address
        <input name="address" required minLength={3} maxLength={300} />
      </label>
      <label>
        Notes
        <textarea name="notes" maxLength={500} rows={2} />
      </label>
      <label className="checkbox">
        <input name="autoAssign" type="checkbox" defaultChecked /> Assign the nearest free driver
        now
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          Create delivery
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
