#!/usr/bin/env python3
"""Run one credential-free DEV report tick."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


REPO = "WasalX/wasalx-platform"
API = f"https://api.github.com/repos/{REPO}"
RELEASES = "/releases?per_page=5"
ASSET = "images-manifest.json"
CENSUS = "Confirm census PASS"
SHA = re.compile(r"[0-9a-f]{40}")
HEX = re.compile(r"[0-9a-f]{64}")
RC = re.compile(r"v[A-Za-z0-9_.-]*-rc\.[A-Za-z0-9_.-]+")
CODES = {"ELIGIBLE", "VERIFIED", "STAGED", "HOLD_VERIFY", "HOLD_STAGING"}
ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "scripts/dev-install"


class Pending(Exception):
    """Public evidence has yet to qualify this release."""


class RateLimit(Exception):
    def __init__(self, until):
        self.until = until


class AssetRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, new_url):
        source, target = urlsplit(req.full_url), urlsplit(new_url)
        if (source.netloc == "github.com" and target.scheme == "https"
                and target.netloc in {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}):
            return Request(new_url, headers={"User-Agent": "wasalx-dev-pull"})
        return None


class GitHub:
    def __init__(self, opener=None):
        self.open = opener or build_opener(ProxyHandler({}), AssetRedirect()).open
        self.remaining = None
        self.reset = 0

    def request(self, path, *, etag=None, asset=False):
        if not asset and self.remaining == 0:
            raise RateLimit(max(self.reset, int(time.time()) + 600))
        headers = {"User-Agent": "wasalx-dev-pull", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if etag:
            headers["If-None-Match"] = etag
        url = f"https://github.com/{REPO}/releases/download/{path}/{ASSET}" if asset else API + path
        try:
            with self.open(Request(url, headers=headers), timeout=20) as response:
                if not asset:
                    self.update_budget(response.headers)
                limit = 2**20 if asset else 4 * 2**20
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise Pending()
                return raw, response.headers.get("ETag")
        except HTTPError as error:
            error.close()
            if not asset:
                self.update_budget(error.headers)
                retry = error.headers.get("Retry-After")
                if error.code in {403, 429} and (retry or self.remaining == 0 or error.code == 429):
                    now = int(time.time())
                    raise RateLimit(max(now + max(600, number(retry)), self.reset if self.remaining == 0 else 0))
            if error.code == 304 and etag:
                return None, etag
            if error.code == 404:
                raise Pending() from None
            raise

    def update_budget(self, headers):
        if headers.get("X-RateLimit-Remaining") is not None:
            self.remaining = number(headers["X-RateLimit-Remaining"])
            self.reset = number(headers.get("X-RateLimit-Reset"))

    def json(self, path):
        return json.loads(self.request(path)[0])


def number(value):
    return int(value) if value and value.isdecimal() else 0


def require(condition):
    if not condition:
        raise Pending()


def object_sha(value):
    require(isinstance(value, str) and SHA.fullmatch(value))
    return value


def tag_commit(api, tag):
    ref = f"refs/tags/{tag}"
    tag_object = api.json(f"/git/ref/tags/{quote(tag, safe='')}")
    require(tag_object["ref"] == ref)
    obj = tag_object["object"]
    # Bound annotated tag dereferences within the per-tick API budget.
    for _ in range(3):
        sha = object_sha(obj["sha"])
        if obj["type"] == "commit":
            return sha
        require(obj["type"] == "tag")
        detail = api.json(f"/git/tags/{sha}")
        require(detail["sha"] == sha)
        obj = detail["object"]
    raise Pending()


def main_tree(api, commit):
    compare = api.json(f"/compare/{commit}...main?per_page=1")
    require(compare["status"] in {"ahead", "identical"})
    base = compare["base_commit"]
    require(base["sha"] == commit)
    return object_sha(base["commit"]["tree"]["sha"])


def successful_steps(api, workflow, commit, job_name, step=None, *, event=None):
    filters = f"head_sha={commit}&status=success&per_page=10"
    if event:
        filters += "&event=push&branch=main"
    runs = api.json(f"/actions/workflows/{workflow}/runs?{filters}")["workflow_runs"]
    run = next((row for row in runs
                if row["head_sha"] == commit and row["conclusion"] == "success"
                and row["head_repository"]["full_name"] == REPO
                and (row["event"] == "push" and row["head_branch"] == "main" if event
                     else row["event"] in {"schedule", "workflow_dispatch", "push"})), None)
    require(run is not None)
    run_id = run["id"]
    require(type(run_id) is int and run_id > 0)
    jobs = api.json(f"/actions/runs/{run_id}/jobs?filter=latest&per_page=100")["jobs"]
    matching = [job for job in jobs if job["name"] == job_name and job["head_sha"] == commit
                and job["conclusion"] == "success"]
    require(len(matching) == 1)
    if step:
        require(any(item["name"] == step and item["conclusion"] == "success" for item in matching[0]["steps"]))


def release_asset(release):
    assets = [asset for asset in release["assets"] if asset["name"] == ASSET and asset["state"] == "uploaded"]
    if len(assets) == 1:
        digest = assets[0].get("digest") or ""
        if digest.startswith("sha256:") and HEX.fullmatch(digest[7:]):
            return digest[7:]
    return None


def eligible(api, tag, digest):
    commit = tag_commit(api, tag)
    tree = main_tree(api, commit)
    successful_steps(api, "ci.yml", commit, "publish / Image digest manifest", event="push")
    successful_steps(api, "nightly-install.yml", commit, "nightly-install", CENSUS)
    raw, _ = api.request(quote(tag, safe=""), asset=True)
    require(sha256(raw) == digest)
    return commit, tree, raw


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def durable_replace(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Outbox:
    def __init__(self, directory, key):
        self.directory, self.key = directory, key
        directory.mkdir(mode=0o700, exist_ok=True)
        self.last = "0" * 64
        self.seq = 0
        self.progress = {}
        # The relay reads numbered JSON files only. An orphan signature can be replaced.
        for sequence, path in enumerate(sorted(directory.glob("*.json")), 1):
            raw = path.read_bytes()
            record = json.loads(raw)
            if (path.name != f"{sequence:020}.json" or record["seq"] != sequence
                    or record["prev_sha256"] != self.last or record["code"] not in CODES
                    or not path.with_suffix(".json.sig").is_file()):
                raise ValueError("broken receipt chain")
            self.remember(record, raw)

    def remember(self, record, raw):
        self.seq, self.last = record["seq"], sha256(raw)
        self.progress[(record["tag"], record["manifest_sha256"])] = record

    def add(self, tag, commit, digest, code, started):
        previous = self.progress.get((tag, digest))
        data = {"schema_version": 1, "seq": self.seq + 1, "prev_sha256": self.last,
                "attempt_id": sha256(f"{tag}\n{commit}\n{digest}".encode()), "tag": tag, "commit": commit,
                "manifest_sha256": digest, "code": code,
                "stage_stamps": {"started_at": started, "recorded_at": stamp()}}
        if previous and previous["commit"] != commit:
            raise ValueError("receipt identity changed")
        raw = json_bytes(data)
        path = self.directory / f"{data['seq']:020}.json"
        # ssh-keygen signs stdin to stdout, so no half-written JSON becomes visible.
        public_key = subprocess.check_output(
            ["ssh-keygen", "-y", "-f", self.key], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10, env=command_env(self.directory))
        if not public_key.startswith(b"ssh-ed25519 "):
            raise ValueError("receipt key must be Ed25519")
        signature = subprocess.check_output(
            ["ssh-keygen", "-Y", "sign", "-f", self.key, "-n", "wasalx-dev-receipt"],
            input=raw, stderr=subprocess.DEVNULL, timeout=10, env=command_env(self.directory))
        durable_replace(path.with_suffix(".json.sig"), signature)
        durable_replace(path, raw)
        self.remember(data, raw)
        print(code, flush=True)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def command_env(work):
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(work), "XDG_CACHE_HOME": str(work),
            "DOCKER_CONFIG": str(work / "docker"), "SSH_ASKPASS_REQUIRE": "never"}


def command(args, work, timeout):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, env=command_env(work), timeout=timeout)


def verify(manifest, commit, tree, config, *, inventory_only=False):
    tools = ["node", TOOLS / "pull-verify.mjs", manifest, commit, tree, config["cosign"],
             config["trusted_root"], config["trusted_root_sha256"]]
    work = manifest.parent
    if inventory_only:
        command([*tools, "inventory"], work, 20)
        return
    command(tools, work, 300)


def fetch_bundles(manifest):
    command([sys.executable, "-I", "-B", ROOT / "scripts/release/images-by-digest.py",
             "stage-hosted-bundles", "--manifest", manifest], manifest.parent, 270)


def cache_releases(api, state):
    path = state / "releases.json"
    cache = json.loads(path.read_bytes()) if path.exists() else {}
    until = cache.get("backoff_until", 0)
    if time.time() < until:
        raise RateLimit(until)
    raw, etag = api.request(RELEASES, etag=cache.get("etag"))
    if raw is not None:
        releases = json.loads(raw)
        if not isinstance(releases, list):
            raise ValueError("invalid release listing")
        cache = {"etag": etag, "releases": releases}
        durable_replace(path, json_bytes(cache))
    return cache["releases"]


def offpeak_seconds():
    now = datetime.now(timezone.utc)
    seconds = now.hour * 3600 + now.minute * 60 + now.second
    if now.hour >= 23:
        seconds -= 24 * 3600
    return max(0, 15 * 3600 - seconds)


def tick(api, outbox, state, config):
    releases = cache_releases(api, state)
    for release in releases:
        tag = release["tag_name"]
        if not (len(tag) <= 128 and RC.fullmatch(tag) and release["prerelease"] is True and release["draft"] is False):
            continue
        digest = release_asset(release)
        record = outbox.progress.get((tag, digest))
        if digest and (not record or record["code"] not in {"STAGED", "HOLD_VERIFY"}):
            break
    else:
        return
    if record and offpeak_seconds() < 600:
        return
    if api.remaining is not None and api.remaining < 9:
        raise RateLimit(max(api.reset, int(time.time()) + 600))
    started = stamp()
    commit, tree, raw = eligible(api, tag, digest)
    if record and record["commit"] != commit:
        raise Pending()
    with tempfile.TemporaryDirectory(prefix="pull-", dir=state) as temporary:
        work = Path(temporary)
        manifest = work / ASSET
        manifest.write_bytes(raw)
        verify(manifest, commit, tree, config, inventory_only=True)
        if not record:
            outbox.add(tag, commit, digest, "ELIGIBLE", started)
        if offpeak_seconds() < 600:
            return
        with open(config["lane_lock"], "rb") as lane:
            try:
                fcntl.flock(lane, fcntl.LOCK_EX | fcntl.LOCK_NB)
                command([config["stage_guard"]], work, 30)
            except (BlockingIOError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                return
            verified = record and record["code"] in {"VERIFIED", "HOLD_STAGING"}
            try:
                fetch_bundles(manifest)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                print("PUBLIC_INPUT_UNAVAILABLE")
                return
            try:
                verify(manifest, commit, tree, config)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                outbox.add(tag, commit, digest, "HOLD_VERIFY", started)
                return
            if not verified:
                outbox.add(tag, commit, digest, "VERIFIED", started)
            remaining = offpeak_seconds()
            if remaining <= 0:
                return
            try:
                command(["/bin/bash", TOOLS / "host-staging.sh", manifest, config["staging_dir"],
                         config["staging_mount"]],
                        work, min(8400, remaining))
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if not record or record["code"] != "HOLD_STAGING":
                    outbox.add(tag, commit, digest, "HOLD_STAGING", started)
                return
            outbox.add(tag, commit, digest, "STAGED", started)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = json.loads(args.config.read_bytes())
        if config["mode"] != "report":
            raise ValueError("unsupported mode")
        state = Path(os.environ["STATE_DIRECTORY"])
        with (state / "tick.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            try:
                tick(GitHub(), Outbox(state / "outbox", args.key), state, config)
            except RateLimit as limit:
                path = state / "releases.json"
                cache = json.loads(path.read_bytes()) if path.exists() else {}
                cache["backoff_until"] = limit.until
                durable_replace(path, json_bytes(cache))
                print("RATE_LIMIT")
            except Pending:
                print("PENDING")
            except (URLError, TimeoutError):
                print("PUBLIC_INPUT_UNAVAILABLE")
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("REPORT_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
