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
exact receipt bytes against that array before reading their timings. The sealed
host environment records the same hashes and budget sources.

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
