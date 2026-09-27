#!/usr/bin/env bash
# Scale test: two API instances behind nginx with the Socket.IO Redis adapter, simulated drivers
# (k6), and two dispatcher consoles (the simulator's listener):
#
#   - the "reconnecting" console connects through nginx, like the web console. The instance it
#     lands on is the one killed, so it must reconnect to the other and resume from the stream.
#   - the "surviving" console connects straight to the other instance and stays connected. It
#     receives fixes from the killed instance only through the Redis adapter, and replays.
#
# Halfway through, the reconnecting console's instance is killed with SIGKILL. The run then checks,
# against the database, that every fix the drivers had acknowledged reached both consoles: lost
# events must be zero. It fails as well when the kill did not disconnect the reconnecting console,
# or when the surviving console lost its connection, because the run then did not test failover.
#
#   load/run-scale-test.sh [--drivers 50] [--duration 120] [--interval 3] [--keep-stack]
#
# Results go to load/results/<timestamp>/. Latency percentiles are recorded there; see
# docs/scale-test.md for when they are published.
#
# Every name follows the compose project, so a second stack can run beside another one, e.g.
#   COMPOSE_PROJECT_NAME=dispatch-b DISPATCH_HTTP_PORT=57180 DISPATCH_POSTGRES_PORT=57532 \
#   DISPATCH_REDIS_PORT=57479 load/run-scale-test.sh
# Memory limits: API_MEMORY and POSTGRES_MEMORY (docker-compose.yml), K6_MEMORY (512m) and
# LISTENER_MEMORY (256m) here. The defaults have been used for runs of up to 50 drivers only.
set -euo pipefail

DRIVERS=50
DURATION=120
INTERVAL=3
KEEP_STACK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --drivers) DRIVERS="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --keep-stack) KEEP_STACK=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
ROOT_HOST="$(pwd -W 2>/dev/null || pwd)"
RUN="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS="load/results/$RUN"
RESULTS_HOST="$ROOT_HOST/load/results/$RUN"
LOAD_HOST="$ROOT_HOST/load"
# The project name decides the network, image and container names (docker-compose.yml).
PROJECT="${COMPOSE_PROJECT_NAME:-dispatch}"
export COMPOSE_PROJECT_NAME="$PROJECT"
NETWORK="${PROJECT}_default"
TOOLS_IMAGE="$PROJECT-tools:local"
K6_CONTAINER="$PROJECT-k6"
K6_MEMORY="${K6_MEMORY:-512m}"
LISTENER_MEMORY="${LISTENER_MEMORY:-256m}"
export MSYS_NO_PATHCONV=1
mkdir -p "$RESULTS"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  log "FAILED: $*"
  exit 1
}

