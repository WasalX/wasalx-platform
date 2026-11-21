#!/usr/bin/env python3
"""Verify the target guest before handing off the packet."""

import json
from pathlib import Path
import subprocess


def main():
    packet = json.loads(Path(__file__).with_name("packet.json").read_bytes())
    identity = packet["identity"]
    ssh = [
        "ssh", "-T", "-F", "/dev/null", "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", f"UserKnownHostsFile={identity['ssh_known_hosts']}",
        "-i", identity["ssh_key"], "-p", str(identity["guest_port"]),
        f"{identity['guest_user']}@{identity['guest_address']}",
    ]
    hostname = subprocess.check_output(
        [*ssh, "hostname"], stdin=subprocess.DEVNULL, text=True, timeout=15,
    ).strip()
    if hostname != identity["guest_hostname"]:
        raise SystemExit("guest hostname mismatch")


if __name__ == "__main__":
    main()
