# WasalX delivery

Follows engineering standard v1.4.

WasalX Delivery owns this document. Change it through a reviewed PR.

## Branching and merging

- Use short-lived branches and open PRs against trunk `main`. Enable auto-merge into the protected merge queue once checks pass at the exact PR head and any required risk-path review gives a passing verdict. Squash through the queue.
- For the [risk paths defined in the agent instructions](AGENTS.md#risk-paths), require one independent Opus 5.5 high verdict on the full diff at the exact PR head. Reuse the verdict for a merge-only base update with the same reviewed diff (same patch-id) or a same-tree re-cut. Review substantive diff changes again. [CODEOWNERS](CODEOWNERS) marks risk paths only. Code-owner and lead approvals are not required.
- If the PR head changes after auto-merge is enabled or a review sends the PR back, disable auto-merge and remove the PR from the merge queue. Check queue membership directly because a queued PR shows no auto-merge request.
- Keep `main` protected and update it only through the queue. The queue qualifies the exact combined tree.
- Run agent pushes, PR operations, merges, reruns, and issue and board writes only through the project's reviewed GitHub App helper. Never print its installation token. Use the owner login only for approved settings changes.

## Checks

- PRs run lint, typecheck, test collection, both unit shards, and dependency review. On a PR, PostgreSQL and portal integration run when a file on the fixed path list in [ci.yml](.github/workflows/ci.yml) changes or CI cannot verify the diff. Otherwise, both first run in the merge queue. CI selects infrastructure jobs by path and narrows advisory image builds by their inputs, with `max-parallel: 8`. Unknown or shared image inputs select the full catalog.
- The queue runs the full CI suite, including PostgreSQL, portal/browser, and infrastructure checks, and accounts for every image in the catalog with `max-parallel: 21`. The merge gate is `ci-gate`, the only required check.
- The advisory [TypeScript comparison](.github/workflows/typescript-comparison.yml) compares TypeScript 5 and 7 diagnostics, compiler time, and service output on the PR candidate and its main baseline. It runs the unit suite on TypeScript 7 output when the emitted files differ.
- The [pnpm cache action](.github/actions/ci-pnpm/action.yml) saves pnpm dependency and service build caches on main pushes only. PostgreSQL integration and portal integration always force clean service builds.
- Run CI on GitHub-hosted runners. Prohibit `pull_request_target`. Fork PRs receive no secrets.
- For every workflow-changing PR, verify the SHA-256 of the pinned actionlint 1.7.12 binary before running it. Require zero new findings compared with the base branch. Older 1.7.x versions misread YAML anchors.

## Test policy

- Fix a failing test or the defect it found. Prohibit test retries to obtain green, ad hoc skips, and silent removal of tests. Replacements carry over the original assertions.
- A quarantine needs a named maintainer, explicit expiry, and a board item. The quarantine file is planned and tracked on the board.
- Every test file belongs to a named runner. Keep runner ownership and the coverage inventory current. The [ownership guard](tests/hosted-ci.test.mjs) detects gaps and stale entries.
- [The integration scenario registry](scripts/postgres-scenario-registry.mjs) assigns each PostgreSQL scenario to one of four shards. CI requires one report per shard and fails on unknown, missing, or duplicate scenarios.

## Privacy checks

Before every push, run the private privacy check on the diff, commits, branch name, PR title and body, and any public issue text. Require zero blocking findings and a finished scan. Report counts only. See the [CI privacy check deviation](#deviations).

## Environments

| Environment | Use and data |
| --- | --- |
| `dev` | Shared test environment. Use synthetic data or sanitized test data approved by WasalX Delivery. Keep data scoped to test tenants. |
| `stg` | Release rehearsal with approved sanitized or synthetic data. Not yet in service. |
| `prod` | Live workloads with authorized tenant data. Not yet in service. |

## Releases

- The [image publication workflow](.github/workflows/branch-image.yml) runs once per eligible `main` commit with `max-parallel: 21`. After the complete manifest is published, a serialized job advances the `:main` aliases only when it can verify a fast-forward.
- Follow the [release criteria and nightly installer evidence rules](docs/release.md) for digest promotion, installer rehearsals, and stable release.

## Deploys

- DEV host steps and the `stg` RC rehearsal each run through a gate. Review each gate once and record one Portfolio GO. After its GO, the gate automatically releases every change that passes and writes an audit row with the deployed commit, image digests, result, and the gate's GO reference. A new kind of change or a change to the gate requires a new GO.
- The owner is the `prod` environment's required reviewer and approves each production deployment there. Only that approval gives GO to release a deployment to production.
- WasalX Delivery prepares the DEV host packets. Host work runs through the Servers lead, including the planned stager and relay outside this repo.
- The `dev` GitHub environment accepts deployments only from `main`. The DEV relay records a receipt only by dispatching the workflow with dispatch ref `main`, environment `dev`, and a 40-hex SHA for a `main` commit. The relay authenticates exclusively through the project's reviewed GitHub App helper. Dispatches accept only the fixed receipt-code vocabulary defined in [deploy.yml](.github/workflows/deploy.yml).
- Before changing state, verify the backup is restorable and retain the previous installed state. Require a real-stack rehearsal for the exact candidate before any probe or pre-arm code reaches DEV. Run health checks after replacement and record health and recovery evidence for the target environment.
- On DEV, install on an overlay over the frozen base. On failure, use the authorized discard path to restore the previous base and verify its health. Preserve the rollback receipt. See the [installer runbook](scripts/dev-install/README.md).
- Any DEV configuration change must pass the installer's native preflight on the new configuration before acceptance.

## DEV safety rules

- Prove the guard after every boot before proceeding. Verify that held services remain stopped. Keep the preimage guard at 60 seconds.
- Hold the frozen-disk lock, verify the immutable flag and exact disk identity, and check the backing chain and disk integrity. Compute a full hash for each new base version, before committing a change to the base, and daily while frozen.
- Stop on any failed proof. Preserve the evidence and use the authorized recovery path before admitting another attempt.

## Hotfixes

Open an issue and follow the [merge rules](#branching-and-merging) for the PR to `main`. Cut an RC tag for the tested fix and validate it. Ship the stable fix through the [production deploy gate](#deploys).

## Security

- WasalX Delivery owns Dependabot, CodeQL, and secret scanning with push protection. Triage alerts through issues or private board items when disclosure would reveal sensitive details.
- Group Dependabot updates using [.github/dependabot.yml](.github/dependabot.yml). Hold stateful major upgrades for PostgreSQL, Elasticsearch, and Jaeger for a planned compatibility and data migration review. Apply the additional version holds in the configuration.
- Follow the high and critical alert release criteria in [docs/release.md](docs/release.md).

## Speed and quality gates

Measure first attempts from GitHub Actions run and job timestamps. Record trends and misses on the private project board.

| Measure | Target and response |
| --- | --- |
| PR push to `ci-gate` completion | p50 under 1 minute, p95 under 2 minutes. Report misses and whether affected-image or integration work was selected. |
| Merge-group creation to `ci-gate` completion | Median at most 8 minutes. Track the tail and confirm the run covers the full image catalog. |
| Job pickup from creation to start | At most 60 seconds. Report longer waits and distinguish runner pickup from workflow dependency time. |
| First-attempt green | Track the fraction of eligible exact heads and merge groups green on attempt one. Investigate each failure and retain it in the count. |
| CI cost | Zero. Changes that would incur charges require owner approval. |

Keep these performance targets independent of the merge result. Address misses through the board while preserving the required checks.

## Deviations

| Rule | Reason | Review date |
| --- | --- | --- |
| §4 CI privacy check on every push and in the queue | Hosted runners cannot use the private list without exposing it. Every agent push runs the pre-push privacy check. A public required check is planned. | 2026-12-14 |
| §4/§8 Record job time limits with p95 × 1.25 samples | Samples are pending. | 2026-12-14 |
| §4 Local pre-commit and pre-push hooks | Agents run the checks in their push workflow. Repository hooks are pending. | 2026-12-14 |
| §4 Runner pickup under 5 s | Measured hosted-runner pickup makes 60 s the working target. Tracked in [#181](https://github.com/WasalX/wasalx-platform/issues/181). | 2026-12-14 |
| §2 Attest artifacts with `actions/attest-build-provenance` and verify with `gh attestation verify` | Images are signed with Cosign and carry BuildKit provenance. The installer verifies them. | 2026-12-14 |
| §4 Run the full suite on main and merge groups | Main pushes skip PR checks and queue image builds because the merge queue already qualified the exact tree. | 2026-12-14 |
