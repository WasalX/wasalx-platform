# DEV install plumbing

Run the same dry-run as CI with `python3 -I -B scripts/dev-install/test_dryrun.py --container`.
It uses the example identity, a disposable Git bundle, and network-disabled dispatcher and guest containers.
The fixture runs the native bind-mount, hostname, and review-origin checks and exercises a hung capture
holding the native stage lock. SSH and Compose calls use recording fakes.

The renderer takes an operator-owned identity file with the fields in
`fixtures/identity.example.json`. Keep the real identity and rendered packet private.

```sh
python3 -I -B scripts/dev-install/render.py --identity "$IDENTITY" --output "$PACKET" \
  --tag "$RUN_TAG" --commit "$COMMIT" --tree "$TREE" --env-sha256 "$ENV_SHA256"
```

The output directory must be fresh. Verify its `SHA256SUMS` against the sealed packet
before invoking its scripts with `python3 -I -B`.

- `dispatch.py` checks the guest hostname over pinned SSH.
- `receive.py` checks out the exact commit and tree from the transferred `signed-<tag>-dev-incoming-source.bundle` in the guest's home.
- `probe.py` takes the native read-only preimage capture using the installed environment.

The signed runbook owns approval, transport, and engine actions. These scripts provide the
checkout and preflight steps for that runbook.

The read-only running-stack scan is `node scripts/dev-install/probe.mjs --project-name "$PROJECT" --env-file "$FULL_ENV"`.
Run it as root from the candidate checkout, with the deployed Compose inputs in a separate tree.
Use `--repository` to select the candidate checkout and repeat `--compose-file` to add overlays.
`--held-services` overrides the DEV hold set with a comma-separated list. Nightly passes an empty list.
Keep the JSON report private. The nightly logs only the counts and census result or a sanitized failure.


## DEV pull report agent

Render the report packet from the reviewed checkout with a private pull identity.

```sh
python3 -I -B scripts/dev-install/render.py --pull-identity "$PULL_IDENTITY" --output "$PACKET"
```

The pull identity supplies these fields.

- `mode` set to `report`.
- `install_dir` for the installed packet, `receipt_key` for the Servers-generated Ed25519 key, and
  `cosign`, `trusted_root`, and `trusted_root_sha256` for the pinned Linux amd64 verification tools.
- `staging_dir` on `staging_mount` (a separate SSD filesystem), `lane_lock` for the
  existing nonblocking host lane lock outside the service's private temporary directory, and
  `stage_guard` for the host's read-only engine and competing-work checks. The guard runs while
  the agent holds the lock and must return zero only when staging can proceed.

Servers verifies `SHA256SUMS` before installing the root-owned packet and units. The
`wasalx-dev-pull` service account needs read access to the installed tools, trust root, and
lane lock, and write access to the staging directory. Keep `pull-config.json` and the
key root-only. Systemd copies them into the service's private credential directory. Use
host egress policy for the public GitHub API and release assets, GHCR and its blob CDN.
The service checks signed bundles against its pinned Sigstore trust root. GitHub
discovery and GHCR pulls use anonymous access.

The timer checks at ten-minute calendar boundaries. The service only stages during
23:00–15:00 UTC. A successful staging directory is named by commit and contains
`images-manifest.json`, `images.tar`, `hosted-evidence.tar`, `host-export.json` and
`SHA256SUMS`. An interrupted transfer retains its verified or resumable blobs in
`<commit>.partial`. Servers manages retention under the shared lane lock.

The outbox is `outbox` under the unit's `StateDirectory`. Its commit marker is
`<20-digit-seq>.json` with a matching `<20-digit-seq>.json.sig`. Sequence starts at
1 with an all-zero `prev_sha256`. Each following receipt hashes the exact previous
JSON bytes. The SSH signature namespace is `wasalx-dev-receipt` and the relay pins its principal in the private allowed-signers file. Schema version 1 has `schema_version`, `seq`,
`prev_sha256`, `attempt_id`, `tag`, `commit`, `manifest_sha256`, `code`, and
`stage_stamps` with UTC `started_at` and `recorded_at`. The code is `ELIGIBLE`,
`VERIFIED`, `STAGED`, `HOLD_VERIFY`, or `HOLD_STAGING`. Retain both files in
sequence. Report mode stops after staging and recording the receipt.

The nightly PR leg binds the exact PR head and its tree through the anonymous GitHub
API and independently verifies real GHCR/Sigstore bytes for the recorded main
publication. The release path needs an RC asset plus an exact-commit nightly job
with a successful `Confirm census PASS` step. This proof begins with a qualifying RC.
