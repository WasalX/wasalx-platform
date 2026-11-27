# WasalX releases

A release candidate (RC) is a `vX.Y.Z-rc.N` tag used to qualify a commit from
`main`. A stable release is a `vX.Y.Z` tag on that commit once it meets all six
criteria below.

1. **Published by CI.** The successful `main` push builds and inspects the
   21 catalog images from the queue-qualified commit, signs them with keyless
   Cosign, and records their digests.
   [`release.yml`](../.github/workflows/release.yml) calls
   [`promote-tag.sh`](../scripts/release/promote-tag.sh) to verify and retag
   those digests without rebuilding them. Promotion hashes each alias's raw
   registry manifest and checks it against the verified digest before publishing.
2. **Fully tested.** The merge queue passes `ci-gate` for the exact commit
   admitted to `main`, and `ci.yml` succeeds on that main push. The CI checks
   include unit tests, type checking, lint, PostgreSQL and browser integration,
   and infrastructure validation for Helm, promtool, OpenTofu, migrations, and
   the secret adapter. Dependency review runs on the pull request.
3. **Clean security state.** This platform repository and its Zammad add-on
   repository each have zero open high or critical CodeQL and Dependabot alerts.
4. **Proven as an RC.** `release.yml` publishes the RC in the `stg` GitHub
   environment. Deploy its digests to staging and install them in DEV using the
   installer's signed-image verification. DEV smoke must pass, held services
   must stay held, and rollback must be proven. Use
   [`deploy.yml`](../.github/workflows/deploy.yml) to record the staging tag
   and DEV commit in the respective GitHub environments. Complete a 24-hour
   soak with no new blocking findings.
5. **Approved through the production gate.** The owner approves each production
   deployment as the `prod` GitHub environment's required reviewer. That
   approval gives GO for the deployment. See [Deploys](../DELIVERY.md#deploys).
6. **Immutable.** GitHub release immutability is enabled and the `v*` tag
   ruleset blocks updates and deletions. Release notes must list the image
   digests. The release workflow attaches `images-manifest.json` with the
   verified digests.

Before requesting `prod` approval, the release workflow checks for a successful,
published RC for the exact commit and a successful `ci.yml` run from that
commit's push to `main`.
The [image publication runbook](runbooks/images-by-digest.md) describes the
independent `:main` discovery alias workflow. Release admission uses the
exact commit's immutable publication and CI evidence.

Live-provider qualification with real WhatsApp or Meta services and real
customers is a separate milestone that requires the owner's approval for the
paid provider accounts and access it needs. A stable
release proves the platform end to end in its own environments.

## Nightly installer evidence

Scheduled runs and manual runs without a commit input take a bounded walk of
`main` and select the newest commit from the last 24 hours with green push CI
and a publication manifest with zero pending rows. The job summary records the
selected SHA, publishing run, and number of newer commits skipped. If the
search finds no eligible publication, the rehearsal fails and reports `BLOCKED`.
The installer checks out the selected SHA and uses that commit's images.
Manual runs with a commit input require the complete publication for that exact
main SHA. RC tag runs require the publication for the commit the tag resolves to.

A failed pull verification or rehearsal logs the failing command, exit code,
and a redacted reason. The diagnostics artifact keeps phase timings and
installer control messages. Raw registry responses, credentials, and Compose
output stay out of the artifact.
The rehearsal verifies that Docker can pull the pinned registry image before
blocking egress, then requires a TCP rejection when Docker pulls the same
digest again. The blocked-egress receipt records that rejection. The census
requires the observed inventory and rerendered hashes to cover the active
services in the rehearsal's resolved Compose model.
