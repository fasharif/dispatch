#!/usr/bin/env bash
# Extracts a Dubai basemap from a daily Protomaps planet build into
# apps/web/public/tiles/dubai.pmtiles (about 13 MB), which the console and the tracking page use
# when it is present. Without it, the maps fall back to MapLibre's demo tiles (country outlines).
#
#   scripts/fetch-basemap.sh                 the build named below
#   scripts/fetch-basemap.sh --build 20261001
#
# Only the tiles inside the box are downloaded (HTTP range requests), not the whole planet.
# Builds are kept for a limited time; https://maps.protomaps.com/builds/ lists the current ones.
#
# Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL).
# Basemap schema and styles: Protomaps (https://github.com/protomaps/basemaps).
set -euo pipefail

IMAGE=protomaps/go-pmtiles:v1.31.2
BUILD=20260925
# west,south,east,north: Dubai from Jebel Ali to Sharjah's edge.
BBOX=54.95,24.85,55.65,25.40
MAXZOOM=14
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [[ ! "$BUILD" =~ ^[0-9]{8}$ ]]; then
  echo "--build must be a date such as 20260925" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
mkdir -p apps/web/public/tiles
OUT_HOST="$(pwd -W 2>/dev/null || pwd)/apps/web/public/tiles"
export MSYS_NO_PATHCONV=1

echo "Extracting $BBOX (zoom 0-$MAXZOOM) from https://build.protomaps.com/$BUILD.pmtiles"
# Root inside the container: bind mounts are not writable by other users on every host.
docker run --rm --name dispatch-fetch-basemap --user root --memory 512m \
  -v "$OUT_HOST:/out" "$IMAGE" \
  extract "https://build.protomaps.com/$BUILD.pmtiles" /out/dubai.pmtiles \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"
docker run --rm --user root -v "$OUT_HOST:/out:ro" "$IMAGE" show /out/dubai.pmtiles | head -n 5
echo "Done: apps/web/public/tiles/dubai.pmtiles"
