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
The `images-manifest` artifact requires one receipt for every matrix row, all
bound to the same commit and tree. While the add-on source is unset, 19 images
are published and the two dependent images appear under `pending`, explicitly
without digests; `publicationComplete` is false. Green CI does not claim those
two images built. Its `images` mapping contains, per published image:

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
the package owner must open **WasalX organization → Packages → each published
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

The single repository variable **`PUBLIC_ADDON_SOURCE`** enables the two dependent
images. It must be JSON with exactly `repository` (an anonymously readable public
GitHub HTTPS repository URL) and `commit` (a full 40-character lowercase commit
SHA). For example, its shape is
`{"repository":"https://github.com/<owner>/<repository>","commit":"<full commit SHA>"}`.
No source is approved by this workflow. Unset means **pending add-on source** for
Zammad and workspace-configurator; all other images still build and publish.
Malformed nonempty values fail the plan instead of silently skipping. The plan
captures this source in the matrix so later variable changes cannot substitute
a different dependency during that run. The supplied revision must provide
`zammad-package`, `build/zammad`, Ruby contracts under `tests/`, and `tests/fixtures`,
matching the existing package version/hash in `zammad-addon.json`. No secret,
deploy key or token is supplied to reach the add-on. The owner controls this
variable; the workflow does not modify repository or organization settings.

The two dependent images carry `LICENSE`, `COPYING` and `THIRD-PARTY-NOTICES`
from that exact source under `/usr/share/licenses/wasalx-zammad-addon/`. The
package version/hash is unchanged; the additional public licence files are
copied separately in the sealed effective Dockerfile.
The inspector checks all three exported file hashes before and after publication.

Build contexts come only from an exact public Git archive. The configurator and
Zammad require anonymous access to the source selected above, using
the existing fetch helper for package/test inputs; the package builder verifies
the expected package hash. Zammad also fetches its pinned add-on inside its
Dockerfile after replacing its original add-on URL/commit with the approved
public tuple in the archived build context. The effective Dockerfile digest and
add-on tuple are recorded in the receipt and attestation. If a configured source
is unavailable anonymously, those builds fail; this workflow supplies no credential
and never publishes private source.
Public dependency registries and the reviewed
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

The content contract admits one publicly distributed demo private key in Cloudflared's
built-in hello-world TLS service, only in `usr/local/bin/cloudflared` for the
`production-cloudflared` image. Its entire PEM content SHA256 is
`17ac4c2ca3deb87202cd2c101d4da9d4f4c0ec3d51a0381729329102b28e61a4`, verified
against `tlsconfig/hello_ca.go` in the Dockerfile's checksum-pinned public
2026.9.1 source archive. Other keys, changed content or a changed archive pin
fail closed. No runtime deployment credential is exempted.

Zammad copies `/usr/local` and `/opt/zammad` from its approved public upstream
image. For those copied paths, the inspector resolves only the pinned
`ZAMMAD_BASE_IMAGE`, anonymously streams its OCI layers, verifies the manifest
and every compressed layer digest, and records full PEM hashes at their source
paths. Only identical full content at that same copied path is admitted. An
unmatched key, unrelated path, different base pin, invalid manifest or altered
layer fails closed. The receipt seals the resulting public-content map; key
bytes and anonymous registry tokens are never written or logged.
