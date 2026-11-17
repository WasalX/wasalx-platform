import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch
os.environ.setdefault("WASALX_QUALITY_WORKFLOW_PATH", ".github/workflows/fixture-quality.yml")

source = Path(__file__).resolve().parents[1] / "scripts/release/ci-phase-guard.py"
spec = importlib.util.spec_from_file_location("ci_phase_guard", source)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class CiOnlyIdentity(unittest.TestCase):
    def setUp(self):
        self.base = {"WASALX_QUALITY_WORKFLOW_PATH": os.environ["WASALX_QUALITY_WORKFLOW_PATH"], 
            "GITHUB_ACTIONS": "true",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REPOSITORY": "WasalX/WasalX",
            "GITHUB_REF": "refs/heads/wasalx/ci-only-stack-c2-fixes",
            "GITHUB_REF_PROTECTED": "false",
            "GITHUB_WORKFLOW_REF": ('WasalX/WasalX/' + os.environ['WASALX_QUALITY_WORKFLOW_PATH'] + '@refs/heads/wasalx/ci-only-stack-c2-fixes'),
            "RUNNER_ENVIRONMENT": "self-hosted",
            "GITHUB_SHA": "a" * 40,
            "WASALX_CI_RUNTIME_SHA": "a" * 40,
            "WASALX_CI_WORKFLOW_RUNTIME": "native",
            "WASALX_CI_SCOPE": "full",
            "WASALX_CI_ROUTE": "cloud",
            "WASALX_CI_EVIDENCE_MODE": "non-qualifying-ci-only",
            "WASALX_CI_RUN_BROWSER": "false",
            "WASALX_CI_RUN_DOCKER_SMOKE": "false",
            "GITHUB_JOB": "postgres",
            "WASALX_CI_CPU_TRIAL_LIVE": "false",
            "WASALX_CI_APPLICATION_CPUS": "",
        }

    def test_exact_ci_only_identity_passes(self):
        with patch.dict(os.environ, self.base, clear=True):
            guard.managed_identity()

    def test_branch_event_ref_sha_and_fullruntime_variants_fail_closed(self):
        changes = [
            {"GITHUB_REF": "refs/heads/wasalx/feature"},
            {"GITHUB_REF": "refs/heads/wasalx/ci-only-!"},
            {"GITHUB_EVENT_NAME": "pull_request"},
            {"GITHUB_EVENT_NAME": "push"},
            {"GITHUB_EVENT_NAME": "merge_group"},
            {"GITHUB_WORKFLOW_REF": ('WasalX/WasalX/' + os.environ['WASALX_QUALITY_WORKFLOW_PATH'] + '@refs/heads/integration/wasalx')},
            {"WASALX_CI_RUNTIME_SHA": "b" * 40},
            {"WASALX_CI_ROUTE": "fullruntime"},
        ]
        for change in changes:
            with self.subTest(change=change), patch.dict(os.environ, {**self.base, **change}, clear=True):
                with self.assertRaises(RuntimeError):
                    guard.managed_identity()

    def test_native_ci_only_identity_allows_cloud_noop_or_one_fullruntime_smoke_job(self):
        with patch.dict(os.environ, self.base, clear=True):
            guard.native_identity()
        smoke_cloud = {**self.base, "WASALX_CI_RUN_DOCKER_SMOKE": "true"}
        with patch.dict(os.environ, smoke_cloud, clear=True):
            guard.native_identity()
        smoke = {**self.base, "GITHUB_JOB": "docker-smoke", "WASALX_CI_ROUTE": "fullruntime", "WASALX_CI_RUN_DOCKER_SMOKE": "true"}
        with patch.dict(os.environ, smoke, clear=True):
            guard.native_identity()
        for change in [{"GITHUB_JOB": "infrastructure", "WASALX_CI_ROUTE": "fullruntime", "WASALX_CI_RUN_DOCKER_SMOKE": "true"},
                       {"GITHUB_JOB": "docker-smoke", "WASALX_CI_ROUTE": "cloud", "WASALX_CI_RUN_DOCKER_SMOKE": "true"},
                       {"WASALX_CI_RUN_BROWSER": "true"}, {"WASALX_CI_RUN_DOCKER_SMOKE": "unknown"}]:
            with self.subTest(change=change), patch.dict(os.environ, {**self.base, **change}, clear=True):
                with self.assertRaises(RuntimeError):
                    guard.native_identity()


if __name__ == "__main__":
    unittest.main()
