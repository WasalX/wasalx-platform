#!/usr/bin/env python3
"""Run one credential-free DEV report tick."""

import argparse
import base64
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
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


REPO = "WasalX/wasalx-platform"
API = f"https://api.github.com/repos/{REPO}"
RELEASES = "/releases?per_page=5"
ASSET = "images-manifest.json"
CENSUS = "Confirm census PASS"
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
# Keep this grammar identical to the D1 consumer's RC tag grammar.
RC = re.compile(r"v[A-Za-z0-9_.-]{0,108}-rc\.[A-Za-z0-9_.-]{1,16}")
IMAGE_NAME = r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*"
DOCKER_HUB_PREFIX = r"(?:(?:docker|index\.docker|registry-1\.docker)\.io/(?:library/)?|library/)"
REF = re.compile(rf"(?!{DOCKER_HUB_PREFIX}){IMAGE_NAME}@{DIGEST.pattern}")
COMPOSE_REF = re.compile(
    rf"({IMAGE_NAME})(?::[A-Za-z0-9_][A-Za-z0-9_.-]{{0,127}})?@((?ai:{DIGEST.pattern}))"
)
PRODUCT_PREFIX = "ghcr.io/wasalx/"
SCHEMA = "ot3.wasalx.d1-handover/v1"
CONFIG_FIELDS = {"mode", "cosign", "trusted_root", "trusted_root_sha256"}
MEDIA_TYPES = (
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)
ANONYMOUS_TOKEN = {
    "registry-1.docker.io": ("https://auth.docker.io/token", "registry.docker.io"),
    "ghcr.io": ("https://ghcr.io/token", "ghcr.io"),
    "quay.io": ("https://quay.io/v2/auth", "quay.io"),
}
ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "scripts/dev-install"


class Pending(Exception):
    """Public evidence has yet to qualify this release."""


