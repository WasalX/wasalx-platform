"""Require the deciding reviewer's GO on the PR's critical changes."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


POLICY_PATH = ".github/critical-paths.json"
SHA = re.compile(r"[0-9a-f]{40}")
VERDICT = re.compile(r"VERDICT: (GO|NO_GO) ([0-9a-f]{40})")
QUEUE_ENTRY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      mergeQueueEntry { baseCommit { oid } headCommit { oid } }
    }
  }
}
"""


def github(*args):
    result = subprocess.run(
        ["gh", "api", *args], check=True, stdout=subprocess.PIPE, timeout=20
    )
    return json.loads(result.stdout)


def commit_sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError("Expected a full commit SHA")
    return value


def load_policy(repo, base):
    config = github(
        "-H",
        "Accept: application/vnd.github.raw+json",
        f"{repo}/contents/{POLICY_PATH}?ref={base}",
    )
    ids, classes = config["reviewerAccountIds"], config["classes"]
    if (
        not isinstance(ids, list)
        or not ids
        or any(type(account_id) is not int or account_id <= 0 for account_id in ids)
    ):
        raise ValueError("Invalid reviewerAccountIds in critical-path configuration")
    if not isinstance(classes, dict) or not classes:
        raise ValueError("Missing critical-path classes")
    globs = set()
    for name, paths in classes.items():
        if (
            not isinstance(paths, list)
            or not paths
            or any(
                not isinstance(path, str)
                or not re.fullmatch(r"[\w.*-]+(?:/[\w.*-]+)*", path, re.ASCII)
                or {".", ".."} & set(path.split("/"))
                for path in paths
            )
        ):
            raise ValueError(f"Invalid paths in critical class {name}")
        globs.update(paths)
    patterns = [
        re.compile(
            re.escape(path)
            .replace(r"\*\*/", "(?:.*/)?")
            .replace(r"\*\*", ".*")
            .replace(r"\*", "[^/]*"),
            re.DOTALL,
        )
        for path in sorted(globs)
    ]
    if not any(pattern.fullmatch(POLICY_PATH) for pattern in patterns):
        raise ValueError("The critical-path configuration must cover its own path")
    return set(ids), patterns


def event_pr(event_name, event, repository, ref, candidate, base):
    if event_name == "pull_request":
        pr = event["pull_request"]
        number, head = pr["number"], pr["head"]["sha"]
        if (
            type(number) is not int
            or number <= 0
            or pr["base"]["sha"] != base
            or ref != f"refs/pull/{number}/merge"
        ):
            raise ValueError("Pull request does not match the event")
        return number, commit_sha(head), pr["base"]["ref"]

    if event_name != "merge_group":
        raise ValueError("Unsupported critical review event")
    group = event["merge_group"]
    branch = group["base_ref"].removeprefix("refs/heads/")
    match = re.fullmatch(
        rf"refs/heads/gh-readonly-queue/{re.escape(branch)}/pr-([1-9][0-9]*)-[0-9a-f]{{40}}",
        ref,
    )
    if (
        not match
        or group["head_ref"] != ref
        or group["head_sha"] != candidate
        or group["base_sha"] != base
    ):
        raise ValueError("Merge-group ref does not identify the event's PR")
    number = int(match[1])
    owner, name = repository.split("/")
    response = github(
        "graphql",
        "-f",
        f"query={QUEUE_ENTRY}",
        "-f",
        f"owner={owner}",
        "-f",
        f"name={name}",
        "-F",
        f"number={number}",
    )
    if response.get("errors"):
        raise ValueError("Could not read the PR's merge-queue entry")
    pr = response["data"]["repository"]["pullRequest"]
    entry = pr["mergeQueueEntry"]
    if (
        not entry
        or entry["baseCommit"]["oid"] != base
        or entry["headCommit"]["oid"] != candidate
    ):
        raise ValueError(f"PR #{number} no longer matches the merge-group candidate")
    return number, commit_sha(pr["headRefOid"]), branch


def pr_snapshot(endpoint, number):
    pr = github(endpoint)
    count = pr["changed_files"]
    if (
        pr["number"] != number
        or pr["state"] != "open"
        or type(count) is not int
        or not 0 <= count <= 3000
    ):
        raise ValueError(f"PR #{number} has no complete changed-file snapshot")
    return commit_sha(pr["head"]["sha"]), pr["base"]["ref"], commit_sha(pr["base"]["sha"]), count


