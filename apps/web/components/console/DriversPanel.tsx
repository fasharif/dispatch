'use client';

import type { DeviceDto, DriverDto, EnrolmentCodeDto } from '@dispatch/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '@/lib/api';
import { isStale } from '@/lib/console-state';
import { DRIVER_STATUS_LABEL, formatAge } from '@/lib/format';
import { useNow } from '@/lib/use-now';

interface DriversPanelProps {
  drivers: DriverDto[];
  token: string;
  /** A driver was added or changed here (created, deactivated). */
  onChanged: (driver: DriverDto) => void;
}

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof ApiRequestError ? caught.message : fallback;

const shortTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * The fleet: enrolment of new drivers' phones with one-time codes, and for each driver the phones
 * they use, so a lost or stolen one can be revoked and a driver who has left deactivated.
 */
export function DriversPanel({ drivers, token, onChanged }: DriversPanelProps) {
  const [code, setCode] = useState<{ name: string; enrolment: EnrolmentCodeDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
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
      onChanged(created.driver);
      setCode({ name: created.driver.name, enrolment: created.enrolment });
      formElement.reset();
    } catch (caught) {
      setError(errorMessage(caught, 'The driver could not be added.'));
    }
  }

  const sorted = [...drivers].sort(
    (a, b) =>
      Number(a.deactivatedAt !== null) - Number(b.deactivatedAt !== null) ||
      a.name.localeCompare(b.name),
  );
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
          It works once, until {shortTime(code.enrolment.expiresAt)}. Enrolling a phone with it
          revokes the phone {code.name} used before.
        </p>
      )}
      <ul className="list">
        {sorted.map((driver) => (
          <li key={driver.id} className="driver-item">
            <span
              className={`dot driver-${driver.deactivatedAt ? 'deactivated' : driver.status}`}
              aria-hidden="true"
            />
            <div>
              <strong>{driver.name}</strong>
              <div className="muted">
                {driver.deactivatedAt
                  ? `Deactivated ${shortDate(driver.deactivatedAt)}`
                  : DRIVER_STATUS_LABEL[driver.status]}
                {driver.deactivatedAt
                  ? ''
                  : driver.position
                    ? ` · last fix ${formatAge(driver.position.recordedAt, now)}${isStale(driver, now) ? ' (stale)' : ''}`
                    : ' · no fix yet'}
              </div>
              {managing === driver.id && (
                <DriverDevices
                  driver={driver}
                  token={token}
                  onCode={(enrolment) => setCode({ name: driver.name, enrolment })}
                  onChanged={onChanged}
                />
              )}
            </div>
            {!driver.deactivatedAt && (
              <button
                type="button"
                className="ghost small"
                aria-expanded={managing === driver.id}
                aria-label={`Phones and access for ${driver.name}`}
                onClick={() => setManaging((current) => (current === driver.id ? null : driver.id))}
              >
                Phones
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface DriverDevicesProps {
  driver: DriverDto;
  token: string;
  onCode: (enrolment: EnrolmentCodeDto) => void;
  onChanged: (driver: DriverDto) => void;
}

/** A driver's phones: revoke one, issue a code for a new one, or deactivate the driver. */
function DriverDevices({ driver, token, onCode, onChanged }: DriverDevicesProps) {
  const [devices, setDevices] = useState<DeviceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  // Load when opened, and again after a phone is revoked.
  useEffect(() => {
    let active = true;
    apiFetch<DeviceDto[]>(`/v1/drivers/${driver.id}/devices`, { token }).then(
      (loaded) => {
        if (active) setDevices(loaded);
      },
      (caught: unknown) => {
        if (active) setError(errorMessage(caught, 'The phones could not be loaded.'));
      },
    );
    return () => {
      active = false;
    };
  }, [driver.id, token, version]);

  async function act(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  const revoke = (device: DeviceDto) => {
    if (!window.confirm(`Revoke "${device.name}"? It stops working at once.`)) return;
    void act(async () => {
      await apiFetch<DeviceDto>(`/v1/drivers/${driver.id}/devices/${device.id}/revoke`, {
        token,
        body: {},
      });
      setVersion((v) => v + 1);
    }, 'The phone could not be revoked.');
  };

  const newCode = () =>
    void act(async () => {
      onCode(
        await apiFetch<EnrolmentCodeDto>(`/v1/drivers/${driver.id}/enrolment-codes`, {
          token,
          body: {},
        }),
      );
    }, 'No enrolment code could be created.');

  const deactivate = () => {
    if (
      !window.confirm(
        `Deactivate ${driver.name}? Every phone is revoked and the driver cannot be assigned again.`,
      )
    )
      return;
    void act(async () => {
      onChanged(
        await apiFetch<DriverDto>(`/v1/drivers/${driver.id}/deactivate`, {
          token,
          body: {},
        }),
      );
    }, 'The driver could not be deactivated.');
  };

  return (
    <div className="driver-devices" aria-label={`Phones of ${driver.name}`} role="group">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {devices === null && !error && <p className="muted small">Loading phones…</p>}
      {devices?.length === 0 && <p className="muted small">No phone enrolled yet.</p>}
      {devices && devices.length > 0 && (
        <ul className="list small">
          {devices.map((device) => (
            <li key={device.id}>
              <div>
                {device.name}
                <div className="muted">
                  {device.revokedAt
                    ? `Revoked ${shortDate(device.revokedAt)} ${shortTime(device.revokedAt)}`
                    : device.lastSeenAt
                      ? `Last seen ${formatAge(device.lastSeenAt)}`
                      : `Enrolled ${shortDate(device.createdAt)}`}
                </div>
              </div>
              {!device.revokedAt && (
                <button
                  type="button"
                  className="danger small"
                  disabled={busy}
                  onClick={() => revoke(device)}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="driver-actions">
        <button type="button" className="small" disabled={busy} onClick={newCode}>
          New enrolment code
        </button>
        <button type="button" className="danger small" disabled={busy} onClick={deactivate}>
          Deactivate driver
        </button>
      </div>
    </div>
  );
}
