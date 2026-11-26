#!/usr/bin/env python3
"""Exercise the rendered packet in a network-isolated Linux container."""

from contextlib import redirect_stdout
import hashlib
import io
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
import time
import unittest
from unittest import mock
from uuid import uuid4


HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
IDENTITY = FIXTURES / "identity.example.json"
IMAGE = "node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea"
SANDBOX_HOSTNAME = "sandbox.example.test"
SANDBOX_TIMEOUT = 120
CLEANUP_TIMEOUT = 20
CHILD_CHECKPOINTS = {
    f"DEV_DRYRUN_CHECKPOINT {phase}".encode("ascii"): phase
    for phase in (
        "suite-started", "golden-render", "dispatch-render", "dispatch-invoke",
        "step-controller-exit", "step-overlay-hold", "step-aged-hold", "step-marker-only",
        "step-missing-stop", "step-completion-digest", "step-held-lock", "step-replaced-lock",
        "step-handback", "step-overlay-admitted", "step-wrapper-descriptor", "step-wrapper-lock",
        "step-wrapper-reopen",
        "guest-prepare", "guest-render", "guest-receive", "guest-readability", "guest-receive-repeat",
        "guest-probe", "guest-probe-timeout", "guest-lock", "suite-passed", "suite-failed",
    )
}
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


def checkpoint(phase):
    print(f"DEV_DRYRUN_CHECKPOINT {phase}", flush=True)


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
        checkpoint("dispatch-render")
        packet = render_packet(source, work, tag, "1" * 40, "2" * 40, "3" * 64)
        checkpoint("dispatch-invoke")
        result = entry(packet, "dispatch", env)
        check(result.returncode == 0, result.stderr)
        check((commands / "calls.jsonl").read_text().splitlines() == [json.dumps(["ssh", *ssh])],
              "unexpected dispatcher calls")


def exercise_guest(source):
    checkpoint("guest-prepare")
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
        checkpoint("guest-render")
        packet = render_packet(source, work, tag, commit, tree, digest(original.read_bytes()))
        try:
            checkpoint("guest-receive")
            result = entry(packet, "receive", env)
            check(result.returncode == 0, result.stderr)
            checkpoint("guest-readability")
            result = subprocess.run(
                [real_node, "--input-type=module", "-e", NATIVE_READABILITY, "readability-fixture",
                 HERE.parent / "release/installer-stages.mjs", original],
                cwd=repo, env=env, capture_output=True, text=True, timeout=20,
            )
            check(result.returncode == 0, result.stderr)
            for child in ("", "inputs", "inputs/bin", "inputs/trust", "inputs/hosted", "private"):
                mode = (support / child).stat().st_mode
                check(stat.S_ISDIR(mode) and stat.S_IMODE(mode) == 0o700, f"guest support path is not private: {child}")
            checkpoint("guest-receive-repeat")
            result = entry(packet, "receive", env)
            check(result.returncode != 0 and "FileExistsError" in result.stderr, "guest support is not exclusive")
            check(stat.S_IMODE((repo / "mounts/payload.txt").stat().st_mode) == 0o644, "checkout data mode changed")
            check(stat.S_IMODE((repo / "mounts/entry.sh").stat().st_mode) == 0o755, "checkout executable mode changed")

            checkpoint("guest-probe")
            result = entry(packet, "probe", env)
            check(result.returncode == 0, "probe rejected the installed environment model\n" + result.stderr)
            check(receipt.read_bytes() == b'{"captured": true}\n', "native capture receipt missing")
            check(stat.S_IMODE(receipt.stat().st_mode) == 0o600, "native capture receipt is not private")
            check(original.read_bytes() == b"MODEL=synthetic\n", "installed environment changed")
            (commands / "hang").touch()
            checkpoint("guest-probe-timeout")
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
            checkpoint("guest-lock")
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
        stderr=subprocess.PIPE, text=True, timeout=50,
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


def host_step(work, shell, *args, clock="2000-01-01T00:00:00Z"):
    return subprocess.run(
        ["bash", "-c", r"""
date() {
    case "$2" in
        +%FT%TZ) printf '%s\n' "$DEV_STEP_FIXTURE_UTC" ;;
        '+%s%N %FT%TZ') printf '946684800000000000 %s\n' "$DEV_STEP_FIXTURE_UTC" ;;
        *) return 1 ;;
    esac
}
stat() { printf '%s\n' 'directory:0:700'; }
df() {
    printf '%s\n' VM_PREFLIGHT_REACHED >&2
    printf '%s\n' Avail 0
}
export -f date stat df
""" + shell, "host-step-fixture", *args],
        env={**os.environ, "DEV_STEP_LOCK": str(work / "active"), "DEV_STEP_FIXTURE_UTC": clock},
        capture_output=True, text=True, timeout=10,
    )


