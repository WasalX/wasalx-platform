#!/usr/bin/env bash
# Run only on disposable Linux runners with sudo, QEMU and an ext4 loop mount.
set -euo pipefail
umask 077
repo="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
work="$(mktemp -d)"
mountpoint="$work/disk"
mkdir -- "$mountpoint"
cleanup() {
    if mountpoint -q "$mountpoint"; then
        find "$mountpoint" -type f -name top.qcow2 -exec chattr -i -- {} +
        umount "$mountpoint"
    fi
    rm -f -- "$work/ext4.img"
    rmdir -- "$mountpoint" "$work"
}
trap cleanup EXIT
truncate -s 128M "$work/ext4.img"
mkfs.ext4 -q -F "$work/ext4.img"
mount -o loop "$work/ext4.img" "$mountpoint"
test "$(findmnt -n -T "$mountpoint" -o FSTYPE)" = ext4

accel=tcg
if python3 -I -B - <<'PY'
import fcntl
import os
try:
    with open("/dev/kvm", "rb+") as kvm:
        os.close(fcntl.ioctl(kvm, 0xAE01, 0))  # KVM_CREATE_VM
except OSError:
    raise SystemExit(1)
PY
then
    accel=kvm
    echo 'QEMU_ACCELERATOR=KVM'
else
    echo 'QEMU_ACCELERATOR=TCG (KVM unavailable)'
fi

run_id=20000101T000000Z
disk() { python3 -I -B "$repo/scripts/dev-install/templates/frozen-disk.py" "$@"; }
fixture() {
    local dir="$mountpoint/$1"
    mkdir "$dir" "$dir/state"
    top="$dir/top.qcow2"
    overlay="$dir/overlay.qcow2"
    alternate="$dir/alternate.qcow2"
    export DISK_STATE="$dir/state" VIRTUAL_BYTES=8388608
    printf -v TOP_CHAIN '["%s"]' "$top"
    export TOP_CHAIN
    # BIOS boot sector for the guard stub. Its I/O write makes QEMU exit 85.
    python3 -I -B - "$dir/disk.raw" <<'PY'
import sys
with open(sys.argv[1], "wb") as disk:
    disk.write(bytes.fromhex("ba f4 00 b0 2a ee f4"))
    disk.seek(510)
    disk.write(bytes.fromhex("55 aa"))
    disk.truncate(8388608)
PY
    if [ "${2:-}" = backing ]; then
        base="$dir/base.qcow2"
        local middle="$dir/middle.qcow2"
        qemu-img convert -f raw -O qcow2 "$dir/disk.raw" "$base"
        qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$middle"
        qemu-img create -q -f qcow2 -F qcow2 -b "$middle" "$top"
        printf -v TOP_CHAIN '["%s","%s","%s"]' "$top" "$middle" "$base"
    else
        qemu-img convert -f raw -O qcow2 "$dir/disk.raw" "$top"
    fi
    chmod 0600 "$top"
    disk freeze "$run_id"
    qemu-img create -q -f qcow2 -F qcow2 -b "$top" "$overlay"
}

guard_stub() {
    local rc=0
    timeout 45s qemu-system-x86_64 -accel "$accel" -m 64 -nodefaults -display none \
        -no-reboot -boot order=c -drive "file=$1,format=qcow2,if=ide" \
        -device isa-debug-exit,iobase=0xf4,iosize=0x04 || rc=$?
    if [ "$rc" != 85 ]; then
        printf 'GUARD_STUB=FAIL qemu_exit=%s\n' "$rc" >&2
        return 1
    fi
    echo 'GUARD_STUB=PASS'
}

overdue_audit() {
    python3 -I -B - "$DISK_STATE/frozen-top.json" "$1" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
receipt = json.loads(path.read_bytes())
receipt["audited_ns"] = 1
if sys.argv[2] == "mismatch":
    receipt["sha256"] = "0" * 64
path.write_text(json.dumps(receipt), encoding="utf-8")
PY
}

