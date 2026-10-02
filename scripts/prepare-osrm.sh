#!/usr/bin/env bash
# Prepares road-network data for the OSRM compose profile (road-based ETAs).
#
#   scripts/prepare-osrm.sh
#       The Geofabrik extract of the GCC states: 253,745,659 bytes for the 25 September 2026 file
#       (Content-Length, checked with curl -I on 26 September 2026). It has not been processed on
#       the development machine, so its memory needs are not measured here; set
#       OSRM_PREPARE_MEMORY (default 3g) to what Docker can give.
#   scripts/prepare-osrm.sh --bbox 25.08,55.17,25.16,55.25
#       Only the roads inside a south,west,north,east box, from the Overpass API. Small and quick,
#       for trying the integration out; tested with OSRM_PREPARE_MEMORY=1500m.
#
# Then: docker compose --profile osrm up -d osrm, and OSRM_URL=http://localhost:57500 for the API
# (http://osrm:5000 inside the compose stack).
#
# Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL).
set -euo pipefail

IMAGE=ghcr.io/project-osrm/osrm-backend:v26.9.0-debian
GCC_URL=https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf
# Overpass refuses requests without a User-Agent (HTTP 406).
AGENT="dispatch-prepare-osrm/1 (portfolio project)"
BBOX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bbox) BBOX="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p osrm/data
DATA_HOST="$(pwd -W 2>/dev/null || pwd)/osrm/data"
export MSYS_NO_PATHCONV=1
rm -f osrm/data/region.*

if [[ -n "$BBOX" ]]; then
  if [[ ! "$BBOX" =~ ^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$ ]]; then
    echo "--bbox must be south,west,north,east in decimal degrees" >&2
    exit 2
  fi
  echo "Downloading roads inside $BBOX from the Overpass API"
  curl -sSf --retry 3 -A "$AGENT" -o osrm/data/region.osm \
    --data-urlencode "data=[out:xml][timeout:120];(way[\"highway\"]($BBOX);>;);out body;" \
    https://overpass-api.de/api/interpreter
  INPUT=/data/region.osm
else
  echo "Downloading $GCC_URL"
  curl -sSfL --retry 3 -A "$AGENT" -o osrm/data/region.osm.pbf "$GCC_URL"
  INPUT=/data/region.osm.pbf
fi

run() {
  docker run --rm --name dispatch-osrm-prepare --memory "${OSRM_PREPARE_MEMORY:-3g}" \
    -v "$DATA_HOST:/data" "$IMAGE" "$@"
}
echo "Extracting the car profile"
run osrm-extract -p /opt/car.lua "$INPUT"
echo "Partitioning and customising (multi-level Dijkstra)"
run osrm-partition /data/region.osrm
run osrm-customize /data/region.osrm
echo "Done: osrm/data/region.osrm*. Start it with: docker compose --profile osrm up -d osrm"
