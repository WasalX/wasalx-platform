# Observability runbook

Use the alert's `severity` and `owner` labels to route the incident through WasalX Delivery. The rule files are the source for alert thresholds and hold times. [Compose rules](../../infra/docker/full/prometheus/alerts.yaml) [Helm rules](../../infra/helm/wasalx/files/observability-rules.yaml)

## First response

1. Record the environment, alert name, first firing time in UTC, and deployed commit or release tag. In Prometheus, confirm the alert is firing and check the relevant targets for scrape failures or missing series. The **WasalX Pilot Operations** dashboard shows queue age, latency, delivery exceptions, and infrastructure signals. [Dashboard](../../infra/docker/full/grafana/dashboards/wasalx-pilot.json)
2. Check the affected service through its configured endpoint. Use portal `/api/health`, control API `/health/ready`, and connector worker `/livez` and `/readyz`. A live worker can still be unready. Use its readiness response to identify the failing dependency.
3. Search structured service logs around the alert time by `trace_id` or `request_id` when present. Use the matching sampled trace if available. The shared redactor masks recognized phone fields and phone numbers in free text, including grouped international formats. Keep evidence to system IDs, timestamps, and safe error codes. Review excerpts for sensitive fields before sharing. [Logging and data rules](../../AGENTS.md#data-safety) [Shared redactor](../../packages/observability/src/index.ts)
4. After mitigation, confirm the signal has recovered, the backlog is draining where applicable, and a synthetic journey passes in an authorized environment. If the incident followed a deploy, send the evidence to WasalX Delivery for the environment's [rollback procedure](../../DELIVERY.md#rollback).

## Inbound queue stalled

For `WasalXInboundQueueStalled`, compare inbox age and depth with webhook acceptance and connector readiness. Trace an accepted event through the inbox, worker, and Zammad. Restore the blocked dependency and watch the existing inbox drain. Keep the original event and its deduplication record.

## Outbound queue stalled

For `WasalXOutboundQueueStalled`, compare delivery queue age and depth with worker readiness, provider send errors, and connection state. Check whether jobs are delayed by backoff or blocked on a connection. Restore that dependency and confirm pending deliveries advance. Reconcile any [unknown sends](#unknown-provider-outcome) before retrying.

## Durable work queue stalled

For `WasalXDurableWorkQueueStalled`, break down queue age and depth by `queue`. Compare the affected queue with scheduler heartbeat, worker readiness, and database metrics. Inspect the oldest item's safe state for a blocked lease, scheduled retry, or terminal error. Recover the affected processor and confirm work resumes through its normal lease path.

## Inbound latency

For `WasalXInboundLatencySLOBreach`, compare the acceptance-to-Zammad p95 with sample volume and inbox age. Use traces to distinguish inbox wait from ticket or article operation time. Follow [inbound queue stalled](#inbound-queue-stalled) or [Zammad errors](#zammad-errors) based on the slow stage, then confirm p95 recovery under comparable traffic.

## Outbound latency

For `WasalXOutboundLatencySLOBreach`, compare request-to-provider p95 with sample volume and outbox age. Follow a delivery trace to separate queue wait, backoff, and provider call time. Follow [outbound queue stalled](#outbound-queue-stalled) or [provider send errors](#provider-send-errors) based on the slow stage, then confirm p95 recovery under comparable traffic.

## Zammad errors

For `WasalXZammadOperationErrorRateHigh`, check the failing operation and result categories against request volume. Confirm Zammad availability from the connector and look for credential, permission, timeout, or search/storage errors in the matching trace. Verify the affected operation after recovery and check for an existing ticket or article before any replay.

## Provider send errors

For `WasalXProviderSendErrorRateHigh`, group attempts by provider and result and check the affected connections. Check for provider availability, rate limiting, and expired authorization. Let scheduled retries honor backoff for retryable failures. Route ambiguous sends to [unknown provider outcome](#unknown-provider-outcome).

## Worker or session loss

For `WasalXConnectorWorkerMissing`, check that worker instances are running and compare `/livez` with `/readyz`. Check whether readiness probes are reaching the worker because they emit the connector heartbeat. If readiness is healthy and the series is absent, check the application telemetry scrape and collector before restarting workers.

## WAHA worker telemetry missing

For `WasalXWahaWorkerTelemetryMissing`, verify that the connector is ready and that the WAHA registry contains the expected active workers. Check registry probe logs, OTLP export, and Prometheus targets. Confirm worker and engine series reappear after restoring the missing signal.

## WAHA worker unhealthy

For `WasalXWahaWorkerUnhealthy`, use the alert's `worker` and `engine` labels to locate the registry entry. Check recent probe outcomes and the worker's readiness and connectivity from the connector. Restore worker health before any session recovery and use the approved connection lifecycle controls for affected sessions.

## WAHA worker capacity high

For `WasalXWahaWorkerCapacityHigh`, compare active session count with the configured capacity of the labeled worker and check spare capacity on healthy workers for that engine. Escalate to WasalX Delivery for capacity changes. Confirm the assigned session load falls below the alert threshold and existing sessions remain healthy.

## Connection action required

For `WasalXConnectionActionRequired`, use the tenant's connection list and safe lifecycle reason to identify the affected connection. Have its authorized administrator complete the requested action and verify the connection returns to `WORKING` before releasing queued work.

## Duplicate spike

For `WasalXDuplicateSuppressionSpike`, compare accepted and duplicate webhook rates and check whether providers are retrying after slow or non-success acknowledgments. Confirm suppression is working by checking that the inbox event produces a single downstream effect. Restore timely acknowledgments and keep the deduplication records.

## Terminal delivery failure

For `WasalXTerminalDeliveryFailure`, open the delivery record using its internal ID and inspect attempt history and the terminal error. Correct the underlying issue or escalate with the safe error code. Use the authorized delivery action only after confirming the recorded outcome permits another send.

## Unknown provider outcome

For `WasalXUnknownProviderOutcome`, compare the delivery attempt with provider receipts or status through authorized tools. Keep the delivery unresolved while evidence is inconclusive. If the provider accepted it, reconcile its status without resending. Use the authorized retry action only when evidence confirms the previous send was not accepted.

## Reauthentication spike

For `WasalXReauthenticationSpike`, compare connection lifecycle events by provider and worker with any recent restart, deploy, or provider incident. If multiple connections share a cause, resolve it before asking administrators to [reauthenticate affected connections](#connection-action-required). Verify they return to service and new reauthentication events subside.

## Authorization anomaly

For `WasalXAuthorizationAnomaly`, correlate denied requests with audit events by time, request ID, and service or role. Check for a permissions or identity configuration regression and escalate suspicious activity through the [security policy](../../SECURITY.md). Keep access controls enforced during triage.

## Provisioning failure

For `WasalXProvisioningTerminalFailure`, identify the failed operation and stage from the provisioner and workspace controller. Check workspace-provider readiness and the relevant operator or dependency. Retain partial resources and send the recorded stage to the provisioning owner for recovery through the normal reconciliation path.

For `NOTION_OAUTH_RECOVERY_PENDING`, refresh the tenant's Connections view and use the integration ID to check its audit and secret cleanup task. A committed activation remains connected. If the callback could not abort an incomplete setup, the scheduled secret cleanup worker retires the aged stage after one hour and retries eligible deletions through its outbox. Keep OAuth codes, state values and secret references out of support records. Reconnect a working connection to the same workspace. Reconnecting a revoked connection creates a fresh binding, which an administrator can select when qualifying its routing source.

## Privacy failure

For `WasalXPrivacyTerminalFailure`, inspect the authorized job and audit history by ID for the failed scope, dependency, and any legal hold. Route to the privacy owner before further action. Preserve job evidence and verify the resulting state through the supported workflow.

## Media quarantine spike

For `WasalXMediaQuarantineSpike`, compare quarantine reason codes with media traffic and scanner or object-storage readiness. Determine whether detection increased or a dependency is failing. Keep quarantined media isolated and confirm scanning and quarantine rates normalize after mitigation.

## Database saturation

For `WasalXDatabasePoolSaturated`, compare waiting, active, and idle connections by pool. Check PostgreSQL readiness, lock and query timings, and recent worker concurrency changes. Restore the bottleneck with the database owner and confirm waiters and affected queues drain.

## Dependency unavailable

For `WasalXDependencyUnavailable`, use the alert's `component` and `dependency` labels to locate the failing readiness check. Check the component's readiness and the dependency from that component's network, then verify both readiness and the gauge return to healthy.

## Search saturation

For `WasalXSearchClusterRed`, confirm Elasticsearch health and inspect unassigned primary shards, node availability, and storage pressure. Follow [search disk low](#search-disk-low) if capacity is the cause. Escalate allocation or recovery decisions to the search owner and confirm primary shards and Zammad search recover.

## Search disk low

For `WasalXSearchDiskLow`, identify the Elasticsearch node and volume with low free space. Compare disk usage with index growth and allocation status. Have the storage owner restore headroom through approved capacity or retention procedures, then verify free space, shard allocation, and query recovery.

## Object storage saturation

For `WasalXObjectStorageLow`, determine whether MinIO usable capacity or the assisted-alpha backing filesystem fired. Identify the affected storage pool or volume and check for recent growth or a degraded node. Use approved capacity or retention procedures and verify free space and object access recover.

## Object storage node offline

For `WasalXObjectStorageNodeOffline`, identify the member reported offline. Check MinIO readiness, cluster quorum, and the member's network and volume health. Restore it through the storage owner's recovery path and verify member health and object access.

## Redis memory high

For `WasalXRedisMemoryHigh`, compare used memory with configured maxmemory and check evictions, rejected writes, and affected client readiness. Identify the workload driving growth and have the Redis owner restore headroom. Keep active session and queue data intact.

## Collector export failure

For `WasalXCollectorExportFailure`, check collector readiness, exporter error logs, queue pressure, and downstream availability. Compare Prometheus target health with the presence of current application metrics and sampled traces. Restore export connectivity and confirm failed-export rates fall and fresh telemetry reaches the backend.

## Alert delivery verification

After an authorized monitoring update, check that Prometheus loaded the expected rule files. The Helm chart renders a `PrometheusRule` for the standard profile and a ConfigMap for assisted alpha. For assisted alpha, also check that Prometheus loads the ConfigMap's rules file. Set `observability.prometheusRule.runbookBaseUrl` to the published runbook page when overriding the default, and preserve the headings used by the rule links. [Helm values](../../infra/helm/wasalx/values.yaml)

Confirm the configured Alertmanager route reaches WasalX Delivery. The checked-in Compose receiver provides local grouping only. In an authorized non-production environment, use a synthetic alert through the same route to verify notification delivery, the runbook link, and recovery. Record the results with the deployment evidence. [Compose receiver](../../infra/docker/full/alertmanager/alertmanager.yaml) [Deployment records](../../DELIVERY.md#deploys)
