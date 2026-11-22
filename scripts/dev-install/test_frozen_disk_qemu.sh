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
grep -q '^PHASE_TIMING phase=rollback step=daily-base-hash event=start ' <<< "$audit_log"
grep -q '^PHASE_TIMING phase=rollback step=daily-base-hash event=pass ' <<< "$audit_log"
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
disk freeze "$run_id"
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
disk commit "$overlay" "$run_id"
disk committed "$run_id"
disk verify
qemu-io -r -f qcow2 -c 'read -P 0xa5 1M 512' "$top" >/dev/null
disk restore-mode "$run_id"
disk archive-overlay "$overlay" "$overlay.retained" "$DISK_STATE/retained.json"
echo 'COMMIT_FIXTURE=PASS'

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
