# Held one-shot prerequisites

A prerequisite is held when it has at least one active success-dependent and
every such dependent is in `devHeldServices`. A non-held dependent keeps the
exit-zero requirement. An unreferenced one-shot keeps its previous treatment.
The synthetic [dependency example](held-oneshot-prereqs.json) records this
classification; it is not runtime or candidate qualification evidence.

The preimage records `heldPrerequisites` and includes those prerequisites in
`heldServices`. Validation recomputes the mapping from the rendered model.
Held installation and smoke preserve stopped prerequisites and their actual
exit codes. A failed prerequisite is not successful execution evidence.

## Release a held sender

Run from an exact clean candidate on the approved qualification host, with
the private environment and digest-bound preimage produced by held installation:

```sh
node scripts/release/installer-stages.mjs release-held \
  --env-file /absolute/private/full.env \
  --project-name wasalx-live \
  --dev-preimages /absolute/private/dev-preimages.json \
  --dev-preimages-sha256 <sha256-of-that-file> \
  --service waha-gows
```

Only a recorded held sender can be selected. Cold-held admission is refused.
The normal preflight, approved host, stage lock, clean candidate, immutable-image
checks, project and retained authentication bindings still apply.

Each held prerequisite runs once with `up --no-deps --no-build --pull never
--abort-on-container-exit --exit-code-from`. Both the command and inspected
exit status must be zero. Failure leaves the sender stopped with no automatic
retry. The sender then uses `up --no-deps --no-build --pull never --detach --wait`;
running state and configured health are checked. Other preserved, non-held
services remain bound to their preimages. The original record is not rewritten.

Release ends the selected sender's stopped hold. Historical held-stack smoke
does not describe its new running state. Source-input equivalence does not
relax exact SHA, tree, Dockerfile, build-context or package identity checks.
Runtime install/release and provider acceptance require separate evidence.
