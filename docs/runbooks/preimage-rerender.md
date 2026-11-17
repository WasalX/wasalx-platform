# Compose preimage re-rendering

Upstream analysis is pinned to
**docker/compose v2.40.3**, which pins compose-go **v2.9.1** in
[go.mod](https://github.com/docker/compose/blob/v2.40.3/go.mod#L11).

## Complete pre-hash differences

| Family | Upstream source and behavior | Handling |
| --- | --- | --- |
| Shared namespaces | [`ensureService`, `resolveServiceReferences`, `resolveSharedNamespaces`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/convergence.go#L113): `network_mode`, `ipc`, `pid` `service:X` become `container:<X's first observed container ID>` before create/recreate and comparison. | Resolve from the same-project owned census; refuse absent or ambiguous X. Existing single-container-per-service census policy remains. |
| Inherited volumes | [`resolveVolumeFrom`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/convergence.go#L280): `X[:mode]` becomes X's bare container ID; `container:name[:mode]` becomes bare `name`. This implementation drops the suffix. Compose's native service form is `X`, not `service:X`. | Reproduce the bare-ID/name form, including suffix stripping. A service literally named `service` remains valid as `service:ro`. Add hash-only placeholder services for bare IDs so Compose's project dependency selection can load them. |
| Service environment | [`WithServices`](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/compose.go#L158) calls `WithServicesEnvironmentResolved(true)` before create/up. [`runHash`](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/config.go#L404) instead loads with `WithoutEnvironmentResolution`. [`WithServicesEnvironmentResolved`](https://github.com/compose-spec/compose-go/blob/v2.9.1/types/project.go#L674) resolves inherited environment keys and service `env_file` values, then removes `env_file`. | Hash normal resolved `config --format json` output. Retain hashes of service env files, including absence of optional files, alongside the existing Compose and project env inputs. |
| Model Runner | [`create`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/create.go#L69) calls [`ensureModels` / `SetModelVariables`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/model.go#L180): inject model-name and runtime endpoint environment variables. | Explicit `models` refusal. Absent from this stack; no model-plugin probe or guessed endpoint. |
| Docker API socket | [`useAPISocket`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/apiSocket.go#L33): append the socket bind, inject default `DOCKER_CONFIG` if absent, and append the generated `#apisocket` config reference. | Explicit `use_api_socket` refusal. Absent from this stack; never read Docker credentials. |

[`prepareLabels`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/create.go#L477)
and `runHash` both use the same
[`ServiceHash`](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/hash.go#L27):
clear **build**, **pull_policy**, **scale**, **deploy.replicas**, **depends_on**,
and **profiles**, then Go JSON marshal and SHA-256. `deploy` itself is retained.
Those exclusions do not create a discrepancy between the two paths. this implementation
continues to call Compose's own hash implementation instead of reproducing Go
serialization in JavaScript.

[`applyPlatforms`](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/options.go#L38)
runs in both `runHash` and create options; it applies `DOCKER_DEFAULT_PLATFORM`
to build services and normalizes build platforms. The original environment and
build configuration are retained for it. Compose-generated custom labels,
image digest labels, container numbers and dependency labels do not add
service-hash inputs. Network/volume hashes are separate. Image defaults, proxy
environment, mount inheritance, engine namespace/network configuration, and
other Docker create options are applied after `prepareLabels`; they do not
change this service label hash.

The private resolved-model file is an equivalent alternative to layering an
override onto the original chain: it avoids Compose's list-merge behavior for
`volumes_from` and removes already-consumed service env files. It is temporary,
0600 inside a 0700 directory outside candidate/evidence trees, and is always
removed. The hash helper and diagnostic CLI require root on POSIX, so target
scratch files are root-owned. The normal rendered model
escapes literal dollars for reloading; the hash reload therefore interpolates
once, with normalization disabled. Only `config --hash` consumes this file;
recreation always uses the original retained chain.

In v2.40.3 `--no-env-resolution` alone still consumes service env files through
the typed loader. Input discovery therefore also uses `--no-interpolate`, the
raw-model path in [`runConfigNoInterpolate`](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/config.go#L257).
An env-file path containing dollar interpolation is explicitly refused rather
than recorded with an unverified file binding. This stack has no service
`env_file` paths. ## Version differences

Do not assume the entire v2.2x series has v2.40 hash semantics.
[`v2.20.3 ServiceHash`](https://github.com/docker/compose/blob/v2.20.3/pkg/compose/hash.go#L27)
normalizes scale and replicas to one, creates an empty deploy object, and keeps
dependencies/profiles. Its
[`prepareVolumes` / `getVolumesFrom`](https://github.com/docker/compose/blob/v2.20.3/pkg/compose/create.go#L126)
uses generated container names with a `container:` prefix, rather than the
modern bare-ID volume form. In
[`v2.29.7 ServiceHash`](https://github.com/docker/compose/blob/v2.29.7/pkg/compose/hash.go#L27),
scale/replicas and dependencies are cleared but profiles are still retained;
its namespace/volume resolution already matches v2.40.3
([`resolveVolumeFrom` / `resolveSharedNamespaces`](https://github.com/docker/compose/blob/v2.29.7/pkg/compose/convergence.go#L264)).
No version-specific hash is hard-coded in this implementation, but semantic compatibility with
older reference algorithms is not claimed: the CLI/label version check and
exact resulting hash remain fail-closed gates. The qualified target is 2.40.3.

## Rollback and diagnostic gate

Preimages retain the symbolic rendered references and their captured service/ID
bindings. Recreate referenced services first. After each creation, resolve from
the fresh census and compare the expected hash and namespace HostConfig values
against the new IDs. Retained containers cannot silently keep stale bindings.
External namespace and inherited-volume recreation refusals, effect/migration
guards, original input hashes and immutable-image checks remain enforced.
The order-independent mount comparison remains in place and also applies to
recreated-container comparisons.

From the scratch guest, using the root-owned candidate source and the same
Docker endpoint/access environment as capture:

```sh
node scripts/release/diagnose-preimage-rerender.mjs --project-name <project> --repository <candidate-repository>
```

The diagnostic uses only owned container/image inspection, version reads and
Compose config commands. It writes no stack or capture state, emits no env
values, and prints one `MATCH` or `MISMATCH suspected=<family>` line per owned
container. A changing census or access/tooling failure refuses the diagnostic.
Exit 0 requires every service to match. Local contract tests do not establish
runtime rollback or provider qualification.
