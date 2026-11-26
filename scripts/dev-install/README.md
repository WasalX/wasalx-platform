# DEV install plumbing

Run the same dry-run as CI with `python3 -I -B scripts/dev-install/test_dryrun.py --container`.
It uses the example identity, a disposable Git bundle, and network-disabled dispatcher and guest containers.
The fixture runs the native bind-mount, hostname, and review-origin checks and exercises a hung capture
holding the native stage lock. SSH and Compose calls use recording fakes.
For each container, the image check or pull, creation, and attached run share one 120-second deadline.
The log reports Docker phase durations, a bounded list of fixture checkpoints, and the cleanup result.
If creation or the attached run fails, a separate cleanup budget targets the named fixture container.
After a create timeout, cleanup checks for late registration and reports an unconfirmed result
if removal cannot be verified within that budget.

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
The scan derives its expected service count from the active services in the rendered Compose model
and checks the exact service inventory before and after scanning. Keep the JSON report private.
The nightly logs only the counts and census result or a sanitized failure.

## Fresh held guest projects

Use a new `wasalx-dev-*` project with no existing containers, volumes, or networks.
After native preflight and candidate image preparation, run installer `replace`
with `--drained --dev-fresh-held`, then `smoke` with `--dev-fresh-held`.
The installer creates the DEV hold set and one-shot prerequisites used only by
held services without starting them. Smoke requires every held container to remain
in Docker's `created` state. A failed replacement stays fenced for review.

For a synthetic guest, pass `--dev-simulator` through preflight, image preparation,
replacement, and smoke. It uses the nightly Compose adjustments and puts the WAHA
simulator on the internal connectors network. Use synthetic credentials and private
mail endpoints. The [simulation env generator](../release/generate-simulation-env.py)
supplies the WAHA fixture settings. Set unused host ports in the private env file
before preflight. Keep the smoke receipt `dev-fresh-held-stack-<project>.json` with the guest
evidence.

## Signed host packet

Render the host lease budgets directly from raw host receipts. The renderer takes
125% of the longest successful install and discard lease for each phase, then adds
one full TOP hash allowance to discard. Install registration reserves both budgets.
Registration estimates a full hash using the slowest measured seconds per GB and
the current TOP file length in bytes. Only timings emitted around the actual hash
with its byte count qualify. Whole-second budgets round up.

Omit the receipt arguments for the first packet. Until there is a stamped install
PASS, a stamped discard PASS and a full-hash measurement, the packet uses the
reviewed reservations of 13,400 seconds for install and 11,400 seconds for discard.

Register an approved commit with `register.sh commit "$STATE"`. Its lease reserves
125% of a hash at the current TOP size, a hash at TOP plus overlay size, the
slowest successful `qemu-img commit` rate scaled to the overlay size, and the
longest successful TOP restore. The lease has a 25,050-second minimum and must
fit before `DISCARD_LIMIT`. Missing measurements or a commit timing without
overlay bytes select `LEASE_BUDGET_SOURCE=fallback-commit`.
The 2026-11-22 DEV cycle measurements put a full hash of ~115 GB at 2,880 seconds
(~40 MB/s). The fallback allows two hashes, one assumed full-disk commit pass
of 2,880 seconds, and the reviewed 11,400-second discard/restore reservation,
with 25% headroom on the sum.

Record the independently checked SHA-256 of each raw receipt in the host identity's
`LEASE_RECEIPT_SHA256S` array, in the order passed below. The renderer checks the
exact receipt bytes against that array before reading their timings. Each new raw
receipt records an application-specific host identifier, TOP filesystem device and
inode, and the UTC capture instant in epoch nanoseconds.

Set the optional `LEASE_RECEIPT_POLICY` object in the private host identity to
enable measured budgets. From the verified packet, run
`python3 -I -B host-maintenance.py timing-origin "$TOP"` on the intended host.
Use its `host_sha256` string, `disk_device` and `disk_inode` integers, and set a positive
`max_age_seconds`. Collect those expected values from the intended host and disk
independently of the timing receipts. Without a policy, or if any requested
receipt is unbound, belongs to another host or disk, is from the future, or is
older than the configured maximum, the renderer uses the documented fallback
leases. The sealed host environment records the policy, input hashes and budget
sources.

