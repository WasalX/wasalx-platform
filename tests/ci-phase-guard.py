import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
os.environ.setdefault("WASALX_QUALITY_WORKFLOW_PATH", ".github/workflows/fixture-quality.yml")

source = Path(__file__).resolve().parents[1] / "scripts/release/ci-phase-guard.py"
spec = importlib.util.spec_from_file_location("phase_guard", source)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PhaseGuard(unittest.TestCase):
    def test_owned_daemon_recovery_is_bounded_and_bad_metadata_never_retries(self):
        endpoint = "unix:///run/user/1002/docker.sock"
        timeout = subprocess.TimeoutExpired("docker", 10)
        unavailable = subprocess.CalledProcessError(1, "docker")
        with patch.object(guard.subprocess, "check_output", side_effect=[timeout, unavailable, '{"SecurityOptions": ["name=rootless"]}']) as command, \
             patch.object(guard.time, "sleep") as sleep:
            self.assertEqual(guard.docker_info(endpoint, {}), {"SecurityOptions": ["name=rootless"]})
            self.assertEqual(command.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
            for call in command.call_args_list:
                self.assertEqual(call.args[0][1:3], ["--host", endpoint])
                self.assertEqual(call.kwargs["timeout"], 10)
        with patch.object(guard.subprocess, "check_output", side_effect=timeout) as command, \
             patch.object(guard.time, "sleep") as sleep:
            with self.assertRaises(subprocess.TimeoutExpired):
                guard.docker_info(endpoint, {})
            self.assertEqual(command.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
        with patch.object(guard.subprocess, "check_output", return_value="invalid-json") as command, \
             patch.object(guard.time, "sleep") as sleep:
            with self.assertRaises(json.JSONDecodeError):
                guard.docker_info(endpoint, {})
            self.assertEqual(command.call_count, 1)
            sleep.assert_not_called()

    def admit(self, uid=1002, euid=None, split=True, short=None, total=2000,
              socket=True, owner=True, directory=True, rootless=True, security="default", docker_root="/runner/docker",
              mount=True, block=True, wrong_mount=False, wrong_write=False, drift=False,
              entries=1, uuid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", endpoint=None,
              failure=None, environment=None):
        workspace = "/runner/work/project"
        roots = {"/": ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 1),
                 "/data": ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 2)}
        calls, observations = [], {}

        def device(path):
            return 2 if split and str(path) in (docker_root, "/data", "/dev/disk/by-uuid/" + roots["/data"][0]) else 1

        class FixturePath(PurePosixPath):
            def resolve(self, strict=False):
                return self

            def stat(self):
                key = str(self)
                observations[key] = observations.get(key, 0) + 1
                kind = stat.S_IFBLK if key.startswith("/dev/disk/by-uuid/") else stat.S_IFDIR
                if key.startswith("/dev/disk/by-uuid/") and not block:
                    kind = stat.S_IFREG
                if key in (workspace, docker_root) and not directory:
                    kind = stat.S_IFREG
                dev = device(self)
                if (wrong_mount and key in roots) or (wrong_write and key in (workspace, docker_root)):
                    dev = 3
                if drift and key == workspace and observations[key] > 1:
                    dev = 3
                return SimpleNamespace(st_mode=kind, st_uid=uid if owner else uid + 1,
                                       st_dev=dev, st_rdev=device(self))

            def lstat(self):
                return SimpleNamespace(st_mode=stat.S_IFSOCK if socket else stat.S_IFREG,
                                       st_uid=uid if owner else uid + 1)

        def command(args, **kwargs):
            calls.append(args)
            if failure:
                raise failure
            if args[1:3] == ["context", "inspect"]:
                return endpoint or f"unix:///run/user/{uid}/docker.sock"
            if args[0] == "/usr/bin/docker":
                self.assertEqual(args[1:3], ["--host", f"unix:///run/user/{uid}/docker.sock"])
                self.assertFalse(set(kwargs["env"]) & {"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"})
                options = (["name=rootless"] if rootless else []) if security == "default" else security
                return json.dumps({"SecurityOptions": options, "DockerRootDir": docker_root})
            target = "/data" if split and args[3] == docker_root else "/"
            value = roots[target][0] if uuid == roots["/"][0] else uuid
            return json.dumps({"filesystems": [{"target": target, "uuid": value}] * entries})

        def disk(path):
            free = (total * 5 + 99) // 100
            return SimpleNamespace(f_blocks=total, f_bavail=free - (1 if short == str(path) else 0), f_bfree=free + 100)

        env = {"WASALX_QUALITY_WORKFLOW_PATH": os.environ["WASALX_QUALITY_WORKFLOW_PATH"], "GITHUB_WORKSPACE": workspace, "RUNNER_NAME": "future-labelled-runner", **(environment or {})}
        with patch.object(guard.sys, "platform", "linux"), \
             patch.object(guard.os, "getuid", return_value=uid, create=True), \
             patch.object(guard.os, "geteuid", return_value=uid if euid is None else euid, create=True), \
             patch.object(guard, "Path", FixturePath), \
             patch.object(guard.os.path, "ismount", return_value=mount), \
             patch.object(guard.os, "statvfs", disk, create=True), \
             patch.object(guard.subprocess, "check_output", command), \
             patch.dict(os.environ, env, clear=True):
            guard.check()
        return calls

    def test_actual_owned_users_and_shared_or_split_mounts_pass_without_host_profiles(self):
        for uid in (1002, 20002, 20003, 31000):
            for split in (True, False):
                self.admit(uid=uid, split=split)
        self.admit(environment={"DOCKER_HOST": "unix:///run/user/1002/docker.sock"})

    def test_root_foreign_socket_engine_and_write_paths_deny(self):
        for args in ({"uid": 0}, {"euid": 0}, {"socket": False}, {"owner": False},
                     {"directory": False}, {"rootless": False}, {"docker_root": "relative"}, {"docker_root": ""},
                     {"security": "name=rootless"}, {"security": {"name=rootless": True}}, {"security": None}, {"security": ["name=rootless", 0]}):
            with self.assertRaises(RuntimeError):
                self.admit(**args)

    def test_default_docker_endpoint_cannot_cross_to_another_engine(self):
        for env in ({"DOCKER_HOST": "unix:///var/run/docker.sock"}, {"DOCKER_CONTEXT": "foreign"},
                    {"DOCKER_TLS_VERIFY": "1"}, {"DOCKER_CERT_PATH": "/foreign"}):
            with self.assertRaisesRegex(RuntimeError, "local socket"):
                self.admit(environment=env, endpoint="unix:///var/run/docker.sock")
        self.admit(environment={"DOCKER_CONTEXT": "owned-rootless"})

    def test_fullruntime_native_jobs_keep_local_rootless_and_uuid_requirements(self):
        for job in ("postgres", "browser-shards", "browser", "infrastructure", "docker-smoke"):
            env = {"WASALX_QUALITY_WORKFLOW_PATH": os.environ["WASALX_QUALITY_WORKFLOW_PATH"], "WASALX_CI_RUNTIME": "native", "WASALX_CI_SCOPE": "full", "GITHUB_JOB": job}
            calls = self.admit(uid=20002, environment=env)
            self.assertTrue(any(argv[0] == "/usr/bin/docker" for argv in calls))
            for change in ({"rootless": False}, {"socket": False}, {"uuid": ""}):
                with self.assertRaises((RuntimeError, ValueError)):
                    self.admit(uid=20002, environment=env, **change)

    def test_mount_uuid_block_identity_and_write_device_drift_deny(self):
        for args in ({"entries": 0}, {"entries": 2}, {"uuid": ""}, {"uuid": "../../foreign"},
                     {"mount": False}, {"block": False}, {"wrong_mount": True}, {"wrong_write": True}, {"drift": True}):
            with self.assertRaises((RuntimeError, ValueError)):
                self.admit(**args)

    def test_each_disk_keeps_exact_fractional_five_percent_and_reserved_blocks_do_not_count(self):
        for total in (2000, 2001):
            self.admit(total=total)
            for path in ("/", "/data"):
                with self.assertRaisesRegex(RuntimeError, "filesystem reserve"):
                    self.admit(total=total, short=path)
        with self.assertRaisesRegex(RuntimeError, "filesystem reserve"):
            self.admit(total=0)

    def test_missing_runtime_metadata_and_bounded_command_failures_deny(self):
        for error in (FileNotFoundError(), subprocess.CalledProcessError(1, "fixture"), subprocess.TimeoutExpired("fixture", 10)):
            with self.assertRaises(type(error)):
                self.admit(failure=error)