class TrustedRootMismatch(Exception):
    """The installed Sigstore trusted root does not match the packet."""


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

    def request(self, path, *, etag=None, asset=False, raw=False):
        if not asset and self.remaining == 0:
            raise RateLimit(max(self.reset, int(time.time()) + 600))
        headers = {"User-Agent": "wasalx-dev-pull", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if raw:
            headers["Accept"] = "application/vnd.github.raw+json"
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


def successful_steps(api, workflow, commit, job_name, *, tag=None):
    if tag:
        filters = f"event=push&branch={quote(tag, safe='')}&head_sha={commit}&per_page=1"
    else:
        filters = f"head_sha={commit}&status=success&per_page=10&event=push&branch=main"
    runs = api.json(f"/actions/workflows/{workflow}/runs?{filters}")["workflow_runs"]
    if tag:
        runs = runs[:1]
    run = next((row for row in runs
                if row["head_sha"] == commit and row["status"] == "completed" and row["conclusion"] == "success"
                and row["head_repository"]["full_name"] == REPO
                and row["event"] == "push" and row["head_branch"] == (tag or "main")), None)
    require(run is not None)
    run_id, attempt = run["id"], run["run_attempt"]
    require(positive_int(run_id) and positive_int(attempt))
    jobs = api.json(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")["jobs"]
    matching = [job for job in jobs if job["name"] == job_name and job["head_sha"] == commit
                and job["conclusion"] == "success"]
    require(len(matching) == 1)
    if tag:
        require(any(item["name"] == CENSUS and item["conclusion"] == "success" for item in matching[0]["steps"]))
    return run_id, attempt


def positive_int(value):
    return type(value) is int and value > 0


def release_asset(release):
    assets = [asset for asset in release["assets"] if asset["name"] == ASSET and asset["state"] == "uploaded"]
    if len(assets) == 1:
        digest = assets[0].get("digest") or ""
        if DIGEST.fullmatch(digest):
            return digest
    return None


def eligible(api, tag, commit, digest):
    tree = main_tree(api, commit)
    successful_steps(api, "ci.yml", commit, "publish / Image digest manifest")
    run_id, attempt = successful_steps(api, "nightly-install.yml", commit, "nightly-install", tag=tag)
    raw, _ = api.request(quote(tag, safe=""), asset=True)
    require(content_digest(raw) == digest)
    return tree, raw, {"run_id": run_id, "attempt": attempt, "census": "PASS"}


def content_digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def fields(value, *names):
    return isinstance(value, dict) and value.keys() == set(names)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value)


def validate_handover(data):
    if (not fields(data, "schema", "source", "tag", "commit", "tree", "refs", "counts",
                   "release_asset_digest", "nightly", "receipt", "signer", "signature")
            or data["schema"] != SCHEMA or data["source"] != "b2-verified"
            or not matches(RC, data["tag"]) or not matches(SHA, data["commit"]) or not matches(SHA, data["tree"])
            or not matches(DIGEST, data["release_asset_digest"])):
        raise ValueError("invalid hand-over identity")
    counts, refs = data["counts"], data["refs"]
    if not fields(counts, "product", "compose") or not isinstance(refs, list):
        raise ValueError("invalid hand-over refs")
    observed = {"product": 0, "compose": 0}
    previous = ""
    for row in refs:
        if (not fields(row, "ref", "mediaType", "origin") or not matches(REF, row["ref"])
                or (row["mediaType"] is not None and not isinstance(row["mediaType"], str))
                or row["origin"] not in ("product", "compose") or row["ref"] <= previous
                or row["ref"].startswith(PRODUCT_PREFIX) != (row["origin"] == "product")):
            raise ValueError("invalid hand-over ref")
        observed[row["origin"]] += 1
        previous = row["ref"]
    if any(type(count) is not int for count in counts.values()) or counts != observed or counts["product"] != 21:
        raise ValueError("invalid hand-over counts")
    nightly, receipt, signer = data["nightly"], data["receipt"], data["signer"]
    if (not fields(nightly, "run_id", "attempt", "census") or not positive_int(nightly["run_id"])
            or not positive_int(nightly["attempt"]) or nightly["census"] != "PASS"
            or not fields(receipt, "seq", "prev_hash", "produced_utc") or not positive_int(receipt["seq"])
            or (receipt["prev_hash"] is not None and not matches(DIGEST, receipt["prev_hash"]))
            or not matches(r"[0-9]{4}(?:-[0-9]{2}){2}T[0-9]{2}(?::[0-9]{2}){2}Z", receipt["produced_utc"])
            or not fields(signer, "key_id", "alg") or signer["alg"] != "ed25519"
            or not matches(r"SHA256:[A-Za-z0-9+/]{43}", signer["key_id"])
            or not isinstance(data["signature"], str)):
        raise ValueError("invalid hand-over evidence")
    signature = base64.b64decode(data["signature"], validate=True)
    if not (signature.startswith(b"-----BEGIN SSH SIGNATURE-----\n")
            and signature.endswith(b"-----END SSH SIGNATURE-----\n")):
        raise ValueError("invalid hand-over signature")


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
        self.last = None
        self.seq = 0
        self.tags = {}
        for sequence, path in enumerate(sorted(directory.glob("*.json")), 1):
            raw = path.read_bytes()
            record = json.loads(raw)
            validate_handover(record)
            if (path.name != f"{sequence:020}.json" or record["receipt"]["seq"] != sequence
                    or record["receipt"]["prev_hash"] != self.last or raw != json_bytes(record)
                    or record["tag"] in self.tags):
                raise ValueError("broken receipt chain")
            self.remember(record, raw)

    def remember(self, record, raw):
        self.seq, self.last = record["receipt"]["seq"], content_digest(raw)
        self.tags[record["tag"]] = (record["commit"], record["release_asset_digest"])

    def add(self, handover):
        if handover["tag"] in self.tags:
            raise ValueError("receipt already exists")
        public_key = subprocess.check_output(
            ["ssh-keygen", "-y", "-f", self.key], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=10, env=command_env(self.directory)).split()
        if len(public_key) < 2 or public_key[0] != b"ssh-ed25519":
            raise ValueError("receipt key must be Ed25519")
        fingerprint = hashlib.sha256(base64.b64decode(public_key[1], validate=True)).digest()
        key_id = "SHA256:" + base64.b64encode(fingerprint).decode("ascii").rstrip("=")
        sequence = self.seq + 1
        data = {**handover, "receipt": {"seq": sequence, "prev_hash": self.last, "produced_utc": stamp()},
                "signer": {"key_id": key_id, "alg": "ed25519"}}
        signature = subprocess.check_output(
            ["ssh-keygen", "-Y", "sign", "-f", self.key, "-n", "wasalx-dev-receipt"],
            input=json_bytes(data), stderr=subprocess.DEVNULL, timeout=10, env=command_env(self.directory))
        data["signature"] = base64.b64encode(signature).decode("ascii")
        validate_handover(data)
        raw = json_bytes(data)
        durable_replace(self.directory / f"{sequence:020}.json", raw)
        self.remember(data, raw)
        print("VERIFIED", flush=True)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def command_env(work):
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(work), "XDG_CACHE_HOME": str(work),
            "DOCKER_CONFIG": str(work / "docker"), "SSH_ASKPASS_REQUIRE": "never"}


def verify(manifest, commit, tree, config, *, stderr=subprocess.DEVNULL, staged=False):
    # The verifier also checks the exact root bytes it passes to Cosign.
    root_digest = content_digest(Path(config["trusted_root"]).read_bytes())
    if root_digest != f"sha256:{config['trusted_root_sha256']}":
        raise TrustedRootMismatch
    tools = ["node", TOOLS / "pull-verify.mjs", manifest, commit, tree, config["cosign"],
             config["trusted_root"], config["trusted_root_sha256"]]
    if staged:
        tools.append("--staged")
    return json.loads(subprocess.check_output(
        tools, stdin=subprocess.DEVNULL, stderr=stderr, env=command_env(manifest.parent), timeout=300))


