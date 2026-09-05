#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p backups
name="ledger-$(date -u +%Y%m%dT%H%M%S)-$$.db"
container_path="/data/.$name"
docker compose exec -T ledger sqlite3 /data/ledger.db ".backup '$container_path'"
trap 'docker compose exec -T ledger rm -f "$container_path" >/dev/null 2>&1 || true' EXIT
docker compose cp "ledger:$container_path" "backups/$name"
chmod 600 "backups/$name"
printf 'Backup saved: %s/backups/%s\n' "$PWD" "$name"
