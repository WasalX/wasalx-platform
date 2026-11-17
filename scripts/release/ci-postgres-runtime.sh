#!/usr/bin/env bash
set -euo pipefail

# GitHub services start before steps; this owned fixture starts only after the phase guard.
[[ $# == 7 && $1 == node && $2 == "${WASALX_RELEASE_EVIDENCE_SCRIPT:?Set WASALX_RELEASE_EVIDENCE_SCRIPT}" && $3 == run && $4 == --gate \
   && $5 == postgres && $6 == --candidate-sha && $7 == "$GITHUB_SHA" && $7 =~ ^[a-f0-9]{40}$ ]]
[[ $GITHUB_RUN_ID =~ ^[1-9][0-9]*$ && $GITHUB_RUN_ATTEMPT =~ ^[1-9][0-9]*$ && $GITHUB_JOB == postgres ]]
name="wasalx-ci-postgres-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"
owner="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"
image=postgres:17.10-alpine3.23@sha256:8189a1f6e40904781fc9e2612687877791d21679866db58b1de996b31fc312e4
scratch=$(mktemp -d "$RUNNER_TEMP/wasalx-ci-postgres.XXXXXX")
cidfile="$scratch/container.cid"
identity_format='{{.Id}}|{{.Name}}|{{.Config.Image}}|{{index .Config.Labels "io.wasalx.ci-postgres-owner"}}|{{index .Config.Labels "io.wasalx.candidate-sha"}}'
active_pid=
cleanup_deadline_ms=
run_interruptible() {
  "$@" &
  active_pid=$!
  local result=0
  wait "$active_pid" || result=$?
  active_pid=
  return "$result"
}
clock_ms() {
  local uptime seconds fraction
  read -r uptime _ < /proc/uptime
  seconds=${uptime%.*}
  fraction=${uptime#*.}000
  now_ms=$((10#$seconds * 1000 + 10#${fraction:0:3}))
}
docker_control() {
  if [[ -n "$cleanup_deadline_ms" ]]; then
    clock_ms
    local remaining=$((cleanup_deadline_ms - now_ms)) budget
    (( remaining > 0 )) || return 1
    printf -v budget '%d.%03ds' "$((remaining / 1000))" "$((remaining % 1000))"
    timeout --signal=KILL "$budget" docker "$@"
  else
    run_interruptible timeout --kill-after=2s 10s docker "$@"
  fi
}
docker_capture() {
  local variable=$1 result=0
  shift
  docker_control "$@" > "$scratch/docker-output" || result=$?
  printf -v "$variable" '%s' "$(cat "$scratch/docker-output")"
  return "$result"
}
cancel() {
  trap '' INT TERM
  clock_ms
  # Match the browser lifecycle's shared INT/TERM settlement budgets.
  cleanup_deadline_ms=$((now_ms + $2))
  if [[ -n "$active_pid" ]]; then
    # GNU timeout owns its process group; a plain guard/sleep owns only its PID.
    kill -KILL -- "-$active_pid" 2>/dev/null || kill -KILL "$active_pid" 2>/dev/null || true
    wait "$active_pid" 2>/dev/null || true
    active_pid=
  fi
  exit "$1"
}
creation_attempted=false
cleanup() {
  status=$?
  trap - EXIT
  trap '' INT TERM
  set +e
  container_id=
  if [[ -f "$cidfile" && ! -L "$cidfile" ]]; then
    container_id=$(cat "$cidfile")
  elif [[ -e "$cidfile" || -L "$cidfile" ]]; then
    printf 'PostgreSQL fixture identity unverified\n' >&2
    status=1
  elif [[ $creation_attempted == true ]]; then
    # A timed-out create can succeed before Docker writes the CID file. The
    # exact name was proved absent before this attempt; never recover a collision.
    docker_capture container_id ps --all --quiet --no-trunc --filter "name=^/$name$"
    if [[ $? != 0 || ! $container_id =~ ^[a-f0-9]{64}$ ]]; then
      printf 'PostgreSQL fixture creation/cleanup unverified\n' >&2
      container_id=
      status=1
    fi
  fi
  if [[ -n "$container_id" ]]; then
    # Never remove an object whose complete ID/name/image/source ownership differs.
    expected="$container_id|/$name|$image|$owner|$GITHUB_SHA"
    docker_capture actual inspect --format "$identity_format" "$container_id"
    if [[ $? != 0 || ! $container_id =~ ^[a-f0-9]{64}$ || $actual != "$expected" ]] \
       || ! docker_control rm --force "$container_id"; then
      printf 'PostgreSQL fixture cleanup unverified\n' >&2
      status=1
    else
      docker_capture remaining ps --all --quiet --no-trunc --filter "id=$container_id"
      if [[ $? != 0 || -n "$remaining" ]]; then
        printf 'PostgreSQL fixture cleanup unverified\n' >&2
        status=1
      fi
    fi
  fi
  rm -f -- "$cidfile" "$scratch/docker-output"
  rmdir -- "$scratch" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'cancel 130 6000' INT
trap 'cancel 143 2000' TERM
run_interruptible python3 scripts/release/ci-phase-guard.py
docker_capture existing ps --all --quiet --no-trunc --filter "name=^/$name$"
[[ -z "$existing" ]]
creation_attempted=true
docker_control create --cidfile "$cidfile" --pull never --name "$name" --label "io.wasalx.ci-postgres-owner=$owner" \
  --label "io.wasalx.candidate-sha=$GITHUB_SHA" --cpus 1 --memory 1g --memory-swap 1g \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=512m \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=postgres --env POSTGRES_PASSWORD=wasalx-ci-admin --env POSTGRES_DB=wasalx_ci \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres -d wasalx_ci' \
  --health-interval 5s --health-timeout 5s --health-retries 20 "$image" \
  postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
container_id=$(cat "$cidfile")
[[ $container_id =~ ^[a-f0-9]{64}$ ]]
run_interruptible python3 scripts/release/ci-phase-guard.py
docker_control start "$container_id"
healthy=false
for ((attempt=0; attempt<20; attempt++)); do
  docker_capture health inspect --format '{{.State.Health.Status}}' "$container_id"
  if [[ $health == healthy ]]; then healthy=true; break; fi
  [[ $health == starting ]]
  run_interruptible sleep 5
done
[[ $healthy == true ]]
docker_capture settings exec "$container_id" psql --username postgres --dbname wasalx_ci --tuples-only --no-align \
  --command "SELECT current_setting('fsync') || '|' || current_setting('synchronous_commit') || '|' || current_setting('full_page_writes')"
[[ $settings == 'off|off|off' ]]
docker_capture endpoint inspect --format "$identity_format|{{json (index .NetworkSettings.Ports \"5432/tcp\")}}" "$container_id"
expected="$container_id|/$name|$image|$owner|$GITHUB_SHA|"
[[ $endpoint == "$expected"* ]]
database_urls=$(python3 - "${endpoint#"$expected"}" <<'PY'
import json, os, re, sys
from urllib.parse import parse_qsl, urlsplit, urlunsplit

try:
    bindings = json.loads(sys.argv[1])
    if not isinstance(bindings, list) or len(bindings) != 1:
        raise ValueError('bindings')
    binding = bindings[0]
    if binding['HostIp'] != '127.0.0.1':
        raise ValueError('address')
    port = binding['HostPort']
    if not isinstance(port, str) or not re.fullmatch(r'[1-9][0-9]{0,4}', port) or int(port) > 65535:
        raise ValueError('port')
    urls = []
    for key in ('DATABASE_ADMIN_URL', 'DATABASE_APP_URL'):
        value = os.environ[key]
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError('URL controls')
        url = urlsplit(value)
        if url.scheme not in ('postgres', 'postgresql') or url.hostname != '127.0.0.1':
            raise ValueError('URL origin')
        if any(key.lower() in ('host', 'hostaddr', 'port') for key, _ in parse_qsl(url.query, keep_blank_values=True)):
            raise ValueError('URL endpoint override')
        netloc = url.netloc.rsplit(':', 1)[0] if url.port is not None else url.netloc
        urls.append(urlunsplit(url._replace(netloc=netloc + ':' + port)))
except Exception:
    raise SystemExit('PostgreSQL fixture port/URL binding unverified') from None
print('\n'.join(urls))
PY
)
mapfile -t database_urls <<< "$database_urls"
[[ ${#database_urls[@]} == 2 ]]
export DATABASE_ADMIN_URL="${database_urls[0]}" DATABASE_APP_URL="${database_urls[1]}"
run_interruptible python3 scripts/release/ci-phase-guard.py
run_interruptible timeout --kill-after=2s 25m "$@"
