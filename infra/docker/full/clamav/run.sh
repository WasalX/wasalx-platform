#!/bin/sh

set -eu

database_dir=${CLAMAV_DATABASE_DIR:-/var/lib/clamav}
freshclam_bin=${CLAMAV_FRESHCLAM_BIN:-freshclam}
clamd_bin=${CLAMAV_CLAMD_BIN:-clamd}
freshclam_config=${CLAMAV_FRESHCLAM_CONFIG:-/etc/clamav/freshclam.conf}
freshclam_pid=""
clamd_pid=""

stop_children() {
  if [ -n "$clamd_pid" ]; then
    kill -TERM "$clamd_pid" 2>/dev/null || true
  fi
  if [ -n "$freshclam_pid" ]; then
    kill -TERM "$freshclam_pid" 2>/dev/null || true
  fi
}

trap stop_children INT TERM EXIT

# The upstream /init configures clamd/freshclam from the allowlisted
# environment before executing this supervisor. A fresh persistent volume still
# needs its first signature set before clamd can start.
if [ ! -f "$database_dir/main.cvd" ] && [ ! -f "$database_dir/main.cld" ]; then
  initial_config=/tmp/freshclam-initial.conf
  sed \
    -e 's|^\(TestDatabases \)|#\1|' \
    -e '$a TestDatabases no' \
    -e 's|^\(NotifyClamd \)|#\1|' \
    "$freshclam_config" > "$initial_config"
  "$freshclam_bin" --foreground --stdout --config-file="$initial_config"
  rm -f "$initial_config"
fi

"$freshclam_bin" \
  --checks="${FRESHCLAM_CHECKS:-12}" \
  --daemon \
  --foreground \
  --stdout \
  --user=clamav &
freshclam_pid=$!

"$clamd_bin" --foreground &
clamd_pid=$!

# The stock image tails /dev/null after spawning clamd. If clamd is OOM-killed,
# that leaves a permanently unhealthy container which Docker cannot restart.
# Waiting for the real scanner makes its exit the container's exit condition.
set +e
wait "$clamd_pid"
status=$?
set -e
clamd_pid=""

if kill -0 "$freshclam_pid" 2>/dev/null; then
  kill -TERM "$freshclam_pid" 2>/dev/null || true
  wait "$freshclam_pid" 2>/dev/null || true
fi
freshclam_pid=""

trap - INT TERM EXIT
exit "$status"
