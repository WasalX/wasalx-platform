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
ROOT = TEMPLATES.parents[2]
PULL_PATHS = ("install_dir", "receipt_key", "cosign", "trusted_root")
PULL_SERVICE = "wasalx-dev-pull.service"
PULL_TIMER = "wasalx-dev-pull.timer"
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
    write_bundle(bundle, files)


def render_pull(identity, bundle):
    if not isinstance(identity, dict) or set(identity) != {*PULL_PATHS, "trusted_root_sha256", "mode"}:
        raise ValueError("invalid pull identity fields")
    if identity["mode"] != "report" or not re.fullmatch(r"[0-9a-f]{64}", identity["trusted_root_sha256"]):
        raise ValueError("invalid pull mode or trust pin")
    for field in PULL_PATHS:
        value = identity[field]
        if (not isinstance(value, str) or not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value)
                or value.startswith("//") or str(PurePosixPath(value)) != value
                or ".." in PurePosixPath(value).parts):
            raise ValueError(f"invalid pull path: {field}")
    config = {key: value for key, value in identity.items() if key not in {"receipt_key", "install_dir"}}
    service = (TEMPLATES / PULL_SERVICE).read_text(encoding="utf-8")
    for field in ("install_dir", "receipt_key"):
        service = service.replace(f"@{field.upper()}@", identity[field])
    files = {
        "pull-agent.py": (TEMPLATES / "pull-agent.py").read_text(encoding="utf-8").encode(),
        PULL_SERVICE: service.encode(),
        PULL_TIMER: (TEMPLATES / PULL_TIMER).read_text(encoding="utf-8").encode(),
        "pull-config.json": (json.dumps(config, indent=2, sort_keys=True) + "\n").encode(),
    }
    for name in (
        "scripts/dev-install/pull-verify.mjs", "scripts/release/installer-hosted-images.mjs",
        "release/installer-images.json",
    ):
        files[name] = (ROOT / name).read_bytes()
    write_bundle(bundle, files)


def write_bundle(bundle, files):
    files["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files.items())
    ).encode("ascii")
    os.umask(0o077)
    bundle.mkdir(parents=True, exist_ok=False)
    for name, data in files.items():
        path = bundle / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as output:
            output.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument("--identity", type=Path)
    identity.add_argument("--pull-identity", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    for name in ("tag", "commit", "tree", "env-sha256"):
        parser.add_argument(f"--{name}")
    args = vars(parser.parse_args())
    identity = args.pop("identity")
    pull_identity = args.pop("pull_identity")
    bundle = args.pop("output")
    if pull_identity:
        if any(args.values()):
            parser.error("run coordinates apply only to --identity")
        render_pull(json.loads(pull_identity.read_bytes()), bundle)
    else:
        if not all(args.values()):
            parser.error("--identity requires all run coordinates")
        render(load_identity(identity), args, bundle)


if __name__ == "__main__":
    main()
