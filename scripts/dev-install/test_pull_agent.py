#!/usr/bin/env python3
"""Exercise the report agent with fake GitHub and real receipt signatures."""

import argparse
from hashlib import sha256
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pull_agent", HERE / "templates/pull-agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
spec = importlib.util.spec_from_file_location("host_staging", HERE / "host-staging.py")
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)
spec = importlib.util.spec_from_file_location("render", HERE / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
COMMIT, TREE, TAG = "1" * 40, "2" * 40, "v1.2.3-rc.1"
RAW = b'{"fixture":true}\n'
DIGEST = sha256(RAW).hexdigest()


class Reply(io.BytesIO):
    def __init__(self, raw, headers=None, status=200):
        super().__init__(raw)
        self.headers = headers or {}
        self.status = status


class PublicAPI:
    def __init__(self):
        self.requests = []
        self.status = "ahead"
        self.census = "success"
        self.raw = RAW
        self.limit = False

    def open(self, request, timeout):
        self.requests.append(request)
        assert not request.has_header("Authorization")
        url = urlsplit(request.full_url)
        if self.limit:
            raise HTTPError(request.full_url, 429, "limit", {"Retry-After": "2700"}, None)
        if url.netloc == "github.com":
            assert url.path.endswith(f"/{TAG}/{agent.ASSET}")
            return Reply(self.raw)
        path = url.path.removeprefix("/repos/" + agent.REPO)
        headers = {"X-RateLimit-Remaining": "40", "ETag": '"listing"'}
        if path == "/releases":
            if request.get_header("If-none-match"):
                raise HTTPError(request.full_url, 304, "", headers, None)
            value = [{"tag_name": TAG, "prerelease": True, "draft": False, "assets": [
                {"name": agent.ASSET, "state": "uploaded", "digest": f"sha256:{DIGEST}"}]}]
        elif path == f"/git/ref/tags/{TAG}":
            value = {"ref": f"refs/tags/{TAG}", "object": {"sha": "3" * 40, "type": "tag"}}
        elif path == f"/git/tags/{'3' * 40}":
            value = {"sha": "3" * 40, "object": {"sha": COMMIT, "type": "commit"}}
        elif path == f"/compare/{COMMIT}...main":
            value = {"status": self.status, "base_commit": {"sha": COMMIT, "commit": {"tree": {"sha": TREE}}}}
        elif path in {"/actions/workflows/ci.yml/runs", "/actions/workflows/nightly-install.yml/runs"}:
            ci = "/ci.yml/" in path
            value = {"workflow_runs": [{"head_sha": COMMIT, "conclusion": "success",
                                       "id": 1 if ci else 2, "head_branch": "main",
                                       "head_repository": {"full_name": agent.REPO},
                                       "event": "push" if ci else "workflow_dispatch"}]}
        elif path in {"/actions/runs/1/jobs", "/actions/runs/2/jobs"}:
            value = {"jobs": [{"name": "publish / Image digest manifest" if "/1/" in path else "nightly-install",
                               "head_sha": COMMIT, "conclusion": "success",
                               "steps": [{"name": agent.CENSUS, "conclusion": self.census}]}]}
        else:
            raise AssertionError(path)
        return Reply(json.dumps(value).encode(), headers)


class PullTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name)
        self.key = self.work / "key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", self.key], check=True)
        self.directory = self.work / "outbox"
        self.outbox = agent.Outbox(self.directory, self.key)
        self.fake = PublicAPI()
        lock = self.work / "lane"
        lock.touch()
        self.config = {"lane_lock": lock, "stage_guard": "/fake/guard", "staging_dir": "/fake/staging",
                       "staging_mount": "/fake/mount"}

    def tick(self):
        agent.tick(agent.GitHub(self.fake.open), self.outbox, self.work, self.config)

    def codes(self):
        return [json.loads(path.read_bytes())["code"] for path in sorted(self.directory.glob("*.json"))]

    def test_eligible_then_verified_then_staged(self):
        with (patch.object(agent, "offpeak_seconds", return_value=7200),
              patch.object(agent, "verify") as verify, patch.object(agent, "fetch_bundles") as fetch,
              patch.object(agent, "command") as command):
            self.tick()
            self.assertTrue(verify.call_args_list[0].kwargs["inventory_only"])
            self.assertEqual(verify.call_args_list[0].args[1:3], (COMMIT, TREE))
            fetch.assert_called_once()
            self.assertEqual(Path(command.call_args.args[0][1]).name, "host-staging.sh")
            self.assertEqual(self.codes(), ["ELIGIBLE", "VERIFIED", "STAGED"])
            before = len(self.fake.requests)
            self.tick()
            self.assertEqual(len(self.fake.requests), before + 1)
            self.assertEqual(self.fake.requests[-1].get_header("If-none-match"), '"listing"')

    def test_foreign_commit_or_missing_census_is_pending(self):
        for status, census in [("diverged", "success"), ("ahead", "skipped")]:
            self.fake.status, self.fake.census = status, census
            with self.assertRaises(agent.Pending):
                self.tick()
        self.assertEqual(self.codes(), [])

    def test_tampered_asset(self):
        self.fake.raw = b"changed bytes"
        with patch.object(agent, "verify") as verify, self.assertRaises(agent.Pending):
            self.tick()
        verify.assert_not_called()
        self.assertEqual(self.codes(), [])

    def test_signature_failure_stops_before_staging(self):
        failure = subprocess.CalledProcessError(1, "cosign")
        with (patch.object(agent, "offpeak_seconds", return_value=7200),
              patch.object(agent, "verify", side_effect=[None, failure]),
              patch.object(agent, "fetch_bundles"), patch.object(agent, "command") as command):
            self.tick()
            command.assert_called_once()
        self.assertEqual(self.codes(), ["ELIGIBLE", "HOLD_VERIFY"])

    def test_rate_limit_persists_without_polling(self):
        self.fake.limit = True
        args = ["pull-agent", "--config", str(self.work / "config"), "--key", str(self.key)]
        (self.work / "config").write_text('{"mode":"report"}')
        with (patch.object(agent, "GitHub", return_value=agent.GitHub(self.fake.open)),
              patch.dict(os.environ, {"STATE_DIRECTORY": str(self.work)}), patch("sys.argv", args)):
            self.assertEqual(agent.main(), 0)
            self.assertEqual(agent.main(), 0)
        self.assertEqual(len(self.fake.requests), 1)
        self.assertGreater(json.loads((self.work / "releases.json").read_bytes())["backoff_until"], time.time() + 2600)
        self.assertEqual(self.codes(), [])

    def test_chain_survives_restart_and_verifies_ed25519(self):
        self.outbox.add(TAG, COMMIT, DIGEST, "ELIGIBLE", agent.stamp())
        # A crash after publishing the signature must leave the next sequence reusable.
        (self.directory / "00000000000000000002.json.sig").write_bytes(b"orphan")
        restarted = agent.Outbox(self.directory, self.key)
        restarted.add(TAG, COMMIT, DIGEST, "VERIFIED", agent.stamp())
        first, second = sorted(self.directory.glob("*.json"))
        self.assertEqual(json.loads(second.read_bytes())["prev_sha256"], sha256(first.read_bytes()).hexdigest())
        allowed = self.work / "allowed_signers"
        allowed.write_bytes(b"fixture-principal " + self.key.with_suffix(".pub").read_bytes())
        for path in (first, second):
            subprocess.run(["ssh-keygen", "-Y", "verify", "-n", "wasalx-dev-receipt", "-I", "fixture-principal",
                            "-f", allowed, "-s", path.with_suffix(".json.sig")],
                           input=path.read_bytes(), stdout=subprocess.DEVNULL, check=True)
        first.write_bytes(first.read_bytes() + b" ")
        with self.assertRaises(ValueError):
            agent.Outbox(self.directory, self.key)

    def test_rendered_packet_is_sealed_and_report_only(self):
        identity = {field: f"/example/{field}" for field in render.PULL_PATHS}
        identity.update(mode="report", trusted_root_sha256="a" * 64)
        bundle = self.work / "package"
        render.render_pull(identity, bundle)
        for entry in (bundle / "SHA256SUMS").read_text().splitlines():
            digest, name = entry.split("  ")
            self.assertEqual(digest, sha256((bundle / name).read_bytes()).hexdigest())
        unit = (bundle / render.PULL_SERVICE).read_text()
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("NoNewPrivileges=yes", unit)
        self.assertIn("LoadCredential=receipt-key:/example/receipt_key", unit)
        self.assertNotIn("@", unit)
        with self.assertRaises(ValueError):
            render.render_pull({**identity, "mode": "unattended"}, self.work / "bad")

    def test_staging_resumes_and_hashes_local_blob(self):
        raw = b"complete blob"
        digest = sha256(raw).hexdigest()
        (self.work / digest).write_bytes(raw[:4])
        def open_range(request, timeout):
            self.assertEqual(request.get_header("Range"), f"bytes=4-{len(raw) - 1}")
            return Reply(raw[4:], {"Content-Range": f"bytes 4-{len(raw) - 1}/{len(raw)}"}, 206)
        descriptor = {"digest": "sha256:" + digest, "size": len(raw)}
        args = ("portal", "https://ghcr.io/v2/wasalx/portal", {}, descriptor, "layer", self.work)
        with patch.object(staging, "capacity"):
            staging.store_blob(open_range, *args, {}, self.work)
        self.assertEqual((self.work / digest).read_bytes(), raw)
        (self.work / digest).write_bytes(b"oops")
        with patch.object(staging, "capacity"), self.assertRaises(staging.Hold):
            staging.store_blob(lambda *_args, **_kwargs: Reply(b"x" * (len(raw) - 4),
                               {"Content-Range": f"bytes 4-{len(raw) - 1}/{len(raw)}"}, 206), *args, {}, self.work)


