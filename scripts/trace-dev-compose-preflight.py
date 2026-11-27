"""Attach a passive observer to the hosted preflight and report it on failure."""

import os
import select
import signal
import subprocess
import sys
from pathlib import Path


def main(command):
    program = Path(__file__).with_suffix(".bt")
    try:
        observer = subprocess.Popen(
            [
                "sudo",
                "-n",
                "timeout",
                "--signal=INT",
                "20",
                "bpftrace",
                "-q",
                "-B",
                "line",
                str(program),
                str(os.getpid()),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError:
        observer = None

    first_line = b""
    try:
        if observer:
            readable, _, _ = select.select([observer.stdout], [], [], 2)
            if readable:
                first_line = observer.stdout.readline()
        status = subprocess.call(command)
    finally:
        if observer:
            observer.send_signal(signal.SIGINT)
            events, warnings = observer.communicate()

    if status:
        subprocess.call(
            ["git", "show", "--no-patch", "--format=Checkout %H, tree %T", "HEAD"]
        )
        if (
            first_line == b"ready\n"
            and observer.returncode != 124
            and events.endswith(b"finished\n")
            and not warnings
        ):
            print(
                "DEV Compose phases (monotonic ns, 1=CLI 2=metadata 3=config)",
                flush=True,
            )
            print(events.removesuffix(b"finished\n").decode(), end="", flush=True)
        else:
            print("DEV Compose phase capture unavailable or incomplete", flush=True)
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
