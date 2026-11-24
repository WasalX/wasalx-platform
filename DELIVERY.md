# WasalX delivery

Follows engineering standard v1.20.

WasalX Delivery owns this document, releases, deploys, rollback, and alerts. See [Test policy](#test-policy) for QA and CI ownership.

## Branching and merging

- Open PRs from short-lived branches against trunk `main`. Merge, split, or close each PR within two days of its first push. Delete merged branches and branches with no PR after seven days without a push.
- Workers push their own branches and open PRs under the project's agent identity. The queue squashes and requires every PR in a group to pass.
- Only critical changes, mapped to paths in [Critical paths](AGENTS.md#critical-paths), get one independent review.
- For all other changes, the thread that made the change opens its own PR and merges it once required CI is green. No second review, lead sign-off, or Portfolio GO is required. Never bypass required CI or branch protection.
- For a critical PR, the author enables auto-merge only after the reviewer's passing verdict comment names the current head SHA. Before any later push, disable auto-merge, check queue membership, and remove the PR if queued. A push after the verdict needs a new verdict only when it adds a new critical change. Tests check the fix for a finding, not another review.
- Update `main` only through the protected queue, which qualifies the exact combined tree. Never force-push or rewrite history.
- Run agent pushes, PR operations, merges, reruns, and issue and board writes only through the project's reviewed GitHub App helper. Never print its installation token. Use the owner login only for approved settings changes and authorized tag creation.

## Checks

- The [Storybook job](.github/workflows/ci.yml) is required by `ci-gate` on main, in the merge queue, on manual CI runs, and on PRs that touch UI or Storybook inputs. It builds the static story index, audits every story with axe's WCAG 2.2 AA rules in Chromium, and fails on accessibility violations or render errors. It checks light and dark themes in English and Arabic (RTL). Product stories use both translations, and English design reference copy keeps its language in RTL layouts. The run's Storybook artifact contains screenshots and a browser report. Pixel comparisons need repeatable hosted-runner baselines.

- PRs run lint, typecheck, test collection, both affected unit shards, and dependency review. [The unit selector](scripts/affected-unit-tests.mjs) follows relative imports from each test and includes tests with uncertain dependencies. A missing diff, an unmapped changed module, or changes to configuration, dependency inputs, workflows, shared fixtures, or the tracked file layout select the full inventory. On a PR, PostgreSQL and portal integration run when a file on the fixed path list in [ci.yml](.github/workflows/ci.yml) changes or CI cannot verify the diff. Otherwise, both first run in the merge queue. CI selects infrastructure jobs by path and narrows advisory image builds by their inputs, with `max-parallel: 8`. Unknown or shared image inputs select the full catalog.
- Both unit shards run the full inventory on main pushes, merge groups, and manual CI runs. A stable release requires successful main CI for its exact commit.
- The `merge_group` run covers the full CI suite, including PostgreSQL, portal/browser, and infrastructure checks, and accounts for every image in the catalog with `max-parallel: 21`. `ci-gate` is the only required status check. Code scanning for high and critical findings is a separate ruleset requirement.
- `ci-gate` always runs. A failed or cancelled required job fails the gate. Only jobs explicitly excluded by the workflow's event or path selection may be skipped.
- The advisory [TypeScript comparison](.github/workflows/typescript-comparison.yml) compares TypeScript 5 and 7 diagnostics, compiler time, and service output on the PR candidate and its main baseline. It runs the unit suite on TypeScript 7 output when the emitted files differ.
- The QEMU frozen-disk discard runs nightly at 02:17 UTC, on PRs, and on manual dispatch. The full install and recreation rehearsal uses a complete `main` publication and runs on the same schedule, on PRs, on manual dispatch from `main`, and when an RC tag is pushed. If the Keycloak inputs differ from that publication, the rehearsal first builds the candidate Keycloak image and verifies startup and realm bootstrap in the disposable stack. On PRs, each rehearsal runs only when its inputs change. See the [nightly installer workflow](.github/workflows/nightly-install.yml).
  For a PR, the workflow skips full installation when the candidate's control API migration tree differs from the resolved publication. The job summary gives the reason and lists the changed paths. The workflow reports the rehearsal result independently of `ci-gate`.
- The [pnpm cache action](.github/actions/ci-pnpm/action.yml) saves pnpm dependency and service build caches on main pushes only. A workspace dependency cache miss clears partial module directories before the frozen install. PostgreSQL integration and portal integration always force clean service builds.
- Run CI on free GitHub-hosted runners. Cancel older CI runs only for the same PR. Keep workflow permissions read-only at the top level, grant writes per job, and pin actions by full commit SHA. Prohibit `pull_request_target`. Fork PRs receive no secrets.
- Set job time limits from the measured p95 plus 25 percent, rounded up to a whole minute. Review limits monthly. A higher limit needs new measurements in a separate PR. See the [CI timing sample](.github/ci-timings.json) and [current coverage](#deviations).
- The [workflow lint job](.github/workflows/ci.yml) verifies the pinned actionlint release archive by SHA-256. It uses the maintained actionlint fork for GitHub's `concurrency.queue` syntax and checks all workflows on every CI run. `ci-gate` requires zero actionlint findings.

## Test policy

- The [application Playwright config](playwright.application.config.ts) selects the journeys that run at 820 px. Mark tablet coverage on each journey with `@tablet`.

- Fix a failing test or the defect it found. Keep required checks and lint rules in place. CI must pass on its first attempt without skipping tests or widening timeouts. File a flaky test as a High-priority bug and fix it or revert the change that introduced it.
- WasalX QA owns tests at every layer, the end-to-end journey catalogue, samples and fixtures, coverage, failing and flaky tests, and nightly suite results. QA runs the pre-release sweep. WasalX Delivery owns the [merge gate](#branching-and-merging), pipeline faults, and [CI speed](#checks).
- Revert the offending change if `main` or the merge queue stays red for 30 minutes. Replacements must preserve the original regression coverage. A test file that only detects changes may be removed after two weeks of evidence. Keep authorization, privacy, migration, and concurrency tests.
- Record known Node unit-test failures in [test-quarantine.json](scripts/test-quarantine.json) with the runner file path, exact test name, owner, and UTC expiry date (`expiresOn`, `YYYY-MM-DD`). The hosted unit reporter labels matching failures and keeps their failing result. A row expires at midnight UTC on its expiry date and fails the unit check.
- Every test file belongs to a named runner. Keep runner ownership and the coverage inventory current. The [ownership guard](tests/hosted-ci.test.mjs) detects gaps and stale entries.
- The [source endpoint guard](tests/source-endpoint-literals.test.mjs) runs in the required unit checks. Keep endpoints in configuration. When a source literal is required, record its exact value, path, and reason in the [allowlist](tests/source-endpoint-allowlist.json). The guard scans tracked source, with exemptions for configuration, generated files, tests, comments, reserved addresses and names, hostless URLs, and namespace identifiers.
- [The integration scenario registry](scripts/postgres-scenario-registry.mjs) assigns each PostgreSQL scenario to one of four shards. Each shard uses a disposable database. CI requires one report per shard and fails on unknown, missing, or duplicate scenarios.
- Use local services and mocks in tests. Use disposable data and test credentials.

## Privacy checks

Before every push, run the private privacy check on the diff, commits, branch name, PR title and body, and any public issue text. Require zero blocking findings and a finished scan. Report counts only.

The [public privacy workflow](.github/workflows/privacy.yml) scans newly introduced commit text, paths, added lines, and PR and issue titles and bodies with generic patterns. The scan runs on branch pushes, PRs, and the merge queue. `ci-gate` fails if the scan fails on a PR, in the queue, or on a push to main. PR title or body edits trigger the privacy workflow by itself. Issue findings appear in Actions after publication. Findings show a location, line, and rule, and redact paths that match a rule.

## Environments

| Environment | Use and data |
| --- | --- |
| `dev` | Shared test environment. Use synthetic data or sanitized test data approved by WasalX Delivery. Keep data scoped to test tenants. |
| `stg` | Release rehearsal with approved sanitized or synthetic data. Not yet in service. |
| `prod` | Live workloads with authorized tenant data. Not yet in service. |

## Releases

- The [image publication workflow](.github/workflows/branch-image.yml) runs once per eligible `main` commit with `max-parallel: 21`. After the complete manifest is published, a serialized job advances the `:main` aliases only when it can verify a fast-forward. The job annotates skipped moves as warnings and retries registry errors during tag creation or digest inspection. A digest mismatch fails the job.
- The manual [image mirror workflow](.github/workflows/mirror-images.yml) runs only from `main`. It copies the installer's pinned object-storage images to the project registry and fails on any digest mismatch.
- Publish one GitHub Release per release milestone. Cut immutable, annotated `vMAJOR.MINOR.PATCH-rc.N` and `vMAJOR.MINOR.PATCH` tags using the identity authorized by the release tag ruleset. Promote the same image digests across environments. PR builds never publish release images.
- Follow the [release criteria and nightly installer evidence rules](docs/release.md) for digest promotion, installer rehearsals, and stable release.

## Deploys

- Require a reviewed gate and one Portfolio GO each for DEV host steps and the `stg` RC rehearsal. After its GO, the gate automatically releases changes that pass and must record the deployed commit, image digests, result, and GO reference. A new kind of change or a change to the gate requires a new GO.
- GitHub keeps environment deployment records. The recording workflow writes the source commit, image digests, and any DEV receipt code to the Actions run summary. The full gate audit row with the GO reference is pending. See the [deployment recording workflow](.github/workflows/deploy.yml).
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

In the daily Delivery check, report p50 and p95 changed lines across the last 100 merged PRs per repository. Exclude files marked `linguist-generated`.

The `portal-integration` job enforces the `/app` JavaScript budget. Keep the other performance targets independent of the merge result and address misses through the board.

## Deviations

| Rule | Reason | Review date |
| --- | --- | --- |
| §4 CI privacy check on every push and in the queue | Hosted CI uses generic public patterns. The full deny list and commit identity checks stay in the private pre-push check. | 2026-12-14 |
| §4/§8 Measure job durations and cap timeouts from p95 | The [timing sample](.github/ci-timings.json) covers the jobs with timeouts in `ci.yml`. Those timeouts still exceed the measured limits. Sampling the other workflows and lowering timeouts are follow-ups. | 2026-12-14 |
| §4 Local pre-commit and pre-push hooks | Agents run the checks in their push workflow. Repository hooks are pending. | 2026-12-14 |
| §4 Runner pickup under 5 s | Measured hosted-runner pickup makes 60 s the working target. Tracked in [#181](https://github.com/WasalX/wasalx-platform/issues/181). | 2026-12-14 |
| §4 PR feedback for `ci.yml` (p50 ≤ 1 min and p95 ≤ 2 min) | On 2026-11-24, the newest 62 successful PR runs measured p50 2.4 min and p95 5.2 min. The PR path still runs the full test and build matrix. | 2026-12-08 |
| §2 Attest artifacts with `actions/attest-build-provenance` and verify with `gh attestation verify` | Images are signed with Cosign and carry BuildKit provenance. The installer verifies them. | 2026-12-14 |
| §4 Run the full suite on main and merge groups | Main pushes skip PR-only checks and queue image builds because the merge queue already qualified the exact tree. | 2026-12-14 |
| §6 Automatic production backups and quarterly restore tests | There is no production data yet. The [control-plane backup and restore runbook](docs/runbooks/control-plane-backup-restore.md) covers enabling backups, installing the quarterly timer, and recording the first successful host rehearsal. | 2026-12-14 |
| §1 One formatter and one linter per language in CI | Ruby, Python, shell, SQL, and CSS lack CI linters. TypeScript and JavaScript use ESLint and still need a formatter. OpenTofu is the only language with a formatter check. | 2026-12-14 |
| §6 Staging rollback rehearsal for every release candidate | Staging is not in service. Once it is, deploy each RC, roll back to the previous release, verify health, and record the rehearsal in the deployment audit. | 2026-12-14 |
