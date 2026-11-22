# WasalX delivery

WasalX Delivery owns this document. Change it through a reviewed PR.

## Branching and merging

- Use short-lived branches and open PRs against trunk `main`. WasalX Delivery enables auto-merge to enter the protected merge queue after the exact PR head is green and any applicable review is complete. Squash through the queue.
- If the PR head changes after auto-merge is enabled or a review sends the PR back, disable auto-merge and remove the PR from the merge queue. Check queue membership directly because a queued PR shows no auto-merge request.
- For the risk paths defined in the agent instructions, require one Opus 5.5 high verdict at the exact head from an independent review of the full diff. Reuse it for a merge-only base update with the same reviewed diff or a same-tree re-cut. Review substantive diff changes again. The queue qualifies the exact combined tree.
- Other PRs land on green. Keep `main` protected and update it only through the queue.

## Checks

- PRs run lint, typecheck, test collection, both unit shards, and dependency review. On a PR, PostgreSQL and portal integration run when a file on the fixed path list in [ci.yml](.github/workflows/ci.yml) changes or CI cannot verify the diff. Otherwise, both first run in the merge queue. CI selects infrastructure jobs by path and narrows advisory image builds by their inputs, with `max-parallel: 8`. Unknown or shared image inputs select the full catalog.
- The queue runs the full CI suite, including PostgreSQL, portal/browser, and infrastructure checks, and accounts for every image in the catalog with `max-parallel: 21`. The merge gate is `ci-gate`, the only required check.
- The advisory [TypeScript comparison](.github/workflows/typescript-comparison.yml) compares TypeScript 5 and 7 diagnostics, compiler time, and service output on the PR candidate and its main baseline. It runs the unit suite on TypeScript 7 output when the emitted files differ.
- The [pnpm cache action](.github/actions/ci-pnpm/action.yml) saves pnpm dependency and service build caches on main pushes only. PostgreSQL integration and portal integration always force clean service builds.
- Run CI on GitHub-hosted runners. Prohibit `pull_request_target`. Fork PRs receive no secrets.

## Test policy

- Fix a failing test or the defect it found. Prohibit test retries to obtain green, ad hoc skips, and silent removal of tests. Replacements carry over the original assertions.
- A quarantine needs a named maintainer, explicit expiry, and a board item. The quarantine file is planned and tracked on the board.
- Every test file belongs to a named runner. Keep runner ownership and the coverage inventory current. The [ownership guard](tests/hosted-ci.test.mjs) detects gaps and stale entries.
- [The integration scenario registry](scripts/postgres-scenario-registry.mjs) assigns each PostgreSQL scenario to one of four shards. CI requires one report per shard and fails on unknown, missing, or duplicate scenarios.

## Privacy checks

Before every push, run the private privacy check on the diff, commits, branch name, PR title and body, and any public issue text. Require zero blocking findings and a finished scan. Report counts only. A public required CI privacy check is planned.

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

- To record a DEV deployment, manually dispatch [deploy.yml](.github/workflows/deploy.yml) from `main` with environment `dev` and a 40-hex SHA for a `main` commit.
- The stager and relay are planned host-side components run by the Servers lead, outside this repo.
- Before changing state, verify the backup is restorable and retain the previous installed state. Require a real-stack rehearsal for the exact candidate before any probe or pre-arm code reaches DEV. Run health checks after replacement and record the deployed commit, digests, and result.
- On DEV, install on an overlay over the frozen base. On failure, use the authorized discard path to restore the previous base and verify its health. Preserve the rollback receipt. See the [installer runbook](scripts/dev-install/README.md).
- WasalX Delivery approves non-production deployments and DEV host steps. Staging rehearses the RC. Obtain explicit owner approval for the production deployment of a stable release. Record health and recovery evidence for the target environment.

## DEV safety rules

- Prove the guard after every boot before proceeding. Verify that held services remain stopped. Keep the preimage guard at 60 seconds.
- Hold the frozen-disk lock, verify the immutable flag and exact disk identity, and check the backing chain and disk integrity. Compute a full hash for each new base version, before committing a change to the base, and daily while frozen.
- Stop on any failed proof. Preserve the evidence and use the authorized recovery path before admitting another attempt.

## Hotfixes

Open an issue, submit a PR to `main`, obtain the independent risk review, and pass the same queue gate. Cut an RC tag for the tested fix and validate it. Obtain the owner's approval before shipping the stable fix to production.

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
