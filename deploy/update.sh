#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
image=${1:?Usage: ./update.sh ghcr.io/owner/ledger@sha256:digest}
if [[ ! "$image" =~ ^ghcr\.io/[a-z0-9._/-]+(@sha256:[a-f0-9]{64}|:[a-zA-Z0-9._-]+)$ ]]; then
  echo 'Invalid GHCR image reference' >&2
  exit 1
fi
[[ -f .env ]] || { echo 'Configure deploy/.env first' >&2; exit 1; }
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
old_image=$(sed -n 's/^LEDGER_IMAGE=//p' .env | tail -1)
[[ -n "$old_image" ]] || { echo 'LEDGER_IMAGE is missing from .env' >&2; exit 1; }
export LEDGER_IMAGE="$image"
docker compose pull ledger
if docker compose ps --status running --services | grep -qx ledger; then
  ./backup.sh
fi
if docker compose up -d --wait --wait-timeout 90 ledger; then
  image_tmp=$(mktemp .env.XXXXXX)
  awk -v image="$image" '/^LEDGER_IMAGE=/{print "LEDGER_IMAGE=" image;next}{print}' .env > "$image_tmp"
  chmod 600 "$image_tmp"
  mv "$image_tmp" .env
  printf 'Deployment healthy: %s\n' "$image"
else
  echo 'Health check failed; restoring previous image' >&2
  export LEDGER_IMAGE="$old_image"
  docker compose up -d --wait --wait-timeout 90 ledger
  exit 1
fi
