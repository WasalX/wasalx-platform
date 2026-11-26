# WasalX delivery

Follows engineering standard v1.20.

WasalX Delivery owns this document, releases, deploys, rollback, and alerts. See [Test policy](#test-policy) for QA and CI ownership.

Use the [observability runbook](docs/runbooks/alert-response.md) to triage runtime alerts.

## Branching and merging

- Open PRs from short-lived branches against trunk `main`. Merge, split, or close each PR within two days of its first push. Delete merged branches and branches with no PR after seven days without a push.
- Workers push their own branches and open PRs under the project's agent identity. The queue squashes and requires every PR in a group to pass.
- Only critical changes, mapped to paths in [Critical paths](AGENTS.md#critical-paths), get one independent review.
- For all other changes, the thread that made the change opens its own PR and merges it once required CI is green. No second review or lead sign-off is required. Never bypass required CI or branch protection.
- For a critical PR, the author enables auto-merge only after the reviewer's passing verdict comment names the current head SHA. Before any later push, disable auto-merge, check queue membership, and remove the PR if queued. A push after the verdict needs a new verdict only when it adds a new critical change. Tests check the fix for a finding, not another review.
- Update `main` only through the protected queue, which qualifies the exact combined tree. Never force-push or rewrite history.
- Run agent pushes, PR operations, merges, reruns, and issue and board writes only through the project's reviewed GitHub App helper. Never print its installation token. Use the owner login only for approved settings changes and authorized tag creation.

## Checks

- The [Storybook job](.github/workflows/ci.yml) is required by `ci-gate` on main, in the merge queue, on manual CI runs, and on PRs that touch UI or Storybook inputs. It builds the static story index, audits every story with axe's WCAG 2.2 AA rules in Chromium, and fails on accessibility violations or render errors. It checks light and dark themes in English and Arabic (RTL). Product stories use both translations, and English design reference copy keeps its language in RTL layouts. The same job checks the built story index and runs the synthetic inbox, groups, administration, service access, and privacy journeys. The run's Storybook artifact contains screenshots and a browser report. Pixel comparisons need repeatable hosted-runner baselines.

- PRs run lint, typecheck, test collection, both affected unit shards, and dependency review. [The unit selector](scripts/affected-unit-tests.mjs) follows relative imports from each test and includes tests with uncertain dependencies. A missing diff, an unmapped changed module, or changes to configuration, dependency inputs, workflows, shared fixtures, or the tracked file layout select the full inventory. On a PR, PostgreSQL and portal integration run when a file on the fixed path list in [ci.yml](.github/workflows/ci.yml) changes or CI cannot verify the diff. Otherwise, both first run in the merge queue. CI selects infrastructure jobs by path and narrows advisory image builds by their inputs, with `max-parallel: 8`. Unknown or shared image inputs select the full catalog.
- The required application browser job tests the English and Arabic fixture journeys in a matrix of tenant role groups and locales. It runs on affected PRs, in the merge queue, on main, and on manual CI runs. Its shards and portal integration use the same portal build and Chromium from that workflow run. Failed or cancelled application shards collect available Playwright reports and test results for seven days. The [workflow](.github/workflows/ci.yml) lists the inputs that select this job on a PR.
- The signed-in platform operator shards use a disposable signed OIDC provider, PostgreSQL, Redis, the control API, and the shared portal build. They verify an authenticated tenant read before running both operator specs in English and Arabic on desktop and mobile. The registered cases mock cost and transition endpoints. CI requires every selected case to execute successfully and reports status and timing without retaining session material.
- The Keycloak identity job uses the pinned project image, a disposable loopback realm and synthetic identities. It requires the English and Arabic journeys through the native recovery page and MFA, plus sign-in with JavaScript disabled. CI records case results and cleanup without retaining credentials, browser data, or raw reports.
- Both unit shards run the full inventory on main pushes, merge groups, and manual CI runs. A stable release requires successful main CI for its exact commit.
- Unit setup stages the fixtures from the [pinned Zammad add-on](zammad-addon.json) and builds its package with `pnpm run zammad:package`. The staging command checks the required source files in the pinned checkout. The hosted and local unit runners check the staged fixtures and built package before running tests and fail with the missing paths if setup is incomplete.
- The `merge_group` run covers the full CI suite, including PostgreSQL, portal/browser, and infrastructure checks, and accounts for every image in the catalog with `max-parallel: 21`. The portal also builds through the installer's Git-archive build command on merge groups and on PRs that affect its image or installer build inputs. `ci-gate` requires this build when selected and is the only required status check. Code scanning for high and critical findings is a separate ruleset requirement.
- `ci-gate` always runs. A failed or cancelled required job fails the gate. Only jobs explicitly excluded by the workflow's event or path selection may be skipped.
- [Zammad compatibility](.github/workflows/zammad-compatibility.yml) builds the image pinned in [the full Compose profile](compose.full.yaml) and runs the browser and Rails upgrade and rollback tests. The job also runs the control API outbound-media contracts for attachment-only replies. The [image build](infra/docker/Dockerfile.zammad) stages a commit-pinned upstream checkout for typechecking and verifies each restored file against the [fixture manifest](infra/docker/full/zammad/typecheck-upstream.json). It gates merge-group, main and manual CI runs, and PRs that change its inputs or have an unverifiable diff. It also runs on the nightly installer schedule. The image build and disposable Rails and Chromium stack add startup time, so unrelated PRs skip this job.
- The advisory [TypeScript comparison](.github/workflows/typescript-comparison.yml) compares TypeScript 5 and 7 diagnostics, compiler time, and service output on the PR candidate and its main baseline. It runs the unit suite on TypeScript 7 output when the emitted files differ.
- The QEMU frozen-disk discard runs nightly at 02:17 UTC, on PRs, and on manual dispatch. The full install and recreation rehearsal runs on the same schedule, on PRs, on manual dispatch, and when an RC tag is pushed. On PRs, each rehearsal runs only when its inputs change. If the PR Keycloak inputs differ from the signed-image fixture, the rehearsal first builds the candidate Keycloak image and verifies startup and realm bootstrap in the disposable stack. See the [nightly installer workflow](.github/workflows/nightly-install.yml) and [publication and evidence rules](docs/release.md#nightly-installer-evidence).
  For a PR, the workflow skips full installation when the candidate's control API migration tree differs from the resolved publication. The job summary gives the reason and lists the changed paths. The workflow reports the rehearsal result independently of `ci-gate`.
- The [pnpm cache action](.github/actions/ci-pnpm/action.yml) saves pnpm dependency and service build caches on main pushes only. A workspace dependency cache miss clears partial module directories before the frozen install. PostgreSQL integration and portal integration always force clean service builds.
- Run CI on free GitHub-hosted runners. Cancel older CI runs only for the same PR. Privacy scans never cancel, because each run screens only its own event's text and commits. Keep workflow permissions read-only at the top level, grant writes per job, and pin actions by full commit SHA. Prohibit `pull_request_target`. Fork PRs receive no secrets.
- Set job time limits from the measured p95 plus 25 percent, rounded up to a whole minute. Review limits monthly. A higher limit needs new measurements in a separate PR. See the [CI timing sample](.github/ci-timings.json) and [current coverage](#deviations).
- The [workflow lint job](.github/workflows/ci.yml) verifies the pinned actionlint and ShellCheck archives and the Pyflakes wheel by SHA-256, then checks all three tool versions. It uses the pinned actionlint fork for GitHub's `concurrency.queue` syntax while [upstream support](https://github.com/rhysd/actionlint/issues/657) is pending. On every CI run, a negative fixture verifies that actionlint reports both a ShellCheck finding in an embedded shell `run` step and a Pyflakes finding in an embedded Python `run` step. The job then requires zero findings across all workflows. ShellCheck covers supported shell `run` steps and Pyflakes covers `run` steps with the Python shell. Scripts invoked by a step and Python inside shell heredocs are outside this coverage. `ci-gate` requires the job to pass.

### Source checks

The lint job keeps the full ESLint check and runs the [source hooks](.pre-commit-config.yaml) on files added by the change. Prettier checks JavaScript, TypeScript, and CSS. Stylelint lints CSS, Ruff formats and lints Python, RuboCop checks Ruby layout and lint rules, ShellCheck and shfmt check shell scripts, and SQLFluff checks PostgreSQL syntax, style, and layout. OpenTofu formatting and validation run in the infrastructure job.

Run `pre-commit run --files <paths>` for the same source hooks locally. Use `ruff format <paths>` for Python, `shfmt -w -i 2 <paths>` for shell, or `pre-commit run ruby-format --hook-stage manual --files <paths>` for Ruby. Use `pre-commit run sql-format --hook-stage manual --files <paths>` on new SQL outside control API migrations. Applied migrations are immutable.

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

The [public privacy workflow](.github/workflows/privacy.yml) scans newly introduced commit text, paths, added lines, and PR and issue titles and bodies with generic patterns. The scan runs on branch pushes, PRs, and the merge queue. `ci-gate` fails if the scan fails on a PR, in the queue, or on a push to main. PR title or body edits trigger the privacy workflow by itself. On PRs, the workflow also requires an allowed opener. Set `PR_OPENER_ALLOWLIST` to comma- or whitespace-separated logins to override the workflow default. Issue findings appear in Actions after publication. Findings show a location, line, and rule, and redact paths that match a rule.

## Environments

| Environment | Use and data |
| --- | --- |
| `dev` | Shared test environment. Use synthetic data or sanitized test data approved by WasalX Delivery. Keep data scoped to test tenants. |
| `stg` | Release rehearsal with approved sanitized or synthetic data. Not yet in service. |
| `prod` | Live workloads with authorized tenant data. Not yet in service. |

## Releases

- The [image publication workflow](.github/workflows/branch-image.yml) runs once per eligible `main` commit with `max-parallel: 21` and records manifest completeness in the CI run summary. The [main image aliases workflow](.github/workflows/main-image-aliases.yml) uses that CI run's manifest after a successful push run. See the [image publication runbook](docs/runbooks/images-by-digest.md) for retry and alias outcomes.
- The manual [image mirror workflow](.github/workflows/mirror-images.yml) runs only from `main`. It copies the installer's pinned object-storage images to the project registry and fails on any digest mismatch.
- Publish one GitHub Release per release milestone. Cut immutable, annotated `vMAJOR.MINOR.PATCH-rc.N` and `vMAJOR.MINOR.PATCH` tags using the identity authorized by the release tag ruleset. Promote the same image digests across environments. PR builds never publish release images.
- Follow the [release criteria and nightly installer evidence rules](docs/release.md) for digest promotion, installer rehearsals, and stable release.

## Deploys

- Require a reviewed gate and one GO from the WasalX Master each for DEV host steps and the `stg` RC rehearsal. After its GO, the gate automatically releases changes that pass and must record the deployed commit, image digests, result, and GO reference. A new kind of change or a change to the gate requires a new GO.
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
| §4 Runner pickup under 5 s | Pickup measured p50 3 s and p95 354 s across 3,629 jobs. Hosted scheduling and matrix limits contribute to waits. The 60 s working target still applies. Tracked in [#511](https://github.com/WasalX/wasalx-platform/issues/511). | 2026-12-10 |
| §4 Job setup under 15 s | Setup measured p50 2 s and p95 12 s overall. PostgreSQL shards reached p95 15–16 s, mostly in service container startup. Tracked in [#511](https://github.com/WasalX/wasalx-platform/issues/511). | 2026-12-10 |
| §4 PR feedback for `ci.yml` (p50 ≤ 1 min and p95 ≤ 2 min) | On 2026-11-26, the latest 150 first-attempt PR runs yielded p50 12.8 min and p95 23.0 min (120 non-cancelled). Selected PRs still run integration and image builds. Tracked in [#511](https://github.com/WasalX/wasalx-platform/issues/511). | 2026-12-10 |
| §2 Attest artifacts with `actions/attest-build-provenance` and verify with `gh attestation verify` | Images are signed with Cosign and carry BuildKit provenance. The installer verifies them. | 2026-12-14 |
| §4 Run the full suite on main and merge groups | Main pushes skip PR-only checks and queue image builds because the merge queue already qualified the exact tree. | 2026-12-14 |
| §6 Automatic production backups and quarterly restore tests | There is no production data yet. The [control-plane backup and restore runbook](docs/runbooks/control-plane-backup-restore.md) covers enabling backups, installing the quarterly timer, and recording the first successful host rehearsal. | 2026-12-14 |
| §1 One formatter and one linter per language in CI | The Keycloak Java extension still lacks formatter and lint checks. | 2026-12-14 |
| §1 Source-style coverage | Existing files stay outside the source-style gate until the baseline format lands after the `v0.1.0-rc.1` tag. Control API migrations remain outside SQLFluff until hosted coverage proves the PostgreSQL dialect parses them. [Tracking issue #233](https://github.com/WasalX/wasalx-platform/issues/233) | 2026-12-14 |
| §6 Staging rollback rehearsal for every release candidate | Staging is not in service. Once it is, deploy each RC, roll back to the previous release, verify health, and record the rehearsal in the deployment audit. | 2026-12-14 |
