"""Real Bash lifecycle with fixture-local CLI doubles; no Docker or host mutation."""
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path

os.environ["WASALX_RELEASE_EVIDENCE_SCRIPT"] = "fixture-release-evidence.mjs"

ROOT = Path(__file__).resolve().parents[1]
SHA = "a" * 40
ID = "b" * 64
STUB = """#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
kind=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
root=pathlib.Path(os.environ['FIXTURE'])
mode=os.environ['MODE']
with (root/'owned-pids').open('a') as log:
    stat=pathlib.Path(f'/proc/{os.getpid()}/stat').read_text().split()
    log.write(json.dumps([os.getpid(),stat[21]])+'\\n')

def mark_ready():
    pending=root/'ready.tmp'
    pending.write_text(f'{os.getpid()}\\n')
    pending.replace(root/'ready')

if kind=='timeout':
    if args[:2]==['--kill-after=2s','25m']:
        (root/'payload-timeout').write_text(json.dumps(args))
        if mode.startswith('timeout-'): args[1]='0.5s'
    os.execv(os.environ['REAL_TIMEOUT'], [os.environ['REAL_TIMEOUT'],*args])
with (root/'calls').open('a') as log: log.write(json.dumps([kind,*args])+'\\n')
if kind=='python3':
    if args[0]=='-': os.execv(sys.executable, [sys.executable,*args])
    count=int((root/'guards').read_text())+1 if (root/'guards').exists() else 1
    (root/'guards').write_text(str(count))
    sys.exit(1 if mode==f'deny{count}' else 0)
if kind=='node':
    (root/'payload-env').write_text(json.dumps({key:os.environ.get(key) for key in ('DATABASE_ADMIN_URL','DATABASE_APP_URL')}))
    if mode=='interrupt':
        # Signal the step Bash, not the timeout monitor racing payload success.
        status=pathlib.Path(f'/proc/{os.getppid()}/status').read_text()
        parent=int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
        os.kill(parent, signal.SIGTERM)
    if mode.startswith('cancel-'):
        if mode=='cancel-resistant': signal.signal(signal.SIGTERM, signal.SIG_IGN)
        mark_ready()
        time.sleep(30)
    if mode.startswith('timeout-'):
        if mode=='timeout-kill': signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(5)
    sys.exit(7 if mode=='payload' else 0)
if args[0]=='create':
    if mode=='collision': sys.exit(1)
    (root/'container').write_text('owned')
    if mode=='cancel-create':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        mark_ready()
        time.sleep(30)
    if mode=='create-no-cid': sys.exit(1)
    pathlib.Path(args[args.index('--cidfile')+1]).write_text('b'*64)
    if mode=='interrupt-create':
        status=pathlib.Path(f'/proc/{os.getppid()}/status').read_text()
        parent=int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
        os.kill(parent, 15)
elif args[0]=='inspect':
    identity='foreign' if mode=='foreign' else 'b'*64+'|/wasalx-ci-postgres-1-2-postgres|postgres:17.12-alpine3.23@sha256:57a828ad76b719bbed499fc30f71754bbe37d78c8c4c990a1a2096380b8d7ca5|1-2-postgres|'+'a'*40
    if mode.startswith('cancel-wrong-') and (root/'ready').exists():
        fields=identity.split('|')
        fields[{'id':0,'name':1,'image':2,'owner':3,'sha':4}[mode.removeprefix('cancel-wrong-')]]='foreign'
        identity='|'.join(fields)
    if 'NetworkSettings.Ports' in args[2]:
        if mode=='port-inspect': sys.exit(1)
        binding={'HostIp':'127.0.0.1','HostPort':'40047'}
        if mode=='port-address': binding['HostIp']='0.0.0.0'
        if mode=='port-missing': del binding['HostPort']
        for suffix,value in [('zero','0'),('range','65536'),('text','oops'),('leading-zero','040047'),('type',40047)]:
            if mode=='port-'+suffix: binding['HostPort']=value
        bindings=[] if mode=='port-empty' else [binding,binding] if mode=='port-multiple' else None if mode=='port-null' else [binding]
        print(identity+'|'+json.dumps(bindings))
    elif 'Labels' in args[2]:
        print(identity)
    else: print('unhealthy' if mode=='health' else 'healthy')
elif args[0]=='exec':
    settings=['off','off','off']
    for index,name in enumerate(('fsync','synchronous_commit','full_page_writes')):
        if mode==f'durability-{name}': settings[index]='on'
    print('|'.join(settings))
elif args[0]=='rm':
    if mode=='cancel-gated-cleanup':
        gate=int(os.environ['CLEANUP_GATE_FD'])
        os.write(gate, b'R')
        if os.read(gate, 1)!=b'G': sys.exit(1)
    if mode=='cancel-slow-cleanup':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(30)
    if mode in ('cleanup','timeout-cleanup'): sys.exit(1)
    (root/'container').unlink()
elif args[0]=='ps':
    if (root/'container').exists(): print('b'*64)
    elif 'name=' in args[-1] and mode=='collision': print('c'*64)
    elif 'id=' in args[-1]:
        if mode=='scan': sys.exit(1)
        if mode=='residue': print('b'*64)
"""


