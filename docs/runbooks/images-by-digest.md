# Published product images

`.github/workflows/branch-image.yml` builds the 21 canonical images from
`scripts/release/product-images.json` on GitHub-hosted Linux AMD64 runners.
The release artifact contract reads that same image list. PRs build and inspect
without registry login, package writes or OIDC. A push to `main` builds, inspects,
publishes, signs and attests with the job's `GITHUB_TOKEN` and keyless Sigstore.
Only the environment-attached `publish` job has package-write and OIDC access.
The `stg` environment has no URL; its owner must configure its branch policy for
`main` before enabling publication. This workflow does not publish production.

Each package is `ghcr.io/wasalx/<image>`, tagged with the full public commit SHA.
The `main` discovery alias advances only after signature verification and
reinspection. Resolve an alias once, then use only `@sha256:<manifest digest>`.
The `images-manifest` artifact is emitted only when all 21 verified receipts
agree on the source commit and tree. Its `images` mapping contains, per image:

- `digest`: the registry's single-platform manifest digest;
- `configDigest`: the SHA256 of the exact exported image configuration bytes;
- `commit`, `tree`, `platform`, `pullReference` and workflow/run identity;
- the source-archive digest and pre/post-publication inspection receipt.

An image inspection ID is deliberately not used as a config digest. Indexes
are refused; adding platforms requires a per-platform manifest/config mapping.
Digest receipts are build evidence, not application acceptance, native queue
qualification, release approval or deployment proof. Admission must separately
bind the reviewed workflow revision, required CI/queue evidence and approved
source tuple. Partial matrix publication cannot authorize an incomplete release.

## Public visibility and anonymous pulls

Repository visibility does not set package visibility. After first publication,
the package owner must open **WasalX organization → Packages → each of the 21
container packages → Package settings → Danger Zone → Change visibility →
Public**. Confirm this separately for every package. No organization setting is
changed by this workflow. It creates no pull token and requires no registry
credential on a consuming machine.

Before admission, prove an anonymous pull using an empty Docker configuration:

```sh
DOCKER_CONFIG="$(mktemp -d)" docker pull ghcr.io/wasalx/<image>@sha256:<digest>
```

The first signed publication, visibility change, anonymous pull and consuming
runtime verification remain unproven until they actually run. A PR build cannot
prove any of them. Preserve the previous verified manifest/config pair for rollback.

## Signature and provenance

Cosign is pinned to v3.0.6 and its Linux AMD64 SHA256 in the workflow. The
certificate identity is exactly:

`https://github.com/WasalX/wasalx-platform/.github/workflows/branch-image.yml@refs/heads/main`

The OIDC issuer is `https://token.actions.githubusercontent.com`. Verify both the
signature and `slsaprovenance` attestation for the selected digest, then validate
the predicate's public commit/tree, config digest, workflow SHA and inspection
seal against admission policy. Origin verification alone does not prove source
honesty or release approval. Sigstore verification failure means no admission.

## Public build inputs and inspection

Build contexts come only from an exact public Git archive. The configurator adds
the public add-on pinned by `zammad-addon.json`, using the existing fetch helper;
its package builder verifies the expected package hash. Zammad fetches its pinned
public add-on inside its Dockerfile. Public dependency registries and the reviewed
Dockerfiles remain build inputs. No private overlay, runner directory, registry
override, secret/SSH mount or authenticated cache is supplied to the builder.
Default BuildKit provenance is disabled; the inspected public predicate is
attested explicitly instead.

The same inspector runs before login/push and after pulling the published digest.
It checks exact labels and environment against public Dockerfile declarations
and the digest-pinned final base, inspects full history and Docker-save config,
verifies every uncompressed layer digest, and scans added layer members/content
for credential material and prohibited configuration paths. Base layers inherit
trust from the pinned public base. Public-source input custody is the primary
privacy boundary; the additional credential scan is not a proof that arbitrary
candidate code or a compromised public dependency cannot disclose information.
Any metadata mismatch, scan finding or digest change fails publication/admission.
The workflow never connects to or changes a consuming machine.
