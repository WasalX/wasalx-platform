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

Held containers may retain historical restart counts. Each count is recorded
in `services[].restartCount`; non-held containers still require zero. Release
refuses a sender or prerequisite whose current count differs from its record.
The pre-start check binds that history; starting a container resets its count
to zero, and any non-zero count after the phase is refused. Held-stack smoke
preserves recorded counts only for the same still-held container; new containers
must have zero restarts.

## Release a held sender

Set `WASALX_TEST_RECIPIENT_ALLOWLIST` to `[]` or the owner's test numbers as a JSON array; missing or empty refuses all recipients in every environment, malformed values refuse startup, and only the explicit literal `*` disables the fence for unrestricted production.

Run from an exact clean candidate on the approved qualification host, with
the private environment and digest-bound preimage produced by held installation:

Set `WASALX_INSTALL_EXPECTED_HOSTNAME` in the operator process environment to
the approved guest hostname before every installer stage or full stack
verification. The hostname must match exactly; missing, empty or mismatched
values refuse before installer actions. There is no default.

For a guarded DEV install, pass `--dev-skip-public-webhook-preflight` on every
installer stage that uses the Compose model. This default-off option replaces
the public webhook check with a local notice and records the skip in the run
log and stack verification receipt. It is refused for staging, production and
rehearsals. The webhook origin must still be configured.

When admitting DEV review origins with `--dev-review-origin` and
`--dev-review-identity-origin`, also set `WASALX_DEV_REVIEW_ORIGIN_SUFFIX` to the
approved hostname suffix. Keep it set for subsequent stages and full stack
verification using that DEV preimage. Both canonical HTTPS origins must match
that literal suffix and share the same hostname, with distinct origins.
Missing or empty suffix configuration refuses review-origin admission.
Supply both values privately; never commit operator hostnames or domains.

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

## Provision a full-stack invitee

Set `WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST` in the private Compose environment.
On DEV, use a JSON array of exact, approved test email addresses or `[]` to
deny all mail. For staging and production, set the explicit value `*` for
unrestricted mail. Use the same key in the invitation mailer Secret for Helm
deployments. A missing or invalid policy fails startup. Invitation deliveries
outside the list fail without retrying. Set the separate
`WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED` switch to `true` only when testing
password reset mail for an approved recipient. Leave it off for other mail
tests. Apply changes through the guarded installer procedure. On an existing
realm, run the approved Keycloak bootstrap reconciliation before testing the
self-service password reset link.

Upgrade the full Compose files and Keycloak image together. The Compose
command requires the fenced providers, so an older image fails startup.
The disposable hosted rehearsal checks the candidate Keycloak image and
bootstrap separately when it installs a signed image set from an older commit.

Before accepting an invitation, the invitee needs an email-verified account in the `wasalx` realm. Confirm control of the invitation address before provisioning.
On the full-stack host, set `private_dir` to a directory outside the checkout owned by UID 1000 with mode `0700`. Set `email_file` to a private file containing the address on one line.
Set `project` and `full_env` to the running stack's Compose project and private environment. The output filename must be new.
```sh
docker compose --env-file "$full_env" -p "$project" -f compose.yaml -f compose.full.yaml --profile full run --rm --no-deps -T \
  -v "$private_dir:/out" -e WASALX_INVITEE_OUTPUT_FILE=/out/invitee.json --entrypoint "node /bootstrap/provision-invitee.mjs" keycloak-bootstrap < "$email_file"
```
After `PASS`, share `invitee.json` privately with the verified recipient and remove the operator copy. Have the invitee change the temporary password and enroll TOTP at first sign-in, then open the invitation. If provisioning fails during or after creation, inspect the account in Keycloak before trying again.
