#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
backup=${1:?Usage: ./restore.sh /absolute/path/to/ledger-backup.db}
backup=$(realpath "$backup")
[[ -f "$backup" ]] || { echo 'Backup file not found' >&2; exit 1; }
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
# Validate before stopping the service. The helper uses the same image and data volume.
check=$(docker compose run --rm -T --no-deps --user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --volume "$backup:/restore.db:ro" --entrypoint sqlite3 ledger 'file:/restore.db?mode=ro&immutable=1' 'PRAGMA integrity_check; SELECT count(*) FROM users;')
[[ "$check" == $'ok\n1' ]] || { echo 'Backup integrity or account validation failed' >&2; exit 1; }
./backup.sh
docker compose stop ledger
trap 'docker compose up -d ledger >/dev/null 2>&1 || true' EXIT
docker compose run --rm -T --no-deps --user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --volume "$backup:/restore.db:ro" --entrypoint sh ledger -ec 'cp /restore.db /data/ledger.restore.db; chmod 600 /data/ledger.restore.db; chown 10001:10001 /data/ledger.restore.db; rm -f /data/ledger.db-wal /data/ledger.db-shm; mv /data/ledger.restore.db /data/ledger.db'
docker compose up -d --wait --wait-timeout 90 ledger
trap - EXIT
echo 'Backup restored; service is healthy'
