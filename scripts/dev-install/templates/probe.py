#!/usr/bin/env python3
"""Run the native read-only capture with the installed Compose environment."""

import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess


def verify_env(path, expected, private_umask):
    info = path.lstat()
    if (path.resolve(strict=True) != path or not stat.S_ISREG(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o666 & ~private_umask or info.st_nlink != 1
            or hashlib.sha256(path.read_bytes()).hexdigest() != expected):
        raise SystemExit("installed environment identity mismatch")


def capture(repo, argv, environment, seconds):
    with subprocess.Popen(
        argv, cwd=repo, env=environment, stdin=subprocess.DEVNULL, start_new_session=True,
    ) as process:
        try:
            status = process.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            # The native entry point spawns flock, which execs the lock owner.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise SystemExit("native preflight timed out") from None
    if status:
        raise SystemExit(f"native preflight failed ({status})")


def main():
    packet = json.loads(Path(__file__).with_name("packet.json").read_bytes())
    identity, run = packet["identity"], packet["run"]
    private_umask = int(identity["private_umask"], 8)
    os.umask(private_umask)
    support = Path(identity["guest_root"]) / run["tag"]
    repo = support / "source"
    original = Path(identity["original_env"])
    verify_env(original, run["env_sha256"], private_umask)
    environment = {
        "PATH": os.environ["PATH"],
        "COMMIT_SHA": run["commit"],
        "WASALX_CANDIDATE_SHA": run["commit"],
        "WASALX_CANDIDATE_TREE": run["tree"],
    }
    capture(repo, [
        "node", "scripts/release/installer-stages.mjs", "preflight",
        "--env-file", str(original), "--project-name", identity["project"],
        "--capture-dev-preimages", str(support / "preimages.json"),
        "--dev-review-origin", identity["portal_origin"],
        "--dev-review-identity-origin", identity["identity_origin"],
    ], environment, identity["probe_seconds"])
    verify_env(original, run["env_sha256"], private_umask)


if __name__ == "__main__":
    main()
