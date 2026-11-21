#!/usr/bin/env python3
"""Run the native read-only capture with the installed Compose environment."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess


def verify_env(path, expected, private_umask):
    info = path.lstat()
    if (path.resolve(strict=True) != path or not stat.S_ISREG(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o666 & ~private_umask or info.st_nlink != 1
            or hashlib.sha256(path.read_bytes()).hexdigest() != expected):
        raise SystemExit("installed environment identity mismatch")


def capture(repo, argv, environment, seconds):
    # GNU timeout signals the process group, including the native lock owner.
    result = subprocess.run(
        ["timeout", "-k", "5s", f"{seconds}s", *argv],
        cwd=repo, env=environment, stdin=subprocess.DEVNULL,
    )
    status = result.returncode
    if status in (124, -9, 137):
        raise SystemExit("native preflight timed out")
    if status:
        raise SystemExit(f"native preflight failed ({status})")


def main():
    packet = json.loads(Path(__file__).with_name("packet.json").read_bytes())
    identity, run = packet["identity"], packet["run"]
    private_umask = int(identity["private_umask"], 8)
    os.umask(private_umask)
    support = Path("/home") / identity["guest_user"] / f"dev-signed-{run['tag']}-dev"
    repo = support / "source"
    original = Path(identity["original_env"])
    verify_env(original, run["env_sha256"], private_umask)
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": identity["probe_home"],
        "LC_ALL": "C",
        "GIT_OPTIONAL_LOCKS": "0",
        "WASALX_INSTALL_EXPECTED_HOSTNAME": identity["expected_hostname"],
        "WASALX_DEV_REVIEW_ORIGIN_SUFFIX": identity["review_origin_suffix"],
        "COMMIT_SHA": run["commit"],
        "WASALX_CANDIDATE_SHA": run["commit"],
        "WASALX_CANDIDATE_TREE": run["tree"],
    }
    capture(repo, [
        "node", "scripts/release/installer-stages.mjs", "preflight",
        "--env-file", str(original), "--project-name", identity["project"],
        "--capture-dev-preimages", str(support / "private/preimages.json"),
        "--dev-review-origin", identity["portal_origin"],
        "--dev-review-identity-origin", identity["identity_origin"],
    ], environment, identity["probe_seconds"])
    verify_env(original, run["env_sha256"], private_umask)


if __name__ == "__main__":
    main()
