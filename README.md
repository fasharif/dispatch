# dispatch

Live delivery tracking: dispatcher console, offline-first driver app, signed customer tracking links and proof of delivery.

[![CI](https://github.com/fasharif/dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/fasharif/dispatch/actions/workflows/ci.yml)

A portfolio project. The orders come from [TopFlow Hub](https://github.com/fasharif/topflow),
another portfolio project, whose receiving side marks them delivered (ADR-024 in its
`docs/DECISIONS.md`). Nothing here serves a real company.

![The dispatcher console: drivers and deliveries on a map of Dubai, with a delivery on its way selected](docs/screenshots/console.png)

| Tracking page, Arabic                                                                                           | Tracking page, English                                        | Proof of delivery in the console                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ![Tracking page in Arabic, right to left, with the driver's position and ETA](docs/screenshots/tracking-ar.png) | ![Tracking page in English](docs/screenshots/tracking-en.png) | ![Photo, signature and geofence result for a completed delivery](docs/screenshots/proof.png) |

## Problem

Once an order leaves the warehouse, the order system knows nothing until someone marks it
delivered. Dispatchers phone drivers to find out where they are, customers phone the shop to ask
when the parcel will arrive, and "delivered" is whatever the driver says. Drivers in Dubai lose
signal in car parks and tunnels, so anything that relies on a constant connection loses data.

## Features

- **Live map.** Every driver's position and every open delivery, updated over WebSockets as
  fixes arrive, on a Protomaps basemap of Dubai. After a reconnect the console catches up on the
  positions it missed and reloads drivers and deliveries.
- **Nearest free driver.** New deliveries are assigned to the closest available driver with a
  recent fix (PostGIS KNN on a GiST index, safe under concurrent assignment). The dispatcher can
  see the candidates with distances and ETAs and override the choice before pickup.
- **Driver locations every few seconds**, from the driver app's background location task, sent
  in batches: every 5 seconds on Android whether or not the driver moves; on iOS as positions
  arrive, at most one every 4 seconds; and, while the app is open, a heartbeat after 30 seconds
  without a position, so a driver waiting at the warehouse stays assignable.
- **Offline replay without duplicates.** Fixes wait in SQLite on the phone with a per-device
  sequence number and an idempotency key, and are replayed after any outage; the API stores each
  one once and says per fix whether it was accepted, a duplicate or a conflict. A replayed fix is
  broadcast again, so consoles never miss one that an instance stored just before it died.
- **Customer tracking links.** HMAC-signed and expiring (48 hours by default), no account needed.
  The page shows the driver's position and ETA while the parcel is on its way, in English or
  Arabic (right to left, Arabic map labels).
- **Proof of delivery.** Photo, signature and the phone's position, which must be within a
  geofence around the drop-off point (`ST_DWithin`, 150 m widened by the fix's accuracy).
- **Webhooks to the order system** from a transactional outbox: HMAC-signed, retried with
  exponential backoff, idempotent by event id. TopFlow Hub's receiving side marks orders
  delivered through its own state machine. Both repositories test the same recorded, signed
  requests, so neither side can change the contract alone.
- **ETA** from OSRM when it is configured (optional compose profile), otherwise a documented
  straight-line estimate; every ETA says which one it is.
- **Scale test.** Two API instances behind nginx, simulated drivers in k6, a console on each
  instance, the instance of one console killed mid-run, and a count of lost events against the
  database for both consoles.

## Architecture

```mermaid
flowchart LR
  D["Driver app<br/>Expo, SQLite queue"]
  C["Dispatcher console<br/>Next.js, MapLibre"]
  T["Tracking page<br/>English / Arabic"]
  N[nginx]
  A1["API instance 1<br/>NestJS, Socket.IO"]
  A2["API instance 2"]
  W["Worker<br/>outbox relay"]
  PG[("PostgreSQL + PostGIS")]
  R[("Redis<br/>adapter, stream, BullMQ")]
  O["OSRM<br/>optional"]
  TF["TopFlow Hub<br/>webhook receiver"]
  D -- "location batches, proof" --> N
  C -- "REST + WebSocket" --> N
  T -- "REST + WebSocket" --> N
  N --> A1
  N --> A2
  A1 --> PG
  A2 --> PG
  A1 <--> R
  A2 <--> R
  A1 -.-> O
  A2 -.-> O
  W --> PG
  W <--> R
  W -- "signed webhooks" --> TF
```

A fix travels like this: the phone records it into its SQLite queue and sends a batch; nginx
passes it to either API instance; the instance stores it (`ON CONFLICT DO NOTHING`), appends it
to a Redis stream and broadcasts it through the Socket.IO Redis adapter, so consoles connected
to the other instance receive it too; only then does the phone get its answer and remove the fix
from its queue. A console that reconnects asks for everything after the last stream id it saw,
and reloads drivers and deliveries over HTTP. If an instance dies between storing a fix and
broadcasting it, the phone gets no answer and sends the batch again; the other instance answers
"duplicate" and broadcasts the stored fix again. Delivery changes write an outbox row in the same
transaction; the worker turns outbox rows into BullMQ jobs that sign and send the webhooks.

## Stack and why

| Part                      | Choice                                                                           | Why                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                       | NestJS 12 (ES modules), `pg` with SQL                                            | Modules, guards and gateways without hiding the SQL; the geo queries are PostGIS as written ([ADR-002](docs/decisions.md#adr-002--the-api-is-nestjs-running-as-native-es-modules), [ADR-003](docs/decisions.md#adr-003--postgresql-with-postgis-queried-in-sql-no-orm)) |
| Database                  | PostgreSQL 18 with PostGIS 3.6                                                   | KNN (`<->`) on GiST indexes, `ST_DWithin` on the ellipsoid, row locks for assignment                                                                                                                                                                                    |
| Realtime                  | Socket.IO 4, WebSocket transport only, `@socket.io/redis-adapter`, Redis stream  | Fan-out across instances without sticky sessions, and resume after a reconnect ([ADR-006](docs/decisions.md#adr-006--live-updates-socketio-over-websocket-only-redis-adapter-redis-stream-for-resume))                                                                  |
| Jobs                      | BullMQ on Redis 8                                                                | Retries with backoff and a job id per event for the outbox relay ([ADR-007](docs/decisions.md#adr-007--webhooks-through-a-transactional-outbox-relayed-by-bullmq))                                                                                                      |
| Console and tracking page | Next.js 16, React 19, MapLibre GL 6, Protomaps PMTiles                           | A street map from one static file, no tile server or API key ([ADR-013](docs/decisions.md#adr-013--basemap-from-a-protomaps-pmtiles-extract-with-a-stated-fallback))                                                                                                    |
| Driver app                | Expo 57 (React Native 0.86), `expo-location`, `expo-task-manager`, `expo-sqlite` | Background location and a durable queue from one TypeScript codebase ([ADR-012](docs/decisions.md#adr-012--the-driver-apps-queue-lives-in-sqlite-behind-a-small-interface))                                                                                             |
| Contracts                 | zod 4 in `packages/shared`                                                       | One schema for validation and types across all apps ([ADR-001](docs/decisions.md#adr-001--one-repository-npm-workspaces-shared-zod-contracts))                                                                                                                          |
| Routing                   | OSRM (optional)                                                                  | Road-network ETAs when data is prepared; a stated fallback otherwise ([ADR-008](docs/decisions.md#adr-008--eta-from-osrm-when-configured-otherwise-a-stated-straight-line-estimate))                                                                                    |
| Load                      | k6 (grafana/k6 image), nginx                                                     | Many simulated drivers against two instances, with one killed mid-run ([ADR-014](docs/decisions.md#adr-014--the-scale-test-counts-lost-events-against-the-database))                                                                                                    |
| Tests                     | Vitest, Playwright, PostGIS and Redis containers                                 | Unit, integration and end-to-end tests against the real database features                                                                                                                                                                                               |

## Quick start

Needs Docker and Node.js 24.

```bash
git clone https://github.com/fasharif/dispatch.git && cd dispatch
scripts/fetch-basemap.sh      # optional: Dubai basemap, about 13 MB; without it the map shows demo tiles
docker compose --profile stack up -d --build --wait
npm ci && npm run build -w @dispatch/shared -w @dispatch/simulator
npm run start -w @dispatch/simulator -- demo --api http://localhost:57080
```

Open <http://localhost:57080> and sign in as `dispatcher@dispatch.local` with the demo password
`dispatch-demo-2026` (local stacks only; production refuses to seed without
`SEED_DISPATCHER_PASSWORD`). The demo enrols 12 simulated drivers, creates an order every 40
seconds and drives each one through pickup and proof of delivery. Enrolment is rate limited, so
the first drivers can take a minute to appear. If the demo stops with an error (for example a
timeout while the stack is still warming up), run the last command again: it reuses the drivers
it created and carries on with their open deliveries. `docker compose --profile stack down -v`
stops everything. The stack's ports are bound to 127.0.0.1 only.

For development with hot reload: `docker compose up -d` (PostgreSQL and Redis only), copy
`apps/api/.env.example` to `apps/api/.env` and `apps/web/.env.example` to `apps/web/.env.local`,
then `npm run build -w @dispatch/shared`, `npm run db:migrate`, `npm run db:seed`,
`npm run dev -w @dispatch/api` and `npm run dev -w @dispatch/web` (console on
<http://localhost:57300>). The driver app starts with `npm start -w @dispatch/driver` in Expo;
it has not been run on a device (see limitations).

## Configuration

Every API variable is validated at start-up, and the process stops with a list of problems if
one is missing or malformed. The full list with defaults is in
[`apps/api/.env.example`](apps/api/.env.example); the ones you are most likely to change:

| Variable                                             | Default                                   | Purpose                                                            |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`, `REDIS_URL`                          | compose services on ports 57432 and 57379 | Data stores                                                        |
| `JWT_SECRET`, `TRACKING_TOKEN_SECRET`                | none (examples in `.env.example`)         | 32+ characters each; production refuses the examples               |
| `PROCESS_ROLE`                                       | `all`                                     | `api` (HTTP and WebSockets), `worker` (outbox relay) or both       |
| `PUBLIC_WEB_URL`, `CORS_ORIGINS`                     | `http://localhost:57300`                  | Base of tracking links; allowed browser origins                    |
| `TRACKING_LINK_TTL_HOURS`                            | 48                                        | Lifetime of a customer tracking link                               |
| `GEOFENCE_RADIUS_M`, `GEOFENCE_ACCURACY_ALLOWANCE_M` | 150, 50                                   | Proof-of-delivery fence around the drop-off point                  |
| `DRIVER_STALE_AFTER_S`                               | 120                                       | Drivers with older fixes are not assigned automatically            |
| `LOCATION_STREAM_RETENTION_MIN`                      | 15                                        | How long a reconnecting console can resume                         |
| `WEBHOOK_URL`, `WEBHOOK_SECRET`                      | empty                                     | Where signed events go; empty keeps them in the outbox             |
| `OSRM_URL`                                           | empty                                     | OSRM base URL for road ETAs; empty uses the straight-line estimate |
| `AUTH_THROTTLE_LIMIT`, `THROTTLE_LIMIT`              | 10, 600 per minute                        | Rate limits for sign-in and enrolment, and for everything else     |

The web app reads `NEXT_PUBLIC_API_URL` (empty means same origin, as behind nginx) and
`NEXT_PUBLIC_BASEMAP_URL` at build time ([`apps/web/.env.example`](apps/web/.env.example)).

Road ETAs: `scripts/prepare-osrm.sh` prepares the Geofabrik GCC extract (a 254 MB download for
the 25 September 2026 file; not processed on the development machine, see limitations) or, with
`--bbox 25.08,55.17,25.16,55.25`, a small box from the Overpass API; then
`docker compose --profile osrm up -d osrm` serves it on port 57500 (`http://osrm:5000` inside the
stack).

## Tests

| Command                                                                          | What it covers                                                                                                                                                                                                                                                                | Needs                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `npm test`                                                                       | Unit tests in every workspace: contracts, geo helpers, state machine, signatures, tokens, config, the webhook contract (recorded requests), the driver app's offline queue, replay and location policy, the console's state and live feed, i18n, demo seeding                 | Nothing                                  |
| `npm run test:integration`                                                       | API against PostGIS and Redis: location ingestion and replays, KNN assignment under concurrency, ending a shift during an assignment, proof of delivery (geofence, ownership, concurrent retries), the outbox relay and webhook retries                                       | `docker compose up -d`                   |
| `npm run test:e2e`                                                               | The core flow over HTTP and WebSockets: create, assign, track, pick up, deliver with proof, webhook sent; sessions ending on time; two API instances: fan-out, a replayed fix broadcast again after its first broadcast was lost, and no lost fix when one instance goes away | `docker compose up -d`                   |
| `npm run test:browser -w @dispatch/web`                                          | Playwright: sign-in, live map, adding a driver, creating a delivery on the map, deliveries changed while the console was disconnected, tracking page in English and Arabic                                                                                                    | API and web app running, database seeded |
| `npm run bundle -w @dispatch/driver`                                             | Metro bundles the driver app for Android                                                                                                                                                                                                                                      | Nothing                                  |
| `npm run test:scale`                                                             | Scale test with a console on each instance ([docs/scale-test.md](docs/scale-test.md))                                                                                                                                                                                         | Docker                                   |
| `TEST_OSRM_URL=http://localhost:57500 npm run test:integration -w @dispatch/api` | ETAs against a real OSRM server                                                                                                                                                                                                                                               | The `osrm` compose profile               |

`npm run lint`, `npm run typecheck` and `npm run format:check` run the same checks as CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), which also runs the integration,
end-to-end and browser tests with PostGIS and Redis service containers, the driver bundle, and a
20-driver scale smoke test.

## Folder structure

```text
apps/
  api/             NestJS API and worker: REST, Socket.IO gateways, outbox relay, SQL migrations
  web/             Next.js dispatcher console and customer tracking page
  driver/          Expo driver app: background location, SQLite queue, proof of delivery
packages/
  shared/          zod contracts, delivery state machine, geo helpers, live-feed client
tools/
  simulator/       CLI: seed simulated drivers, drive them, run the demo, listen and verify
load/              k6 scale test, its runner and report
deploy/            nginx configuration for the compose stack
scripts/           Basemap extract and OSRM data preparation
docs/              Decisions, scale test, screenshots
```

## Decisions

[docs/decisions.md](docs/decisions.md) records the architecture decisions: assignment under
concurrency, idempotent ingestion, resume after reconnect, the outbox, ETA assumptions, tracking
tokens, and the rest.

## Limitations and roadmap

- **The driver app has not run on a phone.** It type-checks, its lint passes, its offline queue,
  replay and location policy are unit-tested with Node's SQLite, and Metro bundles it. The
  location policy follows expo-location's documented behaviour; background location,
  permissions, update rates while standing still and battery use on real Android and iOS devices
  are untested.
- **Latency figures are pending.** The 50-driver scale run recorded zero lost events on both
  consoles with the reconnecting console's API instance killed; p95 driver-to-console latency will
  be published from a 1,000-driver run on a quiet machine ([docs/scale-test.md](docs/scale-test.md)).
- **OSRM was checked with a small box of Dubai roads only.** The full GCC extract has not been
  processed on the development machine (shared with other workloads, limited memory), so its
  memory needs are not known here. The fallback ETA ignores traffic.
- The console reloads delivery and driver-status changes after a reconnect rather than replaying
  them, so it shows the current state, not every change made while it was away (ADR-017).
- `npm audit` reports 10 moderate findings: one advisory for `uuid` below 11.1.1, counted once
  for `uuid` and once for each of the nine Expo build-tooling packages that depend on it through
  `xcode`. The advisory concerns `v3`, `v5` and `v6` with a caller-supplied buffer; `xcode` calls
  only `uuid.v4()`, and none of it runs in the API or the web app (ADR-018).
- Automatic assignment ranks drivers by straight-line distance, not by road travel time.
- Proof-of-delivery photos are stored on a local volume; several API hosts would need shared or
  object storage.
- A tracking link cannot be revoked before it expires, except by rotating the secret.
- One seeded dispatcher account; no user management, roles or audit views.
- GPS spoofing is not detected.
- Roadmap: road-time assignment, SMS or WhatsApp delivery of tracking links, object storage for
  photos, store builds of the driver app, the 1,000-driver timing run.

## Licence

[MIT](LICENSE). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
available under the Open Database Licence; basemap by
[Protomaps](https://github.com/protomaps/basemaps).
