#!/usr/bin/env python3
"""Exercise the report agent with fake GitHub and real receipt signatures."""

import argparse
import base64
from contextlib import redirect_stderr
from copy import deepcopy
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
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pull_agent", HERE / "templates/pull-agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
spec = importlib.util.spec_from_file_location("render", HERE / "render.py")
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
COMMIT, TREE, TAG, MOVED = "1" * 40, "2" * 40, "v1.2.3-rc.1", "4" * 40
COMPOSE_DIGEST = "sha256:" + "ab" * 32
COMPOSE_REF = f"postgres@{COMPOSE_DIGEST}"
PRODUCT_DIGEST = "sha256:" + "6" * 64
CATALOG = json.loads((HERE.parents[1] / "release/installer-images.json").read_bytes())
PUBLISHER = f"https://github.com/{agent.REPO}/.github/workflows/branch-image.yml@refs/heads/main"
IMAGES = {
    image["id"]: {
        "image": image["id"], "commit": COMMIT, "tree": TREE, "platform": "linux/amd64",
        "verified": True, "status": "published", "digest": PRODUCT_DIGEST, "configDigest": PRODUCT_DIGEST,
        "inspection": {"configDigest": PRODUCT_DIGEST}, "workflow": PUBLISHER,
        "pullReference": f"{agent.PRODUCT_PREFIX}{image['id']}@{PRODUCT_DIGEST}",
    }
    for image in CATALOG["images"]
}
PRODUCT_REFS = [image["pullReference"] for image in IMAGES.values()]
RAW = json.dumps({"schemaVersion": 1, "repository": agent.REPO, "platform": "linux/amd64",
                  "commit": COMMIT, "tree": TREE, "publicationComplete": True, "pending": {},
                  "images": IMAGES}).encode()
DIGEST = "sha256:" + sha256(RAW).hexdigest()


class Reply(io.BytesIO):
    def __init__(self, raw, headers=None):
        super().__init__(raw)
        self.headers = headers or {}


