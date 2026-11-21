#!/usr/bin/env python3
"""Create a fresh checkout from an already transferred local Git bundle."""

import argparse
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()

    packet = json.loads(Path(__file__).with_name("packet.json").read_bytes())
    identity, run = packet["identity"], packet["run"]
    os.umask(int(identity["private_umask"], 8))
    bundle = args.bundle.resolve(strict=True)
    if not bundle.is_file() or bundle != args.bundle.absolute():
        raise SystemExit("expected a canonical local Git bundle")

    support = Path(identity["guest_root"]) / run["tag"]
    support.mkdir(parents=True, exist_ok=False)
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
