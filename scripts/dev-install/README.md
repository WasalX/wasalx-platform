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

Servers verifies `SHA256SUMS` before installing the root-owned packet and units. The
`wasalx-dev-pull` account needs read access to the installed tools and trust root.
Keep `pull-config.json` and the receipt key root-only. Systemd loads them as private
credentials. Keep the account out of the Docker group. Discovery and verification
use anonymous public endpoints and a pinned Sigstore trust root.

The timer checks at ten-minute calendar boundaries. D1 owns image blob downloads,
staging windows, disk admission and the DEV-step marker. Servers provisions
`/run/ot3` for D1 via `tmpfiles.d`. The report agent does not acquire the marker.

The agent publishes one numbered `<20-digit-seq>.json` file per verified tag in
`handover-outbox` under the unit's `StateDirectory`. The
`ot3.wasalx.d1-handover/v1` receipt identifies the tag, exact commit and tree, release
asset digest, and successful nightly run and attempt. The sorted image references
contain the 21 verified product digests and the digest-pinned third-party Compose
references at that commit. Each row records its origin and its manifest media type
when available from an anonymous registry HEAD.

The first receipt starts at sequence 1 with a null previous hash. Each subsequent
receipt hashes the entire prior canonical JSON object, including its signature.
The embedded signature is base64 of the armored Ed25519 SSHSIG over canonical JSON
without the signature field. Canonical JSON uses sorted keys, compact separators,
ASCII escaping, UTF-8 encoding, and no trailing newline. D1 verifies with namespace
`wasalx-dev-receipt` and principal `wasalx-dev-pull` using its pinned allowed-signers
file. Keep the receipt files in sequence.

The nightly PR leg binds the exact PR head and its tree through the anonymous GitHub
API and independently verifies real GHCR/Sigstore bytes for the recorded main
publication. The release path requires the RC asset and a successful census on the
latest nightly push run for that tag and commit. The census step checks the installer
commit, tree and published image commit against the rehearsal log.
