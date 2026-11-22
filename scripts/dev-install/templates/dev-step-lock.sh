#!/usr/bin/env bash

hold_dev_step_lock() {
    if [[ -z "${DEV_STEP_LOCK:-}" || ! -d "${DEV_STEP_LOCK%/*}" ]]; then
        echo HOLD_DEV_STEP_MARKER_DIR
        exit 75
    fi
    # Nested phases reuse the inherited description, which already owns the lock.
    if ! [[ /proc/self/fd/7 -ef "$DEV_STEP_LOCK" ]]; then
        exec 7>>"$DEV_STEP_LOCK" || { echo HOLD_DEV_STEP_LOCK; exit 75; }
    fi
    /usr/bin/flock -n -E 75 7 || {
        local status=$?
        if [ "$status" = 75 ]; then echo HOLD_DEV_STEP_BUSY; else echo HOLD_DEV_STEP_LOCK; fi
        exit "$status"
    }
}