class PublicAPI:
    def __init__(self):
        self.requests = []
        self.tag = TAG
        self.status = "ahead"
        self.census = "success"
        self.raw = RAW
        self.digest = DIGEST
        self.commit = COMMIT
        self.nightly = [{}]
        self.compose = f"    image: wasalx/portal:local\n    image: {COMPOSE_REF}\n"
        self.limit = False

    def open(self, request, timeout):
        self.requests.append(request)
        url = urlsplit(request.full_url)
        if self.limit:
            raise HTTPError(request.full_url, 429, "limit", {"Retry-After": "2700"}, None)
        if url.netloc == "github.com":
            assert not request.has_header("Authorization")
            assert url.path.endswith(f"/{self.tag}/{agent.ASSET}")
            return Reply(self.raw)
        if url.netloc != "api.github.com":
            if url.path == "/token":
                assert url.netloc == "ghcr.io" and not request.has_header("Authorization")
                return Reply(b'{"token":"fixture"}')
            assert request.get_method() == "HEAD" and "/manifests/sha256:" in url.path
            if url.netloc == "ghcr.io":
                if request.get_header("Authorization") is None:
                    raise HTTPError(request.full_url, 401, "", {}, None)
                assert request.get_header("Authorization") == "Bearer fixture"
                return Reply(b"", {} if "/portal/" in url.path else {"Content-Type": agent.MEDIA_TYPES[2]})
            return Reply(b"", {"Content-Type": "application/vnd.oci.image.index.v1+json"})
        assert not request.has_header("Authorization")
        path = url.path.removeprefix("/repos/" + agent.REPO)
        headers = {"X-RateLimit-Remaining": "40", "ETag": '"listing"'}
        if path == "/releases":
            if request.get_header("If-none-match"):
                raise HTTPError(request.full_url, 304, "", headers, None)
            value = [{"tag_name": self.tag, "prerelease": True, "draft": False, "assets": [
                {"name": agent.ASSET, "state": "uploaded", "digest": self.digest}]}]
        elif path == f"/git/ref/tags/{self.tag}":
            value = {"ref": f"refs/tags/{self.tag}", "object": {"sha": "3" * 40, "type": "tag"}}
        elif path == f"/git/tags/{'3' * 40}":
            value = {"sha": "3" * 40, "object": {"sha": self.commit, "type": "commit"}}
        elif path == f"/compare/{self.commit}...main":
            value = {"status": self.status, "base_commit": {"sha": self.commit, "commit": {"tree": {"sha": TREE}}}}
        elif path in {"/actions/workflows/ci.yml/runs", "/actions/workflows/nightly-install.yml/runs"}:
            ci = "/ci.yml/" in path
            if not ci:
                assert url.query == f"event=push&branch={self.tag}&head_sha={self.commit}&per_page=1"
            run = {"head_sha": self.commit, "status": "completed", "conclusion": "success", "id": 1 if ci else 2,
                   "run_attempt": 1 if ci else 4, "head_branch": "main" if ci else self.tag,
                   "head_repository": {"full_name": agent.REPO}, "event": "push"}
            value = {"workflow_runs": [run | overrides for overrides in ([{}] if ci else self.nightly)]}
        elif path in {"/actions/runs/1/attempts/1/jobs", "/actions/runs/2/attempts/4/jobs"}:
            value = {"jobs": [{"name": "publish / Image digest manifest" if "/1/" in path else "nightly-install",
                               "head_sha": self.commit, "conclusion": "success",
                               "steps": [{"name": agent.CENSUS, "conclusion": self.census}]}]}
        elif path in {"/contents/compose.yaml", "/contents/compose.full.yaml"}:
            assert url.query == f"ref={COMMIT}"
            assert request.get_header("Accept") == "application/vnd.github.raw+json"
            return Reply(self.compose.encode(), headers)
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
        self.directory = self.work / "handover-outbox"
        self.outbox = agent.Outbox(self.directory, self.key)
        self.fake = PublicAPI()
        self.trusted_root = self.work / "trusted_root.json"
        original_root = b'{"root":"original"}'
        self.trusted_root.write_bytes(original_root)
        self.config = {"mode": "report", "cosign": "/example/cosign",
                       "trusted_root": str(self.trusted_root),
                       "trusted_root_sha256": sha256(original_root).hexdigest()}

    def tick(self):
        agent.tick(agent.GitHub(self.fake.open), self.outbox, self.work, self.config)

    def make_offer(self, tag=TAG):
        return agent.handover(agent.GitHub(self.fake.open), tag, COMMIT, TREE, DIGEST,
                              {"run_id": 2, "attempt": 4, "census": "PASS"}, PRODUCT_REFS)

    def records(self):
        return sorted(self.directory.glob("*.json"))

    def run_main(self, config, key=None):
        path = self.work / "config"
        path.write_text(json.dumps(config))
        args = ["pull-agent", "--config", str(path), "--key", str(key or self.key)]
        with (patch.object(agent, "GitHub", return_value=agent.GitHub(self.fake.open)),
              patch.dict(os.environ, {"STATE_DIRECTORY": str(self.work)}), patch("sys.argv", args)):
            return agent.main()

    def test_verified_handover_without_image_blob_downloads(self):
        with patch.object(agent, "verify", return_value=PRODUCT_REFS) as verify:
            self.tick()
            self.tick()
        verify.assert_called_once()
        self.assertEqual(verify.call_args.args[1:3], (COMMIT, TREE))
        self.assertEqual(len(self.records()), 1)
        record = json.loads(self.records()[0].read_bytes())
        self.assertEqual((record["tag"], record["commit"], record["tree"], record["release_asset_digest"]),
                         (TAG, COMMIT, TREE, DIGEST))
        self.assertEqual(record["nightly"], {"run_id": 2, "attempt": 4, "census": "PASS"})
        self.assertEqual(record["counts"], {"product": 21, "compose": 1})
        self.assertEqual([row["ref"] for row in record["refs"]], sorted(PRODUCT_REFS + [COMPOSE_REF]))
        by_ref = {row["ref"]: row for row in record["refs"]}
        self.assertEqual(by_ref[COMPOSE_REF]["mediaType"], "application/vnd.oci.image.index.v1+json")
        self.assertIsNone(by_ref[f"{agent.PRODUCT_PREFIX}portal@{PRODUCT_DIGEST}"]["mediaType"])
        self.assertEqual(by_ref[f"{agent.PRODUCT_PREFIX}control-api@{PRODUCT_DIGEST}"]["mediaType"], agent.MEDIA_TYPES[2])
        self.assertFalse(any("/blobs/" in req.full_url for req in self.fake.requests))
        self.assertTrue(any(req.get_header("If-none-match") == '"listing"' for req in self.fake.requests))

    def test_rc_tag_at_consumer_limits_creates_receipt(self):
        self.fake.tag = f"v{'a' * 108}-rc.{'b' * 16}"
        with patch.object(agent, "verify", return_value=PRODUCT_REFS):
            self.tick()
        self.assertEqual([json.loads(path.read_bytes())["tag"] for path in self.records()], [self.fake.tag])
        self.assertEqual(self.outbox.seq, 1)

    def test_oversized_rc_tags_leave_receipt_chain_unchanged(self):
        self.outbox.add(self.make_offer())
        records = [path.read_bytes() for path in self.records()]
        seq, last = self.outbox.seq, self.outbox.last
        for prefix, suffix in ((109, 15), (107, 17)):
            with self.subTest(prefix=prefix, suffix=suffix):
                self.fake.tag = f"v{'a' * prefix}-rc.{'b' * suffix}"
                (self.work / "releases.json").unlink(missing_ok=True)
                with patch.object(agent.subprocess, "check_output") as sign:
                    self.tick()
                sign.assert_not_called()
                self.assertEqual([path.read_bytes() for path in self.records()], records)
                self.assertEqual((self.outbox.seq, self.outbox.last), (seq, last))

    def test_handover_normalizes_and_sorts_unique_compose_refs(self):
        second_digest = "sha256:" + "c" * 64
        self.fake.compose += (
            f"    image: docker.io/vendor/image:stable@{COMPOSE_DIGEST}\n"
            f"    image: quay.io/vendor/image:Release_1@sha256:{'AB' * 32}\n"
            f"    image: docker.io/library/postgres:17@{COMPOSE_DIGEST}\n"
            f"    image: docker.io/postgres@{COMPOSE_DIGEST}\n"
            f"    image: index.docker.io/library/postgres:17@{COMPOSE_DIGEST}\n"
            f"    image: registry-1.docker.io/postgres@{COMPOSE_DIGEST}\n"
            f"    image: library/{COMPOSE_REF}\n"
            f"    image: postgres:18@{second_digest}\n"
        )
        offer = self.make_offer()
        self.assertEqual(offer["counts"], {"product": 21, "compose": 4})
        self.assertEqual([row["ref"] for row in offer["refs"]], sorted([
            *PRODUCT_REFS, COMPOSE_REF, f"postgres@{second_digest}",
            f"quay.io/vendor/image@{COMPOSE_DIGEST}", f"vendor/image@{COMPOSE_DIGEST}",
        ]))

    def test_only_latest_tag_push_with_successful_census_qualifies(self):
        cases = {
            "no tag run": ([], "success"),
            "scheduled": ([{"event": "schedule", "head_branch": "main"}], "success"),
            "manual": ([{"event": "workflow_dispatch"}], "success"),
            "red latest with older green": ([{"conclusion": "failure"}, {}], "success"),
            "still running": ([{"status": "in_progress"}], "success"),
            "wrong branch": ([{"head_branch": "main"}], "success"),
            "wrong commit": ([{"head_sha": MOVED}], "success"),
            "census skipped": ([{}], "skipped"),
        }
        with patch.object(agent, "verify") as verify:
            for reason, (nightly, census) in cases.items():
                with self.subTest(reason=reason), self.assertRaises(agent.Pending):
                    self.fake.nightly, self.fake.census = nightly, census
                    self.tick()
            verify.assert_not_called()
        self.assertEqual(self.records(), [])

    def test_foreign_commit_or_tampered_asset_is_pending(self):
        with patch.object(agent, "verify") as verify:
            self.fake.status = "diverged"
            with self.assertRaises(agent.Pending):
                self.tick()
            self.fake.status, self.fake.raw = "ahead", b"changed bytes"
            with self.assertRaises(agent.Pending):
                self.tick()
            verify.assert_not_called()
        self.assertEqual(self.records(), [])

    def test_live_failure_reports_a_redacted_reason(self):
        result = subprocess.run(
            [sys.executable, "-I", "-B", __file__, "--live", "--candidate", "private-fixture-value",
             "--manifest", "unused", "--cosign", "unused", "--trust", "unused"],
            cwd=HERE, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn("command=python3 -I -B scripts/dev-install/test_pull_agent.py --live exit=1 "
                      "reason=live tooling is not the exact PR commit", result.stderr)
        self.assertNotIn("private-fixture-value", result.stderr)

    def test_repointed_tag_keeps_existing_receipt(self):
        self.outbox.add(self.make_offer())
        first = self.records()[0].read_bytes()
        self.fake.commit = MOVED
        with patch.object(agent, "verify") as verify, self.assertRaises(agent.Pending):
            self.tick()
        verify.assert_not_called()
        self.assertEqual([path.read_bytes() for path in self.records()], [first])

    def test_repointed_tag_with_unchanged_asset_fails_real_inventory_check(self):
        self.fake.commit = MOVED
        check_output = subprocess.check_output

        def capture(*args, **kwargs):
            return check_output(*args, **(kwargs | {"stderr": subprocess.PIPE}))

        with (patch.object(agent, "TOOLS", HERE), patch.object(agent.subprocess, "check_output", side_effect=capture),
              self.assertRaises(subprocess.CalledProcessError) as result):
            self.tick()
        self.assertIn(b"hosted source commit mismatch", result.exception.stderr)
        self.assertEqual(self.records(), [])

    def test_rotated_trusted_root_alerts_without_advancing_receipt_chain(self):
        self.outbox.add(self.make_offer("v1.2.3-rc.0"))
        previous = self.records()[0].read_bytes()
        self.trusted_root.write_bytes(b'{"root":"rotated"}')
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(self.run_main(self.config), 1)
        self.assertEqual(stderr.getvalue(), "<3>REPORT_TRUST_ROOT_MISMATCH: Re-pin Sigstore trust via TUF\n")
        self.assertEqual([path.read_bytes() for path in self.records()], [previous])

    def test_product_verification_failure_alerts_without_creating_handover(self):
        stderr = io.StringIO()
        with (patch.object(agent, "verify", side_effect=subprocess.CalledProcessError(1, "cosign")) as verify,
              redirect_stderr(stderr)):
            self.assertEqual(self.run_main(self.config), 1)
        verify.assert_called_once()
        self.assertEqual(stderr.getvalue(), "<3>REPORT_FAILED\n")
        self.assertEqual(self.records(), [])

    def test_repointed_tag_during_verification_creates_no_handover(self):
        def verify(*_args):
            self.fake.commit = MOVED
            return PRODUCT_REFS

        with patch.object(agent, "verify", side_effect=verify), self.assertRaises(agent.Pending):
            self.tick()
        self.assertEqual(self.records(), [])

    def test_tag_only_third_party_ref_is_pending(self):
        self.fake.compose += "    image: redis:8\n"
        with patch.object(agent, "verify", return_value=PRODUCT_REFS), self.assertRaises(agent.Pending):
            self.tick()
        self.assertEqual(self.records(), [])

    def test_rate_limit_persists_without_polling(self):
        self.fake.limit = True
        self.assertEqual(self.run_main(self.config), 0)
        self.assertEqual(self.run_main(self.config), 0)
        self.assertEqual(len(self.fake.requests), 1)
        self.assertGreater(json.loads((self.work / "releases.json").read_bytes())["backoff_until"], time.time() + 2600)
        self.assertEqual(self.records(), [])

    def test_main_rejects_mode_missing_keys_and_sequence_gap(self):
        with patch.object(agent, "verify") as verify:
            self.assertEqual(self.run_main(self.config | {"mode": "unattended"}), 1)
            self.assertEqual(self.run_main({key: val for key, val in self.config.items() if key != "cosign"}), 1)
            self.assertEqual(self.run_main(self.config, self.work / "missing-key"), 1)
            for tag in (TAG, "v1.2.3-rc.2", "v1.2.3-rc.3"):
                self.outbox.add(self.make_offer(tag))
            self.records()[1].unlink()
            self.fake.requests.clear()
            self.assertEqual(self.run_main(self.config), 1)
            verify.assert_not_called()
        self.assertEqual(self.fake.requests, [])
        self.assertEqual([json.loads(path.read_bytes())["receipt"]["seq"] for path in self.records()], [1, 3])

    def test_schema_refuses_unknown_missing_duplicate_refs_and_wrong_counts(self):
        self.outbox.add(self.make_offer())
        record = json.loads(self.records()[0].read_bytes())
        agent.validate_handover(record)
        for parent in (None, "nightly", "receipt", "signer", "counts", "refs"):
            altered = deepcopy(record)
            target = altered if parent is None else altered[parent]
            if parent == "refs":
                target = target[0]
            with self.subTest(parent=parent):
                target["unknown"] = 1
                with self.assertRaises(ValueError):
                    agent.validate_handover(altered)
                target.pop("unknown")
                target.pop(next(iter(target)))
                with self.assertRaises(ValueError):
                    agent.validate_handover(altered)
        counts = {"product": 21, "compose": 2}
        with self.assertRaisesRegex(ValueError, "invalid hand-over counts"):
            agent.validate_handover(record | {"counts": counts})
        duplicate = next(row for row in record["refs"] if row["origin"] == "compose")
        refs = sorted([*record["refs"], duplicate], key=lambda row: row["ref"])
        with self.assertRaisesRegex(ValueError, "invalid hand-over ref"):
            agent.validate_handover(record | {"counts": counts, "refs": refs})

    def test_schema_refuses_noncanonical_or_unsorted_refs(self):
        self.outbox.add(self.make_offer())
        record = json.loads(self.records()[0].read_bytes())
        for ref in (f"postgres:17@{COMPOSE_DIGEST}", f"docker.io/library/{COMPOSE_REF}",
                    f"docker.io/{COMPOSE_REF}", f"index.docker.io/{COMPOSE_REF}",
                    f"registry-1.docker.io/library/{COMPOSE_REF}", f"library/{COMPOSE_REF}",
                    f"postgres@sha256:{'AB' * 32}"):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, "invalid hand-over ref"):
                refs = [row | {"ref": ref} if row["origin"] == "compose" else row for row in record["refs"]]
                agent.validate_handover(record | {"refs": sorted(refs, key=lambda row: row["ref"])})
        with self.assertRaisesRegex(ValueError, "invalid hand-over ref"):
            agent.validate_handover(record | {"refs": list(reversed(record["refs"]))})

    def test_schema_requires_b2_release_asset_digest(self):
        self.outbox.add(self.make_offer())
        record = json.loads(self.records()[0].read_bytes())
        for value in (None, "", "sha512:" + "a" * 64, "sha256:" + "A" * 64):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid hand-over identity"):
                agent.validate_handover(record | {"release_asset_digest": value})
        del record["release_asset_digest"]
        with self.assertRaisesRegex(ValueError, "invalid hand-over identity"):
            agent.validate_handover(record)

    def test_canonical_chain_survives_restart_and_verifies_ed25519(self):
        self.assertEqual(agent.json_bytes({"z": 1, "a": "\u00e9"}), b'{"a":"\\u00e9","z":1}')
        self.outbox.add(self.make_offer())
        restarted = agent.Outbox(self.directory, self.key)
        restarted.add(self.make_offer("v1.2.3-rc.2"))
        first, second = self.records()
        first_raw, second_raw = first.read_bytes(), second.read_bytes()
        self.assertIsNone(json.loads(first_raw)["receipt"]["prev_hash"])
        second_record = json.loads(second_raw)
        self.assertEqual(second_record["receipt"]["prev_hash"], "sha256:" + sha256(first_raw).hexdigest())
        public_key = self.key.with_suffix(".pub")
        fingerprint = subprocess.check_output(["ssh-keygen", "-lf", public_key], text=True).split()[1]
        allowed = self.work / "allowed_signers"
        allowed.write_bytes(b"wasalx-dev-pull " + public_key.read_bytes())
        for raw in (first_raw, second_raw):
            record = json.loads(raw)
            self.assertEqual(raw, agent.json_bytes(record))
            self.assertEqual(record["signer"], {"key_id": fingerprint, "alg": "ed25519"})
            signature = self.work / "signature"
            signature.write_bytes(base64.b64decode(record.pop("signature"), validate=True))
            subprocess.run(["ssh-keygen", "-Y", "verify", "-n", "wasalx-dev-receipt", "-I", "wasalx-dev-pull",
                            "-f", allowed, "-s", signature], input=agent.json_bytes(record),
                           stdout=subprocess.DEVNULL, check=True)
        second_record["receipt"]["prev_hash"] = "sha256:" + "0" * 64
        second.write_bytes(agent.json_bytes(second_record))
        with self.assertRaises(ValueError):
            agent.Outbox(self.directory, self.key)

    def test_rendered_packet_is_sealed_capped_and_report_only(self):
        identity = {field: f"/example/{field}" for field in render.PULL_PATHS}
        identity.update(mode="report", trusted_root_sha256="a" * 64)
        bundle = self.work / "package"
        render.render_pull(identity, bundle)
        seals = (bundle / "SHA256SUMS").read_text().splitlines()
        pin = Path("scripts/release/cosign-pin.json")
        self.assertEqual((bundle / pin).read_bytes(), (HERE.parents[1] / pin).read_bytes())
        self.assertTrue(any(entry.endswith(f"  {pin.as_posix()}") for entry in seals))
        for entry in seals:
            digest, name = entry.split("  ")
            self.assertEqual(digest, sha256((bundle / name).read_bytes()).hexdigest())
        unit = (bundle / render.PULL_SERVICE).read_text().splitlines()
        for setting in ("ProtectSystem=strict", "NoNewPrivileges=yes", "CPUQuota=100%", "MemoryMax=2G",
                        "TasksMax=64", "IOWeight=10", "Nice=10", "TimeoutStartSec=15min",
                        "LoadCredential=receipt-key:/example/receipt_key", "StandardError=journal"):
            self.assertIn(setting, unit)
        self.assertFalse(any("@" in line or line.startswith("ReadWritePaths=") for line in unit))
        self.assertEqual(json.loads((bundle / "pull-config.json").read_bytes()).keys(), agent.CONFIG_FIELDS)
        with self.assertRaises(ValueError):
            render.render_pull({**identity, "mode": "unattended"}, self.work / "bad")


