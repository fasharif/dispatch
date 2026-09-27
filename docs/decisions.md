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
| [017](#adr-017--the-console-reloads-drivers-and-deliveries-on-every-connection)                    | The console reloads drivers and deliveries on every connection                       |
| [018](#adr-018--the-uuid-advisory-in-expos-build-tooling-is-accepted)                              | The uuid advisory in Expo's build tooling is accepted                                |

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
primary key with `FOR UPDATE SKIP LOCKED` and checked again for being free. When all ten are
taken by concurrent assignments or have turned busy, the next ten beyond the ones already tried
are read, until no free driver with a fresh fix is left (the first version stopped after ten;
found in review). A unique partial index allows one active delivery per driver as the final
guard. The dispatcher can override: `GET /v1/deliveries/:id/candidates` lists nearby drivers
(stale ones flagged) and `POST /v1/deliveries/:id/assign` with a `driverId` locks that driver
instead. When nobody is free, the delivery stays `pending`.

**Consequences.** Assignment is correct under concurrency (an integration test assigns in
parallel, another locks the ten nearest drivers and expects the eleventh) and uses the index:
`EXPLAIN` on 20,000 drivers shows an index scan on the partial GiST index ordered by distance,
with the drivers already tried as a filter. "Nearest" is straight-line distance to the pickup,
not travel time; with OSRM configured, the candidate list shows road ETAs, but the automatic
choice still uses distance.

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
the live stream before the response is sent, and the stream id is stored with the fix. A
replay means the device never saw the first answer, so the instance that receives it cannot know
how far the first attempt got: a duplicate whose stream id is empty (the process died between
storing and publishing) is published now, and a duplicate that is already on the stream is
broadcast again under its original stream id, because the first instance may have died after
saving the stream id but before the Redis adapter passed the broadcast on.

**Consequences.** A 2xx means "stored and on the live stream". Offline replays after hours are
safe, and the scale test can count lost events exactly. The cost is one extra read per batch to
classify replays, and a repeated broadcast when a device replays a batch whose first broadcast
did go out; consoles drop the repeat by `deviceId:seq`. An end-to-end test drops the broadcast on
one instance after the commit and checks that a console on the other still receives the fix.

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
`deviceId:seq`. If the id is older than the retained window, the server answers `gap: true`.
Only location fixes go through the stream; delivery and driver-status changes are reloaded over
HTTP on every connection (ADR-017). Each connection is told which instance serves it and when its
session ends, and the server closes it at that moment. Customer tracking pages use a separate
namespace and room per delivery and receive only that delivery's view.

**Consequences.** No location fix is lost when an instance is killed: a console on the dead
instance resumes from the stream, and a console on the surviving instance receives the fixes the
dead instance stored but never broadcast when the devices replay them (ADR-005). Both are tested:
end-to-end with two instances, and in the scale test with a console on each instance. The
guarantee is about fixes; for deliveries and driver status the console shows the current state
after a reconnect, not every change made while it was away. Browsers or proxies that block
WebSockets cannot connect; that is accepted for a dispatcher console and a tracking page.

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

**Context.** A road-network ETA needs routing data. The Geofabrik GCC extract is a 254 MB
download (the 25 September 2026 file), and it has not been processed on the development machine,
which is shared with other workloads; CI has no routing data at all.

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
Before anything is written, a cheap read checks that the delivery exists, belongs to the calling
device and can still be completed; multer stops reading an upload at `MAX_PHOTO_BYTES`. An
optional `Idempotency-Key` header makes a retry answer like the first attempt; the key is checked
again after the row lock, so two concurrent retries get the same answer, and a malformed key is
refused with 400. The capture time comes from the phone's clock and becomes the order's delivery
time in the order system, so it must fall between the pickup and the server's time, allowing
`MAX_CLOCK_SKEW_S` either way; otherwise the completion is refused with 422 `CLOCK_SKEW` before
the photo is stored.

**Consequences.** A driver cannot complete from across town. A spoofed GPS position still passes;
detecting that is out of scope. Photo storage is a local volume, so multiple API hosts need a
shared volume or object storage (listed under limitations).

## ADR-011 — Authentication: dispatcher sessions in memory, hashed device tokens, deny by default

**Context.** Three kinds of caller: dispatchers in a browser, driver devices, and the public
(tracking links, health checks).

**Decision.** Every route is closed unless marked `@Access('public' | 'dispatcher' | 'device')`.
Dispatchers sign in with a password (scrypt, compared in constant time, with a dummy hash for
unknown emails) and receive an HS256 JWT valid for `JWT_TTL_MINUTES` (8 hours, one shift); a live connection is
closed when the token expires. The console keeps it in memory only, not in
`localStorage` or a cookie, so a reload asks for the password again and no stored token is left
for other scripts to find. Devices enrol once with a one-time code a dispatcher creates and
receive an opaque `dvc_…` token; only its SHA-256 is stored. Login and enrolment are rate limited
per address (`AUTH_THROTTLE_LIMIT`), everything else per signed-in dispatcher or device, or per
address for anonymous calls (`THROTTLE_LIMIT`), with counters in Redis so the limits hold across
instances. That limit runs after authentication, so invalid device tokens are limited separately,
before the lookup: a token not shaped like one is refused without a query, and an address with
more than `AUTH_FAILURE_LIMIT` failures in a minute is refused with 429 for a minute. Behind nginx
the address comes from `X-Forwarded-For` (`TRUST_PROXY`). In production the API refuses to start
with the example secrets, unless `ALLOW_INSECURE_LOCAL_SECRETS` is set, as the compose stack does
for a machine of one's own; the API then logs a warning naming them.

A driver has one working phone. Dispatchers can list a driver's phones, revoke one (its token is
refused from the next request, and a driver left without a working phone goes off shift unless a
delivery is in hand), and deactivate a driver who has left: every phone is revoked, unused
enrolment codes stop working, and a database constraint keeps the driver off shift. Enrolling a
new phone revokes the earlier ones. The first version checked `revoked_at` but had no way to set
it, so a lost phone kept its access (found in review).

**Consequences.** No CSRF surface for the console, since there are no cookies. The price is
signing in again after a reload, which suits a console that stays open all shift. Because the
session token lives in the page's memory, the pages send a Content-Security-Policy with a fresh
nonce per response (`apps/web/proxy.ts`): scripts run only with that nonce, connections go only to
the page's origin, the API and the map asset hosts, and nothing may frame the page. Pages are
therefore rendered per request rather than at build time.

## ADR-012 — The driver app's queue lives in SQLite behind a small interface

**Context.** The queue is the part of the driver app that must be right: fixes recorded while
the app is in the background or offline must reach the server once each, in order, after any
crash. Expo modules only run on a device or simulator, which CI does not have.

**Decision.** Background location with `expo-location` and `expo-task-manager`, by time rather
than distance. expo-location documents `timeInterval` and `distanceInterval` as minimums that
must both be met, so by that documentation the first version (5 seconds and 10 metres) would send
nothing for a driver standing still, who would go stale after `DRIVER_STALE_AFTER_S` and be
skipped by automatic assignment (found in review; the app has not run on a device).
`distanceInterval` is now 0: Android reports every 5 seconds; iOS, which ignores the interval,
reports as positions arrive and the queue keeps at most one every 4 seconds; while the app is
open on shift, a heartbeat asks for a position after 30 seconds without one. The values live in
`location/policy.ts`, and a unit test checks them against the API's staleness default. Each fix
is written to SQLite first (`expo-sqlite`), taking the
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
Glyphs and sprites come from the Protomaps assets site (`protomaps.github.io`) at runtime;
Arabic labels use MapLibre's RTL text plugin, served locally. The credit ("Protomaps ©
OpenStreetMap contributors") is always shown in full, not as MapLibre's compact button: on the
console it sits at the bottom left with the zoom buttons at the top left, because the delivery
panels cover the right-hand side of the map, where they had hidden the credit (found in review).

**Consequences.** No tile server and no key. The tiles never leave the stack, but every page that
shows the Protomaps map fetches fonts and symbols from GitHub Pages, so that host sees visitors'
addresses; vendoring the needed glyph ranges and sprites would remove it. The extract ages;
rerunning the script refreshes it. Map data is © OpenStreetMap contributors under the ODbL,
credited visibly on every map; the Noto Sans glyphs are under the SIL Open Font Licence.

## ADR-014 — The scale test counts lost events against the database

**Context.** "No lost events when an instance dies" is the property that matters, and latency on
a shared development machine is noise. The first version killed `api-1` while its single console
connected through nginx, so a run could pass with the console on `api-2`, never reconnecting, and
test nothing; and a console that stays on the surviving instance was never measured.

**Decision.** `load/run-scale-test.sh` starts two API instances behind nginx, enrols N simulated
drivers and runs k6 (one virtual user per driver) and two consoles. Console A connects through
nginx; the server names the instance serving it, and that instance is killed with SIGKILL halfway
through. Console B connects straight to the other instance and must stay connected. The run then
compares every fix stored in the database with what each console received. It fails on any lost
event, on an empty k6 summary, when no fix was stored, when console A did not reconnect and
resume, when console B lost its connection, or when k6 saw a fix refused or never acknowledged
(a lost event is counted against the database, which does not hold those). It reports how many batches had to be replayed
(k6's duplicate answers and retries) and says when there were none, because only the end-to-end
test forces that path. Latency is measured from the batch's `sentAt` to arrival at the console,
on the same Docker host, and recorded in the run's folder; it is published in docs/scale-test.md
only from a run on a quiet machine (`--publish-timings`). Each published row links to a file in
`docs/scale-runs/` with the counts behind it; the raw results are not committed, because the
fleet file holds device tokens.

**Consequences.** The published claim is a count for both consoles, reproducible by anyone with
Docker. Whether a batch is in flight at the moment of the kill is chance at small scale, so the
replay path is covered deterministically by the end-to-end test rather than by this run. Latency
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

**Consequences.** Nothing in the stack depends on how the host shares files with containers.
It has been run on Docker Desktop for Windows; the CI workflow runs it on Ubuntu, but has not run
on GitHub yet, and macOS is untested. Running harness containers as root is acceptable for a
local test harness; the application images themselves run as an unprivileged user.

## ADR-017 — The console reloads drivers and deliveries on every connection

**Context.** Only location fixes go through the Redis stream a console resumes from. Delivery
changes and driver status changes sent while a console was disconnected were lost: after a
failover the console kept a cancelled delivery as open, missed new ones and counted drivers
wrongly until the page was reloaded. A failed first load was not retried either.

**Decision.** On every connection, the first and each reconnect, the console reloads drivers and
deliveries over HTTP, retrying with backoff and saying so while it fails. Status and delivery
events that arrive during the reload are applied again after it. Deliveries carry `updatedAt`
(set with `clock_timestamp()` after the row lock), and the console keeps the newest version of each
delivery whichever path brought it; positions keep the newest fix. The logic lives in
`apps/web/lib/dispatch-feed.ts`, outside React, and is unit-tested with a fake socket; a Playwright
test drops the console's WebSocket, changes deliveries while reconnecting is refused and checks
them after the reconnect.

**Consequences.** After a reconnect the console shows the current state of every driver and of the
last 200 deliveries, at the cost of two HTTP requests per reconnect. It does not show the changes
made while it was away one by one; the delivery's own history (its events) has them. Putting
delivery and status events into a resumable stream as well would give that, with more moving
parts; it is not needed for a console that shows current state.

## ADR-018 — The uuid advisory in Expo's build tooling is accepted

**Context.** `npm audit` reports GHSA-w5hq-g745-h8pq (moderate) for `uuid` 7.0.3, which `xcode`
3.0.1 pulls in through `@expo/config-plugins`; npm counts it once per dependent package, 10 in
all. The flaw is a missing bounds check in `v3`, `v5` and `v6` when the caller passes a buffer.

**Decision.** Accept it for now. `xcode` calls only `uuid.v4()` without a buffer, and the code runs
only in Expo's build tooling (config plugins, prebuild), never in the API, the web app or the
driver app's bundle. An npm `overrides` entry for `uuid` 11.1.1 was tried: npm did not apply it
through the workspace link, and a hand-edited lockfile made `npm ls` report the tree as invalid,
so it was not kept. Dependabot's Expo group will propose the fixed Expo release.

**Consequences.** `npm audit` is not clean, and the README says why. The finding is reviewed again
when Expo updates `@expo/config-plugins` or `xcode`.
