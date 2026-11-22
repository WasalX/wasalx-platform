"""Move GHCR discovery aliases from the serialized main publication job."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
IMAGETOOLS = ("docker", "buildx", "imagetools")


def advance_alias(reference, commit):
    repository, digest = reference.split("@")
    alias = repository + ":main"
    try:
        config = subprocess.check_output([*IMAGETOOLS, "inspect", "--format", "{{json .Image.Config.Labels}}", alias],
                                         stderr=subprocess.DEVNULL, timeout=20)
        current = json.loads(config)["org.opencontainers.image.revision"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        current = None

    if not isinstance(current, str) or not SHA.fullmatch(current):
        return f"Skipped `{alias}` because its current revision could not be determined."
    if current == commit:
        return f"Kept `{alias}` at `{current}`."

    try:
        ancestry = subprocess.run(["git", "merge-base", "--is-ancestor", current, commit],
                                  stderr=subprocess.DEVNULL, timeout=10).returncode
    except (OSError, subprocess.SubprocessError):
        ancestry = None
    if ancestry == 1:
        return f"Skipped `{alias}` at `{current}` because `{commit}` does not descend from it."
    if ancestry != 0:
        return f"Skipped `{alias}` because ancestry from `{current}` could not be verified."

    subprocess.run([*IMAGETOOLS, "create", "--prefer-index=false", "--tag", alias, reference],
                   check=True, timeout=60)
    raw = subprocess.check_output([*IMAGETOOLS, "inspect", "--raw", alias], timeout=20)
    if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError(f"Discovery alias digest mismatch for {alias}")
    return f"Advanced `{alias}` from `{current}` to `{commit}`."


def advance_main_aliases(manifest_path):
    source = tuple(os.environ.get(key) for key in ("GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REPOSITORY"))
    if source != ("push", "refs/heads/main", "WasalX/wasalx-platform"):
        raise ValueError("Discovery alias updates require a main push")

    manifest = json.loads(Path(manifest_path).read_bytes())
    commit = manifest["commit"]
    if commit != os.environ["GITHUB_SHA"] or not SHA.fullmatch(commit):
        raise ValueError("Publication manifest does not match the main push")

    references = []
    for image, row in manifest["images"].items():
        digest = row["digest"]
        if (not re.fullmatch(r"[a-z0-9-]+", image) or not DIGEST.fullmatch(digest)
                or row["commit"] != commit or row["verified"] is not True):
            raise ValueError("Verified publication digest required for alias updates")
        references.append(f"ghcr.io/wasalx/{image}@{digest}")

    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        for reference in references:
            message = advance_alias(reference, commit)
            print(message)
            summary.write(f"- {message}\n")


if __name__ == "__main__":
    advance_main_aliases(sys.argv[1])