fixture discard
disk preboot "$overlay"
qemu-io -f qcow2 -c 'write -P 0xa5 1M 512' "$overlay" >/dev/null
guard_stub "$overlay"
echo 'INSTALL_FIXTURE=FORCED_FAILURE'
disk record-overlay-stop "$overlay" "$DISK_STATE/retained.json"
overdue_audit match
audit_log="$(PHASE_TIMING_MODE=rollback disk verify)"
grep -q '^PHASE_TIMING phase=rollback step=full-top-hash event=start .* bytes=[1-9][0-9]*$' <<< "$audit_log"
grep -q '^PHASE_TIMING phase=rollback step=full-top-hash event=pass .* bytes=[1-9][0-9]*$' <<< "$audit_log"
disk restore-mode "$run_id"
disk archive-overlay "$overlay" "$overlay.retained" "$DISK_STATE/retained.json"
disk archive-overlay "$overlay" "$overlay.retained" "$DISK_STATE/retained.json"
disk begin-writable "$run_id"
disk recover-offline booting "$run_id"
disk verify
disk begin-writable "$run_id"
guard_stub "$top"
disk finish-writable "$run_id"
qemu-io -r -f qcow2 -c 'read -P 0x00 1M 512' "$top" >/dev/null
seal_log="$(PHASE_TIMING_MODE=install disk freeze "$run_id")"
grep -q "^PHASE_TIMING phase=install step=full-top-hash event=pass .* bytes=$(stat -c %s "$top")$" <<< "$seal_log"
test -z "$(PHASE_TIMING_MODE=install disk freeze "$run_id")"
disk audit
echo 'DISCARD_FIXTURE=PASS overdue_audit=PASS offline_recovery=PASS'

fixture discard-audit-mismatch
guard_stub "$overlay"
disk record-overlay-stop "$overlay" "$DISK_STATE/retained.json"
overdue_audit mismatch
if audit_log="$(disk verify 2>&1)"; then
    echo 'DISCARD_AUDIT_MISMATCH=FAIL' >&2
    exit 1
fi
test "$audit_log" = HOLD_DISK_SHA256
test -f "$DISK_STATE/frozen-top.hold"
test "$(disk restore-mode "$run_id" 2>&1 || true)" = HOLD_DISK_HOLD
test "$(stat -c '%a' "$top")" = 400
echo 'DISCARD_AUDIT_MISMATCH=PASS restore=HELD'

fixture commit
disk preboot "$overlay"
qemu-io -f qcow2 -c 'write -P 0xa5 1M 512' "$overlay" >/dev/null
disk record-overlay-stop "$overlay" "$DISK_STATE/retained.json"
before_bytes="$(stat -c %s "$top")"
overlay_bytes="$(stat -c %s "$overlay")"
commit_log="$(PHASE_TIMING_MODE=commit disk commit "$overlay" "$run_id")"
after_bytes="$(stat -c %s "$top")"
test "$after_bytes" -gt "$before_bytes"
test "$(grep -c '^PHASE_TIMING phase=commit step=full-top-hash event=pass ' <<< "$commit_log")" = 2
grep -q "^PHASE_TIMING phase=commit step=full-top-hash event=pass .* bytes=$before_bytes$" <<< "$commit_log"
grep -q "^PHASE_TIMING phase=commit step=full-top-hash event=pass .* bytes=$after_bytes$" <<< "$commit_log"
for event in start pass; do
    grep -q "^PHASE_TIMING phase=commit step=qemu-commit event=$event .* bytes=$overlay_bytes$" <<< "$commit_log"
done
disk committed "$run_id"
disk verify
qemu-io -r -f qcow2 -c 'read -P 0xa5 1M 512' "$top" >/dev/null
disk restore-mode "$run_id"
disk archive-overlay "$overlay" "$overlay.retained" "$DISK_STATE/retained.json"
echo 'COMMIT_FIXTURE=PASS'