def compose_refs(api, commit, product_refs):
    # The local build aliases are represented by the verified product references.
    local = {"wasalx/" + ref.removeprefix(PRODUCT_PREFIX).split("@")[0] for ref in product_refs}
    if "wasalx/secret-sidecar" in local:
        local.add("wasalx/dev-secret-sidecar")
    refs = set()
    for name in ("compose.yaml", "compose.full.yaml"):
        raw, _ = api.request(f"/contents/{name}?ref={commit}", raw=True)
        for value in re.findall(r"(?m)^[ \t]+image:[ \t]*(.*)$", raw.decode("utf-8")):
            ref = value.split(" #", 1)[0].strip().strip("'\"")
            if "@" not in ref and ref.split(":")[0] in local:
                continue
            pinned = COMPOSE_REF.fullmatch(ref)
            require(pinned is not None)
            image, digest = pinned.groups()
            image = re.sub(rf"^{DOCKER_HUB_PREFIX}", "", image, count=1)
            ref = f"{image}@{digest.lower()}"
            require(bool(REF.fullmatch(ref)) and not ref.startswith(PRODUCT_PREFIX))
            refs.add(ref)
    require(bool(refs))
    return refs


def media_type(api, ref):
    name, digest = ref.rsplit("@", 1)
    host, _, repository = name.partition("/")
    if "." not in host:
        repository = name if repository else "library/" + name
        host = "registry-1.docker.io"
    if host not in ANONYMOUS_TOKEN:
        return None
    url = f"https://{host}/v2/{repository}/manifests/{digest}"
    headers = {"User-Agent": "wasalx-dev-pull", "Accept": ", ".join(MEDIA_TYPES)}

    def head():
        with api.open(Request(url, headers=headers, method="HEAD"), timeout=2) as response:
            if response.headers.get("Docker-Content-Digest", digest) == digest:
                value = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
                if value in MEDIA_TYPES:
                    return value

    try:
        try:
            return head()
        except HTTPError as challenge:
            challenge.close()
            if challenge.code != 401:
                return None
        endpoint, service = ANONYMOUS_TOKEN[host]
        query = urlencode({"service": service, "scope": f"repository:{repository}:pull"})
        with api.open(Request(f"{endpoint}?{query}"), timeout=2) as response:
            token = json.loads(response.read(8192)).get("token")
        if not matches(r"[A-Za-z0-9_.~+/=-]+", token):
            return None
        headers["Authorization"] = "Bearer " + token
        return head()
    except HTTPError as error:
        error.close()
    except (AttributeError, URLError, TimeoutError, ValueError):
        pass
    return None


def handover(api, tag, commit, tree, digest, nightly, product_refs):
    compose = compose_refs(api, commit, product_refs)
    refs = [{"ref": ref, "mediaType": media_type(api, ref), "origin": origin}
            for origin, group in (("compose", compose), ("product", product_refs)) for ref in sorted(group)]
    return {"schema": SCHEMA, "source": "b2-verified", "tag": tag, "commit": commit, "tree": tree,
            "refs": sorted(refs, key=lambda row: row["ref"]),
            "counts": {"compose": len(compose), "product": len(product_refs)},
            "release_asset_digest": digest, "nightly": nightly}


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


def tick(api, outbox, state, config):
    releases = cache_releases(api, state)
    for release in releases:
        tag = release["tag_name"]
        if not (RC.fullmatch(tag) and release["prerelease"] is True and release["draft"] is False):
            continue
        digest = release_asset(release)
        if digest:
            break
    else:
        return
    if api.remaining is not None and api.remaining < 13:
        raise RateLimit(max(api.reset, int(time.time()) + 600))
    commit = tag_commit(api, tag)
    if tag in outbox.tags:
        require(outbox.tags[tag] == (commit, digest))
        return
    tree, raw, nightly = eligible(api, tag, commit, digest)
    with tempfile.TemporaryDirectory(prefix="pull-", dir=state) as temporary:
        manifest = Path(temporary) / ASSET
        manifest.write_bytes(raw)
        product_refs = verify(manifest, commit, tree, config)
    offer = handover(api, tag, commit, tree, digest, nightly, product_refs)
    require(tag_commit(api, tag) == commit)
    outbox.add(offer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = json.loads(args.config.read_bytes())
        if not isinstance(config, dict) or config.keys() != CONFIG_FIELDS or config["mode"] != "report":
            raise ValueError("unsupported mode")
        if not args.key.is_file():
            raise ValueError("missing receipt key")
        state = Path(os.environ["STATE_DIRECTORY"])
        with (state / "tick.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            try:
                tick(GitHub(), Outbox(state / "handover-outbox", args.key), state, config)
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
    except TrustedRootMismatch:
        print("<3>REPORT_TRUST_ROOT_MISMATCH: Re-pin Sigstore trust via TUF", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print("<3>REPORT_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
