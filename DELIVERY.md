# WasalX delivery

WasalX Delivery owns this document. Change it through a reviewed PR.

## Branching and merging

- Use short-lived branches and open PRs against trunk `main`. Enable auto-merge to enter the protected merge queue after the exact PR head is green and any applicable review is complete. Squash through the queue.
- For the risk paths defined in the agent instructions, require one independent review of the full diff at the exact head. Reuse it for a merge-only base update with the same reviewed diff or a same-tree re-cut. Review substantive diff changes again. The queue qualifies the exact combined tree.
- Other PRs land on green. Keep `main` protected and update it only through the queue.

## Checks

- PRs run static checks, dependency review, and tests reachable from the diff. The workflow keeps a baseline lint, typecheck, test collection, and both unit shards. It selects affected integration and infrastructure lanes and narrows advisory image builds by their inputs. Unknown or shared image inputs select the full catalog.
- The queue runs the full CI suite, including PostgreSQL, portal/browser, and infrastructure checks, and accounts for all 21 images in the catalog. The merge gate is `ci-gate`, the only required check. See [ci.yml](.github/workflows/ci.yml).
- Target PR p50 under 1 minute and p95 under 2 minutes. Keep CI at zero cost on free GitHub-hosted runners. Use no paid or self-hosted runners and no `pull_request_target`. Fork PRs receive no secrets.

## Test policy

- Fix a failing test or the defect it found. Prohibit test retries to obtain green, ad hoc skips, and silent removal of tests. Replacements carry over the original assertions.
- A quarantine needs a named owner, explicit expiry, and a board item. The quarantine file is planned and tracked on the board.
- Every test file belongs to a named runner. Keep runner ownership and the coverage inventory current. The [ownership guard](tests/hosted-ci.test.mjs) detects gaps and stale entries.
- [The integration scenario registry](scripts/postgres-scenario-registry.mjs) assigns each PostgreSQL scenario to one of four shards. CI requires one report per shard and fails on unknown, missing, or duplicate scenarios.

## Privacy checks

Before every push, run the private privacy check on the diff, commits, branch name, PR title and body, and any public issue text. Require zero blocking findings and a finished scan. Report counts only. A public required CI privacy check is planned.

## Environments

| Environment | Use and data |
| --- | --- |
| ci | Disposable builds and tests with synthetic data. |
| DEV | Shared test environment. Use synthetic or approved sanitized test data and keep it scoped to test tenants. |
| staging | Release rehearsal with approved sanitized or synthetic data. Not yet in service. |
| production | Owner-approved live workloads and authorized tenant data. Not yet in service. |

## Releases

- A green `main` publication builds the catalog once and signs and attests its digests. Cut a `v*-rc.*` tag on the exact tested commit. [promote-tag.sh](scripts/release/promote-tag.sh) verifies and promotes the same digests without rebuilding.
- [Nightly install](.github/workflows/nightly-install.yml) runs on RC tags against the exact tagged commit and its complete publication. PR and scheduled rehearsals record the installer commit and the image publication separately.
- Follow the [release criteria](docs/release.md) for stable promotion. Bind the RC, qualification, approval, and release to the same commit and digests.

## Deploys

- DEV uses a pull-by-digest design. The host agent discovers eligible signed RC builds and verifies them anonymously. The host stager preloads verified images by digest. A separate relay verifies signed receipts and posts host-free deployment records. Enable automatic installs only after this path is qualified. Keep GitHub credentials off deployment hosts.
- Before changing state, verify the backup is restorable and retain the previous installed state. Require a real-stack rehearsal for the exact candidate before any probe or pre-arm code reaches DEV. Run health checks after replacement and record the deployed commit, digests, and result.
- On DEV, install on an overlay over the frozen base. On failure, use the authorized discard path to restore the previous base and verify its health. Preserve the rollback receipt. See the [installer runbook](scripts/dev-install/README.md).
- Staging rehearses the RC. Production receives the approved stable release only after explicit owner approval. Record health and recovery evidence for the target environment.

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
