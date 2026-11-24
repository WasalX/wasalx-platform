#!/usr/bin/env bash
set -euo pipefail
umask 077
export TZ=UTC LC_ALL=C PYTHONUNBUFFERED=1

MODE="$1"
case "$MODE" in install|rollback|commit|audit) ;; *) exit 75 ;; esac
STATE="$2"
test "$(stat -c '%F:%u:%a' -- "$STATE")" = directory:0:700
RUN="$(cat "$STATE/run-id")"
[[ "$RUN" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
# The signed host packet supplies this file. It is never sent to the guest.
# shellcheck source=/dev/null
source "$STATE/host.env"
# shellcheck source=/dev/null
source "$STATE/dev-step-lock.sh"
hold_dev_step_lock
export STATE
ORIGINAL="$STATE/original-dropin.conf"
ROLLBACK_KEPT="$DIR/disk-install-$RUN.rolled-back.$RUN.qcow2"
COMMIT_KEPT="$DIR/disk-install-$RUN.committed.$RUN.qcow2"

disk() { PHASE_TIMING_MODE="$MODE" /usr/bin/python3 -I -B "$STATE/frozen-disk.py" "$@"; }
stamp() {
    local tick utc
    read -r tick utc < <(date -u '+%s%N %FT%TZ')
    printf 'PHASE_TIMING phase=%s step=%s event=%s epoch_ns=%s at=%s\n' "$MODE" "$1" "$2" "$tick" "$utc"
}
step() {
    local name="$1"
    shift
    stamp "$name" start
    "$@"
    stamp "$name" pass
}

value() { systemctl show "$VM" -p "$1" --value; }
root_floor() { test "$(df -B1 --output=avail / | awk 'NR==2 {print $1}')" -ge "$ROOT_FLOOR_BYTES"; }
overlay_floor() {
    local available
    available="$(df -B1 --output=avail "$DIR" | awk 'NR==2 {print $1}')"
    printf 'OVERLAY_SPACE path=%s available_bytes=%s floor_bytes=%s\n' "$DIR" "$available" "$OVERLAY_FLOOR_BYTES"
    test "$available" -ge "$OVERLAY_FLOOR_BYTES"
}
check_hash() { printf '%s  %s\n' "$1" "$2" | sha256sum -c -; }

lease_start="$(stamp lease start)"
root_floor
test "$(findmnt -n -T "$STATE" -o SOURCE)" = "$STATE_MOUNT_SOURCE"
test "$(findmnt -n -T "$DISK_STATE" -o SOURCE)" = "$STATE_MOUNT_SOURCE"
test "$(findmnt -n -T "$DIR" -o SOURCE)" = "$DISK_MOUNT_SOURCE"
test "$(findmnt -n -T "$TOP" -o SOURCE)" = "$DISK_MOUNT_SOURCE"
test "$(stat -c '%F:%u:%a' -- "$DISK_STATE")" = directory:0:700
test "$(value User)" = "$VM_USER"
test "$(value Group)" = "$VM_GROUP"
test "$(value Restart)" = no
value ReadWritePaths | tr ' ' '\n' | grep -Fqx "$DIR"
test -f "$ALLOW_START"
if test "$MODE" != rollback || test "$LEASE_UNIT" != "$LEASE_PREFIX-install-$RUN.service"; then
    test "$LEASE_UNIT" = "$LEASE_PREFIX-$MODE-$RUN.service"
fi
grep -Fqx "0::/system.slice/$LEASE_UNIT" /proc/self/cgroup
(cd "$STAGING" && sha256sum --check --strict --quiet DEV-SHA256SUMS)
for input in overlay-action.sh frozen-disk.py host-maintenance.py host.env dev-guest-phase.sh dev-step-lock.sh probe-up.py run-id; do
    cmp -s -- "$STATE/$input" "$STAGING/$input"
done
exec 8>>"$DISK_STATE/host-action.lock"
flock -n 8
/usr/bin/python3 -I -B "$STATE/host-maintenance.py" timing-origin "$TOP" ||
    printf 'LEASE_RECEIPT_ORIGIN unavailable\n'
printf '%s\n' "$lease_start"
"$ENGINE_FREE" "$ENGINE_RUN"
check_hash "$POWEROFF_SHA" "$POWEROFF_HELPER"

# Bind the effective command and verify the live process when the VM is up.
check_drive() {
    /usr/bin/python3 -B - "$1" <<'PY'
import json,os,re,shlex,subprocess,sys
from pathlib import Path
vm=os.environ['VM']
wanted=sys.argv[1]
def get(prop):
    return subprocess.check_output(['systemctl','show',vm,'-p',prop,'--value'],text=True,timeout=15).strip()
match=re.fullmatch(r'\{ path=/usr/bin/qemu-system-x86_64 ; argv\[\]=(.*?) ; ignore_errors=.*? \}',get('ExecStart'))
assert match, 'unrecognized effective ExecStart'
argv=shlex.split(match.group(1))
seed=os.environ['SEED_DRIVE']
assert argv.count('-drive')==2 and [argv[i+1] for i,x in enumerate(argv[:-1]) if x=='-drive']==[wanted,seed]
assert not any(arg.split('=',1)[0].lstrip('-') in {
    'blockdev','hda','hdb','hdc','hdd','cdrom','fda','fdb','mtdblock','sd','pflash',
    'fsdev','virtfs','virtfs_synth'
} or arg.startswith('-drive=') or arg.removeprefix('-device=').split(',',1)[0] in {
    'virtio-9p-pci','virtio-9p-device','vhost-user-fs-pci','vhost-user-fs-device'
} for arg in argv)
assert argv[argv.index('-name')+1]==os.environ['VM_NAME']
assert os.environ['VM_NETDEV'] in argv
expected=Path(os.environ['STATE'])/'original-qemu-argv.json'
if expected.exists():
    baseline=json.loads(expected.read_text())
    assert argv==[wanted if x==os.environ['TOP_DRIVE'] else x for x in baseline], 'another QEMU argument changed'
else:
    assert wanted==os.environ['TOP_DRIVE']
    with expected.open('x') as f:json.dump(argv,f)
pid=int(get('MainPID'))
if pid:
    live=list(map(os.fsdecode,Path(f'/proc/{pid}/cmdline').read_bytes().rstrip(b'\0').split(b'\0')))
    assert live==argv,'live QEMU arguments did not match the effective unit'
print('QEMU_DRIVE_READBACK=PASS '+wanted,flush=True)
PY
}

# Use the existing ACPI helper directly so its timeout cannot force-kill QEMU.
poweroff_clean() {
    local drive="$1" since pid deadline state
    test "$(value ActiveState)" = active
    pid="$(value MainPID)"
    test "$pid" -gt 1
    check_drive "$drive"
    test -S "$QMP"
    since="$(date -u +%s)"
    /usr/bin/python3 -B "$POWEROFF_HELPER" "$QMP"
    deadline=$((SECONDS+30))
    while :; do
        state="$(value ActiveState)"
        if test "$(value MainPID)" = 0 && { test "$state" = inactive || test "$state" = failed; }; then break; fi
        test "$SECONDS" -lt "$deadline"
        sleep 1
    done
    test "$(value ExecMainCode)" = 1
    test "$(value ExecMainStatus)" = 0
    if test "$state" = failed; then
        # QEMU can exit 0 before systemd's ExecStop gets to its QMP socket.
        test ! -e "$QMP"
        journalctl -u "$VM" --since "@$since" --no-pager -o cat > "$STATE/poweroff-$MODE-$since.log"
        grep -Fq "$POWEROFF_HELPER" "$STATE/poweroff-$MODE-$since.log"
        grep -Fq 'FileNotFoundError: [Errno 2] No such file or directory' "$STATE/poweroff-$MODE-$since.log"
        grep -Fq 'Control process exited, code=exited, status=1/FAILURE' "$STATE/poweroff-$MODE-$since.log"
    fi
    printf 'DEV_CLEAN_SHUTDOWN=PASS qemu_pid=%s qemu_exit=0 at=%s\n' "$pid" "$(date -u +%FT%TZ)"
}

boot() {
    local drive="$1" pid deadline
    root_floor
    if test "$drive" = "$OVERLAY_DRIVE"; then overlay_floor; fi
    systemctl start "$VM"
    deadline=$((SECONDS+30))
    while :; do
        pid="$(value MainPID)"
        if test "$pid" -gt 1 && test "$(readlink "/proc/$pid/exe" 2>/dev/null || true)" = /usr/bin/qemu-system-x86_64; then break; fi
        test "$SECONDS" -lt "$deadline"
        sleep 1
    done
    check_drive "$drive"
}

guest_phase() {
    /bin/bash "$STATE/dev-guest-phase.sh" "$1" "$STATE"
}

frozen_check() {
    root_floor
    disk "$@"
    root_floor
}

# Run against the actual installed drop-in and overlay before boot in this slot.
rollback_precheck() {
    check_hash "$ORIGINAL_SHA" "$ORIGINAL"
    check_hash "$(cat "$STATE/installed-dropin.sha256")" "$DROPIN"
    sha256sum -- "$ORIGINAL" "$DROPIN"
    /usr/bin/python3 -B - "$ORIGINAL" <<'PY'
import os,sys
from pathlib import Path
original=Path(sys.argv[1]).read_bytes()
installed=Path(os.environ['DROPIN']).read_bytes()
old=('-drive '+os.environ['TOP_DRIVE']).encode()
new=('-drive '+os.environ['OVERLAY_DRIVE']).encode()
assert installed.count(new)==1 and old not in installed
assert installed.replace(new,old,1)==original, 'drive reversal does not reproduce the original drop-in'
PY
    test -f "$ALLOW_START"
    "$ENGINE_FREE" "$ENGINE_RUN"
    test -f "$OVERLAY"
    test ! -L "$OVERLAY"
    test ! -e "$ROLLBACK_KEPT"
    test ! -L "$ROLLBACK_KEPT"
    printf 'ROLLBACK_PRECHECK=PASS drive_inverse=byte_exact allow_start=present overlay=%s kept_path_free=%s\n' "$OVERLAY" "$ROLLBACK_KEPT"
}

restore_definition() {
    local tmp actual
    check_hash "$ORIGINAL_SHA" "$ORIGINAL"
    actual="$(sha256sum -- "$DROPIN" | awk '{print $1}')"
    if test "$actual" != "$ORIGINAL_SHA"; then
        test "$(value NeedDaemonReload)" = no
        test "$actual" = "$(cat "$STATE/installed-dropin.sha256")"
        tmp="$(mktemp -- "$(dirname "$DROPIN")/.dev-drive-restore.XXXXXX")"
        cp --preserve=all -- "$ORIGINAL" "$tmp"
        if ! test -e "$STATE/restore-definition.started"; then
            (set -o noclobber; date -u +%FT%TZ > "$STATE/restore-definition.started")
        fi
        test -s "$STATE/restore-definition.started"
        test ! -L "$STATE/restore-definition.started"
        mv -T -- "$tmp" "$DROPIN"
    elif test "$(value NeedDaemonReload)" != no; then
        test -f "$STATE/restore-definition.started"
    fi
    systemctl daemon-reload
    test "$(value NeedDaemonReload)" = no
    check_drive "$TOP_DRIVE"
}

if [ "$MODE" = commit ]; then
    # Commit is a separate offline slot after explicit WasalX approval.
    grep -Fq "$REV held_smoke=PASS fence=PASS release=HELD" "$STATE/install.done"
fi
disk_phase="$(disk phase)"
case "$disk_phase" in
    mode-restore|sealing|committing)
        test "$(value MainPID)" = 0
        step disk-recovery disk recover-offline "$disk_phase" "$RUN"
        ;;
    booting)
        if test "$(value MainPID)" = 0; then
            step disk-recovery disk recover-offline booting "$RUN"
        else
            test "$MODE" = rollback || test "$MODE" = commit
            step recovered-top-drive check_drive "$TOP_DRIVE"
            step recovered-top-identity disk verify-writable "$RUN"
            step recovered-top-guard-and-held guest_phase prove
            step recovered-top-identity disk finish-writable "$RUN"
        fi
        ;;
