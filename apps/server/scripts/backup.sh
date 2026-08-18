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

script_directory=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
compose_file="$script_directory/../compose.yaml"
temporary_output="${backup_output}.partial.$$"

cleanup() {
  rm -f "$temporary_output"
}
trap cleanup EXIT

docker compose -f "$compose_file" exec -T postgres \
  pg_dump --username=folo --dbname=folo --format=custom --no-owner --no-acl \
  >"$temporary_output"

docker compose -f "$compose_file" exec -T postgres pg_restore --list \
  <"$temporary_output" >/dev/null

mv -n "$temporary_output" "$backup_output"
if [[ -e "$temporary_output" ]]; then
  echo "Refusing to overwrite existing backup: $backup_output" >&2
  exit 2
fi
trap - EXIT
echo "Verified PostgreSQL backup written to $backup_output"
