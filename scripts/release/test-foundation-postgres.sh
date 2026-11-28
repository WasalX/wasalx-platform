#!/usr/bin/env bash
set -euo pipefail

# Last foundation-postgres base before the Wolfi switch.
previous=cgr.dev/chainguard/postgres:latest@sha256:9cc085289d7ef0174f35f2ff1e514624c3305c4a26215d8e89e3e277e3377d03
candidate=$1
scratch=$(mktemp -d)
volume=
containers=()
cleanup() {
  local status=$?
  if ((status != 0)); then
    for container in "${containers[@]}"; do
      docker logs "$container" || true
    done
  fi
  if ((${#containers[@]} > 0)); then
    docker rm --force --volumes "${containers[@]}" >/dev/null || status=1
  fi
  if [[ -n "$volume" ]]; then
    docker volume rm "$volume" >/dev/null || status=1
  fi
  rm -r -- "$scratch" || status=1
  exit "$status"
}
trap cleanup EXIT

docker pull --platform linux/amd64 "$previous"
base_title='{{index .Config.Labels "dev.chainguard.image.title"}}'
previous_base=$(docker image inspect --format "$base_title" "$previous")
candidate_base=$(docker image inspect --format "$base_title" "$candidate")
printf 'Foundation base: %s -> %s\n' "$previous_base" "$candidate_base"
[[ $candidate_base == wolfi-base ]]

cat >"$scratch/init.sql" <<'SQL'
CREATE EXTENSION amcheck;
CREATE EXTENSION pgcrypto;
CREATE TABLE labels (id integer PRIMARY KEY, label text NOT NULL);
INSERT INTO labels VALUES (1, 'a'), (2, 'Á'), (3, 'ä'), (4, 'z'), (5, 'Å'), (6, 'é');
CREATE INDEX labels_text_idx ON labels (label);
CREATE INDEX labels_icu_idx ON labels (label COLLATE "en-US-x-icu");
SQL
chmod 0444 "$scratch/init.sql"

create_fixture() {
  docker create --pull never --network none \
    --env POSTGRES_USER=postgres --env POSTGRES_PASSWORD=wasalx-ci-admin --env POSTGRES_DB=image_compat \
    --mount "type=bind,src=$scratch/init.sql,dst=/var/lib/postgres/initdb/00-compat.sql,readonly" \
    "$@"
}

volume=$(docker volume create)
data_mount="type=volume,src=$volume,dst=/var/lib/postgresql/data"
before=$(create_fixture --user 70:70 --mount "$data_mount" "$previous" -c listen_addresses=127.0.0.1)
containers+=("$before")
after=$(create_fixture --mount "$data_mount" "$candidate" -c listen_addresses=127.0.0.1)
containers+=("$after")

inventory() {
  docker export "$1" | tar -tf - | LC_ALL=C sort >"$scratch/$2.paths"
  docker cp "$1:/lib/apk/db/installed" - | tar -xOf - |
    awk '/^P:/ { name = substr($0, 3) } /^V:/ { print name "=" substr($0, 3) }' |
    LC_ALL=C sort >"$scratch/$2.packages"
  test -s "$scratch/$2.packages"
  docker inspect "$1" | jq -c '.[0].Config |
    {User, WorkingDir, Entrypoint, Cmd: (.Cmd // []), Healthcheck,
     Env: ([.Env[] | select(test("^(LANG|PGDATA)="))] | sort)}' >"$scratch/$2.contract"
}
inventory "$before" before
inventory "$after" after
for report in paths packages; do
  diff -u "$scratch/before.$report" "$scratch/after.$report" || [[ $? == 1 ]]
done
diff -u "$scratch/before.contract" "$scratch/after.contract"

start_fixture() {
  local container=$1 attempt
  docker start "$container" >/dev/null
  for ((attempt = 0; attempt < 30; attempt++)); do
    if docker exec "$container" pg_isready -q -h 127.0.0.1 -U postgres -d image_compat; then
      return
    fi
    [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || return 1
    sleep 1
  done
  echo 'PostgreSQL did not become ready' >&2
  return 1
}

client() {
  local container=$1
  shift
  docker exec -i --env PGHOST=127.0.0.1 --env PGUSER=postgres --env PGPASSWORD=wasalx-ci-admin \
    "$container" "$@"
}
sql() {
  local container=$1 database=$2
  shift 2
  client "$container" psql -X -v ON_ERROR_STOP=1 -d "$database" "$@"
}
collations() {
  sql "$1" image_compat -At <<'SQL'
SELECT datlocprovider, datcollate, datctype, datcollversion
FROM pg_database
WHERE datname = current_database() AND datcollversion = pg_database_collation_actual_version(oid);
SELECT collprovider, collname, collversion
FROM pg_collation
WHERE collname = 'en-US-x-icu' AND collversion = pg_collation_actual_version(oid);
SQL
}
check_data() {
  local container=$1 database=$2 labels
  labels=$(sql "$container" "$database" -Atc "SELECT string_agg(label, ',' ORDER BY id) FROM labels")
  [[ $labels == 'a,Á,ä,z,Å,é' ]]
  sql "$container" "$database" <<'SQL'
SELECT bt_index_parent_check('labels_text_idx', true, true);
SELECT bt_index_parent_check('labels_icu_idx', true, true);
SELECT digest('postgres image compatibility', 'sha256');
SQL
}

start_fixture "$before"
baseline=$(collations "$before")
printf 'Baseline collation provider, locale and version:\n%s\n' "$baseline"
[[ $baseline == c\|*en_US* && $baseline == *$'\ni|en-US-x-icu|'* ]]
docker stop --signal SIGINT --time 10 "$before" >/dev/null
[[ $(docker inspect --format '{{.State.ExitCode}}' "$before") == 0 ]]

start_fixture "$after"
actual=$(collations "$after")
printf 'Existing volume collation provider, locale and version:\n%s\n' "$actual"
[[ $actual == "$baseline" ]]
check_data "$after" image_compat
test "$(sql "$after" image_compat -Atc "SELECT count(*) FROM pg_available_extensions WHERE name = 'pgaudit'")" = 1
client "$after" pg_dump -Fc image_compat >"$scratch/image_compat.dump"
client "$after" createdb image_restored
client "$after" pg_restore --exit-on-error -d image_restored <"$scratch/image_compat.dump"
check_data "$after" image_restored

fresh=$(create_fixture --mount type=volume,dst=/var/lib/postgresql/data "$candidate" -c listen_addresses=127.0.0.1)
containers+=("$fresh")
start_fixture "$fresh"
[[ $(collations "$fresh") == "$baseline" ]]
check_data "$fresh" image_compat

docker logs "$after" >"$scratch/after.log" 2>&1
docker logs "$fresh" >"$scratch/fresh.log" 2>&1
if grep -Ei 'collation.*(mismatch|has no actual version)' "$scratch/"*.log; then
  exit 1
fi
echo 'PostgreSQL 18 existing volume, collation versions, amcheck, dump/restore and fresh initialization passed.'
