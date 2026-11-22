#!/usr/bin/env python3
"""Render the portable DEV install plumbing from an operator-owned identity."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
from runpy import run_path
import shlex


TEMPLATES = Path(__file__).with_name("templates")
SCRIPTS = ("dispatch.py", "probe.py", "receive.py")
HOST_SCRIPTS = (
    "dev-guest-phase.sh", "frozen-disk.py", "host-maintenance.py",
    "install-or-discard.sh", "overlay-action.sh", "probe-up.py", "register.sh",
)
HOST_PATHS = (
    "ALLOW_START", "DIR", "DISK_MOUNT_SOURCE", "DISK_STATE", "DROPIN", "ENGINE_FREE", "GUEST_KEY",
    "GUEST_KNOWN_HOSTS", "GUEST_RUN_SCRIPT", "GUEST_VOLUME_SOURCE", "HOST_EXPORT_RECEIPT",
    "HOST_STAGING_RECEIPT", "MARKER_DIRECTORY", "OVERLAY", "POWEROFF_HELPER", "QMP", "STAGING",
    "STATE_MOUNT_SOURCE", "TOP",
)
HOST_PATTERNS = {
    "VM": r"[A-Za-z0-9_.@-]+\.service",
    "VM_USER": r"[a-z_][a-z0-9_-]*", "VM_GROUP": r"[a-z_][a-z0-9_-]*",
    "VM_NAME": r"[a-zA-Z0-9_.-]+",
    "VM_NETDEV": r"[A-Za-z0-9_.:,=+\[\]-]+",
    "GUEST_HOSTNAME": r"[a-zA-Z0-9_.-]+", "GUEST_USER": r"[a-z_][a-z0-9_-]*",
    "GUEST_ADDRESS": r"[0-9.]+", "REVIEW_SUFFIX": r"\.[a-zA-Z0-9.-]+",
    "PORTAL_ORIGIN": r"https://[a-z0-9][a-z0-9.-]+(?::[0-9]+)?",
    "IDENTITY_ORIGIN": r"https://[a-z0-9][a-z0-9.-]+(?::[0-9]+)?",
    "ENGINE_RUN": r"[0-9]{8}T[0-9]{6}(?:\.[0-9]+)?Z",
    "LEASE_PREFIX": r"[a-z0-9][a-z0-9-]*", "MARKER_PREFIX": r"[a-z0-9][a-z0-9-]*",
    "TOOLING_SHA": r"[0-9a-f]{40}",
    **dict.fromkeys(("ORIGINAL_SHA", "MANIFEST_SHA", "POWEROFF_SHA"), r"[0-9a-f]{64}"),
    **dict.fromkeys(("INSTALL_NOT_BEFORE", "INSTALL_CUTOFF", "DISCARD_LIMIT"),
                    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"),
    **dict.fromkeys(("TOP_DRIVE", "OVERLAY_DRIVE", "SEED_DRIVE"), r"file=/[a-zA-Z0-9_./,=-]+"),
}
HOST_NUMBERS = ("ROOT_FLOOR_BYTES", "OVERLAY_FLOOR_BYTES", "VIRTUAL_BYTES", "GUEST_PORT")
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
    write_packet(bundle, files)


def absolute_path(value):
    return (isinstance(value, str) and re.fullmatch(r"/[a-zA-Z0-9_./-]+", value)
            and str(PurePosixPath(value)) == value and ".." not in PurePosixPath(value).parts
            and PurePosixPath(value).anchor == "/")


def render_host(identity, run_id, commit, receipts, bundle):
    fields = set(HOST_PATHS) | HOST_PATTERNS.keys() | set(HOST_NUMBERS) | {"TOP_CHAIN"}
    if not isinstance(identity, dict) or set(identity) != fields:
        raise ValueError("invalid host identity fields")
    for key in HOST_PATHS:
        if not absolute_path(identity[key]):
            raise ValueError(f"invalid host path: {key}")
    for key, pattern in HOST_PATTERNS.items():
        if not isinstance(identity[key], str) or not re.fullmatch(pattern, identity[key]):
            raise ValueError(f"invalid host field: {key}")
    for key in HOST_NUMBERS:
        if type(identity[key]) is not int or not 0 < identity[key] < 2**63:
            raise ValueError(f"invalid host number: {key}")
    if identity["GUEST_PORT"] > 65535:
        raise ValueError("invalid guest port")
    ipaddress.IPv4Address(identity["GUEST_ADDRESS"])
    for disk in ("TOP", "OVERLAY"):
        if (PurePosixPath(identity[disk]).parent != PurePosixPath(identity["DIR"])
                or identity[f"{disk}_DRIVE"].split(",", 1)[0] != f"file={identity[disk]}"):
            raise ValueError("unbound VM drive")
    chain = identity["TOP_CHAIN"]
    if (not isinstance(chain, list) or not chain or not all(absolute_path(path) for path in chain)
            or chain[0] != identity["TOP"] or len(set(chain)) != len(chain) or identity["OVERLAY"] in chain):
        raise ValueError("invalid TOP chain")
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", run_id or "") or not re.fullmatch(r"[0-9a-f]{40}", commit or ""):
        raise ValueError("invalid host run identity")
    lease_budgets = run_path(str(TEMPLATES / "host-maintenance.py"))["lease_budgets"]
    leases, source = lease_budgets(path.read_text(encoding="utf-8") for path in receipts)
    for phase, seconds in leases.items():
        if type(seconds) is not int or not 0 < seconds < 2**31:
            raise ValueError(f"invalid lease duration: {phase}")

    env = {
        **identity, "TOP_CHAIN": json.dumps(chain), "REV": commit,
        "INSTALL_SECONDS": leases["install"], "DISCARD_SECONDS": leases["rollback"],
        "LEASE_BUDGET_SOURCE": source,
    }
    files = {name: (TEMPLATES / name).read_text(encoding="utf-8").encode() for name in HOST_SCRIPTS}
    files["run-id"] = (run_id + "\n").encode()
    files["host.env"] = "".join(f"export {key}={shlex.quote(str(value))}\n"
                                for key, value in sorted(env.items())).encode()
    write_packet(bundle, files)


def write_packet(bundle, files):
    files["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files.items())
    ).encode("ascii")
    os.umask(0o077)
    bundle.mkdir(parents=True, exist_ok=False)
    for name, data in files.items():
        with (bundle / name).open("xb") as output:
            output.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    kind = parser.add_mutually_exclusive_group(required=True)
    kind.add_argument("--identity", type=Path)
    kind.add_argument("--host-identity", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--lease-receipt", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    for name in ("tag", "commit", "tree", "env-sha256"):
        parser.add_argument(f"--{name}")
    args = parser.parse_args()
    if args.host_identity:
        if not args.run_id or not args.commit or args.tag or args.tree or args.env_sha256:
            parser.error("host packets require --run-id and --commit and accept raw --lease-receipt inputs")
        render_host(json.loads(args.host_identity.read_bytes()), args.run_id, args.commit,
                    args.lease_receipt, args.output)
    else:
        if args.run_id or args.lease_receipt or not all((args.tag, args.commit, args.tree, args.env_sha256)):
            parser.error("guest packets require --tag, --commit, --tree and --env-sha256")
        run = {key: getattr(args, key) for key in ("tag", "commit", "tree", "env_sha256")}
        render(load_identity(args.identity), run, args.output)


if __name__ == "__main__":
    main()
