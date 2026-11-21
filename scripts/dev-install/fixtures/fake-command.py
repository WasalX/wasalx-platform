#!/usr/bin/env python3
"""Record only synthetic calls. Refuse unexpected commands."""

import json
import os
from pathlib import Path
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
    if any(os.environ.get(key) != value for key, value in expected["probe_env"].items()):
        raise SystemExit("probe environment does not match the fixture")
    node = expected["real_node"]
    os.execv(node, [node, expected["native_probe"], str(directory), *args])
elif name == "docker" and args == expected["compose"]:
    print(json.dumps({"services": {"app": {"volumes": [{"type": "bind", "source": "mounts"}]}}}))
else:
    raise SystemExit(f"unexpected fixture command: {name}")
