"""Move GHCR discovery aliases from the serialized main publication job."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from image_registry_retry import last_diagnostic, registry_output


SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
IMAGETOOLS = ("docker", "buildx", "imagetools")


def advance_alias(reference, commit):
    repository, digest = reference.split("@")
    alias = repository + ":main"
    try:
        config = registry_output(*IMAGETOOLS, "inspect", "--format", "{{json .Image.Config.Labels}}", alias, timeout=20)
        current = json.loads(config)["org.opencontainers.image.revision"]
    except subprocess.CalledProcessError as error:
        reason = last_diagnostic(error.stderr).lower()
        if "manifest unknown" not in reason and not reason.endswith(f"{alias}: not found"):
            raise
        current = None
    except (ValueError, KeyError, TypeError):
        current = None

    if not isinstance(current, str) or not SHA.fullmatch(current):
        return f"Skipped `{alias}` because its current revision could not be determined.", True
    if current != commit:
        try:
            ancestry = subprocess.run(["git", "merge-base", "--is-ancestor", current, commit],
                                      stderr=subprocess.DEVNULL, timeout=10).returncode
        except (OSError, subprocess.SubprocessError):
            ancestry = None
        if ancestry == 1:
            return f"Skipped `{alias}` at `{current}` because `{commit}` does not descend from it.", True
        if ancestry != 0:
            return f"Skipped `{alias}` because ancestry from `{current}` could not be verified.", True

        # Every attempt tags the same immutable digest under the serialized alias job.
        registry_output(*IMAGETOOLS, "create", "--prefer-index=false", "--tag", alias, reference,
                        timeout=60, capture_stdout=False)
    raw = registry_output(*IMAGETOOLS, "inspect", "--raw", alias, timeout=20)
    if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError(f"Discovery alias digest mismatch for {alias}")
    if current == commit:
        return f"Kept `{alias}` at `{current}`.", False
    return f"Advanced `{alias}` from `{current}` to `{commit}`.", False


def advance_main_aliases(manifest_path):
    source = tuple(os.environ.get(key) for key in ("GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REPOSITORY"))
    if source != ("workflow_run", "refs/heads/main", "WasalX/wasalx-platform"):
        raise ValueError("Discovery alias updates require a completed main CI push")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
    run = event["workflow_run"]
    if (event.get("action") != "completed" or run.get("path") != ".github/workflows/ci.yml"
            or run.get("head_repository", {}).get("full_name") != source[2]
            or (run.get("event"), run.get("head_branch"), run.get("conclusion")) != ("push", "main", "success")):
        raise ValueError("Discovery alias updates require a completed main CI push")

    manifest = json.loads(Path(manifest_path).read_bytes())
    commit = manifest["commit"]
    if commit != run.get("head_sha") or not SHA.fullmatch(commit):
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
            try:
                message, skipped = advance_alias(reference, commit)
            except (OSError, subprocess.SubprocessError, ValueError):
                alias = reference.split("@", 1)[0] + ":main"
                message = f"Failed to verify `{alias}` at `{commit}`. The alias may have changed."
                print(f"::error::{message}")
                summary.write(f"- {message}\n")
                raise
            print(f"::warning::{message}" if skipped else message)
            summary.write(f"- {message}\n")


if __name__ == "__main__":
    advance_main_aliases(sys.argv[1])
