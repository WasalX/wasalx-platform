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

Generate install and discard budgets from complete, successful host receipts. The
generator takes the maximum elapsed time for each phase and rounds 125% of that
time up to whole seconds. The install registration reserves both budgets.

```sh
python3 -I -B scripts/dev-install/templates/host-maintenance.py lease-budgets \
  "$INSTALL_RAW" "$DISCARD_RAW" > "$LEASE_BUDGETS"
python3 -I -B scripts/dev-install/render.py --host-identity "$HOST_IDENTITY" \
  --lease-budgets "$LEASE_BUDGETS" --run-id "$RUN_ID" --commit "$COMMIT" --output "$HOST_PACKET"
```

The host identity fields are in `fixtures/host-identity.example.json`. The signed
launcher verifies the seal and stages the rendered host files with the approved
guest payload and `DEV-SHA256SUMS`. Keep the host packet private and separate
from the guest packet. Use a root-owned mode-0700 `DISK_STATE` directory that
persists across runs, outside the support directories.

- The post-create, pre-boot gate requires the immutable flag, exact TOP identity,
  `qemu-img check` and the pinned backing chain. It checks identity before and
  after the QEMU commands. The hash is recorded when a new offline generation
  is sealed and checked again before a commit.
- Schedule `overlay-action.sh audit "$STATE"` daily under the approved host
  lease while the generation is frozen. An audit overdue by 24 hours blocks
  the disk proof. TOP can run writable after a guarded restore. Its next clean
  shutdown starts a new generation. A persistent `frozen-top.hold` blocks new
  proof attempts until the recorded failure is resolved.
- The operation journal records intent before clearing immutability. A restarted
  rollback re-proves a parked TOP with its recorded hash or re-proves the running
  TOP drive, guard and held state. An interrupted commit without a completed
  generation receipt stops for operator recovery.
- Once the previous lease is closed, archive its support directory with
  `host-maintenance.py archive-support "$PREVIOUS_STATE" "$ARCHIVE_ROOT" "$PREVIOUS_RUN_ID" "$TERMINAL_RAW_NAME"`.
  The archive root must already be private and on the same filesystem.

The real-QEMU nightly uses a scratch ext4 filesystem and a boot-sector guard stub.
Use the signed host qualification to measure the live phase budgets.
