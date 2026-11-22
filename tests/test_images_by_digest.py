from unittest import mock
from contextlib import redirect_stdout
import subprocess
import os
import copy
import importlib.util
import io
import gzip
import json
from pathlib import Path
import re
import runpy
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("images", ROOT / "scripts/release/images-by-digest.py")
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class ImagePublicationTests(unittest.TestCase):
    def test_portal_contact_email_is_passed_without_logging_commands(self):
        dockerfile = (ROOT / "Dockerfile.portal").read_text()
        build_stage = dockerfile.split(" AS build\n", 1)[1].split("\nFROM ", 1)[0]
        self.assertIn("\nARG PUBLIC_CONTACT_EMAIL=\nRUN pnpm build\n", build_stage)
        binding = "          PUBLIC_CONTACT_EMAIL: ${{ matrix.image == 'portal' && vars.PUBLIC_CONTACT_EMAIL || '' }}"
        for name, step_name in [("ci.yml", "Build and inspect without publication"),
                                ("branch-image.yml", "Build without cache imports, export layers and inspect")]:
            with self.subTest(workflow=name):
                workflow = (ROOT / ".github/workflows" / name).read_text()
                step = workflow.split(f"      - name: {step_name}\n", 1)[1].split("\n      - ", 1)[0]
                self.assertIn(binding, step)
                self.assertEqual([line for line in workflow.splitlines() if "PUBLIC_CONTACT_EMAIL" in line], [binding])
                self.assertNotRegex(step, r"\b(?:echo|printenv|set\s+-x)\b")

    def test_build_records_the_portal_contact_input_and_rewrites_layer_timestamps(self):
        commit, tree, epoch = "a" * 40, "b" * 40, "1794938086"

        def invoke(args, **kwargs):
            if args[:2] == ["git", "archive"]:
                with tarfile.open(args[3].removeprefix("--output="), "w") as archive:
                    archive.add(ROOT / row["dockerfile"], arcname=row["dockerfile"])

        for image, contact_email in [("portal", " synthetic-contact "), ("portal", ""),
                                     ("secret-sidecar", " synthetic-contact ")]:
            row = {"image": image, "dockerfile": "Dockerfile." + image}
            with self.subTest(image=image, empty=not contact_email), tempfile.TemporaryDirectory() as directory, \
                    patch.object(images, "catalog", return_value=[row]), \
                    patch.object(images, "coordinates", return_value=(commit, tree)), \
                    patch.object(images, "run", return_value=epoch) as git, \
                    patch.object(images.subprocess, "run", side_effect=invoke) as execute, \
                    patch.object(images, "inspect_image", return_value={}), \
                    patch.dict(images.os.environ, {"SOURCE_DATE_EPOCH": "1", "PUBLIC_CONTACT_EMAIL": contact_email}):
                path = Path(directory) / "receipt.json"
                images.build(image, path)
                raw_receipt = path.read_text()
                git.assert_called_once_with("git", "log", "-1", "--format=%ct", commit, cwd=ROOT)
                args = execute.call_args.args[0]
                build_args = [value for flag, value in zip(args, args[1:]) if flag == "--build-arg"]
                self.assertEqual(args[:3], ["docker", "buildx", "build"])
                self.assertEqual(args[args.index("--output") + 1], "type=docker,rewrite-timestamp=true")
                self.assertIn("SOURCE_DATE_EPOCH=" + epoch, build_args)
                self.assertEqual([arg for arg in build_args if arg.startswith("PUBLIC_CONTACT_EMAIL")],
                                 ["PUBLIC_CONTACT_EMAIL"] if image == "portal" else [])
                self.assertIn("--provenance=false", args)
                self.assertIn("--sbom=false", args)
                receipt = json.loads(raw_receipt)
                if image == "portal":
                    self.assertEqual(receipt["contactEmailSha256"], images.sha256(contact_email.encode()))
                else:
                    self.assertNotIn("contactEmailSha256", receipt)
                self.assertNotIn("synthetic-contact", raw_receipt)

    def test_loaded_config_checks_exported_bytes_and_manifest_binding(self):
        raw = b'{"os":"linux","architecture":"amd64","config":{"Labels":{}}}'
        digest = images.sha256(raw)
        name = "blobs/sha256/" + digest[7:]

        def exported(config=raw, target=name, duplicate=False):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                entries = [(name, config), ("manifest.json", json.dumps([{"Config": target}]).encode())]
                if duplicate:
                    entries.append((name, config))
                for path, data in entries:
                    member = tarfile.TarInfo(path)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            stream.seek(0)
            return stream

        self.assertEqual(images.loaded_config(exported(), digest), {"configDigest": digest, "config": json.loads(raw)})
        for stream in [exported(config=raw + b" "), exported(target="wrong.json"), exported(duplicate=True)]:
            with self.assertRaises(ValueError):
                images.loaded_config(stream, digest)
        trailing = exported().getvalue() + b"\0" * (128 * 1024)
        with patch.object(images.subprocess, "Popen") as factory:
            child = factory.return_value.__enter__.return_value
            child.stdout = io.BytesIO(trailing)
            child.wait.return_value = 0
            self.assertEqual(images.inspect_loaded_config("fixture:local", digest)["configDigest"], digest)
            self.assertEqual(child.stdout.tell(), len(trailing), "drain the export before waiting for Docker")
            child.stdout = io.BytesIO(trailing)
            child.wait.return_value = 1
            with self.assertRaises(ValueError):
                images.inspect_loaded_config("fixture:local", digest)
            child.kill.assert_called_once()

    def test_addon_source_uses_the_pin_and_rejects_overrides(self):
        pin = json.loads((ROOT / "zammad-addon.json").read_text())
        source = {"repository": "https://github.com/" + pin["repository"], "commit": pin["commit"]}
        with patch.dict(images.os.environ, {"PUBLIC_ADDON_SOURCE": ""}):
            rows = images.matrix()["include"]
        self.assertEqual(len(rows), 21)
        self.assertFalse(any(r["pending"] for r in rows))
        addon_sources = {"zammad": source, "workspace-configurator": source}
        self.assertEqual({r["image"]: r["addonSource"] for r in rows if r["addonSource"]}, addon_sources)
        with patch.dict(images.os.environ, {"PUBLIC_ADDON_SOURCE": json.dumps(source)}):
            rows = images.matrix()["include"]
        self.assertFalse(any(r["pending"] for r in rows))
        self.assertEqual({r["image"]: r["addonSource"] for r in rows if r["addonSource"]}, addon_sources)
        for bad in [{**source, "repository": "https://user:password@github.com/example/addon"},
                    {**source, "commit": "main"}, {**source, "extra": "value"},
                    {**source, "commit": "a" * 40}, {**source, "repository": "https://github.com/example/addon"}]:
            with self.assertRaises(ValueError):
                images.public_addon_source(json.dumps(bad))

    def test_catalog_is_the_release_contract_and_covers_compose_builds(self):
        rows = images.catalog()
        contract = (ROOT / "scripts/release/artifact-contract.mjs").read_text()
        self.assertIn('new URL("./product-images.json", import.meta.url)', contract)
        self.assertEqual(len(rows), 21)
        paths = {r["dockerfile"] for r in rows}
        for name in ["compose.yaml", "compose.full.yaml"]:
            self.assertTrue(set(re.findall(r"dockerfile: ([^\s]+)", (ROOT / name).read_text())) <= paths)
        self.assertIn("infra/docker/Dockerfile.zammad", paths)
        self.assertNotIn("Dockerfile.production-secret-sidecar", paths)
        self.assertNotIn("zammad-package", (ROOT / ".dockerignore").read_text().splitlines())

    def test_static_publish_matrix_matches_catalog(self):
        workflow = (ROOT / ".github/workflows/branch-image.yml").read_text()
        publish = workflow.split("        image:\n", 1)[1].split("    steps:\n", 1)[0]
        catalog = [row["image"] for row in images.matrix()["include"]]
        self.assertEqual(re.findall(r"(?m)^          - ([a-z-]+)$", publish), catalog)

    def test_pull_request_matrix_selects_union_of_literal_context_inputs(self):
        rows = images.matrix()["include"]
        narrow = {
            "Dockerfile.foundation-postgres": "foundation-postgres",
            "app/page.tsx": "portal",
            "services/invitation-mailer/src/removed.ts": "invitation-mailer",
            "scripts/release/patch-keycloak-jackson.py": "foundation-keycloak",
            "tools/dev-secret-sidecar.mjs": "secret-sidecar",
            "infra/docker/Dockerfile.zammad": "zammad",
            "infra/docker/full/zammad/entrypoint.rb": "zammad",
        }
        for path, image in narrow.items():
            with self.subTest(path=path):
                self.assertEqual(images.matrix([path], pull_request=True)["include"],
                                 [row for row in rows if row["image"] == image])
        paths = ["packages/core/src/index.ts", "Dockerfile.foundation-postgres", "unmapped/new-file"]
        self.assertEqual([row["image"] for row in images.matrix(paths, pull_request=True)["include"]],
                         ["portal", "control-api", "connector-worker", "foundation-postgres"])
        self.assertEqual(images.matrix(["docs/guide/intro.md", "unmapped/new-file"], pull_request=True),
                         {"include": []})

    def test_pull_request_matrix_selects_addon_staging_inputs(self):
        addon_images = {"zammad", "workspace-configurator"}
        for path, expected in {
            "tests/fixtures/portal-mail-native/followup-body.txt": addon_images,
            "tests/portal-delegation-test.rb": addon_images,
            "tests/zammad-redis-tls.test.rb": addon_images,
            "zammad-package/product.rb": addon_images,
            "build/zammad/wasalx.zpm": addon_images | {"portal"},
            "build/addon-licenses/LICENSE": addon_images | {"portal"},
            "scripts/fetch-zammad-addon.mjs": addon_images,
        }.items():
            with self.subTest(path=path):
                rows = images.matrix([path], pull_request=True)["include"]
                self.assertEqual({row["image"] for row in rows}, expected)

    def test_pull_request_matrix_reruns_all_for_shared_build_inputs(self):
        rows = images.matrix()["include"]
        for path in ["scripts/release/images-by-digest.py", ".github/workflows/ci.yml",
                     ".dockerignore", ".gitattributes", "scripts/release/.gitattributes",
                     "Dockerfile.portal.dockerignore", "infra/docker/Dockerfile.zammad.dockerignore",
                     "infra/docker/.gitattributes", "scripts/release/product-images.json", "zammad-addon.json"]:
            with self.subTest(path=path):
                self.assertEqual(images.matrix(["app/page.tsx", path], pull_request=True)["include"], rows)

    def test_pull_request_matrix_ignores_publish_workflow(self):
        paths = [".github/workflows/branch-image.yml"]
        self.assertEqual(images.matrix(paths, pull_request=True), {"include": []})
        self.assertEqual(images.matrix(paths + ["app/page.tsx"], pull_request=True),
                         images.matrix(["app/page.tsx"], pull_request=True))

    def test_pull_request_matrix_reruns_all_if_a_dockerfile_cannot_be_mapped(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(images, "ROOT", Path(directory)):
            rows = [{"image": "known", "dockerfile": "Dockerfile.known"},
                    {"image": "unknown", "dockerfile": "Dockerfile.unknown"}]
            (images.ROOT / "Dockerfile.known").write_text("COPY app /app")
            (images.ROOT / "Dockerfile.unknown").write_text('COPY ["src", "/src"]')
            self.assertEqual(images.changed_images(rows, ["unmapped/new-file"], pull_request=True), rows)

    def test_matrix_command_selects_images_for_diff_and_full_push(self):
        base = "a" * 40
        script = ROOT / "scripts/release/images-by-digest.py"
        all_images = [row["image"] for row in images.catalog()]
        self.assertEqual(len(all_images), 21)
        for flags, diff_base, diff, expected in [
            (["--pull-request"], "HEAD^1", b"packages/core/src/index.ts\0",
             ["portal", "control-api", "connector-worker"]),
            (["--base-sha", base], base, b"app/page.tsx\0", ["portal"]),
            (["--base-sha", base], base, b"packages/core/src/index.ts\0", all_images),
            (["--base-sha", base], base, b"unmapped/new-file\0", all_images),
            (["--base-sha", base], base, b"docs/image.md\0", []),
            (["--base-sha", base], base, subprocess.CalledProcessError(128, "git diff"), all_images),
            ([], None, None, all_images),
        ]:
            with (self.subTest(flags=flags, diff=diff), io.StringIO() as stdout, redirect_stdout(stdout),
                  patch.object(sys, "argv", [str(script), "matrix", *flags]),
                  patch.object(subprocess, "check_output", return_value=diff,
                               side_effect=diff if isinstance(diff, Exception) else None) as git):
                runpy.run_path(str(script), run_name="__main__")
                self.assertEqual([row["image"] for row in json.loads(stdout.getvalue())["include"]], expected)
                if diff_base is None:
                    git.assert_not_called()
                else:
                    git.assert_called_once_with(
                        ["git", "diff", "--name-only", "-z", "--no-ext-diff", "--no-renames", diff_base, "HEAD", "--"],
                        cwd=ROOT)

    def test_context_map_handles_copy_continuations_and_refuses_unknown_context_syntax(self):
        self.assertEqual(images.context_sources("COPY\t./a//b \\\n  # Comment\n  local/ /app/\n"
                                                "ADD https://example.invalid/source /source\n"
                                                "COPY --from=build /src /dst\n"), {"a/b", "local"})
        for instruction in ["COPY . /app", "COPY src/*.ts /app/", 'COPY ["src", "/app"]',
                            "RUN --mount=target=/src true", "ONBUILD COPY src /app"]:
            with self.subTest(instruction=instruction):
                self.assertIsNone(images.context_sources(instruction))

    def test_all_metadata_contracts_have_exact_source_identity_and_pinned_bases(self):
        for row in images.catalog():
            with self.subTest(image=row["image"]):
                base, labels, environment = images.metadata_contract((ROOT / row["dockerfile"]).read_text(), "a" * 40, "b" * 40)
                self.assertEqual(labels["org.opencontainers.image.revision"], "a" * 40)
                self.assertEqual(labels["io.wasalx.source.tree"], "b" * 40)
                self.assertTrue(base == "scratch" or "@sha256:" in base)
                images.validate_metadata({"Labels": labels, "Env": [k + "=" + v for k, v in environment.items()]}, {}, labels, environment)

    def test_metadata_rejects_unknown_values(self):
        for bad in [{"Labels": {"unexpected": "value"}}, {"Env": ["UNEXPECTED=value"]}, {"OnBuild": ["RUN true"]}]:
            with self.assertRaises(ValueError):
                images.validate_metadata(bad, {}, {}, {})
        with self.assertRaises(ValueError):
            images.metadata_contract("FROM ubuntu:latest", "a" * 40, "b" * 40)

    def test_manifest_uses_config_digest_instead_of_image_inspect_id(self):
        digest = "sha256:" + "1" * 64
        manifest = {"mediaType": "application/vnd.oci.image.manifest.v1+json", "config": {"digest": digest}}
        images.verify_manifest(manifest, digest)
        for bad in [{**manifest, "mediaType": "application/vnd.oci.image.index.v1+json"},
                    {**manifest, "config": {"digest": "sha256:" + "2" * 64}}]:
            with self.assertRaises(ValueError):
                images.verify_manifest(bad, digest)

    def test_layer_inspection_rejects_credentials_and_unsafe_members(self):
        def inspect(name, content, licenses=None, public_members=None):
            inner = io.BytesIO()
            with tarfile.open(fileobj=inner, mode="w") as archive:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            outer = io.BytesIO()
            with tarfile.open(fileobj=outer, mode="w") as archive:
                member = tarfile.TarInfo("layer.tar")
                member.size = len(inner.getvalue())
                archive.addfile(member, io.BytesIO(inner.getvalue()))
            outer.seek(0)
            with tarfile.open(fileobj=outer) as archive:
                return images.inspect_layers(archive, ["layer.tar"], 0, licenses=licenses, public_members=public_members)
        self.assertEqual(inspect("app/public.txt", b"public"), 1)
        self.assertEqual(inspect("app/binary", b"-----BEGIN PRIVATE KEY-----"), 1)
        public = {"app/.env": {"type": "file", "sha256": images.sha256(b"public fixture")}}
        self.assertEqual(inspect("app/.env", b"public fixture", public_members=public), 1)
        with self.assertRaises(ValueError):
            inspect("app/.env", b"changed", public_members=public)
        license_path = "usr/share/licenses/wasalx-zammad-addon/LICENSE"
        expected = {license_path: images.sha256(b"public licence")}
        self.assertEqual(inspect(license_path, b"public licence", expected), 1)
        for name, raw in [(license_path, b"changed"), ("app/unrelated", b"public licence")]:
            with self.assertRaises(ValueError):
                inspect(name, raw, expected)
        for name, data in [("../escape", b"x"), ("app/.env", b"x"), ("root/.ssh/key", b"x"),
                           ("app/key", b"-----BEGIN PRIVATE KEY-----\n" + (b"A" * 64 + b"\n") * 2)]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                inspect(name, data)

    def test_public_key_content_requires_the_entire_reviewed_material_at_chunk_boundaries(self):
        pem = b"-----BEGIN PRIVATE KEY-----\n" + (b"A" * 64 + b"\n") * 2 + b"-----END PRIVATE KEY-----"
        digest = images.hashlib.sha256(pem).hexdigest()
        data = b"x" * (1024 * 1024 - 10) + pem
        images.inspect_content(io.BytesIO(data), {digest})
        for bad in [pem, pem.replace(b"\nA", b"\nB", 1), b"ghp_" + b"a" * 40]:
            with self.assertRaises(ValueError):
                images.inspect_content(io.BytesIO(bad), set() if bad == pem else {digest})

    def test_copied_zammad_keys_require_verified_manifest_and_layer_bytes(self):
        pem = b"-----BEGIN PRIVATE KEY-----\n" + (b"A" * 64 + b"\n") * 2 + b"-----END PRIVATE KEY-----"
        layer = io.BytesIO()
        with tarfile.open(fileobj=layer, mode="w") as archive:
            for name in ["opt/zammad/fixture/key.pem", "unrelated/key.pem", "opt/zammad/.env"]:
                entry = tarfile.TarInfo(name)
                entry.size = len(pem)
                archive.addfile(entry, io.BytesIO(pem))
        blob = gzip.compress(layer.getvalue(), mtime=0)
        for case in ["valid", "manifest-mismatch", "layer-mismatch"]:
            descriptor = images.sha256(blob) if case != "layer-mismatch" else "sha256:" + "0" * 64
            manifest = json.dumps({"layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": descriptor}]}).encode()
            reference = "ghcr.io/zammad/zammad@" + images.sha256(manifest)
            def response(request, **kwargs):
                url = request if isinstance(request, str) else request.full_url
                if "/token?" in url:
                    return io.BytesIO(b'{"token":"public-fixture"}')
                if "/manifests/" in url:
                    return io.BytesIO(manifest + (b" " if case == "manifest-mismatch" else b""))
                return io.BytesIO(blob)
            with self.subTest(case=case), patch.object(images, "ZAMMAD_PUBLIC_BASE", reference), \
                    patch.object(images, "_zammad_public_contract", None), patch.object(images.urllib.request, "urlopen", side_effect=response):
                if case == "valid":
                    self.assertEqual(images.zammad_public_contract(), {"keys": {"opt/zammad/fixture/key.pem": {images.hashlib.sha256(pem).hexdigest()}, "opt/zammad/.env": {images.hashlib.sha256(pem).hexdigest()}}, "members": {"opt/zammad/.env": {"type": "file", "sha256": images.sha256(pem)}}})
                else:
                    with self.assertRaises(ValueError):
                        images.zammad_public_contract()
                    self.assertIsNone(images._zammad_public_contract)

    def test_manifest_requires_complete_verified_uniform_source_receipts(self):
        records = [{"image": r["image"], "commit": "a" * 40, "tree": "b" * 40,
                    "digest": "sha256:" + "1" * 64, "configDigest": "sha256:" + "2" * 64,
                    "verified": True, "pullReference": "ghcr.io/wasalx/" + r["image"] + "@sha256:" + "1" * 64}
                   for r in images.catalog()]
        self.assertEqual(len(images.assemble(records)["images"]), 21)
        pending = copy.deepcopy(records)
        addon_images = {"zammad", "workspace-configurator"}
        for index, row in enumerate(pending):
            if row["image"] in addon_images:
                pending[index] = {k: row[k] for k in ["image", "commit", "tree"]}
                pending[index]["status"] = "pending add-on source"
        manifest = images.assemble(pending)
        self.assertEqual(len(manifest["images"]), 19)
        self.assertEqual(set(manifest["pending"]), addon_images)
        self.assertFalse(manifest["publicationComplete"])
        pending[0] = {"image": "portal", "commit": "a" * 40, "tree": "b" * 40, "status": "pending add-on source"}
        with self.assertRaises(ValueError):
            images.assemble(pending)
        for bad in [records[:-1], records[:-1] + [records[0]]]:
            with self.assertRaises(ValueError):
                images.assemble(bad)
        for key, value in [("tree", "c" * 40), ("verified", False), ("configDigest", "unknown"), ("pullReference", "tag:main")]:
            bad = copy.deepcopy(records)
            bad[0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                images.assemble(bad)

    def test_registry_cache_roles_are_disjoint(self):
        self.assertEqual(len(images.CACHED_IMAGES), 11)
        self.assertLessEqual(images.CACHED_IMAGES, {row["image"] for row in images.catalog()})
        main = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": images.REPOSITORY}
        ref = "type=registry,ref=ghcr.io/wasalx/buildcache:production-prometheus"
        with mock.patch.dict(os.environ, main, clear=True):
            self.assertEqual(images.cache_options("production-prometheus", "write"), ["--cache-to", ref + ",mode=max,ignore-error=true"])
            self.assertEqual(images.cache_options("portal", "off"), [])
            self.assertEqual(images.cache_options("postgres", "write"), [])
            with self.assertRaises(ValueError):
                images.cache_options("portal", "read")
        for event in ["pull_request", "merge_group"]:
            with mock.patch.dict(os.environ, {"GITHUB_EVENT_NAME": event}, clear=True):
                self.assertEqual(images.cache_options("production-prometheus", "read"), ["--cache-from", ref])
                with self.assertRaises(ValueError):
                    images.cache_options("portal", "write")

    def test_docker_pull_retries_only_the_pull(self):
        failure = subprocess.CalledProcessError(1, "docker pull")
        with mock.patch.object(images, "run", side_effect=[failure, failure, ""]) as run:
            with mock.patch.object(images.time, "sleep"):
                images.pull("base")
            self.assertEqual(run.call_args_list, [mock.call("docker", "pull", "--platform", "linux/amd64", "base")] * 3)
        with mock.patch.object(images, "run", side_effect=failure) as run:
            with mock.patch.object(images.time, "sleep"), self.assertRaises(subprocess.CalledProcessError):
                images.pull("base")
            self.assertEqual(run.call_count, 3)

    def test_publication_retry_succeeds_after_two_command_failures(self):
        command = ("docker", "push", "image")
        failure = subprocess.CalledProcessError(1, command)
        with patch.object(images, "run", side_effect=[failure, failure, "published"]) as run, \
                patch.object(images.time, "sleep") as sleep:
            self.assertEqual(images.run_retry(*command), "published")
        self.assertEqual(run.call_args_list, [mock.call(*command)] * 3)
        self.assertEqual(sleep.call_args_list, [mock.call(10), mock.call(20)])

    def test_publication_uses_the_push_branch_alias_and_signing_identity(self):
        commit, tree, digest = "a" * 40, "b" * 40, "sha256:" + "1" * 64
        inspection = {"configDigest": "sha256:" + "2" * 64, "addonLicenses": {}}
        manifest = json.dumps({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                               "config": {"digest": inspection["configDigest"]}})
        ref = "refs/heads/main"
        env = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": ref, "GITHUB_WORKFLOW_SHA": commit,
               "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "PUBLIC_CONTACT_EMAIL": "changed-after-build"}
        contact_digest = images.sha256(b"synthetic-contact")
        identity = images.SOURCE + "/.github/workflows/branch-image.yml@" + ref
        for image in ["portal", "secret-sidecar"]:
            repository = "ghcr.io/wasalx/" + image
            receipt = {"image": image, "commit": commit, "tree": tree, "reference": repository + ":" + commit,
                       "inspection": inspection, "sourceArchiveDigest": "", "addonSource": None, "dockerfileDigest": ""}
            with self.subTest(image=image), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, env, clear=True), \
                    patch.object(images, "coordinates", return_value=(commit, tree)), \
                    patch.object(images, "run", side_effect=[f"digest: {digest}", manifest, "", "", "", "", "",
                                                             f"digest: {digest}"]) as run, \
                    patch.object(images, "pull"), patch.object(images, "inspect_image", return_value=inspection):
                path = Path(directory) / "receipt.json"
                if image == "portal":
                    images.write(path, receipt)
                    with self.assertRaisesRegex(ValueError, "Invalid portal contact email digest"):
                        images.publish(path)
                    run.assert_not_called()
                    receipt["contactEmailSha256"] = contact_digest
                images.write(path, receipt)
                images.publish(path)
                published = json.loads(path.read_text())
                parameters = json.loads(path.with_suffix(".json.predicate.json").read_text())["invocation"]["parameters"]
                if image == "portal":
                    self.assertEqual(published["contactEmailSha256"], contact_digest)
                    self.assertEqual(parameters["contactEmailSha256"], contact_digest)
                else:
                    self.assertNotIn("contactEmailSha256", published)
                    self.assertNotIn("contactEmailSha256", parameters)
                reference = repository + "@" + digest
                alias = repository + ":main"
                self.assertEqual(published["workflow"], identity)
                self.assertTrue(published["verified"])
                run.assert_any_call("cosign", "verify", "--certificate-identity", identity,
                                    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", reference)
                self.assertEqual(run.call_args_list[-2:], [mock.call("docker", "tag", reference, alias),
                                                          mock.call("docker", "push", alias)])

        for event, ref in (("push", "refs/heads/dev"), ("push", "refs/heads/feature"), ("pull_request", "refs/heads/main")):
            with self.subTest(event=event, ref=ref), patch.dict(os.environ, {"GITHUB_EVENT_NAME": event, "GITHUB_REF": ref}):
                with self.assertRaisesRegex(ValueError, "requires a main push"):
                    images.publish("unused")

    def test_release_verifies_every_digest_against_the_tagged_commit(self):
        commit, tree = "a" * 40, "b" * 40
        config = "sha256:" + "2" * 64
        raw = json.dumps({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                          "config": {"digest": config}}).encode()
        digest = images.sha256(raw)
        records = [{"image": r["image"], "commit": commit, "tree": tree, "status": "published",
                    "digest": digest, "configDigest": config, "verified": True, "workflow": images.MAIN_PUBLISHER,
                    "pullReference": f"ghcr.io/wasalx/{r['image']}@{digest}"} for r in images.catalog()]
        manifest = images.assemble(records)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(images, "coordinates", return_value=(commit, tree)), \
                patch.object(images.subprocess, "check_output", return_value=raw) as inspect, \
                patch.object(images, "run_retry") as cosign:
            path = Path(directory) / "images-manifest.json"
            path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
            images.verify_publication(path)
            self.assertEqual(inspect.call_count, 21)
            common = ["--certificate-identity", images.MAIN_PUBLISHER,
                      "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
                      "--certificate-github-workflow-sha", commit]
            expected = []
            for row in manifest["images"].values():
                ref = row["pullReference"]
                expected.extend([mock.call("cosign", "verify", *common, ref),
                                 mock.call("cosign", "verify-attestation", *common, "--type", "slsaprovenance", ref)])
            self.assertEqual(cosign.call_args_list, expected)
            cosign.reset_mock()
            inspect.return_value = raw + b" "
            with self.assertRaisesRegex(ValueError, "manifest digest mismatch"):
                images.verify_publication(path)
            cosign.assert_not_called()
            for key, value in [("commit", "c" * 40), ("publicationComplete", False), ("images", {})]:
                altered = {**manifest, key: value}
                path.write_text(json.dumps(altered, indent=2) + "\n", encoding="utf-8", newline="\n")
                inspect.reset_mock()
                with self.subTest(key=key), self.assertRaises(ValueError):
                    images.verify_publication(path)
                inspect.assert_not_called()

    def test_workflow_restricts_writes_and_oidc_to_main_publish(self):
        text = (ROOT / ".github/workflows/branch-image.yml").read_text()
        self.assertEqual(text.count("driver-opts: image=moby/buildkit:v0.26.3"), 1)
        self.assertNotIn("pull_request_target", text)
        self.assertEqual(text.count("packages: write"), 1)
        self.assertEqual(text.count("id-token: write"), 1)
        self.assertNotIn("attestations: write", text)
        jobs = re.split(r"(?m)^  (\w+):\n", text.split("jobs:\n", 1)[1])
        bodies = dict(zip(jobs[1::2], jobs[2::2]))
        for name, body in bodies.items():
            self.assertIn("runs-on: ubuntu-24.04", body)
            self.assertIn("HOSTED_KIND: ${{ runner.environment }}", body)
            self.assertIn('test "$HOSTED_KIND" = github-hosted', body)
            if name != "publish":
                self.assertNotIn("packages: write", body)
                self.assertNotIn("id-token: write", body)
                self.assertNotIn("secrets.GITHUB_TOKEN", body)
        guard = ("github.event_name == 'push' && github.ref == 'refs/heads/main'"
                 " && github.repository == 'WasalX/wasalx-platform'")
        self.assertIn(guard, bodies["publish"])
        self.assertIn(guard, bodies["manifest"])
        self.assertNotRegex(bodies["publish"], r"(?m)^    environment:")
        self.assertIn("BUILD_CACHE: ${{ github.ref_name == 'main' && 'write' || 'off' }}", bodies["publish"])
        self.assertNotIn("actions/attest-build-provenance@", text)
        self.assertNotIn("url:", text)
        allowed = {"actions/checkout", "actions/setup-node", "actions/upload-artifact", "actions/download-artifact",
                   "docker/setup-buildx-action", "docker/login-action", "sigstore/cosign-installer"}
        for action in re.findall(r"uses: (\S+)", text):
            name, sha = action.split("@")
            self.assertIn(name, allowed)
            self.assertRegex(sha, r"^[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()
