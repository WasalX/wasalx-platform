# DEV install plumbing

Run the same dry-run as CI with `python3 -I -B scripts/dev-install/test_dryrun.py --container`.
It uses the example identity, a disposable Git bundle, and a network-disabled container.
The native bind-mount readability check runs against the resulting checkout. The fixture
records SSH and Compose calls and simulates a hung capture that holds the stage lock.

The renderer takes an operator-owned identity file with the fields in
`fixtures/identity.example.json`. Keep the real identity and rendered packet private.

```sh
python3 -I -B scripts/dev-install/render.py --identity "$IDENTITY" --output "$PACKET" \
  --tag "$RUN_TAG" --commit "$COMMIT" --tree "$TREE" --env-sha256 "$ENV_SHA256"
```

The output directory must be fresh. Verify its `SHA256SUMS` against the sealed packet
before invoking its scripts with `python3 -I -B`.

- `dispatch.py` checks the guest hostname over pinned SSH.
- `receive.py BUNDLE` checks out the exact commit and tree from the transferred local Git bundle.
- `probe.py` takes the native read-only preimage capture using the installed environment.

The signed runbook owns approval, transport, and engine actions. These scripts provide the
checkout and preflight steps for that runbook.
