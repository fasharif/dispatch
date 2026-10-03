#!/usr/bin/env bash
# Fails when the CI workflow's service containers and docker-compose.yml run different PostgreSQL
# or Redis images. Dependabot updates the images in docker-compose.yml but not the services in
# .github/workflows/ci.yml, so its pull request fails here until the workflow uses the same tag
# (ADR-019).
#
#   scripts/check-service-images.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# The distinct references to one image repository (e.g. redis) in a file, one per line.
images() {
  sed -n 's|^ *image: *\('"$2"':[^ ]*\) *$|\1|p' "$1" | sort -u
}

# A list of references on one line, or "none".
joined() {
  if [[ -n "$1" ]]; then
    echo "${1//$'\n'/, }"
  else
    echo none
  fi
}

status=0
for repository in postgis/postgis redis; do
  compose="$(images docker-compose.yml "$repository")"
  workflow="$(images .github/workflows/ci.yml "$repository")"
  if [[ -n "$compose" && "$compose" == "$workflow" ]]; then
    echo "$repository: $compose in both"
  else
    echo "$repository: docker-compose.yml uses $(joined "$compose")," \
      ".github/workflows/ci.yml uses $(joined "$workflow")" >&2
    status=1
  fi
done
exit "$status"