esac

# Keep the whole rollback in the same locked process, including readiness.
restore_top() {
    local kept="$1"
    step stopped-overlay-proof disk verify-stopped-overlay "$OVERLAY" "$kept" "$STATE/overlay-retain.json"
    step definition-restore restore_definition
    step mode-restore disk restore-mode "$RUN"
    step overlay-retain disk archive-overlay "$OVERLAY" "$kept" "$STATE/overlay-retain.json"
    step writable-top-clear disk begin-writable "$RUN"
    step top-boot boot "$TOP_DRIVE"
    step top-guard-and-held guest_phase prove
    step writable-top-proof disk finish-writable "$RUN"
}

stop_overlay() {
    if test "$(value MainPID)" -ne 0; then
        test ! -e "$STATE/overlay-retain.json"
        step overlay-shutdown poweroff_clean "$OVERLAY_DRIVE"
    elif test -f "$STATE/overlay-retain.json"; then
        # The durable stopped-inode receipt survives a host restart.
        return
    else
        test "$(value ExecMainCode)" = 1
        test "$(value ExecMainStatus)" = 0
    fi
    step record-clean-stop disk record-overlay-stop "$OVERLAY" "$STATE/overlay-retain.json"
}

case "$MODE" in
audit)
    if test "$(disk phase)" = writable; then
        check_drive "$TOP_DRIVE"
        echo 'DAILY_FROZEN_AUDIT=DEFERRED_WRITABLE_TOP'
        exit 0
    fi
    step daily-base-hash frozen_check audit
    echo 'DAILY_FROZEN_AUDIT=PASS'
    ;;
