#!/usr/bin/env bash
set -euo pipefail

backup_input=${1:-}
if [[ -z "$backup_input" || ! -f "$backup_input" ]]; then
  echo "Usage: pnpm sources:restore:drill <backup.dump>" >&2
  exit 2
fi

script_directory=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
compose_file=${FEED_SUPPLIER_COMPOSE_FILE:-"$script_directory/../../server/compose.yaml"}
postgres_service=${FEED_SUPPLIER_POSTGRES_SERVICE:-feed-supplier-postgres}
database_name=${FEED_SUPPLIER_DATABASE_NAME:-feed_supplier}
database_user=${FEED_SUPPLIER_DATABASE_USER:-feed_supplier}
drill_database="feed_supplier_restore_$$_$RANDOM"
drill_database_created=false
compose_arguments=(-f "$compose_file")
if [[ -n "${FEED_SUPPLIER_MAIN_ENV_FILE:-}" ]]; then
  compose_arguments+=(--env-file "$FEED_SUPPLIER_MAIN_ENV_FILE")
fi
if [[ -n "${FEED_SUPPLIER_SOURCES_ENV_FILE:-}" ]]; then
  compose_arguments+=(--env-file "$FEED_SUPPLIER_SOURCES_ENV_FILE")
fi

drop_drill_database() {
  if [[ "$drill_database_created" != "true" ]]; then
    return
  fi
  docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
    psql --username="$database_user" --dbname=postgres --set=ON_ERROR_STOP=1 \
    --command="DROP DATABASE IF EXISTS $drill_database WITH (FORCE);" >/dev/null
}
trap drop_drill_database EXIT

checksum_input="${backup_input}.sha256"
if [[ -f "$checksum_input" ]]; then
  backup_directory=$(cd "$(dirname "$backup_input")" && pwd)
  if command -v shasum >/dev/null 2>&1; then
    (cd "$backup_directory" && shasum -a 256 -c "$(basename "$checksum_input")")
  else
    (cd "$backup_directory" && sha256sum --check "$(basename "$checksum_input")")
  fi
fi

docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  pg_restore --list <"$backup_input" >/dev/null
docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  createdb --username="$database_user" "$drill_database"
drill_database_created=true
docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  pg_restore --username="$database_user" --dbname="$drill_database" --exit-on-error --no-owner --no-acl \
  <"$backup_input"

count_query="SELECT json_build_array(
  (SELECT count(*) FROM source_credentials),
  (SELECT count(*) FROM source_route_instances),
  (SELECT count(*) FROM source_audit_events),
  (SELECT count(*) FROM feed_supplier_schema_migrations)
)::text;"
source_counts=$(docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  psql --username="$database_user" --dbname="$database_name" --tuples-only --no-align \
  --command="$count_query")
restored_counts=$(docker compose "${compose_arguments[@]}" --profile sources exec -T "$postgres_service" \
  psql --username="$database_user" --dbname="$drill_database" --tuples-only --no-align \
  --command="$count_query")

if [[ "$source_counts" != "$restored_counts" ]]; then
  echo "Restore drill failed: authoritative row counts differ" >&2
  echo "Source:   $source_counts" >&2
  echo "Restored: $restored_counts" >&2
  exit 1
fi

echo "Feed supplier restore drill passed with authoritative row counts $restored_counts"
