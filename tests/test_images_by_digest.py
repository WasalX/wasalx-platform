from unittest import mock
from contextlib import redirect_stderr, redirect_stdout
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
import textwrap
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "scripts/release"
with patch.object(sys, "path", [str(RELEASE), *sys.path]):
    spec = importlib.util.spec_from_file_location("images", RELEASE / "images-by-digest.py")
    images = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(images)
    alias_spec = importlib.util.spec_from_file_location("aliases", RELEASE / "advance-main-image-aliases.py")
    aliases = importlib.util.module_from_spec(alias_spec)
    alias_spec.loader.exec_module(aliases)
    mirror_spec = importlib.util.spec_from_file_location("mirrors", RELEASE / "installer-mirror-images.py")
    mirrors = importlib.util.module_from_spec(mirror_spec)
    mirror_spec.loader.exec_module(mirrors)


def alias_environment(directory, commit, *, attempt=2):
    path = Path(directory) / "workflow-event.json"
    event = {"action": "completed", "workflow_run": {"path": ".github/workflows/ci.yml",
             "head_repository": {"full_name": images.REPOSITORY}, "event": "push",
             "head_branch": "main", "head_sha": commit, "conclusion": "success", "id": 123,
             "run_attempt": attempt}}
    images.write(path, event)
    return {"GITHUB_EVENT_NAME": "workflow_run", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": images.REPOSITORY, "GITHUB_SHA": "d" * 40,
            "GITHUB_EVENT_PATH": str(path), "GITHUB_STEP_SUMMARY": str(Path(directory) / "summary.md"),
            "GITHUB_OUTPUT": str(Path(directory) / "output")}


def alias_manifest(commit, tree, catalog, *, digest=None, pending=()):
    digest = digest or images.sha256(b"manifest")
    receipts = []
    for entry in catalog:
        image = entry["image"]
        row = {"image": image, "commit": commit, "tree": tree, "platform": "linux/amd64"}
        if image in pending:
            row["status"] = "pending add-on source"
        else:
            row.update(status="published", verified=True, digest=digest, configDigest=images.sha256(b"config"),
                       pullReference=f"ghcr.io/wasalx/{image}@{digest}", workflow=images.MAIN_PUBLISHER,
                       workflowSha=commit, runId="123", runAttempt="1")
        receipts.append(row)
    return images.assemble(receipts, rows=catalog)


def write_alias_manifest(path, manifest, *, attempt="2", **binding):
    raw = (json.dumps(manifest, indent=2) + "\n").encode()
    path.write_bytes(raw)
    images.write(path.with_name("images-manifest-attempt.json"),
                 {"runId": "123", "runAttempt": attempt, "manifestSha256": images.sha256(raw), **binding})


