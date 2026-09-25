-- dispatch: initial schema.
--
-- Positions are stored as geography(Point, 4326): distances and radii are in metres on the
-- WGS 84 ellipsoid, which is what the geofence and "nearest driver" questions need.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── People and devices ─────────────────────────────────────────────────────

CREATE TABLE dispatchers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  -- scrypt$N$r$p$salt$hash (see src/auth/passwords.ts)
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE driver_status AS ENUM ('offline', 'available', 'busy');

CREATE TABLE drivers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  phone                text,
  vehicle              text,
  status               driver_status NOT NULL DEFAULT 'offline',
  -- Latest known position (newest recorded_at wins, whatever order fixes arrive in).
  location             geography(Point, 4326),
  location_accuracy_m  real,
  location_recorded_at timestamptz,
  location_updated_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((location IS NULL) = (location_recorded_at IS NULL))
);

-- KNN ("nearest free driver") uses this partial GiST index: ORDER BY location <-> point.
CREATE INDEX drivers_available_location_idx ON drivers USING gist (location)
  WHERE status = 'available';
CREATE INDEX drivers_location_idx ON drivers USING gist (location);

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    uuid NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- SHA-256 of the bearer token; the token itself is shown once, at enrolment.
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX devices_driver_idx ON devices (driver_id);

CREATE TABLE enrolment_codes (
  code_hash  text PRIMARY KEY,
  driver_id  uuid NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enrolment_codes_driver_idx ON enrolment_codes (driver_id);

-- ─── Location history ───────────────────────────────────────────────────────

-- One row per fix. (device_id, seq) and idempotency_key are both unique, so a replayed fix is
-- stored exactly once. stream_id is set once the fix has been published to the live stream;
-- a replay of a stored but unpublished fix publishes it then.
CREATE TABLE location_updates (
  device_id       uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  seq             bigint NOT NULL CHECK (seq >= 0),
  idempotency_key uuid NOT NULL UNIQUE,
  driver_id       uuid NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  location        geography(Point, 4326) NOT NULL,
  accuracy_m      real,
  speed_mps       real,
  heading_deg     real,
  recorded_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  stream_id       text,
  PRIMARY KEY (device_id, seq)
);
CREATE INDEX location_updates_driver_recorded_idx ON location_updates (driver_id, recorded_at DESC);
CREATE INDEX location_updates_received_idx ON location_updates (received_at);

-- ─── Deliveries ─────────────────────────────────────────────────────────────

CREATE TYPE delivery_status AS ENUM (
  'pending', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'
);

CREATE TABLE deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_reference text NOT NULL,
  recipient_name  text NOT NULL,
  recipient_phone text,
  address         text NOT NULL,
  notes           text,
  pickup          geography(Point, 4326) NOT NULL,
  dropoff         geography(Point, 4326) NOT NULL,
  status          delivery_status NOT NULL DEFAULT 'pending',
  driver_id       uuid REFERENCES drivers (id),
  assignment_mode text CHECK (assignment_mode IN ('auto', 'manual')),
  failure_reason  text,
  created_by      uuid REFERENCES dispatchers (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  assigned_at     timestamptz,
  picked_up_at    timestamptz,
  completed_at    timestamptz,
  closed_at       timestamptz,
  CHECK (status = 'pending' OR status = 'cancelled' OR driver_id IS NOT NULL)
);

-- A driver carries one active delivery at a time; the database enforces it.
CREATE UNIQUE INDEX deliveries_one_active_per_driver_idx ON deliveries (driver_id)
  WHERE status IN ('assigned', 'picked_up');
-- An order has at most one delivery in progress; failed or cancelled attempts may be retried.
CREATE UNIQUE INDEX deliveries_open_order_reference_idx ON deliveries (order_reference)
  WHERE status IN ('pending', 'assigned', 'picked_up', 'delivered');
CREATE INDEX deliveries_status_created_idx ON deliveries (status, created_at DESC);

CREATE TABLE delivery_events (
  id          bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  type        text NOT NULL,
  from_status delivery_status,
  to_status   delivery_status NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('dispatcher', 'driver', 'system')),
  actor_id    uuid,
  note        text,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_delivery_idx ON delivery_events (delivery_id, id);

CREATE TABLE proofs_of_delivery (
  delivery_id          uuid PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
  idempotency_key      text,
  recipient_name       text NOT NULL,
  signature            jsonb NOT NULL,
  photo_path           text NOT NULL,
  photo_content_type   text NOT NULL,
  photo_bytes          integer NOT NULL CHECK (photo_bytes > 0),
  photo_sha256         text NOT NULL,
  location             geography(Point, 4326) NOT NULL,
  accuracy_m           real,
  distance_m           double precision NOT NULL,
  geofence_radius_m    double precision NOT NULL,
  within_geofence      boolean NOT NULL,
  captured_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ─── Transactional outbox ───────────────────────────────────────────────────

-- Written in the same transaction as the change it announces. The relay worker delivers each
-- row to the order system as a signed webhook; `id` is the event id receivers de-duplicate on.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id     uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  enqueued_at     timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_status     integer,
  last_error      text,
  delivered_at    timestamptz,
  failed_at       timestamptz,
  CHECK (delivered_at IS NULL OR failed_at IS NULL)
);
CREATE INDEX outbox_pending_idx ON outbox (created_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE INDEX outbox_delivery_idx ON outbox (delivery_id);
