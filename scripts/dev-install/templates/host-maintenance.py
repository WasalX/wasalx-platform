#!/usr/bin/env python3
"""Generate measured lease inputs or archive a closed support directory."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess


PHASES = {
    "install": re.compile(r"DEV_SIGNED_INSTALL=PASS release=HELD \S+"),
    "rollback": re.compile(r"DISCARD_OVERLAY=PASS TOP_RESTORED \S+"),
}
TIMING = re.compile(r"PHASE_TIMING phase=(install|rollback) step=lease event=(start|pass)"
                    r" epoch_ns=([0-9]{19}) at=\S+")
RUN_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z")


def lease_budgets(receipts):
    worst = {}
    for receipt in receipts:
        pending = {}
        completed = {}
        for line in receipt.splitlines():
            match = TIMING.fullmatch(line)
            if not match:
                for phase, terminal in PHASES.items():
                    if terminal.fullmatch(line):
                        duration = completed.pop(phase, 0)
                        if duration <= 0:
                            raise ValueError(f"unbound terminal receipt: {phase}")
                        worst[phase] = max(worst.get(phase, 0), duration)
                continue
            phase, event, value = match.groups()
            tick = int(value)
            if event == "start":
                # A resumed lease is usable only as its own complete measured sample.
                pending[phase] = tick
                completed.pop(phase, None)
            else:
                started = pending.pop(phase, None)
                if started is None or tick <= started:
                    raise ValueError(f"invalid phase timing: {phase}")
                completed[phase] = tick - started
    if worst.keys() != PHASES.keys():
        raise ValueError("complete install and rollback receipts are required")
    # Round p100 * 1.25 up to whole seconds.
    return {phase: (ns * 5 + 4_000_000_000 - 1) // 4_000_000_000 for phase, ns in worst.items()}


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
    archive = action.add_parser("archive-support")
    archive.add_argument("source", type=Path)
    archive.add_argument("archive", type=Path)
    archive.add_argument("run_id")
    archive.add_argument("receipt_name")
    args = parser.parse_args()
    if args.action == "lease-budgets":
        print(json.dumps(lease_budgets(path.read_text(encoding="utf-8") for path in args.receipts), sort_keys=True))
    else:
        archive_support(args.source, args.archive, args.run_id, args.receipt_name)
        print(f"SUPPORT_ARCHIVE=PASS run_id={args.run_id}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"HOLD_HOST_MAINTENANCE: {error}") from None