def live():
    parser = argparse.ArgumentParser(description="Exercise exact PR tooling against a public main publication.")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--cosign", required=True)
    parser.add_argument("--trust", type=Path, required=True)
    args = parser.parse_args()
    source = subprocess.check_output(["git", "rev-parse", "HEAD", "HEAD^{tree}"], text=True).splitlines()
    if source[0] != args.candidate:
        raise ValueError("live tooling is not the exact PR commit")
    agent.ROOT, agent.TOOLS = HERE.parents[1], HERE
    api = agent.GitHub()
    candidate = api.json(f"/commits/{agent.object_sha(args.candidate)}")
    if [candidate["sha"], candidate["commit"]["tree"]["sha"]] != source:
        raise ValueError("anonymous API did not bind the exact PR tree")
    manifest = json.loads(args.manifest.read_bytes())
    commit = agent.object_sha(manifest["commit"])
    tree = agent.main_tree(api, commit)
    config = {"cosign": args.cosign, "trusted_root": args.trust,
              "trusted_root_sha256": sha256(args.trust.read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory) / agent.ASSET
        work.write_bytes(args.manifest.read_bytes())
        agent.verify(work, commit, tree, config, inventory_only=True)
        agent.fetch_bundles(work)
        agent.verify(work, commit, tree, config)
    print(f"PR_TOOLING={args.candidate} SIGNED_MAIN_PUBLICATION={commit} ANONYMOUS_API_GHCR_SIGSTORE=PASS")


if __name__ == "__main__":
    if "--live" in sys.argv:
        live()
    else:
        unittest.main()