cleanup() {
  local code=$?
  if [[ "$code" -ne 0 ]]; then
    # Keep the services' logs next to the results for diagnosis (CI uploads the folder).
    docker compose --profile stack logs --no-color --timestamps > "$RESULTS/stack.log" 2>&1 || true
  fi
  docker rm -f "$PROJECT-listener-lb" "$PROJECT-listener-survivor" "$K6_CONTAINER" \
    >/dev/null 2>&1 || true
  if [[ "$KEEP_STACK" == false ]]; then
    log "Stopping the stack"
    docker compose --profile stack down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Building images and starting the stack (two API instances, worker, nginx)"
docker build -q -f apps/api/Dockerfile --target tools -t "$TOOLS_IMAGE" . >/dev/null
# Enrolment is rate-limited per address; the whole simulated fleet enrols from one container.
AUTH_THROTTLE_LIMIT=100000 docker compose --profile stack up -d --build --wait \
  postgres redis migrate api-1 api-2 worker nginx >/dev/null

# The harness containers run as root: they share the results folder, where the fleet file (device
# tokens) is readable by its owner only, and non-root users cannot read bind mounts on every host.
tools() {
  docker run --rm --user root --network "$NETWORK" --memory "$LISTENER_MEMORY" \
    -v "$RESULTS_HOST:/work" -w /work "$TOOLS_IMAGE" "$@"
}

# listener <container> <api url> <report file>: a console that records what it receives.
listener() {
  docker run -d --name "$1" --user root --network "$NETWORK" --memory "$LISTENER_MEMORY" \
    -v "$RESULTS_HOST:/work" -w /work "$TOOLS_IMAGE" \
    listen --api "$2" --duration "$LISTEN_FOR" --out "/work/$3" >/dev/null
}

# serving_instance <container>: waits for the listener's first "session on <instance>" line.
serving_instance() {
  local instance=""
  for _ in $(seq 1 60); do
    instance="$(docker logs "$1" 2>&1 | sed -n 's/.*session on \(api-[0-9]\).*/\1/p' | head -n 1)"
    if [[ -n "$instance" ]]; then
      echo "$instance"
      return 0
    fi
    sleep 1
  done
  return 1
}

log "Enrolling $DRIVERS simulated drivers"
tools seed --api http://nginx --drivers "$DRIVERS" --prefix "Load Driver" --fleet /work/fleet.json

LISTEN_FOR=$((DURATION + 40))
log "Starting the reconnecting console (through nginx) for ${LISTEN_FOR}s"
listener "$PROJECT-listener-lb" http://nginx listen-lb.json
VICTIM="$(serving_instance "$PROJECT-listener-lb")" ||
  fail "the console behind nginx did not report its instance (see docker logs $PROJECT-listener-lb)"
if [[ "$VICTIM" == api-1 ]]; then SURVIVOR=api-2; else SURVIVOR=api-1; fi
log "It is served by $VICTIM, which will be killed; starting the surviving console on $SURVIVOR"
listener "$PROJECT-listener-survivor" "http://$SURVIVOR:3000" listen-survivor.json
serving_instance "$PROJECT-listener-survivor" >/dev/null ||
  fail "the console on $SURVIVOR did not connect (see docker logs $PROJECT-listener-survivor)"

log "Running k6: $DRIVERS drivers, a fix every ${INTERVAL}s, for ${DURATION}s"
docker run -d --name "$K6_CONTAINER" --user root --network "$NETWORK" --memory "$K6_MEMORY" \
  -v "$LOAD_HOST:/scripts:ro" -v "$RESULTS_HOST:/results:ro" \
  -e FLEET=/results/fleet.json -e API_URL=http://nginx \
  -e DURATION="${DURATION}s" -e INTERVAL_S="$INTERVAL" \
  grafana/k6:2.3.0 run --quiet /scripts/drivers.ts >/dev/null

sleep $((DURATION / 2))
KILLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Killing $VICTIM (SIGKILL) mid-test"
docker compose --profile stack kill --signal KILL "$VICTIM" >/dev/null 2>&1

docker wait "$K6_CONTAINER" >/dev/null
docker logs "$K6_CONTAINER" > "$RESULTS/k6.log" 2>&1 || true
grep '^{' "$RESULTS/k6.log" | tail -n 1 > "$RESULTS/k6-summary.json" || true
[[ -s "$RESULTS/k6-summary.json" ]] || fail "k6 produced no summary (see $RESULTS/k6.log)"
log "k6 finished: $(cat "$RESULTS/k6-summary.json")"
for name in lb survivor; do
  docker wait "$PROJECT-listener-$name" >/dev/null
  docker logs "$PROJECT-listener-$name" > "$RESULTS/listener-$name.log" 2>&1
done

log "Comparing what the database stored with what each console received"
set +e
VERIFY_EXIT=0
for name in lb survivor; do
  tools verify --fleet /work/fleet.json --report "/work/listen-$name.json" \
    --database-url postgresql://dispatch:dispatch@postgres:5432/dispatch \
    --result "/work/verify-$name.json" | tee "$RESULTS/verify-$name.log"
  code=${PIPESTATUS[0]}
  [[ "$code" -ne 0 ]] && VERIFY_EXIT=$code
done
set -e

cat > "$RESULTS/run.json" <<JSON
{
  "run": "$RUN",
  "drivers": $DRIVERS,
  "durationSeconds": $DURATION,
  "intervalSeconds": $INTERVAL,
  "killedInstance": "$VICTIM",
  "survivingInstance": "$SURVIVOR",
  "killedAt": "$KILLED_AT",
  "gitCommit": "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "host": {
    "os": "$(uname -s)",
    "dockerCpus": $(docker info --format '{{.NCPU}}'),
    "dockerMemoryBytes": $(docker info --format '{{.MemTotal}}'),
    "dockerServerVersion": "$(docker info --format '{{.ServerVersion}}')"
  }
}
JSON

node load/report.mjs "$RESULTS"
# json <file> <expression over r>: reads a value from one of the run's JSON files.
json() { node -e "const r = require('./$RESULTS/$1'); console.log($2)"; }
[[ "$(json verify-lb.json r.storedFixes)" -gt 0 ]] ||
  fail "no fix was stored, so the run proves nothing"
[[ "$(json listen-lb.json r.resumes)" -gt 0 ]] ||
  fail "killing $VICTIM did not make the console behind nginx reconnect and resume"
[[ "$(json listen-survivor.json 'r.connects === 1 && r.disconnects === 0')" == true ]] ||
  fail "the console on $SURVIVOR lost its connection, so the run did not test that path"
[[ "$VERIFY_EXIT" -eq 0 ]] ||
  fail "some acknowledged fixes never reached a console (see $RESULTS/verify-*.log)"
if [[ "$(json k6-summary.json 'r.fixesDuplicate + r.batchRetries')" -eq 0 ]]; then
  log "Note: k6 counted no duplicate answers or retries, so no batch stored by $VICTIM had to be"
  log "replayed in this run. The end-to-end test two-instances.test.ts covers that path."
fi
log "PASSED: no lost events. Results in $RESULTS"
