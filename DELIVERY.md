# WasalX delivery

Follows engineering standard v1.10.

WasalX Delivery owns this document. Change it through a reviewed PR.

## Branching and merging

- Open PRs from short-lived branches against trunk `main`. Merge, split, or close each PR within two days of its first push. Delete merged branches and branches with no PR after seven days without a push.
- Enable auto-merge into the protected merge queue once checks pass at the exact PR head and any required risk-path review gives a passing verdict. The queue squashes and requires every PR in a group to pass.
- For the [risk paths defined in the agent instructions](AGENTS.md#risk-paths), require one independent Opus 5.5 high verdict on the full diff at the exact PR head. Reuse the verdict for a merge-only base update with the same reviewed diff (same patch-id) or a same-tree re-cut. Review substantive diff changes again. [CODEOWNERS](CODEOWNERS) marks risk paths only. Code-owner and lead approvals are not required.
- Record the risk-path verdict on the PR.
- If the PR head changes after auto-merge is enabled or a review sends the PR back, disable auto-merge and remove the PR from the merge queue. Check queue membership directly because a queued PR shows no auto-merge request.
- Update `main` only through the protected queue, which qualifies the exact combined tree. Never force-push or rewrite history.
- Run agent pushes, PR operations, merges, reruns, and issue and board writes only through the project's reviewed GitHub App helper. Never print its installation token. Use the owner login only for approved settings changes and authorized tag creation.

## Checks

- PRs run lint, typecheck, test collection, both unit shards, and dependency review. On a PR, PostgreSQL and portal integration run when a file on the fixed path list in [ci.yml](.github/workflows/ci.yml) changes or CI cannot verify the diff. Otherwise, both first run in the merge queue. CI selects infrastructure jobs by path and narrows advisory image builds by their inputs, with `max-parallel: 8`. Unknown or shared image inputs select the full catalog.
- The `merge_group` run covers the full CI suite, including PostgreSQL, portal/browser, and infrastructure checks, and accounts for every image in the catalog with `max-parallel: 21`. `ci-gate` is the only required status check. Code scanning for high and critical findings is a separate ruleset requirement.
- `ci-gate` always runs. A failed or cancelled required job fails the gate. Only jobs explicitly excluded by the workflow's event or path selection may be skipped.
- The advisory [TypeScript comparison](.github/workflows/typescript-comparison.yml) compares TypeScript 5 and 7 diagnostics, compiler time, and service output on the PR candidate and its main baseline. It runs the unit suite on TypeScript 7 output when the emitted files differ.
- The [nightly installer workflow](.github/workflows/nightly-install.yml) runs at 02:17 UTC, on RC tag pushes, and on PRs, where each job runs only when its inputs change. It rehearses the frozen-disk discard in QEMU and a full installation and recreation from a complete `main` publication.
- The [pnpm cache action](.github/actions/ci-pnpm/action.yml) saves pnpm dependency and service build caches on main pushes only. PostgreSQL integration and portal integration always force clean service builds.
- Run CI on free GitHub-hosted runners. Cancel older CI runs only for the same PR. Keep workflow permissions read-only at the top level, grant writes per job, and pin actions by full commit SHA. Prohibit `pull_request_target`. Fork PRs receive no secrets.
- Set job time limits from the measured p95 plus 25 percent and record the run sample here. Review limits monthly. A higher limit needs new measurements in a separate PR. See [Deviations](#deviations) for current sample coverage.
- For every workflow-changing PR, verify the SHA-256 of the pinned actionlint 1.7.12 binary before running it. Require zero new findings compared with the base branch. Older 1.7.x versions misread YAML anchors.

## Test policy

- Fix a failing test or the defect it found. Keep required checks and lint rules in place. CI must pass on its first attempt without skipping tests or widening timeouts. File a flaky test as a High-priority bug and fix it or revert the change that introduced it.
- Revert the offending change if `main` or the merge queue stays red for 30 minutes. Replacements must preserve the original regression coverage. A test file that only detects changes may be removed after two weeks of evidence. Keep authorization, privacy, migration, and concurrency tests.
- Every test file belongs to a named runner. Keep runner ownership and the coverage inventory current. The [ownership guard](tests/hosted-ci.test.mjs) detects gaps and stale entries.
- [The integration scenario registry](scripts/postgres-scenario-registry.mjs) assigns each PostgreSQL scenario to one of four shards. Each shard uses a disposable database. CI requires one report per shard and fails on unknown, missing, or duplicate scenarios.
- Use local services and mocks in tests. Use disposable data and test credentials.

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
- The manual [image mirror workflow](.github/workflows/mirror-images.yml) runs only from `main`. It copies the installer's pinned object-storage images to the project registry and fails on any digest mismatch.
- Publish one GitHub Release per release milestone. Cut immutable, annotated `vMAJOR.MINOR.PATCH-rc.N` and `vMAJOR.MINOR.PATCH` tags using the identity authorized by the release tag ruleset. Promote the same image digests across environments. PR builds never publish release images.
- Follow the [release criteria and nightly installer evidence rules](docs/release.md) for digest promotion, installer rehearsals, and stable release.

## Deploys

- DEV host steps and the `stg` RC rehearsal each run through a gate. Review each gate once and record one Portfolio GO. After its GO, the gate automatically releases every change that passes and writes an audit row with the deployed commit, image digests, result, and the gate's GO reference. A new kind of change or a change to the gate requires a new GO.
- The owner is the `prod` environment's required reviewer and approves each production deployment there. Only that approval gives GO to release a deployment to production.
- WasalX Delivery prepares the DEV host packets. Host work runs through the Servers lead, including the planned stager and relay outside this repo.
- The `dev` GitHub environment accepts deployments only from `main`. The DEV relay records a receipt only by dispatching the workflow with dispatch ref `main`, environment `dev`, and a 40-hex SHA for a `main` commit. The relay authenticates exclusively through the project's reviewed GitHub App helper. Dispatches accept only the fixed receipt-code vocabulary defined in [deploy.yml](.github/workflows/deploy.yml).
- Before changing state, verify the backup is restorable and retain the previous installed state. Require a real-stack rehearsal for the exact candidate before any probe or pre-arm code reaches DEV. Run health checks after replacement and record health and recovery evidence for the target environment.
- On DEV, install on an overlay over the frozen base.
- Any DEV configuration change must pass the installer's native preflight on the new configuration before acceptance.

### Rollback

- **DEV** — Run the authorized overlay discard from the [DEV installer runbook](scripts/dev-install/README.md). Verify the restored base is healthy and preserve the rollback receipt.
- **Staging and production** — Redeploy the digests in `images-manifest.json` from the last good release for that environment through its deploy gate. No workflow performs this deploy yet; `deploy.yml` records it, and a `prod` dispatch waits for the `prod` reviewer's approval. Use a release candidate tag for `stg` and a stable tag for `prod`. Record the rollback with the [`deploy.yml`](.github/workflows/deploy.yml) `workflow_dispatch`. Set `environment` to `stg` or `prod` and use the same last good tag for the dispatch ref and the `ref` input. Omit the DEV-only receipt code. Run the health checks and retain the result with the deployment record. See the [release procedure](docs/release.md).

  ```bash
  gh workflow run deploy.yml --ref "$tag" -f environment="$environment" -f ref="$tag"
  ```

  Set `tag` to the last good tag and `environment` to the target. Agents use the reviewed GitHub App helper for the dispatch.

## DEV safety rules

- Prove the guard after every boot before proceeding. Verify that held services remain stopped. Keep the preimage guard at 60 seconds.
- Hold the frozen-disk lock, verify the immutable flag and exact disk identity, and check the backing chain and disk integrity. Compute a full hash for each new base version, before committing a change to the base, and daily while frozen.
- Stop on any failed proof. Preserve the evidence and use the authorized recovery path before admitting another attempt.

## Hotfixes

Open an issue and follow the [merge rules](#branching-and-merging) for the PR to `main`. Cut an RC tag for the tested fix and validate it. Ship the stable fix through the [production deploy gate](#deploys).

## Security

- Maintain Dependabot alerts, CodeQL, secret scanning with push protection, and private vulnerability reporting. Report vulnerabilities through the [security policy](SECURITY.md) and handle sensitive alerts privately.
- Group Dependabot updates using [.github/dependabot.yml](.github/dependabot.yml). Hold stateful major upgrades for PostgreSQL, Elasticsearch, and Jaeger for a planned compatibility and data migration review. Apply the additional version holds in the configuration.
- Keep deploy secrets in the environment that uses them. Assign a rotation owner, rotate exposed credentials immediately, and rotate GitHub App private keys annually.
- Follow the high and critical alert release criteria in [docs/release.md](docs/release.md).

## Speed and quality gates

Measure the latest 150 first-attempt PR runs from GitHub Actions timestamps. Split job time into waiting, setup before the first lint or test step, and execution. Track time to mergeable across all required checks, including code scanning. Record trends and misses on the private project board.

| Measure | Target and response |
| --- | --- |
| PR push to `ci-gate` completion | p50 under 1 minute, p95 under 2 minutes. Report misses and whether affected-image or integration work was selected. |
| Merge-group creation to `ci-gate` completion | Median at most 8 minutes. Track the tail and confirm the run covers the full image catalog. |
| Job pickup from creation to start | At most 60 seconds. Report longer waits and distinguish runner pickup from workflow dependency time. |
| Job setup before the first lint or test step | Under 15 seconds. Report misses. |
| First-attempt green | Track the fraction of eligible exact heads and merge groups green on attempt one. Investigate each failure and retain it in the count. |
| CI cost | Zero. Changes that would incur charges require owner approval. |
| Portal page budgets | The page budgets in [DESIGN.md](DESIGN.md#speed): `/app` first-load JavaScript, LCP and INP. Misses become board items. |

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
| §6 Automatic production backups and quarterly restore tests | There is no production data yet. The [backup job](infra/helm/wasalx/templates/control-plane-backup.yaml) is disabled by default and the [restore rehearsal script](scripts/dr/rehearse-postgres-restore.mjs) is unwired. | 2026-12-14 |
| §1 One formatter and one linter per language in CI | Ruby, Python and shell have no lint job, and only OpenTofu has a formatter check. | 2026-12-14 |
| §1 URL and IP literal guard with a reasoned allowlist | The guard and allowlist have yet to be built. | 2026-12-14 |
| §6 Staging rollback rehearsal for every release candidate | Staging is not in service. Once it is, deploy each RC, roll back to the previous release, verify health, and record the rehearsal in the deployment audit. | 2026-12-14 |
