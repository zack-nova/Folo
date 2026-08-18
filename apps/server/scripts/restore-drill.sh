#!/usr/bin/env bash
set -euo pipefail

backup_input=${1:-}
if [[ -z "$backup_input" || ! -f "$backup_input" ]]; then
  echo "Usage: pnpm server:restore:drill <backup.dump>" >&2
  exit 2
fi

script_directory=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
compose_file="$script_directory/../compose.yaml"
drill_database="folo_restore_drill_$$_$RANDOM"
drill_database_created=false

drop_drill_database() {
  if [[ "$drill_database_created" != "true" ]]; then
    return
  fi
  docker compose -f "$compose_file" exec -T postgres \
    psql --username=folo --dbname=postgres --set=ON_ERROR_STOP=1 \
    --command="DROP DATABASE IF EXISTS $drill_database WITH (FORCE);" >/dev/null
}
trap drop_drill_database EXIT

docker compose -f "$compose_file" exec -T postgres \
  createdb --username=folo "$drill_database"
drill_database_created=true
docker compose -f "$compose_file" exec -T postgres \
  pg_restore --username=folo --dbname="$drill_database" --exit-on-error --no-owner --no-acl \
  <"$backup_input"

table_count=$(docker compose -f "$compose_file" exec -T postgres \
  psql --username=folo --dbname="$drill_database" --tuples-only --no-align \
  --command="SELECT count(*) FROM pg_tables WHERE schemaname = 'public';")
if [[ ! "$table_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "Restore drill failed: restored database has no public tables" >&2
  exit 1
fi

count_query="SELECT json_build_array(
  (SELECT count(*) FROM \"user\"),
  (SELECT count(*) FROM feeds),
  (SELECT count(*) FROM entries),
  (SELECT count(*) FROM subscriptions),
  (SELECT count(*) FROM lists),
  (SELECT count(*) FROM list_subscriptions),
  (SELECT count(*) FROM entry_readability),
  (SELECT count(*) FROM instance_ownership)
)::text;"
restored_counts=$(docker compose -f "$compose_file" exec -T postgres \
  psql --username=folo --dbname="$drill_database" --tuples-only --no-align \
  --command="$count_query")

echo "Restore drill passed with $table_count public tables and authoritative row counts $restored_counts"
