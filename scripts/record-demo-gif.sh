#!/usr/bin/env bash
# Records docs/screenshots/demo.gif: the dispatcher console for 40 seconds while the simulator's
# demo runs (one frame a second), played back five times faster. Needs the compose stack and the
# demo running (README, quick start), Playwright's Chromium and Docker (ffmpeg runs in a container).
#
#   scripts/record-demo-gif.sh [--url http://localhost:57080]
set -euo pipefail

URL=http://localhost:57080
FFMPEG=jrottenberg/ffmpeg:8-alpine
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
FRAMES=docs/screenshots/.frames
rm -rf "$FRAMES"
trap 'rm -rf "$FRAMES"' EXIT
(cd apps/web && WEB_URL="$URL" API_URL="$URL" node scripts/capture-demo-frames.mjs "../../$FRAMES" 40 1000)

ROOT_HOST="$(pwd -W 2>/dev/null || pwd)"
export MSYS_NO_PATHCONV=1
# 5 frames a second, 800 pixels wide, one palette for the whole clip (smaller file, no flicker).
docker run --rm --name dispatch-ffmpeg --memory 512m -v "$ROOT_HOST:/w" -w /w "$FFMPEG" \
  -loglevel error -y -framerate 5 -i "$FRAMES/%03d.png" \
  -vf 'scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4' \
  -loop 0 docs/screenshots/demo.gif
ls -l docs/screenshots/demo.gif
