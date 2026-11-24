"""Scan event text and newly introduced Git lines using public patterns."""
from itertools import islice
import json
import os
from pathlib import Path
import re
import subprocess
import sys


OCTET = r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[0-9]{1,2})"
RULES = {
    "github-token": r"\b(?:gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})\b",
    "aws-key-id": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "slack-token": r"\bxox[baprs]-[0-9]{8,}-[a-zA-Z0-9-]{12,}\b",
    "jwt": r"\beyJ[a-zA-Z0-9_-]{5,}\.eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{16,}\b",
    "private-key": r"-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----",
    "private-ipv4": rf"(?<![0-9.])(?:10\.{OCTET}|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.{OCTET}\.{OCTET}(?![0-9]|\.[0-9])",
    "private-path": r"""(?i)(?<![\w])(?:[a-z]:[\\/]+[^\s"'<>|/\\]+|/(?:home|users)/[\w.-]+/)""",
}
RULES = {name: re.compile(pattern) for name, pattern in RULES.items()}
PRIVATE_HOST = re.compile(
    r"(?i)(?:\b[a-z][a-z0-9+.-]*://|@)"
    r"((?:[a-z0-9-]+\.)+(?:internal|lan|local|home\.arpa))"
    r"""\.?(?::[0-9]+)?(?=$|[/?#\s"'\x60),;}\]<>])"""
)
# Public local-development and cluster placeholders already used in the repository.
PLACEHOLDER_HOSTS = {"example.internal", "identity.local", "host.docker.internal", "release.home.arpa"}
SHA = re.compile(r"[0-9a-f]{40}")
HUNK = re.compile(rb"@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@")


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL)


def matches(text):
    rules = [name for name, pattern in RULES.items() if pattern.search(text)]
    hosts = (match[1].lower() for match in PRIVATE_HOST.finditer(text))
    if any(host not in PLACEHOLDER_HOSTS and not host.endswith(".svc.cluster.local") for host in hosts):
        rules.append("private-host")
    return rules


def findings(text, location):
    for number, line in enumerate(text.splitlines(), 1):
        for rule in matches(line):
            yield location, number, rule


def changes(parent, commit):
    diff = git("diff-tree", "-r", "--root", "--no-commit-id", "--no-ext-diff", "--no-textconv",
               "--no-renames", "--no-color", "--text", "--unified=0", "--patch-with-raw",
               "-z", "--diff-filter=AMT", *parent[:1], commit)
    if not diff:
        return
    # Raw NUL-delimited paths are in patch order and preserve unusual filenames.
    raw, separator, patch = diff.partition(b"\0\0")
    if not separator:
        raise ValueError
    paths = islice(raw.split(b"\0"), 1, None, 2)
    previous_header = None
    number = None
    for line in patch.split(b"\n"):
        if line.startswith(b"diff --git "):
            # Git can emit separate deletion and addition patches for a type change.
            if line != previous_header:
                path = next(paths).decode("utf-8", errors="replace")
                path_rules = matches(path)
                location = "<redacted path>" if path_rules else path
                for rule in path_rules:
                    yield location, 1, rule
                previous_header = line
            number = None
        elif line.startswith(b"@@ "):
            number = int(HUNK.match(line)[1])
        elif number is not None and line.startswith(b"+"):
            for rule in matches(line[1:].decode("utf-8", errors="replace")):
                yield location, number, rule
            number += 1
    if next(paths, None) is not None:
        raise ValueError


def merge_parent(parents, upstream):
    if len(parents) > 1:
        for parent in parents:
            ancestry = subprocess.run(["git", "merge-base", "--is-ancestor", parent, upstream],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ancestry.returncode == 0:
                return [parent]
            if ancestry.returncode != 1:
                ancestry.check_returncode()
    return parents[:1]


def commit_findings(base, head, upstream=None):
    upstream = upstream or base
    if not all(SHA.fullmatch(sha) for sha in (base, head, upstream)):
        raise ValueError
    log = git("log", "--no-show-signature", "-z", "--format=%H%x00%P%x00%an <%ae>%x00%cn <%ce>%x00%B",
              head, f"^{base}", f"^{upstream}", "--")
    if not log:
        return
    fields = log.decode("utf-8", errors="replace").removesuffix("\0").split("\0")
    for index in range(0, len(fields), 5):
        commit, parents, author, committer, message = fields[index:index + 5]
        yield from findings(author, "commit.author")
        yield from findings(committer, "commit.committer")
        yield from findings(message, "commit.message")
        # Diff a merge against its upstream parent to exclude files already published on main.
        yield from changes(merge_parent(parents.split(), upstream), commit)


def scan(event, payload):
    upstream = None
    if event in ("pull_request", "issues"):
        field = "pull_request" if event == "pull_request" else "issue"
        item = payload[field]
        yield from findings(item["title"], f"{field}.title")
        body = item["body"]
        if body is not None:
            yield from findings(body, f"{field}.body")
        if event == "issues" or payload.get("action") == "edited":
            return
        yield from findings(item["head"]["ref"], "pull_request.head.ref")
        base, head = item["base"]["sha"], os.environ["GITHUB_SHA"]
    elif event == "merge_group":
        base, head = payload["merge_group"]["base_sha"], payload["merge_group"]["head_sha"]
    elif event == "push":
        ref = payload["ref"]
        yield from findings(ref, "push.ref")
        base, head = payload["before"], payload["after"]
        default = payload["repository"]["default_branch"]
        if ref != f"refs/heads/{default}" or base == "0" * 40:
            upstream = git("rev-parse", "--verify", "--end-of-options",
                           f"refs/remotes/origin/{default}^{{commit}}").decode("ascii").strip()
            # New or force-pushed branches may have no reachable previous tip.
            if base == "0" * 40 or payload.get("forced") is True:
                base = upstream
    else:
        raise ValueError
    yield from commit_findings(base, head, upstream)


def main():
    try:
        payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
        result = 0
        for path, number, rule in scan(os.environ["GITHUB_EVENT_NAME"], payload):
            print(f"privacy {json.dumps(path)}:{number} {rule}")
            result = 1
        return result
    except (AttributeError, KeyError, OSError, StopIteration, TypeError, ValueError, subprocess.CalledProcessError):
        # Exception messages and Git stderr can contain untrusted text.
        print("Privacy scan could not read its input.")
        return 2


if __name__ == "__main__":
    sys.exit(main())
