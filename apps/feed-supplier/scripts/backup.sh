#!/usr/bin/env bash
set -euo pipefail

backup_output=${1:-}
if [[ -z "$backup_output" ]]; then
  echo "Usage: pnpm sources:backup <output.dump>" >&2
  exit 2
fi
if [[ -e "$backup_output" || -e "${backup_output}.sha256" ]]; then
  echo "Refusing to overwrite an existing backup or checksum" >&2
  exit 2
fi

script_directory=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
compose_file=${FEED_SUPPLIER_COMPOSE_FILE:-"$script_directory/../../server/compose.yaml"}
postgres_service=${FEED_SUPPLIER_POSTGRES_SERVICE:-feed-supplier-postgres}
database_name=${FEED_SUPPLIER_DATABASE_NAME:-feed_supplier}
database_user=${FEED_SUPPLIER_DATABASE_USER:-feed_supplier}
temporary_output="${backup_output}.partial.$$"
temporary_checksum="${backup_output}.sha256.partial.$$"
compose_arguments=(-f "$compose_file")
if [[ -n "${FEED_SUPPLIER_MAIN_ENV_FILE:-}" ]]; then
  compose_arguments+=(--env-file "$FEED_SUPPLIER_MAIN_ENV_FILE")
fi
if [[ -n "${FEED_SUPPLIER_SOURCES_ENV_FILE:-}" ]]; then
  compose_arguments+=(--env-file "$FEED_SUPPLIER_SOURCES_ENV_FILE")
fi

cleanup() {
  rm -f "$temporary_output" "$temporary_checksum"
}
trap cleanup EXIT

docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  pg_dump --username="$database_user" --dbname="$database_name" --format=custom --no-owner --no-acl \
  >"$temporary_output"
docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  pg_restore --list <"$temporary_output" >/dev/null

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
mv -n "$temporary_checksum" "${backup_output}.sha256"
if [[ -e "$temporary_checksum" ]]; then
  echo "Refusing to overwrite existing checksum: ${backup_output}.sha256" >&2
  exit 2
fi
trap - EXIT
echo "Verified feed supplier backup written to $backup_output"
