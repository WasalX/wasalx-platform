#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 3 || -z "$1" || "$2" != /* || "$3" != /* ]]; then
  echo 'HOLD_DEV_INSTALL_INPUTS: expected unit user, absolute sealed bundle path and absolute DEV step lock path' >&2
  exit 75
fi
unit_user="$1"
state="$2"
lock="$3"
test "$(id -un)" = "$unit_user" || {
  echo HOLD_DEV_INSTALL_USER
  exit 75
}
test "$(stat -c '%F:%u:%a' -- "$state")" = directory:0:700 || {
  echo HOLD_DEV_INSTALL_BUNDLE
  exit 75
}
(cd "$state" && sha256sum --check --strict --quiet SHA256SUMS)
# shellcheck source=/dev/null
source "$state/host.env"
test "${DEV_STEP_LOCK:-}" = "$lock" || {
  echo HOLD_DEV_INSTALL_LOCK_PATH
  exit 75
}
# shellcheck source=/dev/null
source "$state/dev-step-lock.sh"
run="$(cat "$state/run-id")"
[[ "$run" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo HOLD_LEASE_RUN_ID
  exit 75
}
export LEASE_UNIT="${LEASE_PREFIX}-install-$run.service"

unset DEV_STEP_CLAIM
# Serialize admission with the other DEV steps without reserving a run yet.
dev_step_flock
dev_step_record check || exit 75
for marker in overlay-verification-armed install.done; do
  if [[ -e "$state/$marker" || -L "$state/$marker" ]]; then
    echo HOLD_DEV_INSTALL_ALREADY_STARTED
    exit 75
  fi
done

runtime="$(/usr/bin/python3 -I -B "$state/host-maintenance.py" lease-runtime install)"
now="$(date -u +%s)"
earliest="$(date -u -d "$INSTALL_NOT_BEFORE" +%s)"
cutoff="$(date -u -d "$INSTALL_CUTOFF" +%s)"
test "$now" -ge "$earliest" && test "$now" -lt "$cutoff" || {
  echo HOLD_TIME_WINDOW
  exit 75
}
test "$((cutoff - now))" -ge "$runtime" || {
  echo HOLD_INSTALL_WINDOW_TOO_SHORT
  exit 75
}

hold_dev_step_lock "$run" controller-install
# If recording custody consumed the remaining margin, release it as no-work.
now="$(date -u +%s)"
if [ "$((cutoff - now))" -lt "$runtime" ]; then
  finish_dev_step "$state" no-work
  echo HOLD_INSTALL_WINDOW_TOO_SHORT
  exit 75
fi

# The overlay keeps guest preflight, cutover and smoke together under this lock.
# Exit on any failure so the run record is available for recovery and handback.
/bin/bash "$state/install-or-discard.sh" "$state" install

finish_dev_step "$state"