```sh
python3 -I -B scripts/dev-install/render.py --host-identity "$HOST_IDENTITY" \
  --lease-receipt "$INSTALL_RAW" --lease-receipt "$DISCARD_RAW" \
  --run-id "$RUN_ID" --commit "$COMMIT" --output "$HOST_PACKET"
```

The host identity fields are in `fixtures/host-identity.example.json`. The signed
launcher verifies the seal and stages the rendered host files with the approved
guest payload and `DEV-SHA256SUMS`. Keep the host packet private and separate
from the guest packet. Use a root-owned mode-0700 `DISK_STATE` directory that
persists across runs, outside the support directories.

- The post-create, pre-boot gate requires the immutable flag, exact identity for TOP
  and every backing layer, `qemu-img check` and the pinned backing chain.
  It checks identity before and after the QEMU commands. The TOP hash is recorded
  when a new offline generation is sealed and checked again before a commit.
- When the frozen TOP audit is more than 24 hours old, the next proof hashes TOP
  inline. Discard can continue if that hash matches. A mismatch creates
  `frozen-top.hold`, which blocks restore and further proof attempts until the
  failure is resolved. TOP can run writable after a guarded restore. Its next clean
  shutdown starts a new generation.
- The immutable flag and filesystem identity checks protect against accidental
  changes. Privileged access can forge ctime. The daily audit, commit or recovery
  hash is the only way to detect raw block-device writes to TOP that leave its
  filesystem metadata unchanged.
- The operation journal records intent before clearing immutability. A restarted
  rollback re-proves a parked TOP with its recorded hash or re-proves the running
  TOP drive, guard and held state. An interrupted commit without a completed
  generation receipt stops for operator recovery.
- Once the previous lease is closed, archive its support directory with
  `host-maintenance.py archive-support "$PREVIOUS_STATE" "$ARCHIVE_ROOT" "$PREVIOUS_RUN_ID" "$TERMINAL_RAW_NAME"`.
  The archive root must already be private and on the same filesystem.

The real-QEMU nightly uses a scratch ext4 filesystem and a boot-sector guard stub.
Use the signed host qualification to measure the live phase budgets.

## DEV step lock

Set `DEV_STEP_LOCK` in the private host identity to the absolute path of the
host-provided marker. WasalX holds an exclusive, nonblocking `flock` on that
path from before the first action until the step exits, including if it is killed.
Lease units, install/discard, overlay actions and host-side guest phases share
this lock. A competing step reports `HOLD_DEV_STEP_BUSY` and exits 75.
After acquiring the lock, a writer records its run ID, step, UTC start time
and lock device and inode in the adjacent `$DEV_STEP_LOCK.run` file. An
interrupted writer leaves this record in place. A new acquisition reports
`HOLD_DEV_STEP_UNRESOLVED run_id=<run-id>` and exits 75 while the record
remains. Nested phases share the original locked descriptor.

The controller run ID is the lowercase SHA-256 of the compact UTF-8 JSON
array `[carrier_sha256, cutover_authority_json_sha256]`. Platform leases use
their existing `YYYYMMDDTHHMMSSZ` run ID.

Use the sealed host helper with the same exported host identity. Open
descriptor 7 in the caller and keep it open for the entire action:

```sh
exec 7<"$DEV_STEP_LOCK" || exit 75
bash "$DEV_STEP_HELPER" acquire "$RUN_ID" "$STEP" || exit $?
```

Exit 0 admits the action. Exit 75 reports a named hold. The action then
runs in the caller and keeps its own exit status.

After the action releases descriptor 7, use
`bash "$DEV_STEP_HELPER" handback "$RUN_ID" "$EVIDENCE_DIR"` to clear the
record. The evidence directory holds four JSON files. Each contains the
same `run_id`.

| File | Additional fields |
| --- | --- |
| `terminal.json` | `status` is `terminal`. |
| `stop.json` | `status` is `stopped` or `no-work`. |
| `handback.json` | `released` is `true`. `lock_device` and `lock_inode` identify the released flock. `record_sha256`, `terminal_sha256` and `stop_sha256` hash the exact run record and evidence bytes. |
| `completion.json` | `handback_sha256` hashes the exact handback record bytes. |

The helper checks the evidence and acquires the same lock independently
before clearing the record. Success prints `DEV_STEP_HANDBACK=PASS` and
exits 0. Missing or invalid handback evidence prints
`HOLD_DEV_STEP_HANDBACK` and exits 75. A terminal marker, owner exit or an
old start time leaves the record in place.

