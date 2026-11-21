#!/usr/bin/env python3
"""Create a fresh checkout from an already transferred local Git bundle."""

import json
import os
from pathlib import Path
import subprocess


def main():
    packet = json.loads(Path(__file__).with_name("packet.json").read_bytes())
    identity, run = packet["identity"], packet["run"]
    os.umask(int(identity["private_umask"], 8))
    home = Path("/home") / identity["guest_user"]
    tag = run["tag"]
    bundle = home / f"signed-{tag}-dev-incoming-source.bundle"
    if not bundle.is_file() or bundle != bundle.resolve(strict=True):
        raise SystemExit("expected a canonical local Git bundle")

    support = home / f"dev-signed-{tag}-dev"
    support.mkdir(mode=0o700)
    for child in ("inputs", "inputs/bin", "inputs/trust", "inputs/hosted", "private"):
        (support / child).mkdir(mode=0o700)
    repo = support / "source"
    checkout_umask = int(identity["checkout_umask"], 8)
    git_env = {
        "PATH": os.environ["PATH"], "GIT_ALLOW_PROTOCOL": "file",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
    }
    subprocess.run(
        ["git", "clone", "--no-checkout", "--", str(bundle), str(repo)],
        env=git_env, stdin=subprocess.DEVNULL, check=True, timeout=120, umask=checkout_umask,
    )
    git = ["git", "-C", str(repo)]
    subprocess.run(
        [*git, "checkout", "--detach", run["commit"]],
        env=git_env, stdin=subprocess.DEVNULL, check=True, timeout=30, umask=checkout_umask,
    )

    def git_output(*args):
        return subprocess.check_output(
            [*git, *args], env=git_env, stdin=subprocess.DEVNULL, text=True, timeout=30,
        ).strip()

    if git_output("rev-parse", "HEAD", "HEAD^{tree}").splitlines() != [run["commit"], run["tree"]]:
        raise SystemExit("guest checkout identity mismatch")
    if git_output("status", "--porcelain"):
        raise SystemExit("guest checkout is dirty")


if __name__ == "__main__":
    main()
