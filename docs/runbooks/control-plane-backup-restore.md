# Control-plane backup and restore

The [Helm backup job](../../infra/helm/wasalx/templates/control-plane-backup.yaml) writes versioned PostgreSQL custom archives and integrity manifests to the configured encrypted S3-compatible bucket. The [quarterly restore timer](../../scripts/dr/wasalx-control-plane-restore.timer) uses that bucket to rehearse recovery into a disposable database. Start with an isolated deployment and synthetic data.

## Verify the backup

1. Deploy through the approved environment gate with `controlPlaneBackup.enabled=true`. Use the release's digest-pinned workspace-configurator image and the backup values from the [chart](../../infra/helm/wasalx/values.yaml). The production Terraform configuration already enables the job. Use encrypted staging storage, a versioned bucket with the configured lifecycle and encryption, and explicit egress to the database and bucket. Keep credentials in the environment's secret store.
2. Configure a dedicated database backup login with read access to the control-plane database, including rows covered by forced row-level security. Scope backup storage credentials to the environment's control-plane backup prefix and the bucket protection checks. Keep production and rehearsal sources in separate buckets.
3. Confirm the CronJob is active, check its schedule and time zone, and verify no backup job is running before starting a one-off. On the approved Kubernetes context and namespace, create and inspect a uniquely named job.

   ```bash
   job="wasalx-control-backup-check-$(date -u +%Y%m%d%H%M%S)"
   kubectl --context "$context" --namespace "$namespace" get cronjob wasalx-control-backup
   kubectl --context "$context" --namespace "$namespace" create job "$job" --from=cronjob/wasalx-control-backup
   kubectl --context "$context" --namespace "$namespace" wait --for=condition=complete --timeout=55m "job/$job"
   kubectl --context "$context" --namespace "$namespace" logs "job/$job"
   ```

4. Retain the successful job receipt privately. Verify that it reports `SUCCEEDED` and `readback_verified: true`, with an object version for both the archive and the manifest. Capture one successful scheduled run as evidence that the recurring backup works.

## Rehearse recovery

1. On the approved isolated Linux recovery host, stage the reviewed checkout, Node.js, AWS CLI v2, the local Docker engine and the [pinned PostgreSQL image](../../scripts/dr/rehearse-postgres-restore.mjs). Use encrypted storage for the service cache and Docker data. Create the dedicated `wasalx-restore` account with access to that Docker engine. Docker access is privileged, so keep the host dedicated to recovery. For client-envelope backups, install `age` and `age-keygen` and make the matching identity file readable only to the restore account.
2. Set `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT` and `BACKUP_S3_REGION` in the service's root-owned environment file at `/etc/wasalx/control-plane-restore.env`. Set `BACKUP_AGE_IDENTITY` to the protected identity file path for client-envelope backups. Configure the AWS CLI credential chain on the host for the service account. Grant read-only listing for the control-plane prefix, reads for manifests and reads for versioned archives, with KMS decryption where required. Configure the trusted CA for private S3 endpoints.
3. Install the matching units. If the reviewed checkout or Node.js lives at a different path, set the service's `WorkingDirectory` or `ExecStart` in a host drop-in. Run the first drill before activating the timer.

   ```bash
   sudo install -m 0644 scripts/dr/wasalx-control-plane-restore.{service,timer} /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/wasalx-control-plane-restore.{service,timer}
   sudo systemctl daemon-reload
   sudo systemctl start wasalx-control-plane-restore.service
   sudo systemctl show wasalx-control-plane-restore.service -p Result -p ExecMainStatus -p ExecMainStartTimestamp -p ExecMainExitTimestamp
   sudo journalctl -u wasalx-control-plane-restore.service -n 20 --no-pager
   sudo systemctl enable --now wasalx-control-plane-restore.timer
   systemctl list-timers --all wasalx-control-plane-restore.timer
   ```

4. Match the journal's backup ID, manifest version and archive version to the backup receipt. Retain the evidence JSON path printed by the service and verify that it reports `PASSED`, the matching manifest and archive digests, the restored schema checks, and a destroyed, network-isolated target. Capture its SHA-256, UTC start and finish, restore duration and next timer firing. Record the sanitized first successful rehearsal and the recurring schedule in [DELIVERY.md](../../DELIVERY.md#deviations). Route a failed service or a missed quarterly run to Delivery.

The service requires the latest manifest to be within the [backup freshness objective](../../scripts/dr/contracts.mjs). It verifies the artifact version and digest before starting PostgreSQL. It removes its private scratch files on completion and failure. After an interrupted run, check the named rehearsal container and its volumes and review the private service cache for leftovers before rerunning. Keep archive contents, identities, host paths and raw logs in private custody.