class ImagePublicationTests(unittest.TestCase):
    def test_git_archives_disable_autocrlf(self):
        script_paths = subprocess.check_output(
            ["git", "grep", "-Ilz", "-F", "archive", "--", "scripts", ":(exclude,glob)**/*.md"],
            cwd=ROOT, timeout=10,
        ).decode().split("\0")
        # Cover shell commands and literal subprocess argument lists.
        archive_command = re.compile(
            r'''\bgit(?:[ \t]+[^\s;&|]+)*?[ \t]+archive\b'''
            r'''|["']git["']\s*,\s*\[?\s*(?:["'][^"'\n]*["']\s*,\s*)*?["']archive["']'''
        )
        for path in filter(None, script_paths):
            source = (ROOT / path).read_text(encoding="utf-8").replace("\\\n", " ")
            for command in archive_command.findall(source):
                args = re.sub(r'''["',\[\]]''', " ", command).split()
                self.assertIn(" -c core.autocrlf=false ", " ".join(args), path)

    def test_synthetic_mail_policies_are_explicit_and_nightly_allows_only_its_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            for mode in ["simulation", "nightly"]:
                with self.subTest(mode=mode):
                    target = Path(directory) / mode
                    subprocess.run(
                        [sys.executable, "-B", str(ROOT / "scripts/release/generate-simulation-env.py"),
                         str(ROOT), str(target), str(ROOT / "scripts/contracts/waha-simulation-server.mjs"),
                         *(["--installer-rehearsal"] if mode == "nightly" else [])],
                        check=True, capture_output=True, timeout=20,
                    )
                    keys = ("WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST", "WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED",
                            "WASALX_FULL_QUALIFICATION_OWNER_EMAIL")
                    env = dict(line.rstrip("'").split("='", 1) for line in target.read_text().splitlines()
                               if line.startswith(tuple(key + "=" for key in keys)))
                    expected = [env["WASALX_FULL_QUALIFICATION_OWNER_EMAIL"]] if mode == "nightly" else []
                    self.assertEqual(json.loads(env["WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST"]), expected)
                    self.assertEqual(env["WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED"],
                                     "true" if mode == "nightly" else "false")

    def test_signed_rehearsal_selects_fenced_keycloak_only_when_the_provider_is_packaged(self):
        overlay = (ROOT / "scripts/release/installer-nightly.compose.yaml").read_text()
        script = textwrap.dedent(overlay.split("      - |\n", 1)[1].split("      - --", 1)[0])
        script = script.replace("$$", "$").replace("/opt/keycloak/providers/wasalx-mail-fence.jar", '"$FENCE_JAR"')
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "bash"
        args = ["start", "--import-realm", "--spi-email-sender--provider=wasalx-fenced",
                "--spi-email-template--provider=wasalx-fenced"]
        record_exec = 'exec() { printf "%s\\n" "${@:2}"; exit 0; }\n'
        with tempfile.TemporaryDirectory() as directory:
            jar = Path(directory) / "wasalx-mail-fence.jar"
            for packaged in [False, True]:
                with self.subTest(packaged=packaged):
                    if packaged:
                        jar.write_bytes(b"fixture")
                    result = subprocess.check_output(
                        [bash, "--noprofile", "--norc", "-ec", record_exec + script, "--", *args],
                        env={**os.environ, "FENCE_JAR": jar.as_posix()}, text=True, timeout=10,
                    )
                    self.assertEqual(result.splitlines(), args if packaged else args[:2])

    def test_merge_group_workflow_selects_all_21_images(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        after_matrix_id = workflow.split("      - id: matrix\n", 1)[1]
        step = re.split(r"\n(?= {6}- | {2}\S)", after_matrix_id, maxsplit=1)[0]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "bash"
        helpers = '''\
python3() { "$TEST_PYTHON" -B "$@"; }
jq() { "$TEST_PYTHON" -c 'import json, sys; print(json.dumps(bool(json.load(sys.stdin)["include"])))'; }
'''
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            # Comparing HEAD with itself would give the selector an empty diff.
            subprocess.run(
                [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", helpers + script],
                cwd=ROOT, check=True, timeout=10,
                env={**os.environ, "EVENT": "merge_group", "BASE_SHA": "HEAD", "PUBLIC_ADDON_SOURCE": "",
                     "TEST_PYTHON": sys.executable, "GITHUB_OUTPUT": output.as_posix()},
            )
            values = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual(values["images"], "true")
        selected = json.loads(values["matrix"])["include"]
        self.assertEqual(len(selected), 21)
        self.assertEqual([row["image"] for row in selected], [row["image"] for row in images.catalog()])

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
            if args[:4] == ["git", "-c", "core.autocrlf=false", "archive"]:
                with tarfile.open(args[5].removeprefix("--output="), "w") as archive:
                    archive.add(ROOT / row["dockerfile"], arcname=row["dockerfile"])
            return subprocess.CompletedProcess(args, 0)

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
                self.assertEqual(args[:3], ("docker", "buildx", "build"))
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

    def test_foundation_postgres_build_rejects_postgresql_19(self):
        row = {"image": "foundation-postgres", "dockerfile": "Dockerfile.foundation-postgres"}

        def archive_source(args, **kwargs):
            with tarfile.open(args[5].removeprefix("--output="), "w") as archive:
                archive.add(ROOT / row["dockerfile"], arcname=row["dockerfile"])

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(images, "catalog", return_value=[row]), \
                patch.object(images, "coordinates", return_value=("a" * 40, "b" * 40)), \
                patch.object(images, "run", side_effect=["1794938086", "postgres (PostgreSQL) 19.0"]), \
                patch.object(images.subprocess, "run", side_effect=archive_source), \
                patch.object(images, "registry_output"), \
                patch.object(images, "inspect_image", return_value={}):
            receipt = Path(directory) / "receipt.json"
            with self.assertRaisesRegex(ValueError, "foundation-postgres must run PostgreSQL 18"):
                images.build(row["image"], receipt)
            self.assertFalse(receipt.exists())

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

    def test_keycloak_retries_only_temporary_apk_fetch_errors(self):
        helper = ROOT / "infra/docker/full/keycloak/apk-add-with-retry.sh"
        fixture = r"""
apk() {
    printf 'apk %s\n' "$*" >> "$calls"
    case "$scenario" in
        temporary)
            if [ "$(wc -l < "$calls")" -gt 1 ]; then return 0; fi
            ;;
        signature)
            printf '%s\n' 'ERROR: example: UNTRUSTED signature' >&2
            return 7
            ;;
    esac
    printf '%s\n' 'ERROR: example: temporary error (try again later)' >&2
    return 8
}
sleep() { printf 'sleep %s\n' "$1" >> "$backoff"; }
set -- 'example=1.2.3'
. "$helper"
"""
        apk_call = "apk add --no-cache example=1.2.3"
        for scenario, status, attempts in [("temporary", 0, 2), ("exhausted", 8, 2), ("signature", 7, 1)]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                calls = Path(directory) / "calls"
                backoff = Path(directory) / "backoff"
                result = subprocess.run(
                    ["sh", "-c", fixture], capture_output=True, text=True, timeout=10,
                    env={**os.environ, "helper": str(helper), "scenario": scenario,
                         "calls": str(calls), "backoff": str(backoff)},
                )
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(calls.read_text().splitlines(), [apk_call] * attempts)
                if attempts == 2:
                    self.assertEqual(backoff.read_text(), "sleep 2\n")
                else:
                    self.assertFalse(backoff.exists())

    def test_pull_request_matrix_selects_union_of_literal_context_inputs(self):
        rows = images.matrix()["include"]
        narrow = {
            "Dockerfile.foundation-postgres": "foundation-postgres",
            "scripts/release/test-foundation-postgres.sh": "foundation-postgres",
            "app/page.tsx": "portal",
            "services/invitation-mailer/src/removed.ts": "invitation-mailer",
            "scripts/release/patch-keycloak-jackson.py": "foundation-keycloak",
            "infra/docker/full/keycloak/mail-fence/AllowedEmailSenderFactory.java": "foundation-keycloak",
            "infra/docker/full/keycloak/apk-add-with-retry.sh": "foundation-keycloak",
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
                         ["portal", "control-api", "connector-worker", "tenant-provisioner",
                          "tenant-workspace-controller", "foundation-postgres"])
        self.assertEqual(images.matrix(["docs/guide/intro.md", "unmapped/new-file"], pull_request=True),
                         {"include": []})
        self.assertIn("A PR path that matches no image input selects no image.", (ROOT / "DELIVERY.md").read_text(encoding="utf-8"))

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
        for path in ["scripts/release/images-by-digest.py", "scripts/release/image_registry_retry.py",
                     ".github/workflows/ci.yml",
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

    def test_matrix_command_selects_pr_diff_legacy_base_and_full_catalog(self):
        base = "a" * 40
        script = ROOT / "scripts/release/images-by-digest.py"
        all_images = [row["image"] for row in images.catalog()]
        self.assertEqual(len(all_images), 21)
        for flags, diff_base, diff, expected in [
            (["--pull-request"], "HEAD^1", b"packages/core/src/index.ts\0",
             ["portal", "control-api", "connector-worker", "tenant-provisioner", "tenant-workspace-controller"]),
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

    def test_dockerfiles_do_not_fetch_github_generated_archives(self):
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z", "--", ":(glob)**/Dockerfile*"],
            cwd=ROOT, timeout=10,
        ).decode().split("\0")
        dockerfiles = {row["dockerfile"] for row in images.catalog()}
        dockerfiles.update(path for path in tracked if path and not path.endswith(".dockerignore"))
        generated_archive = re.compile(
            r"https?://(?:github\.com/[^/\s]+/[^/\s]+/archive/|codeload\.github\.com/|"
            r"api\.github\.com/repos/[^/\s]+/[^/\s]+/(?:tarball|zipball)\b)", re.IGNORECASE,
        )
        for path in sorted(dockerfiles):
            with self.subTest(dockerfile=path):
                source = (ROOT / path).read_text(encoding="utf-8")
                self.assertIsNone(generated_archive.search(source),
                                  "Use a commit-pinned Git source or a checksum-pinned release asset")

    def test_go_module_transport_is_scoped_to_the_build(self):
        for image in ("alertmanager", "cloudflared", "otel", "prometheus"):
            with self.subTest(image=image):
                dockerfile = (ROOT / f"Dockerfile.production-{image}").read_text(encoding="utf-8")
                build, runtime = dockerfile.rsplit("\nFROM ", 1)
                if image == "prometheus":
                    self.assertNotIn("GODEBUG", build)
                else:
                    self.assertIn("ENV GODEBUG=http2client=0", build.splitlines())
                self.assertNotIn("GOSUMDB=off", build)
                self.assertNotIn("GODEBUG", runtime)

    def test_registry_cache_roles_are_disjoint(self):
        self.assertEqual(len(images.CACHED_IMAGES), 12)
        self.assertLessEqual(images.CACHED_IMAGES, {row["image"] for row in images.catalog()})
        main = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": images.REPOSITORY}
        ref = "type=registry,ref=ghcr.io/wasalx/buildcache:"
        with mock.patch.dict(os.environ, main, clear=True):
            for image in ("production-prometheus", "production-alertmanager"):
                self.assertEqual(images.cache_options(image, "write"), ["--cache-to", ref + image + ",mode=max,ignore-error=true"])
            self.assertEqual(images.cache_options("portal", "off"), [])
            self.assertEqual(images.cache_options("postgres", "write"), [])
            with self.assertRaises(ValueError):
                images.cache_options("portal", "read")
        for event in ["pull_request", "merge_group"]:
            with mock.patch.dict(os.environ, {"GITHUB_EVENT_NAME": event}, clear=True):
                for image in ("production-prometheus", "production-alertmanager"):
                    self.assertEqual(images.cache_options(image, "read"), ["--cache-from", ref + image])
                with self.assertRaises(ValueError):
                    images.cache_options("portal", "write")

    def test_docker_pull_retries_only_the_pull(self):
        command = ("docker", "pull", "--platform", "linux/amd64", "base")
        failure = subprocess.CalledProcessError(1, command, stderr=b"received unexpected HTTP status: 503 Service Unavailable")
        with (patch.object(subprocess, "run", side_effect=failure) as run,
              patch("time.sleep") as sleep, redirect_stderr(io.StringIO()), self.assertRaises(subprocess.CalledProcessError)):
            images.pull("base")
        self.assertEqual([call.args[0] for call in run.call_args_list], [command] * 3)
        self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2)])

    def test_registry_transport_recovers_without_changing_command_or_output(self):
        command = ("docker", "push", "image")
        failures = [
            b"unexpected status from HEAD request to https://registry.example.test/v2/images: 503 Service Unavailable",
            b'Get "https://registry.example.test/v2/": read tcp 127.0.0.1:443: read: connection reset by peer',
        ]
        results = [subprocess.CalledProcessError(1, command, stderr=reason) for reason in failures]
        results.append(subprocess.CompletedProcess(command, 0, stdout=b"published"))
        with (patch.object(subprocess, "run", side_effect=results) as run,
              patch("time.sleep") as sleep, redirect_stderr(io.StringIO()) as logs):
            self.assertEqual(images.registry_output(*command), b"published")
        self.assertEqual([call.args[0] for call in run.call_args_list], [command] * 3)
        self.assertEqual(sleep.call_args_list, [mock.call(10), mock.call(20)])
        self.assertEqual(logs.getvalue().count("Transient registry transport failure"), 2)

    def test_registry_failures_without_a_transient_cause_stop_immediately(self):
        cases = [
            (("docker", "buildx", "build"), b"unexpected HTTP status: 503\nERROR: failed to solve: exit code: 1"),
            (("docker", "push"), b"unauthorized: unexpected HTTP status: 503"),
            (("docker", "push"), b"unexpected HTTP status: 401\nproxy body: unexpected HTTP status: 503"),
            (("docker", "push"), b"unexpected HTTP status: 401 Unauthorized"),
            (("cosign", "sign"), b"error: certificate identity mismatch"),
            (("cosign", "verify"), b"error: no matching signatures"),
            (("cosign", "attest"), b"error: invalid provenance"),
            (("cosign", "verify-attestation"), b"error: no matching attestations"),
            (("docker", "pull"), b"unknown blob"),
            (("docker", "pull"), b"error: digest mismatch"),
            (("docker", "pull"), b"x509: certificate signed by unknown authority"),
            (("docker", "pull"), b""),
        ]
        for command, reason in cases:
            failure = subprocess.CalledProcessError(1, command, stderr=reason)
            with (self.subTest(command=command, reason=reason), patch.object(subprocess, "run", side_effect=failure) as run,
                  patch("time.sleep") as sleep, redirect_stderr(io.StringIO()), self.assertRaises(subprocess.CalledProcessError)):
                images.registry_output(*command)
            run.assert_called_once()
            sleep.assert_not_called()

    def test_publication_retries_only_push_blob_and_exact_digest_read_back_failures(self):
        commit, tree, digest = "a" * 40, "b" * 40, "sha256:" + "1" * 64
        inspection = {"configDigest": "sha256:" + "2" * 64, "addonLicenses": {}}
        manifest = json.dumps({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                               "config": {"digest": inspection["configDigest"]}}).encode()
        env = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main", "GITHUB_WORKFLOW_SHA": commit,
               "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}
        reference = f"ghcr.io/wasalx/zammad-nginx:{commit}"
        receipt = {"image": "zammad-nginx", "reference": reference, "commit": commit, "tree": tree,
                   "status": "built", "inspection": inspection, "sourceArchiveDigest": "",
                   "addonSource": None, "dockerfileDigest": ""}
        command = ("docker", "push", reference)
        diagnostic = b"sha256:" + b"3" * 64 + b" HTTP/1.1 404 Not Found"
        failure = subprocess.CalledProcessError(1, command, output=diagnostic + b"\n", stderr=b"unknown blob\n")
        inspect = ("docker", "buildx", "imagetools", "inspect", "--raw", f"ghcr.io/wasalx/zammad-nginx@{digest}")
        missing_diagnostic = (f"ERROR: httpReadSeeker: failed open: content at "
                              f"https://ghcr.io/v2/wasalx/zammad-nginx/manifests/{digest} not found: not found\n").encode()
        missing = subprocess.CalledProcessError(1, inspect, stderr=missing_diagnostic)
        wrong_digest = subprocess.CalledProcessError(
            1, inspect, stderr=missing_diagnostic.replace(digest.encode(), b"sha256:" + b"9" * 64))
        pushed = subprocess.CompletedProcess(command, 0, stdout=f"digest: {digest}".encode())
        inspected = subprocess.CompletedProcess(inspect, 0, stdout=manifest)
        signing = [subprocess.CompletedProcess((), 0, stdout=b"")] * 4
        cases = [
            ("push recovers", [failure, pushed, inspected, *signing], 2, 1, [10], True),
            ("push exhausted", [failure] * 3, 3, 0, [10, 20], False),
            ("digest becomes visible", [pushed, missing, inspected, *signing], 1, 2, [10], True),
            ("digest remains missing", [pushed, missing, missing, missing], 1, 3, [10, 20], False),
            ("different digest fails immediately", [pushed, wrong_digest], 1, 1, [], False),
        ]
        for name, results, push_count, inspect_count, delays, published in cases:
            with (self.subTest(name=name), tempfile.TemporaryDirectory() as directory,
                  patch.dict(os.environ, env, clear=True), patch.object(images, "coordinates", return_value=(commit, tree)),
                  patch.object(images, "pull"), patch.object(images, "inspect_image", return_value=inspection),
                  patch.object(subprocess, "run", side_effect=results) as run,
                  patch("time.sleep") as sleep, redirect_stderr(io.StringIO()) as logs):
                path = Path(directory) / "receipt.json"
                images.write(path, receipt)
                if published:
                    images.publish(path)
                    record = json.loads(path.read_text())
                    self.assertEqual((record["digest"], record["status"]), (digest, "published"))
                    self.assertTrue(record["verified"])
                else:
                    with self.assertRaises(subprocess.CalledProcessError) as raised:
                        images.publish(path)
                    self.assertEqual(raised.exception.returncode, 1)
                    self.assertEqual(json.loads(path.read_text()), receipt)
                    self.assertFalse(path.with_suffix(".json.predicate.json").exists())
                    self.assertEqual(run.call_count, push_count + inspect_count)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(commands[:push_count + inspect_count], [command] * push_count + [inspect] * inspect_count)
            self.assertEqual(sleep.call_args_list, [mock.call(delay) for delay in delays])
            push_failures = results.count(failure)
            for attempt in range(1, push_failures + 1):
                self.assertIn(f"Image push attempt {attempt}/3 failed.", logs.getvalue())
            self.assertEqual(logs.getvalue().count(diagnostic.decode()), push_failures)
            self.assertEqual(logs.getvalue().count("unknown blob\n"), push_failures)

    def test_mirror_publication_uses_active_and_staged_compose_pins(self):
        compose = mirrors.load_compose((ROOT / mirrors.COMPOSE).read_bytes())
        row = compose[mirrors.INVENTORY]["minio"]
        staged = "quay.io/minio/minio:next@sha256:" + "a" * 64
        row["staged"] = staged
        with (tempfile.TemporaryDirectory() as directory, patch.object(mirrors, "publish") as publish,
              patch.object(sys, "argv", ["installer-mirror-images.py", "publish"])):
            path = Path(directory) / mirrors.COMPOSE
            path.write_text(json.dumps(compose), encoding="utf-8")
            with patch.object(mirrors, "COMPOSE", path):
                mirrors.main()

        active_digest = compose["services"]["minio"]["image"].split("@")[1]
        client_digest = compose["services"]["minio-bootstrap"]["image"].split("@")[1]
        self.assertEqual(publish.call_args_list, [
            mock.call(f"quay.io/minio/minio@{active_digest}", f"{row['mirror']}@{active_digest}", row["fallback"]),
            mock.call(staged.replace(":next@", "@"), f"{row['mirror']}@sha256:" + "a" * 64, row["fallback"]),
            mock.call(f"quay.io/minio/mc@{client_digest}", f"ghcr.io/wasalx/mc@{client_digest}", "ghcr.io/netvark/mc"),
        ])

    def test_mirror_activation_requires_base_staging_and_matching_public_bytes(self):
        base = mirrors.load_compose((ROOT / mirrors.COMPOSE).read_bytes())
        candidate = copy.deepcopy(base)
        manifest = b'{"schemaVersion":2,"layers":[]}'
        digest = images.sha256(manifest)
        staged = f"quay.io/minio/minio:next@{digest}"
        candidate["services"]["minio"]["image"] = staged
        rows = list(mirrors.inventory(candidate))
        inspect = ("docker", "buildx", "imagetools", "inspect", "--raw", f"ghcr.io/wasalx/minio@{digest}")

        with patch.object(subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "stage this exact reference"):
                mirrors.verify_active(rows, base)
            run.assert_not_called()

        base[mirrors.INVENTORY]["minio"]["staged"] = staged
        with patch.object(mirrors, "verify_manifest") as verify:
            mirrors.verify_active(rows, base)
            self.assertEqual(verify.call_args_list, [mock.call(row[3], timeout=4, delays=(1, 2)) for row in rows])

        for response, error in [
            (subprocess.CalledProcessError(1, inspect, stderr=b"manifest unknown"), subprocess.CalledProcessError),
            (subprocess.CompletedProcess(inspect, 0, stdout=b"wrong bytes"), ValueError),
        ]:
            with (self.subTest(error=error), patch.object(subprocess, "run",
                  side_effect=[response] if isinstance(response, Exception) else None,
                  return_value=response) as run, patch("time.sleep") as sleep,
                  redirect_stderr(io.StringIO()), self.assertRaises(error)):
                mirrors.verify_active(rows, base)
            run.assert_called_once_with(inspect, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=4)
            sleep.assert_not_called()

    def test_active_mirror_retries_transient_registry_errors_within_budget(self):
        manifest = b'{"schemaVersion":2,"layers":[]}'
        digest = images.sha256(manifest)
        source = f"quay.io/minio/minio@{digest}"
        repository = "ghcr.io/wasalx/minio"
        compose = {
            "services": {"minio": {"image": source}},
            mirrors.INVENTORY: {"minio": {"mirror": repository, "fallback": "ghcr.io/netvark/minio", "staged": None}},
        }
        rows = list(mirrors.inventory(compose))
        inspect = ("docker", "buildx", "imagetools", "inspect", "--raw", f"{repository}@{digest}")
        for reason in [b"unexpected HTTP status: 502", b"unexpected HTTP status: 429", b"net/http: TLS handshake timeout"]:
            failure = subprocess.CalledProcessError(1, inspect, stderr=reason)
            success = subprocess.CompletedProcess(inspect, 0, stdout=manifest)
            with (self.subTest(reason=reason),
                  patch.object(subprocess, "run", side_effect=[failure, failure, success]) as run,
                  patch("time.sleep") as sleep, redirect_stderr(io.StringIO())):
                mirrors.verify_active(rows, compose)
            expected = mock.call(inspect, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=4)
            self.assertEqual(run.call_args_list, [expected] * 3)
            self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2)])

    def test_mirror_read_back_retries_the_published_digest_after_primary_or_fallback_copy(self):
        manifest = b'{"schemaVersion":2,"layers":[]}'
        digest = images.sha256(manifest)
        source = f"quay.io/minio/mc@{digest}"
        fallback = "ghcr.io/netvark/mc"
        mirror = f"ghcr.io/wasalx/mc@{digest}"
        tag = f"ghcr.io/wasalx/mc:sha256-{digest[7:]}"
        inspect = ("docker", "buildx", "imagetools", "inspect", "--raw", mirror)
        missing = (f"ERROR: httpReadSeeker: failed open: content at "
                   f"https://ghcr.io/v2/wasalx/mc/manifests/{digest} not found: not found\n").encode()
        invisible = subprocess.CalledProcessError(1, inspect, stderr=missing)
        successful = subprocess.CompletedProcess((), 0, stdout=manifest)
        failed_copy = subprocess.CalledProcessError(1, "primary copy")

        for use_fallback in (False, True):
            before_read = [successful, failed_copy, successful, successful] if use_fallback else [successful, successful]
            with (self.subTest(fallback=use_fallback),
                  patch.object(subprocess, "run", side_effect=[*before_read, invisible, successful]) as run,
                  patch("time.sleep") as sleep, redirect_stderr(io.StringIO()) as logs):
                mirrors.publish(source, mirror, fallback)
            commands = [call.args[0] for call in run.call_args_list]
            copy_command = ["docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag", tag]
            self.assertEqual(commands[1], [*copy_command, source])
            if use_fallback:
                self.assertEqual(commands[3], [*copy_command, f"{fallback}@{digest}"])
            self.assertEqual(commands[-2:], [inspect, inspect])
            sleep.assert_called_once_with(10)
            self.assertIn("Published image manifest is not yet visible", logs.getvalue())

        with (patch.object(subprocess, "run", return_value=subprocess.CompletedProcess((), 0, stdout=b"wrong")),
              self.assertRaisesRegex(ValueError, "Digest mismatch")):
            mirrors.publish(source, mirror, fallback)

    def test_publication_pushes_only_the_commit_tag_and_uses_the_signing_identity(self):
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
                    patch.object(images, "registry_output", side_effect=[f"digest: {digest}".encode(), manifest,
                                                                         b"", b"", b"", b""]) as run, \
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
                self.assertEqual(published["workflow"], identity)
                self.assertTrue(published["verified"])
                run.assert_any_call("cosign", "verify", "--certificate-identity", identity,
                                    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", reference)
                self.assertEqual([call for call in run.call_args_list if call.args[:2] == ("docker", "push")],
                                 [mock.call("docker", "push", receipt["reference"], retry_unknown_blob=True)])

        for event, ref in (("push", "refs/heads/dev"), ("push", "refs/heads/feature"), ("pull_request", "refs/heads/main")):
            with self.subTest(event=event, ref=ref), patch.dict(os.environ, {"GITHUB_EVENT_NAME": event, "GITHUB_REF": ref}):
                with self.assertRaisesRegex(ValueError, "requires a main push"):
                    images.publish("unused")

    def test_main_alias_advances_to_a_descendant_and_skips_a_late_older_publish_or_unknown_revision(self):
        raw = b'{"schemaVersion":2}'
        digest = images.sha256(raw)
        repository = "ghcr.io/wasalx/portal"
        alias = repository + ":main"
        reference = repository + "@" + digest
        git_run = subprocess.run
        with tempfile.TemporaryDirectory() as directory:
            git_run(["git", "init", "--quiet"], cwd=directory, check=True)
            catalog = [{"image": "portal"}]
            catalog_path = Path(directory) / images.CATALOG_PATH
            images.write(catalog_path, catalog)
            git_run(["git", "add", images.CATALOG_PATH], cwd=directory, check=True)

            def commit(message):
                git_run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c",
                         "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", message],
                        cwd=directory, check=True)
                return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=directory, text=True).strip()

            older, newer = commit("older"), commit("newer")
            images.write(catalog_path, [{"image": "another-image"}])
            git_run(["git", "add", images.CATALOG_PATH], cwd=directory, check=True)
            commit("catalog changed on main")
            current = older

            def registry(*command, **kwargs):
                nonlocal current
                self.assertEqual(command[:3], ("docker", "buildx", "imagetools"))
                if command[3] == "create":
                    self.assertEqual(command[4:], ("--prefer-index=false", "--tag", alias, reference))
                    current = newer
                    return None
                self.assertEqual(command[3], "inspect")
                self.assertEqual(command[-1], alias)
                if command[4] == "--raw":
                    return raw
                self.assertEqual(command[4:-1], ("--format", "{{json .Image.Config.Labels}}"))
                return json.dumps({"org.opencontainers.image.revision": current}).encode()

            manifest = Path(directory) / "images-manifest.json"
            summary = Path(directory) / "summary.md"
            with patch.object(aliases.images, "ROOT", Path(directory)), \
                    patch.object(aliases, "registry_output", side_effect=registry) as registry_calls, \
                    patch.object(subprocess, "run", side_effect=lambda command, **kw: git_run(command, **{"cwd": directory, **kw})), \
                    redirect_stdout(io.StringIO()) as stdout:
                for candidate, expected in ((newer, newer), (newer, newer), (older, newer), (older, None)):
                    if expected is None:
                        current = None
                    tree = images.run("git", "rev-parse", f"{candidate}^{{tree}}", cwd=directory)
                    write_alias_manifest(manifest, alias_manifest(candidate, tree, catalog, digest=digest))
                    with patch.dict(os.environ, alias_environment(directory, candidate)):
                        aliases.advance_main_aliases(manifest)
                    self.assertEqual(current, expected)
                self.assertEqual(sum(call.args[3] == "create" for call in registry_calls.call_args_list), 1)
            messages = summary.read_text(encoding="utf-8")
            self.assertIn(f"Advanced `{alias}` from `{older}` to `{newer}`", messages)
            self.assertIn(f"Kept `{alias}` at `{newer}`.", messages)
            self.assertIn(f"Skipped `{alias}` at `{newer}` because `{older}` does not descend from it", messages)
            self.assertIn(f"Skipped `{alias}` because its current revision could not be determined", messages)

            warnings = [line for line in stdout.getvalue().splitlines() if line.startswith("::warning::")]
            self.assertEqual(warnings, [f"::warning::{line[2:]}" for line in messages.splitlines()
                                        if line.startswith("- Skipped ")])
            self.assertEqual(len(warnings), 2)

    def test_main_alias_retries_create_and_raw_inspect_independently(self):
        raw = b'{"schemaVersion":2}'
        alias = "ghcr.io/wasalx/portal:main"
        reference = "ghcr.io/wasalx/portal@" + images.sha256(raw)
        commit, older = "a" * 40, "b" * 40
        create = ("docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag", alias, reference)
        inspect = ("docker", "buildx", "imagetools", "inspect", "--raw", alias)
        ancestry = ["git", "merge-base", "--is-ancestor", older, commit]
        labels = json.dumps({"org.opencontainers.image.revision": older}).encode()
        unavailable = b"unexpected status code: 503 Service Unavailable"
        with (patch.object(subprocess, "run", side_effect=[
                  subprocess.CompletedProcess([], 0, stdout=labels),
                  subprocess.CompletedProcess(ancestry, 0), subprocess.CalledProcessError(1, create, stderr=unavailable),
                  subprocess.TimeoutExpired(create, 60), subprocess.CompletedProcess(create, 0),
                  subprocess.TimeoutExpired(inspect, 20), subprocess.CalledProcessError(1, inspect, stderr=unavailable),
                  subprocess.CompletedProcess(inspect, 0, stdout=raw)]) as run,
              patch("time.sleep") as sleep, redirect_stderr(io.StringIO())):
            message, skipped = aliases.advance_alias(reference, commit)
        self.assertTrue(message.startswith("Advanced "))
        self.assertFalse(skipped)
        self.assertEqual(run.call_args_list[1:], [mock.call(ancestry, stderr=subprocess.DEVNULL, timeout=10)]
                         + [mock.call(create, check=True, stdout=None, stderr=subprocess.PIPE, timeout=60)] * 3
                         + [mock.call(inspect, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)] * 3)
        self.assertEqual(sleep.call_args_list, [mock.call(10), mock.call(20)] * 2)

    def test_main_alias_fails_after_three_registry_attempts(self):
        labels = subprocess.CompletedProcess([], 0, stdout=b'{"org.opencontainers.image.revision":"' + b"b" * 40 + b'"}')
        reference = "ghcr.io/wasalx/portal@" + images.sha256(b"manifest")
        failure = subprocess.CalledProcessError(1, "imagetools", stderr=b"unexpected status code: 502 Bad Gateway")
        ancestry = subprocess.CompletedProcess("git merge-base", 0)
        for stage, prefix in (("lookup", []), ("create", [labels, ancestry]),
                              ("inspect", [labels, ancestry, subprocess.CompletedProcess([], 0)])):
            with self.subTest(stage=stage):
                with (patch.object(subprocess, "run", side_effect=prefix + [failure] * 3) as run,
                      patch("time.sleep") as sleep, redirect_stderr(io.StringIO()), self.assertRaises(subprocess.CalledProcessError)):
                    aliases.advance_alias(reference, "a" * 40)
                self.assertEqual(run.call_count, len(prefix) + 3)
                self.assertEqual(sleep.call_args_list, [mock.call(10), mock.call(20)])

    def test_main_alias_digest_mismatch_fails_without_retry(self):
        reference = "ghcr.io/wasalx/portal@" + images.sha256(b"manifest")
        commit = "a" * 40
        for current in ("b" * 40, commit):
            labels = json.dumps({"org.opencontainers.image.revision": current}).encode()
            responses = [labels, b"wrong"] if current == commit else [labels, None, b"wrong"]
            with (self.subTest(current=current),
                  patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run,
                  patch.object(aliases, "registry_output", side_effect=responses) as registry,
                  self.assertRaisesRegex(ValueError, "alias digest mismatch")):
                aliases.advance_alias(reference, commit)
            self.assertEqual(run.call_count, int(current != commit))
            self.assertEqual(registry.call_count, len(responses))

    def test_alias_lookup_skips_missing_alias_and_fails_fast_on_denied_access(self):
        reference = "ghcr.io/wasalx/portal@" + images.sha256(b"manifest")
        for diagnostic in (b"ERROR: ghcr.io/wasalx/portal:main: not found", b"denied: unauthorized"):
            failure = subprocess.CalledProcessError(1, "imagetools", stderr=diagnostic)
            with (self.subTest(diagnostic=diagnostic), patch.object(subprocess, "run", side_effect=failure) as run,
                  patch("time.sleep") as sleep, redirect_stderr(io.StringIO())):
                if diagnostic.endswith(b"not found"):
                    message, skipped = aliases.advance_alias(reference, "a" * 40)
                    self.assertTrue(skipped)
                    self.assertIn("current revision could not be determined", message)
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        aliases.advance_alias(reference, "a" * 40)
                run.assert_called_once()
                sleep.assert_not_called()

    def test_main_alias_warns_when_git_ancestry_is_unknown(self):
        commit, older, tree = "a" * 40, "b" * 40, "c" * 40
        labels = json.dumps({"org.opencontainers.image.revision": older}).encode()
        catalog = [{"image": "portal"}]
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            summary = Path(directory) / "summary.md"
            write_alias_manifest(manifest, alias_manifest(commit, tree, catalog))
            env = alias_environment(directory, commit)
            with (patch.dict(os.environ, env), patch.object(aliases, "registry_output", return_value=labels) as read,
                  patch.object(aliases.images, "run", return_value=tree),
                  patch.object(aliases.images, "catalog", return_value=catalog),
                  patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 128)) as run,
                  redirect_stdout(io.StringIO()) as stdout):
                aliases.advance_main_aliases(manifest)
            read.assert_called_once()
            run.assert_called_once_with(["git", "merge-base", "--is-ancestor", older, commit],
                                        stderr=subprocess.DEVNULL, timeout=10)
            message = f"Skipped `ghcr.io/wasalx/portal:main` because ancestry from `{older}` could not be verified."
            self.assertEqual(stdout.getvalue(), f"::warning::{message}\n")
            self.assertEqual(summary.read_text(encoding="utf-8"), f"- {message}\n")

    def test_main_alias_event_guards_prevent_registry_access(self):
        commit = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            summary = Path(directory) / "summary.md"
            env = alias_environment(directory, commit)
            event_path = Path(env["GITHUB_EVENT_PATH"])
            event = json.loads(event_path.read_bytes())
            with patch.dict(os.environ, env), patch.object(aliases, "advance_alias") as advance:
                for key, value in (("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", "refs/heads/feature"),
                                   ("GITHUB_REPOSITORY", "example/fork")):
                    with (self.subTest(guard=key), patch.dict(os.environ, {key: value}),
                          self.assertRaisesRegex(ValueError, "require a completed main CI push")):
                        aliases.advance_main_aliases(manifest)
                for key, value in (("conclusion", "failure"), ("event", "pull_request"), ("head_branch", "feature"),
                                   ("path", ".github/workflows/other.yml"), ("head_repository", {"full_name": "example/fork"})):
                    images.write(event_path, {**event, "workflow_run": {**event["workflow_run"], key: value}})
                    with self.subTest(key=key), self.assertRaisesRegex(ValueError, "require a completed main CI push"):
                        aliases.advance_main_aliases(manifest)
                for key, value in (("head_sha", "main"), ("id", 0), ("run_attempt", "2")):
                    images.write(event_path, {**event, "workflow_run": {**event["workflow_run"], key: value}})
                    with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Invalid triggering"):
                        aliases.advance_main_aliases(manifest)
                advance.assert_not_called()
            self.assertFalse(summary.exists())

    def test_main_alias_requires_a_complete_bound_publication_before_registry_access(self):
        commit, tree = "a" * 40, "b" * 40
        catalog = images.catalog()
        complete = alias_manifest(commit, tree, catalog)
        allowed_pending = alias_manifest(commit, tree, catalog, pending=images.addon_images(catalog))
        with (tempfile.TemporaryDirectory() as directory, patch.object(aliases.images, "run", return_value=tree),
              patch.object(aliases.images, "catalog", return_value=catalog) as historical_catalog,
              patch.object(aliases, "advance_alias", return_value=("Verified alias.", False)) as advance,
              redirect_stdout(io.StringIO()) as stdout):
            path = Path(directory) / "images-manifest.json"
            env = alias_environment(directory, commit)
            with patch.dict(os.environ, env):
                for binding, error in [({"attempt": "3"}, "later CI attempt"), ({"runId": "124"}, "triggering run"),
                                       ({"manifestSha256": images.sha256(b"other bytes")}, "manifest bytes")]:
                    with self.subTest(binding=binding), self.assertRaisesRegex(ValueError, error):
                        write_alias_manifest(path, complete, **binding)
                        aliases.advance_main_aliases(path)
                write_alias_manifest(path, complete)
                path.with_name("images-manifest-attempt.json").unlink()
                with self.assertRaisesRegex(ValueError, "producing-attempt binding"):
                    aliases.advance_main_aliases(path, validate_only=True)

                for key, value in [("images", {}), ("images", {"portal": complete["images"]["portal"]}),
                                   ("tree", "c" * 40), ("commit", "c" * 40), ("schemaVersion", 2),
                                   ("repository", "example/other"), ("platform", "linux/arm64"),
                                   ("publicationComplete", False)]:
                    write_alias_manifest(path, {**complete, key: value})
                    with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                        aliases.advance_main_aliases(path)

                for key, value in [("tree", "c" * 40), ("platform", "linux/arm64"), ("verified", False),
                                   ("digest", "main"), ("status", "built"), ("workflow", "other"),
                                   ("workflowSha", "c" * 40), ("runId", "124"), ("runAttempt", "3")]:
                    invalid = copy.deepcopy(complete)
                    invalid["images"]["portal"][key] = value
                    write_alias_manifest(path, invalid)
                    with self.subTest(row_key=key), self.assertRaises(ValueError):
                        aliases.advance_main_aliases(path)

                for image in ("zammad", "portal"):
                    invalid = copy.deepcopy(complete)
                    row = invalid["images"].pop(image)
                    invalid["pending"][image] = {key: row[key] for key in ("image", "commit", "tree", "platform")}
                    invalid["pending"][image]["status"] = "pending add-on source"
                    invalid["publicationComplete"] = False
                    write_alias_manifest(path, invalid)
                    with self.subTest(pending=image), self.assertRaises(ValueError):
                        aliases.advance_main_aliases(path)
                invalid = copy.deepcopy(allowed_pending)
                invalid["pending"]["zammad"]["pullReference"] = complete["images"]["zammad"]["pullReference"]
                write_alias_manifest(path, invalid)
                with self.assertRaisesRegex(ValueError, "cannot contain publication claims"):
                    aliases.advance_main_aliases(path, validate_only=True)
                advance.assert_not_called()
                self.assertFalse(Path(env["GITHUB_OUTPUT"]).exists())

                write_alias_manifest(path, complete, attempt="1")
                aliases.advance_main_aliases(path, validate_only=True)
                aliases.advance_main_aliases(path)
                self.assertEqual(Path(env["GITHUB_OUTPUT"]).read_text(), "ready=false\n")
                self.assertIn("HELD_PRIOR_ATTEMPT: CI run 123 attempt 2 reused the manifest from attempt 1",
                              stdout.getvalue())
                advance.assert_not_called()

                for manifest in (complete, allowed_pending):
                    write_alias_manifest(path, manifest)
                    aliases.advance_main_aliases(path, validate_only=True)
                    self.assertTrue(Path(env["GITHUB_OUTPUT"]).read_text().endswith("ready=true\n"))
                    advance.assert_not_called()
                    aliases.advance_main_aliases(path)
                    self.assertEqual(advance.call_args_list,
                                     [mock.call(row["pullReference"], commit) for row in manifest["images"].values()])
                    advance.reset_mock()
            historical_catalog.assert_called_with(commit=commit)

    def test_failed_alias_is_recorded_without_changing_immutable_publication_receipt(self):
        commit, tree = "a" * 40, "b" * 40
        catalog = [{"image": image} for image in ("portal", "worker", "zammad")]
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            summary = Path(directory) / "summary.md"
            write_alias_manifest(manifest, alias_manifest(commit, tree, catalog))
            artifact = manifest.read_bytes()
            failure = subprocess.CalledProcessError(1, "imagetools", stderr=b"error: unauthorized")
            with (patch.dict(os.environ, alias_environment(directory, commit)), redirect_stdout(io.StringIO()) as logs,
                  patch.object(aliases.images, "run", return_value=tree),
                  patch.object(aliases.images, "catalog", return_value=catalog),
                  patch.object(aliases, "advance_alias", side_effect=[("Advanced portal.", False), failure]) as advance,
                  self.assertRaises(subprocess.CalledProcessError)):
                aliases.advance_main_aliases(manifest)
            self.assertEqual(advance.call_count, 2)
            self.assertEqual(manifest.read_bytes(), artifact)
            self.assertIn("::error::Failed to verify", logs.getvalue())
            self.assertIn("Advanced portal.", summary.read_text(encoding="utf-8"))
            self.assertIn("Failed to verify `ghcr.io/wasalx/worker:main`", summary.read_text(encoding="utf-8"))

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
                patch.object(images, "registry_output") as cosign:
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

    def test_workflow_restricts_package_writes_to_publish_and_aliases_and_oidc_to_publish(self):
        text = (ROOT / ".github/workflows/branch-image.yml").read_text()
        alias_workflow = (ROOT / ".github/workflows/main-image-aliases.yml").read_text()
        self.assertEqual(text.count("driver-opts: image=moby/buildkit:v0.26.3"), 1)
        self.assertNotIn("pull_request_target", text + alias_workflow)
        self.assertEqual(text.count("packages: write"), 1)
        self.assertEqual(alias_workflow.count("packages: write"), 1)
        self.assertEqual(text.count("id-token: write"), 1)
        self.assertNotIn("id-token: write", alias_workflow)
        self.assertNotIn("attestations: write", text + alias_workflow)
        jobs = re.split(r"(?m)^  (\w+):\n", text.split("jobs:\n", 1)[1])
        bodies = dict(zip(jobs[1::2], jobs[2::2]))
        bodies["aliases"] = alias_workflow.split("jobs:\n", 1)[1]
        for name, body in bodies.items():
            self.assertIn("runs-on: ubuntu-24.04", body)
            self.assertIn("HOSTED_KIND: ${{ runner.environment }}", body)
            self.assertIn('test "$HOSTED_KIND" = github-hosted', body)
            self.assertEqual("id-token: write" in body, name == "publish")
            self.assertEqual("packages: write" in body, name in ("publish", "aliases"))
            self.assertEqual("secrets.GITHUB_TOKEN" in body, name in ("publish", "aliases"))
        guard = ("github.event_name == 'push' && github.ref == 'refs/heads/main'"
                 " && github.repository == 'WasalX/wasalx-platform'")
        self.assertIn(guard, bodies["publish"])
        self.assertIn(guard, bodies["manifest"])
        self.assertNotRegex(bodies["publish"], r"(?m)^    environment:")
        self.assertIn(guard, bodies["queue"])
        self.assertRegex(bodies["publish"], r"(?m)^    needs: queue$")
        self.assertIn("ref: ${{ github.sha }}", bodies["publish"])
        build = 'images-by-digest.py build --cache write --image "$IMAGE" --output "records/$IMAGE.json"'
        publish = 'images-by-digest.py publish --output "records/$IMAGE.json"'
        self.assertLess(bodies["publish"].index(build), bodies["publish"].index(publish))
        self.assertNotIn("actions/download-artifact@", bodies["publish"])
        self.assertNotIn("actions/attest-build-provenance@", text)
        self.assertNotIn("url:", text)
        allowed = {"actions/checkout", "actions/setup-node", "actions/upload-artifact", "actions/download-artifact",
                   "docker/setup-buildx-action", "docker/login-action", "sigstore/cosign-installer"}
        actions = re.findall(r"uses: (\S+)", text + alias_workflow)
        cosign_action = "./.github/actions/cosign"
        self.assertEqual(actions.count(cosign_action), 1)
        actions.remove(cosign_action)
        install = (ROOT / cosign_action / "action.yml").read_text()
        nested = re.findall(r"uses: (\S+)", install)
        self.assertEqual(len(nested), 1)
        self.assertTrue(nested[0].startswith("sigstore/cosign-installer@"))
        for action in actions + nested:
            name, sha = action.split("@")
            self.assertIn(name, allowed)
            self.assertRegex(sha, r"^[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()
