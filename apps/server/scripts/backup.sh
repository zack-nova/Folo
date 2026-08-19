#!/usr/bin/env bash
set -euo pipefail

backup_output=${1:-}
if [[ -z "$backup_output" ]]; then
  echo "Usage: pnpm server:backup <output.dump>" >&2
  exit 2
fi
if [[ -e "$backup_output" ]]; then
  echo "Refusing to overwrite existing backup: $backup_output" >&2
  exit 2
fi
checksum_output="${backup_output}.sha256"
if [[ -e "$checksum_output" ]]; then
  echo "Refusing to overwrite existing checksum: $checksum_output" >&2
  exit 2
fi

script_directory=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
compose_file=${FOLO_COMPOSE_FILE:-"$script_directory/../compose.yaml"}
postgres_service=${FOLO_POSTGRES_SERVICE:-postgres}
database_name=${FOLO_DATABASE_NAME:-folo}
database_user=${FOLO_DATABASE_USER:-folo}
temporary_output="${backup_output}.partial.$$"
temporary_checksum="${checksum_output}.partial.$$"

cleanup() {
  rm -f "$temporary_output"
  rm -f "$temporary_checksum"
}
trap cleanup EXIT

docker compose -f "$compose_file" exec -T "$postgres_service" \
  pg_dump --username="$database_user" --dbname="$database_name" --format=custom --no-owner --no-acl \
  >"$temporary_output"

docker compose -f "$compose_file" exec -T "$postgres_service" pg_restore --list \
  <"$temporary_output" >/dev/null

if command -v shasum >/dev/null 2>&1; then
  checksum=$(shasum -a 256 "$temporary_output" | awk '{print $1}')
else
  checksum=$(sha256sum "$temporary_output" | awk '{print $1}')
fi
echo "$checksum  $(basename "$backup_output")" >"$temporary_checksum"

mv -n "$temporary_output" "$backup_output"
if [[ -e "$temporary_output" ]]; then
  echo "Refusing to overwrite existing backup: $backup_output" >&2
  exit 2
fi
mv -n "$temporary_checksum" "$checksum_output"
if [[ -e "$temporary_checksum" ]]; then
  echo "Refusing to overwrite existing checksum: $checksum_output" >&2
  exit 2
fi
trap - EXIT
echo "Verified PostgreSQL backup written to $backup_output with checksum $checksum_output"
