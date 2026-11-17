// Synthetic policy inputs for local-services and mock-only tests. No external workflow is invoked.
process.env.WASALX_TEST_RECIPIENT_ALLOWLIST ??= "*";
process.env.WASALX_QUALITY_WORKFLOW_PATH ??= ".github/workflows/fixture-quality.yml";
process.env.WASALX_RELEASE_WORKFLOW_PATH ??= ".github/workflows/fixture-release.yml";
process.env.WASALX_RELEASE_EVIDENCE_SCRIPT ??= "fixture-release-evidence.mjs";
