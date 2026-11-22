#!/usr/bin/env python3
"""Generate measured lease inputs or archive a closed support directory."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


PHASES = {
    "install": re.compile(r"DEV_SIGNED_INSTALL=PASS release=HELD \S+"),
    "rollback": re.compile(r"DISCARD_OVERLAY=PASS TOP_RESTORED \S+"),
    "commit": re.compile(r"COMMIT_PASS \S+ overlay_retained=\S+"),
}
TIMING = re.compile(r"PHASE_TIMING phase=(install|rollback|audit|commit)"
                    r" step=([a-z-]+) event=(start|pass) epoch_ns=([0-9]{19}) at=\S+"
                    r"(?: bytes=([1-9][0-9]{0,18}))?")
REVIEWED_RESERVATIONS = {"install": 13_400, "rollback": 11_400}
# DEV cycle timings (2026-11-22): 2,880 s per ~115 GB hash at ~40 MB/s.
# Reserve two hashes, one assumed full-disk pass for qemu-img commit, and 11,400 s for restore, plus 25%.
COMMIT_FALLBACK_S = 25_050
GB = 10**9
RUN_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z")


def lease_budgets(receipts):
    worst = {}
    worst_work = {"qemu-commit": 0, "top-restore": 0}
    hash_ns_per_gb = 0
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
            if (step == "full-top-hash") != (size is not None):
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
            if step == "full-top-hash":
                size = int(size)
                hash_ns_per_gb = max(hash_ns_per_gb, (duration * GB + size - 1) // size)
            else:
                completed.setdefault(phase, {})[step] = duration
        if not saw_timing:
            raise ValueError("lease input must be a raw host receipt with timing stamps")
    measured = REVIEWED_RESERVATIONS.keys() <= worst.keys() and hash_ns_per_gb > 0
    budgets = {phase: with_margin(worst[phase]) for phase in REVIEWED_RESERVATIONS} if measured else REVIEWED_RESERVATIONS
    commit_work = sum(worst_work.values()) if hash_ns_per_gb and all(worst_work.values()) else 0
    return {
        "INSTALL_SECONDS": budgets["install"], "DISCARD_SECONDS": budgets["rollback"],
        "INSTALL_DISCARD_BUDGET_SOURCE": "measured-receipts" if measured else "reviewed-reservations",
        "HASH_NS_PER_GB": hash_ns_per_gb, "COMMIT_WORK_NS": commit_work,
        "COMMIT_FALLBACK_SECONDS": 0 if commit_work else COMMIT_FALLBACK_S,
        "LEASE_BUDGET_SOURCE": "measured-receipts" if commit_work else "fallback-commit",
    }


def with_margin(ns):
    # Round p100 * 1.25 up to whole seconds.
    return (ns * 5 + 4_000_000_000 - 1) // 4_000_000_000


def lease_runtime(mode, env):
    fallback = int(env["COMMIT_FALLBACK_SECONDS"])
    if mode == "commit" and fallback:
        return fallback
    measured = env["INSTALL_DISCARD_BUDGET_SOURCE"] == "measured-receipts"
    hash_ns = 0
    if measured or mode == "commit":
        top = Path(env["TOP"]).lstat()
        if not stat.S_ISREG(top.st_mode) or top.st_nlink != 1 or top.st_size <= 0:
            raise ValueError("invalid TOP for lease sizing")
        hash_ns = (int(env["HASH_NS_PER_GB"]) * top.st_size + GB - 1) // GB
    if mode == "commit":
        return with_margin(2 * hash_ns + int(env["COMMIT_WORK_NS"]))
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