class ManagedPhaseGuard(unittest.TestCase):
    def setUp(self):
        # os.sync is POSIX-only; keep managed tests runnable on every developer host.
        self.sync = patch.object(guard.os, "sync", create=True).start()
        self.addCleanup(patch.stopall)

    def environment(self, **changes):
        return {"WASALX_QUALITY_WORKFLOW_PATH": os.environ["WASALX_QUALITY_WORKFLOW_PATH"], "WASALX_CI_RUNTIME": "managed", "GITHUB_ACTIONS": "true",
                "WASALX_CI_WORKFLOW_RUNTIME": "native", "WASALX_CI_SCOPE": "full",
                "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "WasalX/WasalX",
                "GITHUB_REF": "refs/heads/integration/wasalx", "GITHUB_REF_PROTECTED": "false",
                "GITHUB_WORKFLOW_REF": ('WasalX/WasalX/' + os.environ['WASALX_QUALITY_WORKFLOW_PATH'] + '@refs/heads/integration/wasalx'),
                "RUNNER_ENVIRONMENT": "self-hosted", "GITHUB_SHA": "a" * 40,
                "WASALX_CI_RUNTIME_SHA": "a" * 40, "WASALX_CI_CPU_TRIAL_LIVE": "false",
                "GITHUB_JOB": "repository", "GITHUB_WORKSPACE": "/workspace/job/source",
                "RUNNER_TEMP": "/workspace/job/temp", "CI_UNIT_WORKERS_CLOUD": "3", **changes}

    def resource_fixture(self, changes=None, owner=True):
        values = {"/proc/self/cgroup": "0::/", "/sys/fs/cgroup/cpu.max": "400000 100000",
                  "/sys/fs/cgroup/memory.max": str(16 * 1024 ** 3),
                  "/sys/fs/cgroup/memory.current": str(int(2.5 * 1024 ** 3)),
                  "/sys/fs/cgroup/memory.stat": "inactive_file 0\n", **(changes or {})}

        class ManagedPath(PurePosixPath):
            def read_text(self):
                return values[str(self)]

            def is_file(self):
                return str(self) in values and values[str(self)] is not None

            def is_dir(self):
                return True

            def resolve(self, strict=False):
                return self

            def stat(self):
                return SimpleNamespace(st_uid=1000 if owner else 1001, st_mode=stat.S_IFDIR)

        return ManagedPath






    def test_memory_budget_config_validation_rejects_status_resize_and_length_errors(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "ci-memory-budget.json"
            valid = {
                "schemaVersion": 1, "status": "PROVISIONAL", "resizeAfterRuns": 5,
                "provenance": {"runs": ["1"], "memoryPeakGiB": [7.3], "rubyCache": ["miss"], "buildJobs": [4], "oomCount": 0},
                "margin": 1.3, "budgetGiB": 10, "baselineAllowanceGiB": 2, "observedWorkers": 3,
            }
            for key, value in (("status", "DRAFT"), ("resizeAfterRuns", 0), ("resizeAfterRuns", -1),
                               ("resizeAfterRuns", True), ("baselineAllowanceGiB", 0), ("baselineAllowanceGiB", -1),
                               ("baselineAllowanceGiB", True), ("baselineAllowanceGiB", 10),
                               ("baselineAllowanceGiB", float("nan")), ("provenance", {**valid["provenance"], "buildJobs": []})):
                candidate = {**valid, key: value}
                path.write_text(json.dumps(candidate))
                with patch.object(guard, "MEMORY_BUDGET_PATH", path), \
                     patch.object(guard, "Path", self.resource_fixture()), \
                     patch.object(guard.os, "sched_getaffinity", return_value=set(range(5)), create=True), \
                     patch.dict(os.environ, self.environment(), clear=True):
                    with self.assertRaisesRegex(RuntimeError, "memory budget is missing or invalid"):
                        guard.managed_resources()





    def test_missing_or_invalid_memory_budget_refuses(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "ci-memory-budget.json"
            for content in (None, "{}",
                            '{"schemaVersion":1,"provenance":{"runs":["1"],"memoryPeakGiB":[7.3],"oomCount":1},"margin":1.3,"budgetGiB":10,"observedWorkers":3}',
                            '{"schemaVersion":1,"provenance":{"runs":["1"],"memoryPeakGiB":[7.3],"oomCount":false},"margin":1.3,"budgetGiB":10,"observedWorkers":3}',
                            '{"schemaVersion":true,"provenance":{"runs":["1"],"memoryPeakGiB":[7.3],"oomCount":0},"margin":1.3,"budgetGiB":10,"observedWorkers":3}'):
                if content is None:
                    if path.exists():
                        path.unlink()
                else:
                    path.write_text(content)
                with patch.object(guard, "MEMORY_BUDGET_PATH", path), \
                     patch.object(guard, "Path", self.resource_fixture()), \
                     patch.object(guard.os, "sched_getaffinity", return_value=set(range(5)), create=True), \
                     patch.dict(os.environ, self.environment(), clear=True):
                    with self.assertRaisesRegex(RuntimeError, "memory budget is missing or invalid"):
                        guard.managed_resources()




    def test_scope_rejection_precedes_managed_or_native_payload(self):
        valid = self.environment(WASALX_CI_SCOPE="repository-only", WASALX_CI_WORKFLOW_RUNTIME="managed")
        for change in ({}, {"WASALX_CI_SCOPE": "unknown"}, {"WASALX_CI_RUNTIME": "native"},
                       {"GITHUB_JOB": "browser"}):
            with patch.object(guard.sys, "platform", "linux"), \
                 patch.object(guard.os, "getuid", return_value=1000, create=True), \
                 patch.object(guard.os, "geteuid", return_value=1000, create=True), \
                 patch.object(guard, "managed_check", return_value={"runtime": "managed"}) as payload, \
                 patch.dict(os.environ, {**valid, **change}, clear=True):
                if change:
                    with self.assertRaises(RuntimeError):
                        guard.check()
                    payload.assert_not_called()
                else:
                    self.assertEqual(guard.check(), {"runtime": "managed"})

    def test_unbound_docker_phases_refuse_before_any_operation(self):
        for job in ("postgres", "browser-shards", "browser", "infrastructure", "docker-smoke"):
            with patch.dict(os.environ, self.environment(GITHUB_JOB=job), clear=True), \
                 patch.object(guard.subprocess, "check_output") as command:
                with self.assertRaisesRegex(RuntimeError, "MANAGED_DOCKER_STORE_AND_AGGREGATE_UNBOUND"):
                    guard.managed_check(1000, True)
                command.assert_not_called()
        with patch.dict(os.environ, self.environment(), clear=True):
            with self.assertRaisesRegex(RuntimeError, "MANAGED_DOCKER_STORE_AND_AGGREGATE_UNBOUND"):
                guard.managed_check(1000, True, docker_phase=True)


    def test_dockerless_marker_never_exempts_a_docker_phase_or_other_job(self):
        env = self.environment(GITHUB_JOB="infrastructure", WASALX_CI_ROUTE="cloud")
        for change, docker_phase in [({}, True), ({"GITHUB_JOB": "docker-smoke"}, False),
                                     ({"WASALX_CI_ROUTE": "fullruntime"}, False),
                                     ({"WASALX_CI_SCOPE": "repository-only", "WASALX_CI_WORKFLOW_RUNTIME": "managed"}, False)]:
            with patch.dict(os.environ, {**env, **change}, clear=True), \
                 patch.object(guard.subprocess, "check_output") as command:
                with self.assertRaisesRegex(RuntimeError, "MANAGED_DOCKER_STORE_AND_AGGREGATE_UNBOUND"):
                    guard.managed_check(1000, True, docker_phase=docker_phase)
                command.assert_not_called()

    def test_untrusted_and_protected_managed_contexts_refuse(self):
        for change in ({"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_EVENT_NAME": "merge_group"},
                       {"GITHUB_REF_PROTECTED": "true"}, {"GITHUB_REF": "refs/heads/main"},
                       {"WASALX_CI_RUNTIME_SHA": "b" * 40}, {"WASALX_CI_CPU_TRIAL_LIVE": "true"},
                       {"WASALX_CI_WORKFLOW_RUNTIME": "managed"}):
            with patch.dict(os.environ, self.environment(**change), clear=True):
                with self.assertRaises(RuntimeError):
                    guard.managed_identity()



class MissingPrivateBudget(unittest.TestCase):
    def test_missing_private_budget_evidence_denies_managed_admission(self):
        with self.assertRaises(RuntimeError):
            guard.memory_budget()

if __name__ == "__main__":
    unittest.main()
