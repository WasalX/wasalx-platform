#!/usr/bin/env bash
set -euo pipefail
umask 077
MODE="$1"
STATE="$2"
test "$(stat -c '%F:%u:%a' -- "$STATE")" = directory:0:700
case "$MODE" in install|rollback|commit) ;; *) echo HOLD_LEASE_MODE; exit 75 ;; esac
# shellcheck source=/dev/null
source "$STATE/host.env"
# shellcheck source=/dev/null
source "$STATE/dev-step-lock.sh"
# Refuse an already busy host before writing registration records.
(hold_dev_step_lock)
ATTEMPT="$(cat "$STATE/run-id")"
[[ "$ATTEMPT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo HOLD_LEASE_RUN_ID; exit 75; }
LEASE_UNIT="${LEASE_PREFIX}-$MODE-$ATTEMPT.service"
MARKERS="$MARKER_DIRECTORY"
STEM="$MARKERS/${MARKER_PREFIX}-$MODE-$ATTEMPT-build"
MARKER="$STEM.marker"
END="$STEM.end"
RAW="$STATE/$MODE-$ATTEMPT.raw"
FINISH="$STATE/end-$MODE-$ATTEMPT.sh"
test -f "$STATE/overlay-action.sh" || { echo HOLD_LEASE_ACTION; exit 75; }
test -d "$MARKERS" || { echo HOLD_MARKER_DIRECTORY; exit 75; }
test ! -e "$MARKER" || { echo HOLD_MARKER_EXISTS; exit 75; }
test ! -e "$END" || { echo HOLD_END_EXISTS; exit 75; }
test ! -e "$RAW" || { echo HOLD_RAW_EXISTS; exit 75; }
if [ "$MODE" = install ]; then
    [[ "$3" =~ ^[0-9]{10}$ ]] || { echo HOLD_DISPATCH_DEADLINE; exit 75; }
    exec 9>"$STATE/install-registration.lock"
    flock -x -w 60 9 || { echo HOLD_INSTALL_REGISTRATION_LOCK; exit 75; }
    test ! -e "$STATE/install-dispatch-timeout" && test ! -L "$STATE/install-dispatch-timeout" || { echo HOLD_DISPATCH_TIMEOUT; exit 75; }
fi
for path in "$MARKER" "$END" "$RAW" "$FINISH"; do
    test ! -e "$path" && test ! -L "$path" || { echo HOLD_LEASE_PATH_EXISTS; exit 75; }
done
test "$(systemctl show -p LoadState --value "$LEASE_UNIT")" = not-found || { echo HOLD_LEASE_UNIT_EXISTS; exit 75; }
test -f "$STATE/install-or-discard.sh" || { echo HOLD_LEASE_ENTRY; exit 75; }
[[ "$ATTEMPT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo HOLD_LEASE_RUN_ID; exit 75; }
now="$(date -u +%s)"
cutoff="$(date -u -d "$INSTALL_CUTOFF" +%s)"
earliest="$(date -u -d "$INSTALL_NOT_BEFORE" +%s)"
limit="$cutoff"; [ "$MODE" = install ] || limit="$(date -u -d "$DISCARD_LIMIT" +%s)"
test "$now" -ge "$earliest" && test "$now" -lt "$limit" || { echo HOLD_TIME_WINDOW; exit 75; }
test "$(df -B1 --output=avail / | awk 'NR==2 {print $1}')" -ge "$ROOT_FLOOR_BYTES" || { echo HOLD_ROOT_FLOOR; exit 75; }
"$ENGINE_FREE" "$ENGINE_RUN" || { echo HOLD_ENGINE_BUSY; exit 75; }
runtime="$(/usr/bin/python3 -I -B "$STATE/host-maintenance.py" lease-runtime "$MODE")"
now="$(date -u +%s)"
if [ "$MODE" = install ]; then
    if [ "$now" -ge "$3" ]; then
        (set -o noclobber; printf 'dispatch deadline expired %s\n' "$(date -u +%FT%TZ)" > "$STATE/install-dispatch-timeout")
        echo HOLD_DISPATCH_TIMEOUT
        exit 75
    fi
    test "$((cutoff-now))" -ge "$runtime" || { echo HOLD_INSTALL_WINDOW_TOO_SHORT; exit 75; }
fi
test "$((limit-now))" -ge "$runtime" || { echo HOLD_LEASE_WINDOW_TOO_SHORT; exit 75; }
budget_source="$INSTALL_DISCARD_BUDGET_SOURCE"
if [ "$MODE" = commit ]; then budget_source="$LEASE_BUDGET_SOURCE"; fi
printf 'LEASE_BUDGET_SOURCE=%s mode=%s runtime_seconds=%s\n' "$budget_source" "$MODE" "$runtime"
cat > "$FINISH" <<'SH'
#!/usr/bin/env bash
set -eu
umask 022
end="$1"
tmp="$(mktemp -- "$end.XXXXXX")"
test -n "$tmp"
result="$(printenv SERVICE_RESULT || printf launch-failed)"
status="$(printenv EXIT_STATUS || printf unknown)"
printf '%s %s result=%s exit=%s\n' "$(date -u +%FT%TZ)" "$2" "$result" "$status" > "$tmp"
chmod 0644 "$tmp"
mv -T -- "$tmp" "$end"
SH
chmod 0700 "$FINISH"
mkdir -- "$STATE/$MODE-registration" || { echo HOLD_LEASE_ALREADY_CLAIMED; exit 75; }
cat /proc/sys/kernel/random/boot_id > "$STATE/$MODE-registration/boot-id"
tmp="$(mktemp -- "$MARKER.XXXXXX")"
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$LEASE_UNIT" "$TOOLING_SHA" > "$tmp"
chmod 0644 "$tmp"
mv -T -- "$tmp" "$MARKER"
now="$(date -u +%s)"
if [ "$((limit-now))" -le "$runtime" ]; then
    /bin/bash "$FINISH" "$END" "$LEASE_UNIT"
    echo HOLD_LEASE_WINDOW_TOO_SHORT
    exit 75
fi
# The unit entry takes the DEV step lock before running any action.
if ! systemd-run --unit="$LEASE_UNIT" --setenv="LEASE_UNIT=$LEASE_UNIT" --setenv="TMPDIR=$STATE" \
    -p CPUQuota=800% -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=10 -p IOWeight=10 \
    -p Nice=19 -p IOSchedulingClass=idle -p UMask=0077 -p RuntimeMaxSec="$runtime" \
    -p TimeoutStopSec=30 -p KillMode=control-group \
    -p "ExecStopPost=/bin/bash $FINISH $END $LEASE_UNIT" \
    -p "StandardOutput=append:$RAW" -p StandardError=inherit \
    /bin/bash "$STATE/install-or-discard.sh" "$STATE" "$MODE"; then
    test -e "$END" || /bin/bash "$FINISH" "$END" "$LEASE_UNIT"
    exit 1
fi
systemctl show "$LEASE_UNIT" -p ActiveState -p MainPID -p Result
printf 'RAW=%s\n' "$RAW"
