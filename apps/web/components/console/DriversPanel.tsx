'use client';

import type { DriverDto, EnrolmentCodeDto } from '@dispatch/shared';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '@/lib/api';
import { isStale } from '@/lib/console-state';
import { DRIVER_STATUS_LABEL, formatAge } from '@/lib/format';
import { useNow } from '@/lib/use-now';

interface DriversPanelProps {
  drivers: DriverDto[];
  token: string;
  onCreated: (driver: DriverDto) => void;
}

/** The fleet, and enrolment of new drivers' phones with one-time codes. */
export function DriversPanel({ drivers, token, onCreated }: DriversPanelProps) {
  const [code, setCode] = useState<{ name: string; enrolment: EnrolmentCodeDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  async function addDriver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setError(null);
    try {
      const created = await apiFetch<{ driver: DriverDto; enrolment: EnrolmentCodeDto }>(
        '/v1/drivers',
        {
          token,
          body: { name: form.get('name'), vehicle: form.get('vehicle') || undefined },
        },
      );
      onCreated(created.driver);
      setCode({ name: created.driver.name, enrolment: created.enrolment });
      formElement.reset();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'The driver could not be added.',
      );
    }
  }

  const sorted = [...drivers].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section aria-labelledby="drivers-title">
      <h2 id="drivers-title" className="visually-hidden">
        Drivers
      </h2>
      <form className="inline-form" onSubmit={(event) => void addDriver(event)}>
        <input
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Driver name"
          aria-label="Driver name"
        />
        <input name="vehicle" maxLength={60} placeholder="Vehicle" aria-label="Vehicle" />
        <button type="submit">Add</button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {code && (
        <p className="notice" role="status">
          Enrolment code for {code.name}: <strong className="code">{code.enrolment.code}</strong>.
          It works once, until{' '}
          {new Date(code.enrolment.expiresAt).toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          .
        </p>
      )}
      <ul className="list">
        {sorted.map((driver) => (
          <li key={driver.id}>
            <span className={`dot driver-${driver.status}`} aria-hidden="true" />
            <div>
              <strong>{driver.name}</strong>
              <div className="muted">
                {DRIVER_STATUS_LABEL[driver.status]}
                {driver.position
                  ? ` · last fix ${formatAge(driver.position.recordedAt, now)}${isStale(driver, now) ? ' (stale)' : ''}`
                  : ' · no fix yet'}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
