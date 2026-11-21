#!/usr/bin/env python3
"""Record only synthetic calls. Refuse unexpected commands."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys


name = Path(sys.argv[0]).name
args = sys.argv[1:]
directory = Path(sys.argv[0]).parent
expected = json.loads((directory / "expected.json").read_bytes())
log = directory / "calls.jsonl"


def record(argv):
    with log.open("a", encoding="utf-8") as output:
        output.write(json.dumps(argv) + "\n")


record([name, *args])
if name == "ssh" and args == expected["ssh"]:
    print(expected["hostname"])
elif name == "node" and args == expected["capture"]:
    if (directory / "hang").exists():
        subprocess.run(
            ["flock", "--no-fork", str(directory / "stage.lock"), "docker", "probe-hang"],
            check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        subprocess.run(["docker", *expected["compose"]], check=True, stdout=subprocess.DEVNULL)
        Path(args[7]).write_text('{"captured": true}\n', encoding="utf-8")
elif name == "docker" and args == expected["compose"]:
    print(json.dumps({"services": {"app": {"volumes": [{"type": "bind", "source": "mounts"}]}}}))
elif name == "docker" and args == ["probe-hang"] and (directory / "hang").exists():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record(["lock-owner", os.getpid()])
    while True:
        signal.pause()
else:
    raise SystemExit(f"unexpected fixture command: {name}")