D1 uses the same path and treats a failed `flock -n "$DEV_STEP_LOCK" true` probe as busy.
The host provisions the dedicated root-owned mode-0755 directory and empty
root-owned marker via `tmpfiles.d`. Steps open the marker read-only. Leave it
in place between steps so every probe uses the same inode. A missing directory
or marker holds the step with `HOLD_DEV_STEP_MARKER_DIR` or `HOLD_DEV_STEP_MARKER`.
The pull report agent and standing services such as the VM and forwards never
take this lock.

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
staging windows and disk admission.

The agent publishes one numbered `<20-digit-seq>.json` file per verified tag in
`handover-outbox` under the unit's `StateDirectory`. The
`ot3.wasalx.d1-handover/v1` receipt identifies the tag, exact commit and tree, release
asset digest, and successful nightly run and attempt. Receipts with
`source: b2-verified` require a non-null `release_asset_digest` of the form
`sha256:<64 lowercase hex digits>`. Only operator hand-overs may omit the digest
value by setting it to null.

Image refs are sorted and unique. They contain the 21 verified product digests and
the third-party Compose references at that commit. Each uses
`name@sha256:<64 lowercase hex digits>`. The agent drops Compose tags and Docker Hub
host and `library/` prefixes. Other registry prefixes are retained. Each row
records its origin and its manifest media type when available from an anonymous
registry HEAD.

An outbox containing older receipts that violate this format fails startup. Before
clearing it, archive the whole outbox and coordinate a new sequence with the
consumer. A fresh outbox starts at sequence 1.

The first receipt starts at sequence 1 with a null previous hash. Each subsequent
receipt hashes the entire prior canonical JSON object, including its signature.
The embedded signature is base64 of the armored Ed25519 SSHSIG over canonical JSON
without the signature field. Canonical JSON uses sorted keys, compact separators,
ASCII escaping, UTF-8 encoding, and no trailing newline. D1 verifies with namespace
`wasalx-dev-receipt` and principal `wasalx-dev-pull` using its pinned allowed-signers
file. Keep the receipt files in sequence.

The nightly PR leg binds the exact PR head and its tree through the anonymous GitHub
API and independently verifies real GHCR/Sigstore bytes for the recorded main
publication. The verifier uses the pinned trust root and validates the staged
manifest, signature and provenance offline. The report agent stages those public
GHCR bytes once per candidate. Registry credentials stay with the registry on
redirects to another origin. Staging and offline verification have deadlines
inside the agent watchdog, so the failing command and its redacted reason appear
in the service journal. Nightly stages the bytes once for both the live pull
check and the rehearsal. The release path requires the RC asset and a successful census on the
latest nightly push run for that tag and commit. The census step checks the installer
commit, tree and published image commit against the rehearsal log.

### Re-pin Sigstore after a trusted-root rotation

The verifier checks the installed root against the packet's
`trusted_root_sha256` before using Cosign. A mismatch fails the unit and emits
`REPORT_TRUST_ROOT_MISMATCH` at error priority in the journal. The outbox keeps
its existing receipts. Before enabling unattended ticks, route failed runs of
`wasalx-dev-pull.service` to the host's alert destination and check the error
with `journalctl -u wasalx-dev-pull.service -p err`. Investigate verification
failures even when the installed checksum still matches the old pin.

1. On the trusted networked machine, verify the Linux amd64 Cosign binary
   against the pin used by the [pull verifier](pull-verify.mjs).
   Set `COSIGN` to that verified binary's absolute path. The cache path below
   applies to the pinned Cosign v3.1.4. Initialize a clean TUF cache and record
   the SHA-256 of the authenticated target.

   ```sh
   export TUF_ROOT="$(mktemp -d)"
   "$COSIGN" initialize
   root="$TUF_ROOT/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"
   sha256sum "$root"
   ```

2. Stage the authenticated root at a new read-only path for the pull account.
   Set the private pull identity's `trusted_root` and `trusted_root_sha256`
   to that path and recorded hash. Render a new report packet, verify
   `SHA256SUMS`, and have the exact packet and root reviewed and approved.
3. Install the approved packet and root together, retaining the receipt key and
   outbox. Under the authorized qualification window, verify the next eligible
   candidate and confirm D1 accepts the signed receipt before resuming the timer.
