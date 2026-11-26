#!/usr/bin/env bash

dev_step_flock() {
    if [[ -z "${DEV_STEP_LOCK:-}" || ! -d "${DEV_STEP_LOCK%/*}" ]]; then
        echo HOLD_DEV_STEP_MARKER_DIR
        exit 75
    fi
    if ! [[ -f "$DEV_STEP_LOCK" ]]; then
        echo HOLD_DEV_STEP_MARKER
        exit 75
    fi
    # Nested phases reuse the inherited open file description and its lock.
    if ! [[ /proc/self/fd/7 -ef "$DEV_STEP_LOCK" ]]; then
        exec 7<"$DEV_STEP_LOCK" || { echo HOLD_DEV_STEP_MARKER; exit 75; }
    fi
    /usr/bin/flock -n -E 75 7 || {
        local status=$?
        if [ "$status" = 75 ]; then echo HOLD_DEV_STEP_BUSY; else echo HOLD_DEV_STEP_LOCK; fi
        exit 75
    }
}

dev_step_record() {
    local helper="${BASH_SOURCE[0]}"
    /usr/bin/python3 -I -B "$(dirname -- "$helper")/host-maintenance.py" dev-step "$@"
}

hold_dev_step_lock() {
    local inherited=
    # An open descriptor alone does not prove that the earlier owner still holds the lock.
    if [[ -n "${DEV_STEP_CLAIM:-}" && -n "${DEV_STEP_LOCK:-}" && /proc/self/fd/7 -ef "$DEV_STEP_LOCK" ]] &&
        grep -Eq '^lock:.* FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]' "/proc/$BASHPID/fdinfo/7"; then
        inherited="$DEV_STEP_CLAIM"
    fi
    dev_step_flock
    claim_dev_step "$1" "$2" "${3:-direct}" "$inherited"
}

claim_dev_step() {
    local claim
    claim="$(dev_step_record acquire -- "$1" "$2" "$4" "$(date -u +%FT%TZ)" "$3")" ||
        { printf '%s\n' "$claim"; exit 75; }
    DEV_STEP_RUN="$1"
    DEV_STEP_OWNER=
    if [[ "$claim" != inherited ]]; then
        export DEV_STEP_CLAIM="$claim"
        DEV_STEP_OWNER="$2"
    fi
}

finish_dev_step() {
    if [[ -n "$DEV_STEP_OWNER" ]]; then
        local evidence
        # Only the owner stages successful foreground evidence, after its terminal checks.
        evidence="$(dev_step_record terminal -- "$DEV_STEP_RUN" "$1" "$DEV_STEP_OWNER" "${2:-stopped}")" ||
            { printf '%s\n' "$evidence"; exit 75; }
        exec 7<&-
        dev_step_flock
        dev_step_record local-handback -- "$DEV_STEP_RUN" "$evidence" || exit 75
        exec 7<&-
    fi
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
    case "${1:-}:$#" in
        acquire:3)
            # The wrapper supplies and retains its already locked descriptor.
            claim_dev_step "$2" "$3" direct ""
            ;;
        handback:3)
            exec 7<&-
            dev_step_flock
            dev_step_record handback -- "$2" "$3" || exit 75
            ;;
        *) echo HOLD_DEV_STEP_ARGUMENTS; exit 75 ;;
    esac
fi
