'use client';

import type { OutboxEntryDto, OutboxState } from '@dispatch/shared';
import { useEffect, useState } from 'react';
import { ApiRequestError, apiFetch } from '@/lib/api';
import { formatAge } from '@/lib/format';
import { useNow } from '@/lib/use-now';

/** Webhooks sent to the order system: what was delivered, what is pending and what failed. */
export function WebhooksPanel({ token }: { token: string }) {
  const [state, setState] = useState<OutboxState | 'all'>('all');
  const [entries, setEntries] = useState<OutboxEntryDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const now = useNow(5_000);

  // Reload when the filter changes, after a retry, and every 5 seconds (now changes).
  useEffect(() => {
    let active = true;
    const query = state === 'all' ? '' : `?state=${state}`;
    apiFetch<OutboxEntryDto[]>(`/v1/webhooks${query}`, { token }).then(
      (loaded) => {
        if (active) setEntries(loaded);
      },
      () => {
        if (active) setError('Webhooks could not be loaded.');
      },
    );
    return () => {
      active = false;
    };
  }, [state, token, version, now]);

  async function retry(id: string) {
    setError(null);
    try {
      await apiFetch(`/v1/webhooks/${id}/retry`, { token, body: {} });
      setVersion((v) => v + 1);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The event could not be sent again.',
      );
    }
  }

  return (
    <section aria-labelledby="webhooks-title">
      <h2 id="webhooks-title" className="visually-hidden">
        Webhooks
      </h2>
      <div className="filters" role="group" aria-label="Filter webhooks">
        {(['all', 'pending', 'delivered', 'failed'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={state === value}
            onClick={() => setState(value)}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {entries.length === 0 && <p className="muted">No events.</p>}
      <ul className="list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className={`dot outbox-${entry.state}`} aria-hidden="true" />
            <div>
              <strong>{entry.type}</strong>
              <div className="muted">
                {entry.state} · {entry.attempts} attempt{entry.attempts === 1 ? '' : 's'} ·{' '}
                {formatAge(entry.createdAt, now)}
                {entry.lastError && <> · {entry.lastError}</>}
              </div>
            </div>
            {entry.state === 'failed' && (
              <button type="button" onClick={() => void retry(entry.id)}>
                Send again
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
