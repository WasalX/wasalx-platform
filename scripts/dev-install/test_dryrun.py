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


def fakes(work, expected):
    commands = work / "bin"
    commands.mkdir()
    stub = (FIXTURES / "fake-command.py").read_text(encoding="utf-8")
    for name in ("ssh", "node", "docker", "systemctl", "qemu", "qemu-system-x86_64", "qemu-img",
                 "scp", "curl", "wget"):
        fake = commands / name
        fake.write_text(stub, encoding="utf-8")
        fake.chmod(0o700)
    (commands / "expected.json").write_text(json.dumps(expected), encoding="utf-8")
    return commands, {"PATH": f"{commands}:{os.environ['PATH']}"}


def render_packet(source, work, tag, commit, tree, env_sha256):
    packet = work / "absent" / "parent" / "packet"
    check(not packet.parent.exists(), "fixture dispatch parents exist")
    result = render(source, packet, tag, commit, tree, env_sha256)
    check(result.returncode == 0, "dispatch could not create the packet with absent parents\n" + result.stderr)
    check(stat.S_IMODE(packet.stat().st_mode) == 0o700, "packet directory is not private")
    return packet


def entry(packet, name, env):
    return subprocess.run(
        [sys.executable, "-I", "-B", packet / f"{name}.py"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=20,
    )


def exercise_dispatch(source):
    os.umask(0o077)
    identity = json.loads(IDENTITY.read_bytes())
    tag = "20000101-fixture"
    check(socket.gethostname() == SANDBOX_HOSTNAME and len({SANDBOX_HOSTNAME, identity["expected_hostname"], tag}) == 3,
          "fixture hostname collision")
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        ssh = [
            "-T", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", f"UserKnownHostsFile={identity['ssh_known_hosts']}",
            "-i", identity["ssh_key"], "-p", str(identity["guest_port"]),
            f"{identity['guest_user']}@{identity['guest_address']}", "hostname",
        ]
        commands, env = fakes(work, {"ssh": ssh, "hostname": identity["expected_hostname"]})
        packet = render_packet(source, work, tag, "1" * 40, "2" * 40, "3" * 64)
        result = entry(packet, "dispatch", env)
        check(result.returncode == 0, result.stderr)
        check((commands / "calls.jsonl").read_text().splitlines() == [json.dumps(["ssh", *ssh])],
              "unexpected dispatcher calls")


def exercise_guest(source):
    os.umask(0o077)
    identity = json.loads(IDENTITY.read_bytes())
    tag = "20000101-fixture"
    check(socket.gethostname() == identity["expected_hostname"], "guest fixture hostname mismatch")
    home = Path("/home") / identity["guest_user"]
    home.mkdir(mode=0o700, exist_ok=True)

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
        bundle = home / f"signed-{tag}-dev-incoming-source.bundle"
        check(not bundle.exists(), "fixture incoming bundle already exists")
        git("bundle", "create", bundle, "HEAD")
        commit, tree = git("rev-parse", "HEAD", "HEAD^{tree}").splitlines()

        original = Path(identity["original_env"])
        original.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(b"MODEL=synthetic\n")
        support = home / f"dev-signed-{tag}-dev"
        check(not support.exists(), "fixture guest support already exists")
        repo = support / "source"
        real_node = shutil.which("node")
        receipt = support / "private/preimages.json"
        capture = [
            "scripts/release/installer-stages.mjs", "preflight",
            "--env-file", str(original), "--project-name", identity["project"],
            "--capture-dev-preimages", str(receipt),
            "--dev-review-origin", identity["portal_origin"],
            "--dev-review-identity-origin", identity["identity_origin"],
        ]
        compose = ["compose", "--env-file", str(original), "config", "--format", "json"]
        commands, env = fakes(work, {
            "capture": capture, "compose": compose, "real_node": real_node,
            "native_probe": str(FIXTURES / "native-probe.mjs"),
            "probe_env": {"HOME": identity["probe_home"], "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0"},
        })
        packet = render_packet(source, work, tag, commit, tree, digest(original.read_bytes()))
        try:
            result = entry(packet, "receive", env)
            check(result.returncode == 0, result.stderr)
            result = subprocess.run(
                [real_node, "--input-type=module", "-e", NATIVE_READABILITY, "readability-fixture",
                 HERE.parent / "release/installer-stages.mjs", original],
                cwd=repo, env=env, capture_output=True, text=True, timeout=20,
            )
            check(result.returncode == 0, result.stderr)
            for child in ("", "inputs", "inputs/bin", "inputs/trust", "inputs/hosted", "private"):
                mode = (support / child).stat().st_mode
                check(stat.S_ISDIR(mode) and stat.S_IMODE(mode) == 0o700, f"guest support path is not private: {child}")
            result = entry(packet, "receive", env)
            check(result.returncode != 0 and "FileExistsError" in result.stderr, "guest support is not exclusive")
            check(stat.S_IMODE((repo / "mounts/payload.txt").stat().st_mode) == 0o644, "checkout data mode changed")
            check(stat.S_IMODE((repo / "mounts/entry.sh").stat().st_mode) == 0o755, "checkout executable mode changed")

            result = entry(packet, "probe", env)
            check(result.returncode == 0, "probe rejected the installed environment model\n" + result.stderr)
            check(receipt.read_bytes() == b'{"captured": true}\n', "native capture receipt missing")
            check(stat.S_IMODE(receipt.stat().st_mode) == 0o600, "native capture receipt is not private")
            check(original.read_bytes() == b"MODEL=synthetic\n", "installed environment changed")
            (commands / "hang").touch()
            result = entry(packet, "probe", env)
            check(result.returncode != 0, "unbounded probe returned success")

            calls = [json.loads(line) for line in (commands / "calls.jsonl").read_text().splitlines()]
            expected = [
                ["docker", *compose], ["node", *capture], ["docker", *compose], ["node", *capture],
            ]
            check(calls[:-1] == expected and calls[-1][0] == "lock-owner", "unexpected calls or lock fixture did not start")
            owner = calls[-1][1]
            lock_config = HERE.parent / "release/compose-stage-config.json"
            lock_path = json.loads(lock_config.read_bytes())["lockPath"]
            lock = subprocess.run(["flock", "--wait", "1", lock_path, "true"], timeout=3)
            if lock.returncode:
                os.kill(owner, signal.SIGKILL)
                raise RuntimeError("probe timeout leaked the stage lock")
            check("native preflight timed out" in result.stderr, result.stderr)
        finally:
            bundle.unlink()
            if support.exists():
                shutil.rmtree(support)


def exercise_result(stage, source):
    return subprocess.run(
        [sys.executable, "-I", "-B", __file__, f"--exercise-{stage}", source],
        capture_output=True, text=True, timeout=50,
    )


def assert_mutations(test, stage, mutations):
    for label, name, before, after, count, diagnostic in mutations:
        with test.subTest(defect=label), tempfile.TemporaryDirectory() as work:
            source = Path(work) / "src"
            source.mkdir()
            shutil.copyfile(HERE / "render.py", source / "render.py")
            shutil.copytree(HERE / "templates", source / "templates")
            path = source / name
            text = path.read_text(encoding="utf-8")
            test.assertEqual(text.count(before), count)
            path.write_text(text.replace(before, after), encoding="utf-8")
            result = exercise_result(stage, source)
            test.assertNotEqual(result.returncode, 0)
            test.assertIn(diagnostic, result.stderr)
            print(f"Mutation rejected: {label}", flush=True)


class DispatchTest(unittest.TestCase):
    def test_golden_and_fixed_identity(self):
        with tempfile.TemporaryDirectory() as work:
            first, second = Path(work) / "one", Path(work) / "two"
            run_values = [
                ("20000101-first", "1" * 40, "2" * 40, "3" * 64),
                ("20000101-second", "4" * 40, "5" * 40, "6" * 64),
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

    def test_rendered_plumbing(self):
        result = exercise_result("dispatch", HERE)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_historical_mutations_fail(self):
        assert_mutations(self, "dispatch", (
            ("dispatch mkdir", "render.py", "bundle.mkdir(parents=True, exist_ok=False)", "bundle.mkdir()", 1,
             "dispatch could not create the packet with absent parents"),
            ("guest hostname", "templates/dispatch.py", 'hostname != identity["expected_hostname"]',
             'hostname != packet["run"]["tag"]', 1, "guest hostname mismatch"),
        ))


class GuestTest(unittest.TestCase):
    def test_rendered_plumbing(self):
        result = exercise_result("guest", HERE)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_historical_mutations_fail(self):
        assert_mutations(self, "guest", (
            ("checkout umask", "templates/receive.py", "umask=checkout_umask,", "", 2,
             "repository bind-mount readability refusal"),
            ("separate environment", "templates/probe.py", '"--env-file", str(original),',
             '"--env-file", str(support / "preflight.env"),', 1, "probe rejected the installed environment model"),
            ("orphaned lock", "templates/probe.py", '["timeout", "-k", "5s", f"{seconds}s", *argv],',
             "argv, timeout=seconds,", 1, "probe timeout leaked the stage lock"),
            ("missing hostname environment", "templates/probe.py",
             '        "WASALX_INSTALL_EXPECTED_HOSTNAME": identity["expected_hostname"],\n', "", 1,
             "WASALX_INSTALL_EXPECTED_HOSTNAME is required"),
        ))


def container():
    identity = json.loads(IDENTITY.read_bytes())
    for hostname, suite in [(SANDBOX_HOSTNAME, "DispatchTest"), (identity["expected_hostname"], "GuestTest")]:
        subprocess.run([
            "docker", "run", "--rm", "--init", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
            "--hostname", hostname, "--tmpfs", "/tmp:rw,exec,mode=1777",
            "--tmpfs", "/home:rw,uid=65534,gid=65534,mode=0700",
            "--mount", f"type=bind,source={HERE.parent},target=/fixture/scripts,readonly",
            IMAGE, "python3", "-I", "-B", "/fixture/scripts/dev-install/test_dryrun.py", suite,
        ], check=True, timeout=120)


if __name__ == "__main__":
    if sys.argv[1:] == ["--container"]:
        container()
    elif len(sys.argv) == 3 and sys.argv[1] == "--exercise-dispatch":
        exercise_dispatch(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--exercise-guest":
        exercise_guest(Path(sys.argv[2]))
    else:
        unittest.main(verbosity=2)