install)
    install_cutoff="$(date -u -d "$INSTALL_CUTOFF" +%s)"
    test "$(date -u +%s)" -ge "$(date -u -d "$INSTALL_NOT_BEFORE" +%s)" &&
    test "$(date -u +%s)" -lt "$install_cutoff" || { echo HOLD_TIME_WINDOW; exit 75; }
    test ! -e "$STATE/overlay-verification-armed"
    check_hash "$MANIFEST_SHA" "$STAGING/images-manifest.json"
    grep -q ' HOST_STAGING_PASS images=21$' "$HOST_STAGING_RECEIPT"
    test -s "$HOST_EXPORT_RECEIPT"
    overlay_floor
    test -f "$TOP"
    test ! -L "$TOP"
    test ! -e "$OVERLAY"
    test ! -L "$OVERLAY"
    test "$(stat -c '%a:%U:%G' -- "$TOP")" = "600:$VM_USER:$VM_GROUP"
    check_hash "$ORIGINAL_SHA" "$DROPIN"
    cp --preserve=all -- "$DROPIN" "$ORIGINAL"
    systemctl cat "$VM" > "$STATE/unit-before.txt"
    check_drive "$TOP_DRIVE"
    # If either existing fence is missing or differs from [], HOLD before shutdown.
    test "$(value ActiveState)" = active
    top_pid="$(value MainPID)"
    test "$top_pid" -gt 1
    step running-top-guard-and-preflight guest_phase preflight
    test "$(value MainPID)" = "$top_pid"
    test "$(date -u +%s)" -lt "$install_cutoff" || { echo HOLD_TIME_WINDOW; exit 75; }
    step top-shutdown poweroff_clean "$TOP_DRIVE"

    root_floor
    step base-freeze disk freeze "$RUN"
    sudo -n -u "$VM_USER" test -r "$TOP"
    if sudo -n -u "$VM_USER" test -w "$TOP"; then exit 1; fi

    overlay_floor
    step overlay-create qemu-img create -f qcow2 -b "$TOP" -F qcow2 "$OVERLAY"
    chown "$VM_USER:$VM_GROUP" -- "$OVERLAY"
    chmod 0600 -- "$OVERLAY"
    test "$(findmnt -n -T "$OVERLAY" -o SOURCE)" = "$DISK_MOUNT_SOURCE"
    test "$(stat -c '%a:%U:%G' -- "$OVERLAY")" = "600:$VM_USER:$VM_GROUP"
    sudo -n -u "$VM_USER" test -r "$OVERLAY"
    sudo -n -u "$VM_USER" test -w "$OVERLAY"
    # This is the D2 replacement for the sole post-create byte-equality check.
    step post-create-preboot-proof frozen_check preboot "$OVERLAY"
    printf 'DEV_ROLLBACK_SNAPSHOT_READBACK=PASS %s\n' "$(date -u +%FT%TZ)"

    # Only replace the drive argument in the effective drop-in.
    stamp overlay-definition start
    check_hash "$ORIGINAL_SHA" "$DROPIN"
    tmp="$(mktemp -- "$(dirname "$DROPIN")/.dev-drive-install.XXXXXX")"
    cp --preserve=all -- "$ORIGINAL" "$tmp"
    /usr/bin/python3 -B - "$tmp" <<'PY'