LIVE_COMMAND = "python3 -I -B scripts/dev-install/test_pull_agent.py --live"


class LiveParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, f"command={LIVE_COMMAND} exit=2 reason=invalid or missing CLI arguments\n")


def live():
    parser = LiveParser(description="Exercise exact PR tooling against a public main publication.")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--cosign", required=True)
    parser.add_argument("--trust", type=Path, required=True)
    args = parser.parse_args()
    command, reason = "git rev-parse HEAD HEAD^{tree}", "cannot read the checked-out PR commit and tree"
    exit_code = 1
    try:
        source = subprocess.check_output(command.split(), text=True, stderr=subprocess.DEVNULL, timeout=10).splitlines()
        command, reason = LIVE_COMMAND, "live tooling is not the exact PR commit"
        if len(source) != 2 or source[0] != args.candidate:
            raise ValueError
        agent.TOOLS = HERE
        api = agent.GitHub()
        reason = "anonymous API did not bind the exact PR tree"
        candidate = api.json(f"/commits/{agent.object_sha(args.candidate)}")
        if [candidate["sha"], candidate["commit"]["tree"]["sha"]] != source:
            raise ValueError
        reason = "cannot read or validate the main publication manifest"
        manifest_bytes = args.manifest.read_bytes()
        commit = agent.object_sha(json.loads(manifest_bytes)["commit"])
        reason = "anonymous API did not bind the publication to main"
        tree = agent.main_tree(api, commit)
        reason = "cannot prepare the pinned Sigstore root or private manifest"
        config = {"cosign": args.cosign, "trusted_root": args.trust,
                  "trusted_root_sha256": sha256(args.trust.read_bytes()).hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / agent.ASSET
            work.write_bytes(manifest_bytes)
            command, reason = "node scripts/dev-install/pull-verify.mjs", "cannot verify the main publication signatures"
            # The verifier writes only redacted diagnostics to stderr and JSON refs to stdout.
            refs = agent.verify(work, commit, tree, config, stderr=None, trace=True)
        command, reason = LIVE_COMMAND, "cannot validate the publication's Compose image references"
        compose = agent.compose_refs(api, commit, refs)
        print(f"PR_TOOLING={args.candidate} SIGNED_MAIN_PUBLICATION={commit} PRODUCT={len(refs)} COMPOSE={len(compose)} ANONYMOUS_API_GHCR_SIGSTORE=PASS")
        return 0
    except subprocess.CalledProcessError as error:
        exit_code = error.returncode if error.returncode > 0 else 128 - error.returncode
    except subprocess.TimeoutExpired:
        exit_code = 124
        reason += " (command deadline expired)"
    except HTTPError as error:
        reason += f" (HTTP {error.code})"
    except agent.RateLimit:
        reason += " (anonymous GitHub API rate limit)"
    except (URLError, TimeoutError):
        reason += " (network request failed or timed out)"
    except OSError as error:
        reason += f" (OS error {error.errno})"
    except (agent.Pending, agent.TrustedRootMismatch, ValueError, TypeError, KeyError):
        pass
    print(f"command={command} exit={exit_code} reason={reason}", file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    if "--live" in sys.argv:
        sys.exit(live())
    else:
        unittest.main()
