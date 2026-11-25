"""Move GHCR discovery aliases from an attempt-bound main CI publication."""

import argparse
from importlib import import_module
import json
import os
from pathlib import Path
import re
import subprocess

from image_registry_retry import last_diagnostic, registry_output


images = import_module("images-by-digest")
IMAGETOOLS = ("docker", "buildx", "imagetools")
POSITIVE_INTEGER = re.compile(r"[1-9][0-9]*")


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

    if not isinstance(current, str) or not images.SHA.fullmatch(current):
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
    if images.sha256(raw) != digest:
        raise ValueError(f"Discovery alias digest mismatch for {alias}")
    if current == commit:
        return f"Kept `{alias}` at `{current}`.", False
    return f"Advanced `{alias}` from `{current}` to `{commit}`.", False


def publication_event():
    source = tuple(os.environ.get(key) for key in ("GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REPOSITORY"))
    if source != ("workflow_run", "refs/heads/main", images.REPOSITORY):
        raise ValueError("Discovery alias updates require a completed main CI push")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
    run = event["workflow_run"]
    if (event.get("action") != "completed" or run.get("path") != ".github/workflows/ci.yml"
            or run.get("head_repository", {}).get("full_name") != source[2]
            or (run.get("event"), run.get("head_branch"), run.get("conclusion")) != ("push", "main", "success")):
        raise ValueError("Discovery alias updates require a completed main CI push")
    return run


def validate_publication(manifest_path, event):
    run_id, event_attempt, commit = event.get("id"), event.get("run_attempt"), event.get("head_sha")
    images.require(type(run_id) is int and run_id > 0 and type(event_attempt) is int and event_attempt > 0,
                   "Invalid triggering CI run ID or attempt")
    images.require(isinstance(commit, str) and images.SHA.fullmatch(commit), "Invalid triggering main commit")
    manifest_path = Path(manifest_path)
    raw = manifest_path.read_bytes()
    attempt_path = manifest_path.with_name("images-manifest-attempt.json")
    images.require(attempt_path.is_file(), "Alias publication requires a producing-attempt binding")
    binding = json.loads(attempt_path.read_bytes())
    images.require(isinstance(binding, dict) and binding.get("runId") == str(run_id)
                   and binding.get("manifestSha256") == images.sha256(raw),
                   "Publication attempt binding does not match the triggering run and manifest bytes")
    attempt = binding.get("runAttempt")
    images.require(isinstance(attempt, str) and POSITIVE_INTEGER.fullmatch(attempt),
                   "Invalid producing CI attempt")
    producer_attempt = int(attempt)
    images.require(producer_attempt <= event_attempt, "Manifest was produced by a later CI attempt")

    manifest = json.loads(raw)
    images.require(isinstance(manifest, dict) and all(isinstance(manifest.get(key), dict) for key in ("images", "pending")),
                   "Publication manifest requires image and pending receipt maps")
    tree = images.run("git", "rev-parse", "--verify", f"{commit}^{{commit}}^{{tree}}", cwd=images.ROOT)
    images.require((manifest.get("commit"), manifest.get("tree")) == (commit, tree),
                   "Publication manifest does not match the main push commit and tree")
    catalog = images.catalog(commit=commit)
    published = list(manifest["images"].values())
    pending = manifest["pending"]
    records = published + list(pending.values())
    assembled = images.assemble(records, rows=catalog)
    # Check the envelope and map keys against the publisher's canonical assembly.
    images.require(raw == (json.dumps(assembled, indent=2) + "\n").encode()
                   and (assembled["commit"], assembled["tree"]) == (commit, tree),
                   "Unmodified publication manifest for the triggering source required")
    images.require(not pending or set(pending) == images.addon_images(catalog),
                   "Pending publication must account for every add-on-dependent image")
    images.require(all(set(row) == {"image", "commit", "tree", "platform", "status"} for row in pending.values()),
                   "Pending add-on receipts cannot contain publication claims")
    images.require(all(row.get("platform") == assembled["platform"] for row in records),
                   "Publication receipt platform does not match the manifest")
    images.require_main_published_rows(published)
    # A rerun can reassemble receipts for successful image legs from earlier attempts of this run.
    for row in published:
        row_attempt = row.get("runAttempt")
        images.require(row.get("workflowSha") == commit and row.get("runId") == str(run_id)
                       and isinstance(row_attempt, str) and POSITIVE_INTEGER.fullmatch(row_attempt)
                       and int(row_attempt) <= producer_attempt,
                       f"Published image {row['image']} does not belong to this CI run and producing attempt")
    return manifest, producer_attempt


def advance_main_aliases(manifest_path, *, validate_only=False):
    event = publication_event()
    manifest, producer_attempt = validate_publication(manifest_path, event)
    commit = manifest["commit"]
    ready = producer_attempt == event["run_attempt"]
    if not ready:
        message = (f"HELD_PRIOR_ATTEMPT: CI run {event['id']} attempt {event['run_attempt']} reused "
                   f"the manifest from attempt {producer_attempt}. No aliases moved.")
        print(f"::warning::{message}")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write(f"- {message}\n")
    if validate_only:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"ready={str(ready).lower()}\n")
    if validate_only or not ready:
        return

    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        for row in manifest["images"].values():
            reference = row["pullReference"]
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    advance_main_aliases(args.manifest, validate_only=args.validate_only)