def changed_paths(endpoint, number, head, branch):
    snapshot = pr_snapshot(endpoint, number)
    live_head, live_branch, _, count = snapshot
    if live_head != head or live_branch != branch:
        raise ValueError(f"PR #{number} no longer matches the event's head or target branch")
    pages = github("--paginate", "--slurp", f"{endpoint}/files?per_page=100")
    files = [file for page in pages for file in page]
    paths = {file["filename"] for file in files}
    if (
        len(files) != len(paths)
        or len(files) != count
        or pr_snapshot(endpoint, number) != snapshot
    ):
        raise ValueError(
            f"PR #{number} changed-file snapshot is incomplete or has moved"
        )
    paths.update(
        file["previous_filename"] for file in files if file["status"] == "renamed"
    )
    if any(
        not isinstance(path, str)
        or "\0" in path
        or {"", ".", ".."} & set(path.split("/"))
        for path in paths
    ):
        raise ValueError(f"PR #{number} has an invalid changed-file path")
    return paths


def reviewed_commit(repo, number, reviewer_ids):
    pages = github(
        "--paginate", "--slurp", f"{repo}/issues/{number}/comments?per_page=100"
    )
    # GitHub lists issue comments in ascending ID order across pages.
    for comment in (row for page in reversed(pages) for row in reversed(page)):
        if (comment["user"] or {}).get("id") not in reviewer_ids:
            continue
        lines = [
            line
            for line in (comment["body"] or "").splitlines()
            if line.lstrip().startswith("VERDICT:")
        ]
        if not lines:
            continue
        match = VERDICT.fullmatch(lines[0])
        if len(lines) != 1 or not match:
            raise ValueError(
                f"PR #{number} has a malformed verdict in comment {comment['id']}"
            )
        if match[1] != "GO":
            raise ValueError(f"PR #{number} has a NO_GO verdict on {match[2]}")
        return match[2]
    raise ValueError(f"PR #{number} needs a VERDICT: GO from a configured reviewer")


def critical_entries(repo, commit, paths):
    revision = github(f"{repo}/git/commits/{commit}")
    if revision["sha"] != commit:
        raise ValueError(f"Could not identify commit {commit}")
    tree = commit_sha(revision["tree"]["sha"])
    response = github(f"{repo}/git/trees/{tree}?recursive=1")
    if response["sha"] != tree or response["truncated"] is not False:
        raise ValueError(f"Could not read the complete tree at {commit}")
    return {
        item["path"]: (item["mode"], commit_sha(item["sha"]))
        for item in response["tree"]
        if item["type"] != "tree" and item["path"] in paths
    }


def check(event_name, event, repository, ref, candidate, base):
    repo = f"repos/{repository}"
    number, head, branch = event_pr(
        event_name, event, repository, ref, commit_sha(candidate), commit_sha(base)
    )
    reviewer_ids, patterns = load_policy(repo, base)
    paths = changed_paths(f"{repo}/pulls/{number}", number, head, branch)
    critical = {
        path for path in paths if any(pattern.fullmatch(path) for pattern in patterns)
    }
    if not critical:
        print(f"PR #{number} changes no listed critical paths.")
        return

    reviewed = reviewed_commit(repo, number, reviewer_ids)
    if reviewed != head:
        head_entries = critical_entries(repo, head, critical)
        reviewed_entries = critical_entries(repo, reviewed, critical)
        if head_entries != reviewed_entries:
            raise ValueError(
                f"PR #{number} has changed critical paths since the GO on {reviewed}"
            )
    print(f"PR #{number} head {head} is covered by the GO on {reviewed}.")


if __name__ == "__main__":
    try:
        check(
            os.environ["GITHUB_EVENT_NAME"],
            json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes()),
            os.environ["GITHUB_REPOSITORY"],
            os.environ["GITHUB_REF"],
            os.environ["GITHUB_SHA"],
            os.environ["REVIEW_BASE"],
        )
    except (
        KeyError,
        TypeError,
        ValueError,
        OSError,
        subprocess.SubprocessError,
    ) as exc:
        sys.exit(f"Critical review gate failed: {exc}")
