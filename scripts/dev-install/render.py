#!/usr/bin/env python3
"""Render the portable DEV install plumbing from an operator-owned identity."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re


TEMPLATES = Path(__file__).with_name("templates")
SCRIPTS = ("dispatch.py", "probe.py", "receive.py")
PATH_FIELDS = ("probe_home", "original_env", "ssh_key", "ssh_known_hosts")
PATTERNS = {
    "expected_hostname": r"[a-z0-9][a-z0-9.-]{0,252}",
    "guest_user": r"[a-z_][a-z0-9_-]{0,31}",
    "review_origin_suffix": r"\.[a-z0-9][a-z0-9.-]{0,251}",
    "project": r"[a-z0-9][a-z0-9_.-]{0,62}",
    "portal_origin": r"https://[a-z0-9][a-z0-9.-]+(?::[0-9]+)?",
    "identity_origin": r"https://[a-z0-9][a-z0-9.-]+(?::[0-9]+)?",
}


def load_identity(path):
    identity = json.loads(path.read_bytes())
    scalar_fields = {"guest_address", "guest_port", "private_umask", "checkout_umask", "probe_seconds"}
    if not isinstance(identity, dict) or set(identity) != set(PATH_FIELDS) | PATTERNS.keys() | scalar_fields:
        raise ValueError("invalid identity fields")
    for name in PATH_FIELDS:
        value = identity[name]
        if not isinstance(value, str) or not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value):
            raise ValueError(f"invalid identity path: {name}")
        parsed = PurePosixPath(value)
        if str(parsed) != value or ".." in parsed.parts or parsed.anchor != "/":
            raise ValueError(f"noncanonical identity path: {name}")
    for name, pattern in PATTERNS.items():
        if not isinstance(identity[name], str) or not re.fullmatch(pattern, identity[name]):
            raise ValueError(f"invalid identity field: {name}")
    if not isinstance(identity["guest_address"], str):
        raise ValueError("invalid guest address")
    ipaddress.IPv4Address(identity["guest_address"])
    for name, minimum, maximum in (("guest_port", 1, 65535), ("probe_seconds", 1, 600)):
        if type(identity[name]) is not int or not minimum <= identity[name] <= maximum:
            raise ValueError(f"invalid identity field: {name}")
    if identity["private_umask"] != "077" or identity["checkout_umask"] != "022":
        raise ValueError("invalid private or checkout umask")
    return identity


def render(identity, run, bundle):
    for name, pattern in {
        "tag": r"[0-9]{8}-[a-z0-9-]{1,39}",
        "commit": r"[0-9a-f]{40}",
        "tree": r"[0-9a-f]{40}",
        "env_sha256": r"[0-9a-f]{64}",
    }.items():
        if not re.fullmatch(pattern, run[name]):
            raise ValueError(f"invalid run field: {name}")

    files = {name: (TEMPLATES / name).read_text(encoding="utf-8").encode() for name in SCRIPTS}
    files["packet.json"] = (json.dumps({"identity": identity, "run": run}, indent=2, sort_keys=True) + "\n").encode()
    files["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files.items())
    ).encode("ascii")
    os.umask(int(identity["private_umask"], 8))
    bundle.mkdir(parents=True, exist_ok=False)
    for name, data in files.items():
        with (bundle / name).open("xb") as output:
            output.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    for name in ("tag", "commit", "tree", "env-sha256"):
        parser.add_argument(f"--{name}", required=True)
    args = vars(parser.parse_args())
    identity = load_identity(args.pop("identity"))
    bundle = args.pop("output")
    render(identity, args, bundle)


if __name__ == "__main__":
    main()
