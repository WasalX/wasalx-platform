#!/usr/bin/env bash
set -euo pipefail
umask 077
state="$1"
mode="$2"
test "$(stat -c '%F:%u:%a' -- "$state")" = directory:0:700
# shellcheck source=/dev/null
source "$state/host.env"
# shellcheck source=/dev/null
source "$state/dev-step-lock.sh"
run="$(cat "$state/run-id")"
hold_dev_step_lock "$run" "$mode" lease
p="$STAGING"
action="$state/overlay-action.sh"
(cd "$p" && sha256sum --check --strict --quiet DEV-SHA256SUMS)
cmp -s -- "$action" "$p/overlay-action.sh"
case "$mode" in
install)
    if bash "$action" install "$state"; then
        if grep -q '^DEV_OVERLAY_DONE .* held_smoke=PASS fence=PASS release=HELD$' "$state/install.done"; then
            finish_dev_step "$state"
            printf 'DEV_SIGNED_INSTALL=PASS release=HELD %s\n' "$(date -u +%FT%TZ)"
            exit 0
        fi
        failure=75
    else
        failure=$?
    fi
    printf 'DEV_SIGNED_INSTALL=HOLD exit=%s %s\n' "$failure" "$(date -u +%FT%TZ)"
    ;;
rollback)
    if grep -sq '^DEV_OVERLAY_DONE .* held_smoke=PASS fence=PASS release=HELD$' "$state/install.done"; then
        echo HOLD_SUCCESS_WITHOUT_END
        exit 75
    fi
    printf 'DISCARD_ONLY=START %s\n' "$(date -u +%FT%TZ)"
    ;;
commit)
    bash "$action" commit "$state"
    finish_dev_step "$state"
    exit 0
    ;;
*) exit 75 ;;
esac
if [ ! -f "$state/overlay-verification-armed" ]; then
    printf 'ROLLBACK=HOLD_BEFORE_ARMED\n'
    exit 75
fi
if bash "$action" rollback "$state"; then
    printf 'DISCARD_OVERLAY=PASS TOP_RESTORED %s\n' "$(date -u +%FT%TZ)"
    finish_dev_step "$state"
    if [ "$mode" = rollback ]; then exit 0; fi
else
    if [ "$?" = 76 ]; then
        printf 'DISCARD_OVERLAY=HOLD TOP_PORTAL_DOWN\n'
    else
        printf 'DISCARD_OVERLAY=HOLD ROLLBACK_BRANCH_FAILED\n'
    fi
fi
exit 75
