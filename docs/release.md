# WasalX releases

A release candidate (RC) is a `vX.Y.Z-rc.N` tag used to qualify a commit from
`main`. A stable release is a `vX.Y.Z` tag on that commit once it meets all six
criteria below.

1. **Built once by CI.** The successful `main` push builds all 21 images,
   signs them with keyless Cosign, and records their digests.
   [`release.yml`](../.github/workflows/release.yml) calls
   [`promote-tag.sh`](../scripts/release/promote-tag.sh) to verify and retag
   those digests without rebuilding them.
2. **Fully tested.** The merge queue passes `ci-gate`, and `ci.yml` succeeds
   on the exact `main` commit. The CI checks include unit tests, type checking,
   lint, PostgreSQL and browser integration, and infrastructure validation
   for Helm, promtool, OpenTofu, migrations, and the secret adapter. Dependency
   review runs on the pull request.
3. **Clean security state.** Both release repositories have zero open high or
   critical CodeQL alerts and zero open high or critical Dependabot alerts.
4. **Proven as an RC.** `release.yml` publishes the RC in the `stg` GitHub
   environment. Deploy its digests to staging and install them in DEV using the
   installer's signed-image verification. DEV smoke must pass, held services
   must stay held, and rollback must be proven. Use
   [`deploy.yml`](../.github/workflows/deploy.yml) to record the staging tag
   and DEV commit in the respective GitHub environments. Complete a 24-hour
   soak with no new blocking findings.
5. **Approved by the owner.** Obtain written release approval before the owner
   gives the required approval in the `prod` GitHub environment.
6. **Immutable.** GitHub release immutability is enabled and the `v*` tag
   ruleset blocks updates and deletions. Release notes must list the image
   digests. The release workflow attaches `images-manifest.json` with the
   verified digests.

Stable tag promotion requires both a successful, published RC for the exact
commit and a successful `ci.yml` run from that commit's push to `main`.

Live-provider qualification with real WhatsApp or Meta services and real
customers is a separate milestone that requires owner approval. A stable
release proves the platform end to end in its own environments.
