#!/usr/bin/env python3
"""Generate measured lease inputs or archive a closed support directory."""

import argparse
import hmac
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


PHASES = {
    "install": re.compile(r"DEV_SIGNED_INSTALL=PASS release=HELD \S+"),
    "rollback": re.compile(r"DISCARD_OVERLAY=PASS TOP_RESTORED \S+"),
    "commit": re.compile(r"COMMIT_PASS \S+ overlay_retained=\S+"),
}
TIMING = re.compile(r"PHASE_TIMING phase=(install|rollback|audit|commit)"
                    r" step=([a-z-]+) event=(start|pass) epoch_ns=([0-9]{19}) at=\S+"
                    r"(?: bytes=([1-9][0-9]{0,18}))?")
ORIGIN = re.compile(r"LEASE_RECEIPT_ORIGIN host_sha256=([0-9a-f]{64})"
                    r" disk_device=([0-9]{1,20}) disk_inode=([0-9]{1,20}) captured_ns=([0-9]{19})")
REVIEWED_RESERVATIONS = {"install": 13_400, "rollback": 11_400}
# DEV cycle timings (2026-11-22): 2,880 s per ~115 GB hash at ~40 MB/s.
# Reserve two hashes, one assumed full-disk pass for qemu-img commit, and 11,400 s for restore, plus 25%.
COMMIT_FALLBACK_S = 25_050
GB = 10**9
RUN_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z")


def sizing_top(path):
    top = path.lstat()
    if not stat.S_ISREG(top.st_mode) or top.st_nlink != 1 or top.st_size <= 0:
        raise ValueError("invalid TOP for lease sizing")
    return top


def timing_origin(path):
    machine_id = Path("/etc/machine-id").read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", machine_id) or int(machine_id, 16) == 0:
        raise ValueError("invalid machine ID for lease timing")
    host = hmac.digest(b"WasalX DEV timing receipt v1", bytes.fromhex(machine_id), "sha256").hex()
    top = sizing_top(path)
    return (f"LEASE_RECEIPT_ORIGIN host_sha256={host} disk_device={top.st_dev}"
            f" disk_inode={top.st_ino} captured_ns={time.time_ns()}")