test_commit_registration() (
    local state="$mountpoint/registration" templates="$repo/scripts/dev-install/templates"
    mkdir -p -- "$state/markers" "$state/staging"
    export LEASE_RECORD="$state/systemd-run.args"
    systemctl() { if [ "$1" = show ] && [ "${2:-}" = -p ]; then echo not-found; fi; }
    systemd-run() { printf '%s\n' "$@" > "$LEASE_RECORD"; }
    export -f systemctl systemd-run
    cp -- "$templates/dev-step-lock.sh" "$templates/host-maintenance.py" "$templates/install-or-discard.sh" "$state/"
    printf '%s\n' "$run_id" > "$state/run-id"
    cat > "$state/overlay-action.sh" <<'SH'
source "$2/dev-step-lock.sh"
hold_dev_step_lock
if [ "${LOCK_TEST:-}" = hold ]; then
    printf 'ready\n' >&5
    read -r _ <&6
    exit
fi
printf 'ACTION=%s\n' "$1"
exit 75
SH
    cp -- "$state/overlay-action.sh" "$state/staging/"
    (cd "$state/staging" && sha256sum overlay-action.sh > DEV-SHA256SUMS)
    cat > "$state/host.env" <<EOF
export LEASE_PREFIX=fixture MARKER_PREFIX=fixture TOOLING_SHA=fixture
export MARKER_DIRECTORY=$state/markers STAGING=$state/staging
export DEV_STEP_LOCK=$state/locks/dev-step.active
export ENGINE_FREE=/bin/true ENGINE_RUN=$run_id ROOT_FLOOR_BYTES=1
export INSTALL_NOT_BEFORE=$(date -u -d '1 hour ago' +%FT%TZ)
export INSTALL_CUTOFF=$(date -u -d '+1 hour' +%FT%TZ)
export DISCARD_LIMIT=$(date -u -d '+6 hours' +%FT%TZ)
export COMMIT_FALLBACK_SECONDS=25050 INSTALL_DISCARD_BUDGET_SOURCE=reviewed-reservations
export LEASE_BUDGET_SOURCE=fallback-commit
EOF
    local result=0 output holder ready finish
    output="$(bash "$templates/register.sh" commit "$state")" || result=$?
    test "$result" = 75
    test "$output" = HOLD_DEV_STEP_MARKER_DIR
    test ! -e "$state/locks"
    test ! -e "$LEASE_RECORD"
    mkdir -- "$state/locks"
    result=0
    output="$(bash "$templates/register.sh" commit "$state")" || result=$?
    test "$result" = 75
    test "$output" = HOLD_LEASE_WINDOW_TOO_SHORT
    test ! -e "$LEASE_RECORD"
    printf 'export DISCARD_LIMIT=%s\n' "$(date -u -d '+8 hours' +%FT%TZ)" >> "$state/host.env"
    bash "$templates/register.sh" commit "$state" | grep -Fx 'LEASE_BUDGET_SOURCE=fallback-commit mode=commit runtime_seconds=25050'
    grep -Fx 'RuntimeMaxSec=25050' "$LEASE_RECORD"
    local -a lease
    mapfile -t lease < <(tail -n 4 "$LEASE_RECORD")
    test "${lease[3]}" = commit
    result=0
    output="$("${lease[@]}")" || result=$?
    test "$result" = 75
    test "$output" = ACTION=commit

    mkfifo -- "$state/ready.fifo" "$state/finish.fifo"
    exec 5<>"$state/ready.fifo" 6<>"$state/finish.fifo"
    holder=
    trap 'if [ -n "$holder" ]; then kill -KILL "$holder" 2>/dev/null || :; wait "$holder" 2>/dev/null || :; fi' EXIT
    expect_busy() {
        local status=0 log
        log="$("$@")" || status=$?
        test "$status" = 75
        test "$log" = HOLD_DEV_STEP_BUSY
    }
    for finish in exit kill; do
        LOCK_TEST=hold "${lease[@]}" &
        holder=$!
        read -rt 5 ready <&5
        test "$ready" = ready
        expect_busy bash "$templates/register.sh" commit "$state"
        expect_busy "${lease[@]}"
        expect_busy bash "$templates/overlay-action.sh" audit "$state"
        expect_busy bash "$templates/dev-guest-phase.sh" prove "$state"
        if flock -n "$state/locks/dev-step.active" true; then
            echo 'DEV_STEP_LOCK=FAIL probe admitted during lease' >&2
            exit 1
        fi
        if [ "$finish" = kill ]; then
            kill -KILL "$holder"
            result=0
            wait "$holder" 2>/dev/null || result=$?
            test "$result" = 137
        else
            printf 'finish\n' >&6
            wait "$holder"
        fi
        holder=
        flock -n "$state/locks/dev-step.active" true
    done
    echo 'DEV_STEP_LOCK=PASS contention=75 release_after_exit=PASS release_after_kill=PASS'
)
test_commit_registration

expect_hold() {
    local name="$1" reason="$2" output
    if output="$(disk preboot "$overlay" 2>&1)"; then
        echo "NEGATIVE_PREFLIGHT=FAIL case=$name unexpectedly_admitted=true" >&2
        exit 1
    fi
    test "$output" = "HOLD_$reason"
    test "$(disk verify 2>&1 || true)" = HOLD_DISK_HOLD
    echo "NEGATIVE_PREFLIGHT=PASS case=$name boot=NOT_RUN reason=$reason"
}

fixture cleared-flag
chattr -i -- "$top"
expect_hold cleared-flag IMMUTABLE_FLAG

fixture ctime-changed
chattr -i -- "$top"
chmod 0600 "$top"
chmod 0400 "$top"
chattr +i -- "$top"
expect_hold ctime-changed DISK_CTIME

fixture size-changed
chattr -i -- "$top"
truncate -s +1 "$top"
chattr +i -- "$top"
expect_hold size-changed DISK_SIZE

fixture broken-chain
qemu-img create -q -f qcow2 "$alternate" "$VIRTUAL_BYTES"
qemu-img rebase -u -f qcow2 -F qcow2 -b "$alternate" "$overlay"
expect_hold broken-chain BACKING_CHAIN

fixture swapped-lower backing
cp -p -- "$base" "$base.replacement"
mv -T -- "$base.replacement" "$base"
expect_hold swapped-lower BACKING_DISK_IDENTITY