def assert_step_result(test, case, actual, expected):
    if actual != expected:
        checkpoint(case)
    test.assertEqual(actual, expected)


class DispatchTest(unittest.TestCase):
    def test_overlay_holds_after_controller_exit_until_verified_handback(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            templates = HERE / "templates"
            run_id = digest(json.dumps(["a" * 64, "b" * 64], separators=(",", ":")).encode())
            helper = work / "dev-step-lock.sh"
            for name in (helper.name, "host-maintenance.py", "frozen-disk.py"):
                shutil.copyfile(templates / name, work / name)
            (work / "active").touch()
            (work / "run-id").write_text("20000101T000000Z\n", encoding="ascii")
            (work / "host.env").write_text("export DIR=. ROOT_FLOOR_BYTES=1\n", encoding="ascii")
            controller = host_step(work, r"""
exec 7<"$DEV_STEP_LOCK"
flock -n -E 75 7 || exit $?
bash "$1" acquire "$2" install || exit $?
kill -KILL "$BASHPID"
""", helper, run_id)
            assert_step_result(self, "step-controller-exit", controller.returncode, -signal.SIGKILL)
            overlay = 'exec bash "$1" rollback "$2"'
            record_path = work / "active.run"
            record_bytes = record_path.read_bytes()
            record = json.loads(record_bytes)
            self.assertEqual((record["run_id"], record["step"], record["started_at"]),
                             (run_id, "install", "2000-01-01T00:00:00Z"))
            held = host_step(work, overlay, templates / "overlay-action.sh", work)
            assert_step_result(self, "step-overlay-hold", (held.returncode, held.stdout, held.stderr),
                               (75, f"HOLD_DEV_STEP_UNRESOLVED run_id={run_id}\n", ""))
            os.utime(record_path, ns=(1, 1))
            aged = host_step(work, overlay, templates / "overlay-action.sh", work, clock="2001-01-01T00:00:00Z")
            assert_step_result(self, "step-aged-hold", (aged.returncode, aged.stdout, aged.stderr), (75, held.stdout, ""))

            evidence = work / "evidence"
            evidence.mkdir(mode=0o700)
            clear = 'exec bash "$1" handback "$2" "$3"'

            def handback_refused(case):
                result = host_step(work, clear, helper, run_id, evidence)
                assert_step_result(self, case, (result.returncode, result.stdout), (75, "HOLD_DEV_STEP_HANDBACK\n"))
                self.assertEqual(record_path.read_bytes(), record_bytes)

            terminal = json.dumps({"run_id": run_id, "status": "terminal"}).encode()
            stop = json.dumps({"run_id": run_id, "status": "stopped"}).encode()
            (evidence / "terminal.json").write_bytes(terminal)
            handback_refused("step-marker-only")
            handback = json.dumps({
                "run_id": run_id, "released": True,
                "lock_device": record["lock_device"], "lock_inode": record["lock_inode"],
                "record_sha256": digest(record_bytes), "terminal_sha256": digest(terminal), "stop_sha256": digest(stop),
            }).encode()
            (evidence / "handback.json").write_bytes(handback)
            completion = evidence / "completion.json"
            completion.write_text(json.dumps({"run_id": run_id, "handback_sha256": digest(handback)}), encoding="ascii")
            handback_refused("step-missing-stop")
            (evidence / "stop.json").write_bytes(stop)
            completion.write_text(json.dumps({"run_id": run_id, "handback_sha256": "0" * 64}), encoding="ascii")
            handback_refused("step-completion-digest")
            completion.write_text(json.dumps({"run_id": run_id, "handback_sha256": digest(handback)}), encoding="ascii")

            same_lock_held = host_step(work, r"""
exec 7<"$DEV_STEP_LOCK"
flock -n -E 75 7 || exit $?
bash "$1" handback "$2" "$3"
# Keep the independent owner alive through the child call.
exit $?
""", helper, run_id, evidence)
            assert_step_result(self, "step-held-lock", (same_lock_held.returncode, same_lock_held.stdout),
                               (75, "HOLD_DEV_STEP_BUSY\n"))
            marker = work / "active"
            original = marker.with_suffix(".original")
            marker.rename(original)
            marker.touch()
            handback_refused("step-replaced-lock")
            original.replace(marker)
            cleared = host_step(work, clear, helper, run_id, evidence)
            assert_step_result(self, "step-handback", (cleared.returncode, cleared.stdout),
                               (0, "DEV_STEP_HANDBACK=PASS\n"))
            self.assertFalse(record_path.exists())
            admitted = host_step(work, overlay, templates / "overlay-action.sh", work)
            assert_step_result(self, "step-overlay-admitted", (admitted.returncode, admitted.stderr),
                               (1, "VM_PREFLIGHT_REACHED\n"))

    def test_maintenance_wrapper_keeps_lock_after_acquire_returns(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "active").touch()
            (work / "other").touch()
            helper = HERE / "templates" / "dev-step-lock.sh"
            run_id = "20000101T000000Z"
            for setup in ("", 'exec 7<"$DEV_STEP_LOCK"; ', 'exec 7<"$3"; flock -n -E 75 7; '):
                result = host_step(work, setup + 'exec bash "$1" acquire "$2" maintenance',
                                   helper, run_id, work / "other")
                assert_step_result(self, "step-wrapper-descriptor", (result.returncode, result.stdout),
                                   (75, "HOLD_DEV_STEP_DESCRIPTOR\n"))
            self.assertFalse((work / "active.run").exists())
            wrapper = host_step(work, r"""
exec 7<"$DEV_STEP_LOCK"
flock -n -E 75 7 || exit $?
bash "$1" acquire "$2" maintenance || exit $?
if flock -n "$DEV_STEP_LOCK" true; then exit 1; fi
if bash -c 'flock -n "$DEV_STEP_LOCK" true'; then exit 1; fi
exit 42
""", helper, run_id)
            assert_step_result(self, "step-wrapper-lock", (wrapper.returncode, wrapper.stdout), (42, ""))
            reopened = host_step(work, r"""
exec 7<"$DEV_STEP_LOCK"
flock -n -E 75 7 || exit $?
bash "$1" acquire "$2" maintenance
""", helper, run_id)
            assert_step_result(self, "step-wrapper-reopen", (reopened.returncode, reopened.stdout),
                               (75, f"HOLD_DEV_STEP_UNRESOLVED run_id={run_id}\n"))

    def test_golden_and_fixed_identity(self):
        checkpoint("golden-render")
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


def sandbox_log(suite, message):
    print(f"DEV dry-run {suite}: {message}", flush=True)


def report_checkpoints(suite, output):
    phases = [CHILD_CHECKPOINTS[line] for line in (output or b"").splitlines() if line in CHILD_CHECKPOINTS]
    sandbox_log(suite, "child " + (" ".join(phases[-12:]) if phases else "no checkpoint"))


class DockerPhaseTimeout(RuntimeError):
    pass


def docker_phase(suite, phase, deadline, *args):
    started = time.monotonic()
    sandbox_log(suite, f"{phase} started")
    outcome = "error"
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            outcome = "deadline exceeded"
            raise RuntimeError(f"{suite}: {phase} deadline exceeded")
        result = subprocess.run(
            ["docker", *args], timeout=remaining,
            stdout=subprocess.PIPE if phase == "start-attach" else subprocess.DEVNULL,
            stderr=subprocess.PIPE if phase == "cleanup" else subprocess.DEVNULL,
        )
        if phase == "start-attach":
            report_checkpoints(suite, result.stdout)
        outcome = f"exit={result.returncode}"
        return result
    except subprocess.TimeoutExpired as error:
        if phase == "start-attach":
            report_checkpoints(suite, error.output)
        outcome = "deadline exceeded"
        raise DockerPhaseTimeout(f"{suite}: {phase} deadline exceeded") from None
    except OSError:
        raise RuntimeError(f"{suite}: {phase} could not run Docker") from None
    finally:
        sandbox_log(suite, f"{phase} {outcome} elapsed_ms={int((time.monotonic() - started) * 1000)}")


def cleanup_sandbox(suite, name, create_timed_out):
    deadline = time.monotonic() + CLEANUP_TIMEOUT
    absent = f"Error response from daemon: No such container: {name}".encode()
    try:
        while time.monotonic() < deadline:
            cleanup = docker_phase(suite, "cleanup", deadline, "rm", "--force", "--volumes", name)
            # Forced removal can exit successfully while reporting an absent container.
            if cleanup.stderr.strip() != absent:
                if cleanup.returncode == 0:
                    sandbox_log(suite, "cleanup removed")
                else:
                    sandbox_log(suite, "cleanup unconfirmed" if create_timed_out else "cleanup failed")
                return
            if not create_timed_out:
                sandbox_log(suite, "cleanup container absent")
                return
            # The daemon may still register the name after the create client exits.
            time.sleep(max(0, min(1, deadline - time.monotonic())))
    except RuntimeError:
        pass
    sandbox_log(suite, "cleanup unconfirmed")


def sandbox(hostname, suite):
    deadline = time.monotonic() + SANDBOX_TIMEOUT
    image = docker_phase(suite, "image-check", deadline, "image", "inspect", IMAGE)
    if image.returncode:
        pull = docker_phase(suite, "pull", deadline, "pull", IMAGE)
        check(pull.returncode == 0, f"{suite}: pull failed")

    name = f"wasalx-dev-dryrun-{uuid4().hex}"
    create = None
    create_timed_out = False
    removed = False
    try:
        create = docker_phase(
            suite, "create", deadline, "create", "--name", name, "--pull", "never",
            "--rm", "--init", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
            "--hostname", hostname, "--tmpfs", "/tmp:rw,exec,mode=1777",
            "--tmpfs", "/home:rw,uid=65534,gid=65534,mode=0700",
            "--mount", f"type=bind,source={HERE.parent},target=/fixture/scripts,readonly",
            IMAGE, "python3", "-I", "-B", "/fixture/scripts/dev-install/test_dryrun.py", suite,
        )
        check(create.returncode == 0, f"{suite}: create failed")
        start = docker_phase(suite, "start-attach", deadline, "start", "--attach", name)
        check(start.returncode == 0, f"{suite}: start-attach failed")
        # Attached start with --rm waits for the daemon's removal result.
        removed = True
        sandbox_log(suite, "cleanup auto-removed")
    except DockerPhaseTimeout:
        create_timed_out = create is None
        raise
    finally:
        if not removed:
            cleanup_sandbox(suite, name, create_timed_out)


class SandboxTest(unittest.TestCase):
    def test_cold_image_and_attached_start_share_the_deadline(self):
        elapsed = 0
        output = io.StringIO()
        phases = iter(((1, 1), (82, 0), (5, 0), (4, 0)))

        def run_docker(args, **options):
            nonlocal elapsed
            duration, status = next(phases)
            elapsed += duration
            return subprocess.CompletedProcess(args, status, stdout=b"DEV_DRYRUN_CHECKPOINT suite-passed\n")

        with (
            redirect_stdout(output),
            mock.patch.object(time, "monotonic", side_effect=lambda: elapsed),
            mock.patch.object(subprocess, "run", side_effect=run_docker) as docker,
        ):
            sandbox(SANDBOX_HOSTNAME, "DispatchTest")
        inspect, pull, create, start = docker.call_args_list
        self.assertEqual([call.kwargs["timeout"] for call in docker.call_args_list], [120, 119, 37, 32])
        self.assertEqual(inspect.args[0], ["docker", "image", "inspect", IMAGE])
        self.assertEqual(pull.args[0], ["docker", "pull", IMAGE])
        create_args = create.args[0]
        name = create_args[3]
        self.assertEqual(create_args[:3], ["docker", "create", "--name"])
        self.assertEqual(create_args[4:], [
            "--pull", "never", "--rm", "--init", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
            "--hostname", SANDBOX_HOSTNAME, "--tmpfs", "/tmp:rw,exec,mode=1777",
            "--tmpfs", "/home:rw,uid=65534,gid=65534,mode=0700",
            "--mount", f"type=bind,source={HERE.parent},target=/fixture/scripts,readonly",
            IMAGE, "python3", "-I", "-B", "/fixture/scripts/dev-install/test_dryrun.py", "DispatchTest",
        ])
        self.assertEqual(start.args[0], ["docker", "start", "--attach", name])
        self.assertIn("child suite-passed", output.getvalue())
        self.assertIn("cleanup auto-removed", output.getvalue())

    def test_create_or_attach_timeout_attempts_owned_cleanup_with_safe_output(self):
        for phase in ("create", "start-attach"):
            with self.subTest(phase=phase):
                timeout = subprocess.TimeoutExpired(
                    ["docker", "raw-command-marker"], SANDBOX_TIMEOUT,
                    output=b"DEV_DRYRUN_CHECKPOINT dispatch-invoke\nDEV_DRYRUN_CHECKPOINT raw-output-marker\n",
                )
                results = [mock.Mock(returncode=0)]  # Local image hit.
                if phase == "start-attach":
                    results.append(mock.Mock(returncode=0))
                results.extend((timeout, mock.Mock(returncode=0, stderr=b"")))
                output = io.StringIO()
                with (
                    redirect_stdout(output),
                    mock.patch.object(time, "monotonic", return_value=1),
                    mock.patch.object(subprocess, "run", side_effect=results) as docker,
                ):
                    with self.assertRaisesRegex(RuntimeError, f"DispatchTest: {phase} deadline exceeded"):
                        sandbox(SANDBOX_HOSTNAME, "DispatchTest")
                name = docker.call_args_list[1].args[0][3]
                self.assertEqual(docker.call_args.args[0], ["docker", "rm", "--force", "--volumes", name])
                self.assertEqual(docker.call_args.kwargs["timeout"], CLEANUP_TIMEOUT)
                self.assertIn("cleanup removed", output.getvalue())
                self.assertNotIn("raw-", output.getvalue())
                if phase == "start-attach":
                    self.assertIn("child dispatch-invoke", output.getvalue())

    def test_failed_suite_remains_failed_if_cleanup_times_out(self):
        output = io.StringIO()
        results = [
            mock.Mock(returncode=0), mock.Mock(returncode=0),
            mock.Mock(returncode=1, stdout=b"DEV_DRYRUN_CHECKPOINT suite-failed\n"),
            subprocess.TimeoutExpired(["docker", "rm"], CLEANUP_TIMEOUT),
        ]
        with redirect_stdout(output), mock.patch.object(subprocess, "run", side_effect=results):
            with self.assertRaisesRegex(RuntimeError, "DispatchTest: start-attach failed"):
                sandbox(SANDBOX_HOSTNAME, "DispatchTest")
        self.assertIn("child suite-failed", output.getvalue())
        self.assertIn("cleanup deadline exceeded", output.getvalue())

    def test_timed_out_create_checks_for_late_registration(self):
        for appears in (True, False):
            with self.subTest(appears=appears):
                elapsed = 0
                removals = 0
                output = io.StringIO()

                def sleep(seconds):
                    nonlocal elapsed
                    elapsed += seconds

                def run_docker(args, **options):
                    nonlocal removals
                    if args[1] == "image":
                        return subprocess.CompletedProcess(args, 0)
                    if args[1] == "create":
                        sleep(options["timeout"])
                        raise subprocess.TimeoutExpired(args, options["timeout"])
                    removals += 1
                    if appears and removals == 2:
                        return subprocess.CompletedProcess(args, 0, stderr=b"")
                    absent = f"Error response from daemon: No such container: {args[-1]}".encode()
                    return subprocess.CompletedProcess(args, 0, stderr=absent)

                with (
                    redirect_stdout(output),
                    mock.patch.object(time, "monotonic", side_effect=lambda: elapsed),
                    mock.patch.object(time, "sleep", side_effect=sleep),
                    mock.patch.object(subprocess, "run", side_effect=run_docker) as docker,
                ):
                    with self.assertRaisesRegex(RuntimeError, "DispatchTest: create deadline exceeded"):
                        sandbox(SANDBOX_HOSTNAME, "DispatchTest")
                _, create, *cleanup = docker.call_args_list
                name = create.args[0][3]
                self.assertTrue(all(call.args[0] == ["docker", "rm", "--force", "--volumes", name] for call in cleanup))
                expected_attempts = 2 if appears else CLEANUP_TIMEOUT
                self.assertEqual(
                    [call.kwargs["timeout"] for call in cleanup],
                    list(range(CLEANUP_TIMEOUT, CLEANUP_TIMEOUT - expected_attempts, -1)),
                )
                self.assertNotIn("cleanup container absent", output.getvalue())
                self.assertIn("cleanup removed" if appears else "cleanup unconfirmed", output.getvalue())


def container():
    identity = json.loads(IDENTITY.read_bytes())
    sandbox(SANDBOX_HOSTNAME, "DispatchTest")
    sandbox(identity["expected_hostname"], "GuestTest")


if __name__ == "__main__":
    if sys.argv[1:] == ["--container"]:
        if not unittest.main(argv=[sys.argv[0], "SandboxTest"], verbosity=2, exit=False).result.wasSuccessful():
            sys.exit(1)
        try:
            container()
        except RuntimeError as error:
            sys.exit(str(error))
    elif len(sys.argv) == 3 and sys.argv[1] == "--exercise-dispatch":
        exercise_dispatch(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--exercise-guest":
        exercise_guest(Path(sys.argv[2]))
    elif sys.argv[1:] in (["DispatchTest"], ["GuestTest"]):
        checkpoint("suite-started")
        result = unittest.main(verbosity=2, exit=False).result
        checkpoint("suite-passed" if result.wasSuccessful() else "suite-failed")
        sys.exit(not result.wasSuccessful())
    else:
        unittest.main(verbosity=2)