import os,sys
from pathlib import Path
path=Path(sys.argv[1])
source=path.read_bytes()
old=('-drive '+os.environ['TOP_DRIVE']).encode()
new=('-drive '+os.environ['OVERLAY_DRIVE']).encode()
assert source.count(old)==1 and new not in source
updated=source.replace(old,new,1)
assert updated.replace(new,old,1)==source
path.write_bytes(updated)
PY
    sha256sum -- "$tmp" | awk '{print $1}' > "$STATE/installed-dropin.sha256"
    # Check before the intentional drive edit causes NeedDaemonReload=yes.
    test "$(value NeedDaemonReload)" = no
    mv -T -- "$tmp" "$DROPIN"
    systemctl daemon-reload
    test "$(value NeedDaemonReload)" = no
    check_drive "$OVERLAY_DRIVE"
    systemctl cat "$VM" > "$STATE/unit-overlay.txt"
    stamp overlay-definition pass
    step rollback-precheck rollback_precheck
    (set -o noclobber; date -u +%FT%TZ > "$STATE/overlay-verification-armed")
    step overlay-boot boot "$OVERLAY_DRIVE"

    # Boot guard -> Docker readiness -> held/fence read-back -> guest inputs.
    # Then verify-hosted -> original preimage -> candidate env -> preload ->
    # admit-hosted -> action-time preimage + replace -> held smoke -> fence proofs.
    step overlay-guard-and-install guest_phase install
    check_drive "$OVERLAY_DRIVE"
    step terminal-frozen-proof frozen_check verify
    printf 'DEV_OVERLAY_DONE %s %s held_smoke=PASS fence=PASS release=HELD\n' "$(date -u +%FT%TZ)" "$REV" | tee "$STATE/install.done"
    stamp lease pass
    ;;