@unittest.skipUnless(os.name == "posix", "Requires the real Linux Bash lifecycle")
class PostgresLifecycle(unittest.TestCase):
    def release_cleanup_after_old_watchdog(self, process, gate):
        self.assertEqual(gate.recv(1), b"R", "owned cleanup must reach the gate")
        # Keep the runtime blocked past the old three-second watchdog.
        with self.assertRaises(subprocess.TimeoutExpired):
            process.wait(timeout=3.25)
        gate.sendall(b"G")

    def run_fixture(self, mode, environment=None, external_signal=None):
        with (
            tempfile.TemporaryDirectory(prefix="wasalx-postgres-test-") as directory,
            ExitStack() as resources,
        ):
            root = Path(directory)
            (root / "bin").mkdir()
            for name in ("docker", "python3", "node", "timeout"):
                tool = root / "bin" / name
                tool.write_text(STUB.replace("#!/usr/bin/env python3", f"#!{shutil.which('python3')}"))
                tool.chmod(0o755)
            env = {**os.environ, "PATH": str(root / "bin") + ":" + os.environ["PATH"],
                   "FIXTURE": str(root), "RUNNER_TEMP": str(root), "MODE": mode, "REAL_TIMEOUT": shutil.which("timeout"), "GITHUB_SHA": SHA, "GITHUB_RUN_ID": "1",
                   "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "postgres",
                   "DATABASE_ADMIN_URL": "postgresql://admin:admin%3Apass@127.0.0.1:5432/admin_fixture?sslmode=disable&application_name=ci%20admin",
                   "DATABASE_APP_URL": "postgresql://app:app%40pass@127.0.0.1:5433/app_fixture?options=-c%20statement_timeout%3D5000",
                   **(environment or {})}
            # Exercise the actual exec Bash step PID, not a self-signalling child.
            test_bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else "/usr/bin/bash"
            env["WASALX_TEST_BASH"] = test_bash
            runtime = ROOT / "scripts/release/ci-postgres-runtime.sh"
            command = [test_bash, "--noprofile", "--norc", "-c", 'exec "$WASALX_TEST_BASH" "$@"', "wasalx-postgres-test",
                       str(runtime), "node", "fixture-release-evidence.mjs",
                       "run", "--gate", "postgres", "--candidate-sha", SHA]
            (root / "foreign-container").write_text("another-job")
            if external_signal is None:
                result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=40)
            else:
                ready = root / "ready"
                (root / "owned-pids").touch()
                signal_name = signal.Signals(external_signal).name.removeprefix("SIG")
                budget = re.search(
                    rf"^trap 'cancel \d+ (\d+)' {signal_name}$",
                    runtime.read_text(),
                    re.MULTILINE,
                )
                self.assertIsNotNone(budget, f"{signal_name}: missing runtime cleanup budget")
                # The Docker budget excludes signal delivery and final scratch removal.
                watchdog_seconds = int(budget[1]) / 1_000 + 0.5

                gate = None
                pass_fds = ()
                if mode == "cancel-gated-cleanup":
                    gate, child_gate = socket.socketpair()
                    resources.enter_context(gate)
                    resources.enter_context(child_gate)
                    gate.settimeout(watchdog_seconds)
                    pass_fds = (child_gate.fileno(),)
                    env["CLEANUP_GATE_FD"] = str(child_gate.fileno())
                process = subprocess.Popen(
                    command,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                    pass_fds=pass_fds,
                )
                if gate is not None:
                    child_gate.close()
                child_pid = None
                try:
                    deadline = time.monotonic() + 10
                    while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(ready.exists(), f"{mode}: owned child did not publish its PID before exit or the 10s readiness deadline")
                    pid_line = ready.read_text()
                    self.assertRegex(pid_line, r"\A[1-9][0-9]*\n\Z", f"{mode}: readiness must contain one complete PID line")
                    child_pid = int(pid_line)
                    os.kill(child_pid, 0)
                    started = time.monotonic()
                    os.kill(process.pid, external_signal)
                    release = None
                    if gate is not None:
                        executor = resources.enter_context(ThreadPoolExecutor(max_workers=1))
                        release = executor.submit(self.release_cleanup_after_old_watchdog, process, gate)
                    try:
                        stdout, stderr = process.communicate(timeout=watchdog_seconds)
                    except subprocess.TimeoutExpired:
                        self.fail(
                            f"{mode}: SIG{signal_name} runtime exit watchdog expired "
                            f"after {watchdog_seconds:g}s"
                        )
                    cancel_seconds = time.monotonic() - started
                    if release is not None:
                        release.result()
                finally:
                    # Observe the implementation before the watchdog can repair it.
                    try:
                        child_remaining = child_pid is not None and Path(f"/proc/{child_pid}/stat").read_text().split()[2] != "Z"
                    except FileNotFoundError:
                        child_remaining = False
                    # Test-local watchdog: only exact PIDs born in this fixture.
                    for line in (root / "owned-pids").read_text().splitlines():
                        pid, birth = json.loads(line)
                        try:
                            if Path(f"/proc/{pid}/stat").read_text().split()[21] == birth:
                                os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        except FileNotFoundError:
                            pass
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=3)
                    process.stdout.close()
                    process.stderr.close()
                result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                result.cancel_seconds = cancel_seconds
                result.child_remaining = child_remaining
            self.assertEqual((root / "foreign-container").read_text(), "another-job")
            self.assertEqual(list(root.glob("wasalx-ci-postgres.*")), [], "owned scratch must settle")
            result.payload_environment = json.loads((root / "payload-env").read_text()) if (root / "payload-env").exists() else None
            result.payload_timeout = json.loads((root / "payload-timeout").read_text()) if (root / "payload-timeout").exists() else None
            result.container_remaining = (root / "container").exists()
            return result, [json.loads(line) for line in (root / "calls").read_text().splitlines()]

    def test_guard_precedes_create_start_and_unchanged_gate(self):
        result, calls = self.run_fixture("pass")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call[0] for call in calls], ["python3", "docker", "docker", "python3", "docker", "docker", "docker", "docker", "python3", "python3", "node", "docker", "docker", "docker"])
        self.assertEqual(calls[10], ["node", "fixture-release-evidence.mjs", "run", "--gate", "postgres", "--candidate-sha", SHA])
        self.assertEqual(result.payload_timeout, ["--kill-after=2s", "25m", *calls[10]])
        self.assertFalse(result.container_remaining)
        create = calls[2]
        self.assertEqual(create[-7:], ["postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"])
        self.assertEqual(calls[6][1:3], ["exec", ID])
        for setting in ("fsync", "synchronous_commit", "full_page_writes"):
            self.assertIn(f"current_setting('{setting}')", calls[6][-1])
        for option in ("127.0.0.1::5432", "1g", "pg_isready -h 127.0.0.1 -U postgres -d wasalx_ci", "20", "5s"):
            self.assertIn(option, create)
        self.assertEqual(calls[7][-1], ID)
        self.assertIn('NetworkSettings.Ports "5432/tcp"', calls[7][3])
        self.assertEqual(result.payload_environment, {
            "DATABASE_ADMIN_URL": "postgresql://admin:admin%3Apass@127.0.0.1:40047/admin_fixture?sslmode=disable&application_name=ci%20admin",
            "DATABASE_APP_URL": "postgresql://app:app%40pass@127.0.0.1:40047/app_fixture?options=-c%20statement_timeout%3D5000",
        })
        self.assertEqual(calls[-2], ["docker", "rm", "--force", ID])

    def test_denied_phases_and_collision_do_not_launch_payload(self):
        for mode in ("deny1", "deny2", "deny3", "collision", "health", "durability-fsync", "durability-synchronous_commit", "durability-full_page_writes"):
            result, calls = self.run_fixture(mode)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(any(call[0] == "node" for call in calls))
            if mode in ("deny1", "collision"):
                self.assertFalse(any(call[1:2] == ["rm"] for call in calls))
            else:
                self.assertIn(["docker", "rm", "--force", ID], calls)

    def test_failures_and_interrupt_cleanup_only_owned_container(self):
        for mode in ("payload", "interrupt", "interrupt-create", "create-no-cid", "cleanup", "scan", "residue", "foreign"):
            with self.subTest(mode=mode):
                result, calls = self.run_fixture(mode)
                self.assertNotEqual(result.returncode, 0, mode)
                if mode == "interrupt": self.assertEqual(result.returncode, 143, result.stderr)
                if mode == "foreign":
                    self.assertIsNone(result.payload_environment)
                    self.assertFalse(any(call[1:2] == ["rm"] for call in calls))
                else:
                    self.assertIn(["docker", "rm", "--force", ID], calls)
                if mode == "payload":
                    self.assertEqual(result.returncode, 7)

    def test_payload_deadline_and_kill_grace_preserve_owned_cleanup(self):
        for mode, status in (("timeout-term", 124), ("timeout-kill", 137), ("timeout-cleanup", 1)):
            with self.subTest(mode=mode):
                result, calls = self.run_fixture(mode)
                self.assertEqual(result.returncode, status, result.stderr)
                payload = ["node", "fixture-release-evidence.mjs", "run", "--gate", "postgres", "--candidate-sha", SHA]
                self.assertEqual(result.payload_timeout, ["--kill-after=2s", "25m", *payload])
                self.assertEqual(calls.count(payload), 1)
                self.assertIn(["docker", "rm", "--force", ID], calls)
                self.assertEqual(result.container_remaining, mode == "timeout-cleanup")

    def test_invalid_port_bindings_do_not_launch_payload_and_clean_only_owned_container(self):
        for suffix in ("inspect", "address", "missing", "zero", "range", "text", "leading-zero", "type", "empty", "multiple", "null"):
            with self.subTest(binding=suffix):
                result, calls = self.run_fixture("port-" + suffix)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(result.payload_environment)
                self.assertIn(["docker", "rm", "--force", ID], calls)

    def test_invalid_database_urls_do_not_launch_payload_or_print_credentials(self):
        values = ["", "postgresql://private-password@foreign.invalid:5432/db", "http://private-password@127.0.0.1:5432/db",
                  "postgresql://private-password@127.0.0.1:bad/db", "postgresql://private-password@127.0.0.1:5432/db\n"]
        values.extend("postgresql://private-password@127.0.0.1:5432/db?" + query for query in (
            "host=foreign.invalid", "port=5432", "hostaddr=127.0.0.2", "%68ost=foreign.invalid", "%70ort=5432"))
        for key in ("DATABASE_ADMIN_URL", "DATABASE_APP_URL"):
            for value in values:
                with self.subTest(variable=key, url=value):
                    result, calls = self.run_fixture("pass", {key: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIsNone(result.payload_environment)
                    self.assertNotIn("private-password", result.stdout + result.stderr)
                    self.assertIn(["docker", "rm", "--force", ID], calls)


    def test_external_step_pid_int_and_term_settle_live_payload(self):
        for signum, status in ((signal.SIGINT, 130), (signal.SIGTERM, 143)):
            for mode in ("cancel-running", "cancel-resistant"):
                with self.subTest(signal=signum, mode=mode):
                    result, calls = self.run_fixture(mode, external_signal=signum)
                    self.assertEqual(result.returncode, status, result.stderr)
                    self.assertFalse(result.child_remaining, "owned payload must not remain alive")
                    self.assertFalse(result.container_remaining)
                    self.assertIn(["docker", "rm", "--force", ID], calls)

    def test_sigint_waits_for_gated_cleanup_past_old_watchdog(self):
        result, calls = self.run_fixture(
            "cancel-gated-cleanup", external_signal=signal.SIGINT
        )
        self.assertEqual(result.returncode, 130, result.stderr)
        self.assertFalse(result.child_remaining)
        self.assertFalse(result.container_remaining)
        self.assertIn(["docker", "rm", "--force", ID], calls)

    def test_external_cancel_cleanup_deadline_is_bounded_and_unknown_fails(self):
        result, calls = self.run_fixture("cancel-slow-cleanup", external_signal=signal.SIGTERM)
        self.assertLess(result.cancel_seconds, 2.5)
        self.assertEqual(result.returncode, 1)
        self.assertIn("cleanup unverified", result.stderr)
        self.assertTrue(result.container_remaining)
        self.assertFalse(result.child_remaining)

    def test_external_cancel_rejects_every_changed_identity_field(self):
        for field in ("id", "name", "image", "owner", "sha"):
            with self.subTest(field=field):
                result, calls = self.run_fixture("cancel-wrong-" + field, external_signal=signal.SIGTERM)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(result.container_remaining)
                self.assertFalse(result.child_remaining)
                self.assertFalse(any(call[1:2] == ["rm"] for call in calls))
                self.assertIn("cleanup unverified", result.stderr)

    def test_external_cancel_during_create_recovers_only_exact_owned_cid(self):
        result, calls = self.run_fixture("cancel-create", external_signal=signal.SIGTERM)
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertFalse(result.container_remaining)
        self.assertFalse(result.child_remaining)
        self.assertIsNone(result.payload_environment)
        self.assertIn(["docker", "rm", "--force", ID], calls)


if __name__ == "__main__":
    unittest.main()
