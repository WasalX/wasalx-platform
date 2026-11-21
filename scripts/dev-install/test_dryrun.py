#!/usr/bin/env python3
"""Exercise the rendered packet in a network-isolated Linux container."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
IDENTITY = FIXTURES / "identity.example.json"
IMAGE = "node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea"
SANDBOX_HOSTNAME = "sandbox.example.test"
NATIVE_READABILITY = """
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { assertRepositoryBindMountsReadable } = await import(pathToFileURL(process.argv[2]));
await assertRepositoryBindMountsReadable({
  repository: process.cwd(),
  composeArguments: ['compose', '--env-file', process.argv[3]],
  command: (command, args) => execFileSync(command, args, { encoding: 'utf8' }),
});
"""


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, **options):
    return subprocess.run(args, check=True, timeout=20, **options)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def render(source, output, tag, commit, tree, env_sha256):
    return subprocess.run([
        sys.executable, "-I", "-B", source / "render.py", "--identity", IDENTITY,
        "--output", output, "--tag", tag, "--commit", commit, "--tree", tree,
        "--env-sha256", env_sha256,
    ], capture_output=True, text=True, timeout=10)


def files(directory):
    return {entry.name: entry.read_bytes() for entry in directory.iterdir()}


def exercise(source):
    os.umask(0o077)
    identity = json.loads(IDENTITY.read_bytes())
    tag = "trial-fixture"
    check(socket.gethostname() == SANDBOX_HOSTNAME and len({SANDBOX_HOSTNAME, identity["guest_hostname"], tag}) == 3,
          "fixture hostname collision")

    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        git_source = work / "origin"
        git_source.mkdir()

        def git(*args):
            return run("git", "-C", git_source, *args, capture_output=True, text=True).stdout.strip()

        git("init", "--initial-branch=main", "--object-format=sha1")
        mounts = git_source / "mounts"
        mounts.mkdir()
        (mounts / "payload.txt").write_text("fixture\n", encoding="utf-8")
        (mounts / "entry.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (mounts / "entry.sh").chmod(0o700)
        git("add", "--", "mounts")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture")
        bundle = work / "candidate.bundle"
        git("bundle", "create", bundle, "HEAD")
        commit, tree = git("rev-parse", "HEAD", "HEAD^{tree}").splitlines()

        original = Path(identity["original_env"])
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(b"MODEL=synthetic\n")
        support = Path(identity["guest_root"]) / tag
        check(not support.exists(), "fixture guest support already exists")
        repo = support / "source"
        commands = work / "bin"
        commands.mkdir()
        for name in ("ssh", "node", "docker", "systemctl", "qemu", "qemu-system-x86_64", "qemu-img",
                     "scp", "curl", "wget"):
            fake = commands / name
            fake.write_text((FIXTURES / "fake-command.py").read_text(encoding="utf-8"), encoding="utf-8")
            fake.chmod(0o700)
        real_node = shutil.which("node")
        env = {"PATH": f"{commands}:{os.environ['PATH']}"}
        ssh = [
            "-T", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", f"UserKnownHostsFile={identity['ssh_known_hosts']}",
            "-i", identity["ssh_key"], "-p", str(identity["guest_port"]),
            f"{identity['guest_user']}@{identity['guest_address']}", "hostname",
        ]
        capture = [
            "scripts/release/installer-stages.mjs", "preflight",
            "--env-file", str(original), "--project-name", identity["project"],
            "--capture-dev-preimages", str(support / "preimages.json"),
            "--dev-review-origin", identity["portal_origin"],
            "--dev-review-identity-origin", identity["identity_origin"],
        ]
        compose = ["compose", "--env-file", str(original), "config", "--format", "json"]
        (commands / "expected.json").write_text(json.dumps({
            "ssh": ssh, "capture": capture, "compose": compose, "hostname": identity["guest_hostname"],
        }), encoding="utf-8")

        packet = work / "absent" / "parent" / "packet"
        check(not packet.parent.exists(), "fixture dispatch parents exist")
        result = render(source, packet, tag, commit, tree, digest(original.read_bytes()))
        check(result.returncode == 0, "dispatch could not create the packet with absent parents\n" + result.stderr)
        check(stat.S_IMODE(packet.stat().st_mode) == 0o700, "packet directory is not private")

        def entry(name, *args):
            return subprocess.run(
                [sys.executable, "-I", "-B", packet / f"{name}.py", *args],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=15,
            )

        result = entry("dispatch")
        check(result.returncode == 0, result.stderr)
        try:
            result = entry("receive", bundle)
            check(result.returncode == 0, result.stderr)
            result = subprocess.run(
                [real_node, "--input-type=module", "-e", NATIVE_READABILITY, "readability-fixture",
                 HERE.parent / "release/installer-stages.mjs", original],
                cwd=repo, env=env, capture_output=True, text=True, timeout=20,
            )
            check(result.returncode == 0, result.stderr)
            check(stat.S_IMODE(support.stat().st_mode) == 0o700, "guest support directory is not private")
            check(stat.S_IMODE((repo / "mounts/payload.txt").stat().st_mode) == 0o644, "checkout data mode changed")
            check(stat.S_IMODE((repo / "mounts/entry.sh").stat().st_mode) == 0o755, "checkout executable mode changed")

            result = entry("probe")
            check(result.returncode == 0, "probe rejected the installed environment model\n" + result.stderr)
            receipt = support / "preimages.json"
            check(receipt.read_bytes() == b'{"captured": true}\n', "native capture receipt missing")
            check(stat.S_IMODE(receipt.stat().st_mode) == 0o600, "native capture receipt is not private")
            check(original.read_bytes() == b"MODEL=synthetic\n", "installed environment changed")
            (commands / "hang").touch()
            result = entry("probe")
            check(result.returncode != 0, "unbounded probe returned success")

            calls = [json.loads(line) for line in (commands / "calls.jsonl").read_text().splitlines()]
            expected = [
                ["ssh", *ssh], ["docker", *compose],
                ["node", *capture], ["docker", *compose], ["node", *capture], ["docker", "probe-hang"],
            ]
            check(calls[:-1] == expected and calls[-1][0] == "lock-owner", "unexpected calls or lock fixture did not start")
            owner = calls[-1][1]
            lock = subprocess.run(["flock", "--wait", "1", commands / "stage.lock", "true"], timeout=3)
            if lock.returncode:
                os.kill(owner, signal.SIGKILL)
                raise RuntimeError("probe timeout leaked the stage lock")
            check("native preflight timed out" in result.stderr, result.stderr)
        finally:
            if support.exists():
                shutil.rmtree(support)


class DryRunTest(unittest.TestCase):
    def test_golden_and_fixed_identity(self):
        with tempfile.TemporaryDirectory() as work:
            first, second = Path(work) / "one", Path(work) / "two"
            run_values = [
                ("trial-first", "1" * 40, "2" * 40, "3" * 64),
                ("trial-second", "4" * 40, "5" * 40, "6" * 64),
            ]
            expected_identity = json.loads(IDENTITY.read_bytes())
            invariant = []
            for output, values in zip((first, second), run_values, strict=True):
                result = render(HERE, output, *values)
                self.assertEqual(result.returncode, 0, result.stderr)
                emitted = files(output)
                self.assertEqual(emitted.pop("SHA256SUMS").decode(), "".join(
                    f"{digest(data)}  {name}\n" for name, data in sorted(emitted.items())
                ))
                expected_run = dict(zip(("tag", "commit", "tree", "env_sha256"), values, strict=True))
                expected_packet = {"identity": expected_identity, "run": expected_run}
                self.assertEqual(emitted.pop("packet.json"),
                                 (json.dumps(expected_packet, indent=2, sort_keys=True) + "\n").encode())
                invariant.append(emitted)
            self.assertEqual(invariant[0], invariant[1])
            golden = (FIXTURES / "golden.sha256").read_text(encoding="ascii")
            self.assertEqual((first / "SHA256SUMS").read_text(encoding="ascii"), golden)
            result = render(HERE, first, *run_values[1])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((first / "SHA256SUMS").read_text(encoding="ascii"), golden)

    def exercise_result(self, source):
        return subprocess.run(
            [sys.executable, "-I", "-B", __file__, "--exercise", source],
            capture_output=True, text=True, timeout=40,
        )

    def test_rendered_plumbing(self):
        result = self.exercise_result(HERE)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_historical_mutations_fail(self):
        mutations = (
            ("checkout umask", "templates/receive.py", "umask=checkout_umask,", "", 2,
             "repository bind-mount readability refusal"),
            ("dispatch mkdir", "render.py", "bundle.mkdir(parents=True, exist_ok=False)", "bundle.mkdir()", 1,
             "dispatch could not create the packet with absent parents"),
            ("guest hostname", "templates/dispatch.py", 'hostname != identity["guest_hostname"]',
             'hostname != packet["run"]["tag"]', 1, "guest hostname mismatch"),
            ("separate environment", "templates/probe.py", '"--env-file", str(original),',
             '"--env-file", str(support / "preflight.env"),', 1, "probe rejected the installed environment model"),
            ("orphaned lock", "templates/probe.py", "    with subprocess.Popen(",
             "    subprocess.run(argv, cwd=repo, env=environment, check=True, timeout=seconds)\n"
             "    return\n    with subprocess.Popen(", 1, "probe timeout leaked the stage lock"),
        )
        for label, name, before, after, count, diagnostic in mutations:
            with self.subTest(defect=label), tempfile.TemporaryDirectory() as work:
                source = Path(work) / "src"
                source.mkdir()
                shutil.copyfile(HERE / "render.py", source / "render.py")
                shutil.copytree(HERE / "templates", source / "templates")
                path = source / name
                text = path.read_text(encoding="utf-8")
                self.assertEqual(text.count(before), count)
                path.write_text(text.replace(before, after), encoding="utf-8")
                result = self.exercise_result(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(diagnostic, result.stderr)
                print(f"Mutation rejected: {label}", flush=True)


def container():
    subprocess.run([
        "docker", "run", "--rm", "--init", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
        "--hostname", SANDBOX_HOSTNAME, "--tmpfs", "/tmp:rw,exec,mode=1777",
        "--mount", f"type=bind,source={HERE.parent},target=/fixture/scripts,readonly",
        IMAGE, "python3", "-I", "-B", "/fixture/scripts/dev-install/test_dryrun.py",
    ], check=True, timeout=180)


if __name__ == "__main__":
    if sys.argv[1:] == ["--container"]:
        container()
    elif len(sys.argv) == 3 and sys.argv[1] == "--exercise":
        exercise(Path(sys.argv[2]))
    else:
        unittest.main(verbosity=2)
