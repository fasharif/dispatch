#!/usr/bin/env bash
# Scale test: two API instances behind nginx with the Socket.IO Redis adapter, simulated drivers
# (k6), and a dispatcher console (the simulator's listener) connected through nginx. Halfway
# through, one API instance is killed with SIGKILL. The run then checks, against the database,
# that every fix the drivers had acknowledged reached the console: lost events must be zero.
#
#   load/run-scale-test.sh [--drivers 50] [--duration 120] [--interval 3] [--keep-stack]
#
# Results go to load/results/<timestamp>/. Latency percentiles are recorded there; see
# docs/scale-test.md for when they are published.
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
NETWORK=dispatch_default
export MSYS_NO_PATHCONV=1
mkdir -p "$RESULTS"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

cleanup() {
  docker rm -f dispatch-listener dispatch-k6 >/dev/null 2>&1 || true
  if [[ "$KEEP_STACK" == false ]]; then
    log "Stopping the stack"
    docker compose --profile stack down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Building images and starting the stack (two API instances, worker, nginx)"
docker build -q -f apps/api/Dockerfile --target tools -t dispatch-tools:local . >/dev/null
# Enrolment is rate-limited per address; the whole simulated fleet enrols from one container.
AUTH_THROTTLE_LIMIT=100000 docker compose --profile stack up -d --build --wait \
  postgres redis migrate api-1 api-2 worker nginx >/dev/null

# The harness containers run as root: they share the results folder, where the fleet file (device
# tokens) is readable by its owner only, and non-root users cannot read bind mounts on every host.
tools() {
  docker run --rm --user root --network "$NETWORK" --memory 256m \
    -v "$RESULTS_HOST:/work" -w /work dispatch-tools:local "$@"
}

log "Enrolling $DRIVERS simulated drivers"
tools seed --api http://nginx --drivers "$DRIVERS" --prefix "Load Driver" --fleet /work/fleet.json

LISTEN_FOR=$((DURATION + 40))
log "Starting the console listener for ${LISTEN_FOR}s"
docker run -d --name dispatch-listener --user root --network "$NETWORK" --memory 256m \
  -v "$RESULTS_HOST:/work" -w /work dispatch-tools:local \
  listen --api http://nginx --duration "$LISTEN_FOR" --out /work/listen-report.json >/dev/null
sleep 3

log "Running k6: $DRIVERS drivers, a fix every ${INTERVAL}s, for ${DURATION}s"
docker run -d --name dispatch-k6 --user root --network "$NETWORK" --memory 512m \
  -v "$LOAD_HOST:/scripts:ro" -v "$RESULTS_HOST:/results:ro" \
  -e FLEET=/results/fleet.json -e API_URL=http://nginx \
  -e DURATION="${DURATION}s" -e INTERVAL_S="$INTERVAL" \
  grafana/k6:2.3.0 run --quiet /scripts/drivers.ts >/dev/null

sleep $((DURATION / 2))
KILLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Killing dispatch-api-1 (SIGKILL) mid-test"
docker kill --signal KILL dispatch-api-1 >/dev/null

docker wait dispatch-k6 >/dev/null
docker logs dispatch-k6 > "$RESULTS/k6.log" 2>&1 || true
grep '^{' "$RESULTS/k6.log" | tail -n 1 > "$RESULTS/k6-summary.json" || true
if [[ ! -s "$RESULTS/k6-summary.json" ]]; then
  log "FAILED: k6 produced no summary (see $RESULTS/k6.log)"
  exit 1
fi
log "k6 finished: $(cat "$RESULTS/k6-summary.json")"
docker wait dispatch-listener >/dev/null
docker logs dispatch-listener > "$RESULTS/listener.log" 2>&1

log "Comparing what the database stored with what the console received"
set +e
tools verify --fleet /work/fleet.json --report /work/listen-report.json \
  --database-url postgresql://dispatch:dispatch@postgres:5432/dispatch --result /work/verify.json \
  | tee "$RESULTS/verify.log"
VERIFY_EXIT=${PIPESTATUS[0]}
set -e

cat > "$RESULTS/run.json" <<JSON
{
  "run": "$RUN",
  "drivers": $DRIVERS,
  "durationSeconds": $DURATION,
  "intervalSeconds": $INTERVAL,
  "killedInstance": "dispatch-api-1",
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
STORED="$(node -e "console.log(require('./$RESULTS/verify.json').storedFixes)")"
if [[ "$STORED" -eq 0 ]]; then
  log "FAILED: no fix was stored, so the run proves nothing"
  exit 1
fi
if [[ "$VERIFY_EXIT" -ne 0 ]]; then
  log "FAILED: some acknowledged fixes never reached the console (see $RESULTS/verify.log)"
  exit 1
fi
log "PASSED: no lost events. Results in $RESULTS"
