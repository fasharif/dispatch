# Decisions

Architecture decision records for dispatch. Each one says what was decided, why, and what it
costs. Newer records can replace older ones; nothing is edited silently.

| ADR                                                                                                | Decision                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [001](#adr-001--one-repository-npm-workspaces-shared-zod-contracts)                                | One repository, npm workspaces, shared zod contracts                                 |
| [002](#adr-002--the-api-is-nestjs-running-as-native-es-modules)                                    | The API is NestJS running as native ES modules                                       |
| [003](#adr-003--postgresql-with-postgis-queried-in-sql-no-orm)                                     | PostgreSQL with PostGIS, queried in SQL, no ORM                                      |
| [004](#adr-004--nearest-free-driver-knn-read-then-lock-by-key)                                     | Nearest free driver: KNN read, then lock by key                                      |
| [005](#adr-005--driver-fixes-are-sent-at-least-once-and-stored-once)                               | Driver fixes are sent at least once and stored once                                  |
| [006](#adr-006--live-updates-socketio-over-websocket-only-redis-adapter-redis-stream-for-resume)   | Live updates: Socket.IO over WebSocket only, Redis adapter, Redis stream for resume  |
| [007](#adr-007--webhooks-through-a-transactional-outbox-relayed-by-bullmq)                         | Webhooks through a transactional outbox, relayed by BullMQ                           |
| [008](#adr-008--eta-from-osrm-when-configured-otherwise-a-stated-straight-line-estimate)           | ETA from OSRM when configured, otherwise a stated straight-line estimate             |
| [009](#adr-009--customer-tracking-links-are-signed-expiring-tokens-not-accounts)                   | Customer tracking links are signed, expiring tokens, not accounts                    |
| [010](#adr-010--proof-of-delivery-photo-signature-and-a-geofence-checked-in-the-database)          | Proof of delivery: photo, signature and a geofence checked in the database           |
| [011](#adr-011--authentication-dispatcher-sessions-in-memory-hashed-device-tokens-deny-by-default) | Authentication: dispatcher sessions in memory, hashed device tokens, deny by default |
| [012](#adr-012--the-driver-apps-queue-lives-in-sqlite-behind-a-small-interface)                    | The driver app's queue lives in SQLite behind a small interface                      |
| [013](#adr-013--basemap-from-a-protomaps-pmtiles-extract-with-a-stated-fallback)                   | Basemap from a Protomaps PMTiles extract, with a stated fallback                     |
| [014](#adr-014--the-scale-test-counts-lost-events-against-the-database)                            | The scale test counts lost events against the database                               |
| [015](#adr-015--toolchain-pins-typescript-6-and-eslint-9)                                          | Toolchain pins: TypeScript 6 and ESLint 9                                            |
| [016](#adr-016--docker-desktop-bind-mount-workarounds)                                             | Docker Desktop bind-mount workarounds                                                |

---

## ADR-001 — One repository, npm workspaces, shared zod contracts

**Context.** The API, the web console, the driver app and the simulator all exchange the same
payloads: location batches, deliveries, tracking views, webhook envelopes. Types copied between
projects drift, and a type alone does not validate anything at run time.

**Decision.** One repository with npm workspaces: `packages/shared`, `apps/api`, `apps/web`,
`apps/driver` and `tools/simulator`. `packages/shared` holds zod schemas and the types inferred
from them, the delivery state machine and the geo helpers. The API validates every request body
with these schemas, and the console, the driver app and the simulator use the inferred types.
The shared package is built to ES modules and consumed from `dist`, so every app sees exactly
what was published.

**Consequences.** A contract change is one commit and fails type checks everywhere it matters.
The shared package must be built before the others are type-checked or tested (CI does this
first). React is pinned to one version for both Next.js and Expo, because npm installs a single
copy for the workspace.

## ADR-002 — The API is NestJS running as native ES modules

**Context.** NestJS 12 is published as ES modules only. The rest of the workspace is ES modules
too.

**Decision.** The API is `"type": "module"` with `NodeNext` resolution and explicit `.js`
extensions in imports. Tests compile with SWC (`unplugin-swc`), because NestJS dependency
injection needs decorator metadata and esbuild does not emit it. Classes that are injected into
each other live in separate files, since circular imports between ES modules leave one side
undefined while decorators run.

**Consequences.** No CommonJS interop layer and no bundler for the API. The price is the `.js`
suffix on every relative import and some care with file layout.

## ADR-003 — PostgreSQL with PostGIS, queried in SQL, no ORM

**Context.** The interesting queries are spatial: nearest drivers by distance, whether a
proof-of-delivery position lies within a radius of the drop-off point, positions as
`geography(Point, 4326)`. They need index-aware operators (`<->`, `ST_DWithin`) and row locks.

**Decision.** `pg` with parameterised SQL in the services, and plain SQL migrations applied by a
small migrator that records a checksum for each file and holds an advisory lock, so two API
instances starting together do not race. Positions are `geography` in WGS 84; distances are in
metres on the ellipsoid.

**Consequences.** Every query is visible and reviewable, and PostGIS features are used as
PostGIS documents them. There is no generated client, so row types are declared by hand next to
each query and covered by integration tests against a real PostGIS server.

## ADR-004 — Nearest free driver: KNN read, then lock by key

**Context.** Automatic assignment must pick the closest available driver with a recent fix, and
two dispatchers (or two API instances) assigning at the same moment must not give one driver two
deliveries. `SELECT … ORDER BY location <-> point … FOR UPDATE SKIP LOCKED` in one statement
failed under concurrency with "attempted to lock invisible tuple".

**Decision.** Two steps inside the assignment transaction. First, a KNN query on a partial GiST
index over available drivers (`ORDER BY location <-> pickup`) returns up to ten candidates whose
last fix is newer than `DRIVER_STALE_AFTER_S`. Then each candidate, nearest first, is locked by
primary key with `FOR UPDATE SKIP LOCKED` and checked again for being free. A unique partial
index allows one active delivery per driver as the final guard. The dispatcher can override:
`GET /v1/deliveries/:id/candidates` lists nearby drivers (stale ones flagged) and
`POST /v1/deliveries/:id/assign` with a `driverId` locks that driver instead. When nobody is
free, the delivery stays `pending`.

**Consequences.** Assignment is correct under concurrency (an integration test assigns in
parallel) and uses the index. "Nearest" is straight-line distance to the pickup, not travel
time; with OSRM configured, the candidate list shows road ETAs, but the automatic choice still
uses distance.

## ADR-005 — Driver fixes are sent at least once and stored once

**Context.** Phones lose signal, time out after the server has stored a batch, and are killed by
the operating system. The app must resend anything not acknowledged, and the server must not
store or broadcast a fix twice.

**Decision.** Each fix carries a per-device sequence number and a random idempotency key, both
assigned when it is recorded. The API inserts batches with `ON CONFLICT DO NOTHING` against
unique `(device_id, seq)` and a unique idempotency key, and answers per fix: `accepted`,
`duplicate`, `conflict` (the same seq with a different key, or the reverse) or `rejected` (clock
skew beyond `MAX_CLOCK_SKEW_S`, or older than the retained history). The driver's current
position only moves forward in time, whatever order fixes arrive in. New fixes are appended to
the live stream before the response is sent, and the stream id is stored with the fix; a
duplicate whose stream id is empty (the process died between storing and publishing) is
published when it is replayed.

**Consequences.** A 2xx means "stored and on the live stream". Offline replays after hours are
safe, and the scale test can count lost events exactly. The cost is one extra read per batch to
classify replays.

## ADR-006 — Live updates: Socket.IO over WebSocket only, Redis adapter, Redis stream for resume

**Context.** Several API instances sit behind nginx. A dispatcher's console is connected to one
of them, while a driver's fix may arrive at another. When an instance dies, its consoles
reconnect elsewhere and must not miss what happened in between.

**Decision.** Socket.IO with `@socket.io/redis-adapter`, so a broadcast from any instance reaches
every console. Clients and servers use the WebSocket transport only: without HTTP long-polling
there is no need for sticky sessions, and nginx can balance connections round robin. Every fix
is also appended to a Redis stream (`dispatch:locations`, trimmed to
`LOCATION_STREAM_RETENTION_MIN` minutes). A console remembers the newest stream id it has seen;
after a reconnect it asks for everything after that id (paged `XRANGE`), and drops duplicates by
`deviceId:seq`. If the id is older than the retained window, the server answers `gap: true` and
the console reloads the driver list instead. Customer tracking pages use a separate namespace
and room per delivery and receive only that delivery's view.

**Consequences.** Killing an instance mid-stream loses no events (end-to-end test with two
instances, and the scale test). Browsers or proxies that block WebSockets cannot connect; that
is accepted for a dispatcher console and a tracking page.

## ADR-007 — Webhooks through a transactional outbox, relayed by BullMQ

**Context.** The order system (TopFlow Hub, a separate portfolio project) must hear about
assignments, pickups, deliveries, failures and cancellations. Sending the HTTP request inside the
database transaction couples the two systems' availability; sending it after the commit loses
events when the process dies in between.

**Decision.** Every delivery change inserts an `outbox` row in the same transaction. A worker
process (`PROCESS_ROLE=worker`) sweeps unsent rows every 5 seconds into BullMQ jobs whose job id
is the event id, so a row is queued once however often it is swept. Each request carries
`x-dispatch-event-id`, `x-dispatch-event-type` and
`x-dispatch-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over "<t>.<body>">`. Answers are
classified: 2xx delivered; 408, 409, 425, 429 and 5xx retried with exponential backoff and
jitter (`WEBHOOK_MAX_ATTEMPTS`, 8 by default); other 4xx and 3xx (redirects are not followed)
are final. Dispatchers can see the outbox and retry a failed event from the console.

**Consequences.** Delivery is at least once and unordered, so the receiver must deduplicate by
event id and check the timestamp; TopFlow's receiver does both. Without `WEBHOOK_URL` events
stay in the outbox, which is how the demo runs.

## ADR-008 — ETA from OSRM when configured, otherwise a stated straight-line estimate

**Context.** A road-network ETA needs routing data. The GCC extract is large, and preparing it
takes several gigabytes of memory, which CI and many laptops do not have.

**Decision.** With `OSRM_URL` set, ETAs come from OSRM's route and table services (driving
profile, multi-level Dijkstra); routed ETAs on tracking pages are cached per delivery for 15
seconds. Without it, or when OSRM fails, answers `NoRoute` or exceeds `OSRM_TIMEOUT_MS`, the
estimate is straight-line: haversine distance × `ETA_DETOUR_FACTOR` (1.4) at `ETA_SPEED_KMH`
(30). Every estimate carries its `source` (`osrm` or `straight_line`), and the pages say which
one they show. `scripts/prepare-osrm.sh` prepares either the Geofabrik GCC extract or a small
box from the Overpass API; the compose profile `osrm` serves it.

**Consequences.** Everything works without routing data, and the fallback is documented rather
than hidden. The straight-line figure ignores traffic, one-way streets and the Creek crossings,
so it can be wrong by a wide margin for individual trips; 30 km/h and 1.4 are assumptions for
urban Dubai, not measurements.

## ADR-009 — Customer tracking links are signed, expiring tokens, not accounts

**Context.** Customers should follow a delivery from a link in a message, without an account,
and a guessed or old link must reveal nothing.

**Decision.** `v1.<base64url {d: delivery id, e: expiry}>.<base64url HMAC-SHA256>`, signed with
`TRACKING_TOKEN_SECRET` and valid for `TRACKING_LINK_TTL_HOURS` (48). Verification is constant
time; an invalid link answers 404 and an expired one 410 with a message to ask the sender for a
new link. The page shows the order reference, status, the driver's first name, and the driver's
position and ETA only while the parcel is on its way (`picked_up`), never before pickup or after
delivery. It is available in English and Arabic (right to left, Arabic map labels), chosen from a
cookie or `Accept-Language`, with times in Asia/Dubai.

**Consequences.** No database lookup to validate a link and nothing to store. A link cannot be
revoked before it expires except by rotating the secret, which invalidates all links; that is
acceptable for a 48-hour window.

## ADR-010 — Proof of delivery: photo, signature and a geofence checked in the database

**Context.** "Delivered" should mean the driver was at the address, the recipient signed, and a
photo exists.

**Decision.** `POST /v1/driver/deliveries/:id/complete` takes a multipart photo (JPEG, PNG or
WebP, recognised by its first bytes, up to `MAX_PHOTO_BYTES`), a signature as vector strokes,
the recipient's name and a fresh position with its accuracy. The API checks the position with `ST_DWithin` on the ellipsoid
against the drop-off point: `GEOFENCE_RADIUS_M` (150), widened by the reported accuracy up to
`GEOFENCE_ACCURACY_ALLOWANCE_M` (50). Outside the fence the request is refused with the distance.
Photos are stored on disk under generated names (`UPLOAD_DIR`) and served to dispatchers only.

**Consequences.** A driver cannot complete from across town. A spoofed GPS position still passes;
detecting that is out of scope. Photo storage is a local volume, so multiple API hosts need a
shared volume or object storage (listed under limitations).

## ADR-011 — Authentication: dispatcher sessions in memory, hashed device tokens, deny by default

**Context.** Three kinds of caller: dispatchers in a browser, driver devices, and the public
(tracking links, health checks).

**Decision.** Every route is closed unless marked `@Access('public' | 'dispatcher' | 'device')`.
Dispatchers sign in with a password (scrypt, compared in constant time, with a dummy hash for
unknown emails) and receive an HS256 JWT valid for `JWT_TTL_MINUTES` (8 hours, one shift). The console keeps it in memory only, not in
`localStorage` or a cookie, so a reload asks for the password again and no stored token is left
for other scripts to find. Devices enrol once with a one-time code a dispatcher creates and
receive an opaque `dvc_…` token; only its SHA-256 is stored. Login and enrolment are rate limited
per address (`AUTH_THROTTLE_LIMIT`), everything else per signed-in dispatcher or device, or per
address for anonymous calls (`THROTTLE_LIMIT`), with counters in Redis so the limits hold across
instances. In production the API refuses to start with the
example secrets.

**Consequences.** No CSRF surface for the console, since there are no cookies. The price is
signing in again after a reload, which suits a console that stays open all shift.

## ADR-012 — The driver app's queue lives in SQLite behind a small interface

**Context.** The queue is the part of the driver app that must be right: fixes recorded while
the app is in the background or offline must reach the server once each, in order, after any
crash. Expo modules only run on a device or simulator, which CI does not have.

**Decision.** Background location with `expo-location` and `expo-task-manager` (a fix every 5
seconds or 10 metres on shift). Each fix is written to SQLite first (`expo-sqlite`), taking the
next sequence number in the same transaction, and removed only after the server has answered for
it. Replay sends the oldest fixes first and stops at a network error, a refused device token or
any other error answer, keeping everything unanswered; a 400 for a whole batch is retried one fix
at a time so a malformed fix cannot block the queue. The queue
and replay logic depend on a four-method `SqlDatabase` interface: the app uses `expo-sqlite`,
and the unit tests use Node's built-in `node:sqlite`, so the same SQL runs in CI.

**Consequences.** The queue's behaviour (sequence numbers across restarts, a lost response
turning into duplicates, offline replay, 400 isolation) is tested without a device. What is not tested here is the operating
system side: background permissions, battery optimisation and task scheduling on real phones.

## ADR-013 — Basemap from a Protomaps PMTiles extract, with a stated fallback

**Context.** The console and tracking pages need a street map of Dubai without an API key or a
third-party tile service that tracks visitors.

**Decision.** MapLibre GL with the Protomaps basemap style, reading a single PMTiles file (Dubai,
zoom 0–14, about 13 MB) through HTTP range requests. `scripts/fetch-basemap.sh` extracts it from
a daily Protomaps planet build; it is not committed. The compose stack serves it from nginx. When
the file is missing the maps fall back to MapLibre's demo tiles (country outlines) and say so.
Glyphs and sprites come from the Protomaps assets repository; Arabic labels use MapLibre's RTL
text plugin, served locally.

**Consequences.** No tile server and no key. The extract ages; rerunning the script refreshes it.
Map data is © OpenStreetMap contributors under the ODbL, credited on every map.

## ADR-014 — The scale test counts lost events against the database

**Context.** "No lost events when an instance dies" is the property that matters, and latency on
a shared development machine is noise.

**Decision.** `load/run-scale-test.sh` starts two API instances behind nginx, enrols N simulated
drivers, runs k6 (one virtual user per driver) and a listening console, kills one API instance
with SIGKILL halfway through, and then compares every fix stored in the database with what the
console received. The run fails on any lost event, on an empty k6 summary, or when no fix was
stored. Latency is measured from the batch's `sentAt` to arrival at the console, on the same
Docker host, and recorded in the run's folder; it is published in docs/scale-test.md only from a
run on a quiet machine (`--publish-timings`).

**Consequences.** The published claim is a count, reproducible by anyone with Docker. Latency
figures stay pending until a clean run exists.

## ADR-015 — Toolchain pins: TypeScript 6 and ESLint 9

**Context.** TypeScript 7 and ESLint 10 exist, but `typescript-eslint` does not support
TypeScript 7 yet, and the Next.js and Expo ESLint configurations require ESLint 9.

**Decision.** TypeScript 6.0 and ESLint 9.39 with `typescript-eslint`'s strict type-checked
rules across the workspace, exact versions in every `package.json`, and the lockfile committed.
Dependabot proposes updates weekly, grouped by family (NestJS, Expo, React, lint, test).

**Consequences.** One compiler and one linter configuration everywhere. Moving to TypeScript 7
waits for `typescript-eslint`.

## ADR-016 — Docker Desktop bind-mount workarounds

**Context.** On Docker Desktop for Windows, processes running as a non-root user inside a
container could not read files bind-mounted from this repository's path (EIO). nginx (worker
processes), k6 and the simulator containers were affected.

**Decision.** The compose stack copies the basemap into a named volume with a one-shot `tiles`
service, which nginx then serves. The scale-test harness containers run as root, since they only
read the results folder and talk to the stack.

**Consequences.** The stack behaves the same on Linux, macOS and Windows. Running harness
containers as root is acceptable for a local test harness; the application images themselves
run as an unprivileged user.