def lease_receipts_match(receipts, policy):
    if policy is None:
        return False
    if (not isinstance(policy, dict)
            or set(policy) != {"host_sha256", "disk_device", "disk_inode", "max_age_seconds"}
            or not isinstance(policy["host_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", policy["host_sha256"])
            or type(policy["disk_device"]) is not int or not 0 <= policy["disk_device"] < 2**64
            or type(policy["disk_inode"]) is not int or not 0 < policy["disk_inode"] < 2**64
            or type(policy["max_age_seconds"]) is not int or not 0 < policy["max_age_seconds"] < 2**31):
        raise ValueError("invalid LEASE_RECEIPT_POLICY")

    now = time.time_ns()
    max_age = policy["max_age_seconds"] * 10**9
    for receipt in receipts:
        captured_ns = None
        for line in receipt.splitlines():
            if line.startswith("LEASE_RECEIPT_ORIGIN"):
                origin = ORIGIN.fullmatch(line)
                if not origin:
                    return False
                host, device, inode, captured = origin.groups()
                captured_ns = int(captured)
                if (host != policy["host_sha256"] or int(device) != policy["disk_device"]
                        or int(inode) != policy["disk_inode"] or not 0 <= now - captured_ns <= max_age):
                    return False
            elif timing := TIMING.fullmatch(line):
                tick = int(timing[4])
                # The lease clock includes the preflight that verifies the packet before origin capture.
                earliest = now - max_age if (timing[2], timing[3]) == ("lease", "start") else captured_ns
                if captured_ns is None or not earliest <= tick <= now:
                    return False
        if captured_ns is None:
            return False
    return True


def lease_budgets(receipts):
    worst = {}
    worst_work = {"qemu-commit": 0, "top-restore": 0}
    hash_ns_per_gb = 0
    legacy_commit = False
    for receipt in receipts:
        pending = {}
        completed = {}
        saw_timing = False
        for line in receipt.splitlines():
            match = TIMING.fullmatch(line)
            if not match:
                for phase, terminal in PHASES.items():
                    if terminal.fullmatch(line):
                        steps = completed.pop(phase, {})
                        duration = steps.get("lease", 0)
                        if duration <= 0:
                            raise ValueError(f"unbound terminal receipt: {phase}")
                        worst[phase] = max(worst.get(phase, 0), duration)
                        for step in worst_work:
                            worst_work[step] = max(worst_work[step], steps.get(step, 0))
                continue
            phase, step, event, value, size = match.groups()
            saw_timing = True
            if step not in ("lease", "full-top-hash", *worst_work):
                continue
            if step != "qemu-commit" and (step == "full-top-hash") != (size is not None):
                raise ValueError(f"invalid phase timing: {phase}/{step}")
            key = (phase, step)
            tick = int(value)
            if event == "start":
                pending[key] = tick, size
                if step == "lease":
                    # A resumed lease is usable only as its own complete measured sample.
                    completed.pop(phase, None)
                continue
            started, started_size = pending.pop(key, (tick, None))
            if tick <= started or size != started_size:
                raise ValueError(f"invalid phase timing: {phase}/{step}")
            duration = tick - started
            if step == "qemu-commit" and size is None:
                legacy_commit = True
                continue
            if size is not None:
                size = int(size)
                duration = (duration * GB + size - 1) // size
            if step == "full-top-hash":
                hash_ns_per_gb = max(hash_ns_per_gb, duration)
            else:
                steps = completed.setdefault(phase, {})
                steps[step] = max(steps.get(step, 0), duration)
        if not saw_timing:
            raise ValueError("lease input must be a raw host receipt with timing stamps")
    measured = REVIEWED_RESERVATIONS.keys() <= worst.keys() and hash_ns_per_gb > 0
    budgets = {phase: with_margin(worst[phase]) for phase in REVIEWED_RESERVATIONS} if measured else REVIEWED_RESERVATIONS
    commit_measured = hash_ns_per_gb > 0 and all(worst_work.values()) and not legacy_commit
    return {
        "INSTALL_SECONDS": budgets["install"], "DISCARD_SECONDS": budgets["rollback"],
        "INSTALL_DISCARD_BUDGET_SOURCE": "measured-receipts" if measured else "reviewed-reservations",
        "HASH_NS_PER_GB": hash_ns_per_gb, "QEMU_COMMIT_NS_PER_GB": worst_work["qemu-commit"],
        "TOP_RESTORE_NS": worst_work["top-restore"],
        "COMMIT_FALLBACK_SECONDS": 0 if commit_measured else COMMIT_FALLBACK_S,
        "LEASE_BUDGET_SOURCE": "measured-receipts" if commit_measured else "fallback-commit",
    }


def with_margin(ns):
    # Round p100 * 1.25 up to whole seconds.
    return (ns * 5 + 4_000_000_000 - 1) // 4_000_000_000


def lease_runtime(mode, env):
    fallback = int(env["COMMIT_FALLBACK_SECONDS"])
    if mode == "commit" and fallback and not all(
        int(env.get(key, 0)) for key in ("HASH_NS_PER_GB", "QEMU_COMMIT_NS_PER_GB", "TOP_RESTORE_NS")
    ):
        return max(COMMIT_FALLBACK_S, fallback)
    measured = env["INSTALL_DISCARD_BUDGET_SOURCE"] == "measured-receipts"
    hash_ns = 0
    if measured or mode == "commit":
        top = sizing_top(Path(env["TOP"]))
        hash_rate = int(env["HASH_NS_PER_GB"])
        hash_ns = (hash_rate * top.st_size + GB - 1) // GB
    if mode == "commit":
        try:
            overlay = Path(env["OVERLAY"]).lstat()
        except FileNotFoundError:
            # A resumed commit may already have archived the overlay.
            overlay_bytes = 0
        else:
            if not stat.S_ISREG(overlay.st_mode) or overlay.st_nlink != 1 or overlay.st_size <= 0:
                raise ValueError("invalid OVERLAY for lease sizing")
            overlay_bytes = overlay.st_size
        post_hash_ns = (hash_rate * (top.st_size + overlay_bytes) + GB - 1) // GB
        qemu_ns = (int(env["QEMU_COMMIT_NS_PER_GB"]) * overlay_bytes + GB - 1) // GB
        measured_ns = hash_ns + post_hash_ns + qemu_ns + int(env["TOP_RESTORE_NS"])
        return max(COMMIT_FALLBACK_S, fallback, with_margin(measured_ns))
    discard = int(env["DISCARD_SECONDS"]) + with_margin(hash_ns)
    return int(env["INSTALL_SECONDS"]) + discard if mode == "install" else discard


def private_directory(path):
    st = path.lstat()
    return stat.S_ISDIR(st.st_mode) and st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o700


def archive_support(source, archive, run_id, receipt_name):
    if not RUN_ID.fullmatch(run_id) or not re.fullmatch(r"[A-Za-z0-9_.-]+\.raw", receipt_name):
        raise ValueError("invalid archive binding")
    if not private_directory(archive):
        raise ValueError("invalid archive directory")
    target = archive / run_id
    moved = not os.path.lexists(source)
    if not moved and os.path.lexists(target):
        raise ValueError("archive target exists")
    previous = target if moved else source
    if (not private_directory(previous) or previous.stat().st_dev != archive.stat().st_dev
            or archive.resolve().is_relative_to(previous.resolve())):
        raise ValueError("invalid support directory")
    for file in (previous / "run-id", previous / receipt_name):
        st = file.lstat()
        if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid()
                or st.st_mode & 0o022):
            raise ValueError("invalid support receipt")
    if (previous / "run-id").read_text(encoding="ascii").strip() != run_id:
        raise ValueError("support run-id mismatch")
    terminal = (previous / receipt_name).read_text(encoding="utf-8").rstrip().splitlines()[-1:]
    if not terminal or not any(pattern.fullmatch(terminal[0]) for pattern in PHASES.values()):
        raise ValueError("support archive requires terminal PASS")
    if not moved:
        subprocess.run(["mv", "-T", "--no-clobber", "--", source, target], check=True)
        if os.path.lexists(source) or not private_directory(target):
            raise ValueError("support archive did not move")
        for parent in {source.parent, archive}:
            fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_subparsers(dest="action", required=True)
    budget = action.add_parser("lease-budgets")
    budget.add_argument("receipts", type=Path, nargs="+")
    origin = action.add_parser("timing-origin")
    origin.add_argument("top", type=Path)
    runtime = action.add_parser("lease-runtime")
    runtime.add_argument("mode", choices=("install", "rollback", "commit"))
    archive = action.add_parser("archive-support")
    archive.add_argument("source", type=Path)
    archive.add_argument("archive", type=Path)
    archive.add_argument("run_id")
    archive.add_argument("receipt_name")
    args = parser.parse_args()
    if args.action == "lease-budgets":
        budgets = lease_budgets(path.read_text(encoding="utf-8") for path in args.receipts)
        print(json.dumps(budgets, sort_keys=True))
    elif args.action == "timing-origin":
        print(timing_origin(args.top))
    elif args.action == "lease-runtime":
        seconds = lease_runtime(args.mode, os.environ)
        if not 0 < seconds < 2**31:
            raise ValueError("invalid lease duration")
        print(seconds)
    else:
        archive_support(args.source, args.archive, args.run_id, args.receipt_name)
        print(f"SUPPORT_ARCHIVE=PASS run_id={args.run_id}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"HOLD_HOST_MAINTENANCE: {error}") from None
