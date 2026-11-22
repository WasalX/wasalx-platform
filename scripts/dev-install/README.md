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
