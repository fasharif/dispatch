-- dispatch: dispatchers can revoke a phone and deactivate a driver (ADR-011).
--
-- devices.revoked_at existed from the start and was checked on every request, but nothing set it.
-- A deactivated driver has every phone revoked, cannot enrol a new one and is never assigned.

ALTER TABLE drivers ADD COLUMN deactivated_at timestamptz;

-- Deactivation takes the driver off shift in the same statement, and nothing puts them back.
ALTER TABLE drivers
  ADD CONSTRAINT drivers_deactivated_offline_check
  CHECK (deactivated_at IS NULL OR status = 'offline');

-- The phones that still work, per driver: listed in the console and revoked on re-enrolment.
CREATE INDEX devices_active_driver_idx ON devices (driver_id) WHERE revoked_at IS NULL;