rollback)
    if test "$(disk phase)" = writable && test "$(value MainPID)" -ne 0; then
        step recovered-top-drive check_drive "$TOP_DRIVE"
        step recovered-top-identity disk verify-writable "$RUN"
        step overlay-retain disk archive-overlay "$OVERLAY" "$ROLLBACK_KEPT" "$STATE/overlay-retain.json"
        step top-guard-and-held guest_phase prove
    else
        stop_overlay
        step frozen-proof frozen_check verify
        step top-restore restore_top "$ROLLBACK_KEPT"
    fi
    printf 'ROLLBACK_PASS %s overlay_retained=%s\n' "$(date -u +%FT%TZ)" "$ROLLBACK_KEPT"
    stamp https-readiness start
    if ! /usr/bin/python3 -I -B "$STATE/probe-up.py" | tee "$STATE/rollback-portal.log" ||
        ! grep -Fqx 'PORTAL_HTTPS_READY=PASS' "$STATE/rollback-portal.log"; then
        exit 76
    fi
    stamp https-readiness pass
    stamp lease pass
    ;;
commit)
    if test "$(disk phase)" = writable && test "$(value MainPID)" -ne 0; then
        disk committed "$RUN"
        step recovered-top-drive check_drive "$TOP_DRIVE"
        step recovered-top-identity disk verify-writable "$RUN"
        step overlay-retain disk archive-overlay "$OVERLAY" "$COMMIT_KEPT" "$STATE/overlay-retain.json"
        step top-guard-and-held guest_phase prove
    else
        if ! disk committed "$RUN"; then
            if test "$(value MainPID)" -ne 0; then
                step overlay-guard-and-held guest_phase prove
                stop_overlay
            else
                test -f "$STATE/overlay-retain.json"
                step stopped-overlay-proof disk record-overlay-stop "$OVERLAY" "$STATE/overlay-retain.json"
            fi
            step committed-base disk commit "$OVERLAY" "$RUN"
        fi
        test "$(value MainPID)" = 0
        step top-restore restore_top "$COMMIT_KEPT"
    fi
    stamp lease pass
    printf 'COMMIT_PASS %s overlay_retained=%s\n' "$(date -u +%FT%TZ)" "$COMMIT_KEPT"
    ;;
esac
