import {verifyCurrentOperatorLocks} from "../tests/current-operator-locks-postgres.mjs";
import {verifyMetaNumberRelease} from "../tests/meta-number-release-postgres.mjs";
import {verifyMetaPublicTariffAcceptance} from '../tests/meta-public-tariff-acceptance-postgres.mjs';
import {withFixtureTenant} from '../tests/meta-routing-fixture.mjs';
import {verifyMetaCostHistoricalRepair} from "../tests/meta-cost-historical-postgres.mjs";
import {verifyMetaCostFactInterleavings,verifyMetaCostActivationInterleaving,verifyMetaCostPrivacyFences,verifyMetaCostRetention} from "../tests/meta-cost-interleaving-postgres.mjs";
import {verifyMetaCostFixtureProducers} from "../tests/meta-cost-postgres.mjs";
import {verifyMetaCostMoneyAndCorrections,verifyMetaCostCausalOrders} from "../tests/meta-cost-scenarios-postgres.mjs";
import {verifyMetaCostTariffAdmissions,verifyMetaCostSelectorSemantics,verifyMetaCostSnapshotBound,verifyMetaCostFactAndBatchBounds,verifyMetaCostCustomerHistory} from "../tests/meta-cost-admission-postgres.mjs";
import {verifyMetaCostLookupAndPrivacy} from "../tests/meta-cost-lookup-orchestration-postgres.mjs";
import {verifyMetaCostStatementsPostgres} from "../tests/meta-cost-statements-postgres.mjs";
import {verifyMetaCostAgedExpiry} from "../tests/meta-cost-aged-expiry-postgres.mjs";
import { verifyMetaDeletionPostgres } from "../tests/meta-deletion-postgres.mjs";
import { execFileSync } from 'node:child_process';
import { designationResults } from '../tests/group-designation-evidence.mjs';
import assert from "node:assert/strict";
import { parsePostgresShardArgs, scenarioShard, verifyPostgresShard } from "./postgres-scenario-registry.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { InboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { OutboxRepository } from "../services/connector-worker/dist/services/connector-worker/src/repository.js";
import { PrivacyLegalHoldError,PrivacyRepository,PrivacyRepositoryError } from "../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js";
import { advanceBotFlow,parseBotFlow } from "../services/connector-worker/dist/packages/core/src/bot-flow.js";
import { ConnectionOperationRepository,synchronizeGroups } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";
import { ConnectionsController } from "../services/control-api/dist/connections.controller.js";
import { MetaGroupsService } from "../services/control-api/dist/meta-groups.service.js";
import { verifyMetaCredentialMetadata } from "../packages/core/dist/meta-account-relation.js";
import { DeliveriesController } from "../services/control-api/dist/deliveries.controller.js";
import { deliveryHoldReasonSql,deliveryOrderingPredecessorSql } from "../services/control-api/dist/delivery-presentation.js";
import { BotFlowsService } from "../services/control-api/dist/bot-flows.service.js";
import { DatabaseService } from "../services/control-api/dist/database.service.js";
import { RuleGovernanceService } from "../services/control-api/dist/rule-governance.service.js";
import { RuleTestService } from "../services/control-api/dist/rule-test.service.js";
import { PrivacyController } from "../services/control-api/dist/privacy.controller.js";
import { WahaAuthorizationService } from "../services/control-api/dist/waha-authorization.service.js";
import { ZammadInternalController } from "../services/control-api/dist/zammad-internal.controller.js";
import { ZammadTicketStateController } from "../services/control-api/dist/zammad-ticket-state.controller.js";
import { executeMigrationSql,migrate } from "../services/control-api/dist/migrate.js";
import { PostgresProviderStore } from "../services/workspace-provider/dist/repository.js";
import { verifyGroupQuoteProjection, verifyTicketEventTargets } from "../tests/group-quote-postgres.mjs";
import { verifyGroupParticipantDedup } from "../tests/group-participant-dedup-postgres.mjs";
import { verifyDirectKeepOpenConstraints } from "../tests/direct-keep-open-postgres.mjs";
import { verifyTeamNumberValidation } from "../tests/team-numbers-postgres.mjs";
import { verifyOwnedWorkRestoration } from "../tests/owned-work-restoration-postgres.mjs";
import { verifyParticipantIdentityProjection } from "../tests/participant-identity-postgres.mjs";
import { verifyMetaSignup } from "../tests/meta-signup-postgres.mjs";
import { verifyMetaLifecycleWorker, verifyMetaLifecycleConsumers, verifyMetaLifecycleIngress } from "../tests/meta-lifecycle-postgres.mjs";
import { verifyMetaDirectIdentityPostgres, seedMetaDirectLegacyRoutingHistory } from "../tests/meta-direct-identity-postgres.mjs";
import { verifyMetaBillingDiagnostics } from "../tests/meta-billing-diagnostic-postgres.mjs";
import { verifyMetaAccountPolicy,verifyMetaLegacyNullBilling } from "../tests/meta-account-policy-postgres.mjs";
import {seedMetaRoutingLegacyUpgrade,verifyMetaRoutingLegacyUpgrade} from "../tests/meta-routing-upgrade-postgres.mjs";
import {syntheticMetaManagedRuntimeEvidence,verifyMetaManagedSoftware} from "../tests/meta-managed-software-postgres.mjs";
import {verifyMetaTransitionExecution} from "../tests/meta-account-transition-execution-postgres.mjs";
import {verifyMetaTransitionSuccessors} from "../tests/meta-account-transition-successor-postgres.mjs";
import {verifyMetaAccountIdentitySuccessorPostgres} from "../tests/meta-account-identity-successor-postgres.mjs";
import {verifyMetaTransitionOperatorReviews} from "../tests/meta-transition-operator-postgres.mjs";
import {verifyMetaTemplatePreparation} from "../tests/meta-template-preparation-postgres.mjs";
import {verifyMetaLegacyMigration} from "../tests/meta-legacy-migration-postgres.mjs";
import {verifyMetaTransitionObserverRenewal} from "../tests/meta-account-transition-observer-postgres.mjs";
import { verifyMetaPricingReceipts } from "../tests/meta-pricing-postgres.mjs";
import { verifyGroupWorkspaceReceipts } from "../tests/group-workspace-receipts-postgres.mjs";
import { verifyGroupDesignation } from "../tests/group-designation-postgres.mjs";
import { verifyNativeMembership } from "../tests/native-membership-postgres.mjs";
import { verifyNativeRouting } from "../tests/native-routing-postgres.mjs";
import {verifyWahaRenewal} from '../tests/waha-renewal-postgres.mjs';
import {verifyRoutingReconnect} from '../tests/routing-reconnect-postgres.mjs';

const { shard, report } = parsePostgresShardArgs(process.argv.slice(2));
const executed = [];
function shouldRun(name) {
  const assigned = scenarioShard(name);
  return shard === undefined || shard === assigned;
}
function runRegisteredScenario(name, run) {
  executed.push(name);
  return timeScenario(name, run);
}

const adminUrl=required("DATABASE_ADMIN_URL");const appUrl=required("DATABASE_APP_URL");
// Synthetic provider fixtures exercise normal admission; scoped scenarios set their own allowlist.
process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="*";
const connectorWorkerUrl=runtimeUrl("wasalx_connector_worker_runtime","wasalx-test-connector-worker");
const connectorWorkerConfig={connectionString:connectorWorkerUrl.toString(),options:"-c role=wasalx_connector_worker"};
const cleanupUrl=runtimeUrl("wasalx_secret_cleanup_runtime","wasalx-test-cleanup");
const provisioningUrl=runtimeUrl("wasalx_provisioning_runtime","wasalx-test-provisioning");
const supportUrl=runtimeUrl("wasalx_support_runtime","wasalx-test-support");
const wahaRegistryUrl=runtimeUrl("wasalx_waha_registry_runtime","wasalx-test-waha-registry");
const wahaOperatorUrl=runtimeUrl("wasalx_waha_operator_runtime","wasalx-test-waha-operator");
const wahaRolloutGateUrl=runtimeUrl("wasalx_waha_rollout_gate_runtime","wasalx-test-waha-rollout-gate");
const invitationMailerUrl=runtimeUrl("wasalx_invitation_mailer_runtime","wasalx-test-invitation-mailer");
const identityPolicyUrl=runtimeUrl("wasalx_identity_policy_runtime","wasalx-test-identity-policy");
const meteringIngestUrl=runtimeUrl("wasalx_metering_ingest_runtime","wasalx-test-metering-ingest");
const platformOperationsUrl=runtimeUrl("wasalx_platform_operations_runtime","wasalx-test-platform-operations");
const workspaceProviderUrl=runtimeUrl("wasalx_workspace_provider_runtime","wasalx-test-workspace-provider");
const provisioningRelease={
  packageVersion:"0.5.80",

  packageSha256:"a".repeat(64),
  images:{
    zammad:`registry.example.invalid/zammad@sha256:${"b".repeat(64)}`,
    configurator:`registry.example.invalid/configurator@sha256:${"c".repeat(64)}`,
    nginx:`registry.example.invalid/nginx@sha256:${"d".repeat(64)}`,
    redis:`registry.example.invalid/redis@sha256:${"e".repeat(64)}`,
    memcached:`registry.example.invalid/memcached@sha256:${"f".repeat(64)}`,
  },
};
const completedProvisioningReleaseEvidence={
  zammad:{
    runtime_image:provisioningRelease.images.zammad,
    package_version:provisioningRelease.packageVersion,
    package_sha256:provisioningRelease.packageSha256,
  },
  package:{
    package_version:provisioningRelease.packageVersion,
    package_sha256:provisioningRelease.packageSha256,
  },
};
const controlMigrationsUrl=new URL("../services/control-api/migrations/",import.meta.url);
const controlMigrationsPath=fileURLToPath(controlMigrationsUrl);
const migrationFiles=(await readdir(controlMigrationsUrl))
  .filter(file=>/^\d{4}_[a-z0-9_]+\.sql$/u.test(file))
  .sort();
assert.ok(migrationFiles.includes("0182_meta_customer_tariff_acceptance.sql"));
assert.ok(migrationFiles.includes("0025_rule_governance.sql"));
assert.ok(migrationFiles.includes("0033_waha_rollout_gate.sql"));
assert.ok(migrationFiles.includes("0035_waha_outbound_safety.sql"));
assert.ok(migrationFiles.includes("0071_waha_outbound_destination_lock.sql"));
assert.ok(migrationFiles.includes("0126_waha_outbound_policy_privilege_and_receipts.sql"));
assert.ok(migrationFiles.includes("0127_group_workspace_lid_mentions.sql"));
assert.ok(migrationFiles.includes("0128_waha_worker_renewal_lock_avoidance.sql"));
assert.ok(migrationFiles.includes("0129_authorization_privacy_boundaries.sql"));
assert.ok(migrationFiles.includes("0130_participant_identity_quality.sql"));
assert.ok(migrationFiles.includes("0131_notion_oauth_reconnect_qualification.sql"));
assert.ok(migrationFiles.includes("0136_first_client_beta_integrity.sql"));
assert.ok(migrationFiles.includes("0142_webhook_admission_tenant_fence.sql"));
assert.ok(migrationFiles.includes("0199_current_operator_row_locks.sql"));
assert.ok(migrationFiles.includes("0143_invitation_mailer_tenant_admission.sql"));
assert.ok(migrationFiles.includes("0144_polymorphic_actor_membership.sql"));
assert.ok(migrationFiles.includes("0145_connector_identity_link_updates.sql"));
assert.ok(migrationFiles.includes("0146_privacy_claim_transition_null_safety.sql"));
assert.ok(migrationFiles.includes("0147_privacy_purge_execution_boundary.sql"));
assert.ok(migrationFiles.includes("0148_connector_group_binding_lock.sql"));
assert.ok(migrationFiles.includes("0149_connector_participant_upsert.sql"));
assert.ok(migrationFiles.includes("0150_connector_media_lifecycle.sql"));
assert.ok(migrationFiles.includes("0151_delivery_stop_retry.sql"));
assert.ok(migrationFiles.includes("0072_bot_handoff_ambiguity_fence.sql"));
assert.ok(migrationFiles.includes("0074_automatic_group_sync.sql"));
assert.ok(migrationFiles.includes("0075_waha_only_automatic_group_sync.sql"));
assert.ok(migrationFiles.includes("0036_waha_assignment_renewal.sql"));
assert.ok(migrationFiles.includes("0037_tenant_resume_runtime.sql"));
assert.ok(migrationFiles.includes("0038_rule_snapshot_family_lookup.sql"));
assert.ok(migrationFiles.includes("0039_connection_onboarding_timing.sql"));
assert.ok(migrationFiles.includes("0040_waha_active_identity_unique.sql"));
assert.ok(migrationFiles.includes("0041_waha_duplicate_identity_cleanup.sql"));
assert.ok(migrationFiles.includes("0042_waha_scan_acknowledgement.sql"));
assert.ok(migrationFiles.includes("0043_direct_bot_foundation.sql"));
assert.ok(migrationFiles.includes("0044_direct_bot_delivery.sql"));
assert.ok(migrationFiles.includes("0045_direct_bot_actions.sql"));
assert.ok(migrationFiles.includes("0046_bot_action_url_constraints.sql"));
assert.ok(migrationFiles.includes("0060_bot_action_secret_tenant.sql"));
assert.ok(migrationFiles.includes("0108_bot_action_revision_integrity.sql"));
assert.ok(migrationFiles.includes("0109_zammad_service_assertion_replay.sql"));
assert.ok(migrationFiles.includes("0110_group_workspace_operation_receipts.sql"));
assert.ok(migrationFiles.includes("0111_secret_provisioning_stages.sql"));
assert.ok(migrationFiles.includes("0112_secret_cleanup_reference_ownership.sql"));
assert.ok(migrationFiles.includes("0116_direct_flow_media_assets.sql"));
assert.ok(migrationFiles.includes("0118_bot_assignment_active_flow_fence.sql"));
assert.ok(migrationFiles.includes("0061_bot_handoff_delivery_order.sql"));
assert.ok(migrationFiles.includes("0062_direct_bot_reference_privacy.sql"));
assert.ok(migrationFiles.includes("0063_direct_bot_delivery_origin.sql"));
assert.ok(migrationFiles.includes("0069_direct_delivery_destination_privacy.sql"));
assert.ok(migrationFiles.includes("0047_bot_scheduler_privileges.sql"));
assert.ok(migrationFiles.includes("0052_client_routing_versions.sql"));
assert.ok(migrationFiles.includes("0053_client_routing_sync_runtime.sql"));
assert.ok(migrationFiles.includes("0054_client_routing_sync_completion.sql"));
assert.ok(migrationFiles.includes("0055_client_routing_scheduler.sql"));
assert.ok(migrationFiles.includes("0056_client_routing_webhooks.sql"));
assert.ok(migrationFiles.includes("0057_client_routing_pins.sql"));
assert.ok(migrationFiles.includes("0058_bot_handoff_owner.sql"));
assert.ok(migrationFiles.includes("0059_client_routing_sync_safety.sql"));
assert.ok(migrationFiles.includes("0068_client_routing_sync_supersession.sql"));
assert.ok(migrationFiles.includes("0095_client_routing_sync_noop.sql"));
assert.ok(migrationFiles.includes("0099_client_routing_oauth_expiry.sql"));
assert.ok(migrationFiles.includes("0100_force_webhook_routes_rls.sql"));
assert.ok(migrationFiles.includes("0070_tenant_referential_integrity.sql"));
assert.equal(new Set(migrationFiles.map(file=>file.slice(0,4))).size,migrationFiles.length);
const tenantForeignKeys=[
  "case_correlations_group_binding_tenant_fk","case_corr_predecessor_tenant_fk","case_corr_replacement_tenant_fk",
  "case_detach_correlation_tenant_fk","delivery_attempts_delivery_tenant_fk","delivery_outbox_connection_tenant_fk",
  "delivery_outbox_group_binding_tenant_fk","delivery_ticket_links_delivery_tenant_fk","event_inbox_connection_tenant_fk",
  "group_bindings_rule_set_tenant_fk","group_bindings_whatsapp_group_tenant_fk","message_links_connection_tenant_fk",
  "normalized_messages_connection_tenant_fk","normalized_messages_event_tenant_fk","participant_identities_connection_tenant_fk",
  "platform_support_request_tenant_fk","privacy_export_request_tenant_fk","privacy_job_targets_job_tenant_fk",
  "privacy_jobs_request_tenant_fk","provider_sessions_connection_tenant_fk","tenant_invitation_email_invitation_tenant_fk",
  "trigger_rules_rule_set_tenant_fk","webhook_routes_connection_tenant_fk","whatsapp_groups_connection_tenant_fk",
  "zammad_service_assertion_jti_instance_fk","zammad_status_delivery_tenant_fk","zammad_ticket_state_instance_tenant_fk",
];
let metaIdentityRoutingHistory;
const metaLifecycleFailures=[];
async function prepareDatabase(){
const migrationStartedAt=performance.now();
const qualifyMigrations=shouldRun("migrations");
const admin=new Client({connectionString:adminUrl});await admin.connect();
try{
  await admin.query(`DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_app') THEN CREATE ROLE wasalx_app NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_runtime') THEN CREATE ROLE wasalx_runtime LOGIN; END IF;
    ALTER ROLE wasalx_runtime LOGIN PASSWORD 'wasalx-test-app';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_connector_worker') THEN CREATE ROLE wasalx_connector_worker NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_connector_worker_runtime') THEN CREATE ROLE wasalx_connector_worker_runtime LOGIN; END IF;
    ALTER ROLE wasalx_connector_worker_runtime LOGIN PASSWORD 'wasalx-test-connector-worker';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_secret_cleanup_client') THEN CREATE ROLE wasalx_secret_cleanup_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_secret_cleanup_runtime') THEN CREATE ROLE wasalx_secret_cleanup_runtime LOGIN; END IF;
    ALTER ROLE wasalx_secret_cleanup_runtime LOGIN PASSWORD 'wasalx-test-cleanup';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_provisioning_client') THEN CREATE ROLE wasalx_provisioning_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_provisioning_runtime') THEN CREATE ROLE wasalx_provisioning_runtime LOGIN; END IF;
    ALTER ROLE wasalx_provisioning_runtime LOGIN PASSWORD 'wasalx-test-provisioning';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_support_client') THEN CREATE ROLE wasalx_support_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_support_runtime') THEN CREATE ROLE wasalx_support_runtime LOGIN; END IF;
    ALTER ROLE wasalx_support_runtime LOGIN PASSWORD 'wasalx-test-support';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_registry_client') THEN CREATE ROLE wasalx_waha_registry_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_registry_runtime') THEN CREATE ROLE wasalx_waha_registry_runtime LOGIN; END IF;
    ALTER ROLE wasalx_waha_registry_runtime LOGIN PASSWORD 'wasalx-test-waha-registry';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_operator_client') THEN CREATE ROLE wasalx_waha_operator_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_operator_runtime') THEN CREATE ROLE wasalx_waha_operator_runtime LOGIN; END IF;
    ALTER ROLE wasalx_waha_operator_runtime LOGIN PASSWORD 'wasalx-test-waha-operator';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_rollout_gate_client') THEN CREATE ROLE wasalx_waha_rollout_gate_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_waha_rollout_gate_runtime') THEN CREATE ROLE wasalx_waha_rollout_gate_runtime LOGIN; END IF;
    ALTER ROLE wasalx_waha_rollout_gate_runtime LOGIN PASSWORD 'wasalx-test-waha-rollout-gate';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_invitation_mailer') THEN CREATE ROLE wasalx_invitation_mailer NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_invitation_mailer_runtime') THEN CREATE ROLE wasalx_invitation_mailer_runtime LOGIN; END IF;
    ALTER ROLE wasalx_invitation_mailer_runtime LOGIN PASSWORD 'wasalx-test-invitation-mailer';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_identity_policy_activator') THEN CREATE ROLE wasalx_identity_policy_activator NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_identity_policy_runtime') THEN CREATE ROLE wasalx_identity_policy_runtime LOGIN; END IF;
    ALTER ROLE wasalx_identity_policy_runtime LOGIN PASSWORD 'wasalx-test-identity-policy';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_metering_ingest_client') THEN CREATE ROLE wasalx_metering_ingest_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_metering_ingest_runtime') THEN CREATE ROLE wasalx_metering_ingest_runtime LOGIN; END IF;
    ALTER ROLE wasalx_metering_ingest_runtime LOGIN PASSWORD 'wasalx-test-metering-ingest';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_platform_operations_client') THEN CREATE ROLE wasalx_platform_operations_client NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_platform_operations_runtime') THEN CREATE ROLE wasalx_platform_operations_runtime LOGIN; END IF;
    ALTER ROLE wasalx_platform_operations_runtime LOGIN PASSWORD 'wasalx-test-platform-operations';
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_workspace_provider_runtime') THEN CREATE ROLE wasalx_workspace_provider_runtime LOGIN NOBYPASSRLS; END IF;
    ALTER ROLE wasalx_workspace_provider_runtime LOGIN PASSWORD 'wasalx-test-workspace-provider';
    GRANT wasalx_app TO wasalx_runtime;
    REVOKE wasalx_app FROM wasalx_connector_worker_runtime;
    GRANT wasalx_connector_worker TO wasalx_connector_worker_runtime;
    GRANT wasalx_secret_cleanup_client TO wasalx_secret_cleanup_runtime;
    GRANT wasalx_provisioning_client TO wasalx_provisioning_runtime;
    GRANT wasalx_support_client TO wasalx_support_runtime;
    GRANT wasalx_waha_registry_client TO wasalx_waha_registry_runtime;
    GRANT wasalx_waha_operator_client TO wasalx_waha_operator_runtime;
    GRANT wasalx_waha_rollout_gate_client TO wasalx_waha_rollout_gate_runtime;
    GRANT wasalx_invitation_mailer TO wasalx_invitation_mailer_runtime;
    GRANT wasalx_identity_policy_activator TO wasalx_identity_policy_runtime;
    GRANT wasalx_metering_ingest_client TO wasalx_metering_ingest_runtime;
    GRANT wasalx_platform_operations_client TO wasalx_platform_operations_runtime;
  END $$;`);
  if(!qualifyMigrations){
    await migrate(controlMigrationsPath);
    return;
  }
  executed.push("migrations");
  await timeScenario("freshMigrationResume",proveFreshMigrationResume);
  const appliedBeforeOwnership=migrationFiles.filter(file=>file<"0112_secret_cleanup_reference_ownership.sql");
  for(const file of appliedBeforeOwnership){
    const sql=await readFile(new URL(`../services/control-api/migrations/${file}`,import.meta.url),"utf8");await executeMigrationSql(admin,sql);
    if(file==="0100_force_webhook_routes_rls.sql")await admin.query(`
      INSERT INTO tenants(id,name,slug,state)
      VALUES ('39000000-0000-4000-8000-000000000039','Legacy upgrade tenant','legacy-upgrade','ACTIVE');
      INSERT INTO users(id,oidc_subject,email,display_name)
      VALUES ('39300000-0000-4000-8000-000000000039','legacy-upgrade-owner','legacy-upgrade@example.invalid','Legacy owner');
      INSERT INTO tenant_memberships(tenant_id,user_id,role)
      VALUES ('39000000-0000-4000-8000-000000000039','39300000-0000-4000-8000-000000000039','tenant_owner');
      INSERT INTO client_routing_versions(
        id,tenant_id,version,state,revision,definition,snapshot_sha256,created_by,created_actor_type,
        activated_by,activated_actor_type,activated_at
      ) VALUES (
        '39800000-0000-4000-8000-000000000039','39000000-0000-4000-8000-000000000039',1,'ACTIVE',2,
        '{"schemaVersion":1,"name":"Legacy routing","fallback":{"zammadGroupId":"2"},"sources":[],"clients":[]}',repeat('3',64),
        '39300000-0000-4000-8000-000000000039','USER','39300000-0000-4000-8000-000000000039','USER',now()
      );
      INSERT INTO client_routing_source_state(
        id,tenant_id,source_id,routing_version_id,config_sha256,kind,sync_mode,
        secret_reference,endpoint_url,schedule_minutes,next_due_at
      ) VALUES (
        '39810000-0000-4000-8000-000000000039','39000000-0000-4000-8000-000000000039','legacy.crm',
        '39800000-0000-4000-8000-000000000039',repeat('4',64),'HTTP_JSON','SCHEDULED',
        'secret://tenants/39000000-0000-4000-8000-000000000039/routing/legacy-crm',
        'https://legacy.example.invalid/clients',60,now()
      );
      INSERT INTO client_routing_sync_jobs(
        id,tenant_id,source_state_id,config_sha256,trigger_key,trigger_kind,expected_snapshot_revision
      ) VALUES (
        '39820000-0000-4000-8000-000000000039','39000000-0000-4000-8000-000000000039',
        '39810000-0000-4000-8000-000000000039',repeat('4',64),'legacy-upgrade','SCHEDULED',0
      );
      INSERT INTO bot_action_definitions(
        id,tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,secret_reference,created_by,updated_by
      ) VALUES
        ('39830000-0000-4000-8000-000000000039','39000000-0000-4000-8000-000000000039','legacy.lookup','Legacy lookup',
          'HTTP_JSON','https://legacy.example.invalid/lookup','GET','BEARER',
          'secret://tenants/39000000-0000-4000-8000-000000000039/bot-actions/shared-credential',
          '39300000-0000-4000-8000-000000000039','39300000-0000-4000-8000-000000000039'),
        ('39830000-0000-4000-8000-000000000040','39000000-0000-4000-8000-000000000039','owned.lookup','Owned lookup',
          'HTTP_JSON','https://legacy.example.invalid/owned','GET','BEARER',
          'secret://tenants/39000000-0000-4000-8000-000000000039/bot-actions/owned.lookup',
          '39300000-0000-4000-8000-000000000039','39300000-0000-4000-8000-000000000039');`);
  }
  const migrationChecksums=new Map(await Promise.all(migrationFiles.map(async file=>[
    file,createHash("sha256").update(await readFile(new URL(`../services/control-api/migrations/${file}`,import.meta.url),"utf8")).digest("hex"),
  ])));
  assert.equal(migrationChecksums.get("0111_secret_provisioning_stages.sql"),"6347b155cc662a965a0769438685e5cfc1dbf12c03c7dfb1353bd622c4199cc6");
  await admin.query(`CREATE TABLE public.wasalx_schema_migrations (
    name text PRIMARY KEY,checksum_sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await admin.query(`INSERT INTO public.wasalx_schema_migrations(name,checksum_sha256)
    SELECT * FROM unnest($1::text[],$2::text[])`,[
    appliedBeforeOwnership,appliedBeforeOwnership.map(file=>migrationChecksums.get(file)),
  ]);
  const migrationCountBeforeCommercialGoRejection=(await admin.query("SELECT count(*)::integer AS count FROM wasalx_schema_migrations")).rows[0].count;
  await assert.rejects(
    ()=>migrate(controlMigrationsPath),
    error=>error?.code==="55000"&&/adoption\/upgrade lifecycle/u.test(error.message),
  );
  assert.deepEqual((await admin.query("SELECT count(*)::integer AS count FROM wasalx_schema_migrations")).rows,[
    {count:migrationCountBeforeCommercialGoRejection},
  ]);
  assert.deepEqual((await admin.query("SELECT name FROM wasalx_schema_migrations ORDER BY name DESC LIMIT 1")).rows,[
    {name:"0111_secret_provisioning_stages.sql"},
  ]);
  for(const file of migrationFiles.filter(file=>file>="0112_secret_cleanup_reference_ownership.sql"&&file<"0133_commercial_go_boundaries.sql")){
    await executeMigrationSql(admin,await readFile(new URL(`../services/control-api/migrations/${file}`,import.meta.url),"utf8"));
    await admin.query("INSERT INTO public.wasalx_schema_migrations(name,checksum_sha256) VALUES ($1,$2)",[file,migrationChecksums.get(file)]);
  }
  for(const file of (await readdir(new URL("../services/workspace-provider/migrations/",import.meta.url))).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort()){
    await admin.query(await readFile(new URL(`../services/workspace-provider/migrations/${file}`,import.meta.url),"utf8"));
  }
  assert.deepEqual((await admin.query("SELECT name FROM wasalx_schema_migrations ORDER BY name DESC LIMIT 1")).rows,[
    {name:"0132_release_blocker_closure.sql"},
  ]);
  const legacyRoutingRepair=await admin.query(`SELECT source.state,integration.provider,integration.state AS integration_state,
      integration.secret_reference,integration.created_by,
      (SELECT count(*)::integer FROM audit_events event WHERE event.tenant_id=source.tenant_id
        AND event.action='client_routing.integration_imported') AS audit_count
    FROM client_routing_source_state source
    JOIN client_routing_integrations integration
      ON integration.tenant_id=source.tenant_id AND integration.secret_reference=source.secret_reference
    WHERE source.id='39810000-0000-4000-8000-000000000039'`);
  assert.deepEqual(legacyRoutingRepair.rows,[{
    state:"ACTIVE",provider:"HTTP_JSON",integration_state:"CONNECTED",
    secret_reference:"secret://tenants/39000000-0000-4000-8000-000000000039/routing/legacy-crm",
    created_by:"39300000-0000-4000-8000-000000000039",audit_count:1,
  }]);
  await admin.query("BEGIN");
  try{
    await admin.query("SELECT set_config('app.tenant_id',$1,true)",["39000000-0000-4000-8000-000000000039"]);
    const legacyClaim=await admin.query("SELECT job_id,source_id,secret_reference FROM app.claim_client_routing_sync_jobs($1,1)",["39840000-0000-4000-8000-000000000039"]);
    assert.deepEqual(legacyClaim.rows,[{
      job_id:"39820000-0000-4000-8000-000000000039",source_id:"legacy.crm",
      secret_reference:"secret://tenants/39000000-0000-4000-8000-000000000039/routing/legacy-crm",
    }]);
    await admin.query("COMMIT");
  }catch(error){await admin.query("ROLLBACK");throw error}
  const legacyActions=await admin.query(`SELECT action_key,state,auth_scheme,secret_reference FROM bot_action_definitions
    WHERE tenant_id='39000000-0000-4000-8000-000000000039' ORDER BY action_key`);
  assert.deepEqual(legacyActions.rows,[
    {action_key:"legacy.lookup",state:"PAUSED",auth_scheme:"NONE",secret_reference:null},
    {action_key:"owned.lookup",state:"ACTIVE",auth_scheme:"BEARER",secret_reference:"secret://tenants/39000000-0000-4000-8000-000000000039/bot-actions/owned.lookup"},
  ]);
  assert.deepEqual((await admin.query(`SELECT convalidated FROM pg_constraint
    WHERE conrelid='bot_action_definitions'::regclass AND conname='bot_action_definitions_tenant_secret_check'`)).rows,[{convalidated:true}]);
  assert.deepEqual((await admin.query(`SELECT count(*)::integer AS audit_count FROM audit_events
    WHERE tenant_id='39000000-0000-4000-8000-000000000039'
      AND action='bot_action.credential_rotation_required'`)).rows,[{audit_count:1}]);
  await assert.rejects(
    ()=>admin.query("UPDATE bot_action_definitions SET state='ACTIVE' WHERE id='39830000-0000-4000-8000-000000000039'"),
    error=>error.code==="23514",
  );
  await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id='39000000-0000-4000-8000-000000000039'");
  await admin.query(`
    INSERT INTO users(id,oidc_subject,email,display_name)
    VALUES ('39300000-0000-4000-8000-000000000040','legacy-upgrade-spare-owner','legacy-upgrade-spare@example.invalid','Legacy spare owner');
    INSERT INTO tenant_memberships(tenant_id,user_id,role)
    VALUES ('39000000-0000-4000-8000-000000000039','39300000-0000-4000-8000-000000000040','tenant_owner');
    DELETE FROM tenant_memberships
     WHERE tenant_id='39000000-0000-4000-8000-000000000039'
       AND user_id='39300000-0000-4000-8000-000000000039';`);
  assert.deepEqual((await admin.query(`SELECT
    (SELECT count(*)::integer FROM tenant_memberships WHERE tenant_id='39000000-0000-4000-8000-000000000039') AS memberships,
    (SELECT count(*)::integer FROM bot_action_revisions WHERE tenant_id='39000000-0000-4000-8000-000000000039') AS revisions`)).rows,[{memberships:1,revisions:2}]);
  await admin.query(`
    DELETE FROM bot_action_definitions WHERE tenant_id='39000000-0000-4000-8000-000000000039';
    DELETE FROM client_routing_source_state WHERE tenant_id='39000000-0000-4000-8000-000000000039';
    DELETE FROM secret_cleanup_outbox WHERE tenant_id='39000000-0000-4000-8000-000000000039';
    DELETE FROM client_routing_integrations WHERE tenant_id='39000000-0000-4000-8000-000000000039';
    DELETE FROM client_routing_versions WHERE tenant_id='39000000-0000-4000-8000-000000000039';
    DELETE FROM users WHERE id='39300000-0000-4000-8000-000000000039';
    UPDATE tenants SET state='SUSPENDED' WHERE id='39000000-0000-4000-8000-000000000039';`);
  assert.deepEqual((await admin.query(`SELECT count(*)::integer AS revisions FROM bot_action_revisions
    WHERE tenant_id='39000000-0000-4000-8000-000000000039'`)).rows,[{revisions:0}]);
  await admin.query("TRUNCATE TABLE public.tenants, public.users CASCADE");
  const boundaryWriter=new Client({connectionString:adminUrl,application_name:"wasalx-boundary-race-writer"});
  let boundaryMigration;
  await boundaryWriter.connect();
  try{
    await boundaryWriter.query("BEGIN");
    await boundaryWriter.query(`INSERT INTO tenants(id,name,slug,state)
      VALUES ('39000000-0000-4000-8000-000000000040','Boundary race tenant','boundary-race','ACTIVE')`);
    const boundaryWriterPid=(await boundaryWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let migrationSettled=false;
    let migrationFailureCode=null;
    boundaryMigration=migrate(controlMigrationsPath).then(
      ()=>{migrationSettled=true;return undefined;},
      error=>{migrationSettled=true;migrationFailureCode=error?.code??"UNCLASSIFIED";return error;},
    );
    let migrationWaiting=false;
    // Connection/setup and the historical ledger scan precede the lock under test.
    const boundaryWaitDeadline=performance.now()+60_000;
    while(!migrationWaiting&&!migrationSettled&&performance.now()<boundaryWaitDeadline){
      migrationWaiting=(await admin.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND application_name='wasalx-migration'
           AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
      ) AS waiting`,[boundaryWriterPid])).rows[0].waiting;
      if(!migrationWaiting)await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(migrationWaiting,true,`Migration did not block on the boundary writer; settled=${migrationSettled}, code=${migrationFailureCode}`);
    await boundaryWriter.query("COMMIT");
    const boundaryError=await boundaryMigration;
    assert.equal(boundaryError?.code,"55000");
    assert.match(boundaryError?.message??"",/adoption\/upgrade lifecycle/u);
  }finally{
    await boundaryWriter.query("ROLLBACK").catch(()=>undefined);
    await boundaryWriter.end();
    if(boundaryMigration)await boundaryMigration.catch(()=>undefined);
  }
  assert.deepEqual((await admin.query("SELECT name FROM wasalx_schema_migrations ORDER BY name DESC LIMIT 1")).rows,[
    {name:"0132_release_blocker_closure.sql"},
  ]);
  await admin.query("DELETE FROM tenants WHERE id='39000000-0000-4000-8000-000000000040'");
  // Preserve the protected Meta lifecycle ledger before adding the pending native membership migration.
  const protectedPrefix=await mkdtemp(resolve(tmpdir(),"wasalx-protected-prefix-"));
  try{
    const prefixFiles=migrationFiles.filter(file=>file<"0162_native_membership_projection.sql");
    assert.equal(prefixFiles.length,161);
    assert.equal(prefixFiles.at(-1),"0161_meta_account_lifecycle.sql");
    await Promise.all(prefixFiles.map(async file=>writeFile(resolve(protectedPrefix,file),await readFile(new URL(file,controlMigrationsUrl)))));
    await migrate(protectedPrefix);
    const previousLedger=(await admin.query("SELECT name,checksum_sha256,applied_at FROM wasalx_schema_migrations ORDER BY name")).rows;
    assert.deepEqual(previousLedger.map(row=>[row.name,row.checksum_sha256]),prefixFiles.map(file=>[file,migrationChecksums.get(file)]));
    assert.equal((await admin.query("SELECT to_regclass('public.native_membership_projections')::text AS relation")).rows[0].relation,null);
    // Apply the real prefix through customer policy170 before seeding the exact
    // original manual generation immediately ahead of routing171.
    const routingFiles=migrationFiles.filter(file=>file<"0171_meta_external_routing.sql");
    assert.equal(routingFiles.length,170);
    assert.ok(routingFiles.every((file,index)=>Number(file.slice(0,4))===index+1));
    assert.equal(routingFiles.at(-1),"0170_meta_account_policy.sql");
    await Promise.all(routingFiles.map(async file=>writeFile(resolve(protectedPrefix,file),await readFile(new URL(file,controlMigrationsUrl)))));
    await migrate(protectedPrefix);
    const routingUpgrade=await seedMetaRoutingLegacyUpgrade(admin);
    metaIdentityRoutingHistory=await seedMetaDirectLegacyRoutingHistory(admin);
    await migrate(controlMigrationsPath);
    // These identities reuse the existing tenant/connection/session parent key.
    const sessionForeignKeys=(await admin.query(`SELECT relation.relname AS relation,c.convalidated AS validated,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS source_columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS target_columns
      FROM pg_constraint c JOIN pg_class relation ON relation.oid=c.conrelid
      WHERE c.contype='f' AND c.confrelid='public.provider_sessions'::regclass
        AND c.conrelid=ANY($1::regclass[]) ORDER BY relation.relname`,[[
      'public.meta_connection_account_bindings','public.meta_template_safety_markers',
    ]])).rows;
    assert.deepEqual(sessionForeignKeys,[
      {relation:'meta_connection_account_bindings',validated:true,source_columns:['tenant_id','connection_id','provider_session_id'],target_columns:['tenant_id','connection_id','id']},
      {relation:'meta_template_safety_markers',validated:true,source_columns:['tenant_id','source_connection_id','source_session_id'],target_columns:['tenant_id','connection_id','id']},
    ],'Session references must preserve the exact tenant and connection pair');
    try{console.log(JSON.stringify({metaRoutingLegacyUpgrade:await timeScenario("metaRoutingLegacyUpgrade",()=>verifyMetaRoutingLegacyUpgrade(admin,routingUpgrade,appUrl))}))}catch(error){
      // Collect isolated deterministic failures only after rollback, client close and public readback.
      if(error?.metaRoutingLegacyUpgradeCleanupConfirmed!==true
        || !(error.code==='ERR_ASSERTION'||/^(22|23|42|44|P0)[0-9A-Z]{3}$/u.test(error.code??'')||error.code==='55000'))throw error;
      metaLifecycleFailures.push(error);console.error("Meta routing legacy upgrade PostgreSQL failed",error);
    }
    const upgradedLedger=(await admin.query("SELECT name,checksum_sha256,applied_at FROM wasalx_schema_migrations ORDER BY name")).rows;
    assert.deepEqual(upgradedLedger.slice(0,previousLedger.length),previousLedger);
    assert.deepEqual(upgradedLedger.slice(previousLedger.length).map(row=>[row.name,row.checksum_sha256]),
      migrationFiles.slice(previousLedger.length).map(file=>[file,migrationChecksums.get(file)]));
    assert.equal(upgradedLedger[previousLedger.length]?.name,"0162_native_membership_projection.sql");
    assert.equal((await admin.query("SELECT to_regclass('public.native_membership_projections')::text AS relation")).rows[0].relation,"native_membership_projections");
    process.stdout.write(JSON.stringify({protected_migration_prefix:previousLedger.length,native_membership_migration:"0162_native_membership_projection.sql",ledger_rows_preserved:true})+"\n");
  }finally{await rm(protectedPrefix,{recursive:true,force:true})}
  assert.deepEqual((await admin.query("SELECT name FROM wasalx_schema_migrations ORDER BY name DESC LIMIT 1")).rows,[
    {name:migrationFiles.at(-1)},
  ]);
  const tenantCreatePrivileges=await admin.query(`SELECT
    has_function_privilege('wasalx_provisioning_client','app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)','EXECUTE') AS client_wrapper,
    has_function_privilege('wasalx_provisioning_runtime','app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)','EXECUTE') AS runtime_wrapper,
    has_function_privilege('wasalx_provisioning_client','app.operator_create_tenant_unfenced(text,text,text,text,integer,jsonb,text,text,text,text,text)','EXECUTE') AS client_unfenced,
    has_function_privilege('wasalx_provisioning_runtime','app.operator_create_tenant_unfenced(text,text,text,text,integer,jsonb,text,text,text,text,text)','EXECUTE') AS runtime_unfenced,
    has_function_privilege('wasalx_app','app.operator_create_tenant_unfenced(text,text,text,text,integer,jsonb,text,text,text,text,text)','EXECUTE') AS app_unfenced,
    has_function_privilege('wasalx_provisioner','app.operator_create_tenant_unfenced(text,text,text,text,integer,jsonb,text,text,text,text,text)','EXECUTE') AS provisioner_unfenced,
    NOT EXISTS (
      SELECT 1 FROM pg_proc routine
      CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid='app.operator_create_tenant_unfenced(text,text,text,text,integer,jsonb,text,text,text,text,text)'::regprocedure
        AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
    ) AS public_unfenced_restricted`);
  assert.deepEqual(tenantCreatePrivileges.rows,[{
    client_wrapper:true,runtime_wrapper:true,client_unfenced:false,runtime_unfenced:false,
    app_unfenced:false,provisioner_unfenced:false,public_unfenced_restricted:true,
  }]);
  const migrationFenceHolder=new Client({connectionString:adminUrl,application_name:"wasalx-migration-fence-holder"});
  const migrationFenceWriter=new Client({connectionString:adminUrl,application_name:"wasalx-migration-fence-writer"});
  const migrationFenceProvisioning=new Client({connectionString:provisioningUrl.toString(),application_name:"wasalx-migration-fence-provisioning"});
  await Promise.all([migrationFenceHolder.connect(),migrationFenceWriter.connect(),migrationFenceProvisioning.connect()]);
  try{
    await migrationFenceHolder.query("BEGIN");
    await migrationFenceHolder.query("SELECT pg_advisory_lock(8724591307)");
    await migrationFenceProvisioning.query("SET statement_timeout='2s'");
    const provisioningPid=(await migrationFenceProvisioning.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const createWhileMigrating=migrationFenceProvisioning.query(
      "SELECT app.operator_create_tenant($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) AS result",
      ["migration-fence-supported","1".repeat(64),"Migration fence supported","migration-fence-supported",90,"{}",
        "oidc-migration-fence","migration-fence@example.invalid","Migration Fence","migration-fence-operator","migration-fence-audit"],
    ).then(()=>null,error=>error);
    let creationWaiting=false;
    for(let attempt=0;attempt<100&&!creationWaiting;attempt+=1){
      creationWaiting=(await admin.query(
        "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[provisioningPid],
      )).rows[0]?.waiting===true;
      if(!creationWaiting)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(creationWaiting,true);
    assert.deepEqual((await admin.query(`SELECT namespace_record.nspname,relation.relname,lock.mode
      FROM pg_locks lock
      JOIN pg_class relation ON relation.oid=lock.relation
      JOIN pg_namespace namespace_record ON namespace_record.oid=relation.relnamespace
     WHERE lock.pid=$1 AND lock.granted AND lock.mode='RowExclusiveLock'
       AND namespace_record.nspname NOT LIKE 'pg_%'
       AND namespace_record.nspname<>'information_schema'
     ORDER BY namespace_record.nspname,relation.relname`,[provisioningPid])).rows,[]);
    await migrationFenceHolder.query("SET LOCAL lock_timeout='500ms'");
    await migrationFenceHolder.query("LOCK TABLE provisioning_operator_requests,tenants IN SHARE MODE");
    const creationError=await createWhileMigrating;
    assert.ok(creationError?.code==="57014"&&/statement timeout/u.test(creationError.message));
    assert.deepEqual((await admin.query("SELECT count(*)::integer AS count FROM provisioning_operator_requests WHERE idempotency_key='migration-fence-supported'")).rows,[{count:0}]);
    await migrationFenceHolder.query("ROLLBACK");
    await migrationFenceHolder.query("SELECT pg_advisory_unlock(8724591307)");

    await migrationFenceHolder.query("SELECT pg_advisory_lock(8724591307)");
    await migrationFenceWriter.query("SET statement_timeout='1s'");
    await assert.rejects(
      migrationFenceWriter.query(`INSERT INTO tenants(id,name,slug,state)
        VALUES ('39000000-0000-4000-8000-000000000041','Migration fence tenant','migration-fence','ACTIVE')`),
      error=>error?.code==="57014"&&/statement timeout/u.test(error.message),
    );
    assert.deepEqual((await admin.query("SELECT count(*)::integer AS count FROM tenants WHERE id='39000000-0000-4000-8000-000000000041'")).rows,[{count:0}]);
    await migrationFenceHolder.query("SELECT pg_advisory_unlock(8724591307)");

    const ledgerBeforeCreatorFence=(await admin.query("SELECT name,checksum_sha256 FROM wasalx_schema_migrations ORDER BY name")).rows;
    await migrationFenceProvisioning.query("BEGIN");
    await migrationFenceProvisioning.query(
      "SELECT app.operator_create_tenant($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)",
      ["migration-fence-creator-first","2".repeat(64),"Creator first fence","creator-first-fence",90,
        JSON.stringify({deployment:{zammadVersion:"7.1.3",release:provisioningRelease}}),
        "oidc-migration-creator-first","migration-creator-first@example.invalid","Creator First",
        "migration-fence-operator","migration-fence-creator-first"],
    );
    await assert.rejects(migrate(controlMigrationsPath),error=>error?.code==="55P03"&&/already running/u.test(error.message));
    assert.deepEqual((await admin.query("SELECT name,checksum_sha256 FROM wasalx_schema_migrations ORDER BY name")).rows,ledgerBeforeCreatorFence);
    await migrationFenceProvisioning.query("ROLLBACK");
    assert.deepEqual((await admin.query("SELECT count(*)::integer AS count FROM provisioning_operator_requests WHERE idempotency_key='migration-fence-creator-first'")).rows,[{count:0}]);
  }finally{
    await migrationFenceHolder.query("ROLLBACK").catch(()=>undefined);
    await migrationFenceHolder.query("SELECT pg_advisory_unlock_all()").catch(()=>undefined);
    await migrationFenceProvisioning.query("ROLLBACK").catch(()=>undefined);
    await Promise.all([migrationFenceHolder.end(),migrationFenceWriter.end(),migrationFenceProvisioning.end()]);
  }
  const mentionValidation=await admin.query(`SELECT
    app.valid_group_mentions(ARRAY['12025550102@c.us']::text[]) AS valid,
    app.valid_group_mentions(ARRAY['12025550112@lid']::text[]) AS lid,
    app.valid_group_mentions(ARRAY['12025550102@c.us','12025550102@c.us']::text[]) AS duplicate,
    app.valid_group_mentions(ARRAY['12025550112@invalid']::text[]) AS invalid`);
  assert.deepEqual(mentionValidation.rows,[{valid:true,lid:true,duplicate:false,invalid:false}]);
  const unscopedTenantForeignKeys=await admin.query(`SELECT source.relname AS source_table,constraint_record.conname,target.relname AS target_table
    FROM pg_constraint constraint_record
    JOIN pg_class source ON source.oid=constraint_record.conrelid
    JOIN pg_class target ON target.oid=constraint_record.confrelid
    JOIN pg_attribute source_tenant ON source_tenant.attrelid=constraint_record.conrelid AND source_tenant.attname='tenant_id' AND NOT source_tenant.attisdropped
    JOIN pg_attribute target_tenant ON target_tenant.attrelid=constraint_record.confrelid AND target_tenant.attname='tenant_id' AND NOT target_tenant.attisdropped
    WHERE constraint_record.contype='f' AND NOT (source_tenant.attnum=ANY(constraint_record.conkey))
    ORDER BY source.relname,constraint_record.conname`);
  assert.deepEqual(unscopedTenantForeignKeys.rows,[]);
  const validatedTenantForeignKeys=await admin.query(`SELECT conname,convalidated FROM pg_constraint WHERE conname=ANY($1::text[]) ORDER BY conname`,[tenantForeignKeys]);
  assert.equal(validatedTenantForeignKeys.rowCount,27);
  assert.ok(validatedTenantForeignKeys.rows.every(row=>row.convalidated));
  await admin.query(`INSERT INTO tenants (id,name,slug,state) VALUES ('10000000-0000-4000-8000-000000000001','Tenant A','tenant-a','ACTIVE'),('20000000-0000-4000-8000-000000000002','Tenant B','tenant-b','ACTIVE');
    INSERT INTO users (id,oidc_subject,email,display_name) VALUES ('10100000-0000-4000-8000-000000000001','oidc-owner-a','owner@a.invalid','Owner A'),('20200000-0000-4000-8000-000000000002','oidc-owner-b','owner@b.invalid','Owner B');
    INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ('10000000-0000-4000-8000-000000000001','10100000-0000-4000-8000-000000000001','tenant_owner'),('20000000-0000-4000-8000-000000000002','20200000-0000-4000-8000-000000000002','tenant_owner');
    INSERT INTO zammad_instances (id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference) VALUES ('11000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','https://a.invalid','test','WORKING','db://a','a','a/','secret://tenants/10000000-0000-4000-8000-000000000001/zammad/service','secret://tenants/10000000-0000-4000-8000-000000000001/zammad/privacy'),('22000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','https://b.invalid','test','WORKING','db://b','b','b/','secret://tenants/20000000-0000-4000-8000-000000000002/zammad/service','secret://tenants/20000000-0000-4000-8000-000000000002/zammad/privacy');
    INSERT INTO connections (id,tenant_id,name,provider,engine,state,secret_reference) VALUES ('12000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A WAHA','WAHA','GOWS','WORKING','secret://a/waha'),('12100000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Dedicated bot WAHA','WAHA','GOWS','WORKING','secret://a/waha-direct'),('23000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','B WAHA','WAHA','GOWS','WORKING','secret://b/waha');
    `);
  // Missing context still rejects even an unrelated WAHA fixture.
  await assert.rejects(()=>admin.query("INSERT INTO provider_sessions(tenant_id,connection_id,opaque_session_id,state,session_storage_reference) VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','session-a','WORKING','storage://a')"),error=>error.code==='42501'&&error.message==='tenant context is required');
  assert.equal((await admin.query("SELECT count(*)::integer AS count FROM provider_sessions WHERE connection_id='12000000-0000-4000-8000-000000000001'")).rows[0].count,0);
  await withFixtureTenant(admin,'10000000-0000-4000-8000-000000000001',async()=>{
    await admin.query("INSERT INTO provider_sessions(tenant_id,connection_id,opaque_session_id,state,session_storage_reference) VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','session-a','WORKING','storage://a')");
    await admin.query(`INSERT INTO webhook_routes (tenant_id,connection_id,provider,route_token_sha256,hmac_secret_reference) VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','WAHA','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','secret://10000000-0000-4000-8000-000000000001/connections/12000000-0000-4000-8000-000000000001/webhook');`);
  });
  await withFixtureTenant(admin,'20000000-0000-4000-8000-000000000002',()=>admin.query("INSERT INTO provider_sessions(tenant_id,connection_id,opaque_session_id,state,session_storage_reference) VALUES ('20000000-0000-4000-8000-000000000002','23000000-0000-4000-8000-000000000002','session-b','WORKING','storage://b')"));
  await admin.query(`
    INSERT INTO whatsapp_groups (id,tenant_id,connection_id,external_group_id,display_name) VALUES ('13000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','120363000000009@g.us','Group A');
    INSERT INTO rule_families (id,tenant_id,name,created_by) VALUES ('14100000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Default','10100000-0000-4000-8000-000000000001');
    INSERT INTO rule_sets (id,tenant_id,family_id,name,version,state,revision,snapshot_sha256,created_by,activated_by,activated_at)
      VALUES (
        '14000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '14100000-0000-4000-8000-000000000001','Default',1,'ACTIVE',1,
        encode(digest(jsonb_build_array(jsonb_build_object(
          'name','Ten digits','matcherType','exact_length','pattern','(?<!\\d)\\d{10}(?!\\d)',
          'matcherOptions',jsonb_build_object('digitLength',10),'priority',1,
          'enabled',true,'savedExamples','[]'::jsonb
        ))::text,'sha256'),'hex'),
        '10100000-0000-4000-8000-000000000001','10100000-0000-4000-8000-000000000001',now()
      );
    INSERT INTO trigger_rules (tenant_id,rule_set_id,name,matcher_type,pattern,matcher_options,priority,enabled) VALUES ('10000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','Ten digits','exact_length','(?<!\\d)\\d{10}(?!\\d)','{"digitLength":10}',1,true);
    INSERT INTO group_bindings (id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state) VALUES ('15000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'ACTIVE');
    INSERT INTO delivery_outbox (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state) VALUES ('16000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','42','9','Resolved','text/plain','delivery-a','QUEUED');
    INSERT INTO tenant_invitations (id,tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256)
      VALUES ('15100000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','invitee@a.invalid','Invitee A','agent',repeat('d',64),now()+interval '1 day','10100000-0000-4000-8000-000000000001','postgres-invitation-a',repeat('e',64));
    INSERT INTO tenant_invitation_email_outbox (id,tenant_id,invitation_id,action,recipient_email,token_ciphertext,token_key_version,idempotency_key,request_sha256)
      VALUES ('15200000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','15100000-0000-4000-8000-000000000001','INVITE','invitee@a.invalid',decode(repeat('ab',128),'hex'),'local-v1','postgres-invitation-email-a',repeat('f',64));`);
  await admin.query(`INSERT INTO provisioning_operations
      (tenant_id,zammad_instance_id,status,action,spec,completed_steps,step_results,completed_at,requested_by)
    VALUES (
      '10000000-0000-4000-8000-000000000001',
      '11000000-0000-4000-8000-000000000001','COMPLETE','PROVISION',
      $1::jsonb,
      '["identity","database","search","storage","secrets","zammad","package","oidc","defaults","health"]',
      $2::jsonb,now(),'postgres-resume-fixture'
    )`,[
    JSON.stringify({deployment:{zammadVersion:"test",release:provisioningRelease}}),
    JSON.stringify(completedProvisioningReleaseEvidence),
  ]);
  await admin.query(`INSERT INTO whatsapp_groups (id,tenant_id,connection_id,external_group_id,display_name)
      VALUES ('25000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','23000000-0000-4000-8000-000000000002','fixture-0010@example.test','Group B');
    INSERT INTO rule_families (id,tenant_id,name,created_by)
      VALUES ('24100000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','Temporary B','20200000-0000-4000-8000-000000000002');
    INSERT INTO rule_sets (id,tenant_id,family_id,name,version,state,revision,snapshot_sha256,created_by)
      VALUES ('24000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','24100000-0000-4000-8000-000000000002','Temporary B',1,'DRAFT',1,repeat('0',64),'20200000-0000-4000-8000-000000000002');
    INSERT INTO group_bindings (id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
      VALUES ('26000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','25000000-0000-4000-8000-000000000002','24000000-0000-4000-8000-000000000002','Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'ACTIVE');
    INSERT INTO delivery_outbox (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state)
      VALUES ('27000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','23000000-0000-4000-8000-000000000002','26000000-0000-4000-8000-000000000002','42','9','Independent tenant delivery','text/plain','delivery-a','QUEUED');`);
  const tenantScopedIdempotency=await admin.query("SELECT tenant_id FROM delivery_outbox WHERE idempotency_key='delivery-a' ORDER BY tenant_id");
  assert.deepEqual(tenantScopedIdempotency.rows,[
    {tenant_id:"10000000-0000-4000-8000-000000000001"},
    {tenant_id:"20000000-0000-4000-8000-000000000002"},
  ]);
  await assert.rejects(
    () => admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id='10000000-0000-4000-8000-000000000001' AND user_id='10100000-0000-4000-8000-000000000001'"),
    error => error.code === "P0001" && /WASALX_LAST_ACTIVE_OWNER/u.test(error.message),
  );
  await admin.query("DELETE FROM delivery_outbox WHERE id='27000000-0000-4000-8000-000000000002'");
  await admin.query(`INSERT INTO client_routing_integrations
      (id,tenant_id,provider,display_name,external_account_id,secret_reference,state,revision,created_by,created_at,updated_at)
    VALUES
      ('87000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','NOTION','Expired A',NULL,'secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000001','CONNECTING',1,'10100000-0000-4000-8000-000000000001',now()-interval '2 hours',now()-interval '2 hours'),
      ('87000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','NOTION','Live A',NULL,'secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000002','CONNECTING',1,'10100000-0000-4000-8000-000000000001',now()-interval '5 minutes',now()-interval '5 minutes'),
      ('87000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','NOTION','Connected A','workspace-a-1','secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000003','CONNECTED',2,'10100000-0000-4000-8000-000000000001',now()-interval '4 days',now()-interval '4 days'),
      ('87000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','NOTION','Connected A second','workspace-a-2','secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000004','CONNECTED',2,'10100000-0000-4000-8000-000000000001',now()-interval '3 days',now()-interval '3 days'),
      ('87000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','NOTION','Old revoked A',NULL,'secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000005','REVOKED',2,'10100000-0000-4000-8000-000000000001',now()-interval '6 days',now()-interval '6 days'),
      ('87000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','HTTP_JSON','CRM JSON',NULL,'secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000006','CONNECTED',1,'10100000-0000-4000-8000-000000000001',now()-interval '2 days',now()-interval '2 days'),
      ('97000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','NOTION','Expired B',NULL,'secret://tenants/20000000-0000-4000-8000-000000000002/routing/integrations/97000000-0000-4000-8000-000000000001','CONNECTING',1,'20200000-0000-4000-8000-000000000002',now()-interval '2 hours',now()-interval '2 hours');
    INSERT INTO client_routing_oauth_states
      (id,tenant_id,integration_id,provider,requested_by,state_sha256,redirect_uri,expires_at)
    VALUES
      ('87100000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','87000000-0000-4000-8000-000000000001','NOTION','10100000-0000-4000-8000-000000000001',repeat('1',64),'https://app.example.invalid/oauth/notion/callback',now()-interval '1 hour'),
      ('87100000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','87000000-0000-4000-8000-000000000002','NOTION','10100000-0000-4000-8000-000000000001',repeat('2',64),'https://app.example.invalid/oauth/notion/callback',now()+interval '1 hour'),
      ('97100000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','97000000-0000-4000-8000-000000000001','NOTION','20200000-0000-4000-8000-000000000002',repeat('3',64),'https://app.example.invalid/oauth/notion/callback',now()-interval '1 hour');`);
  await admin.query("BEGIN");
  try{
    const disposableTenant="39900000-0000-4000-8000-000000000099";
    const disposableInstance="39910000-0000-4000-8000-000000000099";
    await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES ($1,'Assertion cascade','assertion-cascade','ACTIVE')",[disposableTenant]);
    await admin.query(`INSERT INTO zammad_instances(id,tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference)
      VALUES ($2::uuid,$1::uuid,'https://assertion.invalid','test','WORKING','db://assertion','assertion','assertion/','secret://tenants/'||$1::uuid::text||'/zammad/service','secret://tenants/'||$1::uuid::text||'/zammad/privacy')`,[disposableTenant,disposableInstance]);
    await admin.query(`INSERT INTO zammad_service_assertion_jtis(tenant_id,zammad_instance_id,jti,expires_at)
      VALUES ($1,$2,'39920000-0000-4000-8000-000000000099',now()+interval '2 minutes')`,[disposableTenant,disposableInstance]);
    await admin.query("DELETE FROM tenants WHERE id=$1",[disposableTenant]);
    assert.equal((await admin.query("SELECT count(*)::integer AS count FROM zammad_service_assertion_jtis WHERE tenant_id=$1",[disposableTenant])).rows[0].count,0);
    await admin.query("ROLLBACK");
  }catch(error){await admin.query("ROLLBACK");throw error}
}finally{
  await admin.end();
  if(qualifyMigrations)printScenarioTiming("migrations",migrationStartedAt);
}
}

async function runSharedCore(){
executed.push("sharedCore");
const sharedCoreStartedAt=performance.now();
const app=new Client({connectionString:appUrl});await app.connect();
const cleanup=new Client({connectionString:cleanupUrl.toString()});await cleanup.connect();
const provisioning=new Client({connectionString:provisioningUrl.toString()});await provisioning.connect();
const support=new Client({connectionString:supportUrl.toString()});await support.connect();
const wahaRegistry=new Client({connectionString:wahaRegistryUrl.toString()});await wahaRegistry.connect();
const wahaOperator=new Client({connectionString:wahaOperatorUrl.toString()});await wahaOperator.connect();
const wahaRolloutGate=new Client({connectionString:wahaRolloutGateUrl.toString()});await wahaRolloutGate.connect();
const invitationMailer=new Client({connectionString:invitationMailerUrl.toString()});await invitationMailer.connect();
const identityPolicy=new Client({connectionString:identityPolicyUrl.toString()});await identityPolicy.connect();
const meteringIngest=new Client({connectionString:meteringIngestUrl.toString()});await meteringIngest.connect();
const platformOperations=new Client({connectionString:platformOperationsUrl.toString()});await platformOperations.connect();
const connectorWorker=new Client(connectorWorkerConfig);await connectorWorker.connect();
const workspaceProvider=new Client({connectionString:workspaceProviderUrl.toString()});await workspaceProvider.connect();
const workspaceStore=new PostgresProviderStore(workspaceProviderUrl.toString());
const fixtureAdmin=new Client({connectionString:adminUrl});
async function tenant(id,operation){await app.query("BEGIN");try{await app.query("SELECT set_config('app.tenant_id',$1,true)",[id]);const result=await operation();await app.query("COMMIT");return result}catch(error){await app.query("ROLLBACK");throw error}}
async function workerTenant(id,operation){await connectorWorker.query("BEGIN");try{await connectorWorker.query("SELECT set_config('app.tenant_id',$1,true)",[id]);const result=await operation();await connectorWorker.query("COMMIT");return result}catch(error){await connectorWorker.query("ROLLBACK");throw error}}
let sharedCorePrerequisitesPassed=false,sharedCoreSummary,sharedCoreFailure;
let sharedCoreCleanupFailures=[];
const sharedCoreEnvironment={...process.env},sharedCoreFetch=globalThis.fetch;
try{
  await fixtureAdmin.connect();
  const appIdentity=await app.query(`SELECT
    current_user AS current_user,
    role.rolsuper AS is_superuser,
    role.rolbypassrls AS bypasses_rls,
    pg_has_role(current_user,'wasalx_app','MEMBER') AS app_member
    FROM pg_roles role WHERE role.rolname=current_user`);
  assert.deepEqual(appIdentity.rows,[{
    current_user:"wasalx_runtime",is_superuser:false,bypasses_rls:false,app_member:true,
  }]);
  const workerIdentity=await connectorWorker.query(`SELECT current_user,session_user,role.rolsuper AS is_superuser,
    role.rolbypassrls AS bypasses_rls,
    pg_has_role(current_user,'wasalx_connector_worker','MEMBER') AS worker_member,
    pg_has_role(current_user,'wasalx_app','MEMBER') AS app_member,
    pg_has_role(session_user,'wasalx_app','MEMBER') AS session_app_member,
    has_table_privilege(current_user,'bot_assignments','UPDATE') AS assignment_table_update,
    has_column_privilege(current_user,'bot_assignments','id','UPDATE') AS assignment_id_update,
    has_column_privilege(current_user,'bot_assignments','state','UPDATE') AS assignment_state_update
    FROM pg_roles role WHERE role.rolname=current_user`);
  assert.deepEqual(workerIdentity.rows,[{
    current_user:"wasalx_connector_worker",session_user:"wasalx_connector_worker_runtime",
    is_superuser:false,bypasses_rls:false,worker_member:true,app_member:false,session_app_member:false,
    assignment_table_update:false,assignment_id_update:true,assignment_state_update:false,
  }]);
  assert.deepEqual((await connectorWorker.query(`SELECT
    has_table_privilege(current_user,'public.group_bindings','UPDATE') AS table_update,
    ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid='public.group_bindings'::regclass
      AND attnum>0 AND NOT attisdropped AND has_column_privilege(current_user,attrelid,attnum,'UPDATE') ORDER BY attname) AS update_columns,
    relrowsecurity AS rls,relforcerowsecurity AS forced
    FROM pg_class WHERE oid='public.group_bindings'::regclass`)).rows,
  [{table_update:false,update_columns:["id"],rls:true,forced:true}]);
  assert.equal((await workerTenant("10000000-0000-4000-8000-000000000001",()=>connectorWorker.query(
    "SELECT id FROM group_bindings WHERE id='15000000-0000-4000-8000-000000000001' FOR UPDATE",
  ))).rowCount,1);
  assert.equal((await workerTenant("20000000-0000-4000-8000-000000000002",()=>connectorWorker.query(
    "SELECT id FROM group_bindings WHERE id='15000000-0000-4000-8000-000000000001' FOR UPDATE",
  ))).rowCount,0);
  await assert.rejects(()=>workerTenant("10000000-0000-4000-8000-000000000001",()=>connectorWorker.query(
    "UPDATE group_bindings SET state='PAUSED' WHERE id='15000000-0000-4000-8000-000000000001'",
  )),error=>error.code==="42501");
  await assert.rejects(()=>workerTenant("10000000-0000-4000-8000-000000000001",()=>connectorWorker.query(
    "UPDATE group_bindings SET id='15000000-0000-4000-8000-000000000099' WHERE id='15000000-0000-4000-8000-000000000001'",
  )),error=>error.code==="23514"&&error.message==="group binding identity is immutable");
  const purgeBoundary=await connectorWorker.query(`SELECT procedure.prosecdef AS security_definer,
    owner.rolname AS owner,procedure.proconfig AS config,
    has_function_privilege(current_user,procedure.oid,'EXECUTE') AS worker_execute,
    has_table_privilege(current_user,'public.event_inbox','DELETE') AS worker_delete,
    has_table_privilege(owner.rolname,'public.event_inbox','DELETE') AS owner_delete,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,acldefault('f',procedure.proowner))) acl
      WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc procedure JOIN pg_roles owner ON owner.oid=procedure.proowner
    WHERE procedure.oid='app.purge_expired_unmatched_events(interval,timestamptz)'::regprocedure`);
  assert.deepEqual(purgeBoundary.rows,[{security_definer:true,owner:"wasalx_app",
    config:["search_path=pg_catalog, public, app, pg_temp","row_security=on"],
    worker_execute:true,worker_delete:false,owner_delete:true,public_execute:false}]);
  for(const role of ["wasalx_app","wasalx_connector_worker"]){
    assert.deepEqual((await connectorWorker.query(`SELECT rolcanlogin AS login,rolsuper AS superuser,rolbypassrls AS bypass,
      has_schema_privilege(rolname,'public','CREATE') AS public_create,
      has_schema_privilege(rolname,'app','CREATE') AS app_create FROM pg_roles WHERE rolname=$1`,[role])).rows,
    [{login:false,superuser:false,bypass:false,public_create:false,app_create:false}]);
  }
  for(const table of ["event_inbox","normalized_messages","privacy_legal_holds","group_workspace_participants","media_objects"]){
    assert.deepEqual((await connectorWorker.query(`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced
      FROM pg_class WHERE oid=$1::regclass`,[`public.${table}`])).rows,[{enabled:true,forced:true}]);
  }
  for(const [table,allowed] of [
    ["participant_identities",["display_name","display_name_quality","normalized_phone"]],
    ["message_links",["zammad_article_id"]],
    ["group_workspace_participants",["normalized_phone","display_name","synchronized_at"]],
    ["media_objects",["expires_at","scan_state"]],
  ]){
    assert.equal((await connectorWorker.query(
      "SELECT has_table_privilege(current_user,$1,'UPDATE') AS allowed",[table],
    )).rows[0].allowed,false);
    const columns=await connectorWorker.query(`SELECT column_name,
      has_column_privilege(current_user,$1,column_name,'UPDATE') AS allowed
      FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`,[table]);
    assert.ok(columns.rowCount>allowed.length);
    for(const column of columns.rows)assert.equal(column.allowed,allowed.includes(column.column_name),`${table}.${column.column_name}`);
  }
  for(const statement of [
    "SELECT id FROM users LIMIT 1",
    "SELECT tenant_id FROM tenant_memberships LIMIT 1",
    "SELECT id FROM tenant_invitations LIMIT 1",
    "UPDATE tenant_settings SET default_theme='LIGHT'",
    "SELECT * FROM app.accept_tenant_invitation(repeat('0',64),'worker-probe','worker-probe@example.invalid','Worker probe')",
  ])await assert.rejects(()=>connectorWorker.query(statement),error=>error.code==="42501");
  await assert.rejects(()=>connectorWorker.query("SELECT id FROM connections LIMIT 1"),error=>error.code==="42501");
  // Migration/role/RLS admission stays fail-fast; later shared assertions must not hide isolated suites.
  sharedCorePrerequisitesPassed=true;
  const workerTenantA=await workerTenant("10000000-0000-4000-8000-000000000001",async()=>{
    await connectorWorker.query("SAVEPOINT worker_link_upsert_probe");
    for(const article of [null,"99","100"]){
      const linked=await connectorWorker.query(`INSERT INTO message_links
        (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction)
        VALUES (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','worker-link-upsert-proof','42',$1,'OUTBOUND')
        ON CONFLICT (connection_id,external_message_id,zammad_ticket_id)
        DO UPDATE SET zammad_article_id=COALESCE(message_links.zammad_article_id,EXCLUDED.zammad_article_id)
        RETURNING zammad_article_id`,[article]);
      assert.equal(linked.rows[0].zammad_article_id,article===null?null:"99");
    }
    await connectorWorker.query("SELECT set_config('app.tenant_id','20000000-0000-4000-8000-000000000002',true)");
    assert.equal((await connectorWorker.query("SELECT count(*)::integer AS count FROM message_links WHERE external_message_id='worker-link-upsert-proof'")).rows[0].count,0);
    await connectorWorker.query("ROLLBACK TO SAVEPOINT worker_link_upsert_probe");
    await connectorWorker.query("SAVEPOINT worker_participant_upsert_probe");
    for(const [phone,name] of [["+12025550113","Worker roster proof"],["+12025550114",null]]){
      const roster=await connectorWorker.query(`INSERT INTO group_workspace_participants
        (tenant_id,whatsapp_group_id,external_participant_id,normalized_phone,display_name,synchronized_at)
        VALUES (app.current_tenant_id(),'13000000-0000-4000-8000-000000000001','12025550113@c.us',$1,$2,now())
        ON CONFLICT (tenant_id,whatsapp_group_id,external_participant_id) DO UPDATE
          SET normalized_phone=EXCLUDED.normalized_phone,
              display_name=COALESCE(EXCLUDED.display_name,group_workspace_participants.display_name),
              synchronized_at=EXCLUDED.synchronized_at
        RETURNING normalized_phone,display_name`,[phone,name]);
      assert.deepEqual(roster.rows,[{normalized_phone:phone,display_name:"Worker roster proof"}]);
    }
    await connectorWorker.query("SELECT set_config('app.tenant_id','20000000-0000-4000-8000-000000000002',true)");
    assert.equal((await connectorWorker.query("SELECT 1 FROM group_workspace_participants WHERE external_participant_id='12025550113@c.us'")).rowCount,0);
    assert.equal((await connectorWorker.query("UPDATE group_workspace_participants SET display_name='Cross tenant' WHERE external_participant_id='12025550113@c.us'")).rowCount,0);
    await connectorWorker.query("SAVEPOINT denied_participant_probe");
    await assert.rejects(()=>connectorWorker.query(`INSERT INTO group_workspace_participants
      (tenant_id,whatsapp_group_id,external_participant_id) VALUES
      ('10000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','12025550115@c.us')`),error=>error.code==="42501");
    await connectorWorker.query("ROLLBACK TO SAVEPOINT denied_participant_probe");
    await connectorWorker.query("ROLLBACK TO SAVEPOINT worker_participant_upsert_probe");
    await connectorWorker.query("SELECT id FROM bot_assignments WHERE false FOR SHARE OF bot_assignments");
    assert.equal((await connectorWorker.query(
      "SELECT count(*)::integer AS count FROM connections WHERE tenant_id='20000000-0000-4000-8000-000000000002'",
    )).rows[0].count,0);
    await connectorWorker.query(`INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,request_id)
      VALUES (app.current_tenant_id(),'SYSTEM','connector-worker-test','worker.role_probe','worker','connector-worker','postgres-worker-role-probe')`);
    await connectorWorker.query("SAVEPOINT worker_claim_probe");
    const claimed=await connectorWorker.query(
      "SELECT id FROM app.claim_delivery_jobs('41000000-0000-4000-8000-000000000099',1)",
    );
    await connectorWorker.query("ROLLBACK TO SAVEPOINT worker_claim_probe");
    return claimed.rowCount;
  });
  assert.ok(workerTenantA>=0);
  const mediaRoleRepository=new InboundRepository(new Pool(connectorWorkerConfig));
  const mediaRoleRecord={id:"63900000-0000-4000-8000-000000000099",
    tenantId:"10000000-0000-4000-8000-000000000001",sha256:"9".repeat(64),
    objectKey:`10000000-0000-4000-8000-000000000001/sha256/99/${"9".repeat(64)}`,mimeType:"image/png",byteSize:128,
    expiresAt:"2099-01-01T00:00:00.000Z",createdAt:"2026-09-01T00:00:00.000Z"};
  try{
    assert.equal((await mediaRoleRepository.reserve(mediaRoleRecord)).scanState,"STAGING");
    const renewed={...mediaRoleRecord,expiresAt:"2099-02-01T00:00:00.000Z"};
    assert.equal((await mediaRoleRepository.reserve(renewed)).expiresAt,renewed.expiresAt);
    assert.equal((await mediaRoleRepository.promote(renewed)).id,mediaRoleRecord.id);
    assert.equal((await mediaRoleRepository.findByHash(mediaRoleRecord.tenantId,mediaRoleRecord.sha256)).id,mediaRoleRecord.id);
    await workerTenant("20000000-0000-4000-8000-000000000002",async()=>{
      assert.equal((await connectorWorker.query("SELECT id FROM media_objects WHERE id=$1",[mediaRoleRecord.id])).rowCount,0);
      assert.equal((await connectorWorker.query("UPDATE media_objects SET scan_state='CLEAN' WHERE id=$1",[mediaRoleRecord.id])).rowCount,0);
      await connectorWorker.query("SAVEPOINT denied_media_probe");
      await assert.rejects(()=>connectorWorker.query(`INSERT INTO media_objects
        (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at)
        VALUES ('63900000-0000-4000-8000-000000000098',$1::uuid,repeat('8',64),$1::text||'/sha256/88/'||repeat('8',64),'image/png',128,'STAGING',now())`,
      [mediaRoleRecord.tenantId]),error=>error.code==="42501");
      await connectorWorker.query("ROLLBACK TO SAVEPOINT denied_media_probe");
    });
    await workerTenant(mediaRoleRecord.tenantId,async()=>{
      await connectorWorker.query("SAVEPOINT denied_media_identity");
      await assert.rejects(()=>connectorWorker.query("UPDATE media_objects SET object_key='changed' WHERE id=$1",[mediaRoleRecord.id]),error=>error.code==="42501");
      await connectorWorker.query("ROLLBACK TO SAVEPOINT denied_media_identity");
    });
  }finally{
    await mediaRoleRepository.close();
    await tenant(mediaRoleRecord.tenantId,()=>app.query("DELETE FROM media_objects WHERE id=$1",[mediaRoleRecord.id]));
  }
  const workerStatusDeliveryId="16900000-0000-4000-8000-000000000099";
  await workerTenant("10000000-0000-4000-8000-000000000001",async()=>{
    const deliveryId=workerStatusDeliveryId;
    await connectorWorker.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at)
      VALUES ($1,app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','42','99','Status projection proof','text/plain','worker-status-projection','SENDING',1,'41000000-0000-4000-8000-000000000098',now()+interval '1 minute')`,[deliveryId]);
    await connectorWorker.query(`INSERT INTO delivery_attempts (tenant_id,delivery_id,attempt_number,state)
      VALUES (app.current_tenant_id(),$1,1,'SENDING')`,[deliveryId]);
    await connectorWorker.query(`INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id)
      VALUES (app.current_tenant_id(),$1,'42'),(app.current_tenant_id(),$1,'43')`,[deliveryId]);
    await connectorWorker.query(`INSERT INTO message_links
      (tenant_id,connection_id,external_message_id,zammad_ticket_id,direction)
      VALUES (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','provider-status-proof','42','OUTBOUND')`);
  });
  const renewalTenant="10000000-0000-4000-8000-000000000001";
  const renewalLease="41000000-0000-4000-8000-000000000098";
  const replacementLease="41000000-0000-4000-8000-000000000097";
  const renewalJob={id:workerStatusDeliveryId,tenantId:renewalTenant,
    connectionId:"12000000-0000-4000-8000-000000000001",ticketId:"42",articleId:"99",attempts:1};
  const renewalApp="wasalx-delivery-renew-privacy-test";
  const workerCompletionRepository=new OutboxRepository(new Pool({
    ...connectorWorkerConfig,max:1,statement_timeout:15_000,application_name:renewalApp,
  }));
  const privacyHolder=new Client({connectionString:appUrl});
  const renewalObserver=new Client({connectionString:adminUrl});
  let pendingRenewal;
  await Promise.all([privacyHolder.connect(),renewalObserver.connect()]);
  try{
    for(const changeLease of [false,true]){
      await privacyHolder.query("BEGIN");
      await privacyHolder.query("SELECT set_config('app.tenant_id',$1,true)",[renewalTenant]);
      await privacyHolder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${renewalTenant}`]);
      const holderPid=(await privacyHolder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if(changeLease)await privacyHolder.query(
        "UPDATE delivery_outbox SET lease_id=$1 WHERE tenant_id=$2 AND id=$3",
        [replacementLease,renewalTenant,workerStatusDeliveryId],
      );
      let settled=false;
      pendingRenewal=workerCompletionRepository.renewDeliveryLease(renewalJob,renewalLease)
        .then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});
      let waiting=false;
      const waitDeadline=performance.now()+10_000;
      while(!waiting&&!settled&&performance.now()<waitDeadline){
        waiting=(await renewalObserver.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND application_name=$1
            AND wait_event_type='Lock' AND lower(wait_event)='advisory'
            AND $2::integer=ANY(pg_blocking_pids(pid))
        ) AS waiting`,[renewalApp,holderPid])).rows[0].waiting;
        if(!waiting&&!settled)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true,"Actual delivery renewal must wait for the privacy advisory lock");
      assert.equal(settled,false);
      await privacyHolder.query("COMMIT");
      const result=await pendingRenewal;pendingRenewal=undefined;
      if(result.error)throw result.error;
      assert.equal(result.value,!changeLease);
      await workerTenant(renewalTenant,async()=>{
        const row=(await connectorWorker.query(`SELECT state,attempts,lease_id,external_message_id,
          (SELECT count(*)::integer FROM delivery_attempts a
            WHERE a.tenant_id=d.tenant_id AND a.delivery_id=d.id) AS attempt_count,
          (SELECT state FROM delivery_attempts a
            WHERE a.tenant_id=d.tenant_id AND a.delivery_id=d.id AND a.attempt_number=1) AS attempt_state,
          lease_expires_at>clock_timestamp()+interval '4 minutes' AS extended
          FROM delivery_outbox d WHERE d.id=$1`,[workerStatusDeliveryId])).rows[0];
        assert.deepEqual(row,{state:"SENDING",attempts:1,
          lease_id:changeLease?replacementLease:renewalLease,external_message_id:null,
          attempt_count:1,attempt_state:"SENDING",extended:true});
      });
    }
    // Restore only the synthetic fixture's lease for the existing completion proof.
    await workerTenant(renewalTenant,()=>connectorWorker.query(
      "UPDATE delivery_outbox SET lease_id=$1 WHERE id=$2 AND state='SENDING' AND lease_id=$3",
      [renewalLease,workerStatusDeliveryId,replacementLease],
    ));
    await workerCompletionRepository.complete(renewalJob,renewalLease,"SENT","provider-status-proof");
  }finally{
    await privacyHolder.query("ROLLBACK").catch(()=>{});
    if(pendingRenewal)await pendingRenewal;
    await workerTenant(renewalTenant,()=>connectorWorker.query(
      "UPDATE delivery_outbox SET lease_id=$1 WHERE id=$2 AND state='SENDING' AND lease_id=$3",
      [renewalLease,workerStatusDeliveryId,replacementLease],
    ));
    await Promise.all([privacyHolder.end(),renewalObserver.end(),workerCompletionRepository.close()]);
  }
  await workerTenant("10000000-0000-4000-8000-000000000001",async()=>{
    const deliveryId=workerStatusDeliveryId;
    assert.deepEqual((await connectorWorker.query(`SELECT zammad_ticket_id,zammad_article_id
      FROM message_links WHERE external_message_id='provider-status-proof' ORDER BY zammad_ticket_id`)).rows,
    [{zammad_ticket_id:"42",zammad_article_id:"99"},{zammad_ticket_id:"43",zammad_article_id:"99"}]);
    assert.equal((await connectorWorker.query("SELECT state FROM delivery_attempts WHERE delivery_id=$1 AND attempt_number=1",[deliveryId])).rows[0].state,"SENT");
    assert.equal((await connectorWorker.query(
      "SELECT app.project_delivery_status($1,'SENT','provider-status-proof',NULL)",[deliveryId],
    )).rows[0].project_delivery_status,2);
    assert.equal((await connectorWorker.query(
      "SELECT app.project_delivery_status($1,'SENT','provider-status-proof',NULL)",[deliveryId],
    )).rows[0].project_delivery_status,2);
    await connectorWorker.query("UPDATE delivery_outbox SET state='DELIVERED' WHERE id=$1",[deliveryId]);
    assert.equal((await connectorWorker.query(
      "SELECT app.project_delivery_status($1,'DELIVERED','provider-status-proof',NULL)",[deliveryId],
    )).rows[0].project_delivery_status,2);
    assert.deepEqual((await connectorWorker.query(
      "SELECT zammad_ticket_id,delivery_state FROM zammad_status_outbox WHERE delivery_id=$1 ORDER BY zammad_ticket_id",
      [deliveryId],
    )).rows,[
      {zammad_ticket_id:"42",delivery_state:"DELIVERED"},
      {zammad_ticket_id:"43",delivery_state:"DELIVERED"},
    ]);
  });
  await assert.rejects(
    ()=>workerTenant("10000000-0000-4000-8000-000000000001",()=>connectorWorker.query("DELETE FROM delivery_outbox WHERE id=$1",[workerStatusDeliveryId])),
    error=>error?.code==="42501",
  );
  assert.equal((await workerTenant("10000000-0000-4000-8000-000000000001",()=>connectorWorker.query(
    "SELECT count(*)::integer AS count FROM delivery_outbox WHERE id=$1",[workerStatusDeliveryId],
  ))).rows[0].count,1);
  assert.ok((await workerTenant("20000000-0000-4000-8000-000000000002",()=>connectorWorker.query(
    "SELECT count(*)::integer AS count FROM connections",
  ))).rows[0].count>0);
  await assert.rejects(
    ()=>workerTenant("10000000-0000-4000-8000-000000000001",()=>connectorWorker.query(
      "UPDATE audit_events SET action='worker.role_probe_mutated' WHERE request_id='postgres-worker-role-probe'",
    )),
    error=>error.code==="42501",
  );
  const constraintFailure=(code,constraint)=>(error)=>error.code===code&&error.constraint===constraint;
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO connections
      (id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES ('12900000-0000-4000-8000-000000000099',app.current_tenant_id(),'Wrong Meta owner','META','CLOUD_API','PAUSED',
        'secret://20000000-0000-4000-8000-000000000002/connections/22900000-0000-4000-8000-000000000098/meta')`)),
    constraintFailure("23514","connections_meta_secret_owner_check"),
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`UPDATE webhook_routes
      SET hmac_secret_reference='secret://20000000-0000-4000-8000-000000000002/connections/22100000-0000-4000-8000-000000000002/webhook'
      WHERE connection_id='12000000-0000-4000-8000-000000000001'`)),
    constraintFailure("23514","webhook_routes_secret_owner_check"),
  );
  const zammadSecretOwnershipProbes=[
    ["service_secret_reference","secret://tenants/20000000-0000-4000-8000-000000000002/zammad/service"],
    ["privacy_secret_reference","secret://tenants/20000000-0000-4000-8000-000000000002/zammad/privacy"],
  ];
  const invalidRoutingSecretReferences=[
    "secret://tenants/20000000-0000-4000-8000-000000000002/routing/crm",
    "secret://tenants/10000000-0000-4000-8000-000000000001/routing/x/../../../escape",
    "secret://tenants/10000000-0000-4000-8000-000000000001/routing/a//b",
    "secret://tenants/10000000-0000-4000-8000-000000000001/routing/a/",
  ];
  for(const [column,reference] of zammadSecretOwnershipProbes)await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      `UPDATE zammad_instances SET ${column}=$1 WHERE id='11000000-0000-4000-8000-000000000001'`,[reference],
    )),
    error=>error.code==="42501",
  );
  const constraintAdmin=new Client({connectionString:adminUrl});await constraintAdmin.connect();
  try{
    await constraintAdmin.query("BEGIN");
    for(const [column,reference] of zammadSecretOwnershipProbes){
      await constraintAdmin.query("SAVEPOINT zammad_secret_owner_probe");
      await assert.rejects(
        constraintAdmin.query(`UPDATE zammad_instances SET ${column}=$1 WHERE id='11000000-0000-4000-8000-000000000001'`,[reference]),
        constraintFailure("23514","zammad_instances_secret_owner_check"),
      );
      await constraintAdmin.query("ROLLBACK TO SAVEPOINT zammad_secret_owner_probe");
    }
    for(const reference of invalidRoutingSecretReferences){
      await constraintAdmin.query("SAVEPOINT routing_integration_secret_probe");
      await assert.rejects(
        constraintAdmin.query(
          "UPDATE client_routing_integrations SET secret_reference=$1 WHERE id='87000000-0000-4000-8000-000000000003'",[reference],
        ),
        constraintFailure("23514","client_routing_integrations_secret_reference_check"),
      );
      await constraintAdmin.query("ROLLBACK TO SAVEPOINT routing_integration_secret_probe");
    }
  }finally{
    await constraintAdmin.query("ROLLBACK").catch(()=>undefined);
    await constraintAdmin.end();
  }
  for(const reference of invalidRoutingSecretReferences)await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE client_routing_integrations SET secret_reference=$1 WHERE id='87000000-0000-4000-8000-000000000003'",[reference],
    )),
    error=>error.code==="42501",
  );
  const actorGuardCoverage=await app.query(`WITH actor_columns AS (
    SELECT DISTINCT source.oid AS relation_id,source.relname AS table_name,
      source_attribute.attname AS column_name
    FROM pg_constraint foreign_key
    JOIN pg_class source ON source.oid=foreign_key.conrelid
    JOIN pg_namespace source_namespace ON source_namespace.oid=source.relnamespace
    JOIN pg_class target ON target.oid=foreign_key.confrelid
    JOIN pg_namespace target_namespace ON target_namespace.oid=target.relnamespace
    CROSS JOIN LATERAL unnest(foreign_key.conkey) WITH ORDINALITY AS source_key(attnum,ordinal)
    JOIN LATERAL unnest(foreign_key.confkey) WITH ORDINALITY AS target_key(attnum,ordinal)
      ON target_key.ordinal=source_key.ordinal
    JOIN pg_attribute source_attribute ON source_attribute.attrelid=source.oid
      AND source_attribute.attnum=source_key.attnum
    JOIN pg_attribute target_attribute ON target_attribute.attrelid=target.oid
      AND target_attribute.attnum=target_key.attnum
    WHERE foreign_key.contype='f' AND source_namespace.nspname='public'
      AND target_namespace.nspname='public' AND target.relname='users'
      AND target_attribute.attname='id'
      AND EXISTS (SELECT 1 FROM pg_attribute tenant_attribute
        WHERE tenant_attribute.attrelid=source.oid AND tenant_attribute.attname='tenant_id'
          AND tenant_attribute.attnum>0 AND NOT tenant_attribute.attisdropped)
  )
  SELECT actor.table_name,actor.column_name FROM actor_columns actor
  WHERE NOT (actor.table_name='tenant_memberships' AND actor.column_name='user_id')
    -- A retained lifecycle subject is not an acting-user attribution. Its
    -- dedicated writer and immutable binding must remain enforced effectively,
    -- including inherited/PUBLIC grants, before this narrow exception applies.
    AND NOT (actor.table_name='native_membership_projections' AND actor.column_name='user_id'
      AND NOT has_any_column_privilege('wasalx_app',actor.relation_id,'INSERT')
      AND NOT has_column_privilege('wasalx_app',actor.relation_id,actor.column_name,'UPDATE')
      AND NOT has_table_privilege('wasalx_app',actor.relation_id,'DELETE')
      AND EXISTS (SELECT 1 FROM pg_trigger immutable
        WHERE immutable.tgrelid=actor.relation_id AND immutable.tgname='native_membership_immutable'
          AND NOT immutable.tgisinternal AND immutable.tgenabled IN ('O','A')
          AND immutable.tgfoid='app.protect_native_membership_identity()'::regprocedure))
    AND NOT EXISTS (SELECT 1 FROM pg_trigger guard
      WHERE guard.tgrelid=actor.relation_id AND guard.tgname='tenant_actor_membership_guard'
        AND NOT guard.tgisinternal AND guard.tgenabled IN ('O','A')
        AND guard.tgfoid='app.enforce_bot_action_actor_membership()'::regprocedure
        AND position(convert_to(actor.column_name,'UTF8')||decode('00','hex') in guard.tgargs)>0)
  ORDER BY actor.table_name,actor.column_name`);
  assert.deepEqual(actorGuardCoverage.rows,[]);
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE tenant_settings SET updated_by=$1 WHERE tenant_id=app.current_tenant_id()",
      ["20200000-0000-4000-8000-000000000002"],
    )),
    error=>error.code==="42501",
  );
  assert.ok((await app.query(`SELECT count(*)::integer AS count FROM pg_trigger
    WHERE tgname='tenant_actor_membership_guard' AND NOT tgisinternal AND tgenabled IN ('O','A')`)).rows[0].count>0);
  const specializedActorGuards=await app.query(`WITH expected(table_name,trigger_name,function_name) AS (VALUES
      ('consent_records','consent_actor_membership_guard','app.enforce_consent_actor_membership()'),
      ('audit_events','audit_event_actor_membership_guard','app.enforce_audit_event_actor_membership()')
    )
    SELECT expected.table_name,expected.trigger_name FROM expected
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger guard
      JOIN pg_class relation ON relation.oid=guard.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname=expected.table_name
        AND guard.tgname=expected.trigger_name AND NOT guard.tgisinternal
        AND guard.tgenabled IN ('O','A') AND guard.tgfoid=to_regprocedure(expected.function_name))
    ORDER BY expected.table_name`);
  assert.deepEqual(specializedActorGuards.rows,[]);
  const workspaceRequest=(tenantId,operationId,idempotencyKey)=>({
    version:1,tenant_id:tenantId,operation_id:operationId,action:"verify",generation:1,
    fencing_token:1,idempotency_key:idempotencyKey,
    desired:{
      tenant_id:tenantId,slug:`workspace-${tenantId.slice(0,8)}`,region:"test",
      owner:{oidcSubject:"workspace-owner",email:"workspace@example.invalid",displayName:"Workspace owner"},
      database:{isolation:"DedicatedDatabaseAndRole",databaseName:"workspace",roleName:"workspace",secretReference:`secret://tenants/${tenantId}/zammad/database`},
      search:{isolation:"DedicatedNamespaceAndCredential",namespace:"workspace",secretReference:`secret://tenants/${tenantId}/zammad/search`},
      storage:{isolation:"DedicatedPrefixAndCredential",prefix:`tenant/${tenantId}/`,secretReference:`secret://tenants/${tenantId}/zammad/storage`},
      service_secret_reference:`secret://tenants/${tenantId}/zammad/service`,
      privacy_secret_reference:`secret://tenants/${tenantId}/zammad/privacy`,
      zammad:{instanceId:operationId,version:"7.1.3",hostname:"workspace.example.invalid",packageVersion:"0.5.80",packageSha256:"a".repeat(64)},

      oidc:{issuer:"https://identity.example.invalid/realms/wasalx",clientId:"workspace",secretReference:`secret://tenants/${tenantId}/zammad/oidc`,disablePasswordLogin:true},
      retention_days:90,desired_state:"Active",desired_step:"health",
    },
  });
  const workspaceA=workspaceRequest(
    "71000000-0000-4000-8000-000000000001","71100000-0000-4000-8000-000000000001","workspace-provider-a",
  );
  const workspaceB=workspaceRequest(
    "72000000-0000-4000-8000-000000000002","72100000-0000-4000-8000-000000000002","workspace-provider-b",
  );
  const workspaceResponse=input=>({
    status:"READY",tenant_id:input.tenant_id,action:input.action,fencing_token:input.fencing_token,
    idempotency_key:input.idempotency_key,evidence:{verified:true},
  });
  assert.equal(await workspaceStore.ready(),true);
  for(const input of [workspaceA,workspaceB]){
    const claim=await workspaceStore.claim(input);assert.equal(claim.kind,"CLAIMED");
    await workspaceStore.complete(input,claim.token,workspaceResponse(input));
    assert.deepEqual(await workspaceStore.claim(input),{kind:"REPLAY",response:workspaceResponse(input)});
  }
  await assert.rejects(
    ()=>workspaceProvider.query("SELECT tenant_id FROM workspace_provider.operations"),
    error=>error.code==="42501",
  );
  for(const [tenantId,otherTenant] of [[workspaceA.tenant_id,workspaceB.tenant_id],[workspaceB.tenant_id,workspaceA.tenant_id]]){
    await workspaceProvider.query("BEGIN");
    try{
      await workspaceProvider.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      assert.equal((await workspaceProvider.query(
        "SELECT count(*)::integer AS count FROM workspace_provider.operations WHERE tenant_id=$1",[tenantId],
      )).rows[0].count,1);
      assert.equal((await workspaceProvider.query(
        "SELECT count(*)::integer AS count FROM workspace_provider.operations WHERE tenant_id=$1",[otherTenant],
      )).rows[0].count,0);
      await workspaceProvider.query("SAVEPOINT workspace_provider_cross_tenant_probe");
      try{
        await assert.rejects(
          ()=>workspaceProvider.query(
            "INSERT INTO workspace_provider.tenants(tenant_id,highest_fencing_token) VALUES ($1,1)",[otherTenant],
          ),
          error=>error.code==="42501",
        );
      }finally{
        await workspaceProvider.query("ROLLBACK TO SAVEPOINT workspace_provider_cross_tenant_probe");
        await workspaceProvider.query("RELEASE SAVEPOINT workspace_provider_cross_tenant_probe");
      }
      await workspaceProvider.query("SAVEPOINT workspace_provider_append_only_probe");
      try{
        await assert.rejects(
          ()=>workspaceProvider.query("UPDATE workspace_provider.audit_events SET event_type='MUTATED' WHERE tenant_id=$1",[tenantId]),
          error=>error.code==="42501",
        );
      }finally{
        await workspaceProvider.query("ROLLBACK TO SAVEPOINT workspace_provider_append_only_probe");
        await workspaceProvider.query("RELEASE SAVEPOINT workspace_provider_append_only_probe");
      }
    }finally{await workspaceProvider.query("ROLLBACK")}
  }
  const botAssignmentPrivileges=await app.query(`SELECT
    has_function_privilege('wasalx_app','app.assign_bot_flow(uuid,uuid,text,uuid)','EXECUTE') AS app_legacy,
    has_function_privilege('wasalx_app','app.assign_bot_flow(uuid,uuid,text,uuid,uuid)','EXECUTE') AS app_current,
    has_function_privilege('public','app.assign_bot_flow(uuid,uuid,text,uuid)','EXECUTE') AS public_legacy,
    has_function_privilege('public','app.assign_bot_flow(uuid,uuid,text,uuid,uuid)','EXECUTE') AS public_current`);
  assert.deepEqual(botAssignmentPrivileges.rows,[{
    app_legacy:false,app_current:true,public_legacy:false,public_current:false,
  }]);
  const assertionLedgerPolicy=await app.query(`SELECT relrowsecurity,relforcerowsecurity,
      has_table_privilege(current_user,'zammad_service_assertion_jtis','SELECT') AS can_select,
      has_table_privilege(current_user,'zammad_service_assertion_jtis','INSERT') AS can_insert,
      has_table_privilege(current_user,'zammad_service_assertion_jtis','DELETE') AS can_delete,
      has_table_privilege(current_user,'zammad_service_assertion_jtis','UPDATE') AS can_update,
      has_table_privilege(current_user,'zammad_service_assertion_jtis','TRUNCATE') AS can_truncate
    FROM pg_class WHERE oid='zammad_service_assertion_jtis'::regclass`);
  assert.deepEqual(assertionLedgerPolicy.rows,[{
    relrowsecurity:true,relforcerowsecurity:true,can_select:true,can_insert:true,can_delete:true,can_update:false,can_truncate:false,
  }]);
  const assertionJti="99000000-0000-4000-8000-000000000009";
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "DELETE FROM zammad_service_assertion_jtis WHERE jti=$1",[assertionJti],
  ));
  await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "DELETE FROM zammad_service_assertion_jtis WHERE jti=$1",[assertionJti],
  ));
  const insertAssertion=(tenantId,instanceId)=>tenant(tenantId,()=>app.query(`INSERT INTO zammad_service_assertion_jtis
      (tenant_id,zammad_instance_id,jti,expires_at) VALUES ($1,$2,$3,now()+interval '2 minutes')
      ON CONFLICT (tenant_id,jti) DO NOTHING RETURNING jti`,[tenantId,instanceId,assertionJti]));
  assert.equal((await insertAssertion("10000000-0000-4000-8000-000000000001","11000000-0000-4000-8000-000000000001")).rowCount,1);
  assert.equal((await insertAssertion("10000000-0000-4000-8000-000000000001","11000000-0000-4000-8000-000000000001")).rowCount,0);
  assert.equal((await insertAssertion("20000000-0000-4000-8000-000000000002","22000000-0000-4000-8000-000000000002")).rowCount,1);
  const assertionsA=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT tenant_id FROM zammad_service_assertion_jtis WHERE jti=$1",[assertionJti],
  ));
  const assertionsB=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT tenant_id FROM zammad_service_assertion_jtis WHERE jti=$1",[assertionJti],
  ));
  assert.deepEqual(assertionsA.rows,[{tenant_id:"10000000-0000-4000-8000-000000000001"}]);
  assert.deepEqual(assertionsB.rows,[{tenant_id:"20000000-0000-4000-8000-000000000002"}]);
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO zammad_service_assertion_jtis
      (tenant_id,zammad_instance_id,jti,expires_at) VALUES ($1,$2,$3,now()-interval '10 seconds')`,[
    "10000000-0000-4000-8000-000000000001","11000000-0000-4000-8000-000000000001","99000000-0000-4000-8000-000000000010",
  ])),error=>error.code==="23514");
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE zammad_service_assertion_jtis SET expires_at=expires_at+interval '1 second' WHERE jti=$1",[assertionJti],
  )),error=>error.code==="42501");
  await assert.rejects(()=>app.query("TRUNCATE zammad_service_assertion_jtis"),error=>error.code==="42501");
  assert.equal((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "DELETE FROM zammad_service_assertion_jtis WHERE jti=$1",[assertionJti],
  ))).rowCount,1);
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "DELETE FROM zammad_service_assertion_jtis WHERE jti=$1",[assertionJti],
  ))).rowCount,1);
  const projectedRoutingIntegrationsA=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.list_client_routing_integrations()",
  ));
  assert.equal(projectedRoutingIntegrationsA.rows.filter(row=>row.state==="CONNECTED").length,3);
  assert.equal(projectedRoutingIntegrationsA.rows.filter(row=>row.state==="CONNECTING").length,1);
  assert.deepEqual(projectedRoutingIntegrationsA.rows.filter(row=>row.state==="REVOKED").map(row=>row.id),[
    "87000000-0000-4000-8000-000000000001",
  ]);
  assert.ok(projectedRoutingIntegrationsA.rows.every(row=>!Object.hasOwn(row,"external_account_id")));
  const projectedRoutingIntegrationsB=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT id,state FROM app.list_client_routing_integrations()",
  ));
  assert.deepEqual(projectedRoutingIntegrationsB.rows,[{
    id:"97000000-0000-4000-8000-000000000001",state:"REVOKED",
  }]);
  const durableExpiredBeforeReconnect=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT state,revision FROM client_routing_integrations WHERE id='87000000-0000-4000-8000-000000000001'",
  ));
  assert.deepEqual(durableExpiredBeforeReconnect.rows,[{state:"CONNECTING",revision:"1"}]);
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "SELECT * FROM app.begin_client_routing_notion_oauth($1,$2,$3)",
      ["20200000-0000-4000-8000-000000000002","5".repeat(64),"https://app.example.invalid/oauth/notion/callback"],
    )),
    error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "SELECT * FROM app.begin_client_routing_notion_oauth($1,$2,$3)",
      ["10100000-0000-4000-8000-000000000001","2".repeat(64),"https://app.example.invalid/oauth/notion/callback"],
    )),
    error=>error.code==="23505",
  );
  const rolledBackRoutingExpiry=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
      (SELECT state||':'||revision::text FROM client_routing_integrations WHERE id='87000000-0000-4000-8000-000000000001') AS durable,
      (SELECT count(*)::integer FROM audit_events WHERE action='client_routing.integration_expired') AS audits`));
  assert.deepEqual(rolledBackRoutingExpiry.rows,[{durable:"CONNECTING:1",audits:0}]);
  const reconnectedRouting=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.begin_client_routing_notion_oauth($1,$2,$3)",
    ["10100000-0000-4000-8000-000000000001","4".repeat(64),"https://app.example.invalid/oauth/notion/callback"],
  ))).rows[0];
  assert.match(reconnectedRouting.integration_id,/^[0-9a-f-]{36}$/u);
  assert.equal(reconnectedRouting.secret_reference,`secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/${reconnectedRouting.integration_id}`);
  const retiredRoutingExpiry=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
      (SELECT state||':'||revision::text FROM client_routing_integrations WHERE id='87000000-0000-4000-8000-000000000001') AS expired,
      (SELECT state||':'||revision::text FROM client_routing_integrations WHERE id='87000000-0000-4000-8000-000000000002') AS active,
      (SELECT count(*)::integer FROM client_routing_integrations WHERE state='CONNECTED') AS connected,
      (SELECT count(*)::integer FROM audit_events WHERE action='client_routing.integration_expired'
        AND target_id='87000000-0000-4000-8000-000000000001') AS audits`));
  assert.deepEqual(retiredRoutingExpiry.rows,[{expired:"REVOKED:2",active:"CONNECTING:1",connected:3,audits:1}]);
  const resumedRouting=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.begin_client_routing_notion_oauth($1,$2,$3,$4)",[
      "10100000-0000-4000-8000-000000000001","8".repeat(64),"https://app.example.invalid/oauth/notion/callback","87000000-0000-4000-8000-000000000002",
    ],
  ))).rows[0];
  assert.equal(resumedRouting.integration_id,"87000000-0000-4000-8000-000000000002");
  const tenantBExpiryIsolation=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT state,revision FROM client_routing_integrations WHERE id='97000000-0000-4000-8000-000000000001'",
  ));
  assert.deepEqual(tenantBExpiryIsolation.rows,[{state:"CONNECTING",revision:"1"}]);
  const routingClaimA=new Client({connectionString:appUrl});const routingClaimB=new Client({connectionString:appUrl});
  await Promise.all([routingClaimA.connect(),routingClaimB.connect()]);
  try{
    await routingClaimA.query("BEGIN");await routingClaimA.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    const firstClaim=(await routingClaimA.query("SELECT * FROM app.begin_client_routing_credential($1,$2,$3,$4,NULL,NULL,$5,$6)",[
      "10100000-0000-4000-8000-000000000001","ZOHO","Concurrent CRM","BEARER","6".repeat(64),"7".repeat(64),
    ])).rows[0];
    await routingClaimB.query("BEGIN");await routingClaimB.query("SET LOCAL statement_timeout='2s'");await routingClaimB.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    const replayPromise=routingClaimB.query("SELECT * FROM app.begin_client_routing_credential($1,$2,$3,$4,NULL,NULL,$5,$6)",[
      "10100000-0000-4000-8000-000000000001","ZOHO","Concurrent CRM","BEARER","6".repeat(64),"7".repeat(64),
    ]);
    await new Promise(resolve=>setTimeout(resolve,25));
    await routingClaimA.query("COMMIT");
    const replayClaim=(await replayPromise).rows[0];await routingClaimB.query("COMMIT");
    assert.equal(firstClaim.duplicate,false);assert.equal(replayClaim.duplicate,true);
    assert.equal(replayClaim.integration_id,firstClaim.integration_id);assert.equal(replayClaim.secret_reference,firstClaim.secret_reference);assert.equal(replayClaim.state,"CONNECTING");
    assert.equal((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "SELECT app.abort_client_routing_credential($1,$2) AS aborted",[firstClaim.integration_id,"10100000-0000-4000-8000-000000000001"],
    ))).rows[0].aborted,true);
  }finally{await routingClaimA.query("ROLLBACK").catch(()=>undefined);await routingClaimB.query("ROLLBACK").catch(()=>undefined);await Promise.all([routingClaimA.end(),routingClaimB.end()])}
  assert.equal((await app.query("SELECT has_function_privilege('wasalx_scheduler_reader','app.meta_account_successor_activation(uuid)','EXECUTE') allowed")).rows[0].allowed,false,
    "Automatic WAHA group work does not acquire Meta successor activation authority");
  // A privileged scheduler's fixed cross-tenant producer is not authority for
  // ordinary callers to insert work without their tenant context.
  for(const caller of [app,connectorWorker]){
    assert.equal((await caller.query("SELECT has_table_privilege(current_user,'public.connection_operations','INSERT') allowed")).rows[0].allowed,caller===app,"Worker deliberately lacks operation INSERT; only app reaches the tenant trigger");
    await caller.query('BEGIN');
    try{
      await caller.query("SELECT set_config('app.tenant_id','',true)");
      await assert.rejects(caller.query("INSERT INTO public.connection_operations(tenant_id,connection_id,operation_type,idempotency_key,requested_by_type,requested_by_id,request_id) VALUES($1,$2,'SYNC_GROUPS',$3,'SYSTEM','connector-scheduler',$3)",['10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',crypto.randomUUID()]),error=>error.code==='42501'&&(caller===app?error.message==='tenant context is required':error.message==='permission denied for table connection_operations'));
    }finally{await caller.query('ROLLBACK');}
  }
  const automaticGroupSync=await app.query("SELECT app.queue_due_group_syncs(200)::integer AS queued");
  assert.equal(automaticGroupSync.rows[0].queued,2);
  assert.equal((await app.query("SELECT app.queue_due_group_syncs(200)::integer AS queued")).rows[0].queued,0);
  for(const tenantId of ["10000000-0000-4000-8000-000000000001","20000000-0000-4000-8000-000000000002"]){
    const proof=await tenant(tenantId,()=>app.query(`SELECT operation_type,state,requested_by_type,requested_by_id,
      payload->>'automatic' AS automatic,payload->>'reason' AS reason
      FROM connection_operations WHERE tenant_id=$1 AND idempotency_key LIKE 'automatic-group-sync:%'`,[tenantId]));
    assert.deepEqual(proof.rows,[{operation_type:"SYNC_GROUPS",state:"QUEUED",requested_by_type:"SYSTEM",requested_by_id:"connector-scheduler",automatic:"true",reason:"PERIODIC_RECONCILIATION"}]);
    await tenant(tenantId,()=>app.query("UPDATE connection_operations SET state='CANCELLED',completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND idempotency_key LIKE 'automatic-group-sync:%'",[tenantId]));
  }
  const routingDefinition={schemaVersion:1,name:"Postgres client routing",fallback:{zammadGroupId:"2"},sources:[
    {id:"manual",name:"Manual",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}},
    {id:"crm",name:"CRM JSON",kind:"HTTP_JSON",syncMode:"HYBRID",secretReference:"secret://tenants/10000000-0000-4000-8000-000000000001/routing/integrations/87000000-0000-4000-8000-000000000006",endpointUrl:"https://crm.example.invalid/clients",scheduleMinutes:60,fieldMapping:{}},
  ],clients:[{id:"acme",name:"Acme",routeSourceId:"manual",zammadGroupId:"2",matchers:[{kind:"DOMAIN",sourceId:"manual",value:"acme.example"}]}]};
  const routingVersion=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.create_client_routing_version($1,$2)",[routingDefinition,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0];
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query("SELECT * FROM app.activate_client_routing_version($1,$2,NULL,$3)",[routingVersion.id,routingVersion.revision,"10100000-0000-4000-8000-000000000001"]);
    await app.query("SELECT app.reconcile_client_routing_sources($1,$2,$3)",[routingVersion.id,"10100000-0000-4000-8000-000000000001",{crm:"b".repeat(64)}]);
  });
  const initialRoutingSource=(await app.query("SELECT * FROM app.resolve_client_routing_webhook_route($1)",["b".repeat(64)])).rows[0];
  for(const reference of invalidRoutingSecretReferences)await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE client_routing_source_state SET state='RETIRED',secret_reference=$1 WHERE id=$2",[reference,initialRoutingSource.source_state_id],
    )),
    error=>error.code==="42501",
  );
  const routingSourceConstraintAdmin=new Client({connectionString:adminUrl});await routingSourceConstraintAdmin.connect();
  try{
    await routingSourceConstraintAdmin.query("BEGIN");
    for(const reference of invalidRoutingSecretReferences){
      await routingSourceConstraintAdmin.query("SAVEPOINT routing_source_secret_probe");
      await assert.rejects(
        routingSourceConstraintAdmin.query(
          "UPDATE client_routing_source_state SET state='RETIRED',secret_reference=$1 WHERE id=$2",[reference,initialRoutingSource.source_state_id],
        ),
        constraintFailure("23514","client_routing_source_state_secret_reference_check"),
      );
      await routingSourceConstraintAdmin.query("ROLLBACK TO SAVEPOINT routing_source_secret_probe");
    }
  }finally{
    await routingSourceConstraintAdmin.query("ROLLBACK").catch(()=>undefined);
    await routingSourceConstraintAdmin.end();
  }
  const concurrentRoutingJob=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.enqueue_client_routing_webhook_sync($1,$2)",[initialRoutingSource.source_state_id,"9".repeat(64)],
  ))).rows[0];
  assert.equal(concurrentRoutingJob.duplicate,false);
  const routingLease="54000000-0000-4000-8000-000000000001";
  const routingJobs=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.claim_client_routing_sync_jobs($1,2)",[routingLease],
  ))).rows;
  assert.equal(routingJobs.length,2);
  const [routingJob,supersededRoutingJob]=routingJobs;
  assert.equal(routingJob.source_id,"crm");
  const routingSnapshot=[{client_id:"beta",client_name:"Beta",zammad_group_id:"3",matcher_kind:"DOMAIN",matcher_value:"beta.example"}];
  const syncedDefinition={...routingDefinition,clients:[...routingDefinition.clients,{id:"beta",name:"Beta",routeSourceId:"crm",zammadGroupId:"3",matchers:[{kind:"DOMAIN",sourceId:"crm",value:"beta.example"}]}]};
  const syncedRouting=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.complete_client_routing_sync_job($1,$2,$3,$4,$5,NULL,$6)",
    [routingJob.job_id,routingLease,routingJob.fencing_token,{crm:0},JSON.stringify(routingSnapshot),syncedDefinition],
  ))).rows[0];
  const supersededRouting=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.complete_client_routing_sync_job($1,$2,$3,$4,$5,NULL,$6)",
    [supersededRoutingJob.job_id,routingLease,supersededRoutingJob.fencing_token,{crm:0},JSON.stringify(routingSnapshot),syncedDefinition],
  ))).rows[0];
  assert.deepEqual(supersededRouting,syncedRouting);
  const routingProof=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    (SELECT state FROM client_routing_versions WHERE id=$1) AS original_state,
    (SELECT activated_actor_type='USER' AND activated_sync_job_id IS NULL FROM client_routing_versions WHERE id=$1) AS manual_activation,
    (SELECT retired_at=(SELECT activated_at FROM client_routing_versions WHERE id=$2)
       FROM client_routing_versions WHERE id=$1) AS transition_clock_shared,
    (SELECT retired_sync_job_id IS NOT NULL AND retired_sync_job_id=(SELECT activated_sync_job_id FROM client_routing_versions WHERE id=$2)
       FROM client_routing_versions WHERE id=$1) AS transition_job_shared,
    (SELECT created_actor_type||':'||activated_actor_type FROM client_routing_versions WHERE id=$2) AS system_actors,
    (SELECT state FROM client_routing_sync_jobs WHERE id=$3) AS job_state,
    (SELECT state FROM client_routing_sync_jobs WHERE id=$4) AS superseded_job_state,
    (SELECT count(*)::integer FROM client_routing_sync_jobs WHERE trigger_kind='SCHEDULED' AND state='QUEUED') AS scheduled_jobs,
    (SELECT count(*)::integer FROM client_routing_versions) AS routing_version_count,
    (SELECT snapshot_revision FROM client_routing_source_state WHERE source_id='crm' AND state='ACTIVE') AS snapshot_revision,
    (SELECT state||':'||COALESCE(safe_error,'') FROM client_routing_source_state WHERE source_id='crm' AND state='ACTIVE') AS source_state,
    (SELECT count(*)::integer FROM audit_events WHERE action='client_routing.sync_superseded' AND target_id=$4::text AND actor_type='SYSTEM') AS superseded_audits,
    (SELECT route_source_id FROM client_routing_matchers WHERE routing_version_id=$2 AND client_id='beta' LIMIT 1) AS route_source`,
    [routingVersion.id,syncedRouting.routing_version_id,routingJob.job_id,supersededRoutingJob.job_id]));
  assert.deepEqual(routingProof.rows,[{original_state:"RETIRED",manual_activation:true,transition_clock_shared:true,transition_job_shared:true,system_actors:"SYSTEM:SYSTEM",job_state:"SUCCEEDED",superseded_job_state:"DISCARDED",scheduled_jobs:1,routing_version_count:2,snapshot_revision:"1",source_state:"ACTIVE:",superseded_audits:1,route_source:"crm"}]);
  const noOpRequest=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.request_client_routing_source_sync($1,$2,$3,$4)",
    ["crm",1,"10100000-0000-4000-8000-000000000001","e".repeat(64)],
  ))).rows[0];
  assert.equal(noOpRequest.duplicate,false);
  const noOpLease="55000000-0000-4000-8000-000000000001";
  const noOpJob=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.claim_client_routing_sync_jobs($1,1)",[noOpLease],
  ))).rows[0];
  assert.equal(noOpJob.job_id,noOpRequest.job_id);
  const noOpRouting=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.complete_client_routing_sync_job($1,$2,$3,$4,$5,NULL,$6)",
    [noOpJob.job_id,noOpLease,noOpJob.fencing_token,{crm:1},JSON.stringify(routingSnapshot),syncedDefinition],
  ))).rows[0];
  assert.deepEqual(noOpRouting,syncedRouting);
  const noOpProof=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    (SELECT count(*)::integer FROM client_routing_versions) AS routing_version_count,
    (SELECT snapshot_revision FROM client_routing_source_state WHERE source_id='crm' AND state='ACTIVE') AS snapshot_revision,
    (SELECT state||':'||result_routing_version_id::text FROM client_routing_sync_jobs WHERE id=$1) AS job_result,
    (SELECT new_value->>'changed' FROM audit_events WHERE action='client_routing.source_synced' AND request_id=$1::text) AS changed,
    (SELECT last_success_at IS NOT NULL FROM client_routing_source_state WHERE source_id='crm' AND state='ACTIVE') AS live`,[noOpJob.job_id]));
  assert.deepEqual(noOpProof.rows,[{routing_version_count:2,snapshot_revision:"1",job_result:`SUCCEEDED:${syncedRouting.routing_version_id}`,changed:"false",live:true}]);
  await timeScenario("routingReconnect",()=>verifyRoutingReconnect(app));
  const revokedBindingRequest=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.request_client_routing_source_sync($1,$2,$3,$4)",
    ["crm",1,"10100000-0000-4000-8000-000000000001","f".repeat(64)],
  ))).rows[0];
  const revokedBindingLease="56000000-0000-4000-8000-000000000001";
  const revokedBindingJob=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.claim_client_routing_sync_jobs($1,1)",[revokedBindingLease],
  ))).rows[0];
  assert.equal(revokedBindingJob.job_id,revokedBindingRequest.job_id);
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",async()=>{
    const replacement=(await app.query("SELECT * FROM app.begin_client_routing_credential($1,$2,$3,$4,$5,$6,$7,$8)",[
      "10100000-0000-4000-8000-000000000001","HTTP_JSON","CRM JSON replacement","BEARER",
      "87000000-0000-4000-8000-000000000006",1,"8".repeat(64),"9".repeat(64),
    ])).rows[0];
    await app.query("SELECT * FROM app.complete_client_routing_credential($1,$2)",[replacement.integration_id,"10100000-0000-4000-8000-000000000001"]);
    return app.query("SELECT * FROM app.complete_client_routing_sync_job($1,$2,$3,$4,$5,NULL,$6)",[
      revokedBindingJob.job_id,revokedBindingLease,revokedBindingJob.fencing_token,{crm:1},JSON.stringify(routingSnapshot),syncedDefinition,
    ]);
  }),error=>error.code==="42501");
  const revokedBindingProof=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    (SELECT state||':'||revision::text FROM client_routing_integrations WHERE id='87000000-0000-4000-8000-000000000006') AS binding,
    (SELECT state FROM client_routing_sync_jobs WHERE id=$1) AS job_state,
    (SELECT snapshot_revision FROM client_routing_source_state WHERE source_id='crm' AND state='ACTIVE') AS snapshot_revision`,[revokedBindingJob.job_id]));
  assert.deepEqual(revokedBindingProof.rows,[{binding:"CONNECTED:1",job_state:"RUNNING",snapshot_revision:"1"}]);
  const webhookBindingProof=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    source.state,source.kind,source.webhook_route_sha256,integration.state AS integration_state
    FROM client_routing_source_state source
    JOIN client_routing_integrations integration ON integration.tenant_id=source.tenant_id
      AND integration.secret_reference=source.secret_reference AND integration.provider=source.kind
    WHERE source.source_id='crm' AND source.state='ACTIVE'`));
  assert.deepEqual(webhookBindingProof.rows,[{state:"ACTIVE",kind:"HTTP_JSON",webhook_route_sha256:"b".repeat(64),integration_state:"CONNECTED"}]);
  assert.equal((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT app.fail_client_routing_sync_job($1,$2,$3,true,$4,NULL) AS completed",
    [revokedBindingJob.job_id,revokedBindingLease,revokedBindingJob.fencing_token,"Binding changed during completion test"],
  ))).rows[0].completed,true);
  const pinnedEvent=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
    (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES ($1,$2,'WAHA','routing-pin-proof','message.any','{}',$3,'PROCESSED')
    RETURNING id,governing_client_routing_version_id`,["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001","a".repeat(64)]))).rows[0];
  assert.equal(pinnedEvent.governing_client_routing_version_id,syncedRouting.routing_version_id);
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE event_inbox SET governing_client_routing_version_id=$1 WHERE id=$2",[routingVersion.id,pinnedEvent.id],
  )),error=>error.code==="55000");
  const replayPin=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
    (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,governing_client_routing_version_id)
    VALUES ($1,$2,'WAHA','routing-pin-replay','quarantine.reprocess','{}',$3,'PROCESSED',$4)
    RETURNING governing_client_routing_version_id`,["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001","d".repeat(64),routingVersion.id]))).rows[0];
  assert.equal(replayPin.governing_client_routing_version_id,routingVersion.id);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO zammad_email_routes
    (tenant_id,zammad_ticket_id,client_routing_version_id,client_route_status,client_id,client_route_matched_by,
     zammad_instance_id,source_article_id,request_sha256)
    VALUES ($1,'90001',$2,'MATCHED','beta','DOMAIN',$3,'70001',repeat('b',64))`,[
    "10000000-0000-4000-8000-000000000001",syncedRouting.routing_version_id,"11000000-0000-4000-8000-000000000001",
  ]));
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query("SELECT count(*)::int AS count FROM zammad_email_routes"))).rows[0].count,0);
  const nativeEmailRoute=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO zammad_email_routes
    (tenant_id,zammad_ticket_id,client_routing_version_id,client_route_status,client_id,client_route_matched_by,
     zammad_instance_id,source_article_id,request_sha256)
    VALUES (app.current_tenant_id(),'90002',$1,'MATCHED','beta','DOMAIN',$2,'70002',repeat('a',64))
    RETURNING id,zammad_instance_id`,[syncedRouting.routing_version_id,"11000000-0000-4000-8000-000000000001"])) ).rows[0];
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO zammad_email_route_applications
      (tenant_id,route_id,zammad_instance_id,idempotency_key,request_sha256,application_status,
       observed_group_id,request_id)
      VALUES (app.current_tenant_id(),$1,'22000000-0000-4000-8000-000000000002','native-email-wrong-instance',
        repeat('c',64),'APPLIED','7','native-email-wrong-instance')`,[nativeEmailRoute.id])),
    error=>error.code==="23503",
  );
  const nativeEmailDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const nativeEmailDatabase=new DatabaseService();
  const nativeEmailClaims={tenantId:"10000000-0000-4000-8000-000000000001",instanceId:nativeEmailRoute.zammad_instance_id,
    subject:nativeEmailRoute.zammad_instance_id,groupIds:[],groupAdmin:false};
  let nativeEmailAuthorizationChecks=0;
  const nativeEmailController=new ZammadInternalController(nativeEmailDatabase,{verify:async(authorization,scope)=>{
    assert.equal(authorization,"Bearer postgres-native-email");assert.equal(scope,"zammad:routing");
    nativeEmailAuthorizationChecks+=1;return nativeEmailClaims;
  }},{wake:async()=>{}});
  const nativeEmailAcknowledgement={tenant_id:nativeEmailClaims.tenantId,instance_id:nativeEmailClaims.instanceId,
    route_id:nativeEmailRoute.id,ticket_id:"90002",article_id:"70002",idempotency_key:"native-email-application-70002",
    application_status:"APPLIED",observed_group_id:"7",observed_owner_id:"8"};
  try{
    assert.deepEqual(await nativeEmailController.emailRoutingAcknowledgement("Bearer postgres-native-email",nativeEmailAcknowledgement,{headers:{"x-request-id":"native-email-application-70002"}}),{
      route_id:nativeEmailRoute.id,acknowledged:true,application_status:"APPLIED",observed_group_id:"7",observed_owner_id:"8",duplicate:false,
    });
    assert.equal((await nativeEmailController.emailRoutingAcknowledgement("Bearer postgres-native-email",nativeEmailAcknowledgement,{headers:{"x-request-id":"native-email-application-70002"}})).duplicate,true);
    await assert.rejects(
      ()=>nativeEmailController.emailRoutingAcknowledgement("Bearer postgres-native-email",{...nativeEmailAcknowledgement,application_status:"MANUAL_OVERRIDE"},{headers:{"x-request-id":"native-email-application-70002"}}),
      /conflicts with an existing receipt/u,
    );
    assert.equal(nativeEmailAuthorizationChecks,3);
  }finally{
    await nativeEmailDatabase.onModuleDestroy();
    if(nativeEmailDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=nativeEmailDatabaseUrl;
  }
  assert.deepEqual((await tenant(nativeEmailClaims.tenantId,()=>app.query(`SELECT
    (SELECT count(*)::integer FROM zammad_email_route_applications WHERE route_id=$1) AS applications,
    (SELECT count(*)::integer FROM audit_events WHERE action='zammad_email.route_applied' AND target_id=$1::text) AS audits`,[
      nativeEmailRoute.id,
    ]))).rows,[{applications:1,audits:1}]);
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT count(*)::integer AS count FROM zammad_email_route_applications",
  ))).rows[0].count,0);
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE zammad_email_route_applications SET application_status='MANUAL_OVERRIDE' WHERE route_id=$1",[nativeEmailRoute.id],
    )),
    error=>error.code==="42501",
  );
  const webhookRoute=(await app.query("SELECT * FROM app.resolve_client_routing_webhook_route($1)",["b".repeat(64)])).rows[0];
  assert.deepEqual({tenant_id:webhookRoute.tenant_id,source_id:webhookRoute.source_id,kind:webhookRoute.kind},{tenant_id:"10000000-0000-4000-8000-000000000001",source_id:"crm",kind:"HTTP_JSON"});
  const webhookFirst=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT * FROM app.enqueue_client_routing_webhook_sync($1,$2)",[webhookRoute.source_state_id,"c".repeat(64)]))).rows[0];
  const webhookReplay=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT * FROM app.enqueue_client_routing_webhook_sync($1,$2)",[webhookRoute.source_state_id,"c".repeat(64)]))).rows[0];
  assert.equal(webhookFirst.duplicate,false);assert.equal(webhookReplay.duplicate,true);assert.equal(webhookReplay.job_id,webhookFirst.job_id);
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT * FROM app.complete_client_routing_sync_job($1,$2,$3,$4,$5,NULL,$6)",
      [routingJob.job_id,routingLease,routingJob.fencing_token,{crm:0},JSON.stringify(routingSnapshot),syncedDefinition])),
    error=>error.code==="40001",
  );
  const runtimeRoles=await Promise.all([
    cleanup.query("SELECT pg_has_role(current_user,'wasalx_secret_cleanup_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    provisioning.query("SELECT pg_has_role(current_user,'wasalx_provisioning_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    support.query("SELECT pg_has_role(current_user,'wasalx_support_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    wahaRegistry.query("SELECT pg_has_role(current_user,'wasalx_waha_registry_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    wahaOperator.query("SELECT pg_has_role(current_user,'wasalx_waha_operator_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    wahaRolloutGate.query("SELECT pg_has_role(current_user,'wasalx_waha_rollout_gate_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    invitationMailer.query("SELECT pg_has_role(current_user,'wasalx_invitation_mailer','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    identityPolicy.query("SELECT pg_has_role(current_user,'wasalx_identity_policy_activator','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    meteringIngest.query("SELECT pg_has_role(current_user,'wasalx_metering_ingest_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
    platformOperations.query("SELECT pg_has_role(current_user,'wasalx_platform_operations_client','MEMBER') AS scoped,pg_has_role(current_user,'wasalx_app','MEMBER') AS app"),
  ]);
  assert.deepEqual(runtimeRoles.map(result=>result.rows[0]),Array.from({length:10},()=>({scoped:true,app:false})));
  const expiredSupportId="29300000-0000-4000-8000-000000000001";
  const boundaryAdmin=new Client({connectionString:adminUrl});await boundaryAdmin.connect();
  try{
    await boundaryAdmin.query(`INSERT INTO platform_support_access_requests
      (id,tenant_id,operator_subject,operator_email,operator_display_name,reason,requested_duration_seconds,
       state,approved_by,approved_at,access_expires_at)
      VALUES ($1,'10000000-0000-4000-8000-000000000001','postgres-support-operator',
        'support@example.invalid','Support operator','PostgreSQL expiry boundary proof',3600,'APPROVED',
        '10100000-0000-4000-8000-000000000001',now()-interval '2 hours',now()-interval '1 hour')`,[expiredSupportId]);
    for(const requestId of ["postgres-support-expiry-1","postgres-support-expiry-2"]){
      assert.deepEqual((await support.query(
        "SELECT app.operator_support_overview($1,$2,$3) AS overview",
        [expiredSupportId,"postgres-support-operator",requestId],
      )).rows,[{overview:{active:false}}]);
    }
    assert.deepEqual((await boundaryAdmin.query(`SELECT state,
      (SELECT count(*)::integer FROM audit_events WHERE tenant_id=request.tenant_id
        AND action='support_access.expired' AND target_id=request.id::text) AS expiry_audits
      FROM platform_support_access_requests request WHERE id=$1`,[expiredSupportId])).rows,[{state:"EXPIRED",expiry_audits:1}]);
  }finally{await boundaryAdmin.end()}
  await assert.rejects(
    ()=>app.query("SELECT app.operator_support_overview($1,$2,$3)",[expiredSupportId,"postgres-support-operator","postgres-support-forbidden"]),
    error=>error.code==="42501",
  );
  const provisioningProjection=(await provisioning.query(
    "SELECT app.operator_tenant_provisioning_status($1,$2,$3) AS status",
    ["10000000-0000-4000-8000-000000000001","postgres-provisioning-operator","postgres-provisioning-status"],
  )).rows[0].status;
  assert.deepEqual(Object.keys(provisioningProjection).sort(),[
    "action","attempts","available_at","completed_at","completed_steps","current_step","error_code",
    "max_attempts","operation_id","status","tenant_id","tenant_name","tenant_slug","tenant_state",
    "updated_at","zammad_instance_id",
  ]);
  await assert.rejects(
    ()=>support.query("SELECT app.operator_tenant_provisioning_status($1,$2,$3)",["10000000-0000-4000-8000-000000000001","postgres-support-operator","postgres-provisioning-forbidden"]),
    error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>provisioning.query("SELECT app.operator_support_overview($1,$2,$3)",[expiredSupportId,"postgres-support-operator","postgres-support-role-forbidden"]),
    error=>error.code==="42501",
  );
  const ruleLedgerPrivileges=await app.query(`SELECT
    has_table_privilege(current_user,'rule_set_operations','SELECT') AS can_select,
    has_table_privilege(current_user,'rule_set_operations','INSERT') AS can_insert,
    has_table_privilege(current_user,'rule_set_operations','UPDATE') AS can_update,
    has_table_privilege(current_user,'rule_set_operations','DELETE') AS can_delete`);
  assert.deepEqual(ruleLedgerPrivileges.rows,[{
    can_select:true,can_insert:true,can_update:false,can_delete:false,
  }]);
  const operationalMetrics=await app.query("SELECT metric,dimension,value FROM app.observability_runtime_metrics()");
  assert.equal(operationalMetrics.rowCount,23);
  assert.deepEqual([...new Set(operationalMetrics.rows.map(row=>row.metric))].sort(),["connection_state","queue_age_seconds","queue_depth"]);
  assert.ok(operationalMetrics.rows.every(row=>typeof row.dimension==="string"&&Number.isFinite(Number(row.value))));
  const resumePrivileges=await Promise.all([
    provisioning.query(`SELECT
      has_function_privilege(current_user,'app.operator_resume_tenant(uuid,text,text,text,text,text)','EXECUTE') AS request_resume,
      has_function_privilege(current_user,'app.authorize_tenant_resumption(uuid,uuid,bigint,jsonb)','EXECUTE') AS authorize_resume,
      has_function_privilege(current_user,'app.complete_tenant_resumption(uuid,uuid,bigint,jsonb)','EXECUTE') AS complete_resume`),
    app.query(`SELECT
      has_function_privilege(current_user,'app.operator_resume_tenant(uuid,text,text,text,text,text)','EXECUTE') AS request_resume,
      has_function_privilege(current_user,'app.authorize_tenant_resumption(uuid,uuid,bigint,jsonb)','EXECUTE') AS authorize_resume,
      has_function_privilege(current_user,'app.complete_tenant_resumption(uuid,uuid,bigint,jsonb)','EXECUTE') AS complete_resume`),
  ]);
  assert.deepEqual(resumePrivileges.map(result=>result.rows[0]),[
    {request_resume:true,authorize_resume:true,complete_resume:true},
    {request_resume:false,authorize_resume:false,complete_resume:false},
  ]);
  const createReplayPrivileges=await Promise.all([
    provisioning.query("SELECT has_function_privilege(current_user,'app.replay_tenant_create_request(text,text,text)','EXECUTE') AS allowed"),
    app.query("SELECT has_function_privilege(current_user,'app.replay_tenant_create_request(text,text,text)','EXECUTE') AS allowed"),
  ]);
  assert.deepEqual(createReplayPrivileges.map(result=>result.rows[0]),[{allowed:true},{allowed:false}]);

  const provisionedAgentBaseUrl="https://fresh-zammad.invalid";
  const reprovisionedServiceBaseUrl="https://fresh-zammad-2.invalid";
  const explicitAgentBaseUrl="https://agents.fresh-zammad.invalid";
  const freshProvisioning=(await provisioning.query(
    "SELECT app.operator_create_tenant($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) AS result",
    [
      "postgres-agent-origin-proof","5".repeat(64),"Agent origin proof","agent-origin-proof",90,
      JSON.stringify({deployment:{zammadVersion:"7.1.3",release:provisioningRelease}}),
      "oidc-agent-origin-owner","agent-origin-owner@example.invalid","Agent Origin Owner",
      "postgres-operator","postgres-agent-origin-proof",
    ],
  )).rows[0].result;
  assert.deepEqual((await provisioning.query(
    "SELECT app.replay_tenant_create_request($1,$2,$3) AS result",
    ["postgres-agent-origin-proof","5".repeat(64),"postgres-operator"],
  )).rows,[{result:{...freshProvisioning,duplicate:true}}]);
  assert.deepEqual((await provisioning.query(
    "SELECT app.replay_tenant_create_request($1,$2,$3) AS result",
    ["postgres-create-missing","5".repeat(64),"postgres-operator"],
  )).rows,[{result:null}]);
  for(const [requestHash,actor] of [["6".repeat(64),"postgres-operator"],["5".repeat(64),"another-operator"]]){
    await assert.rejects(
      ()=>provisioning.query(
        "SELECT app.replay_tenant_create_request($1,$2,$3)",
        ["postgres-agent-origin-proof",requestHash,actor],
      ),
      error=>error.code==="23505",
    );
  }
  const replayAdmin=new Client({connectionString:adminUrl});await replayAdmin.connect();
  try{
    await replayAdmin.query(`INSERT INTO provisioning_operator_requests
      (idempotency_key,request_sha256,action,actor_subject)
      VALUES ('postgres-create-incomplete',$1,'CREATE','postgres-operator')`,["7".repeat(64)]);
  }finally{await replayAdmin.end()}
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.replay_tenant_create_request('postgres-create-incomplete',$1,'postgres-operator')",
      ["7".repeat(64)],
    ),
    error=>error.code==="55000",
  );
  await assert.rejects(
    ()=>app.query(
      "SELECT app.replay_tenant_create_request($1,$2,$3)",
      ["postgres-agent-origin-proof","5".repeat(64),"postgres-operator"],
    ),
    error=>error.code==="42501",
  );
  const freshTenantId=freshProvisioning.tenant_id;
  const tenantPath=`tenants/${freshTenantId}/`;
  const provisioningSteps=[
    ["identity",{}],
    ["database",{database_reference:`postgresql://database.example.invalid/${freshTenantId}`}],
    ["search",{search_namespace:`wasalx_${freshTenantId.replaceAll("-","")}`}],
    ["storage",{storage_prefix:tenantPath}],
    ["secrets",{
      service_secret_reference:`secret://${tenantPath}zammad/service`,
      privacy_secret_reference:`secret://${tenantPath}zammad/privacy`,
    }],
    ["zammad",{
      zammad_base_url:provisionedAgentBaseUrl,
      runtime_image:provisioningRelease.images.zammad,
      package_version:provisioningRelease.packageVersion,
      package_sha256:provisioningRelease.packageSha256,
    }],
    ["package",completedProvisioningReleaseEvidence.package],
    ["oidc",{}],
    ["defaults",{}],
    ["health",{zammad_base_url:provisionedAgentBaseUrl,healthy:true,isolation_verified:true}],
  ];
  let freshInstanceId;
  for(const [index,[step,result]] of provisioningSteps.entries()){
    const lease=`45000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`;
    const claim=(await provisioning.query(
      "SELECT app.claim_tenant_provisioning_tasks($1,1) AS task",
      [lease],
    )).rows[0].task;
    assert.equal(claim.tenantId,freshTenantId);
    freshInstanceId=claim.zammadInstanceId;
    assert.deepEqual((await provisioning.query(
      "SELECT app.start_tenant_provisioning_step($1,$2,$3,$4) AS changed",
      [freshTenantId,lease,Number(claim.fencingToken),step],
    )).rows,[{changed:true}]);
    if(step==="zammad"){
      await assert.rejects(
        ()=>provisioning.query(
          "SELECT app.complete_tenant_provisioning_step($1,$2,$3,$4,$5::jsonb)",
          [freshTenantId,lease,Number(claim.fencingToken),step,JSON.stringify({...result,runtime_image:`registry.example.invalid/zammad@sha256:${"0".repeat(64)}`})],
        ),
        error=>error.code==="22023",
      );
    }
    if(step==="package"){
      await assert.rejects(
        ()=>provisioning.query(
          "SELECT app.complete_tenant_provisioning_step($1,$2,$3,$4,$5::jsonb)",
          [freshTenantId,lease,Number(claim.fencingToken),step,"{}"],
        ),
        error=>error.code==="22023",
      );
    }
    assert.deepEqual((await provisioning.query(
      "SELECT app.complete_tenant_provisioning_step($1,$2,$3,$4,$5::jsonb) AS changed",
      [freshTenantId,lease,Number(claim.fencingToken),step,JSON.stringify(result)],
    )).rows,[{changed:true}]);
  }
  assert.deepEqual((await tenant(freshTenantId,()=>app.query(
    `SELECT base_url,agent_base_url,state FROM zammad_instances
      WHERE tenant_id=$1 AND id=$2`,
    [freshTenantId,freshInstanceId],
  ))).rows,[{
    base_url:provisionedAgentBaseUrl,
    agent_base_url:provisionedAgentBaseUrl,
    state:"WORKING",
  }]);

  const reprovisionAdmin=new Client({connectionString:adminUrl});
  await reprovisionAdmin.connect();
  try{
    await reprovisionAdmin.query(
      "UPDATE zammad_instances SET agent_base_url=$2 WHERE tenant_id=$1",
      [freshTenantId,explicitAgentBaseUrl],
    );
    await reprovisionAdmin.query("UPDATE tenants SET state='PROVISIONING' WHERE id=$1",[freshTenantId]);
    await reprovisionAdmin.query(`UPDATE provisioning_operations
      SET action='PROVISION',status='PENDING',current_step=NULL,
          completed_steps=completed_steps-'health',
          step_results=jsonb_set(step_results,'{zammad,zammad_base_url}',to_jsonb($2::text),true),
          attempts=0,lease_id=NULL,lease_expires_at=NULL,completed_at=NULL,available_at=now()
      WHERE tenant_id=$1`,[freshTenantId,reprovisionedServiceBaseUrl]);
  }finally{await reprovisionAdmin.end()}
  const reprovisionLease="46000000-0000-4000-8000-000000000001";
  const reprovisionClaim=(await provisioning.query(
    "SELECT app.claim_tenant_provisioning_tasks($1,1) AS task",
    [reprovisionLease],
  )).rows[0].task;
  assert.equal(reprovisionClaim.tenantId,freshTenantId);
  assert.deepEqual((await provisioning.query(
    "SELECT app.start_tenant_provisioning_step($1,$2,$3,'health') AS changed",
    [freshTenantId,reprovisionLease,Number(reprovisionClaim.fencingToken)],
  )).rows,[{changed:true}]);
  assert.deepEqual((await provisioning.query(
    "SELECT app.complete_tenant_provisioning_step($1,$2,$3,'health',$4::jsonb) AS changed",
    [freshTenantId,reprovisionLease,Number(reprovisionClaim.fencingToken),JSON.stringify({
      zammad_base_url:reprovisionedServiceBaseUrl,healthy:true,isolation_verified:true,
    })],
  )).rows,[{changed:true}]);
  assert.deepEqual((await tenant(freshTenantId,()=>app.query(
    "SELECT base_url,agent_base_url,state FROM zammad_instances WHERE tenant_id=$1",
    [freshTenantId],
  ))).rows,[{
    base_url:reprovisionedServiceBaseUrl,
    agent_base_url:explicitAgentBaseUrl,
    state:"WORKING",
  }]);

  const resumeTenantId="10000000-0000-4000-8000-000000000001";
  const suspensionLease="41000000-0000-4000-8000-000000000001";
  const resumptionLease="42000000-0000-4000-8000-000000000001";
  const provisionOperationId=(await fixtureAdmin.query(
    "SELECT operation_id FROM provisioning_operations WHERE tenant_id=$1",
    [resumeTenantId],
  )).rows[0].operation_id;
  const suspensionRequest=await provisioning.query(
    "SELECT app.operator_suspend_tenant($1,$2,$3,$4,$5,$6) AS result",
    [resumeTenantId,"postgres-suspend-resume-proof","1".repeat(64),"postgres-operator","Resume lifecycle proof","postgres-suspend-resume-proof"],
  );
  assert.equal(suspensionRequest.rows[0].result.status,"SUSPEND_PENDING");
  assert.equal(suspensionRequest.rows[0].result.duplicate,false);
  const suspensionOperationId=suspensionRequest.rows[0].result.operation_id;
  assert.notEqual(suspensionOperationId,provisionOperationId);
  const suspensionReplay=await provisioning.query(
    "SELECT app.operator_suspend_tenant($1,$2,$3,$4,$5,$6) AS result",
    [resumeTenantId,"postgres-suspend-resume-proof","1".repeat(64),"postgres-operator","Resume lifecycle proof","postgres-suspend-resume-proof-replay"],
  );
  assert.equal(suspensionReplay.rows[0].result.duplicate,true);
  assert.equal(suspensionReplay.rows[0].result.operation_id,suspensionOperationId);
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.operator_suspend_tenant($1,$2,$3,$4,$5,$6)",
      [resumeTenantId,"postgres-suspend-resume-proof","2".repeat(64),"postgres-operator","Changed request","postgres-suspend-resume-conflict"],
    ),
    error=>error.code==="23505",
  );
  const suspensionClaim=await provisioning.query(
    "SELECT app.claim_tenant_provisioning_tasks($1,1) AS task",
    [suspensionLease],
  );
  assert.equal(suspensionClaim.rowCount,1);
  assert.equal(suspensionClaim.rows[0].task.action,"SUSPEND");
  assert.equal(suspensionClaim.rows[0].task.operationId,suspensionOperationId);
  assert.deepEqual((await fixtureAdmin.query(
    "SELECT lease_expires_at>now()+interval '150 seconds' AS has_margin FROM provisioning_operations WHERE tenant_id=$1",
    [resumeTenantId],
  )).rows,[{has_margin:true}]);
  const suspensionFence=Number(suspensionClaim.rows[0].task.fencingToken);
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.complete_tenant_suspension($1,$2,$3,$4::jsonb)",
      [resumeTenantId,suspensionLease,suspensionFence,JSON.stringify({suspended:true,suspended_at:new Date().toISOString()})],
    ),
    error=>error.code==="22023",
  );
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.complete_tenant_suspension($1,$2,$3,$4::jsonb)",
      [resumeTenantId,suspensionLease,suspensionFence,JSON.stringify({
        suspended:true,credentials_disabled:true,workloads_scaled_to_zero:true,
        ingress_disabled:true,suspended_at:"2020-01-01T00:00:00.000Z",
      })],
    ),
    error=>error.code==="22023",
  );
  const suspensionComplete=await provisioning.query(
    "SELECT app.complete_tenant_suspension($1,$2,$3,$4::jsonb) AS changed",
    [resumeTenantId,suspensionLease,suspensionFence,JSON.stringify({
      suspended:true,credentials_disabled:true,workloads_scaled_to_zero:true,
      ingress_disabled:true,suspended_at:new Date().toISOString(),
    })],
  );
  assert.deepEqual(suspensionComplete.rows,[{changed:true}]);
  const suspendedState=await tenant(resumeTenantId,()=>app.query(
    "SELECT t.state AS tenant_state,z.state AS zammad_state FROM tenants t JOIN zammad_instances z ON z.tenant_id=t.id WHERE t.id=$1",
    [resumeTenantId],
  ));
  assert.deepEqual(suspendedState.rows,[{tenant_state:"SUSPENDED",zammad_state:"SUSPENDED"}]);

  const resumeRequest=await provisioning.query(
    "SELECT app.operator_resume_tenant($1,$2,$3,$4,$5,$6) AS result",
    [resumeTenantId,"postgres-resume-proof","3".repeat(64),"postgres-operator","Fresh health and isolation checks passed","postgres-resume-proof"],
  );
  assert.equal(resumeRequest.rows[0].result.status,"RESUME_PENDING");
  assert.equal(resumeRequest.rows[0].result.duplicate,false);
  const resumeOperationId=resumeRequest.rows[0].result.operation_id;
  assert.notEqual(resumeOperationId,suspensionOperationId);
  const resumeReplay=await provisioning.query(
    "SELECT app.operator_resume_tenant($1,$2,$3,$4,$5,$6) AS result",
    [resumeTenantId,"postgres-resume-proof","3".repeat(64),"postgres-operator","Fresh health and isolation checks passed","postgres-resume-proof-replay"],
  );
  assert.equal(resumeReplay.rows[0].result.duplicate,true);
  assert.equal(resumeReplay.rows[0].result.operation_id,resumeOperationId);
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.operator_resume_tenant($1,$2,$3,$4,$5,$6)",
      [resumeTenantId,"postgres-resume-proof","4".repeat(64),"postgres-operator","Changed resume request","postgres-resume-conflict"],
    ),
    error=>error.code==="23505",
  );
  const resumeClaim=await provisioning.query(
    "SELECT app.claim_tenant_provisioning_tasks($1,1) AS task",
    [resumptionLease],
  );
  assert.equal(resumeClaim.rowCount,1);
  assert.equal(resumeClaim.rows[0].task.action,"RESUME");
  assert.equal(resumeClaim.rows[0].task.status,"RESUMING");
  assert.equal(resumeClaim.rows[0].task.currentStep,"resume_prepare");
  const resumeFence=Number(resumeClaim.rows[0].task.fencingToken);
  const freshPrepareEvidence={
    prepared:true,credentials_enabled:true,workloads_ready:true,
    healthy:true,isolation_verified:true,zammad_base_url:"https://a.invalid",
    provider_resumed_at:new Date().toISOString(),checked_at:new Date().toISOString(),
  };
  const staleResumePrepare=await provisioning.query(
    "SELECT app.authorize_tenant_resumption($1,$2,$3,$4::jsonb) AS changed",
    [resumeTenantId,"43000000-0000-4000-8000-000000000001",resumeFence,JSON.stringify(freshPrepareEvidence)],
  );
  assert.deepEqual(staleResumePrepare.rows,[{changed:false}]);
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.authorize_tenant_resumption($1,$2,$3,$4::jsonb)",
      [resumeTenantId,resumptionLease,resumeFence,JSON.stringify({
        ...freshPrepareEvidence,checked_at:"2020-01-01T00:00:00.000Z",
      })],
    ),
    error=>error.code==="22023",
  );
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.authorize_tenant_resumption($1,$2,$3,$4::jsonb)",
      [resumeTenantId,resumptionLease,resumeFence,JSON.stringify({
        ...freshPrepareEvidence,ingress_enabled:true,
      })],
    ),
    error=>error.code==="22023",
  );
  await assert.rejects(
    ()=>provisioning.query(
      "SELECT app.authorize_tenant_resumption($1,$2,$3,$4::jsonb)",
      [resumeTenantId,resumptionLease,resumeFence,JSON.stringify({
        ...freshPrepareEvidence,healthy:"true",
      })],
    ),
    error=>error.code==="22023",
  );
  const resumeAuthorized=await provisioning.query(
    "SELECT app.authorize_tenant_resumption($1,$2,$3,$4::jsonb) AS changed",
    [resumeTenantId,resumptionLease,resumeFence,JSON.stringify(freshPrepareEvidence)],
  );
  assert.deepEqual(resumeAuthorized.rows,[{changed:true}]);
  const authorizedState=await tenant(resumeTenantId,()=>app.query(
    "SELECT t.state AS tenant_state,z.state AS zammad_state,p.status,p.current_step FROM tenants t JOIN zammad_instances z ON z.tenant_id=t.id JOIN provisioning_operations p ON p.tenant_id=t.id WHERE t.id=$1",
    [resumeTenantId],
  ));
  assert.deepEqual(authorizedState.rows,[{
    tenant_state:"ACTIVE",zammad_state:"WORKING",status:"RESUME_PENDING",current_step:"resume_publish",
  }]);
  const publicationLease="44000000-0000-4000-8000-000000000001";
  const publicationClaim=await provisioning.query(
    "SELECT app.claim_tenant_provisioning_tasks($1,1) AS task",
    [publicationLease],
  );
  assert.equal(publicationClaim.rowCount,1);
  assert.equal(publicationClaim.rows[0].task.currentStep,"resume_publish");
  assert.equal(publicationClaim.rows[0].task.status,"RESUMING");
  const publicationFence=Number(publicationClaim.rows[0].task.fencingToken);
  assert.equal(publicationFence,resumeFence+1);
  const freshPublishEvidence={
    resumed:true,ingress_enabled:true,healthy:true,isolation_verified:true,
    zammad_base_url:"https://a.invalid",resumed_at:new Date().toISOString(),checked_at:new Date().toISOString(),
  };
  const resumeComplete=await provisioning.query(
    "SELECT app.complete_tenant_resumption($1,$2,$3,$4::jsonb) AS changed",
    [resumeTenantId,publicationLease,publicationFence,JSON.stringify(freshPublishEvidence)],
  );
  assert.deepEqual(resumeComplete.rows,[{changed:true}]);
  const resumedState=await tenant(resumeTenantId,()=>app.query(
    `SELECT t.state AS tenant_state,z.state AS zammad_state,p.action,p.status,
      (SELECT array_agg(a.action ORDER BY a.action) FROM audit_events a
       WHERE a.tenant_id=t.id AND a.action IN ('tenant.resumption_requested','tenant.resumption_authorized','tenant.resumption_completed')) AS resume_audit
      FROM tenants t JOIN zammad_instances z ON z.tenant_id=t.id
      JOIN provisioning_operations p ON p.tenant_id=t.id WHERE t.id=$1`,
    [resumeTenantId],
  ));
  assert.deepEqual(resumedState.rows,[{
    tenant_state:"ACTIVE",zammad_state:"WORKING",action:"RESUME",status:"COMPLETE",
    resume_audit:["tenant.resumption_authorized","tenant.resumption_completed","tenant.resumption_requested"],
  }]);
  const wahaPrivileges=await Promise.all([
    wahaRegistry.query(`SELECT
      has_function_privilege(current_user,'app.report_waha_worker_heartbeat(text,text,text,text,integer,text,integer,integer,boolean,timestamptz,text)','EXECUTE') AS heartbeat,
      has_function_privilege(current_user,'app.set_waha_worker_mode(text,bigint,text,text,integer,text,text)','EXECUTE') AS mode`),
    wahaOperator.query(`SELECT
      has_function_privilege(current_user,'app.report_waha_worker_heartbeat(text,text,text,text,integer,text,integer,integer,boolean,timestamptz,text)','EXECUTE') AS heartbeat,
      has_function_privilege(current_user,'app.set_waha_worker_mode(text,bigint,text,text,integer,text,text)','EXECUTE') AS mode`),
    wahaRolloutGate.query(`SELECT
      has_function_privilege(current_user,'app.assert_waha_worker_registry_transition(jsonb)','EXECUTE') AS gate,
      has_function_privilege(current_user,'app.report_waha_worker_heartbeat(text,text,text,text,integer,text,integer,integer,boolean,timestamptz,text)','EXECUTE') AS heartbeat,
      has_function_privilege(current_user,'app.set_waha_worker_mode(text,bigint,text,text,integer,text,text)','EXECUTE') AS mode`),
  ]);
  assert.deepEqual(wahaPrivileges.slice(0,2).map(result=>result.rows[0]),[
    {heartbeat:true,mode:false},
    {heartbeat:false,mode:true},
  ]);
  assert.deepEqual(wahaPrivileges[2].rows,[{gate:true,heartbeat:false,mode:false}]);
  await assert.rejects(()=>wahaRolloutGate.query("SELECT count(*) FROM waha_workers"),error=>error.code==="42501");
  await assert.rejects(()=>wahaRolloutGate.query("SELECT count(*) FROM app.waha_registry_rollout_guard"),error=>error.code==="42501");
  const isolatedRuntimePrivileges=await Promise.all([
    invitationMailer.query(`SELECT
      has_function_privilege(current_user,'app.claim_invitation_email_jobs(uuid,integer)','EXECUTE')
        AND has_function_privilege(current_user,'app.pending_invitation_email_tenants(integer)','EXECUTE') AS intended,
      has_function_privilege(current_user,'app.activate_tenant_identity_policy(uuid,bigint,text)','EXECUTE') AS forbidden`),
    identityPolicy.query(`SELECT
      has_function_privilege(current_user,'app.requested_tenant_identity_policy(uuid,bigint)','EXECUTE')
        AND has_function_privilege(current_user,'app.activate_tenant_identity_policy(uuid,bigint,text)','EXECUTE') AS intended,
      has_function_privilege(current_user,'app.claim_invitation_email_jobs(uuid,integer)','EXECUTE') AS forbidden`),
    meteringIngest.query(`SELECT
      has_function_privilege(current_user,'app.ingest_usage_meter_event(uuid,text,text,text,text,numeric,timestamptz,timestamptz,text)','EXECUTE')
        AND has_function_privilege(current_user,'app.capture_next_usage_metering_period()','EXECUTE') AS intended,
      has_function_privilege(current_user,'app.operator_platform_operations_overview(text,text)','EXECUTE') AS forbidden`),
    platformOperations.query(`SELECT
      has_function_privilege(current_user,'app.operator_platform_operations_overview(text,text)','EXECUTE') AS intended,
      has_function_privilege(current_user,'app.ingest_usage_meter_event(uuid,text,text,text,text,numeric,timestamptz,timestamptz,text)','EXECUTE') AS forbidden`),
  ]);
  assert.deepEqual(isolatedRuntimePrivileges.map(result=>result.rows[0]),Array.from({length:4},()=>({intended:true,forbidden:false})));
  assert.deepEqual((await invitationMailer.query(`SELECT
    has_function_privilege(current_user,'app.lock_current_active_tenant_for_event_admission()','EXECUTE') AS admission,
    has_any_column_privilege(current_user,'public.tenants','SELECT') AS tenant_read,
    has_any_column_privilege(current_user,'public.tenants','UPDATE') AS tenant_write`)).rows,
  [{admission:true,tenant_read:false,tenant_write:false}]);
  await fixtureAdmin.query(`
    INSERT INTO tenant_invitations
      (id,tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256)
    VALUES
      ('15100000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','invitee@b.invalid','Invitee B','agent',repeat('c',64),now()+interval '1 day','20200000-0000-4000-8000-000000000002','postgres-invitation-b',repeat('b',64));
    INSERT INTO tenant_invitation_email_outbox
      (id,tenant_id,invitation_id,action,recipient_email,token_ciphertext,token_key_version,idempotency_key,request_sha256)
    VALUES
      ('15200000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','15100000-0000-4000-8000-000000000002','INVITE','invitee@b.invalid',decode(repeat('cd',128),'hex'),'local-v1','postgres-invitation-email-b',repeat('a',64));
    INSERT INTO tenant_invitation_email_outbox
      (id,tenant_id,invitation_id,action,recipient_email,token_ciphertext,token_key_version,idempotency_key,request_sha256,state,attempts,lease_id,lease_expires_at,fencing_token)
    VALUES
      ('15200000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','15100000-0000-4000-8000-000000000002','RESEND','invitee@b.invalid',decode(repeat('ef',128),'hex'),'local-v1','postgres-invitation-email-abandoned',repeat('d',64),'SENDING',1,'41000000-0000-4000-8000-000000000003',now()-interval '1 minute',1);
    UPDATE tenants SET state='SUSPENDED' WHERE id='10000000-0000-4000-8000-000000000001';
  `);
  await assert.rejects(() => fixtureAdmin.query(`INSERT INTO tenant_invitations
    (id,tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256)
    VALUES ('15100000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002','fixture-0011@example.test,invalid','Invalid','agent',repeat('1',64),now()+interval '1 day','20200000-0000-4000-8000-000000000002','postgres-invalid-invitation',repeat('2',64))`), error => error.code === "23514");
  await assert.rejects(() => fixtureAdmin.query(`INSERT INTO tenant_invitation_email_outbox
    (id,tenant_id,invitation_id,action,recipient_email,token_ciphertext,token_key_version,idempotency_key,request_sha256)
    VALUES ('15200000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002','15100000-0000-4000-8000-000000000002','RESEND','fixture-0011@example.test,invalid',decode(repeat('aa',128),'hex'),'local-v1','postgres-invalid-recipient',repeat('3',64))`), error => error.code === "23514");
  const activeInvitationTenants=await invitationMailer.query("SELECT app.pending_invitation_email_tenants(10) AS tenant_id");
  assert.deepEqual(activeInvitationTenants.rows,[{tenant_id:"20000000-0000-4000-8000-000000000002"}]);
  await invitationMailer.query("BEGIN");
  try{
    await invitationMailer.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    assert.deepEqual((await invitationMailer.query("SELECT id FROM app.claim_invitation_email_jobs('41000000-0000-4000-8000-000000000001',10)")).rows,[]);
    await invitationMailer.query("COMMIT");
  }catch(error){await invitationMailer.query("ROLLBACK");throw error}
  await invitationMailer.query("BEGIN");
  try{
    await invitationMailer.query("SELECT set_config('app.tenant_id',$1,true)",["20000000-0000-4000-8000-000000000002"]);
    const activeClaim=await invitationMailer.query("SELECT id,state FROM app.claim_invitation_email_jobs('41000000-0000-4000-8000-000000000002',10)");
    assert.deepEqual(activeClaim.rows,[{id:"15200000-0000-4000-8000-000000000002",state:"SENDING"}]);
    const abandonedInvitation=await invitationMailer.query("SELECT state,error_code,lease_id,lease_expires_at FROM tenant_invitation_email_outbox WHERE id='15200000-0000-4000-8000-000000000003'");
    assert.deepEqual(abandonedInvitation.rows,[{state:"FAILED_TERMINAL",error_code:"EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN",lease_id:null,lease_expires_at:null}]);
    assert.deepEqual((await invitationMailer.query("SELECT id FROM app.claim_invitation_email_jobs('41000000-0000-4000-8000-000000000002',10)")).rows,[]);
    assert.equal((await invitationMailer.query("SELECT app.complete_invitation_email_job('15200000-0000-4000-8000-000000000002','41000000-0000-4000-8000-000000000002',1,'provider-receipt-postgres-b') AS completed")).rows[0].completed,true);
    await invitationMailer.query("COMMIT");
  }catch(error){await invitationMailer.query("ROLLBACK");throw error}
  await fixtureAdmin.query("UPDATE tenants SET state='ACTIVE' WHERE id='10000000-0000-4000-8000-000000000001'");
  const pendingInvitationTenants=await invitationMailer.query("SELECT app.pending_invitation_email_tenants(10) AS tenant_id");
  assert.deepEqual(pendingInvitationTenants.rows,[{tenant_id:"10000000-0000-4000-8000-000000000001"}]);
  await invitationMailer.query("BEGIN");
  try{
    await invitationMailer.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    const claimedInvitation=await invitationMailer.query("SELECT id,tenant_id,attempts,fencing_token,state FROM app.claim_invitation_email_jobs('41000000-0000-4000-8000-000000000001',10)");
    assert.deepEqual(claimedInvitation.rows,[{id:"15200000-0000-4000-8000-000000000001",tenant_id:"10000000-0000-4000-8000-000000000001",attempts:1,fencing_token:"1",state:"SENDING"}]);
    const completedInvitation=await invitationMailer.query("SELECT app.complete_invitation_email_job('15200000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001',1,'provider-receipt-postgres-a') AS completed");
    assert.equal(completedInvitation.rows[0].completed,true);
    const replayedInvitation=await invitationMailer.query("SELECT app.complete_invitation_email_job('15200000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001',1,'provider-receipt-postgres-a') AS completed");
    assert.equal(replayedInvitation.rows[0].completed,false);
    await invitationMailer.query("COMMIT");
  }catch(error){await invitationMailer.query("ROLLBACK");throw error}
  const drainedInvitationTenants=await invitationMailer.query("SELECT app.pending_invitation_email_tenants(10) AS tenant_id");
  assert.deepEqual(drainedInvitationTenants.rows,[]);
  await assert.rejects(()=>meteringIngest.query("SELECT count(*) FROM usage_meter_events"),error=>error.code==="42501");
  await assert.rejects(()=>platformOperations.query("SELECT count(*) FROM platform_operations_audit_events"),error=>error.code==="42501");
  for (const [timeZone, utcInstant, expectedCost] of [
    ["America/Los_Angeles", "2090-09-01 00:15:00+00", "11"],
    ["Asia/Riyadh", "2090-08-31 22:00:00+00", "7"],
  ]) {
    await fixtureAdmin.query("BEGIN");
    try {
      await fixtureAdmin.query(`
        SET LOCAL TIME ZONE '${timeZone}';
        DO $test$
        DECLARE
          fixed_clock constant text := 'TIMESTAMPTZ ''${utcInstant}''';
          definition text := pg_get_functiondef('app.operator_platform_operations_overview(text,text)'::regprocedure);
        BEGIN
          -- Freeze both spellings of the transaction clock in the installed function.
          EXECUTE replace(replace(definition, 'now()', fixed_clock),
            'current_date', '(' || fixed_clock || ')::date');
        END;
        $test$;
        INSERT INTO public.usage_daily_rollups
          (tenant_id, usage_day, meter_key, currency, estimated_cost_micros)
        SELECT '10000000-0000-4000-8000-000000000001', usage_day, 'INBOUND_MESSAGES', 'USD', cost
        FROM (VALUES (DATE '2090-08-31', 7), (DATE '2090-09-01', 11)) AS rollups(usage_day, cost)
        WHERE usage_day <= DATE '${utcInstant.slice(0, 10)}';
        SET LOCAL ROLE wasalx_platform_operations_client;
      `);
      const overview=await fixtureAdmin.query(
        "SELECT app.operator_platform_operations_overview('metering-test','overview-utc-month')->'month_cost_summary' AS month_cost_summary",
      );
      assert.deepEqual(overview.rows[0].month_cost_summary,[
        {currency:"USD",estimated_cost_micros:expectedCost,unpriced_quantity:"0.000000"},
      ],`The overview should use the UTC month in ${timeZone}`);
    } finally {
      await fixtureAdmin.query("ROLLBACK");
    }
  }
  const capturedMetering=await meteringIngest.query("SELECT app.capture_next_usage_metering_period() AS result");
  assert.equal(typeof capturedMetering.rows[0].result,"object");
  assert.equal(typeof capturedMetering.rows[0].result.caught_up,"boolean");
  const caughtUpMetering=await meteringIngest.query("SELECT app.capture_next_usage_metering_period() AS result");
  assert.equal(typeof caughtUpMetering.rows[0].result.caught_up,"boolean");
  assert.ok(new Date(caughtUpMetering.rows[0].result.next_period_start)>=new Date(capturedMetering.rows[0].result.next_period_start));
  const meterArguments=[
    "10000000-0000-4000-8000-000000000001","control-api","postgres-release-gate",
    "postgres-meter-event-1","INBOUND_MESSAGES","1","2026-08-09T20:00:00.000Z",
    "2026-08-09T20:01:00.000Z","connection-postgres-gate",
  ];
  const meterSql="SELECT app.ingest_usage_meter_event($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result";
  const firstMeter=await meteringIngest.query(meterSql,meterArguments);
  assert.equal(firstMeter.rows[0].result.duplicate,false);
  const replayedMeter=await meteringIngest.query(meterSql,meterArguments);
  assert.equal(replayedMeter.rows[0].result.duplicate,true);
  await assert.rejects(
    ()=>meteringIngest.query(meterSql,meterArguments.map((value,index)=>index===5?"2":value)),
    error=>error.code==="23505",
  );
  // Actor admission still permits the first active membership to name itself.
  await fixtureAdmin.query("BEGIN");
  try {
    await fixtureAdmin.query(`INSERT INTO users(id,oidc_subject,email,display_name)
      VALUES ('10100000-0000-4000-8000-000000000099','actor-bootstrap-proof','actor-bootstrap@example.invalid','Actor bootstrap proof')`);
    const bootstrapActor = await fixtureAdmin.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role,state,updated_by)
      VALUES ('10000000-0000-4000-8000-000000000001','10100000-0000-4000-8000-000000000099','agent','ACTIVE','10100000-0000-4000-8000-000000000099')
      RETURNING user_id=updated_by AS self_attributed`);
    assert.deepEqual(bootstrapActor.rows,[{self_attributed:true}]);
  } finally { await fixtureAdmin.query("ROLLBACK"); }
  const botDefinition={
    schemaVersion:1,name:"Postgres support",start:"hello",maxSteps:20,
    nodes:[
      {id:"hello",type:"send_text",text:"Hello",next:"lookup"},
      {id:"lookup",type:"action",actionId:"orders.lookup",input:{query:"{{message.text}}"},onSuccess:"answer",onFailure:"handoff"},
      {id:"answer",type:"send_text",text:"Status {{action.status}}",next:"done"},
      {id:"handoff",type:"handoff",target:"CLIENT_PRIMARY",priority:"2 normal"},
      {id:"done",type:"end"},
    ],
  };
  const postgresActionId="45000000-0000-4000-8000-000000000001";
  const postgresActionRevisionId="45100000-0000-4000-8000-000000000001";
  const postgresCredentialActionId="45000000-0000-4000-8000-000000000002";
  const postgresCredentialRevisionId="45100000-0000-4000-8000-000000000003";
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query(`INSERT INTO bot_action_definitions
      (id,tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,headers,response_mapping,
       active_revision_id,created_by,updated_by)
      VALUES ($1,app.current_tenant_id(),'orders.lookup','Order lookup','HTTP_JSON',
       'https://api.example.invalid/orders','GET','NONE','{}','{"action.status":"/status"}',$2,$3,$3)`,[
      postgresActionId,postgresActionRevisionId,"10100000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO bot_action_revisions
      (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
       headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
      VALUES ($1,app.current_tenant_id(),$2,1,'Order lookup','HTTP_JSON',
       'https://api.example.invalid/orders','GET','NONE','{}','{"action.status":"/status"}',5000,262144,
       'ACTIVE',repeat('a',64),$3)`,[
      postgresActionRevisionId,postgresActionId,"10100000-0000-4000-8000-000000000001",
    ]);
  });
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_action_revisions
      (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
       headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
      VALUES ('45100000-0000-4000-8000-000000000002',app.current_tenant_id(),$1,2,'Cross actor',
       'HTTP_JSON','https://api.example.invalid/orders','GET','NONE','{}','{}',5000,262144,'ACTIVE',repeat('b',64),
       '20200000-0000-4000-8000-000000000002')`,[postgresActionId])),
    error=>error.code==="23503",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE bot_action_revisions SET name='Mutated' WHERE id=$1",[postgresActionRevisionId],
    )),error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "DELETE FROM bot_action_revisions WHERE id=$1",[postgresActionRevisionId],
    )),error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_action_definitions
      (tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,secret_reference,active_revision_id,created_by,updated_by)
      VALUES (app.current_tenant_id(),'cross.tenant','Cross tenant','HTTP_JSON','https://api.example.invalid/action','POST','BEARER',
        'secret://tenants/20000000-0000-4000-8000-000000000002/bot-actions/api',
        '45100000-0000-4000-8000-000000000099',
        '10100000-0000-4000-8000-000000000001','10100000-0000-4000-8000-000000000001')`)),
    error=>error.code==="23514",
  );
  const expiredCredentialStage=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_action_credential_stages
    (id,tenant_id,action_key,idempotency_key,secret_reference,credential_sha256,created_by,created_at,expires_at)
    VALUES ('45300000-0000-4000-8000-000000000001',app.current_tenant_id(),'orders.lookup','expired-stage-proof',
      'secret://tenants/'||app.current_tenant_id()::text||'/bot-actions/orders.lookup/credentials/'||
        encode(digest(app.current_tenant_id()::text||':expired-stage-proof','sha256'),'hex'),
      repeat('c',64),
      '10100000-0000-4000-8000-000000000001',now()-interval '2 hours',now()-interval '1 hour')
    RETURNING id,secret_reference`))).rows[0];
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_action_credential_stages
      (id,tenant_id,action_key,idempotency_key,secret_reference,credential_sha256,created_by,expires_at)
      VALUES ('45300000-0000-4000-8000-000000000099',app.current_tenant_id(),'orders.lookup','future-stage-proof',
        'secret://tenants/'||app.current_tenant_id()::text||'/bot-actions/orders.lookup/credentials/'||
          encode(digest(app.current_tenant_id()::text||':future-stage-proof','sha256'),'hex'),
        repeat('f',64),'10100000-0000-4000-8000-000000000001',now()+interval '2 hours')`)),
    error=>error.code==="23514",
  );
  const boundCredentialStage=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_action_credential_stages
    (id,tenant_id,action_key,idempotency_key,secret_reference,credential_sha256,created_by)
    VALUES ('45300000-0000-4000-8000-000000000002',app.current_tenant_id(),'secure.lookup','bound-stage-proof',
      'secret://tenants/'||app.current_tenant_id()::text||'/bot-actions/secure.lookup/credentials/'||
        encode(digest(app.current_tenant_id()::text||':bound-stage-proof','sha256'),'hex'),
      repeat('d',64),
      '10100000-0000-4000-8000-000000000001') RETURNING id,secret_reference`))).rows[0];
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query(`INSERT INTO bot_action_definitions
      (id,tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,secret_reference,
       active_revision_id,created_by,updated_by)
      VALUES ($1,app.current_tenant_id(),'secure.lookup','Secure lookup','HTTP_JSON',
       'https://api.example.invalid/secure','GET','BEARER',$2,$3,$4,$4)`,[
      postgresCredentialActionId,boundCredentialStage.secret_reference,postgresCredentialRevisionId,
      "10100000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO bot_action_revisions
      (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
       secret_reference,headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
      VALUES ($1,app.current_tenant_id(),$2,1,'Secure lookup','HTTP_JSON',
       'https://api.example.invalid/secure','GET','BEARER',$3,'{}','{}',5000,262144,
       'ACTIVE',repeat('e',64),$4)`,[
      postgresCredentialRevisionId,postgresCredentialActionId,boundCredentialStage.secret_reference,
      "10100000-0000-4000-8000-000000000001",
    ]);
    await app.query(`UPDATE bot_action_credential_stages
      SET state='BOUND',bound_action_revision_id=$1,bound_at=now() WHERE id=$2`,[
      postgresCredentialRevisionId,boundCredentialStage.id,
    ]);
  });
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE bot_action_credential_stages SET credential_sha256=repeat('f',64) WHERE id=$1",[boundCredentialStage.id],
    )),error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`UPDATE bot_action_credential_stages
      SET state='STAGED',bound_action_revision_id=NULL,bound_at=NULL WHERE id=$1`,[boundCredentialStage.id])),
    error=>error.code==="55000",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`UPDATE bot_action_credential_stages
      SET state='BOUND',bound_action_revision_id=$1,bound_at=now() WHERE id=$2`,[
      postgresActionRevisionId,expiredCredentialStage.id,
    ])),error=>error.code==="23514",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE bot_action_credential_stages SET expires_at=now()+interval '2 hours' WHERE id=$1",
      [expiredCredentialStage.id],
    )),error=>error.code==="23514",
  );
  const expiredStageClaims=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,25)",[
    "45400000-0000-4000-8000-000000000001",
  ]);
  const expiredStageTask=expiredStageClaims.rows.find(row=>row.secret_reference===expiredCredentialStage.secret_reference);
  assert.ok(expiredStageTask);
  assert.equal(expiredStageClaims.rows.some(row=>row.secret_reference===boundCredentialStage.secret_reference),false);
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE bot_action_credential_stages SET expires_at=now()+interval '1 hour' WHERE id=$1",
      [expiredCredentialStage.id],
    )),error=>error.code==="23514",
  );
  assert.equal((await cleanup.query("SELECT app.complete_secret_cleanup_task($1,$2,$3) AS completed",[
    expiredStageTask.task_id,"45400000-0000-4000-8000-000000000001",expiredStageTask.fencing_token,
  ])).rows[0].completed,true);
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    const reusedCredentialRevisionId="45100000-0000-4000-8000-000000000005";
    await app.query(`INSERT INTO bot_action_revisions
      (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
       secret_reference,headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
      VALUES ($1,app.current_tenant_id(),$2,2,'Secure lookup','HTTP_JSON',
       'https://api.example.invalid/secure','GET','BEARER',$3,'{}','{}',5000,262144,
       'ACTIVE',repeat('6',64),$4)`,[
      reusedCredentialRevisionId,postgresCredentialActionId,boundCredentialStage.secret_reference,
      "10100000-0000-4000-8000-000000000001",
    ]);
    await app.query(`UPDATE bot_action_definitions
      SET revision=2,active_revision_id=$1,updated_by=$2,updated_at=now()
      WHERE tenant_id=app.current_tenant_id() AND id=$3`,[
      reusedCredentialRevisionId,"10100000-0000-4000-8000-000000000001",postgresCredentialActionId,
    ]);
  });
  const reusedCredentialProtection=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,25)",[
    "45400000-0000-4000-8000-000000000005",
  ]);
  assert.equal(reusedCredentialProtection.rows.some(row=>row.secret_reference===boundCredentialStage.secret_reference),false);
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query(`INSERT INTO bot_action_jobs
      (id,tenant_id,origin,action_definition_id,action_revision_id,action_node_id,request_input,
       on_success_node_id,on_failure_node_id,qualification_requested_by,qualification_idempotency_key,
       qualification_request_sha256,state,completed_at)
      VALUES
      ('45200000-0000-4000-8000-000000000001',app.current_tenant_id(),'QUALIFICATION',$1,$2,
       'qualification','{}','qualification','qualification',$3,'credential-cleanup-queued',repeat('1',64),'QUEUED',NULL),
      ('45200000-0000-4000-8000-000000000002',app.current_tenant_id(),'QUALIFICATION',$1,$2,
       'qualification','{}','qualification','qualification',$3,'credential-cleanup-unknown',repeat('2',64),'OUTCOME_UNKNOWN',now())`,[
      postgresCredentialActionId,postgresCredentialRevisionId,"10100000-0000-4000-8000-000000000001",
    ]);
    const replacementRevisionId="45100000-0000-4000-8000-000000000004";
    await app.query(`INSERT INTO bot_action_revisions
      (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
       headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
      VALUES ($1,app.current_tenant_id(),$2,3,'Secure lookup','HTTP_JSON',
       'https://api.example.invalid/secure','GET','NONE','{}','{}',5000,262144,
       'ACTIVE',repeat('3',64),$3)`,[
      replacementRevisionId,postgresCredentialActionId,"10100000-0000-4000-8000-000000000001",
    ]);
    await app.query(`UPDATE bot_action_definitions
      SET auth_scheme='NONE',secret_reference=NULL,revision=3,active_revision_id=$1,
          updated_by=$2,updated_at=now()
      WHERE tenant_id=app.current_tenant_id() AND id=$3`,[
      replacementRevisionId,"10100000-0000-4000-8000-000000000001",postgresCredentialActionId,
    ]);
  });
  const queuedCredentialProtection=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,25)",[
    "45400000-0000-4000-8000-000000000002",
  ]);
  assert.equal(queuedCredentialProtection.rows.some(row=>row.secret_reference===boundCredentialStage.secret_reference),false);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`UPDATE bot_action_jobs
    SET state='FAILED_TERMINAL',completed_at=now()
    WHERE id='45200000-0000-4000-8000-000000000001'`));
  const unknownCredentialProtection=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,25)",[
    "45400000-0000-4000-8000-000000000003",
  ]);
  assert.equal(unknownCredentialProtection.rows.some(row=>row.secret_reference===boundCredentialStage.secret_reference),false);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`UPDATE bot_action_jobs
    SET state='FAILED_TERMINAL' WHERE id='45200000-0000-4000-8000-000000000002'`));
  const retiredCredentialClaims=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,25)",[
    "45400000-0000-4000-8000-000000000004",
  ]);
  const retiredCredentialTask=retiredCredentialClaims.rows.find(row=>row.secret_reference===boundCredentialStage.secret_reference);
  assert.ok(retiredCredentialTask);
  assert.equal((await cleanup.query("SELECT app.complete_secret_cleanup_task($1,$2,$3) AS completed",[
    retiredCredentialTask.task_id,"45400000-0000-4000-8000-000000000004",retiredCredentialTask.fencing_token,
  ])).rows[0].completed,true);
  const botFamily=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT app.create_bot_flow_family($1,$2) AS id",
    [botDefinition.name,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0].id;
  const botV1=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)",
    [botFamily,botDefinition,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0];
  assert.equal(botV1.state,"DRAFT");
  assert.equal(botV1.version,1);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO automation_action_revision_pins
    (tenant_id,bot_flow_version_id,action_definition_id,action_revision_id)
    VALUES (app.current_tenant_id(),$1,$2,$3)`,[
    botV1.id,postgresActionId,postgresActionRevisionId,
  ]));
  const activatedBotV1=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.activate_bot_flow_version($1,$2,NULL,$3)",
    [botV1.id,botV1.revision,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0];
  assert.equal(activatedBotV1.active_flow_version_id,botV1.id);
  assert.equal(activatedBotV1.assignments_migrated,0);
  const botAssignment=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)",
    ["12000000-0000-4000-8000-000000000001",botFamily,"2",botV1.id,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0];
  const ownerFixtureAdmin=new Client({connectionString:adminUrl});await ownerFixtureAdmin.connect();
  try{
    await ownerFixtureAdmin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'tenant_owner')",[
      "10000000-0000-4000-8000-000000000001","20200000-0000-4000-8000-000000000002",
    ]);
    const ownerRaceClients=[new Client({connectionString:adminUrl}),new Client({connectionString:adminUrl})];
    await Promise.all(ownerRaceClients.map(client=>client.connect()));
    try{
      await Promise.all(ownerRaceClients.map(client=>client.query("BEGIN")));
      const demote=async(client,userId)=>{
        try{
          await client.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[
            "10000000-0000-4000-8000-000000000001",userId,
          ]);
          await client.query("COMMIT");
          return"committed";
        }catch(error){await client.query("ROLLBACK");return error}
      };
      const results=await Promise.all([
        demote(ownerRaceClients[0],"10100000-0000-4000-8000-000000000001"),
        demote(ownerRaceClients[1],"20200000-0000-4000-8000-000000000002"),
      ]);
      assert.equal(results.filter(result=>result==="committed").length,1);
      assert.equal(results.filter(result=>result?.code==="P0001"&&/WASALX_LAST_ACTIVE_OWNER/u.test(result.message)).length,1);
    }finally{
      await Promise.all(ownerRaceClients.map(client=>client.end()));
      await ownerFixtureAdmin.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=ANY($2::uuid[])",[
        "10000000-0000-4000-8000-000000000001",[
          "10100000-0000-4000-8000-000000000001","20200000-0000-4000-8000-000000000002",
        ],
      ]);
    }
    await assert.rejects(
      ()=>tenant("10000000-0000-4000-8000-000000000001",async()=>{
        await app.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=app.current_tenant_id() AND user_id=$1",[
          "10100000-0000-4000-8000-000000000001",
        ]);
        return app.query("SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)",[
          "12000000-0000-4000-8000-000000000001",botFamily,"2",botV1.id,"10100000-0000-4000-8000-000000000001",
        ]);
      }),
      error=>error.code==="42501",
    );
    assert.equal((await ownerFixtureAdmin.query("SELECT state FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[
      "10000000-0000-4000-8000-000000000001","10100000-0000-4000-8000-000000000001",
    ])).rows[0].state,"ACTIVE");
  }finally{
    await ownerFixtureAdmin.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2",[
      "10000000-0000-4000-8000-000000000001","10100000-0000-4000-8000-000000000001",
    ]).catch(()=>undefined);
    await ownerFixtureAdmin.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[
      "10000000-0000-4000-8000-000000000001","20200000-0000-4000-8000-000000000002",
    ]).catch(()=>undefined);
    await ownerFixtureAdmin.end();
  }
  const actorHistoryAdmin=new Client({connectionString:adminUrl});await actorHistoryAdmin.connect();
  await actorHistoryAdmin.query("BEGIN");
  try{
    const tenantId="10000000-0000-4000-8000-000000000001";
    const historicalActor="20200000-0000-4000-8000-000000000002";
    await actorHistoryAdmin.query(
      "INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES ($1,$2,'agent','ACTIVE')",[tenantId,historicalActor],
    );
    await actorHistoryAdmin.query("UPDATE tenant_settings SET updated_by=$2 WHERE tenant_id=$1",[tenantId,historicalActor]);
    await actorHistoryAdmin.query(`INSERT INTO consent_records(tenant_id,actor_id,policy_type,policy_version)
      VALUES ($1,$2,'ACTOR_HISTORY_TEST','v1')`,[tenantId,historicalActor]);
    await actorHistoryAdmin.query(`INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,request_id)
      VALUES ($1,'USER',$2,'actor.history_test','actor_history',$2,'postgres-actor-history')`,[
      tenantId,historicalActor,
    ]);
    await actorHistoryAdmin.query(
      "UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[tenantId,historicalActor],
    );
    assert.equal((await actorHistoryAdmin.query(
      "UPDATE tenant_settings SET default_theme=default_theme WHERE tenant_id=$1 RETURNING updated_by",[tenantId],
    )).rows[0].updated_by,historicalActor);
    assert.equal((await actorHistoryAdmin.query(
      "UPDATE consent_records SET accepted_at=accepted_at WHERE tenant_id=$1 AND actor_id=$2 RETURNING actor_id",[tenantId,historicalActor],
    )).rows[0].actor_id,historicalActor);
    assert.equal((await actorHistoryAdmin.query(
      "SELECT count(*)::integer AS count FROM audit_events WHERE tenant_id=$1 AND request_id='postgres-actor-history'",[tenantId],
    )).rows[0].count,1);
    await actorHistoryAdmin.query("SAVEPOINT actor_history_settings");
    await assert.rejects(
      ()=>actorHistoryAdmin.query("UPDATE tenant_settings SET updated_by=updated_by WHERE tenant_id=$1",[tenantId]),
      error=>error.code==="23503",
    );
    await actorHistoryAdmin.query("ROLLBACK TO SAVEPOINT actor_history_settings");
    await actorHistoryAdmin.query("SAVEPOINT actor_history_consent");
    await assert.rejects(
      ()=>actorHistoryAdmin.query(
        "UPDATE consent_records SET actor_id=actor_id WHERE tenant_id=$1 AND actor_id=$2",[tenantId,historicalActor],
      ),
      error=>error.code==="23503",
    );
    await actorHistoryAdmin.query("ROLLBACK TO SAVEPOINT actor_history_consent");
    await actorHistoryAdmin.query("SAVEPOINT actor_history_audit");
    await assert.rejects(
      ()=>actorHistoryAdmin.query(`INSERT INTO audit_events
        (tenant_id,actor_type,actor_id,action,target_type,target_id,request_id)
        VALUES ($1,'USER',$2,'actor.history_rejected','actor_history',$2,'postgres-actor-history-rejected')`,[
        tenantId,historicalActor,
      ]),
      error=>error.code==="23503",
    );
    await actorHistoryAdmin.query("ROLLBACK TO SAVEPOINT actor_history_audit");
  }finally{
    await actorHistoryAdmin.query("ROLLBACK").catch(()=>undefined);
    await actorHistoryAdmin.end();
  }
  const groupAutomationBefore=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT (SELECT count(*)::integer FROM whatsapp_groups) AS groups,(SELECT count(*)::integer FROM group_bindings) AS bindings",
  ))).rows[0];
  const dedicatedBotAssignment=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)",
    ["12100000-0000-4000-8000-000000000002",botFamily,"2",botV1.id,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0];
  const groupAutomationAfter=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT (SELECT count(*)::integer FROM whatsapp_groups) AS groups,(SELECT count(*)::integer FROM group_bindings) AS bindings",
  ))).rows[0];
  assert.equal(dedicatedBotAssignment.flow_version_id,botV1.id);
  await assert.rejects(
    tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)",
      ["12100000-0000-4000-8000-000000000002",botFamily,"2","49900000-0000-4000-8000-000000000099","10100000-0000-4000-8000-000000000001"],
    )),
    error=>error.code==="40001",
  );
  assert.equal((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT flow_version_id FROM bot_assignments WHERE id=$1",[dedicatedBotAssignment.assignment_id],
  ))).rows[0].flow_version_id,botV1.id);
  assert.deepEqual(groupAutomationAfter,groupAutomationBefore);
  const rollbackPrincipal={subject:"oidc-owner-a",userId:"10100000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",email:"owner@a.invalid",displayName:"Owner A",role:"tenant_owner"};
  const rollbackDatabase={withTenant:async(tenantId,operation)=>tenant(tenantId,()=>operation(app))};
  const rollbackBotControl=new BotFlowsService(rollbackDatabase,{wake:async()=>{}});
  const rollbackRuleControl=new RuleGovernanceService(rollbackDatabase,new RuleTestService());
  const groupCommandRules=[{name:"Historical status",matcherType:"starts_with",pattern:"/status",matcherOptions:{groupCommand:{actionId:"orders.lookup",input:{query:"{{message.argument}}"},successReply:"{{action.status}}",failureReply:"{{action.error}}"}},priority:1,enabled:true,savedExamples:[]}];
  const groupRuleV1=await rollbackRuleControl.create(rollbackPrincipal,"postgres-group-pin-v1","postgres-group-pin-v1",{name:"Pinned command",rules:groupCommandRules});
  const activeGroupRuleV1=await rollbackRuleControl.activate(rollbackPrincipal,groupRuleV1.id,"postgres-group-pin-v1-activate","postgres-group-pin-v1-activate",{expectedRevision:groupRuleV1.revision,expectedActiveRuleSetId:null,expectedActiveRevision:null});
  const postgresActionRevisionV2="45100000-0000-4000-8000-000000000006";
  await tenant(rollbackPrincipal.tenantId,async()=>{
    await app.query(`INSERT INTO bot_action_revisions
      (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
       headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
      VALUES ($1,app.current_tenant_id(),$2,2,'Order lookup','HTTP_JSON',
       'https://api.example.invalid/orders-v2','GET','NONE','{}','{"action.status":"/status"}',5000,262144,
       'ACTIVE',repeat('8',64),$3)`,[postgresActionRevisionV2,postgresActionId,rollbackPrincipal.userId]);
    await app.query(`UPDATE bot_action_definitions SET revision=2,endpoint_url='https://api.example.invalid/orders-v2',
      active_revision_id=$1,updated_by=$2,updated_at=now() WHERE tenant_id=app.current_tenant_id() AND id=$3`,[
      postgresActionRevisionV2,rollbackPrincipal.userId,postgresActionId,
    ]);
  });
  const botDefinitionV2={...botDefinition,name:"Support revision two"};
  const pinnedBotV2=await rollbackBotControl.clone(rollbackPrincipal,botV1.id,"postgres-direct-pin-v2","postgres-direct-pin-v2",botDefinitionV2);
  const activePinnedBotV2=await rollbackBotControl.activate(rollbackPrincipal,pinnedBotV2.id,"postgres-direct-pin-v2-activate","postgres-direct-pin-v2-activate",{expectedRevision:pinnedBotV2.revision,expectedActiveFlowVersionId:botV1.id});
  const botRollback=await rollbackBotControl.clone(rollbackPrincipal,botV1.id,"postgres-direct-pin-rollback","postgres-direct-pin-rollback",botDefinition);
  await rollbackBotControl.activate(rollbackPrincipal,botRollback.id,"postgres-direct-pin-rollback-activate","postgres-direct-pin-rollback-activate",{expectedRevision:botRollback.revision,expectedActiveFlowVersionId:activePinnedBotV2.flowVersionId});
  assert.deepEqual((await tenant(rollbackPrincipal.tenantId,()=>app.query(`SELECT pin.bot_flow_version_id,revision.revision
    FROM automation_action_revision_pins pin JOIN bot_action_revisions revision
      ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
    WHERE pin.tenant_id=app.current_tenant_id() AND pin.bot_flow_version_id=ANY($1::uuid[])
    ORDER BY pin.bot_flow_version_id`,[[botV1.id,pinnedBotV2.id,botRollback.id]]))).rows.map(row=>Number(row.revision)).sort(),[1,1,2]);
  const groupRuleV2=await rollbackRuleControl.clone(rollbackPrincipal,groupRuleV1.id,"postgres-group-pin-v2","postgres-group-pin-v2",{rules:groupCommandRules.map(rule=>({...rule,name:"Current status"}))});
  const activeGroupRuleV2=await rollbackRuleControl.activate(rollbackPrincipal,groupRuleV2.id,"postgres-group-pin-v2-activate","postgres-group-pin-v2-activate",{expectedRevision:groupRuleV2.revision,expectedActiveRuleSetId:activeGroupRuleV1.id,expectedActiveRevision:activeGroupRuleV1.revision});
  const groupRuleRollback=await rollbackRuleControl.rollback(rollbackPrincipal,groupRuleV1.id,"postgres-group-pin-rollback","postgres-group-pin-rollback",{expectedSourceRevision:activeGroupRuleV1.revision+1,expectedActiveRuleSetId:activeGroupRuleV2.id,expectedActiveRevision:activeGroupRuleV2.revision});
  const rollbackRuleId=(await tenant(rollbackPrincipal.tenantId,()=>app.query("SELECT id FROM trigger_rules WHERE tenant_id=app.current_tenant_id() AND rule_set_id=$1",[groupRuleRollback.id]))).rows[0].id;
  await tenant(rollbackPrincipal.tenantId,()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES ('44000000-0000-4000-8000-000000000019',app.current_tenant_id(),
      '12000000-0000-4000-8000-000000000001','WAHA','group-pin-rollback-event','message.any','{}','group-pin-rollback-hash','PROCESSING')`));
  const groupPinRepository=new InboundRepository(new Pool(connectorWorkerConfig));
  const pinnedGroupEvent={id:"44000000-0000-4000-8000-000000000019",tenantId:rollbackPrincipal.tenantId,connectionId:"12000000-0000-4000-8000-000000000001",provider:"waha",providerEventId:"group-pin-rollback-event",eventType:"message.any",payload:{},attempts:1};
  const pinnedGroupExecution=await groupPinRepository.beginGroupCommandAction(pinnedGroupEvent,rollbackRuleId,"orders.lookup",{query:"ORD-1"},3);
  assert.equal(pinnedGroupExecution.action.revision,1);
  assert.equal(pinnedGroupExecution.action.endpointUrl,"https://api.example.invalid/orders");
  assert.equal((await groupPinRepository.claimGroupCommandAction(pinnedGroupEvent,pinnedGroupExecution.id)).state,"RUNNING");
  assert.equal((await groupPinRepository.completeGroupCommandAction(pinnedGroupEvent,pinnedGroupExecution.id,rollbackRuleId,{state:"SUCCEEDED",variables:{}})).state,"SUCCEEDED");
  await groupPinRepository.close();
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES ('44000000-0000-4000-8000-000000000001',app.current_tenant_id(),
      '12000000-0000-4000-8000-000000000001','WAHA','bot-direct-event-1','message.any','{}','bot-direct-hash','PROCESSING')`));
  const botRepository=new InboundRepository(new Pool(connectorWorkerConfig));
  let botCreates=0;let botAppends=0;let botReplies=0;
  const directEvent={id:"44000000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001",provider:"waha",providerEventId:"bot-direct-event-1",eventType:"message.any",payload:{},attempts:1};
  // Keep the conversation inside the retention window for the later user export.
  const directMessageAt=Date.now()-60_000;
  const directMessage={provider:"waha",connectionId:directEvent.connectionId,eventId:directEvent.providerEventId,messageId:"bot-direct-message-1",chatId:"12025550116@c.us",senderId:"12025550116@c.us",senderName:"Verified customer",senderNameQuality:"VERIFIED",input:{type:"text",text:"Hello"},fromApi:false,fromMe:false,timestamp:new Date(directMessageAt).toISOString()};
  const directResult=await botRepository.processDirectMessage(directEvent,{assignmentId:botAssignment.assignment_id,zammadGroup:"2",zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret"},directMessage,{id:77,login:"opaque-customer"},{
    create:async()=>{botCreates+=1;return{id:"88",number:"90088"}},
    append:async()=>{botAppends+=1},
    reply:async()=>{botReplies+=1;return"bot-article-1"},
  });
  assert.deepEqual({duplicate:directResult.duplicate,queued:directResult.queued,state:directResult.state,botCreates,botAppends,botReplies},{duplicate:false,queued:true,state:"ACTION_PENDING",botCreates:1,botAppends:0,botReplies:0});
  const deferredBot=(await tenant(directEvent.tenantId,()=>app.query("SELECT id,zammad_article_id FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key LIKE 'bot:%' AND bot_conversation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",[directEvent.tenantId]))).rows[0];
  assert.ok(deferredBot);assert.equal(deferredBot.zammad_article_id,null);
  await assert.rejects(tenant(directEvent.tenantId,()=>app.query("UPDATE delivery_outbox SET direct_origin='HUMAN' WHERE id=$1",[deferredBot.id])),{code:"23514",constraint:"delivery_outbox_origin_shape"});
  const directReplay=await botRepository.processDirectMessage(directEvent,{assignmentId:botAssignment.assignment_id,zammadGroup:"2",zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret"},directMessage,{id:77,login:"opaque-customer"},{
    create:async()=>{throw new Error("duplicate created a ticket")},append:async()=>{throw new Error("duplicate appended an article")},reply:async()=>{throw new Error("duplicate replied")},
  });
  assert.deepEqual({duplicate:directReplay.duplicate,queued:directReplay.queued},{duplicate:true,queued:false});
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES ('44000000-0000-4000-8000-000000000006',app.current_tenant_id(),
      '12000000-0000-4000-8000-000000000001','WAHA','bot-direct-event-2','message.any','{}','bot-direct-hash-2','PROCESSING')`));
  const pendingResult=await botRepository.processDirectMessage(
    {...directEvent,id:"44000000-0000-4000-8000-000000000006",providerEventId:"bot-direct-event-2"},
    {assignmentId:botAssignment.assignment_id,zammadGroup:"2",zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret"},
    {...directMessage,eventId:"bot-direct-event-2",messageId:"bot-direct-message-2",senderName:"Lower quality name",senderNameQuality:"NOTIFY",input:{type:"text",text:"Any update?"},timestamp:new Date(directMessageAt+30_000).toISOString()},
    {id:77,login:"opaque-customer"},
    {create:async()=>{throw new Error("action-pending message created a ticket")},append:async()=>{botAppends+=1},reply:async()=>{throw new Error("action-pending message emitted a bot reply")}},
  );
  assert.deepEqual({duplicate:pendingResult.duplicate,queued:pendingResult.queued,state:pendingResult.state,ignored:pendingResult.ignored,botAppends},{duplicate:false,queued:false,state:"ACTION_PENDING",ignored:false,botAppends:1});
  assert.deepEqual((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT display_name,display_name_quality FROM participant_identities WHERE connection_id='12000000-0000-4000-8000-000000000001' AND external_participant_id='12025550116@c.us'",
  ))).rows,[{display_name:"Verified customer",display_name_quality:3}]);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES ('44000000-0000-4000-8000-000000000007',app.current_tenant_id(),
      '12000000-0000-4000-8000-000000000001','WAHA','bot-manual-device-event','message.any','{}','bot-manual-device-hash','PROCESSING')`));
  let manualDeviceAppends=0;
  const manualDeviceResult=await botRepository.processDirectMessage(
    {...directEvent,id:"44000000-0000-4000-8000-000000000007",providerEventId:"bot-manual-device-event"},
    {assignmentId:botAssignment.assignment_id,zammadGroup:"2",zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret"},
    {...directMessage,eventId:"bot-manual-device-event",messageId:"bot-manual-device-message",input:{type:"text",text:"Sent from the linked device"},fromMe:true,timestamp:new Date(directMessageAt+45_000).toISOString()},
    {id:77,login:"opaque-customer"},
    {create:async()=>{throw new Error("manual-device message created a second ticket")},append:async()=>{manualDeviceAppends+=1;return"90124"},reply:async()=>{throw new Error("manual-device message advanced the bot")}},
  );
  assert.deepEqual({state:manualDeviceResult.state,queued:manualDeviceResult.queued,ignored:manualDeviceResult.ignored,manualDeviceAppends},{state:"ACTION_PENDING",queued:false,ignored:false,manualDeviceAppends:1});
  assert.deepEqual((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT message.from_me,link.direction,
      event.safe_metadata->>'manual_device' AS manual_device
    FROM normalized_messages message
    JOIN message_links link ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id
      AND link.external_message_id=message.external_message_id
    JOIN bot_conversation_events event ON event.tenant_id=message.tenant_id AND event.event_inbox_id=message.event_inbox_id
    WHERE message.external_message_id='bot-manual-device-message'`))).rows,[{from_me:true,direction:"MANUAL_DEVICE",manual_device:"true"}]);
  assert.deepEqual((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    (SELECT count(*)::integer FROM bot_action_jobs WHERE conversation_id=conversation.id) AS action_jobs,
    (SELECT count(*)::integer FROM delivery_outbox WHERE bot_conversation_id=conversation.id) AS bot_deliveries
    FROM bot_conversations conversation WHERE external_chat_id='12025550116@c.us'`))).rows,[{action_jobs:1,bot_deliveries:1}]);
  const actionRepository=new OutboxRepository(new Pool(connectorWorkerConfig));
  const claimedBotActions=await actionRepository.claimBotActions("10000000-0000-4000-8000-000000000001","47000000-0000-4000-8000-000000000001");
  assert.equal(claimedBotActions.length,1);
  assert.deepEqual(claimedBotActions[0].requestInput,{query:"Hello"});
  await actionRepository.outcomeUnknownBotAction(claimedBotActions[0],"47000000-0000-4000-8000-000000000001","The external action outcome is unknown");
  assert.deepEqual((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT conversation.state AS conversation_state,action.state AS action_state
    FROM bot_conversations conversation JOIN bot_action_jobs action ON action.conversation_id=conversation.id
    WHERE action.id=$1`,[claimedBotActions[0].id]))).rows,[{conversation_state:"ACTION_PENDING",action_state:"OUTCOME_UNKNOWN"}]);
  const actionDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const actionDatabase=new DatabaseService();const actionControl=new BotFlowsService(actionDatabase,{wake:async()=>assert.fail("Human handoff must not reissue the action")});
  try{
    const actionPrincipal={subject:"oidc-owner-a",userId:"10100000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",email:"owner@a.invalid",displayName:"Owner A",role:"tenant_owner"};
    const fence=Number((await tenant(actionPrincipal.tenantId,()=>app.query("SELECT fencing_token FROM bot_conversations WHERE id=$1",[claimedBotActions[0].conversationId]))).rows[0].fencing_token);
    const queuedBotReply=(await tenant(actionPrincipal.tenantId,()=>app.query(`SELECT id,zammad_ticket_id,attempts FROM delivery_outbox
      WHERE bot_conversation_id=$1 AND direct_origin='BOT' AND state='QUEUED' ORDER BY created_at,id LIMIT 1`,[claimedBotActions[0].conversationId]))).rows[0];
    assert.ok(queuedBotReply);
    await tenant(actionPrincipal.tenantId,()=>app.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN',safe_error='PostgreSQL ambiguous delivery proof' WHERE id=$1",[queuedBotReply.id]));
    await assert.rejects(
      ()=>actionControl.commandConversation(actionPrincipal,claimedBotActions[0].conversationId,"postgres-action-human-handoff-blocked","postgres-action-human-handoff-blocked",{action:"HANDOFF_TO_HUMAN",expectedFencingToken:fence}),
      error=>/Resolve the pending WhatsApp bot delivery/.test(error?.message),
    );
    await tenant(actionPrincipal.tenantId,()=>app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='action-reply-sent',safe_error=NULL WHERE id=$1",[queuedBotReply.id]));
    const handedOff=await actionControl.commandConversation(actionPrincipal,claimedBotActions[0].conversationId,"postgres-action-human-handoff","postgres-action-human-handoff-1",{action:"HANDOFF_TO_HUMAN",expectedFencingToken:fence});
    const replayedHandoff=await actionControl.commandConversation(actionPrincipal,claimedBotActions[0].conversationId,"postgres-action-human-handoff","postgres-action-human-handoff-2",{action:"HANDOFF_TO_HUMAN",expectedFencingToken:fence});
    assert.equal(handedOff.state,"HUMAN");assert.equal(replayedHandoff.duplicate,true);
    assert.deepEqual((await tenant(actionPrincipal.tenantId,()=>app.query(`SELECT conversation.state AS conversation_state,action.state AS action_state,
      (SELECT count(*)::integer FROM bot_conversation_events event WHERE event.conversation_id=conversation.id
        AND event.event_kind='HANDOFF_COMPLETED' AND event.safe_metadata->>'external_action_reissued'='false') AS no_reissue_events
      FROM bot_conversations conversation JOIN bot_action_jobs action ON action.conversation_id=conversation.id
      WHERE action.id=$1`,[claimedBotActions[0].id]))).rows,[{conversation_state:"HUMAN",action_state:"OUTCOME_UNKNOWN",no_reissue_events:1}]);
    const cancellationLease="47000000-0000-4000-8000-000000000009";
    await tenant(actionPrincipal.tenantId,()=>app.query("UPDATE delivery_outbox SET state='QUEUED',external_message_id=NULL WHERE id=$1",[queuedBotReply.id]));
    const claimedReply=(await tenant(actionPrincipal.tenantId,()=>app.query(`UPDATE delivery_outbox SET state='CLAIMED',attempts=attempts+1,
      lease_id=$1,lease_expires_at=now()+interval '1 minute' WHERE id=$2 AND state='QUEUED' RETURNING attempts`,[cancellationLease,queuedBotReply.id]))).rows[0];
    await tenant(actionPrincipal.tenantId,()=>app.query(`INSERT INTO delivery_attempts (tenant_id,delivery_id,attempt_number,state)
      VALUES (app.current_tenant_id(),$1,$2,'CLAIMED')`,[queuedBotReply.id,claimedReply.attempts]));
    const directAuthorization=await tenant(actionPrincipal.tenantId,()=>app.query("SELECT authorized,reason_code FROM app.authorize_waha_outbound_send($1)",[queuedBotReply.id]));
    assert.equal(directAuthorization.rowCount,1);assert.ok(typeof directAuthorization.rows[0].reason_code==="string");
    assert.equal(await actionRepository.beginSend({id:queuedBotReply.id,tenantId:actionPrincipal.tenantId,connectionId:directEvent.connectionId,botConversationId:claimedBotActions[0].conversationId,attempts:claimedReply.attempts,provider:"waha",ticketId:queuedBotReply.zammad_ticket_id},cancellationLease),false);
    assert.deepEqual((await tenant(actionPrincipal.tenantId,()=>app.query("SELECT state,manual_retry_allowed FROM delivery_outbox WHERE id=$1",[queuedBotReply.id]))).rows,[{state:"FAILED_TERMINAL",manual_retry_allowed:false}]);
    await tenant(actionPrincipal.tenantId,async()=>{
      const humanDelivery=(await app.query(`INSERT INTO delivery_outbox
        (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
         message_body,content_type,idempotency_key,state,direct_origin,available_at)
        SELECT tenant_id,connection_id,id,external_chat_id,zammad_ticket_id,'human-after-action-handoff',
          'A person is continuing this conversation.','text/plain','human-after-action-handoff','QUEUED','HUMAN','-infinity'::timestamptz
          FROM bot_conversations WHERE id=$1 RETURNING id`,[claimedBotActions[0].conversationId])).rows[0];
      const claimedHuman=(await app.query("SELECT id FROM app.claim_delivery_jobs($1,1) WHERE id=$2",["47000000-0000-4000-8000-000000000010",humanDelivery.id])).rows;
      assert.deepEqual(claimedHuman,[{id:humanDelivery.id}]);
      await app.query(`UPDATE delivery_outbox
        SET state='FAILED_TERMINAL',manual_retry_allowed=false,lease_id=NULL,lease_expires_at=NULL,
            safe_error='Test cleanup before provider send.',updated_at=now()
        WHERE id=$1`,[humanDelivery.id]);
      assert.deepEqual((await app.query("SELECT direct_origin,state,manual_retry_allowed FROM delivery_outbox WHERE id=$1",[humanDelivery.id])).rows,
        [{direct_origin:"HUMAN",state:"FAILED_TERMINAL",manual_retry_allowed:false}]);
      await app.query("DELETE FROM zammad_status_outbox WHERE delivery_id=$1",[queuedBotReply.id]);
      await app.query("DELETE FROM delivery_attempts WHERE delivery_id=$1",[queuedBotReply.id]);
      await app.query("UPDATE delivery_outbox SET state='QUEUED',attempts=0,lease_id=NULL,lease_expires_at=NULL,safe_error=NULL WHERE id=$1",[queuedBotReply.id]);
    });
  }finally{await actionDatabase.onModuleDestroy();if(actionDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=actionDatabaseUrl}
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_conversations SET state='ACTION_PENDING' WHERE id=$1",[claimedBotActions[0].conversationId]));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_action_jobs SET state='FAILED_RETRYABLE',completed_at=NULL,available_at=now() WHERE id=$1",[claimedBotActions[0].id]));
  const reclaimedBotActions=await actionRepository.claimBotActions("10000000-0000-4000-8000-000000000001","47000000-0000-4000-8000-000000000002");
  assert.equal(reclaimedBotActions.length,1);
  const completedAction=reclaimedBotActions[0];
  const actionAdvance=advanceBotFlow(parseBotFlow(completedAction.flowDefinition),completedAction.onSuccessNodeId,undefined,{...completedAction.conversationVariables,"action.status":"shipped"});
  assert.equal(actionAdvance.state,"RESOLVED");
  await actionRepository.recordBotActionResult(completedAction,"47000000-0000-4000-8000-000000000002","SUCCEEDED",{"action.status":"shipped"});
  await app.query("BEGIN");
  try{
    await app.query("SELECT set_config('app.tenant_id',$1,true)",[completedAction.tenantId]);
    const probeRepository=Object.create(OutboxRepository.prototype);
    probeRepository.tenant=async(scope,operation)=>{assert.equal(scope,completedAction.tenantId);return operation(app)};
    const orderedAdvance={...actionAdvance,effects:[{type:"send_text",nodeId:"first",text:"First"},{type:"send_text",nodeId:"second",text:"Second"}]};
    await probeRepository.completeBotAction(completedAction,"47000000-0000-4000-8000-000000000002","SUCCEEDED",{},orderedAdvance);
    const ordered=(await app.query("SELECT message_body,zammad_article_id,extract(epoch FROM created_at)::text AS at FROM delivery_outbox WHERE tenant_id=$1 AND idempotency_key LIKE $2 ORDER BY created_at,id",[completedAction.tenantId,`bot-action:${completedAction.id}:%`])).rows;
    assert.deepEqual(ordered.map(row=>row.message_body),["First","Second"]);
    assert.ok(Number(ordered[1].at)>Number(ordered[0].at),"action effects must not tie on transaction time");
    assert.ok(ordered.every(row=>row.zammad_article_id===null),"history projection belongs to ordered delivery");
  }finally{await app.query("ROLLBACK")}
  await actionRepository.completeBotAction(completedAction,"47000000-0000-4000-8000-000000000002","SUCCEEDED",{"action.status":"shipped"},actionAdvance);
  await actionRepository.close();
  const directRows=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    (SELECT state FROM bot_conversations WHERE external_chat_id='12025550116@c.us') AS conversation_state,
    (SELECT resolution_kind FROM bot_conversations WHERE external_chat_id='12025550116@c.us') AS resolution_kind,
    (SELECT count(*)::integer FROM bot_conversation_events WHERE event_inbox_id='44000000-0000-4000-8000-000000000001') AS event_count,
    (SELECT count(*)::integer FROM delivery_outbox WHERE bot_conversation_id IS NOT NULL AND external_chat_id='12025550116@c.us') AS delivery_count,
    (SELECT count(*)::integer FROM delivery_outbox WHERE bot_conversation_id IS NOT NULL AND external_chat_id='12025550116@c.us' AND direct_origin='BOT') AS bot_delivery_count,
    (SELECT count(*)::integer FROM message_links WHERE external_message_id='bot-direct-message-1' AND direction='INBOUND') AS link_count`));
  assert.deepEqual(directRows.rows,[{conversation_state:"RESOLVED",resolution_kind:"FLOW",event_count:1,delivery_count:3,bot_delivery_count:2,link_count:1}]);
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query("SAVEPOINT bot_delivery_order_probe");
    const first=(await app.query("SELECT id,idempotency_key FROM app.claim_delivery_jobs($1,25) WHERE external_chat_id='12025550116@c.us'",["47000000-0000-4000-8000-000000000003"])).rows;
    assert.equal(first.length,1);
    await app.query("UPDATE delivery_outbox SET state='SENT' WHERE id=$1",[first[0].id]);
    const second=(await app.query("SELECT id,idempotency_key FROM app.claim_delivery_jobs($1,25) WHERE external_chat_id='12025550116@c.us'",["47000000-0000-4000-8000-000000000004"])).rows;
    assert.equal(second.length,1);assert.notEqual(second[0].idempotency_key,first[0].idempotency_key);
    await app.query("ROLLBACK TO SAVEPOINT bot_delivery_order_probe");
  });
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query("SAVEPOINT direct_destination_restart_order_probe");
    const conversations=(await app.query(`INSERT INTO bot_conversations
      (id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,
       zammad_ticket_id,zammad_ticket_number,last_activity_at,resolved_at,resolution_kind,created_at)
      VALUES
      ('47100000-0000-4000-8000-000000000001',app.current_tenant_id(),$1,'12000000-0000-4000-8000-000000000001',$2,
       '12025550117@c.us','BOT-000000000771','RESOLVED','done','771','90771',now()-interval '2 minutes',now()-interval '1 minute','FLOW',now()-interval '2 minutes'),
      ('47100000-0000-4000-8000-000000000002',app.current_tenant_id(),$1,'12000000-0000-4000-8000-000000000001',$2,
       '12025550117@c.us','BOT-000000001771','BOT','hello','771','90771',now(),NULL,NULL,now())
      RETURNING id`,[botAssignment.assignment_id,botV1.id])).rows;
    assert.equal(conversations.length,2);
    await app.query(`INSERT INTO delivery_outbox
      (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
       message_body,content_type,idempotency_key,state,direct_origin,manual_retry_allowed,created_at)
      VALUES
      (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','47100000-0000-4000-8000-000000000001','12025550117@c.us','771','restart-old',
       'Old final reply','text/plain','restart-order-old','FAILED_TERMINAL','BOT',true,now()-interval '1 minute'),
      (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','47100000-0000-4000-8000-000000000002','12025550117@c.us','771','restart-new',
       'New greeting','text/plain','restart-order-new','QUEUED','BOT',false,now())`);
    const held=(await app.query("SELECT id FROM app.claim_delivery_jobs($1,25) WHERE external_chat_id='12025550117@c.us'",["47000000-0000-4000-8000-000000000005"])).rows;
    assert.equal(held.length,0);
    await app.query("UPDATE delivery_outbox SET state='PRIVACY_CANCELLED',manual_retry_allowed=false WHERE idempotency_key='restart-order-old'");
    const released=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,25) WHERE external_chat_id='12025550117@c.us'",["47000000-0000-4000-8000-000000000006"])).rows;
    assert.deepEqual(released,[{idempotency_key:"restart-order-new"}]);
    await app.query("ROLLBACK TO SAVEPOINT direct_destination_restart_order_probe");
  });
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query("SAVEPOINT direct_human_order_probe");
    const conversation=(await app.query(`INSERT INTO bot_conversations
      (id,tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,
       zammad_ticket_id,zammad_ticket_number,last_activity_at,created_at)
      VALUES ('47100000-0000-4000-8000-000000000003',app.current_tenant_id(),$1,'12000000-0000-4000-8000-000000000001',$2,
       '12025550118@c.us','BOT-000000000772','HUMAN','handoff','772','90772',now(),now()) RETURNING id`,[botAssignment.assignment_id,botV1.id])).rows[0];
    await app.query(`INSERT INTO delivery_outbox
      (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
       message_body,content_type,idempotency_key,state,direct_origin,created_at)
      VALUES
      (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001',$1,'12025550118@c.us','772','human-1',
       'First agent reply','text/plain','human-order-1','QUEUED','HUMAN',now()-interval '1 second'),
      (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001',$1,'12025550118@c.us','772','human-2',
       'Second agent reply','text/plain','human-order-2','QUEUED','HUMAN',now())`,[conversation.id]);
    const first=(await app.query("SELECT id,idempotency_key FROM app.claim_delivery_jobs($1,25) WHERE external_chat_id='12025550118@c.us'",["47000000-0000-4000-8000-000000000007"])).rows;
    assert.deepEqual(first.map(row=>row.idempotency_key),["human-order-1"]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='human-order-first' WHERE id=$1",[first[0].id]);
    const second=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,25) WHERE external_chat_id='12025550118@c.us'",["47000000-0000-4000-8000-000000000008"])).rows;
    assert.deepEqual(second,[{idempotency_key:"human-order-2"}]);
    await app.query("ROLLBACK TO SAVEPOINT direct_human_order_probe");
  });
  await botRepository.close();
  const botConversation=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`
    INSERT INTO bot_conversations (
      tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,
      normalized_reference,state,current_node_id,zammad_ticket_id,zammad_ticket_number,last_activity_at
    ) VALUES (
      app.current_tenant_id(),$1,'12000000-0000-4000-8000-000000000001',$2,
      '12025550119@c.us','BOT-A1B2C3D4E5F6','HUMAN','handoff','99','90099',now()
    ) RETURNING id,flow_version_id`,[botAssignment.assignment_id,botV1.id]))).rows[0];
  const botEvent=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`
    INSERT INTO bot_conversation_events (
      tenant_id,conversation_id,event_kind,to_node_id,safe_metadata
    ) VALUES (app.current_tenant_id(),$1,'STARTED','hello','{"provider":"waha"}')
    RETURNING id`,[botConversation.id]))).rows[0];
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_conversations SET state='HANDOFF_PENDING' WHERE id=$1",[botConversation.id]));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO delivery_outbox
    (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
     message_body,content_type,idempotency_key,state,direct_origin)
    VALUES (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001',$1,
      '12025550119@c.us','99','handoff-article','A person will join shortly.','text/plain','handoff-order-proof','QUEUED','BOT')`,[botConversation.id]));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_handoff_jobs
    (tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,priority)
    VALUES (app.current_tenant_id(),$1,'44000000-0000-4000-8000-000000000001','handoff','2','2 normal')`,[botConversation.id]));
  const handoffRepository=new OutboxRepository(new Pool(connectorWorkerConfig));
  assert.equal((await handoffRepository.claimBotHandoffs("10000000-0000-4000-8000-000000000001","49000000-0000-4000-8000-000000000001")).length,0);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE idempotency_key='handoff-order-proof'",
  ));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE bot_handoff_jobs SET available_at=now() WHERE conversation_id=$1",[botConversation.id],
  ));
  assert.equal((await handoffRepository.claimBotHandoffs("10000000-0000-4000-8000-000000000001","49000000-0000-4000-8000-000000000009")).length,0);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE delivery_outbox SET state='SENT',external_message_id='handoff-order-provider-proof' WHERE idempotency_key='handoff-order-proof'",
  ));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE bot_handoff_jobs SET available_at=now() WHERE conversation_id=$1",[botConversation.id],
  ));
  const releasedHandoff=await handoffRepository.claimBotHandoffs("10000000-0000-4000-8000-000000000001","49000000-0000-4000-8000-000000000002");
  assert.equal(releasedHandoff.length,1);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE idempotency_key='handoff-order-proof'",
  ));
  await assert.rejects(
    ()=>handoffRepository.completeBotHandoff(releasedHandoff[0],"49000000-0000-4000-8000-000000000002"),
    /Bot replies are still pending before human handoff/,
  );
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "UPDATE delivery_outbox SET state='SENT' WHERE idempotency_key='handoff-order-proof'",
  ));
  await handoffRepository.completeBotHandoff(releasedHandoff[0],"49000000-0000-4000-8000-000000000002");
  await handoffRepository.close();
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE bot_conversation_events SET safe_metadata='{}' WHERE id=$1",[botEvent.id],
    )),
    error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
      "UPDATE bot_flow_versions SET definition='{}' WHERE id=$1",[botV1.id],
    )),
    error=>error.code==="42501",
  );
  const botV2=(await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.create_bot_flow_version($1,$2,$3,$4)",
    [botFamily,{...botDefinition,nodes:[
      {id:"hello",type:"send_text",text:"Hello again",next:"done"},
      {id:"done",type:"end"},
    ]},botV1.id,"10100000-0000-4000-8000-000000000001"],
  ))).rows[0];
  const activationClient=new Client({connectionString:appUrl});
  const staleAssignmentClient=new Client({connectionString:appUrl});
  const assignmentRaceObserver=new Client({connectionString:adminUrl});
  await Promise.all([activationClient.connect(),staleAssignmentClient.connect(),assignmentRaceObserver.connect()]);
  let activatedBotV2;
  try{
    await activationClient.query("BEGIN");
    await activationClient.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    activatedBotV2=(await activationClient.query(
      "SELECT * FROM app.activate_bot_flow_version($1,$2,$3,$4)",
      [botV2.id,botV2.revision,botRollback.id,"10100000-0000-4000-8000-000000000001"],
    )).rows[0];
    await staleAssignmentClient.query("BEGIN");
    await staleAssignmentClient.query("SET LOCAL statement_timeout='2s'");
    await staleAssignmentClient.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    const staleAssignmentPid=(await staleAssignmentClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let staleAssignmentSettled=false;
    const staleAssignment=staleAssignmentClient.query(
      "SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)",
      ["12000000-0000-4000-8000-000000000001",botFamily,"2",botRollback.id,"10100000-0000-4000-8000-000000000001"],
    ).then(()=>{staleAssignmentSettled=true;return null},error=>{staleAssignmentSettled=true;return error});
    let staleAssignmentBlocked=false;
    for(let attempt=0;attempt<100&&!staleAssignmentBlocked;attempt+=1){
      staleAssignmentBlocked=(await assignmentRaceObserver.query(
        "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[staleAssignmentPid],
      )).rows[0].blocked;
      if(!staleAssignmentBlocked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(staleAssignmentBlocked,true);
    assert.equal(staleAssignmentSettled,false);
    await activationClient.query("COMMIT");
    assert.equal((await staleAssignment).code,"40001");
    await staleAssignmentClient.query("ROLLBACK");
  }finally{
    await activationClient.query("ROLLBACK").catch(()=>undefined);
    await staleAssignmentClient.query("ROLLBACK").catch(()=>undefined);
    await Promise.all([activationClient.end(),staleAssignmentClient.end(),assignmentRaceObserver.end()]);
  }
  assert.equal(activatedBotV2.assignments_migrated,2);
  const botVersionPins=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT (SELECT flow_version_id FROM bot_assignments WHERE id=$1) AS assigned,(SELECT flow_version_id FROM bot_conversations WHERE id=$2) AS conversation",
    [botAssignment.assignment_id,botConversation.id],
  ));
  assert.deepEqual(botVersionPins.rows,[{assigned:botV2.id,conversation:botV1.id}]);
  const heartbeat=await wahaRegistry.query(`SELECT worker_key,health_state
    FROM app.report_waha_worker_heartbeat(
      'postgres-gows-a','GOWS','http://waha-test.internal:3000',
      'secret://platform/waha/postgres-gows-a',100,'STABLE',NULL,300,
      true,now()-interval '1 minute',NULL
    )`);
  assert.deepEqual(heartbeat.rows,[{worker_key:"postgres-gows-a",health_state:"HEALTHY"}]);
  const assignment=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT worker_key,engine,assignment_fencing_token
    FROM app.acquire_waha_session_assignment(
      (SELECT id FROM provider_sessions WHERE tenant_id=app.current_tenant_id()
        AND connection_id='12000000-0000-4000-8000-000000000001'
        AND ownership_state='ACTIVE'),
      'GOWS',interval '5 minutes'
    )`));
  assert.deepEqual(assignment.rows,[{worker_key:"postgres-gows-a",engine:"GOWS",assignment_fencing_token:"1"}]);
  await timeScenario("wahaRenewal",()=>verifyWahaRenewal({app,registry:wahaRegistry,admin:fixtureAdmin,adminUrl}));
  const dependencyRepository=new InboundRepository(new Pool(connectorWorkerConfig));
  const dependencyAdmin=new Client({connectionString:adminUrl});await dependencyAdmin.connect();
  try{
    await dependencyAdmin.query("UPDATE zammad_instances SET state='DEGRADED' WHERE tenant_id=$1",["10000000-0000-4000-8000-000000000001"]);
    await assert.rejects(()=>dependencyRepository.directContext(directEvent,directMessage.chatId,directMessage.senderId),/dependencies are temporarily unavailable/);
  }finally{
    await dependencyAdmin.query("UPDATE zammad_instances SET state='WORKING' WHERE tenant_id=$1",["10000000-0000-4000-8000-000000000001"]);
    await Promise.all([dependencyRepository.close(),dependencyAdmin.end()]);
  }
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_assignments SET state='PAUSED' WHERE id=$1",[botAssignment.assignment_id]));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
    VALUES ('44000000-0000-4000-8000-000000000002',app.current_tenant_id(),
      '12000000-0000-4000-8000-000000000001','WAHA','bot-human-event-2','message.any','{}','bot-human-hash','PROCESSING')`));
  const humanRepository=new InboundRepository(new Pool(connectorWorkerConfig));let humanAppends=0;
  try{
    let pausedAppends=0;
    for(const [state,suffix] of [["BOT","4"],["ACTION_PENDING","5"]]){
      const eventId=`44000000-0000-4000-8000-00000000000${suffix}`;
      const providerEventId=`bot-paused-${state.toLowerCase()}-${suffix}`;
      await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_conversations SET state=$1 WHERE id=$2",[state,botConversation.id]));
      await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
        (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
        VALUES ($1,app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA',$2,'message.any','{}',$3,'PROCESSING')`,
      [eventId,providerEventId,`bot-paused-hash-${suffix}`]));
      const pausedEvent={...directEvent,id:eventId,providerEventId};
      const pausedMessage={...directMessage,eventId:providerEventId,messageId:`bot-paused-message-${suffix}`,chatId:"12025550119@c.us",senderId:"12025550119@c.us",timestamp:`2026-08-15T00:0${suffix}:00.000Z`};
      const pausedContext=await humanRepository.directContext(pausedEvent,pausedMessage.chatId,pausedMessage.senderId);
      assert.ok(pausedContext);assert.equal(pausedContext.assignmentId,botAssignment.assignment_id);
      const pausedResult=await humanRepository.processDirectMessage(pausedEvent,pausedContext,pausedMessage,{id:77,login:"opaque-customer"},{
        create:async()=>{throw new Error("paused existing chat created a ticket")},
        append:async ticketId=>{assert.equal(ticketId,"99");pausedAppends+=1},
        reply:async()=>{throw new Error("paused existing chat emitted a bot reply")},
      });
      assert.deepEqual({state:pausedResult.state,queued:pausedResult.queued,ignored:pausedResult.ignored},{state,queued:false,ignored:false});
    }
    assert.equal(pausedAppends,2);
    await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_conversations SET state='HUMAN' WHERE id=$1",[botConversation.id]));
    const humanResult=await humanRepository.processDirectMessage(
      {...directEvent,id:"44000000-0000-4000-8000-000000000002",providerEventId:"bot-human-event-2"},
      {assignmentId:botAssignment.assignment_id,zammadGroup:"2",zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret"},
      {...directMessage,eventId:"bot-human-event-2",messageId:"bot-human-message-2",chatId:"12025550119@c.us",senderId:"12025550119@c.us",timestamp:"2026-08-15T00:01:00.000Z"},
      {id:77,login:"opaque-customer"},{
        create:async()=>{throw new Error("paused human chat created a ticket")},
        append:async ticketId=>{assert.equal(ticketId,"99");humanAppends+=1},
        reply:async()=>{throw new Error("paused human chat emitted a bot reply")},
      },
    );
    assert.deepEqual({state:humanResult.state,queued:humanResult.queued,ignored:humanResult.ignored,humanAppends},{state:"HUMAN",queued:false,ignored:false,humanAppends:1});
    await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_conversations SET state='HANDOFF_PENDING' WHERE id=$1",[botConversation.id]));
    await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO event_inbox
      (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
      VALUES ('44000000-0000-4000-8000-000000000003',app.current_tenant_id(),
        '12000000-0000-4000-8000-000000000001','WAHA','bot-handoff-event-3','message.any','{}','bot-handoff-hash','PROCESSING')`));
    const pendingResult=await humanRepository.processDirectMessage(
      {...directEvent,id:"44000000-0000-4000-8000-000000000003",providerEventId:"bot-handoff-event-3"},
      {assignmentId:botAssignment.assignment_id,zammadGroup:"2",zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret"},
      {...directMessage,eventId:"bot-handoff-event-3",messageId:"bot-handoff-message-3",chatId:"12025550119@c.us",senderId:"12025550119@c.us",timestamp:"2026-08-15T00:02:00.000Z"},
      {id:77,login:"opaque-customer"},{create:async()=>{throw new Error("pending handoff created a ticket")},append:async()=>{humanAppends+=1},reply:async()=>{throw new Error("pending handoff emitted a bot reply")}},
    );
    assert.deepEqual({state:pendingResult.state,queued:pendingResult.queued,ignored:pendingResult.ignored,humanAppends},{state:"HANDOFF_PENDING",queued:false,ignored:false,humanAppends:2});
    await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE bot_conversations SET state='HUMAN' WHERE id=$1",[botConversation.id]));
  }finally{await humanRepository.close()}
  const botDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const botDatabase=new DatabaseService();const botControl=new BotFlowsService(botDatabase,{wake:async()=>{}});
  const botPrincipal={subject:"oidc-owner-a",userId:"10100000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",email:"owner@a.invalid",displayName:"Owner A",role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]};
  const botResumeFence=Number((await tenant(botPrincipal.tenantId,()=>app.query("SELECT fencing_token FROM bot_conversations WHERE id=$1",[botConversation.id]))).rows[0].fencing_token);
  try{
    await assert.rejects(
      ()=>botControl.commandConversation(botPrincipal,botConversation.id,"postgres-resume-paused","postgres-resume-paused",{action:"RESUME_BOT",expectedFencingToken:botResumeFence}),
      error=>/Activate the bot assignment/.test(error?.message),
    );
    await assert.rejects(
      ()=>botControl.saveAction(botPrincipal,"postgres-edit-pinned-action",{actionKey:"orders.lookup",name:"Changed lookup",kind:"HTTP_JSON",endpointUrl:"https://api.example.invalid/orders",httpMethod:"GET",authScheme:"NONE",secretReference:null,headers:{},responseMapping:{"action.status":"/status"},timeoutMs:5000,maxResponseBytes:262144,state:"ACTIVE",expectedRevision:2}),
      error=>/pinned by an active flow or open conversation/.test(error?.message),
    );
    await tenant(botPrincipal.tenantId,()=>app.query("UPDATE bot_assignments SET state='ACTIVE' WHERE id=$1",[botAssignment.assignment_id]));
    const resumed=await botControl.commandConversation(botPrincipal,botConversation.id,"postgres-resume-active","postgres-resume-active",{action:"RESUME_BOT",expectedFencingToken:botResumeFence});
    assert.equal(resumed.state,"BOT");
    const resumedPin=(await tenant(botPrincipal.tenantId,()=>app.query("SELECT flow_version_id,current_node_id FROM bot_conversations WHERE id=$1",[botConversation.id]))).rows[0];
    assert.deepEqual(resumedPin,{flow_version_id:botV1.id,current_node_id:"hello"});
  }finally{await botDatabase.onModuleDestroy();if(botDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=botDatabaseUrl}
  const quoteAdmin=new Client({connectionString:adminUrl});await quoteAdmin.connect();
  try{await timeScenario("directKeepOpenConstraints",()=>verifyDirectKeepOpenConstraints(quoteAdmin,botPrincipal.tenantId,{
    foreignTenantId:"20000000-0000-4000-8000-000000000002",botAssignmentId:botAssignment.assignment_id,botFlowVersionId:botV1.id,
    userId:botPrincipal.userId,adminUrl,existingConversationId:botConversation.id,
  }));await timeScenario("teamNumberValidation",()=>verifyTeamNumberValidation(quoteAdmin,botPrincipal.tenantId));await timeScenario("participantIdentityProjection",()=>verifyParticipantIdentityProjection(quoteAdmin,botPrincipal.tenantId));await timeScenario("groupParticipantDedup",()=>verifyGroupParticipantDedup(quoteAdmin,botPrincipal.tenantId));await timeScenario("groupQuoteProjection",()=>verifyGroupQuoteProjection(quoteAdmin,botPrincipal.tenantId));await timeScenario("ticketEventTargets",()=>verifyTicketEventTargets(quoteAdmin,botPrincipal.tenantId,{userId:botPrincipal.userId,foreignTenantId:"20000000-0000-4000-8000-000000000002",botAssignmentId:botAssignment.assignment_id,botFlowVersionId:botV1.id}));const designationStartedAt=new Date().toISOString();
  await timeScenario("groupWorkspaceReceipts", async () => {
    await verifyGroupWorkspaceReceipts(quoteAdmin,appUrl);
  });
  const designationProof=await timeScenario("groupDesignation",()=>verifyGroupDesignation(quoteAdmin,appUrl));
  const designationFinishedAt=new Date().toISOString();
  const migrationRows=(await quoteAdmin.query('SELECT name,checksum_sha256 FROM wasalx_schema_migrations ORDER BY name')).rows;
  const currentMigrationChecksums=new Map(await Promise.all(migrationFiles.map(async name=>[name,createHash('sha256').update(await readFile(new URL('../services/control-api/migrations/'+name,import.meta.url))).digest('hex')])));
  for(const [name,sha] of currentMigrationChecksums)assert.equal(migrationRows.find(row=>row.name===name)?.checksum_sha256,sha,'Designation migration identity mismatch: '+name);
  const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
  const git=args=>execFileSync('git',args,{cwd:repositoryRoot,encoding:'utf8'}).trim();
  const designationSourceFiles=['tests/group-designation-postgres.mjs','tests/group-designation-evidence.mjs','scripts/test-postgres-integration.mjs'];
  const designationSourceHashes=Object.fromEntries(await Promise.all(designationSourceFiles.map(async name=>[name,createHash('sha256').update(await readFile(resolve(repositoryRoot,name))).digest('hex')])));
  console.log(JSON.stringify({kind:'postgres-designation-proof',evidenceMode:'simulated',candidateSha:git(['rev-parse','HEAD']),treeSha:git(['rev-parse','HEAD^{tree}']),trackedWorktreeChanges:git(['status','--porcelain','--untracked-files=no'])!=='',sourceHashes:designationSourceHashes,migrations:migrationRows,database:(await quoteAdmin.query('SELECT current_database() AS name')).rows[0].name,results:designationResults(designationProof,{startedAt:designationStartedAt,finishedAt:designationFinishedAt}),acceptance:'Supporting proof; complete canonical PostgreSQL gate exit and candidate admission still required'}));await timeScenario("ownedWorkRestoration",()=>verifyOwnedWorkRestoration(quoteAdmin,appUrl))}finally{await quoteAdmin.end()}
  const crossTenantBot=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT count(*)::integer AS count FROM bot_flow_versions",
  ));
  assert.deepEqual(crossTenantBot.rows,[{count:0}]);
  await tenant(botPrincipal.tenantId,()=>app.query(`
    INSERT INTO whatsapp_groups (id,tenant_id,connection_id,external_group_id,display_name)
      VALUES
      ('13100000-0000-4000-8000-000000000001',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','fixture-0012@example.test','Workspace privacy'),
      ('13200000-0000-4000-8000-000000000001',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','fixture-0013@example.test','Workspace ticketless');
    INSERT INTO group_workspace_settings
      (tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by)
      VALUES
      (app.current_tenant_id(),'13000000-0000-4000-8000-000000000001',true,now()-interval '10 days',1,'RESTRICTED','10100000-0000-4000-8000-000000000001'),
      (app.current_tenant_id(),'13100000-0000-4000-8000-000000000001',true,now()-interval '10 days',1,'RESTRICTED','10100000-0000-4000-8000-000000000001'),
      (app.current_tenant_id(),'13200000-0000-4000-8000-000000000001',true,now()-interval '10 days',1,'RESTRICTED','10100000-0000-4000-8000-000000000001');
    INSERT INTO group_bindings
      (id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
      VALUES ('15200000-0000-4000-8000-000000000001',app.current_tenant_id(),'13200000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'ACTIVE');
    INSERT INTO event_inbox
      (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
      VALUES
      ('63100000-0000-4000-8000-000000000001',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA','workspace-privacy-event','message.any','{}','workspace-privacy-event-hash','PROCESSED',now()-interval '9 days',now()-interval '9 days'),
      ('63100000-0000-4000-8000-000000000002',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA','workspace-user-hold-event','message.any','{}','workspace-user-hold-event-hash','PROCESSED',now()-interval '9 days',now()-interval '9 days');
    INSERT INTO media_objects
      (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at)
      VALUES
      ('63200000-0000-4000-8000-000000000001',app.current_tenant_id(),repeat('4',64),app.current_tenant_id()::text||'/sha256/44/'||repeat('4',64),'image/png',8,'CLEAN',now()-interval '8 days',now()-interval '9 days'),
      ('63200000-0000-4000-8000-000000000002',app.current_tenant_id(),repeat('5',64),app.current_tenant_id()::text||'/sha256/55/'||repeat('5',64),'image/png',8,'CLEAN',now()-interval '8 days',now()-interval '9 days'),
      ('63200000-0000-4000-8000-000000000003',app.current_tenant_id(),repeat('6',64),app.current_tenant_id()::text||'/sha256/66/'||repeat('6',64),'image/png',8,'CLEAN',now()-interval '8 days',now()-interval '9 days'),
      ('63200000-0000-4000-8000-000000000004',app.current_tenant_id(),repeat('7',64),app.current_tenant_id()::text||'/sha256/77/'||repeat('7',64),'image/png',8,'CLEAN',now()-interval '8 days',now()-interval '9 days');
    INSERT INTO normalized_messages
      (id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
       participant_name,message_text,provider_timestamp,provider_metadata,processing_status,history_captured_at,created_at)
      VALUES
      ('63300000-0000-4000-8000-000000000001',app.current_tenant_id(),'63100000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',
       'workspace-privacy-message','fixture-0012@example.test','12025550120@c.us','Privacy user','held history',now()-interval '9 days',
       '{"media_object_id":"63200000-0000-4000-8000-000000000001"}','COMPLETE',now()-interval '9 days',now()-interval '9 days'),
      ('63300000-0000-4000-8000-000000000002',app.current_tenant_id(),'63100000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001',
       'workspace-user-hold-message','fixture-0013@example.test','12025550121@c.us','Held user','held user history',now()-interval '9 days',
       '{"media_object_id":"63200000-0000-4000-8000-000000000004","zammad_customer_id":"777"}','COMPLETE',now()-interval '9 days',now()-interval '9 days');
    INSERT INTO case_correlations
      (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,created_at,updated_at)
      VALUES
      (app.current_tenant_id(),'15000000-0000-4000-8000-000000000001','HELD-SHARED-6361','6361','6361','RESOLVED',now()-interval '40 days',now()-interval '40 days'),
      (app.current_tenant_id(),'15200000-0000-4000-8000-000000000001','UNHELD-SHARED-6361','6361','6361','RESOLVED',now()-interval '40 days',now()-interval '40 days');
    INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,delivery_origin,created_at,updated_at)
      VALUES ('63600000-0000-4000-8000-000000000001',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','6361','6361','Held binding media','image/png','privacy-binding-media','SENT','TICKET',now()-interval '9 days',now()-interval '9 days');
    INSERT INTO delivery_media
      (id,tenant_id,delivery_id,zammad_attachment_id,filename,mime_type,byte_size,state,media_object_id,created_at,updated_at)
      VALUES ('63700000-0000-4000-8000-000000000001',app.current_tenant_id(),'63600000-0000-4000-8000-000000000001',6361,'held.png','image/png',8,'READY','63200000-0000-4000-8000-000000000002',now()-interval '9 days',now()-interval '9 days');
    INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,delivery_origin,created_at,updated_at)
      VALUES ('63600000-0000-4000-8000-000000000002',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','13200000-0000-4000-8000-000000000001','Terminal ticketless media','image/png','privacy-ticketless-media','SENT','GROUP_WORKSPACE',now()-interval '9 days',now()-interval '9 days');
    INSERT INTO delivery_media
      (id,tenant_id,delivery_id,zammad_attachment_id,filename,mime_type,byte_size,state,media_object_id,created_at,updated_at)
      VALUES ('63700000-0000-4000-8000-000000000002',app.current_tenant_id(),'63600000-0000-4000-8000-000000000002',6362,'ticketless.png','image/png',8,'READY','63200000-0000-4000-8000-000000000003',now()-interval '9 days',now()-interval '9 days');
    INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,delivery_origin,created_at,updated_at)
      VALUES ('63600000-0000-4000-8000-000000000003',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','15200000-0000-4000-8000-000000000001','6362','6362','Retry freeze proof','text/plain','privacy-retry-freeze','SENT','TICKET',now()-interval '40 days',now()-interval '40 days')`));
  await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO participant_identities
      (tenant_id,connection_id,external_participant_id,display_name,normalized_phone)
    VALUES
      (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','12025550120@c.us','Privacy user','12025550120'),
      (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','12025550119@c.us','Delete subject','12025550119')
    ON CONFLICT (connection_id,external_participant_id) DO UPDATE
      SET display_name=EXCLUDED.display_name,normalized_phone=EXCLUDED.normalized_phone;
    INSERT INTO group_workspace_participants
      (tenant_id,whatsapp_group_id,external_participant_id,display_name,normalized_phone)
    VALUES
      (app.current_tenant_id(),'13100000-0000-4000-8000-000000000001','12025550120@c.us','Privacy user','+12025550120'),
      (app.current_tenant_id(),'13100000-0000-4000-8000-000000000001','12025550119@c.us','Delete subject','+12025550119')`));
  await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`INSERT INTO group_workspace_participants
      (tenant_id,whatsapp_group_id,external_participant_id,display_name,normalized_phone)
    VALUES (app.current_tenant_id(),'25000000-0000-4000-8000-000000000002','12025550120@c.us','Tenant B privacy user','+12025550120')`));
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT count(*)::integer AS count FROM group_workspace_participants WHERE external_participant_id='12025550120@c.us'",
  ))).rows[0].count,1);
  await assert.rejects(()=>tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO group_workspace_participants
    (tenant_id,whatsapp_group_id,external_participant_id)
    VALUES ('20000000-0000-4000-8000-000000000002','25000000-0000-4000-8000-000000000002','12025550122@c.us')`)),error=>error.code==="42501");
  const privacyControlDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const privacyControlDatabase=new DatabaseService();let privacyWakeCount=0;let workspaceHoldId;let bindingGroupHoldId;let zammadUserHoldId;
  const privacyControl=new PrivacyController(privacyControlDatabase,{wakePrivacy:async()=>{privacyWakeCount+=1}},{},{privacyTarget:async(_request,input)=>{
    assert.equal(input.scope_type,"ZAMMAD_USER");assert(["customer77@example.test","customer777@example.test"].includes(input.reference));
    return {scope_type:"ZAMMAD_USER",scope_value:input.reference==="customer77@example.test"?"77":"777",display:"Synthetic customer",selection_sha256:"a".repeat(64)};
  }});
  try{
    const request={id:"postgres-zammad-user-export",principal:{...botPrincipal,authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
    const created=await privacyControl.createRequest(request,"postgres-zammad-user-export",{requestType:"EXPORT",scopeType:"ZAMMAD_USER",scopeValue:"customer77@example.test",selection_sha256:"a".repeat(64)});
    const replayed=await privacyControl.createRequest({...request,id:"postgres-zammad-user-export-replay"},"postgres-zammad-user-export",{requestType:"EXPORT",scopeType:"ZAMMAD_USER",scopeValue:"customer77@example.test",selection_sha256:"a".repeat(64)});
    assert.equal(replayed.id,created.id);assert.equal(replayed.duplicate,true);assert.equal(privacyWakeCount,2);
    assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query("SELECT request_type,scope_type,disposition,state FROM privacy_requests WHERE id=$1",[created.id]))).rows,[{request_type:"EXPORT",scope_type:"ZAMMAD_USER",disposition:"EXPORT_ONLY",state:"QUEUED"}]);
    await assert.rejects(
      ()=>privacyControl.createHold({...request,id:"postgres-invalid-binding-hold"},{scopeType:"GROUP_BINDING",scopeValue:"invalid",reason:"Invalid binding proof"}, "privacy-hold-fixture-1"),
      error=>error?.getStatus?.()===400,
    );
    await assert.rejects(
      ()=>privacyControl.createHold({...request,id:"postgres-foreign-binding-hold"},{scopeType:"GROUP_BINDING",scopeValue:"26000000-0000-4000-8000-000000000002",reason:"Foreign binding proof"}, "privacy-hold-fixture-2"),
      error=>error?.getStatus?.()===404,
    );
    const concurrentIntent={requestType:"EXPORT",scopeType:"ZAMMAD_USER",scopeValue:"customer77@example.test",selection_sha256:"a".repeat(64)};
    const concurrent=await Promise.all([privacyControl.createRequest(request,"postgres-privacy-concurrent",concurrentIntent),privacyControl.createRequest(request,"postgres-privacy-concurrent",concurrentIntent)]);
    assert.equal(concurrent[0].id,concurrent[1].id);
    assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT count(*)::integer count FROM privacy_jobs WHERE request_id=$1",[concurrent[0].id]))).rows[0].count,1);
    const cancelledKey="postgres-privacy-pre-effect-cancel";
    assert.equal((await privacyControl.receipt(request,{operationId:cancelledKey,kind:"EXPORT",action:"LOOKUP"})).state,"UNKNOWN");
    assert.equal((await privacyControl.receipt(request,{operationId:cancelledKey,kind:"EXPORT",action:"CANCEL_IF_UNADMITTED"})).state,"NOT_APPLIED");
    assert.equal((await privacyControl.createRequest(request,cancelledKey,concurrentIntent)).state,"NOT_APPLIED");
    assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT count(*)::integer count FROM privacy_requests WHERE idempotency_key=$1",[cancelledKey]))).rows[0].count,0);
    const bindingHold=await privacyControl.createHold({...request,id:"postgres-binding-hold"},{scopeType:"GROUP_BINDING",scopeValue:"15000000-0000-4000-8000-000000000001",reason:"Bound group proof"}, "privacy-hold-fixture-3");
    await privacyControl.releaseHold({...request,id:"postgres-binding-hold-release"},bindingHold.id);
    await tenant(botPrincipal.tenantId,async()=>{
      await app.query(`INSERT INTO whatsapp_groups
        (id,tenant_id,connection_id,external_group_id,display_name)
        VALUES ('13a00000-0000-4000-8000-000000000001',app.current_tenant_id(),
          '12000000-0000-4000-8000-000000000001','fixture-0014@example.test','Uppercase hold proof')`);
      await app.query(`INSERT INTO group_workspace_settings
        (tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by)
        VALUES (app.current_tenant_id(),'13a00000-0000-4000-8000-000000000001',true,now(),30,'RESTRICTED',$1)`,[botPrincipal.userId]);
      await app.query(`INSERT INTO group_bindings
        (id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,
         acknowledgement_template,agent_prefix,retention_days,state)
        VALUES ('15a00000-0000-4000-8000-000000000001',app.current_tenant_id(),
          '13a00000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001',
          'Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'ACTIVE')`);
      await app.query(`INSERT INTO case_correlations
        (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state)
        VALUES (app.current_tenant_id(),'15a00000-0000-4000-8000-000000000001',
          'UPPERCASE-HOLD-6364','6364','6364','RESOLVED')`);
    });
    const uppercaseWorkspaceHold=await privacyControl.createHold(
      {...request,id:"postgres-uppercase-workspace-hold"},
      {scopeType:"WHATSAPP_GROUP",scopeValue:"13A00000-0000-4000-8000-000000000001",reason:"Canonical workspace UUID proof"}, "privacy-hold-fixture-4");
    assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(
      "SELECT scope_value,app.has_applicable_privacy_hold('ZAMMAD_TICKET','6364') AS held FROM privacy_legal_holds WHERE id=$1",
      [uppercaseWorkspaceHold.id],
    ))).rows,[{scope_value:"13a00000-0000-4000-8000-000000000001",held:true}]);
    await privacyControl.releaseHold({...request,id:"postgres-uppercase-workspace-release"},uppercaseWorkspaceHold.id);
    const uppercaseBindingHold=await privacyControl.createHold(
      {...request,id:"postgres-uppercase-binding-hold"},
      {scopeType:"GROUP_BINDING",scopeValue:"15A00000-0000-4000-8000-000000000001",reason:"Canonical binding UUID proof"}, "privacy-hold-fixture-5");
    assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(
      "SELECT scope_value,app.has_applicable_privacy_hold('ZAMMAD_TICKET','6364') AS held FROM privacy_legal_holds WHERE id=$1",
      [uppercaseBindingHold.id],
    ))).rows,[{scope_value:"15a00000-0000-4000-8000-000000000001",held:true}]);
    await privacyControl.releaseHold({...request,id:"postgres-uppercase-binding-release"},uppercaseBindingHold.id);
    await assert.rejects(
      ()=>tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO privacy_legal_holds
        (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
        VALUES (app.current_tenant_id(),'GROUP_BINDING','15A00000-0000-4000-8000-000000000001',
          repeat('f',64),'Database canonical UUID proof',$1)`,[botPrincipal.userId])),
      error=>error.code==="23514"&&error.constraint==="privacy_legal_holds_group_uuid_canonical_check",
    );
    const workspaceHold=await privacyControl.createHold({...request,id:"postgres-workspace-hold"},{scopeType:"WHATSAPP_GROUP",scopeValue:"13100000-0000-4000-8000-000000000001",reason:"Workspace history proof"}, "privacy-hold-fixture-6");
    workspaceHoldId=workspaceHold.id;
    const bindingGroupHold=await privacyControl.createHold({...request,id:"postgres-binding-group-hold"},{scopeType:"WHATSAPP_GROUP",scopeValue:"13000000-0000-4000-8000-000000000001",reason:"Binding-routed media proof"}, "privacy-hold-fixture-7");
    bindingGroupHoldId=bindingGroupHold.id;
    const zammadUserHold=await privacyControl.createHold({...request,id:"postgres-zammad-user-hold"},{scopeType:"ZAMMAD_USER",scopeValue:"customer777@example.test",selection_sha256:"a".repeat(64),reason:"Zammad user retention proof"}, "privacy-hold-fixture-8");
    zammadUserHoldId=zammadUserHold.id;
    assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
      "SELECT count(*)::integer AS count FROM audit_events WHERE action='privacy.legal_hold_created' AND target_id=$1",
      [workspaceHoldId],
    ))).rows[0].count,1);
  }finally{await privacyControlDatabase.onModuleDestroy();if(privacyControlDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=privacyControlDatabaseUrl}
  const openBotMediaObjectId="64600000-0000-4000-8000-000000000001";
  const openBotMediaAssetId="64700000-0000-4000-8000-000000000001";
  const activeBotMediaObjectId="64600000-0000-4000-8000-000000000002";
  const activeBotMediaAssetId="64700000-0000-4000-8000-000000000002";
  const raceBotMediaObjectId="64600000-0000-4000-8000-000000000003";
  const raceBotMediaAssetId="64700000-0000-4000-8000-000000000003";
  const freshBotMediaObjectId="64600000-0000-4000-8000-000000000004";
  const freshBotMediaAssetId="64700000-0000-4000-8000-000000000004";
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT bot_media_asset_count_limit,bot_media_asset_bytes_limit::text FROM tenant_settings WHERE tenant_id=app.current_tenant_id()",
  ))).rows,[{bot_media_asset_count_limit:200,bot_media_asset_bytes_limit:"1000000000"}]);
  const readyBotMediaAsset=async(tenantId,{mediaId,assetId,digest,createdBy,expired=false})=>tenant(tenantId,async()=>{
    await app.query(`INSERT INTO media_objects
      (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at)
      VALUES ($1,app.current_tenant_id(),$2,$3,'image/png',8,'CLEAN',
        CASE WHEN $4::boolean THEN now()-interval '1 day' ELSE now()+interval '1 day' END,
        now()-interval '2 days')`,[mediaId,digest,`${tenantId}/sha256/${digest.slice(0,2)}/${digest}`,expired]);
    await app.query(`INSERT INTO bot_media_assets
      (id,tenant_id,filename,mime_type,byte_size,declared_sha256,idempotency_key,request_sha256,created_by,created_at)
      VALUES ($1,app.current_tenant_id(),$2,'image/png',8,$3,$4,$5,$6,now()-interval '2 days')`,[
      assetId,`${assetId}.png`,digest,assetId,createHash("sha256").update(`request:${assetId}`).digest("hex"),createdBy,
    ]);
    await app.query(`UPDATE bot_media_assets SET state='READY',media_object_id=$2,content_sha256=$3,updated_at=now()
      WHERE tenant_id=app.current_tenant_id() AND id=$1`,[assetId,mediaId,digest]);
  });
  await readyBotMediaAsset(botPrincipal.tenantId,{mediaId:openBotMediaObjectId,assetId:openBotMediaAssetId,digest:"c".repeat(64),createdBy:botPrincipal.userId,expired:true});
  await readyBotMediaAsset(botPrincipal.tenantId,{mediaId:activeBotMediaObjectId,assetId:activeBotMediaAssetId,digest:"d".repeat(64),createdBy:botPrincipal.userId});
  await readyBotMediaAsset(botPrincipal.tenantId,{mediaId:raceBotMediaObjectId,assetId:raceBotMediaAssetId,digest:"e".repeat(64),createdBy:botPrincipal.userId});
  const freshOwnerId=(await tenant(freshTenantId,()=>app.query(
    "SELECT user_id FROM tenant_memberships WHERE tenant_id=app.current_tenant_id() AND state='ACTIVE' ORDER BY created_at LIMIT 1",
  ))).rows[0].user_id;
  await readyBotMediaAsset(freshTenantId,{mediaId:freshBotMediaObjectId,assetId:freshBotMediaAssetId,digest:"f".repeat(64),createdBy:freshOwnerId,expired:true});
  await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO bot_flow_media_asset_pins
    (tenant_id,bot_flow_version_id,bot_media_asset_id)
    VALUES (app.current_tenant_id(),$1,$2)`,[botV1.id,openBotMediaAssetId]));
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT state,media_object_id,content_sha256 FROM bot_media_assets WHERE id=$1",
    [openBotMediaAssetId],
  ))).rows,[{state:"READY",media_object_id:openBotMediaObjectId,content_sha256:"c".repeat(64)}]);
  await assert.rejects(
    ()=>tenant(botPrincipal.tenantId,()=>app.query("UPDATE bot_media_assets SET filename='changed.png' WHERE id=$1",[openBotMediaAssetId])),
    error=>error.code==="55000",
  );
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT count(*)::integer AS count FROM bot_media_assets WHERE id=$1",
    [openBotMediaAssetId],
  ))).rows[0].count,0);
  const tenantBMediaFamily=(await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT app.create_bot_flow_family('Cross-tenant media proof',$1) AS id",
    ["20200000-0000-4000-8000-000000000002"],
  ))).rows[0].id;
  const tenantBMediaFlow=(await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)",
    [tenantBMediaFamily,{schemaVersion:1,name:"Cross-tenant media proof",start:"done",maxSteps:1,nodes:[{id:"done",type:"end"}]},"20200000-0000-4000-8000-000000000002"],
  ))).rows[0];
  await assert.rejects(
    ()=>tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`INSERT INTO bot_flow_media_asset_pins
      (tenant_id,bot_flow_version_id,bot_media_asset_id)
      VALUES (app.current_tenant_id(),$1,$2)`,[tenantBMediaFlow.id,openBotMediaAssetId])),
    error=>error.code==="23503",
  );

  const mediaFlowDefinition=(name,assetId)=>({schemaVersion:1,name,start:"media",maxSteps:5,nodes:[
    {id:"media",type:"send_media",assetId,caption:"Media proof",next:"done"},{id:"done",type:"end"},
  ]});
  const createPinnedMediaFlow=async(name,assetId)=>tenant(botPrincipal.tenantId,async()=>{
    const family=(await app.query("SELECT app.create_bot_flow_family($1,$2) AS id",[name,botPrincipal.userId])).rows[0].id;
    const definition=mediaFlowDefinition(name,assetId);
    const version=(await app.query("SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)",[family,definition,botPrincipal.userId])).rows[0];
    await app.query(`INSERT INTO bot_flow_media_asset_pins (tenant_id,bot_flow_version_id,bot_media_asset_id)
      VALUES (app.current_tenant_id(),$1,$2)`,[version.id,assetId]);
    return{family,definition,version:{...version,revision:Number(version.revision)}};
  });
  const expiredMediaFlow=await createPinnedMediaFlow("Expired media activation proof",openBotMediaAssetId);
  const activeMediaFlow=await createPinnedMediaFlow("Active media assignment proof",activeBotMediaAssetId);
  const raceMediaFlow=await createPinnedMediaFlow("Privacy activation fence proof",raceBotMediaAssetId);
  const mediaDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const mediaDatabase=new DatabaseService();const mediaBotControl=new BotFlowsService(mediaDatabase,{wake:async()=>{},issueMediaUploadToken:async()=>"test-upload-token"});
  try{
    const uploadKey="64700000-0000-4000-8000-000000000099";
    const uploadInput={filename:"quota-proof.png",mimeType:"image/png",byteSize:8,contentSha256:"9".repeat(64)};
    const [reserved,concurrentReservation]=await Promise.all([
      mediaBotControl.createMediaAsset(botPrincipal,uploadKey,"postgres-media-reservation",uploadInput),
      mediaBotControl.createMediaAsset(botPrincipal,uploadKey,"postgres-media-reservation-concurrent",uploadInput),
    ]);
    assert.equal(reserved.state,"UPLOADING");
    assert.equal(concurrentReservation.id,reserved.id);
    assert.equal((await mediaBotControl.createMediaAsset(botPrincipal,uploadKey,"postgres-media-reservation-replay",uploadInput)).id,reserved.id);
    assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT count(*)::integer AS count FROM bot_media_assets WHERE idempotency_key=$1",[uploadKey]))).rows[0].count,1);
    const uploadRepository=new InboundRepository(new Pool(connectorWorkerConfig));
    try{await uploadRepository.failMediaAssetUpload(botPrincipal.tenantId,reserved.id,"Isolated reservation test completed without uploading");}
    finally{await uploadRepository.close();}
    await assert.rejects(()=>tenant(botPrincipal.tenantId,()=>app.query("UPDATE tenant_settings SET bot_media_asset_count_limit=5000 WHERE tenant_id=app.current_tenant_id()")),error=>error.code==="42501");
    await tenant(botPrincipal.tenantId,async()=>{
      await app.query("SAVEPOINT native_close_proof");
      try{
        const instance=(await app.query("SELECT id FROM zammad_instances WHERE tenant_id=app.current_tenant_id() AND state='WORKING'")).rows[0];
        const conversation=(await app.query(`INSERT INTO bot_conversations
          (tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,
           zammad_ticket_id,zammad_ticket_number,last_activity_at,created_at,updated_at)
          SELECT tenant_id,assignment_id,connection_id,flow_version_id,'native-close-proof','BOT-ABCDEF123456','HUMAN',current_node_id,
            '960004','960004',now()-interval '2 minutes',now()-interval '2 minutes',now()-interval '2 minutes'
          FROM bot_conversations WHERE id=$1 RETURNING id`,[botConversation.id])).rows[0];
        const controller=new ZammadTicketStateController({
          rows:async(_tenant,sql,values)=>(await app.query(sql,values)).rows,
          withTenant:async(_tenant,callback)=>callback(app),
        },{verify:async()=>({tenantId:botPrincipal.tenantId,instanceId:instance.id})});
        const transitionTime=new Date(Date.now()-1000).toISOString();
        const close={tenant_id:botPrincipal.tenantId,ticket_id:'960004',ticket_number:'960004',state_id:4,state_name:'closed',state_type_name:'closed',transitioned_at:transitionTime,idempotency_key:'native-close-proof'};
        assert.equal((await controller.ticketState(undefined,close.idempotency_key,'native-close-proof',close)).state,'APPLIED');
        assert.deepEqual((await app.query("SELECT state,resolution_kind,fencing_token::integer FROM bot_conversations WHERE id=$1",[conversation.id])).rows,[{state:'RESOLVED',resolution_kind:'OPERATOR',fencing_token:1}]);
        assert.equal((await controller.ticketState(undefined,close.idempotency_key,'native-close-replay',close)).duplicate,true);
        assert.equal((await app.query("SELECT count(*)::integer AS count FROM bot_conversation_events WHERE conversation_id=$1 AND event_kind='RESOLVED'",[conversation.id])).rows[0].count,1);
        await app.query("UPDATE bot_conversations SET state='HUMAN',resolved_at=NULL,resolution_kind=NULL,updated_at=now()-interval '2 minutes' WHERE id=$1",[conversation.id]);
        const reopen={...close,state_id:2,state_name:'open',state_type_name:'open',transitioned_at:new Date().toISOString(),idempotency_key:'native-reopen-proof'};
        await controller.ticketState(undefined,reopen.idempotency_key,'native-reopen-proof',reopen);
        const lateClose={...close,idempotency_key:'native-late-close-proof'};
        assert.equal((await controller.ticketState(undefined,lateClose.idempotency_key,'native-late-close-proof',lateClose)).state,'IGNORED_STALE');
        assert.equal((await app.query("SELECT state FROM bot_conversations WHERE id=$1",[conversation.id])).rows[0].state,'HUMAN');
        const pending=(await app.query(`INSERT INTO delivery_outbox
          (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
           message_body,content_type,idempotency_key,state,direct_origin)
          SELECT tenant_id,connection_id,id,external_chat_id,zammad_ticket_id,'native-close-unknown',
            'Unknown outcome proof','text/plain','native-close-unknown','OUTCOME_UNKNOWN','HUMAN'
          FROM bot_conversations WHERE id=$1 RETURNING id`,[conversation.id])).rows[0];
        const blockedClose={...close,transitioned_at:new Date(Date.now()+1000).toISOString(),idempotency_key:'native-close-blocked-proof'};
        assert.equal((await controller.ticketState(undefined,blockedClose.idempotency_key,'native-close-blocked',blockedClose)).state,'BLOCKED_EFFECTS');
        assert.deepEqual((await app.query("SELECT state,fencing_token::integer FROM bot_conversations WHERE id=$1",[conversation.id])).rows,[{state:'HUMAN',fencing_token:1}]);
        assert.equal((await app.query("SELECT state FROM delivery_outbox WHERE id=$1",[pending.id])).rows[0].state,'OUTCOME_UNKNOWN');
        assert.equal((await controller.ticketState(undefined,blockedClose.idempotency_key,'native-close-still-unknown',blockedClose)).state,'BLOCKED_EFFECTS');
        // Isolated test readback establishes completion; the native close itself must never infer it.
        await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='native-close-observed' WHERE id=$1",[pending.id]);
        const recovered=await controller.ticketState(undefined,blockedClose.idempotency_key,'native-close-settled-retry',blockedClose);
        assert.equal(recovered.state,'APPLIED');
        assert.equal(recovered.duplicate,true);
        assert.deepEqual(await controller.ticketState(undefined,blockedClose.idempotency_key,'native-close-applied-replay',blockedClose),recovered);
        assert.deepEqual((await app.query("SELECT state,fencing_token::integer FROM bot_conversations WHERE id=$1",[conversation.id])).rows,[{state:'RESOLVED',fencing_token:2}]);
        assert.equal((await app.query("SELECT count(*)::integer AS count FROM bot_conversation_events WHERE conversation_id=$1 AND safe_metadata->>'ticket_state_event_id'=$2",[conversation.id,recovered.id])).rows[0].count,1);
      }finally{await app.query("ROLLBACK TO SAVEPOINT native_close_proof")}
    });
    const closeRace=await tenant(botPrincipal.tenantId,async()=>{
      const instance=(await app.query("SELECT id FROM zammad_instances WHERE tenant_id=app.current_tenant_id() AND state='WORKING'")).rows[0];
      const conversation=(await app.query(`INSERT INTO bot_conversations
        (tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,
         zammad_ticket_id,zammad_ticket_number,last_activity_at,created_at,updated_at)
        SELECT tenant_id,assignment_id,connection_id,flow_version_id,'native-close-race','BOT-ABCDEF123457','HUMAN',current_node_id,
          '960005','960005',now()-interval '2 minutes',now()-interval '2 minutes',now()-interval '2 minutes'
        FROM bot_conversations WHERE id=$1 RETURNING id`,[botConversation.id])).rows[0];
      return{instance,conversation};
    });
    const agentEnqueue=new Client({connectionString:appUrl});
    const nativeClose=new Client({connectionString:appUrl});
    await Promise.all([agentEnqueue.connect(),nativeClose.connect()]);
    let closing;
    try{
      await agentEnqueue.query("BEGIN");
      await agentEnqueue.query("SELECT set_config('app.tenant_id',$1,true)",[botPrincipal.tenantId]);
      // Same state predicate and shared conversation lock as native agent enqueue.
      assert.equal((await agentEnqueue.query("SELECT id FROM bot_conversations WHERE id=$1 AND state='HUMAN' FOR SHARE",[closeRace.conversation.id])).rowCount,1);
      const controller=new ZammadTicketStateController({withTenant:async(tenantId,callback)=>{
        await nativeClose.query("BEGIN");
        try{await nativeClose.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const result=await callback(nativeClose);await nativeClose.query("COMMIT");return result}
        catch(error){await nativeClose.query("ROLLBACK");throw error}
      }},{verify:async()=>({tenantId:botPrincipal.tenantId,instanceId:closeRace.instance.id})});
      const body={tenant_id:botPrincipal.tenantId,ticket_id:'960005',state_id:4,state_name:'closed',state_type_name:'closed',transitioned_at:new Date().toISOString(),idempotency_key:'native-close-race'};
      closing=controller.ticketState(undefined,body.idempotency_key,'native-close-race',body);
      let blocked=false;
      for(let attempt=0;attempt<200&&!blocked;attempt++){
        blocked=(await agentEnqueue.query("SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked",[agentEnqueue.processID,nativeClose.processID])).rows[0].blocked;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,"native close must wait for the admitted agent enqueue");
      await agentEnqueue.query(`INSERT INTO delivery_outbox
        (tenant_id,connection_id,bot_conversation_id,external_chat_id,zammad_ticket_id,zammad_article_id,
         message_body,content_type,idempotency_key,state,direct_origin)
        SELECT tenant_id,connection_id,id,external_chat_id,zammad_ticket_id,'native-close-race',
          'Admitted agent reply','text/plain','native-close-race','QUEUED','HUMAN'
        FROM bot_conversations WHERE id=$1`,[closeRace.conversation.id]);
      await agentEnqueue.query("COMMIT");
      assert.equal((await closing).state,'BLOCKED_EFFECTS');
      assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state FROM bot_conversations WHERE id=$1",[closeRace.conversation.id]))).rows[0].state,'HUMAN');
      const beforeSettlement=(await tenant(botPrincipal.tenantId,()=>app.query("SELECT created_at,last_activity_at,updated_at FROM bot_conversations WHERE id=$1",[closeRace.conversation.id]))).rows[0];
      await tenant(botPrincipal.tenantId,()=>app.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=false WHERE bot_conversation_id=$1",[closeRace.conversation.id]));
      assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query("SELECT created_at,last_activity_at,updated_at FROM bot_conversations WHERE id=$1",[closeRace.conversation.id]))).rows[0],beforeSettlement);
      assert.equal((await controller.ticketState(undefined,body.idempotency_key,'native-close-race-settled',body)).state,'APPLIED');
      assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state FROM bot_conversations WHERE id=$1",[closeRace.conversation.id]))).rows[0].state,'RESOLVED');
    }finally{
      await agentEnqueue.query("ROLLBACK").catch(()=>{});
      await closing?.catch(()=>{});
      await Promise.all([agentEnqueue.end(),nativeClose.end()]);
    }
    await assert.rejects(
      ()=>mediaBotControl.activate(botPrincipal,expiredMediaFlow.version.id,"postgres-expired-media-activate","postgres-expired-media-activate",{expectedRevision:expiredMediaFlow.version.revision,expectedActiveFlowVersionId:null}),
      error=>/selected media file is unavailable/i.test(error?.message),
    );
    const activeMedia=await mediaBotControl.activate(botPrincipal,activeMediaFlow.version.id,"postgres-active-media-activate","postgres-active-media-activate",{expectedRevision:activeMediaFlow.version.revision,expectedActiveFlowVersionId:null});
    assert.equal(activeMedia.flowVersionId,activeMediaFlow.version.id);
    await tenant(botPrincipal.tenantId,()=>app.query("UPDATE media_objects SET expires_at=now()-interval '1 minute' WHERE id=$1",[activeBotMediaObjectId]));
    const mediaAssignmentConnectionId="12900000-0000-4000-8000-000000000099";
    await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO connections
      (id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES ($1,app.current_tenant_id(),'Media assignment proof','WAHA','GOWS','WORKING','secret://a/media-assignment-proof')`,[mediaAssignmentConnectionId]));
    try{
      const activeExpiredAssignment=await mediaBotControl.assign(botPrincipal,"postgres-active-expired-media-assign","postgres-active-expired-media-assign",{
        connectionId:mediaAssignmentConnectionId,familyId:activeMediaFlow.family,zammadGroupId:"2",
      });
      assert.equal(activeExpiredAssignment.flowVersionId,activeMediaFlow.version.id);
    }finally{
      await tenant(botPrincipal.tenantId,()=>app.query("DELETE FROM connections WHERE tenant_id=app.current_tenant_id() AND id=$1",[mediaAssignmentConnectionId]));
    }

    const privacyLock=new Client({connectionString:appUrl});await privacyLock.connect();
    try{
      await privacyLock.query("BEGIN");
      await privacyLock.query("SELECT set_config('app.tenant_id',$1,true)",[botPrincipal.tenantId]);
      await privacyLock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${botPrincipal.tenantId}`]);
      await privacyLock.query("UPDATE bot_media_assets SET state='PURGE_PENDING',updated_at=now() WHERE tenant_id=$1 AND id=$2",[botPrincipal.tenantId,raceBotMediaAssetId]);
      let activationSettled=false;
      const racedActivation=mediaBotControl.activate(botPrincipal,raceMediaFlow.version.id,"postgres-raced-media-activate","postgres-raced-media-activate",{expectedRevision:raceMediaFlow.version.revision,expectedActiveFlowVersionId:null})
        .finally(()=>{activationSettled=true});
      await new Promise(resolve=>setTimeout(resolve,40));
      assert.equal(activationSettled,false);
      await privacyLock.query("COMMIT");
      await assert.rejects(()=>racedActivation,error=>/selected media file is unavailable/i.test(error?.message));
      assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state FROM bot_media_assets WHERE id=$1",[raceBotMediaAssetId]))).rows[0].state,"PURGE_PENDING");
    }finally{await privacyLock.query("ROLLBACK").catch(()=>{});await privacyLock.end()}
  }finally{await mediaDatabase.onModuleDestroy();if(mediaDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=mediaDatabaseUrl}

  const privacyRepository=new PrivacyRepository(new Pool({...connectorWorkerConfig,max:2}));
  const privacyJob=(id,tenantId,leaseId,jobType,scopeType,scopeValue,stage="DISCOVER")=>({
    id,tenantId,jobType,scopeType,scopeValue,disposition:jobType==="EXPORT"?"EXPORT_ONLY":jobType==="RETENTION_SWEEP"?"RETENTION_DELETE":"DELETE_TICKETS",
    state:"RUNNING",stage,attempts:1,maxAttempts:25,fencingToken:1,
    zammadBaseUrl:tenantId.startsWith("1000")?"https://a.invalid":"https://b.invalid",
    zammadPrivacySecretReference:`secret://tenants/${tenantId}/zammad/privacy`,
    unmatchedDiagnosticHours:24,exportTtlHours:24,leaseId,createdAt:new Date().toISOString().replace(/Z$/u,"000Z"),
  });
  const insertPrivacyJob=job=>tenant(job.tenantId,()=>app.query(`INSERT INTO privacy_jobs
    (id,tenant_id,request_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,
     lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot,created_at)
    VALUES ($1,app.current_tenant_id(),$2,$3,$4,$5,$6,$7,'RUNNING',$8,1,$9,now()+interval '10 minutes',1,
            CASE WHEN $3='RETENTION_SWEEP' THEN $10::integer ELSE NULL END,$11::timestamptz)`,[
    job.id,job.requestId??null,job.jobType,job.scopeType,job.scopeValue,job.disposition,`postgres-${job.id}`,job.stage,job.leaseId,job.unmatchedDiagnosticHours,job.createdAt,
  ]));
  const privacyTargetSnapshot=job=>tenant(job.tenantId,async()=>
    (await app.query(`SELECT target_type AS type,target_id AS "targetId",state,attempts
      FROM privacy_job_targets WHERE job_id=$1 ORDER BY target_type,target_id`,[job.id])).rows);
  const uploadRaceAssetId="64700000-0000-4000-8000-000000000090";
  const uploadRaceJobId="63400000-0000-4000-8000-000000000089";
  const uploadRaceLease="63500000-0000-4000-8000-000000000089";
  const uploadWriter=new Client({connectionString:appUrl});
  const privacyAdmission=new Client({connectionString:appUrl});
  await Promise.all([uploadWriter.connect(),privacyAdmission.connect()]);
  let uploadRaceJob;
  try{
    await uploadWriter.query("BEGIN");
    await uploadWriter.query("SELECT set_config('app.tenant_id',$1,true)",[freshTenantId]);
    await uploadWriter.query(`INSERT INTO bot_media_assets
      (id,tenant_id,filename,mime_type,byte_size,declared_sha256,idempotency_key,request_sha256,created_by,upload_expires_at)
      VALUES ($1,app.current_tenant_id(),'privacy-upload-race.png','image/png',8,$2,$3,$4,$5,clock_timestamp()-interval '1 second')`,[
      uploadRaceAssetId,"6".repeat(64),uploadRaceAssetId,"5".repeat(64),freshOwnerId,
    ]);
    let admissionSettled=false;
    const admission=(async()=>{
      await privacyAdmission.query("BEGIN");
      await privacyAdmission.query("SELECT set_config('app.tenant_id',$1,true)",[freshTenantId]);
      await privacyAdmission.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${freshTenantId}`]);
      const row=(await privacyAdmission.query(`INSERT INTO privacy_jobs
        (id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,attempts,
         lease_id,lease_expires_at,fencing_token,created_at)
        VALUES ($1,app.current_tenant_id(),'DELETE','PARTICIPANT','privacy-upload-race','DELETE_TICKETS',$2,
          'RUNNING','DISCOVER',1,$3,now()+interval '10 minutes',1,clock_timestamp())
        RETURNING to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,[
        uploadRaceJobId,`postgres-${uploadRaceJobId}`,uploadRaceLease,
      ])).rows[0];
      await privacyAdmission.query("COMMIT");
      return row;
    })().finally(()=>{admissionSettled=true});
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(admissionSettled,false);
    await uploadWriter.query("COMMIT");
    const admitted=await admission;
    uploadRaceJob=privacyJob(uploadRaceJobId,freshTenantId,uploadRaceLease,"DELETE","PARTICIPANT","privacy-upload-race");
    uploadRaceJob.createdAt=String(admitted.created_at);
    assert.equal((await tenant(freshTenantId,()=>app.query(`SELECT created_at<=$2::timestamptz AS pre_cutoff
      FROM bot_media_assets WHERE id=$1`,[uploadRaceAssetId,uploadRaceJob.createdAt]))).rows[0].pre_cutoff,true);
    await privacyRepository.discover(uploadRaceJob,uploadRaceLease);
    assert.deepEqual((await tenant(freshTenantId,()=>app.query(
      "SELECT state,filename,request_sha256,declared_sha256,safe_error FROM bot_media_assets WHERE id=$1",[uploadRaceAssetId],
    ))).rows,[{state:"FAILED",filename:"[removed]",request_sha256:null,declared_sha256:null,safe_error:"Media upload expired before completion."}]);
    assert.deepEqual((await tenant(freshTenantId,()=>app.query(
      "SELECT new_value->>'result_code' AS result_code FROM audit_events WHERE action='bot_media_asset.upload_expired' AND target_id=$1",[uploadRaceAssetId],
    ))).rows,[{result_code:"UPLOAD_EXPIRED"}]);
    await tenant(freshTenantId,()=>app.query(`UPDATE privacy_jobs
      SET state='SUCCEEDED',stage='DONE',lease_id=NULL,lease_expires_at=NULL,completed_at=now()
      WHERE id=$1`,[uploadRaceJobId]));
  }finally{
    await uploadWriter.query("ROLLBACK").catch(()=>undefined);
    await privacyAdmission.query("ROLLBACK").catch(()=>undefined);
    await Promise.all([uploadWriter.end(),privacyAdmission.end()]);
  }
  const precisionJob=privacyJob(
    "63400000-0000-4000-8000-000000000090",botPrincipal.tenantId,
    "63500000-0000-4000-8000-000000000090","DELETE","TENANT",botPrincipal.tenantId,
  );
  precisionJob.createdAt="2026-09-04T10:11:12.123456Z";
  await insertPrivacyJob(precisionJob);
  await tenant(botPrincipal.tenantId,()=>app.query(`UPDATE privacy_jobs
    SET state='FAILED_RETRYABLE',lease_id=NULL,lease_expires_at=NULL,available_at='-infinity'::timestamptz
    WHERE id=$1`,[precisionJob.id]));
  const precisionLease="63500000-0000-4000-8000-000000000091";
  const claimedPrecisionJob=(await privacyRepository.claim(botPrincipal.tenantId,precisionLease,1))[0];
  assert.equal(claimedPrecisionJob?.id,precisionJob.id);
  assert.equal(claimedPrecisionJob?.createdAt,precisionJob.createdAt);
  const precisionEvents=[
    ["63600000-0000-4000-8000-000000000090","privacy-cutoff-before","2026-09-04T10:11:12.123455Z"],
    ["63600000-0000-4000-8000-000000000091","privacy-cutoff-equal","2026-09-04T10:11:12.123456Z"],
    ["63600000-0000-4000-8000-000000000092","privacy-cutoff-after","2026-09-04T10:11:12.123457Z"],
  ];
  await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at)
    SELECT event.id,app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA',event.provider_id,'message','{}',repeat('9',64),'ACCEPTED',event.received_at
      FROM unnest($1::uuid[],$2::text[],$3::timestamptz[]) AS event(id,provider_id,received_at)`,[
    precisionEvents.map(([id])=>id),precisionEvents.map(([,providerId])=>providerId),precisionEvents.map(([, ,receivedAt])=>receivedAt),
  ]));
  const claimPrecisionEvent=id=>tenant(botPrincipal.tenantId,()=>app.query(`UPDATE event_inbox
    SET status='PROCESSING',lease_id='63700000-0000-4000-8000-000000000090',lease_expires_at=now()+interval '1 minute'
    WHERE id=$1 AND status='ACCEPTED' RETURNING id`,[id]));
  assert.equal((await claimPrecisionEvent(precisionEvents[0][0])).rowCount,1);
  assert.equal((await claimPrecisionEvent(precisionEvents[1][0])).rowCount,1);
  assert.equal((await claimPrecisionEvent(precisionEvents[2][0])).rowCount,0);
  await tenant(botPrincipal.tenantId,async()=>{
    await app.query("UPDATE event_inbox SET status='PROCESSED',processed_at=now(),lease_id=NULL,lease_expires_at=NULL WHERE id=ANY($1::uuid[])",[precisionEvents.slice(0,2).map(([id])=>id)]);
    await app.query(`INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
      VALUES (app.current_tenant_id(),$1,'ZAMMAD_TICKET','precision-target',repeat('8',64))`,[precisionJob.id]);
    await app.query("UPDATE privacy_jobs SET stage='EXTERNAL' WHERE id=$1",[precisionJob.id]);
    await app.query("SAVEPOINT privacy_transition_probe");
    for(const [table,column,id,claim] of [
      ["event_inbox","status",precisionEvents[0][0],"status='PROCESSING',lease_id='63700000-0000-4000-8000-000000000091',lease_expires_at=now()+interval '1 minute'"],
      ["bot_action_jobs","state",claimedBotActions[0].id,"state='RUNNING',completed_at=NULL,lease_id='63700000-0000-4000-8000-000000000091',lease_expires_at=now()+interval '1 minute'"],
      ["bot_handoff_jobs","state",releasedHandoff[0].id,"state='RUNNING',completed_at=NULL,lease_id='63700000-0000-4000-8000-000000000091',lease_expires_at=now()+interval '1 minute'"],
      ["group_action_executions","state",pinnedGroupExecution.id,"state='RUNNING',completed_at=NULL"],
    ]){
      assert.equal((await app.query(`UPDATE ${table} SET ${column}=${column} WHERE id=$1 RETURNING id`,[id])).rowCount,1,`${table} non-claim update`);
      assert.equal((await app.query(`UPDATE ${table} SET ${claim} WHERE id=$1 RETURNING id`,[id])).rowCount,0,`${table} claim fence`);
    }
    await app.query("ROLLBACK TO SAVEPOINT privacy_transition_probe");
    await app.query("RELEASE SAVEPOINT privacy_transition_probe");
    assert.equal((await app.query("UPDATE event_inbox SET status='ACCEPTED',processed_at=NULL WHERE id=$1",[precisionEvents[0][0]])).rowCount,1);
  });
  assert.equal((await claimPrecisionEvent(precisionEvents[0][0])).rowCount,0);
  assert.equal((await claimPrecisionEvent(precisionEvents[2][0])).rowCount,0);
  await assert.rejects(
    tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO privacy_job_targets
      (tenant_id,job_id,target_type,target_id,target_sha256)
      VALUES (app.current_tenant_id(),$1,'ZAMMAD_TICKET','late-target',repeat('7',64))`,[precisionJob.id])),
    error=>error?.code==="23514",
  );
  await assert.rejects(
    tenant(botPrincipal.tenantId,()=>app.query("DELETE FROM privacy_job_targets WHERE job_id=$1",[precisionJob.id])),
    error=>error?.code==="23514",
  );
  await assert.rejects(
    tenant(botPrincipal.tenantId,()=>app.query("UPDATE privacy_job_targets SET target_id='changed-target' WHERE job_id=$1",[precisionJob.id])),
    error=>error?.code==="23514",
  );
  const mutablePrivacyJob=privacyJob(
    "63400000-0000-4000-8000-000000000091",botPrincipal.tenantId,
    "63500000-0000-4000-8000-000000000091","DELETE","PARTICIPANT","privacy-mutable-target",
  );
  await insertPrivacyJob(mutablePrivacyJob);
  await assert.rejects(
    tenant(botPrincipal.tenantId,()=>app.query("UPDATE privacy_job_targets SET job_id=$2 WHERE job_id=$1",[precisionJob.id,mutablePrivacyJob.id])),
    error=>error?.code==="23514",
  );
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT count(*)::integer AS count FROM privacy_job_targets WHERE job_id=$1",[precisionJob.id],
  ))).rows[0].count,0);
  await tenant(botPrincipal.tenantId,()=>app.query(`UPDATE privacy_jobs
    SET state='SUCCEEDED',stage='DONE',lease_id=NULL,lease_expires_at=NULL,completed_at=now()
    WHERE id=ANY($1::uuid[])`,[[precisionJob.id,mutablePrivacyJob.id]]));
  const releasedPrecisionIds=[precisionEvents[0][0],precisionEvents[2][0]];
  for(const id of releasedPrecisionIds)assert.equal((await claimPrecisionEvent(id)).rowCount,1);
  // These inner-repository fixtures bypass the outer processor's completion step.
  const completedFixtureEventIds=["019","001","006","007","004","005","002","003"]
    .map(suffix=>`44000000-0000-4000-8000-000000000${suffix}`);
  await tenant(botPrincipal.tenantId,async()=>{
    assert.equal((await app.query(`UPDATE normalized_messages SET processing_status='COMPLETE'
      WHERE event_inbox_id=ANY($1::uuid[]) AND processing_status='PROCESSING'`,[completedFixtureEventIds])).rowCount,7);
    assert.equal((await app.query(`UPDATE event_inbox SET status='PROCESSED',processed_at=now(),
      lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
      WHERE id=ANY($1::uuid[]) AND status='PROCESSING'`,[completedFixtureEventIds])).rowCount,8);
    assert.equal((await app.query(`UPDATE event_inbox SET status='PROCESSED',processed_at=now(),
      lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,updated_at=now()
      WHERE id=ANY($1::uuid[]) AND status='PROCESSING'`,[releasedPrecisionIds])).rowCount,2);
  });
  const purgeDueIds=["095","099","100","101"].map(suffix=>`64800000-0000-4000-8000-000000000${suffix}`);
  await tenant(botPrincipal.tenantId,async()=>{
    for(const [index,status] of ["UNMATCHED","IGNORED","DUPLICATE","REDACTED"].entries()){
      await app.query(`INSERT INTO event_inbox
        (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
        VALUES ($1,app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA','purge-due-'||$2,'message','{}',repeat('9',64),$2,now()-interval '2 days',now()-interval '2 days')`,[purgeDueIds[index],status]);
    }
    await app.query(`INSERT INTO event_inbox
      (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
      VALUES
      ('64800000-0000-4000-8000-000000000096',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA','purge-recent','message','{}',repeat('9',64),'UNMATCHED',now()-interval '23 hours',now()-interval '23 hours'),
      ('64800000-0000-4000-8000-000000000097',app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA','purge-linked','message','{}',repeat('9',64),'UNMATCHED',now()-interval '2 days',now()-interval '2 days')`);
    await app.query(`INSERT INTO normalized_messages
      (id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
       participant_name,message_text,provider_timestamp,provider_metadata,processing_status,history_captured_at,created_at)
      VALUES ('64900000-0000-4000-8000-000000000097',app.current_tenant_id(),'64800000-0000-4000-8000-000000000097',
        '12000000-0000-4000-8000-000000000001','purge-linked-message','fixture-0012@example.test','12025550120@c.us',
        'Privacy fixture','Linked retention fixture',now()-interval '2 days','{}','COMPLETE',now()-interval '2 days',now()-interval '2 days')`);
  });
  await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`INSERT INTO event_inbox
    (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
    VALUES ('64800000-0000-4000-8000-000000000098',app.current_tenant_id(),'23000000-0000-4000-8000-000000000002',
      'WAHA','purge-other-tenant','message','{}',repeat('9',64),'UNMATCHED',now()-interval '2 days',now()-interval '2 days')`));
  const heldRetention=privacyJob("63400000-0000-4000-8000-000000000001",botPrincipal.tenantId,"63500000-0000-4000-8000-000000000001","RETENTION_SWEEP","TENANT",botPrincipal.tenantId);
  await insertPrivacyJob(heldRetention);
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(
    `SELECT unmatched_diagnostic_hours_snapshot,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM privacy_jobs WHERE id=$1`,
    [heldRetention.id],
  ))).rows.map(row=>({hours:row.unmatched_diagnostic_hours_snapshot,createdAt:String(row.created_at)})),[{hours:24,createdAt:heldRetention.createdAt}]);
  await assert.rejects(
    tenant(botPrincipal.tenantId,()=>app.query(
      "UPDATE privacy_jobs SET unmatched_diagnostic_hours_snapshot=1 WHERE id=$1",
      [heldRetention.id],
    )),
    error=>error?.code==="23514",
  );
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT unmatched_diagnostic_hours_snapshot FROM privacy_jobs WHERE id=$1",
    [heldRetention.id],
  ))).rows[0].unmatched_diagnostic_hours_snapshot,24);
  await privacyRepository.discover(heldRetention,heldRetention.leaseId);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT unmatched_diagnostic_hours_snapshot FROM privacy_jobs WHERE id=$1",
    [heldRetention.id],
  ))).rows[0].unmatched_diagnostic_hours_snapshot,24);
  const heldRetentionTargets=await privacyTargetSnapshot(heldRetention);
  for(const id of ["63300000-0000-4000-8000-000000000001","63300000-0000-4000-8000-000000000002",
    "63200000-0000-4000-8000-000000000001","63200000-0000-4000-8000-000000000002","63200000-0000-4000-8000-000000000004",
    "6361",openBotMediaObjectId,activeBotMediaObjectId])assert.equal(heldRetentionTargets.some(target=>target.targetId===id),false);
  assert.ok(heldRetentionTargets.some(target=>target.type==="MEDIA_OBJECT"&&target.targetId==="63200000-0000-4000-8000-000000000003"));
  for(const target of await privacyRepository.targets(heldRetention)){
    await privacyRepository.beginTargetExternal(heldRetention,heldRetention.leaseId,target);
    await privacyRepository.markTargetExternal(heldRetention,heldRetention.leaseId,target);
  }
  await privacyRepository.finalize(heldRetention,heldRetention.leaseId);
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state,stage FROM privacy_jobs WHERE id=$1",[heldRetention.id]))).rows,[{state:"SUCCEEDED",stage:"DONE"}]);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT count(*)::integer AS count FROM event_inbox WHERE id=ANY($1::uuid[])",[purgeDueIds]))).rows[0].count,0);
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(`SELECT id::text FROM event_inbox
    WHERE id IN ('64800000-0000-4000-8000-000000000096','64800000-0000-4000-8000-000000000097') ORDER BY id`))).rows,
  [{id:"64800000-0000-4000-8000-000000000096"},{id:"64800000-0000-4000-8000-000000000097"}]);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT count(*)::integer AS count FROM normalized_messages WHERE id='64900000-0000-4000-8000-000000000097'"))).rows[0].count,1);
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query("SELECT count(*)::integer AS count FROM event_inbox WHERE id='64800000-0000-4000-8000-000000000098'"))).rows[0].count,1);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state FROM bot_media_assets WHERE id=$1",[openBotMediaAssetId]))).rows[0].state,"READY");
  const tenantDeleteMedia=privacyJob("63400000-0000-4000-8000-000000000004",freshTenantId,"63500000-0000-4000-8000-000000000004","DELETE","TENANT",freshTenantId);
  await insertPrivacyJob(tenantDeleteMedia);
  await privacyRepository.discover(tenantDeleteMedia,tenantDeleteMedia.leaseId);
  const tenantDeleteMediaTargets=await privacyRepository.targets(tenantDeleteMedia);
  assert.equal(tenantDeleteMediaTargets.some(target=>target.type==="MEDIA_OBJECT"&&target.targetId===freshBotMediaObjectId),true);
  assert.equal((await tenant(freshTenantId,()=>app.query("SELECT state FROM bot_media_assets WHERE id=$1",[freshBotMediaAssetId]))).rows[0].state,"PURGE_PENDING");
  for(const target of tenantDeleteMediaTargets){
    await privacyRepository.beginTargetExternal(tenantDeleteMedia,tenantDeleteMedia.leaseId,target);
    await privacyRepository.markTargetExternal(tenantDeleteMedia,tenantDeleteMedia.leaseId,target);
  }
  await privacyRepository.finalize(tenantDeleteMedia,tenantDeleteMedia.leaseId);
  assert.deepEqual((await tenant(freshTenantId,()=>app.query("SELECT state,stage FROM privacy_jobs WHERE id=$1",[tenantDeleteMedia.id]))).rows,[{state:"SUCCEEDED",stage:"DONE"}]);
  assert.equal((await tenant(freshTenantId,()=>app.query("SELECT count(*)::integer AS count FROM media_objects WHERE id=$1",[freshBotMediaObjectId]))).rows[0].count,0);
  assert.deepEqual((await tenant(freshTenantId,()=>app.query(
    "SELECT state,filename,request_sha256,declared_sha256,content_sha256,media_object_id,mime_type,byte_size::integer AS byte_size FROM bot_media_assets WHERE id=$1",
    [freshBotMediaAssetId],
  ))).rows,[{state:"PURGED",filename:"[removed]",request_sha256:null,declared_sha256:null,content_sha256:null,media_object_id:null,mime_type:"image/png",byte_size:8}]);
  await tenant(botPrincipal.tenantId,async()=>{
    await app.query("UPDATE privacy_legal_holds SET state='RELEASED',released_by=$1,released_at=now(),updated_at=now() WHERE id=ANY($2::uuid[])",[botPrincipal.userId,[workspaceHoldId,bindingGroupHoldId,zammadUserHoldId]]);
  });
  const resumedRetention=privacyJob("63400000-0000-4000-8000-000000000002",botPrincipal.tenantId,"63500000-0000-4000-8000-000000000002","RETENTION_SWEEP","TENANT",botPrincipal.tenantId);
  await insertPrivacyJob(resumedRetention);
  await privacyRepository.discover(resumedRetention,resumedRetention.leaseId);
  const unheldTargets=await privacyTargetSnapshot(resumedRetention);
  const frozenUnheldTargets=unheldTargets.map(target=>`${target.type}:${target.targetId}`).sort();
  assert.equal(unheldTargets.some(target=>target.targetId==="63300000-0000-4000-8000-000000000001"),true);
  assert.equal(unheldTargets.some(target=>target.targetId==="63200000-0000-4000-8000-000000000001"),true);
  assert.equal(unheldTargets.some(target=>target.targetId==="63200000-0000-4000-8000-000000000002"),true);
  assert.equal(unheldTargets.some(target=>target.targetId==="63300000-0000-4000-8000-000000000002"),true);
  assert.equal(unheldTargets.some(target=>target.targetId==="63200000-0000-4000-8000-000000000004"),true);
  assert.equal(unheldTargets.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="6361"),true);
  await tenant(botPrincipal.tenantId,async()=>{
    await app.query(`INSERT INTO case_correlations
      (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,created_at,updated_at)
      VALUES (app.current_tenant_id(),'15200000-0000-4000-8000-000000000001','PRIVACY-RETRY-6362','6362','6362','RESOLVED',now()-interval '40 days',now()-interval '40 days')`);
    await app.query("UPDATE delivery_outbox SET state='QUEUED',updated_at=now()-interval '40 days' WHERE id='63600000-0000-4000-8000-000000000003'");
    await app.query("UPDATE privacy_jobs SET state='FAILED_RETRYABLE',lease_id=NULL,lease_expires_at=NULL,available_at='-infinity'::timestamptz WHERE id=$1",[resumedRetention.id]);
    await app.query("UPDATE retention_policies SET unmatched_diagnostic_hours=1 WHERE tenant_id=app.current_tenant_id()");
  });
  const resumedLeaseId="63500000-0000-4000-8000-000000000003";
  const reclaimedRetention=(await privacyRepository.claim(botPrincipal.tenantId,resumedLeaseId,1))[0];
  assert.equal(reclaimedRetention?.id,resumedRetention.id);
  assert.equal(reclaimedRetention?.unmatchedDiagnosticHours,24);
  assert.equal(reclaimedRetention?.createdAt,resumedRetention.createdAt);
  await tenant(botPrincipal.tenantId,()=>app.query("UPDATE retention_policies SET unmatched_diagnostic_hours=24 WHERE tenant_id=app.current_tenant_id()"));
  await privacyRepository.discover(reclaimedRetention,resumedLeaseId);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT state FROM delivery_outbox WHERE id='63600000-0000-4000-8000-000000000003'",
  ))).rows[0].state,"QUEUED");
  assert.deepEqual((await privacyTargetSnapshot(resumedRetention)).map(target=>`${target.type}:${target.targetId}`).sort(),frozenUnheldTargets);
  assert.equal((await privacyTargetSnapshot(resumedRetention)).some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="6362"),false);
  await tenant(botPrincipal.tenantId,async()=>{
    await app.query("UPDATE privacy_jobs SET state='FAILED_RETRYABLE',lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[resumedRetention.id]);
    await app.query(`INSERT INTO privacy_legal_holds (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
      VALUES (app.current_tenant_id(),'WHATSAPP_GROUP','13100000-0000-4000-8000-000000000001',repeat('5',64),'Resumed retention proof',$1)`,[botPrincipal.userId]);
    await app.query("UPDATE privacy_jobs SET state='RUNNING',stage='EXTERNAL',lease_id=$2,lease_expires_at=now()+interval '10 minutes' WHERE id=$1",[resumedRetention.id,resumedLeaseId]);
  });
  await assert.rejects(
    privacyRepository.discover({...reclaimedRetention,stage:"EXTERNAL"},resumedLeaseId),
    error=>error?.name==="PrivacyLegalHoldError",
  );
  assert.deepEqual((await privacyTargetSnapshot(resumedRetention)).map(target=>`${target.type}:${target.targetId}`).sort(),frozenUnheldTargets);
  assert.equal(await privacyRepository.fail(reclaimedRetention,resumedLeaseId,{
    retryable:false,legalHold:true,code:"LEGAL_HOLD_ACTIVE",safeError:"An active legal hold blocks this privacy deletion",
  }),true);
  await tenant(botPrincipal.tenantId,async()=>{
    await app.query(`UPDATE privacy_legal_holds SET state='RELEASED',released_by=$1,released_at=now(),updated_at=now()
      WHERE scope_type='WHATSAPP_GROUP' AND scope_value='13100000-0000-4000-8000-000000000001' AND state='ACTIVE'`,[botPrincipal.userId]);
  });
  const exportRequestId="60000000-0000-4000-8000-000000000001";
  const exportBusinessSnapshot=()=>tenant(botPrincipal.tenantId,async()=>{
    const snapshot={};
    for(const table of ["delivery_outbox","delivery_ticket_links","zammad_status_outbox","message_links","case_correlations","direct_customer_close_commands","bot_conversations","bot_conversation_events","bot_action_jobs","normalized_messages","participant_identities","group_workspace_participants","media_objects"]){
      snapshot[table]=(await app.query(`SELECT to_jsonb(record) AS value FROM ${table} record WHERE tenant_id=$1 ORDER BY to_jsonb(record)::text`,[botPrincipal.tenantId])).rows;
    }
    return snapshot;
  });
  const businessBeforeExports=await exportBusinessSnapshot();
  await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO privacy_requests
    (id,tenant_id,request_type,scope_type,scope_value,scope_sha256,disposition,idempotency_key,request_sha256,state,requested_by)
    VALUES ($1,app.current_tenant_id(),'EXPORT','REFERENCE','BOT-A1B2C3D4E5F6',repeat('4',64),'EXPORT_ONLY',
      'postgres-export-artifact',repeat('5',64),'RUNNING',$2)`,[exportRequestId,botPrincipal.userId]));
  const exportJob={...privacyJob("61000000-0000-4000-8000-000000000001",botPrincipal.tenantId,"62000000-0000-4000-8000-000000000001","EXPORT","REFERENCE","BOT-A1B2C3D4E5F6"),requestId:exportRequestId};
  const crossTenantExport=privacyJob("61000000-0000-4000-8000-000000000002","20000000-0000-4000-8000-000000000002","62000000-0000-4000-8000-000000000002","EXPORT","REFERENCE","BOT-A1B2C3D4E5F6");
  const participantExport=privacyJob("61000000-0000-4000-8000-000000000008",botPrincipal.tenantId,"62000000-0000-4000-8000-000000000008","EXPORT","PARTICIPANT","12025550120@c.us");
  await insertPrivacyJob(exportJob);await insertPrivacyJob(crossTenantExport);await insertPrivacyJob(participantExport);
  for(const job of [exportJob,crossTenantExport,participantExport]){
    await privacyRepository.discover(job,job.leaseId);job.stage="EXPORT";
  }
  const exportedBot=await privacyRepository.exportData(exportJob,exportJob.leaseId);
  assert.deepEqual(exportedBot.ticketIds,["99"]);
  await tenant(exportJob.tenantId,async()=>{
    const instanceId="11000000-0000-4000-8000-000000000001";
    const controller=new ZammadInternalController({
      rows:async(tenantId,sql,parameters)=>{assert.equal(tenantId,exportJob.tenantId);return(await app.query(sql,parameters)).rows},
      withTenant:async(tenantId,operation)=>{assert.equal(tenantId,exportJob.tenantId);return operation(app)},
    },{verify:async(_authorization,scope)=>{assert.equal(scope,"zammad:privacy");return{tenantId:exportJob.tenantId,instanceId}}},{});
    const input={job_id:exportJob.id,lease_id:exportJob.leaseId,fencing_token:1,operation:"READ_TICKET",native_id:"99",attempt:0};
    const admission=change=>controller.privacyAdmission("synthetic-signed-privacy",{...input,...change});
    assert.equal((await admission({})).allowed,true);
    assert.equal((await admission({operation:"READ_ARTICLES"})).allowed,true);
    for(const change of [{lease_id:crypto.randomUUID()},{fencing_token:2},{attempt:1},{native_id:"100"},{job_id:crossTenantExport.id},{target_id:crypto.randomUUID()}]){
      assert.equal((await admission(change)).allowed,false,JSON.stringify(change));
    }
    for(const [sql,parameters] of [
      ["UPDATE privacy_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[exportJob.id]],
      ["UPDATE privacy_job_targets SET state='SKIPPED' WHERE job_id=$1",[exportJob.id]],
    ]){
      await app.query("SAVEPOINT privacy_admission_state");
      await app.query(sql,parameters);
      assert.equal((await admission({})).allowed,false);
      await app.query("ROLLBACK TO SAVEPOINT privacy_admission_state");
    }
    // Runtime state is provisioner-owned: prepare this isolated fixture with the
    // harness administrator, while admission still executes as wasalx_app.
    await fixtureAdmin.query("UPDATE zammad_instances SET state='SUSPENDED' WHERE id=$1",[instanceId]);
    try{await assert.rejects(admission({}),{status:401})}
    finally{await fixtureAdmin.query("UPDATE zammad_instances SET state='WORKING' WHERE id=$1",[instanceId])}
    console.log("Native privacy SQL admission: exact manifest, cross-tenant job, lease/fence/attempt and inactive instance passed");
  });
  assert.equal(exportedBot.botConversations.length,1);
  assert.equal(exportedBot.botConversations[0].normalized_reference,"BOT-A1B2C3D4E5F6");
  assert.ok(exportedBot.botEvents.length>=1);
  const exportObjectKey=`tenants/${botPrincipal.tenantId}/privacy-exports/${exportRequestId}-${exportJob.fencingToken}.json`;
  await privacyRepository.reserveArtifactUpload(exportJob,exportJob.leaseId,exportObjectKey);
  const persistedArtifact=await privacyRepository.persistArtifact(exportJob,exportJob.leaseId,{objectKey:exportObjectKey,sha256:"6".repeat(64),byteSize:2});
  assert.match(persistedArtifact.id,/^[0-9a-f-]{36}$/u);
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(`SELECT
    (SELECT count(*)::integer FROM privacy_export_artifacts WHERE request_id=$1) AS artifacts,
    (SELECT count(*)::integer FROM privacy_object_cleanup WHERE job_id=$2) AS cleanup`,[exportRequestId,exportJob.id]))).rows,[{artifacts:1,cleanup:0}]);
  assert.deepEqual(await privacyRepository.exportData(crossTenantExport,crossTenantExport.leaseId),{ticketIds:[],messages:[],participantIdentities:[],metaDirectAliases:[],metaDirectIdentityEvents:[],metaDirectRecipients:[],metaCoexistence:{messages:[],contacts:[]},metaRouting:{events:[],actions:[]},metaBillingEvidence:[],metaAccountPolicies:[],metaManagedAuthority:[],metaFinancialEffects:[],metaAccountTransitions:[],metaCostAssessments:[],metaCostTariffs:[],metaCostStatements:[],metaCostSourceReviewStatus:[{unknownSubjectCoverage:0,unknownRecordSubjectCoverage:0,unresolvedWrites:0}],metaSignupAttempts:[],groupWorkspaceParticipants:[],correlations:[],botConversations:[],botEvents:[],botActions:[]});
  const exportedParticipant=await privacyRepository.exportData(participantExport,participantExport.leaseId);
  assert.deepEqual(exportedParticipant.participantIdentities.map(identity=>identity.external_participant_id),["12025550120@c.us"]);
  assert.deepEqual(exportedParticipant.groupWorkspaceParticipants.map(participant=>participant.external_participant_id),["12025550120@c.us"]);
  const userExport={...privacyJob("61000000-0000-4000-8000-000000000006",botPrincipal.tenantId,"62000000-0000-4000-8000-000000000006","EXPORT","ZAMMAD_USER","77"),requestId:"60000000-0000-4000-8000-000000000006"};
  await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO privacy_requests
    (id,tenant_id,request_type,scope_type,scope_value,scope_sha256,disposition,idempotency_key,request_sha256,state,requested_by)
    VALUES ($1,app.current_tenant_id(),'EXPORT','ZAMMAD_USER','77',repeat('4',64),'EXPORT_ONLY',
      'postgres-user-export-artifact',repeat('5',64),'RUNNING',$2)`,[userExport.requestId,botPrincipal.userId]));
  await insertPrivacyJob(userExport);
  // A retained older user manifest can contain a user and ticket with the same
  // native numeric ID. Seed it before discovery freezes manifest membership.
  await tenant(userExport.tenantId,async()=>{
    await app.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
      VALUES(app.current_tenant_id(),$1,'ZAMMAD_USER','77',encode(digest('77','sha256'),'hex')),
        (app.current_tenant_id(),$1,'ZAMMAD_TICKET','77',encode(digest('77','sha256'),'hex'))`,[userExport.id]);
  });
  await privacyRepository.discover(userExport,userExport.leaseId);userExport.stage="EXPORT";
  await tenant(userExport.tenantId,async()=>{
    const controller=new ZammadInternalController({rows:async(_tenantId,sql,parameters)=>(await app.query(sql,parameters)).rows,withTenant:async(_tenantId,operation)=>operation(app)},
      {verify:async()=>({tenantId:userExport.tenantId,instanceId:"11000000-0000-4000-8000-000000000001"})},{});
    assert.equal((await controller.privacyAdmission("synthetic-signed-privacy",{job_id:userExport.id,lease_id:userExport.leaseId,fencing_token:1,operation:"READ_TICKET",native_id:"77",attempt:0})).allowed,true);
  });
  const exportedUser=await privacyRepository.exportData(userExport,userExport.leaseId);
  assert.ok(exportedUser.ticketIds.includes("88"));
  assert.ok(exportedUser.botConversations.some(conversation=>conversation.external_chat_id==="12025550116@c.us"));
  const userExportObjectKey=`tenants/${userExport.tenantId}/privacy-exports/${userExport.requestId}-${userExport.fencingToken}.json`;
  await privacyRepository.reserveArtifactUpload(userExport,userExport.leaseId,userExportObjectKey);
  await privacyRepository.persistArtifact(userExport,userExport.leaseId,{objectKey:userExportObjectKey,sha256:"7".repeat(64),byteSize:2});
  for(const job of [exportJob,crossTenantExport,participantExport,userExport]){
    if(job===exportJob||job===userExport){
      const finalized=await privacyRepository.finalize(job,job.leaseId);
      assert.equal(finalized.botConversations,0);assert.equal(finalized.deliveryBodies,0);
      assert.deepEqual(await exportBusinessSnapshot(),businessBeforeExports);
      assert.equal((await privacyTargetSnapshot(job)).every(target=>target.state==="COMPLETE"),true);
    }
    assert.equal(await privacyRepository.complete(job,job.leaseId,{fixture:"export-data-contract"}),true);
    assert.deepEqual((await tenant(job.tenantId,()=>app.query("SELECT state,stage FROM privacy_jobs WHERE id=$1",[job.id]))).rows,[{state:"SUCCEEDED",stage:"DONE"}]);
  }
  assert.deepEqual(await exportBusinessSnapshot(),businessBeforeExports);
  console.log("Native exports preserve all business rows through discovery, saved artifact, finalization and completion; retained numeric user/ticket collision passed");
  const linkedAmbiguousDelivery=(await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO delivery_outbox
    (tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state)
    VALUES (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001',
      '501','linked-ambiguous','Acknowledgement','text/plain','privacy-linked-ambiguous','OUTCOME_UNKNOWN') RETURNING id`))).rows[0];
  await tenant(botPrincipal.tenantId,()=>app.query(
    "INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id) VALUES (app.current_tenant_id(),$1,'502')",
    [linkedAmbiguousDelivery.id],
  ));
  const linkedDelete=privacyJob("61000000-0000-4000-8000-000000000007",botPrincipal.tenantId,"62000000-0000-4000-8000-000000000007","DELETE","ZAMMAD_TICKET","502");
  await insertPrivacyJob(linkedDelete);
  await assert.rejects(
    ()=>privacyRepository.discover(linkedDelete,linkedDelete.leaseId),
    error=>error instanceof PrivacyRepositoryError&&error.code==="DELIVERY_OUTCOME_UNRESOLVED"&&error.retryable,
  );
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state FROM delivery_outbox WHERE id=$1",[linkedAmbiguousDelivery.id]))).rows[0].state,"OUTCOME_UNKNOWN");
  // End this deliberately unresolved fixture without changing the delivery outcome.
  assert.equal(await privacyRepository.fail(linkedDelete,linkedDelete.leaseId,{
    retryable:false,code:"FIXTURE_COMPLETE",safeError:"Unresolved delivery guard fixture completed",
  }),true);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state FROM privacy_jobs WHERE id=$1",[linkedDelete.id]))).rows[0].state,"FAILED_TERMINAL");
  const userHoldId=(await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO privacy_legal_holds
    (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
    VALUES (app.current_tenant_id(),'PARTICIPANT','12025550116@c.us',$1,'PostgreSQL Zammad user hold proof',$2) RETURNING id`,["7".repeat(64),botPrincipal.userId]))).rows[0].id;
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT app.has_applicable_privacy_hold('ZAMMAD_USER','77') AS held"))).rows[0].held,true);
  await tenant(botPrincipal.tenantId,()=>app.query("UPDATE privacy_legal_holds SET state='RELEASED',released_by=$1,released_at=now(),updated_at=now() WHERE id=$2",[botPrincipal.userId,userHoldId]));
  const holdId=(await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO privacy_legal_holds
    (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
    VALUES (app.current_tenant_id(),'REFERENCE','BOT-A1B2C3D4E5F6',$1,'PostgreSQL direct-bot privacy proof',$2)
    RETURNING id`,["6".repeat(64),botPrincipal.userId]))).rows[0].id;
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT app.has_applicable_privacy_hold('PARTICIPANT','12025550119@c.us') AS held",
  ))).rows[0].held,true);
  assert.equal((await tenant(crossTenantExport.tenantId,()=>app.query(
    "SELECT app.has_applicable_privacy_hold('PARTICIPANT','12025550119@c.us') AS held",
  ))).rows[0].held,false);
  const deleteJob=privacyJob("61000000-0000-4000-8000-000000000003",botPrincipal.tenantId,"62000000-0000-4000-8000-000000000003","DELETE","PARTICIPANT","12025550119@c.us");
  await insertPrivacyJob(deleteJob);
  await tenant(deleteJob.tenantId,async()=>{
    await app.query("SAVEPOINT held_native_intent");
    const heldTarget=(await app.query(`INSERT INTO privacy_job_targets
      (tenant_id,job_id,target_type,target_id,target_sha256,attempts,external_started_at)
      VALUES(app.current_tenant_id(),$1,'ZAMMAD_TICKET','99',encode(digest('99','sha256'),'hex'),1,clock_timestamp()) RETURNING id`,[deleteJob.id])).rows[0];
    await app.query("UPDATE privacy_jobs SET stage='EXTERNAL' WHERE id=$1",[deleteJob.id]);
    const controller=new ZammadInternalController({rows:async(_tenantId,sql,parameters)=>(await app.query(sql,parameters)).rows,withTenant:async(_tenantId,operation)=>operation(app)},
      {verify:async()=>({tenantId:deleteJob.tenantId,instanceId:"11000000-0000-4000-8000-000000000001"})},{});
    const input={job_id:deleteJob.id,lease_id:deleteJob.leaseId,fencing_token:1,target_id:heldTarget.id,operation:"DELETE_TICKET",native_id:"99",attempt:1};
    assert.equal((await controller.privacyAdmission("synthetic-signed-privacy",input)).allowed,false);
    await app.query("UPDATE privacy_legal_holds SET state='RELEASED',released_by=$1,released_at=now() WHERE id=$2",[botPrincipal.userId,holdId]);
    assert.equal((await controller.privacyAdmission("synthetic-signed-privacy",input)).allowed,true);
    await app.query("ROLLBACK TO SAVEPOINT held_native_intent");
  });
  await assert.rejects(()=>privacyRepository.discover(deleteJob,deleteJob.leaseId),error=>error instanceof PrivacyLegalHoldError);
  await tenant(botPrincipal.tenantId,()=>app.query(`UPDATE privacy_legal_holds
    SET state='RELEASED',released_by=$1,released_at=now(),updated_at=now() WHERE id=$2`,[botPrincipal.userId,holdId]));
  assert.deepEqual(await privacyRepository.discover(deleteJob,deleteJob.leaseId),{DELIVERY:1,EXPORT_ARTIFACT:2,NORMALIZED_MESSAGE:4,ZAMMAD_TICKET:1});
  const privacyTargets=await privacyRepository.targets(deleteJob);
  for(const target of privacyTargets){
    const attempt=await privacyRepository.beginTargetExternal(deleteJob,deleteJob.leaseId,target);
    if(target.type==="ZAMMAD_TICKET")await tenant(deleteJob.tenantId,async()=>{
      const controller=new ZammadInternalController({
        rows:async(tenantId,sql,parameters)=>{assert.equal(tenantId,deleteJob.tenantId);return(await app.query(sql,parameters)).rows},
        withTenant:async(tenantId,operation)=>{assert.equal(tenantId,deleteJob.tenantId);return operation(app)},
      },{verify:async()=>({tenantId:deleteJob.tenantId,instanceId:"11000000-0000-4000-8000-000000000001"})},{});
      const input={job_id:deleteJob.id,lease_id:deleteJob.leaseId,fencing_token:deleteJob.fencingToken,target_id:target.id,operation:"DELETE_TICKET",native_id:target.targetId,attempt};
      const admission=()=>controller.privacyAdmission("synthetic-signed-privacy",input);
      assert.equal((await admission()).allowed,true);
      await app.query("SAVEPOINT destructive_privacy_hold");
      await assert.rejects(app.query(`INSERT INTO privacy_legal_holds
        (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
        VALUES (app.current_tenant_id(),'ZAMMAD_TICKET',$1,repeat('8',64),'Native admission hold proof',$2)`,[target.targetId,botPrincipal.userId]),error=>error.code==="55000");
      await app.query("ROLLBACK TO SAVEPOINT destructive_privacy_hold");
      assert.equal((await admission()).allowed,true);
      console.log("Native destructive privacy SQL admission: persisted first intent and applicable legal hold passed");
    });
    await privacyRepository.markTargetExternal(deleteJob,deleteJob.leaseId,target);
  }
  const deletedBot=await privacyRepository.finalize(deleteJob,deleteJob.leaseId);
  assert.deepEqual({zammadTickets:deletedBot.zammadTickets,botConversations:deletedBot.botConversations},{zammadTickets:1,botConversations:1});
  assert.equal(deletedBot.deliveryBodies,1);
  assert.equal(deletedBot.exportArtifacts,2);
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query(`SELECT state,message_body,content_redacted_at IS NOT NULL AS redacted
    FROM delivery_outbox WHERE idempotency_key='handoff-order-proof'`))).rows,[{state:"SENT",message_body:"",redacted:true}]);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query(
    "SELECT count(*)::integer AS count FROM privacy_export_artifacts WHERE id=$1",[persistedArtifact.id],
  ))).rows[0].count,0);
  assert.equal(deletedBot.participantIdentities,1);
  assert.equal(deletedBot.groupWorkspaceParticipants,1);
  assert.equal((await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT count(*)::integer AS count FROM group_workspace_participants WHERE external_participant_id='12025550120@c.us'",
  ))).rows[0].count,1);
  assert.equal((await tenant(botPrincipal.tenantId,()=>app.query("SELECT count(*)::integer AS count FROM bot_conversations WHERE id=$1",[botConversation.id]))).rows[0].count,0);
  await privacyRepository.close();
  await tenant(botPrincipal.tenantId,()=>app.query(
    "DELETE FROM group_workspace_settings WHERE tenant_id=app.current_tenant_id() AND whatsapp_group_id='13000000-0000-4000-8000-000000000001'",
  ));
  for(const [workerKey,engine,endpoint,capacity] of [
    ["managed-gows-0","GOWS","http://managed-gows-0-0.managed-gows-0.wasalx.svc.cluster.local:3000/",100],
    ["managed-noweb-0","NOWEB","http://managed-noweb-0-0.managed-noweb-0.wasalx.svc.cluster.local:3000/",25],
  ]){
    await wahaRegistry.query(`SELECT worker_key FROM app.report_waha_worker_heartbeat(
      $1,$2,$3,$4,$5,'STABLE',NULL,300,true,now()-interval '1 minute',NULL
    )`,[workerKey,engine,endpoint,`secret://platform/waha/${workerKey}`,capacity]);
  }
  const managedAssignment=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`SELECT worker_key,engine,assignment_fencing_token
    FROM app.acquire_waha_session_assignment(
      (SELECT id FROM provider_sessions WHERE tenant_id=app.current_tenant_id()
        AND connection_id='23000000-0000-4000-8000-000000000002'
        AND ownership_state='ACTIVE'),
      'GOWS',interval '5 minutes'
    )`));
  assert.deepEqual(managedAssignment.rows,[{worker_key:"managed-gows-0",engine:"GOWS",assignment_fencing_token:"1"}]);
  const managedWorkers=await wahaOperator.query("SELECT worker_key,version FROM app.list_waha_workers() WHERE worker_key LIKE 'managed-%' ORDER BY worker_key");
  for(const worker of managedWorkers.rows){
    const disabled=await wahaOperator.query(
      "SELECT lifecycle_state FROM app.set_waha_worker_mode($1,$2,'DISABLED','STABLE',NULL,'postgres-rollout-test','Drain completed before declarative removal.')",
      [worker.worker_key,worker.version],
    );
    assert.deepEqual(disabled.rows,[{lifecycle_state:"DISABLED"}]);
  }
  const desiredManagedWorkers=[
    {workerKey:"managed-gows-0",engine:"GOWS",baseUrl:"http://managed-gows-0-0.managed-gows-0.wasalx.svc.cluster.local:3000/",secretReference:"secret://platform/waha/managed-gows-0"},
    {workerKey:"managed-noweb-0",engine:"NOWEB",baseUrl:"http://managed-noweb-0-0.managed-noweb-0.wasalx.svc.cluster.local:3000/",secretReference:"secret://platform/waha/managed-noweb-0"},
  ];
  await assert.rejects(
    ()=>wahaRolloutGate.query(
      "SELECT * FROM app.assert_waha_worker_registry_transition($1::jsonb)",
      [JSON.stringify([{workerKey:"managed-gows-0",engine:null,baseUrl:null,secretReference:null}])],
    ),
    error=>error.code==="P0001"&&/invalid managed WAHA rollout gate request/u.test(error.message),
  );
  const rolloutKeepBoth=await wahaRolloutGate.query(
    "SELECT checked_workers,omitted_workers FROM app.assert_waha_worker_registry_transition($1::jsonb)",
    [JSON.stringify(desiredManagedWorkers)],
  );
  assert.deepEqual(rolloutKeepBoth.rows,[{checked_workers:2,omitted_workers:0}]);
  await assert.rejects(
    ()=>wahaRolloutGate.query(
      "SELECT * FROM app.assert_waha_worker_registry_transition($1::jsonb)",
      [JSON.stringify([{...desiredManagedWorkers[0],baseUrl:"http://replacement-0.replacement.wasalx.svc.cluster.local:3000/"},desiredManagedWorkers[1]])],
    ),
    error=>error.code==="P0001"&&/immutable identity mismatch/u.test(error.message),
  );
  const rolloutRemoveEmpty=await wahaRolloutGate.query(
    "SELECT checked_workers,omitted_workers FROM app.assert_waha_worker_registry_transition($1::jsonb)",
    [JSON.stringify([desiredManagedWorkers[0]])],
  );
  assert.deepEqual(rolloutRemoveEmpty.rows,[{checked_workers:2,omitted_workers:1}]);
  const omittedHeartbeat=await wahaRegistry.query(`SELECT worker_key FROM app.report_waha_worker_heartbeat(
    'managed-noweb-0','NOWEB','http://managed-noweb-0-0.managed-noweb-0.wasalx.svc.cluster.local:3000/','secret://platform/waha/managed-noweb-0',25,'STABLE',NULL,300,true,now(),NULL
  )`);
  assert.deepEqual(omittedHeartbeat.rows,[{worker_key:"managed-noweb-0"}]);
  const omittedNoweb=(await wahaOperator.query("SELECT worker_key,version FROM app.list_waha_workers() WHERE worker_key='managed-noweb-0'")).rows[0];
  await assert.rejects(
    ()=>wahaOperator.query(
      "SELECT lifecycle_state FROM app.set_waha_worker_mode($1,$2,'ACTIVE','STABLE',NULL,'postgres-rollout-test','Attempted unsafe reactivation.')",
      [omittedNoweb.worker_key,omittedNoweb.version],
    ),
    error=>error.code==="P0001"&&/cannot reactivate outside/u.test(error.message),
  );
  await assert.rejects(
    ()=>wahaRegistry.query(`SELECT worker_key FROM app.report_waha_worker_heartbeat(
      'managed-gows-9','GOWS','http://managed-gows-9-0.managed-gows-9.wasalx.svc.cluster.local:3000/','secret://platform/waha/managed-gows-9',100,'STABLE',NULL,300,true,now(),NULL
    )`),
    error=>error.code==="P0001"&&/outside the staged registry/u.test(error.message),
  );
  await assert.rejects(
    ()=>wahaRolloutGate.query(
      "SELECT * FROM app.assert_waha_worker_registry_transition($1::jsonb)",
      [JSON.stringify([desiredManagedWorkers[1]])],
    ),
    error=>error.code==="P0001"&&/protected assignments 1/u.test(error.message),
  );
  await assert.rejects(()=>app.query("SELECT count(*) FROM connections"),error=>error.code==="42501");
  await assert.rejects(()=>app.query("SELECT count(*) FROM webhook_routes"),error=>error.code==="42501");
  await assert.rejects(()=>app.query("SELECT count(*) FROM tenant_settings"),error=>error.code==="42501");
  const route=await app.query("SELECT tenant_id,connection_id FROM app.resolve_waha_webhook_route('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')");assert.equal(route.rowCount,1);assert.equal(route.rows[0].tenant_id,"10000000-0000-4000-8000-000000000001");
  const ingressDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const ingressDatabase=new DatabaseService();
  try{
    const ingressOwner=(await tenant(route.rows[0].tenant_id,()=>app.query(`SELECT
      connection.state AS connection_state,session.state AS session_state,session.opaque_session_id,route.hmac_secret_reference
      FROM connections connection
      JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
      JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id AND route.provider='WAHA'
      WHERE connection.id=$1`,[route.rows[0].connection_id]))).rows[0];
    await tenant(route.rows[0].tenant_id,async()=>{
      await app.query("UPDATE connections SET state='CONNECTING' WHERE id=$1",[route.rows[0].connection_id]);
      await app.query("UPDATE provider_sessions SET state='CONNECTING' WHERE connection_id=$1 AND ownership_state='ACTIVE'",[route.rows[0].connection_id]);
    });
    const ingressRoute={tenant_id:route.rows[0].tenant_id,connection_id:route.rows[0].connection_id,provider:"WAHA",hmac_secret_reference:ingressOwner.hmac_secret_reference};
    const ingressInput=(providerEventId,eventType,providerSessionKey=ingressOwner.opaque_session_id,providerEngine="GOWS")=>({
      providerEventId,eventType,payload:{id:providerEventId},payloadSha256:createHash("sha256").update(providerEventId).digest("hex"),
      routeKey:"a".repeat(64),providerSessionKey,providerEngine,
    });
    await assert.rejects(
      ()=>ingressDatabase.acceptWebhookEvent(ingressRoute,ingressInput("postgres-connecting-message","message")),
      error=>/Webhook route was not found/u.test(error?.message),
    );
    assert.equal((await ingressDatabase.acceptWebhookEvent(ingressRoute,ingressInput("postgres-connecting-status","session.status"))).duplicate,false);
    await assert.rejects(
      ()=>ingressDatabase.acceptWebhookEvent(ingressRoute,ingressInput("postgres-wrong-session","message","wrong-session")),
      error=>/Webhook route was not found/u.test(error?.message),
    );
    await assert.rejects(
      ()=>ingressDatabase.acceptWebhookEvent(ingressRoute,ingressInput("postgres-wrong-engine","message",ingressOwner.opaque_session_id,"NOWEB")),
      error=>/Webhook route was not found/u.test(error?.message),
    );
    await tenant(route.rows[0].tenant_id,async()=>{
      await app.query("UPDATE connections SET state='WORKING' WHERE id=$1",[route.rows[0].connection_id]);
      await app.query("UPDATE provider_sessions SET state='WORKING' WHERE connection_id=$1 AND ownership_state='ACTIVE'",[route.rows[0].connection_id]);
    });
    assert.equal((await ingressDatabase.acceptWebhookEvent(ingressRoute,ingressInput("postgres-connecting-message","message"))).duplicate,false);
    assert.equal((await ingressDatabase.acceptWebhookEvent(ingressRoute,ingressInput("postgres-connecting-message","message"))).duplicate,true);
    assert.deepEqual((await tenant(route.rows[0].tenant_id,()=>app.query(`SELECT provider_event_id,status FROM event_inbox
      WHERE provider_event_id IN ('postgres-connecting-message','postgres-connecting-status') ORDER BY provider_event_id`))).rows,[
      {provider_event_id:"postgres-connecting-message",status:"ACCEPTED"},
      {provider_event_id:"postgres-connecting-status",status:"ACCEPTED"},
    ]);
    await tenant(route.rows[0].tenant_id,async()=>{
      await app.query("UPDATE event_inbox SET status='PROCESSED',processed_at=now() WHERE provider_event_id IN ('postgres-connecting-message','postgres-connecting-status')");
      await app.query("UPDATE connections SET state=$2 WHERE id=$1",[route.rows[0].connection_id,ingressOwner.connection_state]);
      await app.query("UPDATE provider_sessions SET state=$2 WHERE connection_id=$1 AND ownership_state='ACTIVE'",[route.rows[0].connection_id,ingressOwner.session_state]);
    });
    const metaConnectionId="12200000-0000-4000-8000-000000000003";
    const metaSession="610000000003";
    const metaWaba="620000000003";
    const metaRouteKey=metaSession;
    const metaSecret=`secret://${route.rows[0].tenant_id}/connections/${metaConnectionId}/meta`;
    await tenant(route.rows[0].tenant_id,async()=>{
      await app.query(`INSERT INTO connections (id,tenant_id,name,provider,engine,state,secret_reference)
        VALUES ($1,app.current_tenant_id(),'PostgreSQL Meta admission','META','CLOUD_API','CONNECTING',$2)`,[metaConnectionId,metaSecret]);
      await app.query(`INSERT INTO provider_sessions (tenant_id,connection_id,opaque_session_id,state,session_storage_reference,provider_state_data)
        VALUES (app.current_tenant_id(),$1,$2,'CONNECTING',$3,$4)`,[metaConnectionId,metaSession,`meta-cloud://${metaWaba}/${metaSession}`,{wabaId:metaWaba}]);
      await app.query(`INSERT INTO webhook_routes (tenant_id,connection_id,provider,external_key,hmac_secret_reference)
        VALUES (app.current_tenant_id(),$1,'META',$2,$3)`,[metaConnectionId,metaRouteKey,metaSecret]);
    });
    const metaRoute={tenant_id:route.rows[0].tenant_id,connection_id:metaConnectionId,provider:"META",hmac_secret_reference:metaSecret};
    const metaInput=(providerEventId,eventType)=>{
      const payload={object:"whatsapp_business_account",entry:[{id:metaWaba,changes:[{field:"messages",value:{
        messaging_product:"whatsapp",metadata:{phone_number_id:metaSession},
        ...(eventType==="messages"
          ? {messages:[{id:providerEventId,from:"12025550123",timestamp:"1791374400",type:"text",text:{body:"Synthetic admission fixture"}}]}
          : {statuses:[{id:providerEventId,recipient_id:"12025550123",timestamp:"1791374400",status:"sent"}]}),
      }}]}]};
      return {providerEventId,eventType,payload,payloadSha256:createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        routeKey:metaRouteKey,providerSessionKey:metaSession,providerEngine:"CLOUD_API"};
    };
    await assert.rejects(
      ()=>ingressDatabase.acceptWebhookEvent(metaRoute,metaInput("postgres-meta-connecting-message","messages")),
      error=>/Webhook route was not found/u.test(error?.message),
    );
    assert.equal((await tenant(metaRoute.tenant_id,()=>app.query(
      "SELECT count(*)::integer AS count FROM event_inbox WHERE connection_id=$1 AND provider_event_id='postgres-meta-connecting-message'",
      [metaConnectionId],
    ))).rows[0].count,0);
    assert.equal((await ingressDatabase.acceptWebhookEvent(metaRoute,metaInput("postgres-meta-connecting-status","message.status"))).duplicate,false);
    await tenant(metaRoute.tenant_id,async()=>{
      await app.query("UPDATE connections SET state='WORKING' WHERE id=$1",[metaConnectionId]);
      await app.query("UPDATE provider_sessions SET state='WORKING' WHERE connection_id=$1 AND ownership_state='ACTIVE'",[metaConnectionId]);
    });
    assert.equal((await ingressDatabase.acceptWebhookEvent(metaRoute,metaInput("postgres-meta-connecting-message","messages"))).duplicate,false);
    assert.equal((await ingressDatabase.acceptWebhookEvent(metaRoute,metaInput("postgres-meta-connecting-message","messages"))).duplicate,true);
    await tenant(metaRoute.tenant_id,async()=>{
      await app.query(`UPDATE event_inbox SET status='PROCESSED',processed_at=now()
        WHERE connection_id=$1 AND provider_event_id IN ('postgres-meta-connecting-message','postgres-meta-connecting-status')`,[metaConnectionId]);
      await app.query("DELETE FROM connections WHERE id=$1",[metaConnectionId]);
    });
  }finally{await ingressDatabase.onModuleDestroy();if(ingressDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=ingressDatabaseUrl}
  const discovered=await app.query("SELECT tenant_id,tenant_slug,membership_role FROM app.resolve_oidc_memberships('oidc-owner-a')");assert.deepEqual(discovered.rows,[{tenant_id:"10000000-0000-4000-8000-000000000001",tenant_slug:"tenant-a",membership_role:"tenant_owner"}]);
  // This oracle checks exact work membership, not the producer's availability order.
  // FIFO/availability and lifecycle-order probes below retain their original assertions.
  const workIdentity=row=>row.tenant_id+'\0'+row.work_type;
  const byWorkIdentity=(a,b)=>workIdentity(a).localeCompare(workIdentity(b));
  const scheduledWork=await app.query("SELECT tenant_id,work_type FROM app.list_due_worker_tenants(25)");assert.deepEqual([...scheduledWork.rows].sort(byWorkIdentity),[
    {tenant_id:"10000000-0000-4000-8000-000000000001",work_type:"delivery"},
    {tenant_id:"10000000-0000-4000-8000-000000000001",work_type:"privacy"},
    {tenant_id:"20000000-0000-4000-8000-000000000002",work_type:"privacy"},
    {tenant_id:"10000000-0000-4000-8000-000000000001",work_type:"routing"},
    {tenant_id:freshTenantId,work_type:"privacy"},
  ].sort(byWorkIdentity));
  const visible=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM connections ORDER BY id"));assert.deepEqual(visible.rows.map(row=>row.id),["12000000-0000-4000-8000-000000000001","12100000-0000-4000-8000-000000000002"]);
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO connections (tenant_id,name,provider,engine,state,secret_reference) VALUES ('10000000-0000-4000-8000-000000000001','Invalid engine','WAHA','CLOUD_API','PAUSED','secret://invalid/engine')")),error=>error.code==="23514");
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE connections SET engine='NOWEB' WHERE id='12000000-0000-4000-8000-000000000001'")),error=>error.code==="P0001"&&/immutable/u.test(error.message));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE connections SET phone_e164='+12025550124' WHERE id='12000000-0000-4000-8000-000000000001'"));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO connections (id,tenant_id,name,provider,engine,state,secret_reference) VALUES ('12000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Duplicate identity candidate','WAHA','GOWS','PROVISIONING','secret://a/duplicate')"));
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE connections SET phone_e164='+12025550124' WHERE id='12000000-0000-4000-8000-000000000002'")),
    error=>error.code==="23505"&&error.constraint==="connections_active_waha_identity_unique",
  );
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO provider_sessions
    (id,tenant_id,connection_id,opaque_session_id,state,provider_state,session_storage_reference)
    VALUES ('52000000-0000-4000-8000-000000000040','10000000-0000-4000-8000-000000000001',
      '12000000-0000-4000-8000-000000000002','duplicate-session','AWAITING_AUTH','SCAN_QR_CODE','storage://duplicate')`));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO webhook_routes
    (tenant_id,connection_id,provider,route_token_sha256,hmac_secret_reference)
    VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','WAHA',
      repeat('b',64),'secret://10000000-0000-4000-8000-000000000001/connections/12000000-0000-4000-8000-000000000002/webhook')`));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO connection_operations
    (tenant_id,connection_id,operation_type,idempotency_key,requested_by_type,requested_by_id,request_id)
    VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','PROVISION',
      'duplicate-provision','SYSTEM','postgres-gate','duplicate-provision')`));
  const protectedConnectionBefore=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT to_jsonb(c.*) AS connection,to_jsonb(ps.*) AS session,to_jsonb(route.*) AS route
    FROM connections c
    JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
    JOIN webhook_routes route ON route.tenant_id=c.tenant_id AND route.connection_id=c.id
    WHERE c.id='12000000-0000-4000-8000-000000000001'`));
  const lifecycleRepository=new ConnectionOperationRepository(new Pool({...connectorWorkerConfig,max:2}));
  let duplicateAssignment;
  try{
    const operationLeaseId="50000000-0000-4000-8000-000000000044";
    const jobs=await lifecycleRepository.claim("10000000-0000-4000-8000-000000000001",operationLeaseId,1);
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].connectionId,"12000000-0000-4000-8000-000000000002");
    duplicateAssignment=await lifecycleRepository.acquireWahaWorkerAssignment(jobs[0],120);
    assert.equal(duplicateAssignment.workerKey,"postgres-gows-a");
    const sessionLease=await lifecycleRepository.acquireProviderSessionLease(jobs[0],operationLeaseId,"postgres-duplicate-worker",120);
    const persisted=await lifecycleRepository.complete(jobs[0],operationLeaseId,sessionLease,{
      connectionState:"WORKING",providerState:"WORKING",providerStateData:{status:"WORKING"},
      phoneE164:"+12025550124",engine:"GOWS",webhookState:"ACTIVE",result:{provisioned:true},
    });
    assert.equal(persisted?.connectionState,"ACTION_REQUIRED");
    assert.equal(persisted?.result.rejected,"DUPLICATE_IDENTITY");
  }finally{await lifecycleRepository.close()}
  const duplicateStatusRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));
  try{
    const observedAt=new Date().toISOString();
    const event={id:"50000000-0000-4000-8000-000000000040",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000002",provider:"waha",providerEventId:"duplicate-status",eventType:"session.status",payload:{},attempts:1};
    const observation={opaqueSessionId:"duplicate-session",observedAt,providerState:"WORKING",connectionState:"WORKING"};
    const identity={phoneE164:"+12025550124",pinnedWahaWorkerId:duplicateAssignment.workerId};
    await tenant(event.tenantId,()=>app.query(`UPDATE connection_operations
      SET state='FAILED_TERMINAL',completed_at=now(),updated_at=now()
      WHERE connection_id=$1 AND idempotency_key='duplicate-identity:'||$2`,[event.connectionId,"52000000-0000-4000-8000-000000000040"]));
    assert.equal(await duplicateStatusRepository.applyProviderStatus(
      {...event,id:"50000000-0000-4000-8000-000000000041",providerEventId:"duplicate-status-late"},
      {...observation,observedAt:new Date(Date.now()+1000).toISOString()},identity,
    ),"IGNORED");
    await tenant(event.tenantId,()=>app.query(`UPDATE connection_operations
      SET state='QUEUED',completed_at=NULL,updated_at=now()
      WHERE connection_id=$1 AND idempotency_key='duplicate-identity:'||$2`,[event.connectionId,"52000000-0000-4000-8000-000000000040"]));
  }finally{await duplicateStatusRepository.close()}
  const duplicateEvidence=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT c.state AS connection_state,c.phone_e164,route.state AS route_state,
      ps.state AS session_state,operation.id AS operation_id,operation.state AS operation_state,operation.operation_type,operation.payload
    FROM connections c
    JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
    JOIN webhook_routes route ON route.tenant_id=c.tenant_id AND route.connection_id=c.id
    JOIN connection_operations operation ON operation.tenant_id=c.tenant_id AND operation.connection_id=c.id
    WHERE c.id='12000000-0000-4000-8000-000000000002' AND operation.idempotency_key LIKE 'duplicate-identity:%'`));
  assert.equal(duplicateEvidence.rowCount,1);
  const cleanupOperationId=duplicateEvidence.rows[0].operation_id;
  assert.deepEqual({...duplicateEvidence.rows[0],operation_id:undefined},{
    connection_state:"ACTION_REQUIRED",phone_e164:null,route_state:"PAUSED",session_state:"ACTION_REQUIRED",
    operation_id:undefined,operation_state:"QUEUED",operation_type:"DISCONNECT",
    payload:{reason:"DUPLICATE_IDENTITY",pinnedWahaWorkerId:duplicateAssignment.workerId},
  });
  const cleanupClaim=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT id,fencing_token FROM app.claim_connection_operations('50000000-0000-4000-8000-000000000042',1)",
  ));
  assert.deepEqual(cleanupClaim.rows,[{id:cleanupOperationId,fencing_token:"1"}]);
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query("UPDATE provider_sessions SET assignment_lease_expires_at=now()-interval '1 second' WHERE id='52000000-0000-4000-8000-000000000040'");
    await app.query("UPDATE connection_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[cleanupOperationId]);
  });
  const expiredCleanup=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT waha_worker_id
    FROM app.pin_waha_session_assignment_for_cleanup('52000000-0000-4000-8000-000000000040',$1,$2,1,interval '2 minutes')`,
    [duplicateAssignment.workerId,cleanupOperationId]));
  assert.equal(expiredCleanup.rowCount,0);
  const recoveredCleanupClaim=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT id,fencing_token FROM app.claim_connection_operations('50000000-0000-4000-8000-000000000045',1)",
  ));
  assert.deepEqual(recoveredCleanupClaim.rows,[{id:cleanupOperationId,fencing_token:"2"}]);
  const wrongCleanup=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT waha_worker_id
    FROM app.pin_waha_session_assignment_for_cleanup('52000000-0000-4000-8000-000000000040',$1,'50000000-0000-4000-8000-000000000043',2,interval '2 minutes')`,
    [duplicateAssignment.workerId]));
  assert.equal(wrongCleanup.rowCount,0);
  const staleCleanup=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT waha_worker_id
    FROM app.pin_waha_session_assignment_for_cleanup('52000000-0000-4000-8000-000000000040',$1,$2,1,interval '2 minutes')`,
    [duplicateAssignment.workerId,cleanupOperationId]));
  assert.equal(staleCleanup.rowCount,0);
  const pinnedCleanup=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT waha_worker_id,worker_key,assignment_fencing_token
    FROM app.pin_waha_session_assignment_for_cleanup('52000000-0000-4000-8000-000000000040',$1,$2,2,interval '2 minutes')`,
    [duplicateAssignment.workerId,cleanupOperationId]));
  assert.deepEqual(pinnedCleanup.rows,[{waha_worker_id:duplicateAssignment.workerId,worker_key:"postgres-gows-a",assignment_fencing_token:"2"}]);
  const privilegeAdmin=new Client({connectionString:adminUrl});await privilegeAdmin.connect();
  try{
    const duplicateFunctionPrivileges=await privilegeAdmin.query(`SELECT
      has_function_privilege('wasalx_app','app.queue_duplicate_waha_identity_cleanup(uuid,uuid,uuid,text,text)','EXECUTE') AS app_queue,
      has_function_privilege('wasalx_app','app.pin_waha_session_assignment_for_cleanup(uuid,uuid,uuid,bigint,interval)','EXECUTE') AS app_pin,
      to_regprocedure('app.pin_waha_session_assignment_for_cleanup(uuid,uuid,interval)') IS NULL AS old_pin_absent,
      EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE p.oid IN ('app.queue_duplicate_waha_identity_cleanup(uuid,uuid,uuid,text,text)'::regprocedure,
                        'app.pin_waha_session_assignment_for_cleanup(uuid,uuid,uuid,bigint,interval)'::regprocedure)
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute`);
    assert.deepEqual(duplicateFunctionPrivileges.rows,[{app_queue:true,app_pin:true,old_pin_absent:true,public_execute:false}]);
  }finally{await privilegeAdmin.end()}
  const protectedConnectionAfter=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT to_jsonb(c.*) AS connection,to_jsonb(ps.*) AS session,to_jsonb(route.*) AS route
    FROM connections c
    JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
    JOIN webhook_routes route ON route.tenant_id=c.tenant_id AND route.connection_id=c.id
    WHERE c.id='12000000-0000-4000-8000-000000000001'`));
  assert.deepEqual(protectedConnectionAfter.rows,protectedConnectionBefore.rows);
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    await app.query("UPDATE connection_operations SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$1",[cleanupOperationId]);
    await app.query("UPDATE provider_sessions SET state='REVOKED',ownership_state='RETIRED',retired_at=now(),worker_id=NULL,lease_expires_at=NULL WHERE id='52000000-0000-4000-8000-000000000040'");
    await app.query("UPDATE webhook_routes SET state='REVOKED' WHERE connection_id='12000000-0000-4000-8000-000000000002'");
    await app.query("UPDATE connections SET state='REVOKED' WHERE id='12000000-0000-4000-8000-000000000002'");
  });
  const tenantSettingsVisible=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT tenant_id,version FROM tenant_settings ORDER BY tenant_id"));assert.deepEqual(tenantSettingsVisible.rows,[{tenant_id:"10000000-0000-4000-8000-000000000001",version:"1"}]);
  const crossTenantSettings=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT tenant_id FROM tenant_settings WHERE tenant_id='20000000-0000-4000-8000-000000000002'"));assert.equal(crossTenantSettings.rowCount,0);
  await assert.rejects(()=>tenant("20000000-0000-4000-8000-000000000002",()=>app.query("UPDATE tenant_settings SET group_workspace_enabled=true WHERE tenant_id=app.current_tenant_id()")),error=>error.code==="42501");
  const groupWorkspaceDefaults=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT * FROM app.update_group_workspace_defaults(1,true,120,'RESTRICTED','20200000-0000-4000-8000-000000000002')",
  ));
  assert.deepEqual(groupWorkspaceDefaults.rows,[{group_workspace_enabled:true,group_history_default_retention_days:120,group_history_default_visibility:"RESTRICTED",version:"2"}]);
  const tenantAGroupWorkspace=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT group_workspace_enabled FROM tenant_settings WHERE tenant_id=app.current_tenant_id()"));
  assert.deepEqual(tenantAGroupWorkspace.rows,[{group_workspace_enabled:false}]);
  const wahaPolicyPrivileges=await app.query(`SELECT
    has_column_privilege('wasalx_app','waha_outbound_connection_policies','allow_human_group_workspace_initiation','UPDATE') AS app_update_group_initiation`);
  assert.deepEqual(wahaPolicyPrivileges.rows,[{app_update_group_initiation:true}]);
  const disclosurePrivileges=await app.query(`SELECT
    has_table_privilege('wasalx_app','group_disclosure_deliveries','DELETE') AS app_delete,
    has_column_privilege('wasalx_app','group_disclosure_deliveries','disclosure_sha256','SELECT') AS app_read_digest,
    has_column_privilege('wasalx_app','group_disclosure_deliveries','disclosure_sha256','INSERT') AS app_insert_digest,
    has_column_privilege('wasalx_app','group_disclosure_deliveries','state','UPDATE') AS app_update_state,
    has_column_privilege('wasalx_app','group_disclosure_deliveries','tenant_id','UPDATE') AS app_update_tenant`);
  assert.deepEqual(disclosurePrivileges.rows,[{app_delete:false,app_read_digest:true,app_insert_digest:true,app_update_state:true,app_update_tenant:false}]);
  await assert.rejects(()=>tenant("20000000-0000-4000-8000-000000000002",()=>app.query("INSERT INTO group_disclosure_deliveries (tenant_id,group_binding_id,disclosure_sha256,delivery_id,state) VALUES ($1,$2,$3,$4,'QUEUED')",[
    "20000000-0000-4000-8000-000000000002","15000000-0000-4000-8000-000000000001","5".repeat(64),"16000000-0000-4000-8000-000000000001",
  ])),error=>error.code==="23503");
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO group_disclosure_deliveries (tenant_id,group_binding_id,disclosure_sha256,delivery_id,state) VALUES ($1,$2,$3,$4,'QUEUED')",[
    "10000000-0000-4000-8000-000000000001","15000000-0000-4000-8000-000000000001","4".repeat(64),"16000000-0000-4000-8000-000000000001",
  ]));
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("DELETE FROM group_disclosure_deliveries WHERE disclosure_sha256=$1",["4".repeat(64)])),error=>error.code==="42501");
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO tenant_invitations (tenant_id,email,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256) VALUES ('10000000-0000-4000-8000-000000000001','cross-actor@a.invalid','agent',$1,now()+interval '1 day','20200000-0000-4000-8000-000000000002','cross-actor-invite',$2)",["d".repeat(64),"e".repeat(64)])),error=>error.code==="23503"&&error.message==="tenant actor must be an active member of its tenant");
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO tenant_invitations (tenant_id,email,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256) VALUES ('20000000-0000-4000-8000-000000000002','cross-tenant@b.invalid','agent',$1,now()+interval '1 day','20200000-0000-4000-8000-000000000002','cross-tenant-invite',$2)",["b".repeat(64),"c".repeat(64)])),error=>error.code==="42501");
  const requestedIdentityPolicy=await identityPolicy.query("SELECT tenant_id,version,sso_enforcement_state,security_policy_state FROM app.requested_tenant_identity_policy($1,$2)",["10000000-0000-4000-8000-000000000001",1]);
  assert.deepEqual(requestedIdentityPolicy.rows,[{tenant_id:"10000000-0000-4000-8000-000000000001",version:"1",sso_enforcement_state:"DISABLED",security_policy_state:"REQUESTED"}]);
  const identityEvidence="9".repeat(64);
  const activatedIdentityPolicy=await identityPolicy.query("SELECT app.activate_tenant_identity_policy($1,$2,$3) AS activated",["10000000-0000-4000-8000-000000000001",1,identityEvidence]);
  assert.equal(activatedIdentityPolicy.rows[0].activated,true);
  const replayedIdentityPolicy=await identityPolicy.query("SELECT app.activate_tenant_identity_policy($1,$2,$3) AS activated",["10000000-0000-4000-8000-000000000001",1,identityEvidence]);
  assert.equal(replayedIdentityPolicy.rows[0].activated,false);
  const staleIdentityPolicy=await identityPolicy.query("SELECT app.activate_tenant_identity_policy($1,$2,$3) AS activated",["10000000-0000-4000-8000-000000000001",2,"8".repeat(64)]);
  assert.equal(staleIdentityPolicy.rows[0].activated,false);
  const activatedIdentityEvidence=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT version,security_policy_state,policy_verification_evidence_sha256 FROM tenant_settings WHERE tenant_id=app.current_tenant_id()"));
  assert.deepEqual(activatedIdentityEvidence.rows,[{version:"2",security_policy_state:"ACTIVE",policy_verification_evidence_sha256:identityEvidence}]);
  const noRequestedIdentityPolicy=await identityPolicy.query("SELECT tenant_id FROM app.requested_tenant_identity_policy($1,$2)",["10000000-0000-4000-8000-000000000001",2]);
  assert.deepEqual(noRequestedIdentityPolicy.rows,[]);
  const enabledGroupWorkspace=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(
    "SELECT * FROM app.update_group_workspace_defaults(2,true,90,'RESTRICTED','10100000-0000-4000-8000-000000000001')",
  ));
  assert.deepEqual(enabledGroupWorkspace.rows,[{group_workspace_enabled:true,group_history_default_retention_days:90,group_history_default_visibility:"RESTRICTED",version:"3"}]);
  const workspaceOperationActions=["GROUP_WORKSPACE_DEFAULTS","GROUP_WORKSPACE_CAPTURE","GROUP_WORKSPACE_GRANT","GROUP_WORKSPACE_REVOKE"];
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    for(const [index,action]of workspaceOperationActions.entries())await app.query(`INSERT INTO bot_flow_operations
      (tenant_id,action,idempotency_key,request_sha256,result,requested_by,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[
      "10000000-0000-4000-8000-000000000001",action,`workspace-operation-${index}`,String(index+1).repeat(64),
      {action,index},"10100000-0000-4000-8000-000000000001",`workspace-request-${index}`,
    ]);
    const visible=await app.query("SELECT action,result FROM bot_flow_operations WHERE idempotency_key LIKE 'workspace-operation-%' ORDER BY idempotency_key");
    assert.deepEqual(visible.rows,workspaceOperationActions.map((action,index)=>({action,result:{action,index}})));
  });
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`INSERT INTO bot_flow_operations
    (tenant_id,action,idempotency_key,request_sha256,result,requested_by,request_id)
    VALUES ($1,$2,'workspace-operation-0',$3,'{}',$4,'workspace-conflict')`,[
    "10000000-0000-4000-8000-000000000001","GROUP_WORKSPACE_DEFAULTS","f".repeat(64),"10100000-0000-4000-8000-000000000001",
  ])),error=>error.code==="23505");
  const hiddenWorkspaceOperations=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(
    "SELECT action FROM bot_flow_operations WHERE idempotency_key LIKE 'workspace-operation-%'",
  ));
  assert.deepEqual(hiddenWorkspaceOperations.rows,[]);
  await tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`INSERT INTO bot_flow_operations
    (tenant_id,action,idempotency_key,request_sha256,result,requested_by,request_id)
    VALUES ($1,'GROUP_WORKSPACE_DEFAULTS','workspace-operation-0',$2,'{}',$3,'workspace-tenant-b')`,[
    "20000000-0000-4000-8000-000000000002","a".repeat(64),"20200000-0000-4000-8000-000000000002",
  ]));
  await tenant("10000000-0000-4000-8000-000000000001",async()=>{
    const tenantSetting=await app.query("SELECT group_workspace_enabled FROM tenant_settings WHERE tenant_id=$1",["10000000-0000-4000-8000-000000000001"]);
    assert.deepEqual(tenantSetting.rows,[{group_workspace_enabled:true}]);
    const inserted=await app.query(`INSERT INTO group_workspace_settings
      (tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by)
      VALUES ($1,$2,true,now(),90,'RESTRICTED',$3) RETURNING capture_enabled`,[
      "10000000-0000-4000-8000-000000000001","13000000-0000-4000-8000-000000000001","10100000-0000-4000-8000-000000000001",
    ]);
    assert.deepEqual(inserted.rows,[{capture_enabled:true}]);
    const syncJob={tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001"};
    const synchronizedProviderGroups=(await app.query(`SELECT id,external_group_id,display_name,participant_count
      FROM whatsapp_groups WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id`,[syncJob.tenantId,syncJob.connectionId])).rows.map(group=>({
      id:group.external_group_id,name:group.display_name,participants:Number(group.participant_count??0),
      ...(group.id==="13000000-0000-4000-8000-000000000001"?{participantRoster:[{
        id:"12025550125@c.us",normalizedPhone:"+12025550125",displayName:"Roster synchronization proof",
      }]}:{}),
    }));
    await synchronizeGroups(app,syncJob,synchronizedProviderGroups);
    const consentContender=new Client({connectionString:appUrl});await consentContender.connect();
    try{
      await consentContender.query("BEGIN");
      await consentContender.query("SELECT set_config('app.tenant_id',$1,true)",[syncJob.tenantId]);
      assert.equal((await consentContender.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",[`group-workspace-consent:${syncJob.tenantId}`])).rows[0].locked,false);
    }finally{await consentContender.query("ROLLBACK").catch(()=>undefined);await consentContender.end()}
    assert.equal((await app.query("SELECT count(*)::integer AS count FROM group_workspace_participants WHERE external_participant_id='12025550125@c.us'")).rows[0].count,1);
    await synchronizeGroups(app,syncJob,[]);
    assert.equal((await app.query("SELECT count(*)::integer AS count FROM group_workspace_participants WHERE tenant_id=$1",[syncJob.tenantId])).rows[0].count,0);
    await synchronizeGroups(app,syncJob,synchronizedProviderGroups);
    await app.query("UPDATE group_workspace_settings SET capture_enabled=false WHERE tenant_id=$1 AND whatsapp_group_id='13000000-0000-4000-8000-000000000001'",[syncJob.tenantId]);
    await synchronizeGroups(app,syncJob,synchronizedProviderGroups);
    assert.equal((await app.query("SELECT count(*)::integer AS count FROM group_workspace_participants WHERE external_participant_id='12025550125@c.us'")).rows[0].count,0);
    await app.query("UPDATE group_workspace_settings SET capture_enabled=true WHERE tenant_id=$1 AND whatsapp_group_id='13000000-0000-4000-8000-000000000001'",[syncJob.tenantId]);
    await synchronizeGroups(app,syncJob,synchronizedProviderGroups);
    assert.equal((await app.query("SELECT count(*)::integer AS count FROM group_workspace_participants WHERE external_participant_id='12025550125@c.us'")).rows[0].count,1);
    assert.equal((await app.query("SELECT version FROM app.update_group_workspace_defaults(3,false,90,'RESTRICTED',$1)",[botPrincipal.userId])).rows[0].version,"4");
    await synchronizeGroups(app,syncJob,synchronizedProviderGroups);
    assert.equal((await app.query("SELECT count(*)::integer AS count FROM group_workspace_participants WHERE tenant_id=$1",[syncJob.tenantId])).rows[0].count,0);
    assert.equal((await app.query("SELECT version FROM app.update_group_workspace_defaults(4,true,90,'RESTRICTED',$1)",[botPrincipal.userId])).rows[0].version,"5");
    await synchronizeGroups(app,syncJob,synchronizedProviderGroups.map(group=>({...group,participantRoster:undefined})));
    await app.query("SAVEPOINT delivery_destination_order_probe");
    await app.query(`INSERT INTO whatsapp_groups (id,tenant_id,connection_id,external_group_id,display_name) VALUES
      ('13000000-0000-4000-8000-000000000097',$1,$2,'fixture-0015@example.test','Ordering A'),
      ('13000000-0000-4000-8000-000000000098',$1,$2,'fixture-0016@example.test','Ordering B'),
      ('13000000-0000-4000-8000-000000000099',$1,$2,'fixture-0017@example.test','Ordering batch')`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO group_workspace_settings
        (tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by) VALUES
        ($1,'13000000-0000-4000-8000-000000000097',true,now(),90,'RESTRICTED',$2),
        ($1,'13000000-0000-4000-8000-000000000098',true,now(),90,'RESTRICTED',$2),
        ($1,'13000000-0000-4000-8000-000000000099',true,now(),90,'RESTRICTED',$2)`,[
      "10000000-0000-4000-8000-000000000001","10100000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO group_bindings
        (id,tenant_id,whatsapp_group_id,rule_set_id,zammad_group_id,default_priority,assignment_mode,acknowledgement_template,agent_prefix,retention_days,state)
      VALUES ('15000000-0000-4000-8000-000000000097',$1,'13000000-0000-4000-8000-000000000097','14000000-0000-4000-8000-000000000001',
        'Operations','normal','zammad_auto','Case {{reference}}','Agent:',30,'ACTIVE')`,[
      "10000000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO delivery_outbox
        (id,tenant_id,connection_id,group_workspace_group_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,delivery_origin,created_at) VALUES
        ('16000000-0000-4000-8000-000000000971',$1,$2,'13000000-0000-4000-8000-000000000097',NULL,NULL,'A first','text/plain','ordering-a-first','QUEUED','GROUP_WORKSPACE',now()-interval '3 seconds'),
        ('16000000-0000-4000-8000-000000000973',$1,$2,'13000000-0000-4000-8000-000000000098',NULL,NULL,'B independent','text/plain','ordering-b-independent','QUEUED','GROUP_WORKSPACE',now()-interval '2 seconds')`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO delivery_outbox
        (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state,delivery_origin,created_at)
      VALUES ('16000000-0000-4000-8000-000000000972',$1,$2,'15000000-0000-4000-8000-000000000097','972','972','A second','text/plain','ordering-a-second','QUEUED','TICKET',now()-interval '1 second')`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,available_at,delivery_origin,
         batch_id,batch_sequence,batch_part_count,created_at) VALUES
        ('ffffffff-0000-4000-8000-000000000097',$1,$2,'13000000-0000-4000-8000-000000000099','Batch A first','text/plain','ordering-batch-a-first','QUEUED',now(),'GROUP_WORKSPACE',
         '18000000-0000-4000-8000-000000000097',0,2,now()-interval '4 seconds'),
        ('00000000-0000-4000-8000-000000000097',$1,$2,'13000000-0000-4000-8000-000000000099','Batch A second','text/plain','ordering-batch-a-second','QUEUED','infinity','GROUP_WORKSPACE',
         '18000000-0000-4000-8000-000000000097',1,2,now()-interval '4 seconds'),
        ('88888888-0000-4000-8000-000000000098',$1,$2,'13000000-0000-4000-8000-000000000099','Batch B first','text/plain','ordering-batch-b-first','QUEUED',now(),'GROUP_WORKSPACE',
         '18000000-0000-4000-8000-000000000098',0,2,now()-interval '4 seconds'),
        ('11111111-0000-4000-8000-000000000098',$1,$2,'13000000-0000-4000-8000-000000000099','Batch B second','text/plain','ordering-batch-b-second','QUEUED','infinity','GROUP_WORKSPACE',
         '18000000-0000-4000-8000-000000000098',1,2,now()-interval '4 seconds')`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    const firstDestinationClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000097"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-"));
    assert.deepEqual(firstDestinationClaims.map(row=>row.idempotency_key).sort(),["ordering-a-first","ordering-b-independent","ordering-batch-a-first"]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-provider-'||id WHERE idempotency_key=ANY($1::text[])",[["ordering-a-first","ordering-b-independent","ordering-batch-a-first"]]);
    const nextDestinationClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000098"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-"));
    assert.deepEqual(nextDestinationClaims.map(row=>row.idempotency_key).sort(),["ordering-a-second","ordering-batch-a-second"]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-provider-'||id WHERE idempotency_key=ANY($1::text[])",[["ordering-a-second","ordering-batch-a-second"]]);
    const thirdDestinationClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000099"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-"));
    assert.deepEqual(thirdDestinationClaims.map(row=>row.idempotency_key),["ordering-batch-b-first"]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-provider-'||id WHERE idempotency_key='ordering-batch-b-first'");
    const fourthDestinationClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000100"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-"));
    assert.deepEqual(fourthDestinationClaims.map(row=>row.idempotency_key),["ordering-batch-b-second"]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-provider-'||id WHERE idempotency_key='ordering-batch-b-second'");
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,delivery_origin,
       batch_id,batch_sequence,batch_part_count,created_at) VALUES
      ('16000000-0000-4000-8000-000000000101',$1,$2,'13000000-0000-4000-8000-000000000099','Terminal head','text/plain','ordering-terminal-head','QUEUED','GROUP_WORKSPACE','18000000-0000-4000-8000-000000000101',0,2,now()-interval '3 seconds'),
      ('16000000-0000-4000-8000-000000000102',$1,$2,'13000000-0000-4000-8000-000000000099','Terminal blocked','text/plain','ordering-terminal-blocked','QUEUED','GROUP_WORKSPACE','18000000-0000-4000-8000-000000000101',1,2,now()-interval '3 seconds'),
      ('16000000-0000-4000-8000-000000000103',$1,$2,'13000000-0000-4000-8000-000000000099','Independent after terminal','text/plain','ordering-terminal-independent','QUEUED','GROUP_WORKSPACE',NULL,0,1,now()-interval '2 seconds')`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=false WHERE idempotency_key='ordering-terminal-head'");
    assert.deepEqual((await app.query(`SELECT state,blocked_by_delivery_id::text FROM delivery_outbox
      WHERE idempotency_key='ordering-terminal-blocked'`)).rows,[{
      state:"BLOCKED",blocked_by_delivery_id:"16000000-0000-4000-8000-000000000101",
    }]);
    const terminalChainClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000101"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-terminal-"));
    assert.deepEqual(terminalChainClaims,[{idempotency_key:"ordering-terminal-independent"}]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-terminal-independent-sent' WHERE idempotency_key='ordering-terminal-independent'");
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,delivery_origin,
       batch_id,batch_sequence,batch_part_count,created_at) VALUES
      ('16000000-0000-4000-8000-000000000104',$1,$2,'13000000-0000-4000-8000-000000000099','Manual retry head','text/plain','ordering-manual-head','QUEUED','GROUP_WORKSPACE','18000000-0000-4000-8000-000000000104',0,2,now()-interval '1 second'),
      ('16000000-0000-4000-8000-000000000105',$1,$2,'13000000-0000-4000-8000-000000000099','Manual blocked','text/plain','ordering-manual-blocked','QUEUED','GROUP_WORKSPACE','18000000-0000-4000-8000-000000000104',1,2,now()-interval '1 second'),
      ('16000000-0000-4000-8000-000000000106',$1,$2,'13000000-0000-4000-8000-000000000099','Independent after manual retry','text/plain','ordering-manual-independent','QUEUED','GROUP_WORKSPACE',NULL,0,1,now())`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query("UPDATE delivery_outbox SET state='FAILED_TERMINAL',manual_retry_allowed=true WHERE idempotency_key='ordering-manual-head'");
    const manualChainClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000102"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-manual-"));
    assert.deepEqual(manualChainClaims,[]);
    const stoppedId="16000000-0000-4000-8000-000000000104";
    const orderingProjection=()=>app.query(`SELECT ${deliveryHoldReasonSql("d")} AS reason,
      ${deliveryOrderingPredecessorSql("d")} AS predecessor FROM delivery_outbox d WHERE idempotency_key='ordering-manual-independent'`);
    assert.deepEqual((await orderingProjection()).rows,[{reason:"WAITING_FOR_EARLIER_DELIVERY",predecessor:stoppedId}]);
    const stopController=new DeliveriesController({withTenant:async(tenantId,operation)=>{
      assert.equal(tenantId,botPrincipal.tenantId);return operation(app);
    }},{wake:async()=>{}});
    const stopBefore=(await app.query("SELECT *,updated_at::text AS revision FROM delivery_outbox WHERE id=$1",[stoppedId])).rows[0];
    const stopRequest={principal:botPrincipal,id:"ordering-stop-retry"};
    const stopBody={confirmation:"STOP",expectedRevision:stopBefore.revision};
    for(const [name,setup] of [
      ["unknown",()=>app.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN',manual_retry_allowed=false WHERE id=$1",[stoppedId])],
      ["lease",()=>app.query("UPDATE delivery_outbox SET lease_id='17000000-0000-4000-8000-000000000199',lease_expires_at=now()+interval '1 minute' WHERE id=$1",[stoppedId])],
      ["review",()=>app.query(`INSERT INTO quarantine_records(tenant_id,source_kind,reason_code,delivery_id,safe_summary)
        VALUES ($1,'OUTBOUND','PROVIDER_OUTCOME_UNKNOWN',$2,'Delivery outcome requires review')`,[botPrincipal.tenantId,stoppedId])],
      ["privacy",()=>app.query(`INSERT INTO privacy_jobs(tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key)
        VALUES ($1::uuid,'DELETE','TENANT',$1::text,'DELETE_TICKETS','ordering-stop-privacy')`,[botPrincipal.tenantId])],
      ["redacted",()=>app.query(`UPDATE delivery_outbox SET content_redacted_at=now(),message_body='',
        group_workspace_group_id=NULL,manual_retry_allowed=false WHERE id=$1`,[stoppedId])],
    ]){
      await app.query("SAVEPOINT stop_denial");
      try{
        await setup();
        const currentRevision=(await app.query("SELECT updated_at::text AS revision FROM delivery_outbox WHERE id=$1",[stoppedId])).rows[0].revision;
        await assert.rejects(()=>stopController.stopRetrying(stopRequest,stoppedId,`ordering-stop-${name}`,{...stopBody,expectedRevision:currentRevision}),/Delivery changed/,name);
      }finally{await app.query("ROLLBACK TO SAVEPOINT stop_denial")}
    }
    await app.query("SAVEPOINT stop_tenant_denial");
    try{
      const otherTenant="20000000-0000-4000-8000-000000000002";
      await app.query("SELECT set_config('app.tenant_id',$1,true)",[otherTenant]);
      const isolatedController=new DeliveriesController({withTenant:async(id,operation)=>{assert.equal(id,otherTenant);return operation(app)}},{wake:async()=>{throw new Error("Must not wake")}});
      await assert.rejects(()=>isolatedController.stopRetrying({...stopRequest,principal:{...botPrincipal,tenantId:otherTenant}},stoppedId,"ordering-cross-tenant",stopBody),/Delivery changed/);
    }finally{await app.query("ROLLBACK TO SAVEPOINT stop_tenant_denial")}
    await assert.rejects(()=>stopController.stopRetrying(stopRequest,stoppedId,"ordering-stale-stop",{...stopBody,expectedRevision:"stale"}),/Delivery changed/);
    assert.equal((await stopController.stopRetrying(stopRequest,stoppedId,"ordering-stop-retry",stopBody)).manual_retry_allowed,false);
    assert.equal((await stopController.stopRetrying(stopRequest,stoppedId,"ordering-stop-retry",stopBody)).duplicate,true);
    const stopAfter=(await app.query("SELECT *,updated_at::text AS revision FROM delivery_outbox WHERE id=$1",[stoppedId])).rows[0];
    for(const key of Object.keys(stopBefore).filter(key=>!["manual_retry_allowed","updated_at","revision"].includes(key)))
      assert.deepEqual(stopAfter[key],stopBefore[key],`Stop retry preserves ${key}`);
    assert.equal((await app.query("SELECT count(*)::int AS count FROM audit_events WHERE target_id=$1 AND action='delivery.retry_stopped'",[stoppedId])).rows[0].count,1);
    assert.equal((await app.query("SELECT count(*)::int AS count FROM bot_flow_operations WHERE idempotency_key='ordering-stop-retry'")).rows[0].count,1);
    assert.deepEqual((await orderingProjection()).rows,[{reason:null,predecessor:null}]);
    await assert.rejects(()=>stopController.stopRetrying(stopRequest,stoppedId,"ordering-stop-again",stopBody),/Delivery changed/);
    await assert.rejects(()=>stopController.retry(stopRequest,stoppedId,"ordering-retry-stopped"),/not retryable/);
    await app.query("SAVEPOINT stopped_native_retry");
    try{
      await app.query("UPDATE delivery_outbox SET delivery_origin='TICKET',zammad_ticket_id=42,zammad_article_id=9 WHERE id=$1",[stoppedId]);
      await app.query("UPDATE group_workspace_settings SET visibility='ALL_AGENTS' WHERE whatsapp_group_id='13000000-0000-4000-8000-000000000099'");
      const claims={tenantId:botPrincipal.tenantId,instanceId:"11000000-0000-4000-8000-000000000001",userId:"2",groupIds:[],groupAdmin:true};
      const nativeController=new ZammadInternalController({withTenant:async(_id,operation)=>operation(app),rows:async(id,sql,params)=>{assert.equal(id,botPrincipal.tenantId);return(await app.query(sql,params)).rows}},
        {verify:async()=>claims},{wake:async()=>{throw new Error("Stopped delivery must not wake")}});
      assert.equal((await app.query(`SELECT delivery.id FROM delivery_outbox delivery
        JOIN whatsapp_groups group_record ON group_record.tenant_id=delivery.tenant_id AND group_record.id=delivery.group_workspace_group_id
        JOIN group_workspace_settings workspace ON workspace.tenant_id=group_record.tenant_id AND workspace.whatsapp_group_id=group_record.id
        WHERE delivery.id=$1 AND delivery.zammad_ticket_id='42' AND delivery.zammad_article_id='9'
          AND workspace.visibility='ALL_AGENTS' AND delivery.content_redacted_at IS NULL
          AND NOT app.delivery_has_active_privacy_target(delivery.id)`,[stoppedId])).rowCount,1);
      await assert.rejects(()=>nativeController.retry("test-service-identity",{tenant_id:claims.tenantId,instance_id:claims.instanceId,
        ticket_id:42,article_id:9,actor_id:2,delivery_id:stoppedId,idempotency_key:"ordering-native-retry-stopped"}),/Retryable delivery was not found/);
      assert.equal((await app.query("SELECT manual_retry_allowed FROM delivery_outbox WHERE id=$1",[stoppedId])).rows[0].manual_retry_allowed,false);
    }finally{await app.query("ROLLBACK TO SAVEPOINT stopped_native_retry")}
    const stoppedDetail=await stopController.detail(stopRequest,stoppedId);
    assert.equal(stoppedDetail.retry_stopped,true);
    for(const privateField of ["external_chat_id","message_body","bot_content"])
      assert.equal(Object.hasOwn(stoppedDetail,privateField),false,`${privateField} must not be projected`);
    assert.equal((await app.query("SELECT state FROM delivery_outbox WHERE idempotency_key='ordering-manual-blocked'")).rows[0].state,"BLOCKED");
    const releasedManualClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000104"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-manual-"));
    assert.deepEqual(releasedManualClaims,[{idempotency_key:"ordering-manual-independent"}]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-manual-independent-sent' WHERE idempotency_key='ordering-manual-independent'");
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,state,delivery_origin,
       batch_id,batch_sequence,batch_part_count,created_at) VALUES
      ('16000000-0000-4000-8000-000000000107',$1,$2,'13000000-0000-4000-8000-000000000099','Unknown head','text/plain','ordering-unknown-head','QUEUED','GROUP_WORKSPACE','18000000-0000-4000-8000-000000000107',0,2,now()+interval '1 second'),
      ('16000000-0000-4000-8000-000000000108',$1,$2,'13000000-0000-4000-8000-000000000099','Unknown blocked','text/plain','ordering-unknown-blocked','QUEUED','GROUP_WORKSPACE','18000000-0000-4000-8000-000000000107',1,2,now()+interval '1 second'),
      ('16000000-0000-4000-8000-000000000109',$1,$2,'13000000-0000-4000-8000-000000000099','Independent after unknown','text/plain','ordering-unknown-independent','QUEUED','GROUP_WORKSPACE',NULL,0,1,now()+interval '2 seconds')`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE idempotency_key='ordering-unknown-head'");
    const unknownChainClaims=(await app.query("SELECT idempotency_key FROM app.claim_delivery_jobs($1,100)",["17000000-0000-4000-8000-000000000103"])).rows
      .filter(row=>row.idempotency_key.startsWith("ordering-unknown-"));
    assert.deepEqual(unknownChainClaims,[]);
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,
       idempotency_key,state,delivery_origin,batch_id,batch_sequence,batch_part_count,created_at) VALUES
      ('16000000-0000-4000-8000-000000000110',$1,$2,'15000000-0000-4000-8000-000000000097','9910','9910',
       'Ticket batch head','text/plain','ordering-ticket-batch-head','QUEUED','TICKET','18000000-0000-4000-8000-000000000110',0,2,now()),
      ('16000000-0000-4000-8000-000000000111',$1,$2,'15000000-0000-4000-8000-000000000097','9910','9911',
       'Ticket batch successor','text/plain','ordering-ticket-batch-successor','QUEUED','TICKET','18000000-0000-4000-8000-000000000110',1,2,now())`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",
    ]);
    await app.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN' WHERE idempotency_key='ordering-ticket-batch-head'");
    assert.deepEqual((await app.query(`SELECT state,blocked_by_delivery_id::text FROM delivery_outbox
      WHERE idempotency_key='ordering-ticket-batch-successor'`)).rows,[{
      state:"BLOCKED",blocked_by_delivery_id:"16000000-0000-4000-8000-000000000110",
    }]);
    assert.deepEqual((await app.query(`SELECT zammad_ticket_id,delivery_state,safe_error FROM zammad_status_outbox
      WHERE delivery_id='16000000-0000-4000-8000-000000000111'`)).rows,[{
      zammad_ticket_id:"9910",delivery_state:"BLOCKED",
      safe_error:"Blocked because an earlier article part requires recovery.",
    }]);
    await app.query("UPDATE delivery_outbox SET state='SENT',external_message_id='ordering-ticket-batch-head-sent' WHERE idempotency_key='ordering-ticket-batch-head'");
    assert.deepEqual((await app.query(`SELECT state,blocked_by_delivery_id FROM delivery_outbox
      WHERE idempotency_key='ordering-ticket-batch-successor'`)).rows,[{state:"QUEUED",blocked_by_delivery_id:null}]);
    assert.deepEqual((await app.query(`SELECT zammad_ticket_id,delivery_state,safe_error FROM zammad_status_outbox
      WHERE delivery_id='16000000-0000-4000-8000-000000000111'`)).rows,[{
      zammad_ticket_id:"9910",delivery_state:"QUEUED",safe_error:null,
    }]);
    await app.query("ROLLBACK TO SAVEPOINT delivery_destination_order_probe");
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,zammad_ticket_id,zammad_article_id,
       message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at,delivery_origin)
      VALUES ('16000000-0000-4000-8000-000000000087',$1,'12000000-0000-4000-8000-000000000001',$2,
        NULL,NULL,'Ticketless workspace safety proof','text/plain','workspace-safety-proof','QUEUED',0,
        NULL,NULL,'GROUP_WORKSPACE')`,[
      "10000000-0000-4000-8000-000000000001","13000000-0000-4000-8000-000000000001",
    ]);
    const workspaceScheduled=await app.query(
      "SELECT work_type FROM app.list_due_worker_tenants(25) WHERE tenant_id=$1 AND work_type='delivery'",
      ["10000000-0000-4000-8000-000000000001"],
    );
    assert.deepEqual(workspaceScheduled.rows,[{work_type:"delivery"}]);
    await app.query(`UPDATE delivery_outbox SET state='CLAIMED',attempts=1,
      lease_id='17000000-0000-4000-8000-000000000087',lease_expires_at=now()+interval '1 minute'
      WHERE id='16000000-0000-4000-8000-000000000087'`);
    const workspaceAuthorization=await app.query(
      "SELECT authorized,reason_code FROM app.authorize_waha_outbound_send('16000000-0000-4000-8000-000000000087')",
    );
    assert.equal(workspaceAuthorization.rowCount,1);
    assert.notEqual(workspaceAuthorization.rows[0].reason_code,"INVALID_DELIVERY_STATE");
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_workspace_group_id,message_body,content_type,idempotency_key,
       state,attempts,lease_id,lease_expires_at,delivery_origin,batch_id,batch_sequence,batch_part_count)
      VALUES
      ('16000000-0000-4000-8000-000000000088',$1,$2,$3,'Ticketless batch first','text/plain',
       'workspace-batch-first','SENDING',1,'17000000-0000-4000-8000-000000000088',now()-interval '1 second',
       'GROUP_WORKSPACE','18000000-0000-4000-8000-000000000088',0,2),
      ('16000000-0000-4000-8000-000000000089',$1,$2,$3,'Ticketless batch second','text/plain',
       'workspace-batch-second','QUEUED',0,NULL,NULL,
       'GROUP_WORKSPACE','18000000-0000-4000-8000-000000000088',1,2)`,[
      "10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001","13000000-0000-4000-8000-000000000001",
    ]);
    await app.query("UPDATE delivery_outbox SET state='OUTCOME_UNKNOWN',lease_id=NULL,lease_expires_at=NULL WHERE id='16000000-0000-4000-8000-000000000088'");
    const ticketlessBatch=await app.query("SELECT id,state,blocked_by_delivery_id FROM delivery_outbox WHERE batch_id=$1 ORDER BY batch_sequence",["18000000-0000-4000-8000-000000000088"]);
    assert.deepEqual(ticketlessBatch.rows,[
      {id:"16000000-0000-4000-8000-000000000088",state:"OUTCOME_UNKNOWN",blocked_by_delivery_id:null},
      {id:"16000000-0000-4000-8000-000000000089",state:"BLOCKED",blocked_by_delivery_id:"16000000-0000-4000-8000-000000000088"},
    ]);
    const ticketlessStatuses=await app.query("SELECT delivery_id FROM zammad_status_outbox WHERE delivery_id=ANY($1::uuid[])",[["16000000-0000-4000-8000-000000000088","16000000-0000-4000-8000-000000000089"]]);
    assert.equal(ticketlessStatuses.rowCount,0);
    await app.query("SAVEPOINT no_further_attempts_check");
    const stoppedPart="16000000-0000-4000-8000-000000000088";
    const blockedPart="16000000-0000-4000-8000-000000000089";
    const stopped=async(id)=>(await app.query("SELECT app.delivery_no_further_attempts(app.current_tenant_id(),$1) AS stopped",[id])).rows[0].stopped;
    assert.equal(await stopped(stoppedPart),false);
    assert.equal(await stopped(blockedPart),false);
    const disposition=await app.query(`UPDATE quarantine_records SET state='RESOLVED',resolution_code='DELIVERY_NO_FURTHER_ATTEMPTS',
      resolved_by='10100000-0000-4000-8000-000000000001',resolved_at=now(),version=version+1
      WHERE delivery_id=$1 AND reason_code='PROVIDER_OUTCOME_UNKNOWN'`,[stoppedPart]);
    assert.equal(disposition.rowCount,1);
    assert.equal(await stopped(stoppedPart),true);
    assert.equal(await stopped(blockedPart),true);
    assert.equal(await stopped("16000000-0000-4000-8000-000000000087"),false);
    assert.equal((await app.query("SELECT app.delivery_no_further_attempts($1,$2) AS stopped",["20000000-0000-4000-8000-000000000002",stoppedPart])).rows[0].stopped,false);
    for(const leasedPart of [stoppedPart,blockedPart]){
      await app.query("UPDATE delivery_outbox SET lease_id=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1",[leasedPart,"17000000-0000-4000-8000-000000000088"]);
      assert.equal(await stopped(leasedPart),false,"leased work cannot be exempted");
      assert.equal(await stopped(blockedPart),false,"a lease on the blocker or successor preserves the barrier");
      await app.query("UPDATE delivery_outbox SET lease_id=NULL,lease_expires_at=NULL WHERE id=$1",[leasedPart]);
    }
    await app.query("UPDATE delivery_outbox SET state='DELIVERED' WHERE id=$1",[stoppedPart]);
    assert.equal((await app.query("SELECT state FROM delivery_outbox WHERE id=$1",[blockedPart])).rows[0].state,"BLOCKED","late receipt must not restart stopped batch parts");
    assert.equal(await stopped(blockedPart),true);
    await app.query("ROLLBACK TO SAVEPOINT no_further_attempts_check");
    await app.query("RELEASE SAVEPOINT no_further_attempts_check");
    await app.query("DELETE FROM group_workspace_settings WHERE tenant_id=$1 AND whatsapp_group_id=$2",[
      "10000000-0000-4000-8000-000000000001","13000000-0000-4000-8000-000000000001",
    ]);
  });
  const webhookAdmissionPrivileges=await app.query(`SELECT
    has_function_privilege('wasalx_app','app.lock_current_active_tenant_for_event_admission()','EXECUTE') AS function_execute,
    has_table_privilege('wasalx_app','public.tenants','UPDATE') AS tenant_update`);
  assert.deepEqual(webhookAdmissionPrivileges.rows,[{function_execute:true,tenant_update:false}]);
  await assert.rejects(()=>app.query("UPDATE tenants SET name='Compromised' WHERE id='10000000-0000-4000-8000-000000000001'"),error=>error.code==="42501");
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO connections (tenant_id,name,provider,engine,state,secret_reference) VALUES ('20000000-0000-4000-8000-000000000002','Cross tenant','WAHA','GOWS','PAUSED','secret://x')")),error=>error.code==="42501");
  await assert.rejects(()=>tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`INSERT INTO delivery_outbox
    (tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state)
    VALUES ('20000000-0000-4000-8000-000000000002','23000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000001','cross-group','1','blocked','text/plain','cross-tenant-group','QUEUED')`)),error=>error.code==="23503");
  await assert.rejects(()=>tenant("20000000-0000-4000-8000-000000000002",()=>app.query(`INSERT INTO delivery_outbox
    (tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,idempotency_key,state)
    VALUES ('20000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','cross-connection','1','blocked','text/plain','cross-tenant-connection','QUEUED')`)),error=>error.code==="23503");
  const claimed=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,idempotency_key,attempts,state FROM app.claim_delivery_jobs('17000000-0000-4000-8000-000000000001',25) ORDER BY idempotency_key"));
  assert.deepEqual(claimed.rows.map(({idempotency_key,attempts,state})=>({idempotency_key,attempts,state})),
    [`bot:${claimedBotActions[0].conversationId}:${directEvent.id}:0`,"delivery-a","privacy-retry-freeze"].sort().map(idempotency_key=>({idempotency_key,attempts:1,state:"CLAIMED"})));
  assert.deepEqual((await tenant(botPrincipal.tenantId,()=>app.query("SELECT state,attempts FROM delivery_outbox WHERE idempotency_key=$1",[`bot-action:${completedAction.id}:0`]))).rows,[{state:"QUEUED",attempts:0}]);
  const groupAuthorization=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT authorized,reason_code FROM app.authorize_waha_outbound_send('16000000-0000-4000-8000-000000000001')"));
  assert.equal(groupAuthorization.rowCount,1);assert.ok(typeof groupAuthorization.rows[0].reason_code==="string");
  const duplicateClaim=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM app.claim_delivery_jobs('17000000-0000-4000-8000-000000000002',25)"));assert.equal(duplicateClaim.rowCount,0);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE delivery_outbox SET lease_expires_at=now()-interval '1 second' WHERE id='16000000-0000-4000-8000-000000000001'"));
  const recovered=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,attempts,state FROM app.claim_delivery_jobs('17000000-0000-4000-8000-000000000003',25)"));assert.equal(recovered.rowCount,1);assert.equal(recovered.rows[0].attempts,2);assert.equal(recovered.rows[0].state,"CLAIMED");
  await tenant(botPrincipal.tenantId,()=>app.query(`INSERT INTO event_inbox
    (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at)
    VALUES (app.current_tenant_id(),'12000000-0000-4000-8000-000000000001','WAHA','event-before-restart','message','{}',repeat('7',64),'ACCEPTED',clock_timestamp()-interval '1 second')`));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO connection_operations (tenant_id,connection_id,operation_type,idempotency_key,requested_by_type,requested_by_id,request_id) VALUES ($1,$2,'RESTART','restart-a','USER','10100000-0000-4000-8000-000000000001','request-restart-a')",["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001"]));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO connection_operations (tenant_id,connection_id,operation_type,idempotency_key,requested_by_type,requested_by_id,request_id) VALUES ($1,$2,'PAUSE','restart-b','USER','10100000-0000-4000-8000-000000000001','request-restart-b')",["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001"]));
  const scheduledConnection=await app.query("SELECT work_type FROM app.list_due_worker_tenants(25) WHERE work_type='connection'");assert.deepEqual(scheduledConnection.rows,[{work_type:"connection"}]);
  const blockedOperationClaim=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM app.claim_connection_operations('17100000-0000-4000-8000-000000000001',25)"));assert.equal(blockedOperationClaim.rowCount,0);
  assert.equal((await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE event_inbox SET status='PROCESSED',lease_id=NULL,lease_expires_at=NULL,processed_at=now() WHERE provider_event_id='event-before-restart'"))).rowCount,1);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at) VALUES ($1,$2,'WAHA','event-after-restart','message','{}','event-after-restart-hash','ACCEPTED',clock_timestamp())",["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001"]));
  const operationClaim=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,attempts,fencing_token FROM app.claim_connection_operations('17100000-0000-4000-8000-000000000001',25)"));assert.equal(operationClaim.rowCount,1);assert.equal(operationClaim.rows[0].attempts,1);assert.equal(operationClaim.rows[0].fencing_token,"1");
  const duplicateOperationClaim=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM app.claim_connection_operations('17100000-0000-4000-8000-000000000002',25)"));assert.equal(duplicateOperationClaim.rowCount,0);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE connection_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[operationClaim.rows[0].id]));
  const recoveredOperation=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,attempts,fencing_token FROM app.claim_connection_operations('17100000-0000-4000-8000-000000000003',25)"));assert.equal(recoveredOperation.rowCount,1);assert.equal(recoveredOperation.rows[0].attempts,2);assert.equal(recoveredOperation.rows[0].fencing_token,"2");
  const staleCompletion=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM app.complete_connection_operation($1,'17100000-0000-4000-8000-000000000001',1,'{}')",[operationClaim.rows[0].id]));assert.equal(staleCompletion.rowCount,0);
  const currentCompletion=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,state FROM app.complete_connection_operation($1,'17100000-0000-4000-8000-000000000003',2,'{}')",[operationClaim.rows[0].id]));assert.equal(currentCompletion.rowCount,1);assert.equal(currentCompletion.rows[0].state,"SUCCEEDED");
  const fifoOperation=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,idempotency_key FROM app.claim_connection_operations('17100000-0000-4000-8000-000000000004',25)"));assert.deepEqual(fifoOperation.rows.map(row=>row.idempotency_key),["restart-b"]);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM app.complete_connection_operation($1,'17100000-0000-4000-8000-000000000004',1,'{}')",[fifoOperation.rows[0].id]));
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE event_inbox SET status='PROCESSED',processed_at=now() WHERE provider_event_id='event-after-restart'"));
  const cleanupAdmin=new Client({connectionString:adminUrl});await cleanupAdmin.connect();
  try{
    const cleanupTenant="30000000-0000-4000-8000-000000000003";
    await cleanupAdmin.query("INSERT INTO tenants (id,name,slug,state) VALUES ($1,'Cleanup Tenant','cleanup-tenant','ACTIVE')",[cleanupTenant]);
    await cleanupAdmin.query(`INSERT INTO connections
      (id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES ('31000000-0000-4000-8000-000000000003',$1,'Cleanup connection','WAHA','GOWS','REVOKED','secret://cleanup/connection')`,[
      cleanupTenant,
    ]);
    await withFixtureTenant(cleanupAdmin,cleanupTenant,()=>cleanupAdmin.query(`INSERT INTO connection_operations
      (id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id,completed_at)
      VALUES ('32000000-0000-4000-8000-000000000003',$1,'31000000-0000-4000-8000-000000000003',
        'PROVISION','cleanup-operation',jsonb_build_object('webhookSecretReference',$2::text),
        'SUCCEEDED','SYSTEM','postgres-proof','cleanup-operation',now())`,[
      cleanupTenant,`secret://${cleanupTenant}/connections/31000000-0000-4000-8000-000000000003/webhook`,
    ]));
    await tenant(cleanupTenant,()=>app.query("INSERT INTO secret_cleanup_outbox (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference) VALUES ($1,'31000000-0000-4000-8000-000000000003','32000000-0000-4000-8000-000000000003','WEBHOOK_SECRET',$2)",[
      cleanupTenant,`secret://${cleanupTenant}/connections/31000000-0000-4000-8000-000000000003/webhook`,
    ]));
    await assert.rejects(()=>tenant(cleanupTenant,()=>app.query("SELECT id FROM secret_cleanup_outbox")),error=>error.code==="42501");
    await assert.rejects(()=>app.query("SELECT * FROM app.claim_secret_cleanup_tasks('33000000-0000-4000-8000-000000000001',25)"),error=>error.code==="42501");
    await assert.rejects(()=>cleanupAdmin.query("DELETE FROM tenants WHERE id=$1",[cleanupTenant]),error=>error.code==="23503");
    // Wait for rollback to release locks before the other connection claims work.
    await cleanupAdmin.query("SELECT 1");
    const cleanupClaim=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks('33000000-0000-4000-8000-000000000002',25)");
    const cleanupTask=cleanupClaim.rows.find(row=>row.tenant_id===cleanupTenant);assert.ok(cleanupTask);assert.equal(cleanupTask.attempts,1);assert.equal(cleanupTask.fencing_token,"1");
    const duplicateCleanupClaim=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks('33000000-0000-4000-8000-000000000003',25)");assert.equal(duplicateCleanupClaim.rowCount,0);
    await cleanupAdmin.query("UPDATE secret_cleanup_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[cleanupTask.task_id]);
    const recoveredCleanup=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks('33000000-0000-4000-8000-000000000004',25)");assert.equal(recoveredCleanup.rowCount,1);assert.equal(recoveredCleanup.rows[0].attempts,2);assert.equal(recoveredCleanup.rows[0].fencing_token,"2");
    const staleCleanupCompletion=await cleanup.query("SELECT app.complete_secret_cleanup_task($1,'33000000-0000-4000-8000-000000000002',1) AS completed",[cleanupTask.task_id]);assert.equal(staleCleanupCompletion.rows[0].completed,false);
    const currentCleanupCompletion=await cleanup.query("SELECT app.complete_secret_cleanup_task($1,'33000000-0000-4000-8000-000000000004',2) AS completed",[cleanupTask.task_id]);assert.equal(currentCleanupCompletion.rows[0].completed,true);
    await assert.rejects(()=>cleanupAdmin.query("DELETE FROM tenants WHERE id=$1",[cleanupTenant]),error=>error.code==="23503");
    await cleanupAdmin.query("DELETE FROM secret_cleanup_outbox WHERE tenant_id=$1 AND state='SUCCEEDED'",[cleanupTenant]);
    const removedCleanupTenant=await cleanupAdmin.query("DELETE FROM tenants WHERE id=$1 RETURNING id",[cleanupTenant]);assert.equal(removedCleanupTenant.rowCount,1);
    const stageTenant="34000000-0000-4000-8000-000000000011";
    const otherStageTenant="34000000-0000-4000-8000-000000000012";
    const stageUser="34100000-0000-4000-8000-000000000011";
    const otherStageUser="34100000-0000-4000-8000-000000000012";
    const wahaConnection="34200000-0000-4000-8000-000000000011";
    const metaConnection="34200000-0000-4000-8000-000000000012";
    const rotatedConnection="34200000-0000-4000-8000-000000000013";
    const otherConnection="34200000-0000-4000-8000-000000000014";
    const wahaOperation="34300000-0000-4000-8000-000000000011";
    const metaOperation="34300000-0000-4000-8000-000000000012";
    const rotatedOperation="34300000-0000-4000-8000-000000000013";
    const otherOperation="34300000-0000-4000-8000-000000000014";
    const routingIntegration="34400000-0000-4000-8000-000000000011";
    const wahaReference=`secret://${stageTenant}/connections/${wahaConnection}/webhook`;
    const metaOldReference=`secret://${stageTenant}/connections/${metaConnection}/meta`;
    const metaStagedReference=`secret://${stageTenant}/connections/${metaConnection}/meta/rotations/${"a".repeat(64)}`;
    const rotatedOldReference=`secret://${stageTenant}/connections/${rotatedConnection}/meta/rotations/${"b".repeat(64)}`;
    const rotatedLiveReference=`secret://${stageTenant}/connections/${rotatedConnection}/meta/rotations/${"c".repeat(64)}`;
    const unrelatedReference=`secret://${stageTenant}/connections/${metaConnection}/meta/rotations/${"d".repeat(64)}`;
    const unrelatedOperation="34300000-0000-4000-8000-000000000015";
    const routingReference=`secret://tenants/${stageTenant}/routing/integrations/${routingIntegration}`;
    await cleanupAdmin.query("BEGIN");
    try{
      await cleanupAdmin.query("SELECT set_config('app.tenant_id',$1,true)",[stageTenant]);
      await cleanupAdmin.query(`INSERT INTO tenants(id,name,slug,state) VALUES
        ($1,'Secret stage tenant','secret-stage-tenant','ACTIVE'),
        ($2,'Other secret stage tenant','other-secret-stage-tenant','ACTIVE')`,[stageTenant,otherStageTenant]);
      await cleanupAdmin.query(`INSERT INTO users(id,oidc_subject,email,display_name) VALUES
        ($1,'secret-stage-owner','secret-stage@example.invalid','Secret stage owner'),
        ($2,'other-secret-stage-owner','other-secret-stage@example.invalid','Other secret stage owner')`,[stageUser,otherStageUser]);
      await cleanupAdmin.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES
        ($1,$2,'tenant_owner'),($3,$4,'tenant_owner')`,[stageTenant,stageUser,otherStageTenant,otherStageUser]);
      await cleanupAdmin.query(`INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES
        ($1,$2,'Staged WAHA','WAHA','GOWS','PROVISIONING','secret://platform/waha/admin'),
        ($3,$2,'Staged Meta','META','CLOUD_API','WORKING',$4),
        ($5,$2,'Rotated Meta','META','CLOUD_API','WORKING',$6),
        ($7::uuid,$8::uuid,'Other Meta','META','CLOUD_API','WORKING','secret://'||$8::uuid::text||'/connections/'||$7::uuid::text||'/meta')`,[
        wahaConnection,stageTenant,metaConnection,metaOldReference,rotatedConnection,rotatedLiveReference,
        otherConnection,otherStageTenant,
      ]);
      await cleanupAdmin.query(`INSERT INTO connection_operations
        (id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id,completed_at)
        VALUES
        ($1,$2,$3,'PROVISION','staged-waha',jsonb_build_object('webhookSecretReference',$9::text),'STAGED','USER',$4,'staged-waha',NULL),
        ($5,$2,$6,'ROTATE_META_CREDENTIAL','staged-meta',jsonb_build_object('oldSecretReference',$10::text,'newSecretReference',$11::text),'STAGED','USER',$4,'staged-meta',NULL),
        ($7,$2,$8,'ROTATE_META_CREDENTIAL','rotated-meta',jsonb_build_object('oldSecretReference',$12::text,'newSecretReference',$13::text),'SUCCEEDED','USER',$4,'rotated-meta',now()),
        ($14,$2,$6,'RESTART','unrelated-operation','{}','SUCCEEDED','USER',$4,'unrelated-operation',now())`,[
        wahaOperation,stageTenant,wahaConnection,stageUser,metaOperation,metaConnection,
        rotatedOperation,rotatedConnection,
        wahaReference,metaOldReference,metaStagedReference,rotatedOldReference,rotatedLiveReference,
        unrelatedOperation,
      ]);
      await cleanupAdmin.query("SELECT set_config('app.tenant_id',$1,true)",[otherStageTenant]);
      await cleanupAdmin.query("INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id,completed_at) VALUES($1,$2,$3,'PROVISION','other-stage','{}','STAGED','USER',$4,'other-stage',NULL)",[otherOperation,otherStageTenant,otherConnection,otherStageUser]);
      await cleanupAdmin.query("SELECT set_config('app.tenant_id',$1,true)",[stageTenant]);
      await cleanupAdmin.query(`INSERT INTO webhook_routes
        (tenant_id,connection_id,provider,route_token_sha256,hmac_secret_reference,state)
        VALUES ($1,$2,'WAHA',repeat('9',64),$3,'PAUSED')`,[stageTenant,wahaConnection,wahaReference]);
      await cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
        (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference) VALUES
        ($1,$2,$3,'WEBHOOK_SECRET',$4),
        ($1,$5,$6,'CONNECTION_CREDENTIAL',$7)`,[
        stageTenant,wahaConnection,wahaOperation,wahaReference,
        metaConnection,metaOperation,metaStagedReference,
      ]);
      await cleanupAdmin.query(`INSERT INTO client_routing_integrations
        (id,tenant_id,provider,display_name,secret_reference,auth_scheme,created_by,request_key_sha256,request_payload_sha256)
        VALUES ($1,$2,'HTTP_JSON','Staged routing',$3,'BEARER',$4,repeat('1',64),repeat('2',64))`,[
        routingIntegration,stageTenant,routingReference,stageUser,
      ]);
      await cleanupAdmin.query("COMMIT");
    }catch(error){await cleanupAdmin.query("ROLLBACK");throw error}
    await assert.rejects(()=>cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL','secret://cross-tenant/credential')`,[
      stageTenant,otherConnection,otherOperation,
    ]),error=>error.code==="23514");
    await assert.rejects(()=>cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL','secret://platform/meta/admin')`,[
      stageTenant,metaConnection,metaOperation,
    ]),error=>error.code==="23514");
    await assert.rejects(()=>cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,$3,'WEBHOOK_SECRET',$4)`,[
      stageTenant,wahaConnection,wahaOperation,
      `secret://${otherStageTenant}/connections/${otherConnection}/webhook`,
    ]),error=>error.code==="23514");
    await assert.rejects(()=>cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL',$4)`,[
      stageTenant,metaConnection,unrelatedOperation,unrelatedReference,
    ]),error=>error.code==="23514");
    await assert.rejects(()=>cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,routing_integration_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,'ROUTING_INTEGRATION_SECRET',$3)`,[
      stageTenant,routingIntegration,`${routingReference}/forged`,
    ]),error=>error.code==="23514");
    await assert.rejects(()=>cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,bot_action_credential_stage_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,'BOT_ACTION_CREDENTIAL_STAGE',$3)`,[
      "10000000-0000-4000-8000-000000000001",expiredCredentialStage.id,
      `${expiredCredentialStage.secret_reference}/forged`,
    ]),error=>error.code==="23514");
    await cleanupAdmin.query("ALTER TABLE secret_cleanup_outbox DISABLE TRIGGER secret_cleanup_reference_guard");
    await cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
      VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL','secret://platform/meta/poisoned')`,[
      stageTenant,rotatedConnection,rotatedOperation,
    ]);
    await cleanupAdmin.query("ALTER TABLE secret_cleanup_outbox ENABLE TRIGGER secret_cleanup_reference_guard");
    const preExpiryClaims=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks('34500000-0000-4000-8000-000000000011',100)");
    assert.deepEqual(preExpiryClaims.rows.filter(row=>row.tenant_id===stageTenant),[]);
    assert.deepEqual((await cleanupAdmin.query(`SELECT state,attempts FROM secret_cleanup_outbox
      WHERE tenant_id=$1 AND secret_reference='secret://platform/meta/poisoned'`,[stageTenant])).rows,[
      {state:"QUEUED",attempts:0},
    ]);
    await cleanupAdmin.query(`INSERT INTO secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference) VALUES
      ($1,$2,$3,'CONNECTION_CREDENTIAL',$4),
      ($1,$2,$3,'CONNECTION_CREDENTIAL',$5)`,[
      stageTenant,rotatedConnection,rotatedOperation,rotatedOldReference,rotatedLiveReference,
    ]);
    await withFixtureTenant(cleanupAdmin,stageTenant,()=>cleanupAdmin.query(`UPDATE connection_operations SET updated_at=now()-interval '61 minutes'
      WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,[stageTenant,[wahaOperation,metaOperation]]));
    await cleanupAdmin.query(`UPDATE client_routing_integrations SET updated_at=now()-interval '61 minutes'
      WHERE tenant_id=$1 AND id=$2`,[stageTenant,routingIntegration]);
    const expiredClaims=await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks('34500000-0000-4000-8000-000000000012',100)");
    assert.deepEqual(expiredClaims.rows.filter(row=>row.tenant_id===stageTenant).map(row=>row.secret_reference).sort(),[
      metaStagedReference,routingReference,rotatedOldReference,wahaReference,
    ].sort());
    assert.deepEqual((await cleanupAdmin.query(`SELECT id,state,error_code FROM connection_operations
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,[stageTenant,[wahaOperation,metaOperation]])).rows,[
      {id:wahaOperation,state:"FAILED_TERMINAL",error_code:"CREDENTIAL_STAGE_EXPIRED"},
      {id:metaOperation,state:"FAILED_TERMINAL",error_code:"CREDENTIAL_STAGE_EXPIRED"},
    ]);
    assert.deepEqual((await cleanupAdmin.query(`SELECT id,state,secret_reference FROM connections
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,[stageTenant,[wahaConnection,metaConnection,rotatedConnection]])).rows,[
      {id:wahaConnection,state:"REVOKED",secret_reference:"secret://platform/waha/admin"},
      {id:metaConnection,state:"WORKING",secret_reference:metaOldReference},
      {id:rotatedConnection,state:"WORKING",secret_reference:rotatedLiveReference},
    ]);
    assert.deepEqual((await cleanupAdmin.query("SELECT state,revision FROM client_routing_integrations WHERE tenant_id=$1 AND id=$2",[
      stageTenant,routingIntegration,
    ])).rows,[{state:"REVOKED",revision:"2"}]);
    const blockedLiveCleanup=await cleanupAdmin.query(`SELECT state,attempts FROM secret_cleanup_outbox
      WHERE tenant_id=$1 AND secret_reference=$2`,[stageTenant,rotatedLiveReference]);
    assert.deepEqual(blockedLiveCleanup.rows,[{state:"QUEUED",attempts:0}]);
    await cleanupAdmin.query("DELETE FROM secret_cleanup_outbox WHERE tenant_id=$1",[stageTenant]);
    const credentialCleanupTenant="30000000-0000-4000-8000-000000000004";
    const credentialCleanupUser="30100000-0000-4000-8000-000000000004";
    await cleanupAdmin.query("BEGIN");
    try{
      await cleanupAdmin.query(`INSERT INTO tenants (id,name,slug,state)
        VALUES ($1,'Credential Cleanup Tenant','credential-cleanup-tenant','ACTIVE')`,[credentialCleanupTenant]);
      await cleanupAdmin.query(`INSERT INTO users (id,oidc_subject,email,display_name)
        VALUES ($1,'credential-cleanup-owner','credential-cleanup@example.invalid','Credential cleanup owner')`,[credentialCleanupUser]);
      await cleanupAdmin.query(`INSERT INTO tenant_memberships (tenant_id,user_id,role)
        VALUES ($1,$2,'tenant_owner')`,[credentialCleanupTenant,credentialCleanupUser]);
      const staged=(await cleanupAdmin.query(`INSERT INTO bot_action_credential_stages
        (id,tenant_id,action_key,idempotency_key,secret_reference,credential_sha256,created_by)
        VALUES ('30300000-0000-4000-8000-000000000004',$1::uuid,'cleanup.lookup','tenant-delete-proof',
          'secret://tenants/'||$1::uuid::text||'/bot-actions/cleanup.lookup/credentials/'||
            encode(digest($1::uuid::text||':tenant-delete-proof','sha256'),'hex'),repeat('4',64),$2)
        RETURNING secret_reference`,[credentialCleanupTenant,credentialCleanupUser])).rows[0];
      await cleanupAdmin.query(`INSERT INTO bot_action_definitions
        (id,tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,secret_reference,
         active_revision_id,created_by,updated_by)
        VALUES ('30400000-0000-4000-8000-000000000004',$1,'cleanup.lookup','Cleanup lookup','HTTP_JSON',
          'https://api.example.invalid/cleanup','GET','BEARER',$2,
          '30500000-0000-4000-8000-000000000004',$3,$3)`,[
        credentialCleanupTenant,staged.secret_reference,credentialCleanupUser,
      ]);
      await cleanupAdmin.query(`INSERT INTO bot_action_revisions
        (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,
         secret_reference,headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
        VALUES ('30500000-0000-4000-8000-000000000004',$1,
          '30400000-0000-4000-8000-000000000004',1,'Cleanup lookup','HTTP_JSON',
          'https://api.example.invalid/cleanup','GET','BEARER',$2,'{}','{}',5000,262144,
          'ACTIVE',repeat('5',64),$3)`,[credentialCleanupTenant,staged.secret_reference,credentialCleanupUser]);
      await cleanupAdmin.query(`UPDATE bot_action_credential_stages
        SET state='BOUND',bound_action_revision_id='30500000-0000-4000-8000-000000000004',bound_at=now()
        WHERE tenant_id=$1 AND id='30300000-0000-4000-8000-000000000004'`,[credentialCleanupTenant]);
      await cleanupAdmin.query("UPDATE tenants SET state='DELETING' WHERE id=$1",[credentialCleanupTenant]);
      await cleanupAdmin.query("COMMIT");
    }catch(error){await cleanupAdmin.query("ROLLBACK");throw error}
    await assert.rejects(
      ()=>cleanupAdmin.query("DELETE FROM tenants WHERE id=$1",[credentialCleanupTenant]),
      error=>error.code==="23503",
    );
    // ErrorResponse can arrive before rollback releases the credential stage lock.
    await cleanupAdmin.query("SELECT 1");
    const credentialCleanupClaims=await cleanup.query(
      "SELECT * FROM app.claim_secret_cleanup_tasks('33000000-0000-4000-8000-000000000005',25)",
    );
    const credentialCleanupTask=credentialCleanupClaims.rows.find(row=>row.tenant_id===credentialCleanupTenant);
    assert.ok(credentialCleanupTask);
    assert.equal((await cleanup.query(
      "SELECT app.complete_secret_cleanup_task($1,'33000000-0000-4000-8000-000000000005',$2) AS completed",
      [credentialCleanupTask.task_id,credentialCleanupTask.fencing_token],
    )).rows[0].completed,true);
    await assert.rejects(
      ()=>cleanupAdmin.query("DELETE FROM tenants WHERE id=$1",[credentialCleanupTenant]),
      error=>error.code==="23503",
    );
    await cleanupAdmin.query("DELETE FROM secret_cleanup_outbox WHERE tenant_id=$1 AND state='SUCCEEDED'",[credentialCleanupTenant]);
    assert.equal((await cleanupAdmin.query("DELETE FROM tenants WHERE id=$1 RETURNING id",[credentialCleanupTenant])).rowCount,1);
    await cleanupAdmin.query("DELETE FROM users WHERE id=$1",[credentialCleanupUser]);
  }finally{await cleanupAdmin.end()}
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','WAHA','event-1','message','{}','hash','ACCEPTED')"));
  const scheduledInbound=await app.query("SELECT work_type FROM app.list_due_worker_tenants(25) WHERE work_type='inbound'");assert.deepEqual(scheduledInbound.rows,[{work_type:"inbound"}]);
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES ('10000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','WAHA','event-1','message','{}','hash','ACCEPTED')")),error=>error.code==="23505");
  const inbound=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,attempts,status FROM app.claim_inbound_events('19000000-0000-4000-8000-000000000001',25)"));assert.equal(inbound.rowCount,1);assert.equal(inbound.rows[0].attempts,1);assert.equal(inbound.rows[0].status,"PROCESSING");
  const inboundDuplicate=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id FROM app.claim_inbound_events('19000000-0000-4000-8000-000000000002',25)"));assert.equal(inboundDuplicate.rowCount,0);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE event_inbox SET lease_expires_at=now()-interval '1 second' WHERE provider_event_id='event-1'"));
  const inboundRecovered=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,attempts FROM app.claim_inbound_events('19000000-0000-4000-8000-000000000003',25)"));assert.equal(inboundRecovered.rowCount,1);assert.equal(inboundRecovered.rows[0].attempts,2);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO zammad_status_outbox (tenant_id,delivery_id,zammad_ticket_id,delivery_state) VALUES ('10000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','42','SENT')"));
  const status=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT delivery_id,zammad_ticket_id,delivery_state,attempts FROM app.claim_zammad_status_jobs('18000000-0000-4000-8000-000000000001',25) ORDER BY delivery_id,zammad_ticket_id"));
  assert.deepEqual(status.rows,[
    {delivery_id:"16000000-0000-4000-8000-000000000001",zammad_ticket_id:"42",delivery_state:"SENT",attempts:1},
    {delivery_id:workerStatusDeliveryId,zammad_ticket_id:"42",delivery_state:"DELIVERED",attempts:1},
    {delivery_id:workerStatusDeliveryId,zammad_ticket_id:"43",delivery_state:"DELIVERED",attempts:1},
  ]);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,request_id) VALUES ('10000000-0000-4000-8000-000000000001','USER','10100000-0000-4000-8000-000000000001','test','connection','c1','r1')"));
  await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE audit_events SET action='tampered'")),error=>error.message.includes("append-only"));
  await wahaRegistry.query(`SELECT worker_key FROM app.report_waha_worker_heartbeat(
    'postgres-gows-a','GOWS','http://waha-test.internal:3000',
    'secret://platform/waha/postgres-gows-a',100,'STABLE',NULL,300,
    true,now()-interval '1 minute',NULL
  )`);
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT worker_key
    FROM app.acquire_waha_session_assignment(
      (SELECT id FROM provider_sessions WHERE tenant_id=app.current_tenant_id()
        AND connection_id='12000000-0000-4000-8000-000000000001'
        AND ownership_state='ACTIVE'),
      'GOWS',interval '5 minutes'
    )`));
  const inboundPayload={id:"evt_e2e",event:"message",payload:{id:"message-e2e",chatId:"120363000000009@g.us",participant:"12025550102@c.us",body:"Shipment ١٢٣٤٥٦٧٨٩٠",source:"app",fromMe:false,timestamp:Math.floor(Date.now()/1000)}};
  await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES ($1,$2,'WAHA','evt-e2e','message',$3,'e2e-hash','ACCEPTED')",["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",inboundPayload]));
  const inboundRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));const originalFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes("/users/search"))return new Response(JSON.stringify([]),{status:200});if(url.endsWith("/api/v1/users")&&init?.method==="POST"){const body=JSON.parse(String(init.body));return new Response(JSON.stringify({id:77,login:body.login,firstname:body.firstname,lastname:"",email:""}),{status:201})}if(url.includes("/tickets/search"))return new Response(JSON.stringify([]),{status:200});if(url.endsWith("/api/v1/tickets")&&init?.method==="POST"){const body=JSON.parse(String(init.body));assert.equal(body.customer_id,77);assert.equal(body.title,"Group A — Ten digits: 1234567890");assert.equal(body.priority,"2 normal");assert.equal(body.owner_id,undefined);assert.equal(body.wasalx_default_priority,"normal");assert.equal(body.wasalx_assignment_mode,"zammad_auto");assert.equal(body.wasalx_business_hours_mode,"ALWAYS");assert.deepEqual(body.article.preferences,{wasalx_origin:"provider",wasalx_external_message_id:"message-e2e",wasalx_sender_phone:"+12025550102"});return new Response(JSON.stringify({id:501,number:"10501",state:"open",group:"Operations",title:"Case"}),{status:201})}if(url.endsWith("/api/v1/ticket_articles/by_ticket/501"))return new Response(JSON.stringify([{id:901,preferences:{wasalx_external_message_id:"message-e2e"}}]),{status:200});throw new Error(`Unexpected Zammad request ${url}`)};
  try{const inboundProcessor=new InboundProcessor(inboundRepository,{resolve:async()=>({token:"test-zammad-token"})});assert.deepEqual(await inboundProcessor.drainTenant("10000000-0000-4000-8000-000000000001"),{events:1,acknowledgements:1})}finally{globalThis.fetch=originalFetch;await inboundRepository.close()}
  const inboundEvidence=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT (SELECT status FROM event_inbox WHERE provider_event_id='evt-e2e') AS event_status,(SELECT count(*)::int FROM normalized_messages WHERE external_message_id='message-e2e') AS normalized_count,(SELECT (provider_metadata->>'zammad_customer_id')::int FROM normalized_messages WHERE external_message_id='message-e2e') AS zammad_customer_id,(SELECT count(*)::int FROM case_correlations WHERE normalized_reference='1234567890') AS correlation_count,(SELECT count(*)::int FROM delivery_outbox delivery JOIN delivery_ticket_links link ON link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id WHERE delivery.tenant_id=app.current_tenant_id() AND delivery.connection_id='12000000-0000-4000-8000-000000000001' AND delivery.group_binding_id='15000000-0000-4000-8000-000000000001' AND delivery.reply_to_message_id='message-e2e' AND delivery.state='QUEUED' AND delivery.idempotency_key~'^ack:[0-9a-f]{64}$' AND link.zammad_ticket_id='501') AS acknowledgement_count"));assert.deepEqual(inboundEvidence.rows[0],{event_status:"PROCESSED",normalized_count:1,zammad_customer_id:77,correlation_count:1,acknowledgement_count:1});
  // Same provider message in a distinct inbox event must not repeat downstream effects.
  const replayInsert=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status) VALUES ($1,$2,'WAHA','evt-e2e-replay','message',$3,'e2e-replay-hash','ACCEPTED') RETURNING id",["10000000-0000-4000-8000-000000000001","12000000-0000-4000-8000-000000000001",inboundPayload]));
  const replayRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));
  try {
    const processor=new InboundProcessor(replayRepository,{resolve:async()=>{throw new Error("Duplicate must not resolve downstream credentials");}});
    assert.deepEqual(await processor.drainTenant("10000000-0000-4000-8000-000000000001"),{events:1,acknowledgements:0});
  } finally { await replayRepository.close(); }
  const replayProof=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT (SELECT status FROM event_inbox WHERE id=$1) AS status,(SELECT count(*)::int FROM normalized_messages WHERE external_message_id='message-e2e') AS messages,(SELECT count(*)::int FROM delivery_outbox WHERE reply_to_message_id='message-e2e') AS acknowledgements",[replayInsert.rows[0].id]));
  assert.deepEqual(replayProof.rows[0],{status:"DUPLICATE",messages:1,acknowledgements:1});

  // Exercise identity recovery with real worker permissions and committed fixtures.
  const identityTenant="10000000-0000-4000-8000-000000000001";
  const identityConnection="12000000-0000-4000-8000-000000000001";
  const identityReview=crypto.randomUUID(),identityEvent=crypto.randomUUID(),identityPrivacy=crypto.randomUUID();
  const identityRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));
  const identityAdmin=new Client({connectionString:adminUrl});
  await identityAdmin.connect();
  const identitySource=(await identityAdmin.query("SELECT id,event_inbox_id FROM normalized_messages WHERE tenant_id=$1 AND external_message_id='message-e2e'",[identityTenant])).rows[0];
  const identityRequest={id:identityEvent,tenantId:identityTenant,connectionId:identityConnection,eventType:"quarantine.reprocess",payload:{quarantineId:identityReview}};
  try{
    await identityAdmin.query(`INSERT INTO event_inbox(id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status)
      VALUES($1::uuid,$2,$3,'WAHA',($1::uuid)::text,'quarantine.reprocess','{}','identity-regression','PROCESSED')`,[identityEvent,identityTenant,identityConnection]);
    await identityAdmin.query(`INSERT INTO quarantine_records(id,tenant_id,source_kind,reason_code,state,connection_id,group_binding_id,source_event_inbox_id,reprocess_event_id,safe_summary)
      VALUES($1,$2,'INBOUND','NON_RETRYABLE_REVIEW','REPROCESS_QUEUED',$3,'15000000-0000-4000-8000-000000000001',$4,$5,'Identity regression')`,[identityReview,identityTenant,identityConnection,identitySource.event_inbox_id,identityEvent]);
    const original=await identityRepository.originalReprocessParticipant(identityRequest,"120363000000009@g.us");
    assert.deepEqual(original,{replyToMessageId:"message-e2e",participantId:"12025550102@c.us",participantName:undefined,fromMe:false,fromApi:false});
    for(const changed of [{tenantId:"20000000-0000-4000-8000-000000000002"},{connectionId:crypto.randomUUID()},{id:crypto.randomUUID()},{payload:{quarantineId:crypto.randomUUID()}}]){
      assert.equal(await identityRepository.originalReprocessParticipant({...identityRequest,...changed},"120363000000009@g.us"),null);
    }
    assert.equal(await identityRepository.originalReprocessParticipant(identityRequest,"fixture-0018@example.test"),null);
    await identityAdmin.query("UPDATE quarantine_records SET state='OPEN' WHERE id=$1",[identityReview]);
    assert.equal(await identityRepository.originalReprocessParticipant(identityRequest,"120363000000009@g.us"),null);
    await identityAdmin.query("UPDATE quarantine_records SET state='REPROCESS_QUEUED' WHERE id=$1",[identityReview]);
    for(const jobType of ["DELETE","RETENTION_SWEEP"]){
      await insertPrivacyJob(privacyJob(identityPrivacy,identityTenant,crypto.randomUUID(),jobType,"TENANT",identityTenant));
      if(jobType==="RETENTION_SWEEP")await identityAdmin.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
        VALUES($1,$2,'NORMALIZED_MESSAGE',$3,repeat('a',64))`,[identityTenant,identityPrivacy,identitySource.id]);
      assert.equal(await identityRepository.originalReprocessParticipant(identityRequest,"120363000000009@g.us"),null);
      await identityAdmin.query("DELETE FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2",[identityTenant,identityPrivacy]);
      await identityAdmin.query("DELETE FROM privacy_jobs WHERE tenant_id=$1 AND id=$2",[identityTenant,identityPrivacy]);
    }
    assert.deepEqual(await identityRepository.originalReprocessParticipant(identityRequest,"120363000000009@g.us"),original);
  }finally{
    await identityRepository.close();
    await identityAdmin.query("DELETE FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2",[identityTenant,identityPrivacy]);
    await identityAdmin.query("DELETE FROM privacy_jobs WHERE tenant_id=$1 AND id=$2",[identityTenant,identityPrivacy]);
    await identityAdmin.query("DELETE FROM quarantine_records WHERE tenant_id=$1 AND id=$2",[identityTenant,identityReview]);
    await identityAdmin.query("DELETE FROM event_inbox WHERE tenant_id=$1 AND id=$2",[identityTenant,identityEvent]);
    await identityAdmin.end();
  }
  const lifecycleCorrelationRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));
  try{
    await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE case_correlations SET state='RESOLVED',zammad_state_id=4,zammad_state_observed_at=now()-interval '1 minute',version=version+1 WHERE normalized_reference='1234567890'"));
    const calls=[];const context={bindingId:"15000000-0000-4000-8000-000000000001"};
    const reopened=await lifecycleCorrelationRepository.correlate({id:"reopen-event",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001",provider:"waha",providerEventId:"reopen-event",eventType:"message",payload:{},attempts:1},context,{provider:"waha",connectionId:"12000000-0000-4000-8000-000000000001",eventId:"reopen-event",messageId:"reopen-message",groupId:"120363000000009@g.us",participantId:"12025550102@c.us",text:"1234567890",fromApi:false,fromMe:false,timestamp:new Date().toISOString()},"1234567890",{create:async()=>{throw new Error("resolved correlation must not create")},reopen:async id=>{calls.push(`reopen:${id}`);return new Date().toISOString()},append:async id=>{calls.push(`append:${id}`)}});
    assert.deepEqual(reopened,{id:"501",number:"10501"});assert.deepEqual(calls,["reopen:501","append:501"]);
    const reopenedState=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT state,generation,zammad_state_id FROM case_correlations WHERE normalized_reference='1234567890' AND state<>'DETACHED'"));assert.deepEqual(reopenedState.rows,[{state:"OPEN",generation:1,zammad_state_id:null}]);

    await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("UPDATE case_correlations SET state='DETACHED',detached_at=now(),detached_by='10100000-0000-4000-8000-000000000001',version=version+1,updated_at=now() WHERE normalized_reference='1234567890' AND state='OPEN'"));
    let generationKey="";await lifecycleCorrelationRepository.correlate({id:"generation-event",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001",provider:"waha",providerEventId:"generation-event",eventType:"message",payload:{},attempts:1},context,{provider:"waha",connectionId:"12000000-0000-4000-8000-000000000001",eventId:"generation-event",messageId:"generation-message",groupId:"120363000000009@g.us",participantId:"12025550102@c.us",text:"1234567890",fromApi:false,fromMe:false,timestamp:new Date().toISOString()},"1234567890",{create:async key=>{generationKey=key;return{id:"502",number:"10502"}},reopen:async()=>{throw new Error("new generation must not reopen")},append:async()=>{throw new Error("new generation must not append")}});
    assert.match(generationKey,/:generation:2$/);
    const generations=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT id,generation,state,zammad_ticket_id,predecessor_correlation_id,replaced_by_correlation_id FROM case_correlations WHERE normalized_reference='1234567890' ORDER BY generation"));assert.equal(generations.rows.length,2);assert.deepEqual(generations.rows.map(row=>({generation:row.generation,state:row.state,ticket:row.zammad_ticket_id})),[{generation:1,state:"DETACHED",ticket:"501"},{generation:2,state:"OPEN",ticket:"502"}]);assert.equal(generations.rows[0].replaced_by_correlation_id,generations.rows[1].id);assert.equal(generations.rows[1].predecessor_correlation_id,generations.rows[0].id);
    const crossTenantLifecycle=await tenant("20000000-0000-4000-8000-000000000002",()=>app.query("SELECT id FROM case_correlations WHERE normalized_reference='1234567890'"));assert.equal(crossTenantLifecycle.rowCount,0);
    await assert.rejects(()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("INSERT INTO case_correlations (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,generation) VALUES ('10000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000001','1234567890','503','10503','OPEN',3)")),error=>error.code==="23505");
  }finally{await lifecycleCorrelationRepository.close()}
  const lifecyclePrivileges=await app.query(`SELECT
    has_function_privilege('public','app.claim_connection_operations(uuid, integer)','EXECUTE') AS public_claim,
    has_function_privilege('public','app.queue_due_group_syncs(integer)','EXECUTE') AS public_sync,
    has_function_privilege('public','app.complete_connection_operation(uuid, uuid, bigint, jsonb)','EXECUTE') AS public_complete,
    has_function_privilege('public','app.fail_connection_operation(uuid, uuid, bigint, boolean, text, text, timestamptz)','EXECUTE') AS public_fail,
    has_function_privilege('public','app.acquire_provider_session_lease(uuid, text, interval)','EXECUTE') AS public_acquire,
    has_function_privilege('public','app.renew_provider_session_lease(uuid, text, bigint, interval)','EXECUTE') AS public_renew,
    has_function_privilege('wasalx_app','app.claim_connection_operations(uuid, integer)','EXECUTE') AS app_claim,
    has_function_privilege('wasalx_connector_worker','app.claim_connection_operations(uuid, integer)','EXECUTE') AS worker_claim,
    has_function_privilege('wasalx_connector_worker','app.queue_due_group_syncs(integer)','EXECUTE') AS worker_sync,
    has_function_privilege('wasalx_connector_worker','app.purge_expired_unmatched_events(interval, timestamptz)','EXECUTE') AS worker_purge`);
  assert.deepEqual(lifecyclePrivileges.rows[0],{public_claim:false,public_sync:false,public_complete:false,public_fail:false,public_acquire:false,public_renew:false,app_claim:true,worker_claim:true,worker_sync:true,worker_purge:true});
  await workerTenant("10000000-0000-4000-8000-000000000001",async()=>{
    await connectorWorker.query("SAVEPOINT lifecycle_worker_execute_probe");
    await connectorWorker.query("SELECT id FROM app.claim_connection_operations($1,1)",["17100000-0000-4000-8000-000000000099"]);
    await connectorWorker.query("SELECT app.queue_due_group_syncs(1)");
    await connectorWorker.query("ROLLBACK TO SAVEPOINT lifecycle_worker_execute_probe");
  });
  const tenantAdministrationPrivileges=await app.query(`SELECT
    has_function_privilege('wasalx_app','app.claim_invitation_email_jobs(uuid, integer)','EXECUTE') AS app_mail_claim,
    has_function_privilege('wasalx_invitation_mailer','app.claim_invitation_email_jobs(uuid, integer)','EXECUTE') AS mailer_claim,
    has_function_privilege('wasalx_app','app.accept_tenant_invitation(text, text, text, text)','EXECUTE') AS app_accept_invitation,
    has_function_privilege('wasalx_app','app.activate_tenant_identity_policy(uuid, bigint, text)','EXECUTE') AS app_activate_policy,
    has_function_privilege('wasalx_provisioning_client','app.activate_tenant_identity_policy(uuid, bigint, text)','EXECUTE') AS provisioner_activate_policy,
    has_table_privilege('wasalx_app','tenant_invitations','SELECT') AS app_read_invitation_table,
    has_table_privilege('wasalx_app','tenant_invitations','INSERT') AS app_insert_invitation_table,
    has_table_privilege('wasalx_app','tenant_invitations','UPDATE') AS app_update_invitation_table,
    has_table_privilege('wasalx_app','tenant_invitations','DELETE') AS app_delete_invitation,
    has_column_privilege('wasalx_app','tenant_invitations','email','SELECT') AS app_read_invitation_email,
    has_column_privilege('wasalx_app','tenant_invitations','token_hash','SELECT') AS app_read_invitation_token_hash,
    has_column_privilege('wasalx_app','tenant_invitations','create_idempotency_key','SELECT') AS app_read_invitation_create_key,
    has_column_privilege('wasalx_app','tenant_invitations','create_request_sha256','SELECT') AS app_read_invitation_request_hash,
    has_column_privilege('wasalx_app','tenant_invitations','token_hash','INSERT') AS app_insert_invitation_token_hash,
    has_column_privilege('wasalx_app','tenant_invitations','token_hash','UPDATE') AS app_update_invitation_token_hash,
    has_column_privilege('wasalx_app','tenant_invitations','accepted_by','UPDATE') AS app_update_invitation_acceptance,
    has_table_privilege('wasalx_app','tenant_invitation_email_outbox','SELECT') AS app_read_invite_table,
    has_column_privilege('wasalx_app','tenant_invitation_email_outbox','recipient_email','SELECT') AS app_read_invite_recipient,
    has_column_privilege('wasalx_app','tenant_invitation_email_outbox','token_ciphertext','SELECT') AS app_read_invite_ciphertext,
    has_column_privilege('wasalx_app','tenant_invitation_email_outbox','token_key_version','SELECT') AS app_read_invite_key_version,
    has_column_privilege('wasalx_app','tenant_invitation_email_outbox','idempotency_key','SELECT') AS app_read_invite_idempotency,
    has_column_privilege('wasalx_app','tenant_invitation_email_outbox','request_sha256','SELECT') AS app_read_invite_request_hash,
    has_column_privilege('wasalx_app','tenant_invitation_email_outbox','token_ciphertext','INSERT') AS app_insert_invite_ciphertext,
    has_column_privilege('wasalx_invitation_mailer','tenant_invitation_email_outbox','token_ciphertext','SELECT') AS mailer_read_invite_ciphertext`);
  assert.deepEqual(tenantAdministrationPrivileges.rows[0],{
    app_mail_claim:false,mailer_claim:true,app_accept_invitation:true,
    app_activate_policy:false,provisioner_activate_policy:true,
    app_read_invitation_table:false,app_insert_invitation_table:false,app_update_invitation_table:false,
    app_delete_invitation:false,app_read_invitation_email:true,app_read_invitation_token_hash:false,
    app_read_invitation_create_key:false,app_read_invitation_request_hash:false,
    app_insert_invitation_token_hash:true,app_update_invitation_token_hash:true,
    app_update_invitation_acceptance:false,
    app_read_invite_table:false,app_read_invite_recipient:false,app_read_invite_ciphertext:false,
    app_read_invite_key_version:false,app_read_invite_idempotency:true,app_read_invite_request_hash:true,
    app_insert_invite_ciphertext:true,mailer_read_invite_ciphertext:true,
  });
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT token_ciphertext FROM tenant_invitation_email_outbox LIMIT 1")),
    error=>error.code==="42501",
  );
  await assert.rejects(
    ()=>tenant("10000000-0000-4000-8000-000000000001",()=>app.query("SELECT token_hash,create_idempotency_key,create_request_sha256 FROM tenant_invitations LIMIT 1")),
    error=>error.code==="42501",
  );
  await app.query("BEGIN");
  try{
    await app.query("SELECT set_config('app.tenant_id',$1,true)",["10000000-0000-4000-8000-000000000001"]);
    const permittedInvitationInsert=await app.query(`INSERT INTO tenant_invitations (
      tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256
    ) VALUES ($1,$2,$3,'agent',$4,now()+interval '1 day',$5,$6,$7) RETURNING id,email,state,version`,[
      "10000000-0000-4000-8000-000000000001","acl-proof@a.invalid","ACL Proof","1".repeat(64),
      "10100000-0000-4000-8000-000000000001","postgres-invitation-acl-proof","2".repeat(64),
    ]);
    assert.deepEqual(permittedInvitationInsert.rows.map(({email,state,version})=>({email,state,version})),[
      {email:"acl-proof@a.invalid",state:"PENDING",version:"1"},
    ]);
    const proofInvitationId=permittedInvitationInsert.rows[0].id;
    const permittedInviteInsert=await app.query(`INSERT INTO tenant_invitation_email_outbox (
      tenant_id,invitation_id,action,recipient_email,token_ciphertext,token_key_version,idempotency_key,request_sha256
    ) VALUES ($1,$2,'RESEND',$3,$4,$5,$6,$7) RETURNING state`,[
      "10000000-0000-4000-8000-000000000001",proofInvitationId,"acl-proof@a.invalid",
      Buffer.from("ab".repeat(128),"hex"),"local-v1","postgres-invitation-insert-proof","7".repeat(64),
    ]);
    assert.deepEqual(permittedInviteInsert.rows,[{state:"PENDING"}]);
    const permittedInvitationUpdate=await app.query(`UPDATE tenant_invitations
      SET token_hash=$3,expires_at=now()+interval '2 days',state='PENDING',version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING state,version`,[
      "10000000-0000-4000-8000-000000000001",proofInvitationId,"3".repeat(64),
    ]);
    assert.deepEqual(permittedInvitationUpdate.rows,[{state:"PENDING",version:"2"}]);
  }finally{await app.query("ROLLBACK")}
  const acceptedInvitation=await app.query(
    "SELECT tenant_id,user_id,membership_role FROM app.accept_tenant_invitation($1,$2,$3,$4)",
    ["d".repeat(64),"oidc-invitee-a","invitee@a.invalid","Invitee A"],
  );
  assert.equal(acceptedInvitation.rows[0].tenant_id,"10000000-0000-4000-8000-000000000001");
  assert.equal(acceptedInvitation.rows[0].membership_role,"agent");
  await assert.rejects(()=>app.query(
    "SELECT tenant_id,user_id,membership_role FROM app.accept_tenant_invitation($1,$2,$3,$4)",[
      "d".repeat(64),"oidc-invitee-a","invitee@a.invalid","Invitee A",
    ],
  ),error=>error.code==="P0002");
  const acceptedInvitationEvidence=await tenant("10000000-0000-4000-8000-000000000001",()=>app.query(`SELECT
    (SELECT count(*)::integer FROM tenant_memberships WHERE user_id=$1) AS memberships,
    (SELECT count(*)::integer FROM audit_events WHERE action='team.invitation_accepted' AND actor_id=$1::text) AS audits`,[
      acceptedInvitation.rows[0].user_id,
    ]));
  assert.deepEqual(acceptedInvitationEvidence.rows,[{memberships:1,audits:1}]);
  const invitationBoundaryAdmin=new Client({connectionString:adminUrl});await invitationBoundaryAdmin.connect();
  try{
    await invitationBoundaryAdmin.query(
      "UPDATE tenant_invitations SET expires_at=now()-interval '1 hour' WHERE token_hash=$1",["d".repeat(64)],
    );
    await assert.rejects(()=>app.query(
      "SELECT tenant_id,user_id,membership_role FROM app.accept_tenant_invitation($1,$2,$3,$4)",[
        "d".repeat(64),"oidc-invitee-a","invitee@a.invalid","Invitee A",
      ],
    ),error=>error.code==="P0002");

    const normalizedRaceEmail="normalized-race@wasalx.invalid";
    await invitationBoundaryAdmin.query(`INSERT INTO tenant_invitations
      (tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256)
      VALUES
      ('10000000-0000-4000-8000-000000000001',$1,'Race A','agent',$2,now()+interval '1 day','10100000-0000-4000-8000-000000000001','normalized-race-a',repeat('8',64)),
      ('20000000-0000-4000-8000-000000000002',$1,'Race B','agent',$3,now()+interval '1 day','20200000-0000-4000-8000-000000000002','normalized-race-b',repeat('9',64))`,[
      normalizedRaceEmail,"e".repeat(64),"f".repeat(64),
    ]);
    const invitationRaceClients=[new Client({connectionString:appUrl}),new Client({connectionString:appUrl})];
    await Promise.all(invitationRaceClients.map(client=>client.connect()));
    try{
      const invitationRace=async(client,token,subject)=>{
        try{return await client.query(
          "SELECT tenant_id,user_id,membership_role FROM app.accept_tenant_invitation($1,$2,$3,$4)",[
            token,subject,normalizedRaceEmail,"Normalized race",
          ],
        )}catch(error){return error}
      };
      const raceResults=await Promise.all([
        invitationRace(invitationRaceClients[0],"e".repeat(64),"normalized-race-a"),
        invitationRace(invitationRaceClients[1],"f".repeat(64),"normalized-race-b"),
      ]);
      assert.equal(raceResults.filter(result=>Array.isArray(result?.rows)&&result.rows.length===1).length,1);
      assert.equal(raceResults.filter(result=>result?.code==="23505").length,1);
      assert.equal((await invitationBoundaryAdmin.query(
        "SELECT count(*)::integer AS count FROM users WHERE lower(email)=lower($1)",[normalizedRaceEmail],
      )).rows[0].count,1);
      assert.equal((await invitationBoundaryAdmin.query(`SELECT count(*)::integer AS count FROM audit_events
        WHERE action='team.invitation_accepted' AND actor_id=(SELECT id::text FROM users WHERE lower(email)=lower($1))`,[
        normalizedRaceEmail,
      ])).rows[0].count,1);
      assert.deepEqual((await invitationBoundaryAdmin.query(`SELECT
        (SELECT count(*)::integer FROM tenant_memberships member JOIN users identity ON identity.id=member.user_id
          WHERE lower(identity.email)=lower($1)) AS memberships,
        (SELECT count(*)::integer FROM tenant_invitations WHERE lower(email)=lower($1) AND state='ACCEPTED') AS accepted_invitations`,[
        normalizedRaceEmail,
      ])).rows,[{memberships:1,accepted_invitations:1}]);
    }finally{await Promise.all(invitationRaceClients.map(client=>client.end()))}

    const suspendedTenant="73000000-0000-4000-8000-000000000003";
    const suspendedToken="7".repeat(64);
    await invitationBoundaryAdmin.query("BEGIN");
    await invitationBoundaryAdmin.query(`INSERT INTO tenants(id,name,slug,state)
      VALUES ($1,'Suspension race','suspension-race','ACTIVE')`,[suspendedTenant]);
    await invitationBoundaryAdmin.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role,state)
      VALUES ($1,'10100000-0000-4000-8000-000000000001','tenant_owner','ACTIVE')`,[suspendedTenant]);
    await invitationBoundaryAdmin.query(`INSERT INTO tenant_invitations
      (tenant_id,email,display_name,role,token_hash,expires_at,invited_by,create_idempotency_key,create_request_sha256)
      VALUES ($1,'suspension-race@wasalx.invalid','Suspension invitee','agent',$2,now()+interval '1 day',
        '10100000-0000-4000-8000-000000000001','suspension-race',repeat('6',64))`,[suspendedTenant,suspendedToken]);
    await invitationBoundaryAdmin.query("COMMIT");
    await invitationBoundaryAdmin.query("BEGIN");
    await invitationBoundaryAdmin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[suspendedTenant]);
    const suspendedAcceptanceClient=new Client({connectionString:appUrl});await suspendedAcceptanceClient.connect();
    try{
      await suspendedAcceptanceClient.query("SET statement_timeout='2s'");
      const suspendedAcceptancePid=(await suspendedAcceptanceClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let suspendedAcceptanceSettled=false;
      const suspendedAcceptance=suspendedAcceptanceClient.query(
        "SELECT * FROM app.accept_tenant_invitation($1,$2,$3,$4)",[
          suspendedToken,"suspension-race-subject","suspension-race@wasalx.invalid","Suspension invitee",
        ],
      ).then(result=>result,error=>error).finally(()=>{suspendedAcceptanceSettled=true});
      let suspendedAcceptanceBlocked=false;
      for(let attempt=0;attempt<100&&!suspendedAcceptanceBlocked;attempt+=1){
        suspendedAcceptanceBlocked=(await invitationBoundaryAdmin.query(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[suspendedAcceptancePid],
        )).rows[0].blocked;
        if(!suspendedAcceptanceBlocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      const suspendedAcceptanceSettledBeforeUnlock=suspendedAcceptanceSettled;
      await invitationBoundaryAdmin.query("COMMIT");
      const suspendedAcceptanceResult=await suspendedAcceptance;
      assert.equal(suspendedAcceptanceBlocked,true);
      assert.equal(suspendedAcceptanceSettledBeforeUnlock,false);
      assert.equal(suspendedAcceptanceResult.code,"P0002");
    }finally{await suspendedAcceptanceClient.end()}
    assert.deepEqual((await invitationBoundaryAdmin.query(`SELECT
      (SELECT count(*)::integer FROM users WHERE oidc_subject='suspension-race-subject') AS users,
      (SELECT count(*)::integer FROM tenant_memberships member JOIN users identity ON identity.id=member.user_id
        WHERE member.tenant_id=$1 AND identity.oidc_subject='suspension-race-subject') AS memberships,
      (SELECT count(*)::integer FROM audit_events WHERE tenant_id=$1 AND action='team.invitation_accepted') AS audits,
      (SELECT count(*)::integer FROM tenant_invitations WHERE tenant_id=$1 AND state='ACCEPTED') AS accepted_invitations`,[
      suspendedTenant,
    ])).rows,[{users:0,memberships:0,audits:0,accepted_invitations:0}]);
  }finally{
    await invitationBoundaryAdmin.query("ROLLBACK").catch(()=>undefined);
    await invitationBoundaryAdmin.end();
  }

  const providerStatusRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));
  const providerStatusEvent={id:"status-fence-event",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001",provider:"waha",providerEventId:"status-fence-1",eventType:"session.status",payload:{},attempts:1};
  const scanDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const scanDatabase=new DatabaseService();
  const scanService=new WahaAuthorizationService(scanDatabase,{},{});
  const scanRequest={id:"request-postgres-scan",principal:{subject:"oidc-owner-a",userId:"10100000-0000-4000-8000-000000000001",tenantId:providerStatusEvent.tenantId,email:"owner@a.invalid",displayName:"Owner A",role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
  try{
    await tenant(providerStatusEvent.tenantId,()=>app.query(`UPDATE connections SET state='AWAITING_AUTH' WHERE tenant_id=$1 AND id=$2`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    await tenant(providerStatusEvent.tenantId,()=>app.query(`UPDATE provider_sessions
      SET state='AWAITING_AUTH',provider_state='SCAN_QR_CODE',last_provider_status_at='2026-08-09T15:58:00.000Z',
          onboarding_qr_ready_at=clock_timestamp()-interval '1 second',onboarding_authorization_method='QR',
          onboarding_scan_acknowledged_at=NULL,onboarding_scan_completed_at=NULL,onboarding_working_at=NULL
      WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    await assert.rejects(
      ()=>tenant(providerStatusEvent.tenantId,()=>app.query(`UPDATE provider_sessions
        SET onboarding_scan_acknowledged_at='2026-08-09T15:57:59.000Z'
        WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId])),
      error=>error.code==="23514",
    );
    const onboardingIdentity=(await tenant(providerStatusEvent.tenantId,()=>app.query(`SELECT c.phone_e164,ps.waha_worker_id
      FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id
      WHERE c.tenant_id=$1 AND c.id=$2 AND ps.ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]))).rows[0];
    assert.ok(onboardingIdentity.phone_e164);assert.ok(onboardingIdentity.waha_worker_id);
    const eligibleAcknowledgement=await scanService.scanComplete(scanRequest,providerStatusEvent.connectionId);
    const eligibleReplay=await scanService.scanComplete({...scanRequest,id:"request-postgres-scan-replay"},providerStatusEvent.connectionId);
    assert.equal(eligibleReplay.duplicate,true);
    assert.equal((await tenant(providerStatusEvent.tenantId,()=>app.query(`SELECT count(*)::int AS count FROM audit_events
      WHERE tenant_id=$1 AND target_id=$2 AND action='connection.auth_scan_completed'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]))).rows[0].count,1);
    const identity={phoneE164:onboardingIdentity.phone_e164,pinnedWahaWorkerId:onboardingIdentity.waha_worker_id};
    const eligibleWorkingAt=new Date(new Date(eligibleAcknowledgement.acknowledgedAt).getTime()+1).toISOString();
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"onboarding-eligible"},{opaqueSessionId:"session-a",observedAt:eligibleWorkingAt,providerState:"WORKING",connectionState:"WORKING"},identity),"APPLIED");
    const eligibleOnboarding=(await tenant(providerStatusEvent.tenantId,()=>app.query(`SELECT onboarding_scan_acknowledged_at,onboarding_scan_completed_at,onboarding_working_at
      FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]))).rows[0];
    assert.equal(new Date(eligibleOnboarding.onboarding_scan_completed_at).toISOString(),new Date(eligibleOnboarding.onboarding_scan_acknowledged_at).toISOString());
    assert.equal(new Date(eligibleOnboarding.onboarding_working_at).toISOString(),eligibleWorkingAt);
    const newQrAt=new Date(new Date(eligibleWorkingAt).getTime()+1).toISOString();
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"onboarding-new-qr"},{opaqueSessionId:"session-a",observedAt:newQrAt,providerState:"SCAN_QR_CODE",connectionState:"AWAITING_AUTH"}),"APPLIED");
    const resetOnboarding=(await tenant(providerStatusEvent.tenantId,()=>app.query(`SELECT onboarding_scan_acknowledged_at,onboarding_scan_completed_at,onboarding_working_at
      FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]))).rows[0];
    assert.deepEqual(resetOnboarding,{onboarding_scan_acknowledged_at:null,onboarding_scan_completed_at:null,onboarding_working_at:null});
    await waitUntil(new Date(newQrAt).getTime()+2);
    await scanService.scanComplete({...scanRequest,id:"request-postgres-scan-rotation"},providerStatusEvent.connectionId);
    const rotatedQrAt=new Date(Math.max(Date.now(),new Date(newQrAt).getTime())+20).toISOString();
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"onboarding-rotated-qr"},{opaqueSessionId:"session-a",observedAt:rotatedQrAt,providerState:"SCAN_QR_CODE",connectionState:"AWAITING_AUTH"}),"APPLIED");
    const rotatedQr=(await tenant(providerStatusEvent.tenantId,()=>app.query(`SELECT onboarding_qr_ready_at,onboarding_scan_acknowledged_at,onboarding_scan_completed_at,onboarding_working_at
      FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]))).rows[0];
    assert.equal(new Date(rotatedQr.onboarding_qr_ready_at).toISOString(),rotatedQrAt);
    assert.deepEqual({ack:rotatedQr.onboarding_scan_acknowledged_at,scan:rotatedQr.onboarding_scan_completed_at,working:rotatedQr.onboarding_working_at},{ack:null,scan:null,working:null});
    const lateWorkingAt=new Date(new Date(rotatedQrAt).getTime()+1).toISOString();
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"onboarding-late"},{opaqueSessionId:"session-a",observedAt:lateWorkingAt,providerState:"WORKING",connectionState:"WORKING"},identity),"APPLIED");
    await waitUntil(new Date(lateWorkingAt).getTime()+50);
    const lateAcknowledgement=await scanService.scanComplete({...scanRequest,id:"request-postgres-scan-late"},providerStatusEvent.connectionId);
    assert.equal(lateAcknowledgement.lateAcknowledgement,true);
    const lateOnboarding=(await tenant(providerStatusEvent.tenantId,()=>app.query(`SELECT onboarding_scan_acknowledged_at,onboarding_scan_completed_at,onboarding_working_at
      FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]))).rows[0];
    assert.equal(lateOnboarding.onboarding_scan_completed_at,null);
    assert.ok(new Date(lateOnboarding.onboarding_scan_acknowledged_at)>new Date(lateOnboarding.onboarding_working_at));
    await tenant(providerStatusEvent.tenantId,()=>app.query(`UPDATE provider_sessions
      SET state='WORKING',provider_state='WORKING',last_provider_status_at=NULL,
          onboarding_qr_ready_at=NULL,onboarding_scan_acknowledged_at=NULL,
          onboarding_scan_completed_at=NULL,onboarding_working_at=NULL
      WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    await tenant(providerStatusEvent.tenantId,()=>app.query(`UPDATE connections SET state='WORKING' WHERE tenant_id=$1 AND id=$2`,[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    assert.equal(await providerStatusRepository.applyProviderStatus(providerStatusEvent,{opaqueSessionId:"session-a",observedAt:"2026-08-09T16:00:00.000Z",providerState:"DISCONNECTED",connectionState:"DEGRADED",reason:"Provider session reported DISCONNECTED"}),"APPLIED");
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"status-fence-stale"},{opaqueSessionId:"session-a",observedAt:"2026-08-09T15:59:59.000Z",providerState:"WORKING",connectionState:"WORKING"}),"IGNORED");
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"status-fence-generation"},{opaqueSessionId:"retired-session-a",observedAt:"2026-08-09T16:00:01.000Z",providerState:"WORKING",connectionState:"WORKING"}),"IGNORED");
    const fencedState=await tenant(providerStatusEvent.tenantId,()=>app.query("SELECT c.state,ps.provider_state,ps.last_provider_status_at FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE' WHERE c.tenant_id=$1 AND c.id=$2",[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    assert.equal(fencedState.rows[0].state,"DEGRADED");assert.equal(fencedState.rows[0].provider_state,"DISCONNECTED");assert.equal(new Date(fencedState.rows[0].last_provider_status_at).toISOString(),"2026-08-09T16:00:00.000Z");

    await tenant(providerStatusEvent.tenantId,()=>app.query("INSERT INTO connection_operations (tenant_id,connection_id,operation_type,idempotency_key,requested_by_type,requested_by_id,request_id) VALUES ($1,$2,'RESTART','status-fence-pending','SYSTEM','status-fence-test','status-fence-pending')",[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"status-fence-pending"},{opaqueSessionId:"session-a",observedAt:"2026-08-09T16:00:02.000Z",providerState:"WORKING",connectionState:"WORKING"}),"IGNORED");
    await tenant(providerStatusEvent.tenantId,()=>app.query("UPDATE connection_operations SET state='CANCELLED',completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND idempotency_key='status-fence-pending'",[providerStatusEvent.tenantId]));
    await tenant(providerStatusEvent.tenantId,()=>app.query("UPDATE connections SET state='PAUSED' WHERE tenant_id=$1 AND id=$2",[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"status-fence-paused"},{opaqueSessionId:"session-a",observedAt:"2026-08-09T16:00:03.000Z",providerState:"WORKING",connectionState:"WORKING"}),"IGNORED");
    await tenant(providerStatusEvent.tenantId,()=>app.query("UPDATE connections SET state='REVOKED' WHERE tenant_id=$1 AND id=$2",[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
    assert.equal(await providerStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"status-fence-revoked"},{opaqueSessionId:"session-a",observedAt:"2026-08-09T16:00:04.000Z",providerState:"WORKING",connectionState:"WORKING"}),"IGNORED");
    await tenant(providerStatusEvent.tenantId,()=>app.query("UPDATE connections SET state='WORKING' WHERE tenant_id=$1 AND id=$2",[providerStatusEvent.tenantId,providerStatusEvent.connectionId]));
  }finally{await providerStatusRepository.close();await scanDatabase.onModuleDestroy();if(scanDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=scanDatabaseUrl}

  const previousDatabaseUrl=process.env.DATABASE_URL;process.env.DATABASE_URL=appUrl;
  const lifecycleDatabase=new DatabaseService();const wakeCalls=[];
  const readinessAdmin=new Client({connectionString:adminUrl});await readinessAdmin.connect();
  const lifecycleController=new ConnectionsController(lifecycleDatabase,{}, {wakeConnection:async tenantId=>wakeCalls.push(tenantId)});
  const ownerRequest={id:"request-postgres-lifecycle",principal:{subject:"oidc-owner-a",userId:"10100000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",email:"owner@a.invalid",displayName:"Owner A",role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
  try{
    const readinessSession=(await readinessAdmin.query("SELECT id,waha_worker_id,assignment_fencing_token,assignment_lease_expires_at,assigned_at,last_provider_status_at,state,provider_state FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'",[ownerRequest.principal.tenantId,providerStatusEvent.connectionId])).rows[0];
    assert.ok(readinessSession?.waha_worker_id,"readiness fixture needs its existing worker assignment");
    const readinessWorker=(await readinessAdmin.query("SELECT health_state,lifecycle_state,last_heartbeat_at,last_started_at FROM waha_workers WHERE id=$1",[readinessSession.waha_worker_id])).rows[0];
    const assertWorkerReady=async expected=>{
      assert.equal((await lifecycleController.list(ownerRequest)).find(row=>row.id===providerStatusEvent.connectionId)?.worker_ready,expected);
      assert.equal((await lifecycleController.detail(ownerRequest,providerStatusEvent.connectionId)).worker_ready,expected);
    };
    try{
      await readinessAdmin.query("UPDATE waha_workers SET health_state='HEALTHY',lifecycle_state='ACTIVE',last_heartbeat_at=now(),last_started_at=now()-interval '1 minute' WHERE id=$1",[readinessSession.waha_worker_id]);
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET assignment_lease_expires_at=now()+interval '5 minutes',last_provider_status_at=now(),state='WORKING',provider_state='WORKING' WHERE id=$1",[readinessSession.id]));
      await assertWorkerReady(true);
      const unrelatedWorker=(await readinessAdmin.query(`INSERT INTO waha_workers
        (worker_key,engine,base_url,secret_reference,capacity,last_started_at)
        VALUES ('readiness-unrelated-boot','GOWS','http://unrelated.internal:3000/','secret://platform/waha/unrelated',1,now()+interval '1 day') RETURNING id`)).rows[0].id;
      try{await assertWorkerReady(true)}finally{await readinessAdmin.query("DELETE FROM waha_workers WHERE id=$1",[unrelatedWorker])}
      // The node has restarted, but its surviving WORKING row belongs to the old boot.
      const restartedWorker=(await readinessAdmin.query("UPDATE waha_workers SET last_started_at=clock_timestamp() WHERE id=$1 RETURNING last_started_at",[readinessSession.waha_worker_id])).rows[0];
      await assertWorkerReady(false);
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET last_provider_status_at=NULL WHERE id=$1",[readinessSession.id]));
      await assertWorkerReady(false);
      // A current, identity-verified WORKING callback restores readiness without a QR milestone.
      const restoredStatusRepository=new InboundRepository(new Pool({...connectorWorkerConfig,max:1}));
      const restoredStatusAt=new Date(Math.max(Date.now(),new Date(restartedWorker.last_started_at).getTime()+1)).toISOString();
      const restoredIdentity=(await readinessAdmin.query("SELECT phone_e164 FROM connections WHERE tenant_id=$1 AND id=$2",[ownerRequest.principal.tenantId,providerStatusEvent.connectionId])).rows[0];
      try{
        assert.equal(await restoredStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"readiness-after-boot"},{opaqueSessionId:"session-a",observedAt:restoredStatusAt,providerState:"WORKING",connectionState:"WORKING"},{phoneE164:restoredIdentity.phone_e164,pinnedWahaWorkerId:readinessSession.waha_worker_id}),"APPLIED");
        await assertWorkerReady(true);
        assert.equal((await lifecycleController.detail(ownerRequest,providerStatusEvent.connectionId)).onboarding_working_at,null);
        const stoppedStatusAt=new Date(Date.parse(restoredStatusAt)+1).toISOString();
        assert.equal(await restoredStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"readiness-current-stopped"},{opaqueSessionId:"session-a",observedAt:stoppedStatusAt,providerState:"STOPPED",connectionState:"ACTION_REQUIRED",reason:"Provider session reported STOPPED"}),"APPLIED");
        assert.equal((await lifecycleController.detail(ownerRequest,providerStatusEvent.connectionId)).state,"ACTION_REQUIRED");
        assert.equal((await lifecycleController.list(ownerRequest)).find(row=>row.id===providerStatusEvent.connectionId).provider_state,"STOPPED");
        assert.equal(await restoredStatusRepository.applyProviderStatus({...providerStatusEvent,providerEventId:"readiness-old-working"},{opaqueSessionId:"session-a",observedAt:restoredStatusAt,providerState:"WORKING",connectionState:"WORKING"},{phoneE164:restoredIdentity.phone_e164,pinnedWahaWorkerId:readinessSession.waha_worker_id}),"IGNORED");
        assert.equal((await lifecycleController.detail(ownerRequest,providerStatusEvent.connectionId)).state,"ACTION_REQUIRED");
      }finally{await restoredStatusRepository.close()}
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE connections SET state='WORKING',action_reason=NULL WHERE id=$1",[providerStatusEvent.connectionId]));
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET state='WORKING',provider_state='WORKING',last_provider_status_at=now() WHERE id=$1",[readinessSession.id]));
      await readinessAdmin.query("UPDATE waha_workers SET last_started_at=NULL WHERE id=$1",[readinessSession.waha_worker_id]);
      await assertWorkerReady(false);
      await readinessAdmin.query("UPDATE waha_workers SET last_started_at=now()-interval '1 minute' WHERE id=$1",[readinessSession.waha_worker_id]);
      await assertWorkerReady(true);
      await readinessAdmin.query("UPDATE waha_workers SET lifecycle_state='DRAINING' WHERE id=$1",[readinessSession.waha_worker_id]);
      await assertWorkerReady(true);
      await readinessAdmin.query("UPDATE waha_workers SET health_state='UNHEALTHY' WHERE id=$1",[readinessSession.waha_worker_id]);
      await assertWorkerReady(false);
      await readinessAdmin.query("UPDATE waha_workers SET health_state='HEALTHY',last_heartbeat_at=now()-make_interval(secs=>heartbeat_ttl_seconds+60) WHERE id=$1",[readinessSession.waha_worker_id]);
      await assertWorkerReady(false);
      await readinessAdmin.query("UPDATE waha_workers SET last_heartbeat_at=now() WHERE id=$1",[readinessSession.waha_worker_id]);
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET assignment_lease_expires_at=now()-interval '1 minute' WHERE id=$1",[readinessSession.id]));
      await assertWorkerReady(false);
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET waha_worker_id=NULL,assignment_fencing_token=0,assignment_lease_expires_at=NULL,assigned_at=NULL WHERE id=$1",[readinessSession.id]));
      await assertWorkerReady(false);
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET waha_worker_id=$2,assignment_fencing_token=$3,assignment_lease_expires_at=now()+interval '5 minutes',assigned_at=$4 WHERE id=$1",[readinessSession.id,readinessSession.waha_worker_id,readinessSession.assignment_fencing_token,readinessSession.assigned_at]));
      await assertWorkerReady(true);
      const otherTenantRequest={...ownerRequest,principal:{...ownerRequest.principal,tenantId:"20000000-0000-4000-8000-000000000002"}};
      assert.equal((await lifecycleController.list(otherTenantRequest)).some(row=>row.id===providerStatusEvent.connectionId),false);
      await assert.rejects(()=>lifecycleController.detail(otherTenantRequest,providerStatusEvent.connectionId),error=>error.getStatus?.()===404);
      assert.deepEqual(await lifecycleDatabase.rows(otherTenantRequest.principal.tenantId,"SELECT * FROM app.current_waha_session_runtime($1)",[readinessSession.id]),[]);
      assert.equal((await lifecycleDatabase.rows(ownerRequest.principal.tenantId,"SELECT last_started_at FROM app.current_waha_session_runtime($1)",[readinessSession.id])).length,1);
    }finally{
      await withFixtureTenant(readinessAdmin,ownerRequest.principal.tenantId,()=>readinessAdmin.query("UPDATE provider_sessions SET waha_worker_id=$2,assignment_fencing_token=$3,assignment_lease_expires_at=$4,assigned_at=$5,last_provider_status_at=$6,state=$7,provider_state=$8 WHERE id=$1",[readinessSession.id,readinessSession.waha_worker_id,readinessSession.assignment_fencing_token,readinessSession.assignment_lease_expires_at,readinessSession.assigned_at,readinessSession.last_provider_status_at,readinessSession.state,readinessSession.provider_state]));
      await readinessAdmin.query("UPDATE waha_workers SET health_state=$2,lifecycle_state=$3,last_heartbeat_at=$4,last_started_at=$5 WHERE id=$1",[readinessSession.waha_worker_id,readinessWorker.health_state,readinessWorker.lifecycle_state,readinessWorker.last_heartbeat_at,readinessWorker.last_started_at]);
    }
    const pauseResult=await lifecycleController.pause(ownerRequest,providerStatusEvent.connectionId,"postgres-pause-route");assert.equal(pauseResult.state,"WORKING");
    const pauseEvidence=await tenant(ownerRequest.principal.tenantId,()=>app.query("SELECT c.state AS connection_state,r.state AS route_state,o.state AS operation_state FROM connections c JOIN webhook_routes r ON r.tenant_id=c.tenant_id AND r.connection_id=c.id JOIN connection_operations o ON o.tenant_id=c.tenant_id AND o.connection_id=c.id AND o.idempotency_key='postgres-pause-route' WHERE c.tenant_id=$1 AND c.id=$2",[ownerRequest.principal.tenantId,providerStatusEvent.connectionId]));
    assert.deepEqual(pauseEvidence.rows,[{connection_state:"WORKING",route_state:"PAUSED",operation_state:"QUEUED"}]);
    await tenant(ownerRequest.principal.tenantId,()=>app.query("UPDATE connection_operations SET state='CANCELLED',completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND idempotency_key='postgres-pause-route'",[ownerRequest.principal.tenantId]));
    const disconnectResult=await lifecycleController.disconnect({...ownerRequest,id:"request-postgres-disconnect"},providerStatusEvent.connectionId,"postgres-disconnect-route",{confirmation:"DISCONNECT"});assert.equal(disconnectResult.state,"WORKING");
    const disconnectEvidence=await tenant(ownerRequest.principal.tenantId,()=>app.query("SELECT c.state AS connection_state,r.state AS route_state,o.state AS operation_state FROM connections c JOIN webhook_routes r ON r.tenant_id=c.tenant_id AND r.connection_id=c.id JOIN connection_operations o ON o.tenant_id=c.tenant_id AND o.connection_id=c.id AND o.idempotency_key='postgres-disconnect-route' WHERE c.tenant_id=$1 AND c.id=$2",[ownerRequest.principal.tenantId,providerStatusEvent.connectionId]));
    assert.deepEqual(disconnectEvidence.rows,[{connection_state:"WORKING",route_state:"PAUSED",operation_state:"QUEUED"}]);

    const tenantBRequest={id:"request-postgres-route-rollback",principal:{subject:"oidc-owner-b",userId:"20200000-0000-4000-8000-000000000002",tenantId:"20000000-0000-4000-8000-000000000002",email:"owner@b.invalid",displayName:"Owner B",role:"tenant_owner"}};
    await assert.rejects(()=>lifecycleController.pause(tenantBRequest,"23000000-0000-4000-8000-000000000002","postgres-pause-missing-route"),error=>error?.message==="The connection webhook route is unavailable");
    const rollbackEvidence=await tenant(tenantBRequest.principal.tenantId,()=>app.query("SELECT c.state,(SELECT count(*)::int FROM connection_operations o WHERE o.tenant_id=c.tenant_id AND o.connection_id=c.id AND o.idempotency_key='postgres-pause-missing-route') AS operation_count FROM connections c WHERE c.tenant_id=$1 AND c.id=$2",[tenantBRequest.principal.tenantId,"23000000-0000-4000-8000-000000000002"]));
    assert.deepEqual(rollbackEvidence.rows,[{state:"WORKING",operation_count:0}]);
    assert.deepEqual(wakeCalls,[ownerRequest.principal.tenantId,ownerRequest.principal.tenantId]);

    // Independent tenant: prove consent atomicity/replay with the real RLS connection pool.
    const consentTenant = "61010000-0000-4000-8000-000000000061";
    const consentConnection = "61020000-0000-4000-8000-000000000061";
    const rollbackConnection = "61020000-0000-4000-8000-000000000062";
    const consentRequest = { ...ownerRequest, id: "postgres-meta-consent", principal: { ...ownerRequest.principal, tenantId: consentTenant } };
    await readinessAdmin.query("INSERT INTO tenants(id,name,slug,state) VALUES ($1,'Meta consent fixture','meta-consent-fixture','ACTIVE')", [consentTenant]);
    await readinessAdmin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'tenant_owner')", [consentTenant,ownerRequest.principal.userId]);
    await lifecycleDatabase.withTenant(consentTenant, async client => {
      for (const id of [consentConnection, rollbackConnection]) {
        await client.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES ($1,$2,'Direct fixture','META','CLOUD_API','WORKING',$3)", [id,consentTenant,`secret://${consentTenant}/connections/${id}/meta`]);
      }
      for (const id of [consentConnection, rollbackConnection]) {
        await client.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES ($1,$2,$3,'610123456789','WORKING','meta-cloud://610987654321/610123456789','ACTIVE',$4::jsonb)", [id.replace("61020000","61030000"),consentTenant,id,JSON.stringify({wabaId:"610987654321"})]);
      }
    });
    await lifecycleDatabase.withTenant(consentTenant,client=>client.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES ($1,$2,'META','610123456789','secret://platform/meta-webhook','ACTIVE')",[consentTenant,consentConnection]));
    const consentController = new ConnectionsController(lifecycleDatabase, {}, { wakeConnection: async () => {} });
    const optIn = { eligibilityAccepted: true, eligibilityVersion: "meta-groups-pg-v1" };
    await assert.rejects(() => consentController.syncGroups(consentRequest,consentConnection,"pg-meta-no-consent"), error => error.getStatus?.() === 409);
    await assert.rejects(() => consentController.syncGroups(ownerRequest,consentConnection,"pg-meta-foreign",optIn), error => error.getStatus?.() === 404);

    const rollbackController = new ConnectionsController({ withTenant: (id, callback) => lifecycleDatabase.withTenant(id, client => callback({
      query: (sql, values) => {
        if (sql.includes("INSERT INTO consent_records")) throw new Error("injected consent persistence failure");
        return client.query(sql, values);
      },
    })) }, {}, { wakeConnection: async () => assert.fail("rolled back consent must not wake") });
    await assert.rejects(() => rollbackController.syncGroups(consentRequest,rollbackConnection,"pg-meta-rollback",optIn), /injected consent persistence failure/);
    const rolledBack = await lifecycleDatabase.withTenant(consentTenant, client => client.query(
      "SELECT c.disclosure_version,(SELECT count(*)::int FROM connection_operations o WHERE o.tenant_id=c.tenant_id AND o.connection_id=c.id) AS operations FROM connections c WHERE c.id=$1", [rollbackConnection]));
    assert.deepEqual(rolledBack.rows,[{disclosure_version:null,operations:0}]);

    const simultaneous = await Promise.all([
      consentController.syncGroups(consentRequest,consentConnection,"pg-meta-opt-in",optIn),
      consentController.syncGroups(consentRequest,consentConnection,"pg-meta-opt-in",optIn),
    ]);
    assert.equal(simultaneous[0].operation.id,simultaneous[1].operation.id);
    assert.deepEqual(simultaneous.map(value => value.duplicate).sort(),[false,true]);
    const consentEvidence = await lifecycleDatabase.withTenant(consentTenant, client => client.query(
      `SELECT c.disclosure_version,
        (SELECT count(*)::int FROM consent_records WHERE tenant_id=c.tenant_id AND policy_type='META_OFFICIAL_GROUPS') AS consents,
        (SELECT count(*)::int FROM connection_operations WHERE tenant_id=c.tenant_id AND connection_id=c.id) AS operations,
        (SELECT count(*)::int FROM audit_events WHERE tenant_id=c.tenant_id AND target_id=c.id::text AND action='connection.meta_groups_consent_accepted') AS audits
       FROM connections c WHERE c.id=$1`, [consentConnection]));
    assert.deepEqual(consentEvidence.rows,[{disclosure_version:optIn.eligibilityVersion,consents:1,operations:1,audits:1}]);
    await assert.rejects(() => consentController.syncGroups(consentRequest,consentConnection,"pg-meta-opt-in",{}),error => error.getStatus?.() === 409);
    await assert.rejects(() => consentController.syncGroups(consentRequest,consentConnection,"pg-meta-opt-in",{...optIn,eligibilityVersion:"v2"}),error => error.getStatus?.() === 409);
    const consentRepository = new ConnectionOperationRepository(new Pool({...connectorWorkerConfig,max:2}));
    const oldMetaConfig = Object.fromEntries(["META_APP_ID", "META_APP_SECRET_REFERENCE", "META_GRAPH_VERSION"].map(key => [key, process.env[key]]));
    Object.assign(process.env, {META_APP_ID:"610123456789000",META_APP_SECRET_REFERENCE:"secret://platform/meta-webhook",META_GRAPH_VERSION:"v24.0"});
    try {
      const jobs = await consentRepository.claim(consentTenant,"61040000-0000-4000-8000-000000000061",1);
      assert.equal(jobs.length,1);
      assert.equal(jobs[0].connectionId,consentConnection);
      assert.equal(jobs[0].disclosureVersion,optIn.eligibilityVersion);
      const original = jobs[0];
      const originalLease = await consentRepository.acquireProviderSessionLease(original,"61040000-0000-4000-8000-000000000061","meta-proof-original",120);
      let storedReference;
      const proofController = new ConnectionsController(lifecycleDatabase,
        {storeMetaCredential:async reference=>{storedReference=reference;}}, {wakeConnection:async()=>{}},
        {create:()=>({verifyCredentialMetadata:async(appId,appSecret)=>{
          assert.equal(appId,"610123456789000");assert.equal(appSecret,"synthetic-meta-app-secret");
          return verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:["whatsapp_business_management","whatsapp_business_messaging"],expires_at:0}},{appId});
        },verifyPhoneAccountRelationship:async()=>({schemaVersion:1,claim:"PHONE_ACCOUNT_RELATION_VERIFIED",phoneNumberId:"610123456789",wabaId:"610987654321",graphVersion:"v24.0",verifiedAt:new Date().toISOString(),responseSha256:"a".repeat(64)})})},
        {resolveHmac:async()=>"synthetic-meta-app-secret"}, {resolveAccessToken:async()=>"synthetic-meta-rotation-token-two"});
      const proofRequest = {...consentRequest,principal:{...consentRequest.principal,authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
      await proofController.rotateMetaCredential(proofRequest,consentConnection,"pg-meta-relation-rotation-one",{accessToken:"synthetic-meta-rotation-token-one"});
      const proofState = async()=> (await lifecycleDatabase.withTenant(consentTenant,client=>client.query(
        "SELECT c.secret_reference,c.state,ps.provider_state_data FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id WHERE c.id=$1",[consentConnection]))).rows[0];
      const afterRotation = await proofState();
      assert.equal(afterRotation.secret_reference,storedReference);
      assert.equal(afterRotation.provider_state_data.metaAccountProof.claim,"PHONE_ACCOUNT_RELATION_VERIFIED");
      assert.equal(afterRotation.provider_state_data.metaAccountProof.credentialMetadata.claim,"CREDENTIAL_METADATA_VERIFIED");
      const completion = await consentRepository.complete(original,"61040000-0000-4000-8000-000000000061",originalLease,
        {connectionState:"WORKING",providerState:"AVAILABLE",providerStateData:original.providerSession.providerStateData,result:{synchronized:true}});
      assert.equal(completion.result.superseded,true);
      assert.deepEqual(await proofState(),afterRotation,"old-token success must not overwrite new proof");
      const replacementLeaseId="61040000-0000-4000-8000-000000000062";
      const [replacementJob] = await consentRepository.claim(consentTenant,replacementLeaseId,1);
      assert.equal(replacementJob.operationType,"RESTART");
      const replacementLease=await consentRepository.acquireProviderSessionLease(replacementJob,replacementLeaseId,"meta-proof-replacement",120);
      await proofController.rotateMetaCredential(proofRequest,consentConnection,"pg-meta-relation-rotation-two",{accessToken:"synthetic-meta-rotation-token-two"});
      const afterSecondRotation=await proofState();

      // Exercise consumer SQL on the same isolated Meta tenant with the actual worker RLS role.
      const consumerRepository=new OutboxRepository(new Pool({...connectorWorkerConfig,max:2}));
      const consumerInbound=new InboundRepository(new Pool({...connectorWorkerConfig,max:2}));
      const consumerGroup="61050000-0000-4000-8000-000000000061";
      const consumerLease="61060000-0000-4000-8000-000000000061";
      const consumerIds=[61,62,63,64].map(n=>`61070000-0000-4000-8000-${String(n).padStart(12,"0")}`);
      try{
        await readinessAdmin.query("INSERT INTO retention_policies(tenant_id,resolved_case_days,media_days) VALUES ($1,30,30) ON CONFLICT (tenant_id) DO NOTHING",[consentTenant]);
        // No candidate delivery exists yet: the actual claim projection must still parse all Meta fields.
        assert.deepEqual(await consumerRepository.claimDeliveries(consentTenant,consumerLease,1),[]);
        await readinessAdmin.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES ($1,$2,$3,'meta-p02b-consumer-group','Meta consumer fixture')",[consumerGroup,consentTenant,consentConnection]);
        const consumerBirths=new Map();
        await readinessAdmin.query("BEGIN");
        try{
          await readinessAdmin.query("SELECT set_config('app.tenant_id',$1,true)",[consentTenant]);
        for(const [index,id] of consumerIds.entries()){
          const inserted=await readinessAdmin.query(`INSERT INTO delivery_outbox
            (id,tenant_id,connection_id,group_workspace_group_id,delivery_origin,message_body,content_type,idempotency_key,state,attempts,lease_id,lease_expires_at)
            VALUES ($1,$2,$3,$4,'GROUP_WORKSPACE','Synthetic consumer proof','text/plain',$5,'CLAIMED',1,$6,now()+interval '5 minutes') RETURNING meta_billing_snapshot`,
            [id,consentTenant,consentConnection,consumerGroup,`p02b-consumer-${index}`,consumerLease]);
          const birth=inserted.rows[0].meta_billing_snapshot;
          assert.equal(birth.claim,"LEGACY_UNATTRIBUTED");consumerBirths.set(id,birth);
          await readinessAdmin.query("INSERT INTO delivery_attempts(tenant_id,delivery_id,attempt_number,state) VALUES ($1,$2,1,'CLAIMED')",[consentTenant,id]);
        }
          await readinessAdmin.query("COMMIT");
        }catch(error){await readinessAdmin.query("ROLLBACK");throw error;}
        const snapshot=async()=> (await lifecycleDatabase.withTenant(consentTenant,client=>client.query(`SELECT c.secret_reference,
          ps.id AS provider_session_id,ps.opaque_session_id,ps.provider_state_data->>'wabaId' AS waba_id,
          ps.provider_state_data->'metaAccountProof' AS proof
          FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id
          WHERE c.id=$1 AND ps.ownership_state='ACTIVE'`,[consentConnection]))).rows[0];
        const active=await snapshot();
        const consumerJob=id=>({id,tenantId:consentTenant,connectionId:consentConnection,groupWorkspaceGroupId:consumerGroup,metaBillingSnapshot:consumerBirths.get(id),
          groupId:"meta-p02b-consumer-group",text:"Synthetic consumer proof",contentType:"text/plain",idempotencyKey:`p02b-consumer-${consumerIds.indexOf(id)}`,
          attempts:1,provider:"meta",sessionId:active.opaque_session_id,connectionSecretReference:active.secret_reference,
          metaCredentialContext:{providerSessionId:active.provider_session_id,phoneNumberId:active.opaque_session_id,wabaId:active.waba_id,proof:active.proof},
          zammadBaseUrl:"https://meta-consumer.invalid",zammadSecretReference:`secret://tenants/${consentTenant}/zammad/service`,mediaEnabled:true,retentionDays:30});
        const currentJob=consumerJob(consumerIds[0]);
        assert.equal(await consumerRepository.beginSend(currentJob,consumerLease),true);
        await consumerRepository.assertMetaDeliveryContextCurrent(currentJob,consumerLease);
        const changedContexts=[
          {...currentJob,connectionSecretReference:afterRotation.secret_reference},
          {...currentJob,metaCredentialContext:{...currentJob.metaCredentialContext,providerSessionId:"61030000-0000-4000-8000-000000000099"}},
          {...currentJob,metaCredentialContext:{...currentJob.metaCredentialContext,phoneNumberId:"610123456780"}},
          {...currentJob,metaCredentialContext:{...currentJob.metaCredentialContext,wabaId:"610987654320"}},
          {...currentJob,metaCredentialContext:{...currentJob.metaCredentialContext,proof:{...active.proof,operationId:"superseded-proof"}}},
          {...currentJob,tenantId:ownerRequest.principal.tenantId},
        ];
        for(const changed of changedContexts)await assert.rejects(()=>consumerRepository.assertMetaDeliveryContextCurrent(changed,consumerLease),/changed before dispatch/u);
        // Use the same actual worker pool/tenant policy for the inbound credentialed-media guard.
        const inboundEvent={id:"61080000-0000-4000-8000-000000000061",tenantId:consentTenant,connectionId:consentConnection,provider:"META"};
        assert.deepEqual(await consumerInbound.currentMetaCredentialProof(inboundEvent,active.secret_reference,currentJob.metaCredentialContext),active.proof);
        for(const changed of changedContexts)await assert.rejects(()=>consumerInbound.currentMetaCredentialProof(
          {...inboundEvent,tenantId:changed.tenantId},changed.connectionSecretReference,changed.metaCredentialContext),/changed before media retrieval/u);
        const staleContext={...currentJob.metaCredentialContext,proof:afterRotation.provider_state_data.metaAccountProof};
        // A real late old-token rejection finishes that delivery but cannot downgrade the rotated connection.
        await consumerRepository.fail({...currentJob,connectionSecretReference:afterRotation.secret_reference,metaCredentialContext:staleContext},
          consumerLease,false,"Synthetic old-token authentication failure",undefined,false,"META_AUTHENTICATION_FAILED");
        assert.deepEqual(await proofState(),afterSecondRotation);
        const staleJob={...consumerJob(consumerIds[1]),connectionSecretReference:afterRotation.secret_reference,metaCredentialContext:staleContext};
        assert.equal(await consumerRepository.beginSend(staleJob,consumerLease),false);
        const deferred=await lifecycleDatabase.withTenant(consentTenant,client=>client.query("SELECT state,attempts,lease_id,(SELECT count(*)::int FROM delivery_attempts a WHERE a.tenant_id=d.tenant_id AND a.delivery_id=d.id) AS attempts_count FROM delivery_outbox d WHERE d.id=$1",[staleJob.id]));
        assert.deepEqual(deferred.rows,[{state:"QUEUED",attempts:0,lease_id:null,attempts_count:0}]);
        const unknownJob=consumerJob(consumerIds[2]);
        assert.equal(await consumerRepository.beginSend(unknownJob,consumerLease),true);
        await consumerRepository.outcomeUnknown(unknownJob,consumerLease,"Synthetic unknown outcome retained.");
        await assert.rejects(()=>consumerRepository.assertMetaDeliveryContextCurrent(unknownJob,consumerLease),/changed before dispatch/u);
        const unknown=await lifecycleDatabase.withTenant(consentTenant,client=>client.query("SELECT state,manual_retry_allowed,lease_id FROM delivery_outbox WHERE id=$1",[unknownJob.id]));
        assert.deepEqual(unknown.rows,[{state:"OUTCOME_UNKNOWN",manual_retry_allowed:false,lease_id:null}]);
        // A current credential failure must still mark the connection, unlike the stale failure above.
        const currentFailure=consumerJob(consumerIds[3]);
        const baseline=(await readinessAdmin.query(`SELECT c.state,c.action_reason,ps.state AS session_state,
          ps.provider_state,ps.provider_state_data FROM connections c JOIN provider_sessions ps
          ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id WHERE c.tenant_id=$1 AND c.id=$2 AND ps.id=$3`,
          [consentTenant,consentConnection,active.provider_session_id])).rows[0];
        const restoreConsumerState=async()=>{
          // Restore only this known synthetic fixture's mutable health fields/proof between independent failure scenarios.
          // Delivery/attempt/audit/UNKNOWN histories remain intact until disposable-DB cleanup.
          await withFixtureTenant(readinessAdmin,consentTenant,()=>readinessAdmin.query("UPDATE connections SET state=$1,action_reason=$2 WHERE tenant_id=$3 AND id=$4",[baseline.state,baseline.action_reason,consentTenant,consentConnection]));
          await withFixtureTenant(readinessAdmin,consentTenant,()=>readinessAdmin.query("UPDATE provider_sessions SET state=$1,provider_state=$2,provider_state_data=$3::jsonb WHERE tenant_id=$4 AND id=$5",
            [baseline.session_state,baseline.provider_state,JSON.stringify(baseline.provider_state_data),consentTenant,active.provider_session_id]));
        };
        assert.equal(await consumerRepository.beginSend(currentFailure,consumerLease),true);
        await consumerRepository.fail(currentFailure,consumerLease,false,"Synthetic current-token authentication failure",undefined,false,"META_AUTHENTICATION_FAILED");
        assert.deepEqual((await readinessAdmin.query("SELECT state,action_reason FROM connections WHERE tenant_id=$1 AND id=$2",[consentTenant,consentConnection])).rows,
          [{state:"ACTION_REQUIRED",action_reason:"Synthetic current-token authentication failure"}]);
        assert.equal((await readinessAdmin.query("SELECT state FROM delivery_outbox WHERE tenant_id=$1 AND id=$2",[consentTenant,currentFailure.id])).rows[0].state,"FAILED_TERMINAL");
        await restoreConsumerState();

        // Public API calls exercise selectMetaContext, the real app-role current-context SQL,
        // and credential-invalid completion. Only the provider boundary is simulated.
        let apiMode="available";
        let apiCalls=0;
        const apiService=new MetaGroupsService(lifecycleDatabase,{resolveAccessToken:async reference=>{
          assert.equal(reference,active.secret_reference);return "synthetic-meta-rotation-token-two";
        }},{create:(token,phone,beforeRequest)=>{
          assert.equal(token,"synthetic-meta-rotation-token-two");assert.equal(phone,active.opaque_session_id);
          assert.equal(typeof beforeRequest,"function");
          return {capability:async()=>{
            await beforeRequest();apiCalls++;
            if(apiMode==="stale-invalid")await withFixtureTenant(readinessAdmin,consentTenant,()=>readinessAdmin.query(`UPDATE provider_sessions
              SET provider_state_data=jsonb_set(provider_state_data,'{metaAccountProof,operationId}',to_jsonb('synthetic-newer-proof'::text))
              WHERE tenant_id=$1 AND id=$2`,[consentTenant,active.provider_session_id]));
            return {eligible:apiMode==="available",state:apiMode==="available"?"AVAILABLE":"CREDENTIAL_INVALID",evidence:"provider_probe",checkedAt:new Date().toISOString()};
          }};
        }});
        assert.equal((await apiService.capability(consentRequest,consentConnection)).state,"AVAILABLE");
        const apiContext={tenantId:consentTenant,connectionId:consentConnection,secretReference:active.secret_reference,
          providerSessionId:active.provider_session_id,phoneNumberId:active.opaque_session_id,wabaId:active.waba_id,
          proof:active.proof,disclosureVersion:optIn.eligibilityVersion,groupsConsent:true,requireWorking:true};
        assert.equal(await lifecycleDatabase.withTenant(consentTenant,client=>apiService.contextCurrent(client,apiContext)),true);
        for(const changed of changedContexts){
          const context={...apiContext,tenantId:changed.tenantId,secretReference:changed.connectionSecretReference,
            ...changed.metaCredentialContext,proof:changed.metaCredentialContext.proof};
          assert.equal(await lifecycleDatabase.withTenant(changed.tenantId,client=>apiService.contextCurrent(client,context)),false);
        }
        assert.equal(await lifecycleDatabase.withTenant(consentTenant,client=>apiService.contextCurrent(client,{...apiContext,disclosureVersion:"superseded-consent"})),false);
        apiMode="stale-invalid";
        assert.equal((await apiService.capability(consentRequest,consentConnection)).state,"CREDENTIAL_INVALID");
        const staleApiState=(await readinessAdmin.query("SELECT c.state,ps.state AS session_state,ps.provider_state_data FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id WHERE c.tenant_id=$1 AND c.id=$2 AND ps.id=$3",[consentTenant,consentConnection,active.provider_session_id])).rows[0];
        assert.equal(staleApiState.state,baseline.state);assert.equal(staleApiState.session_state,baseline.session_state);
        assert.equal(staleApiState.provider_state_data.metaAccountProof.operationId,"synthetic-newer-proof");
        await restoreConsumerState();
        const siblingBefore=(await readinessAdmin.query("SELECT state,provider_state,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2",[consentTenant,rollbackConnection])).rows;
        apiMode="current-invalid";
        assert.equal((await apiService.capability(consentRequest,consentConnection)).state,"CREDENTIAL_INVALID");
        assert.deepEqual((await readinessAdmin.query("SELECT c.state,ps.state AS session_state,ps.provider_state FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id WHERE c.tenant_id=$1 AND c.id=$2 AND ps.id=$3",[consentTenant,consentConnection,active.provider_session_id])).rows,
          [{state:"ACTION_REQUIRED",session_state:"ACTION_REQUIRED",provider_state:"CREDENTIAL_INVALID"}]);
        assert.deepEqual((await readinessAdmin.query("SELECT state,provider_state,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2",[consentTenant,rollbackConnection])).rows,siblingBefore);
        assert.equal(apiCalls,3);
        await restoreConsumerState();
        assert.deepEqual(await proofState(),afterSecondRotation);
        // Retain known deferred/failed/UNKNOWN histories until the owned disposable DB is removed.
      }finally{await Promise.all([consumerRepository.close(),consumerInbound.close()]);}
      await consentRepository.fail(replacementJob,replacementLeaseId,replacementLease,{retryable:true,code:"META_NETWORK",safeError:"Synthetic old token failure",connectionState:"DEGRADED"});
      assert.deepEqual(await proofState(),afterSecondRotation,"old-token failure must not degrade the new connection");
      const failed = await lifecycleDatabase.withTenant(consentTenant,client=>client.query("SELECT state,error_code FROM connection_operations WHERE id=$1",[replacementJob.id]));
      assert.deepEqual(failed.rows,[{state:"FAILED_TERMINAL",error_code:"META_NETWORK"}]);
      const replay=await proofController.rotateMetaCredential(proofRequest,consentConnection,"pg-meta-relation-rotation-one",{accessToken:"synthetic-meta-rotation-token-one"});
      assert.equal(replay.duplicate,true);
      assert.deepEqual(await proofState(),afterSecondRotation,"old completed rotation replay must remain historical");
      // Retire only this synthetic fixture's remaining validation to exercise disconnect admission.
      await lifecycleDatabase.withTenant(consentTenant,client=>client.query("UPDATE connection_operations SET state='CANCELLED',completed_at=now() WHERE tenant_id=$1 AND connection_id=$2 AND state='QUEUED'",[consentTenant,consentConnection]));
      const restarted = await proofController.restart(proofRequest,consentConnection,"pg-meta-app-activation");
      assert.equal(restarted.operation.type,"RESTART");
      assert.equal((await proofState()).provider_state_data.metaAccountProof.operationId,restarted.operation.id);
      const activationReplay=await proofController.restart(proofRequest,consentConnection,"pg-meta-app-activation");
      assert.equal(activationReplay.duplicate,true);
      await lifecycleDatabase.withTenant(consentTenant,client=>client.query("UPDATE connection_operations SET state='CANCELLED',completed_at=now() WHERE tenant_id=$1 AND connection_id=$2 AND state='QUEUED'",[consentTenant,consentConnection]));
      await proofController.disconnect(proofRequest,consentConnection,"pg-meta-proof-disconnect",{confirmation:"DISCONNECT"});
      const disconnectLeaseId="61040000-0000-4000-8000-000000000063";
      const [disconnectJob]=await consentRepository.claim(consentTenant,disconnectLeaseId,1);
      assert.equal(disconnectJob.operationType,"DISCONNECT");
      const disconnectLease=await consentRepository.acquireProviderSessionLease(disconnectJob,disconnectLeaseId,"meta-proof-disconnect",120);
      await proofController.rotateMetaCredential(proofRequest,consentConnection,"pg-meta-relation-rotation-three",{accessToken:"synthetic-meta-rotation-token-three"});
      const beforeDisconnect=await proofState();
      const claimCurrentCleanup = async () => {
        await readinessAdmin.query("BEGIN");
        try {
          await readinessAdmin.query("SET LOCAL ROLE wasalx_secret_cleanup_client");
          const claimed=await readinessAdmin.query("SELECT * FROM app.claim_secret_cleanup_tasks('61040000-0000-4000-8000-000000000064',100)");
          return claimed.rows.filter(row=>row.tenant_id===consentTenant && row.secret_reference===beforeDisconnect.secret_reference);
        } finally { await readinessAdmin.query("ROLLBACK"); }
      };
      assert.equal((await claimCurrentCleanup()).length,0,"current credential remains protected before disconnect");
      await consentRepository.complete(disconnectJob,disconnectLeaseId,disconnectLease,{connectionState:"REVOKED",providerState:"REVOKED_LOCAL",providerStateData:disconnectJob.providerSession.providerStateData,result:{disconnected:true},webhookState:"REVOKED",retireSession:true});
      const afterDisconnect=await proofState();
      assert.equal(afterDisconnect.state,"REVOKED");
      assert.deepEqual(afterDisconnect.provider_state_data.metaAccountProof,beforeDisconnect.provider_state_data.metaAccountProof);
      // Rotation already owns the unique cleanup tombstone for its new reference.
      // Disconnect makes that same row eligible; it must not create a competing owner.
      const cleanup=await readinessAdmin.query("SELECT secret_reference FROM secret_cleanup_outbox WHERE tenant_id=$1 AND connection_id=$2 AND secret_reference=$3 AND cleanup_kind='CONNECTION_CREDENTIAL'",[consentTenant,consentConnection,beforeDisconnect.secret_reference]);
      assert.deepEqual(cleanup.rows,[{secret_reference:beforeDisconnect.secret_reference}]);
      assert.equal((await claimCurrentCleanup()).length,1,"disconnect must release the replacement credential for cleanup");


    } finally { await consentRepository.close(); for (const [key,value] of Object.entries(oldMetaConfig)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; } }
  }finally{await readinessAdmin.end();await lifecycleDatabase.onModuleDestroy();if(previousDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousDatabaseUrl}

  const retryHoldTenant="20000000-0000-4000-8000-000000000002";
  await tenant(retryHoldTenant,async()=>{
    await app.query(`INSERT INTO group_workspace_settings
      (tenant_id,whatsapp_group_id,capture_enabled,enabled_at,retention_days,visibility,updated_by)
      VALUES ($1,'25000000-0000-4000-8000-000000000002',true,now()-interval '40 days',1,'RESTRICTED','20200000-0000-4000-8000-000000000002')
      ON CONFLICT (tenant_id,whatsapp_group_id) DO UPDATE
        SET capture_enabled=true,retention_days=1,updated_at=now()`,[retryHoldTenant]);
    await app.query(`INSERT INTO event_inbox
      (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
      VALUES ('63800000-0000-4000-8000-000000000002',$1,'23000000-0000-4000-8000-000000000002','WAHA',
        'retry-hold-event','message.any','{}','retry-hold-event-hash','PROCESSED',now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO media_objects
      (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at)
      VALUES ('63900000-0000-4000-8000-000000000002',$1,repeat('8',64),
        app.current_tenant_id()::text||'/sha256/88/'||repeat('8',64),'image/png',8,'CLEAN',
        now()-interval '39 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO normalized_messages
      (id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
       participant_name,message_text,provider_timestamp,provider_metadata,processing_status,history_captured_at,created_at)
      VALUES ('64000000-0000-4000-8000-000000000002',$1,'63800000-0000-4000-8000-000000000002',
        '23000000-0000-4000-8000-000000000002','retry-hold-message','fixture-0010@example.test','12025550126@c.us',
        'Retry hold user','must survive retry hold',now()-interval '40 days',
        '{"media_object_id":"63900000-0000-4000-8000-000000000002","zammad_customer_id":"977"}',
        'COMPLETE',now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO case_correlations
      (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,created_at,updated_at)
      VALUES ($1,'26000000-0000-4000-8000-000000000002','RETRY-HOLD-9771','9771','9771','RESOLVED',
        now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO message_links
      (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,created_at)
      VALUES ($1,'23000000-0000-4000-8000-000000000002','retry-hold-message','9771','9771','INBOUND',
        now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO event_inbox
      (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
      VALUES ('63800000-0000-4000-8000-000000000003',$1,'23000000-0000-4000-8000-000000000002','WAHA',
        'shared-hold-event','message.any','{}','shared-hold-event-hash','PROCESSED',now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO media_objects
      (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at) VALUES
      ('63900000-0000-4000-8000-000000000003',$1,repeat('a',64),
        app.current_tenant_id()::text||'/sha256/aa/'||repeat('a',64),'image/png',8,'CLEAN',
        now()-interval '39 days',now()-interval '40 days'),
      ('63900000-0000-4000-8000-000000000004',$1,repeat('b',64),
        app.current_tenant_id()::text||'/sha256/bb/'||repeat('b',64),'image/png',8,'CLEAN',
        now()-interval '39 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO normalized_messages
      (id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
       participant_name,message_text,provider_timestamp,provider_metadata,processing_status,history_captured_at,created_at)
      VALUES ('64000000-0000-4000-8000-000000000003',$1,'63800000-0000-4000-8000-000000000003',
        '23000000-0000-4000-8000-000000000002','shared-hold-message','fixture-0010@example.test','12025550127@c.us',
        'Shared hold user','shared ticket evidence',now()-interval '40 days',
        '{"media_object_id":"63900000-0000-4000-8000-000000000003"}',
        'COMPLETE',now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO case_correlations
      (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,created_at,updated_at) VALUES
      ($1,'26000000-0000-4000-8000-000000000002','SHARED-PRIMARY-9781','9781','9781','RESOLVED',now()-interval '40 days',now()-interval '40 days'),
      ($1,'26000000-0000-4000-8000-000000000002','SHARED-HELD-9782','9782','9782','RESOLVED',now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO message_links
      (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,created_at) VALUES
      ($1,'23000000-0000-4000-8000-000000000002','shared-hold-message','9781','9781','INBOUND',now()-interval '40 days'),
      ($1,'23000000-0000-4000-8000-000000000002','shared-hold-message','9782','9782','INBOUND',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,
       idempotency_key,state,delivery_origin,manual_retry_allowed,batch_id,batch_sequence,batch_part_count,
       blocked_by_delivery_id,created_at,updated_at) VALUES
      ('64400000-0000-4000-8000-000000000003',$1,'23000000-0000-4000-8000-000000000002',
        '26000000-0000-4000-8000-000000000002','9781','9781','Shared queued delivery','text/plain',
        'privacy-shared-queued','QUEUED','TICKET',false,NULL,0,1,NULL,
        now()-interval '40 days',now()-interval '40 days'),
      ('64400000-0000-4000-8000-000000000004',$1,'23000000-0000-4000-8000-000000000002',
        '26000000-0000-4000-8000-000000000002','9781','9781','Shared sent media','image/png',
        'privacy-shared-sent','SENT','TICKET',false,NULL,0,1,NULL,
        now()-interval '40 days',now()-interval '40 days'),
      ('64400000-0000-4000-8000-000000000005',$1,'23000000-0000-4000-8000-000000000002',
        '26000000-0000-4000-8000-000000000002','9781','9781','Shared ambiguous delivery','text/plain',
        'privacy-shared-ambiguous','OUTCOME_UNKNOWN','TICKET',false,NULL,0,1,NULL,
        now()-interval '40 days',now()-interval '40 days'),
      ('64400000-0000-4000-8000-000000000006',$1,'23000000-0000-4000-8000-000000000002',
        '26000000-0000-4000-8000-000000000002','9781','9781','Failed delivery awaiting manual retry','text/plain',
        'privacy-shared-failed-terminal','FAILED_TERMINAL','TICKET',true,
        '64600000-0000-4000-8000-000000000001',0,2,NULL,
        now()-interval '40 days',now()-interval '40 days'),
      ('64400000-0000-4000-8000-000000000007',$1,'23000000-0000-4000-8000-000000000002',
        '26000000-0000-4000-8000-000000000002','9781','9781','Blocked batch successor','text/plain',
        'privacy-shared-blocked','BLOCKED','TICKET',false,
        '64600000-0000-4000-8000-000000000001',1,2,'64400000-0000-4000-8000-000000000006',
        now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id) VALUES
      ($1,'64400000-0000-4000-8000-000000000003','9782'),
      ($1,'64400000-0000-4000-8000-000000000004','9782'),
      ($1,'64400000-0000-4000-8000-000000000005','9782'),
      ($1,'64400000-0000-4000-8000-000000000006','9782'),
      ($1,'64400000-0000-4000-8000-000000000007','9782')`,[retryHoldTenant]);
    await app.query(`INSERT INTO delivery_media
      (id,tenant_id,delivery_id,zammad_attachment_id,filename,mime_type,byte_size,state,media_object_id,created_at,updated_at)
      VALUES ('64500000-0000-4000-8000-000000000004',$1,'64400000-0000-4000-8000-000000000004',
        9781,'shared.png','image/png',8,'READY','63900000-0000-4000-8000-000000000004',
        now()-interval '40 days',now()-interval '40 days'),
      ('64500000-0000-4000-8000-000000000005',$1,'64400000-0000-4000-8000-000000000006',
        9782,'shared-retry.png','image/png',8,'READY','63900000-0000-4000-8000-000000000004',
        now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO event_inbox
      (id,tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,processed_at)
      VALUES ('63800000-0000-4000-8000-000000000004',$1,'23000000-0000-4000-8000-000000000002','WAHA',
        'shared-live-event','message.any','{}','shared-live-event-hash','PROCESSED',now(),now())`,[retryHoldTenant]);
    await app.query(`INSERT INTO media_objects
      (id,tenant_id,sha256,object_key,mime_type,byte_size,scan_state,expires_at,created_at) VALUES
      ('63900000-0000-4000-8000-000000000005',$1,repeat('c',64),
        app.current_tenant_id()::text||'/sha256/cc/'||repeat('c',64),'image/png',8,'CLEAN',
        now()+interval '30 days',now()),
      ('63900000-0000-4000-8000-000000000006',$1,repeat('d',64),
        app.current_tenant_id()::text||'/sha256/dd/'||repeat('d',64),'image/png',8,'CLEAN',
        now()+interval '30 days',now())`,[retryHoldTenant]);
    await app.query(`INSERT INTO normalized_messages
      (id,tenant_id,event_inbox_id,connection_id,external_message_id,external_group_id,external_participant_id,
       participant_name,message_text,provider_timestamp,provider_metadata,processing_status,history_captured_at,created_at)
      VALUES ('64000000-0000-4000-8000-000000000004',$1,'63800000-0000-4000-8000-000000000004',
        '23000000-0000-4000-8000-000000000002','shared-live-message','fixture-0010@example.test','12025550128@c.us',
        'Shared live user','shared live ticket evidence',now(),
        '{"media_object_id":"63900000-0000-4000-8000-000000000005"}',
        'COMPLETE',now(),now())`,[retryHoldTenant]);
    await app.query(`INSERT INTO case_correlations
      (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,created_at,updated_at) VALUES
      ($1,'26000000-0000-4000-8000-000000000002','SHARED-LIVE-PRIMARY-9783','9783','9783','RESOLVED',now()-interval '40 days',now()-interval '40 days'),
      ($1,'26000000-0000-4000-8000-000000000002','SHARED-LIVE-RETAINED-9784','9784','9784','RESOLVED',now(),now())`,[retryHoldTenant]);
    await app.query(`INSERT INTO message_links
      (tenant_id,connection_id,external_message_id,zammad_ticket_id,zammad_article_id,direction,created_at) VALUES
      ($1,'23000000-0000-4000-8000-000000000002','shared-live-message','9783','9783','INBOUND',now()-interval '40 days'),
      ($1,'23000000-0000-4000-8000-000000000002','shared-live-message','9784','9784','INBOUND',now())`,[retryHoldTenant]);
    await app.query(`INSERT INTO delivery_outbox
      (id,tenant_id,connection_id,group_binding_id,zammad_ticket_id,zammad_article_id,message_body,content_type,
       idempotency_key,state,delivery_origin,created_at,updated_at)
      VALUES ('64400000-0000-4000-8000-000000000008',$1,'23000000-0000-4000-8000-000000000002',
        '26000000-0000-4000-8000-000000000002','9783','9783','Shared live sent media','image/png',
        'privacy-shared-live-sent','SENT','TICKET',now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]);
    await app.query(`INSERT INTO delivery_ticket_links (tenant_id,delivery_id,zammad_ticket_id)
      VALUES ($1,'64400000-0000-4000-8000-000000000008','9784')`,[retryHoldTenant]);
    await app.query(`INSERT INTO delivery_media
      (id,tenant_id,delivery_id,zammad_attachment_id,filename,mime_type,byte_size,state,media_object_id,created_at,updated_at)
      VALUES ('64500000-0000-4000-8000-000000000006',$1,'64400000-0000-4000-8000-000000000008',
        9783,'shared-live.png','image/png',8,'READY','63900000-0000-4000-8000-000000000006',
        now(),now())`,[retryHoldTenant]);
    await app.query(`INSERT INTO zammad_status_outbox
      (tenant_id,delivery_id,zammad_ticket_id,delivery_state,external_message_id,completed_at)
      VALUES ($1,'64400000-0000-4000-8000-000000000008','9783','SENT','shared-live-provider-message',now()),
        ($1,'64400000-0000-4000-8000-000000000008','9784','SENT','shared-live-provider-message',now())`,[retryHoldTenant]);
  });
  const retryHoldRepository=new PrivacyRepository(new Pool({...connectorWorkerConfig,max:2}));
  try{
    const initialRetryHoldJob=privacyJob(
      "64100000-0000-4000-8000-000000000002",retryHoldTenant,
      "64200000-0000-4000-8000-000000000002","RETENTION_SWEEP","TENANT",retryHoldTenant,
    );
    await insertPrivacyJob(initialRetryHoldJob);
    await assert.rejects(
      ()=>retryHoldRepository.discover(initialRetryHoldJob,initialRetryHoldJob.leaseId),
      error=>error instanceof PrivacyRepositoryError&&error.code==="DELIVERY_OUTCOME_UNRESOLVED"&&error.retryable,
    );
    await tenant(retryHoldTenant,()=>app.query(`UPDATE delivery_outbox
      SET state='SENT',external_message_id='shared-ambiguous-resolved',updated_at=now()
      WHERE id='64400000-0000-4000-8000-000000000005' AND state='OUTCOME_UNKNOWN'`));
    await retryHoldRepository.discover(initialRetryHoldJob,initialRetryHoldJob.leaseId);
    const initialRetryHoldTargets=await privacyTargetSnapshot(initialRetryHoldJob);
    assert.equal(initialRetryHoldTargets.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="9781"),true);
    assert.equal(initialRetryHoldTargets.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="9782"),true);
    assert.equal(initialRetryHoldTargets.some(target=>target.targetId==="64000000-0000-4000-8000-000000000003"),true);
    assert.equal(initialRetryHoldTargets.some(target=>target.targetId==="63900000-0000-4000-8000-000000000003"),true);
    assert.equal(initialRetryHoldTargets.some(target=>target.targetId==="63900000-0000-4000-8000-000000000004"),true);
    assert.equal(initialRetryHoldTargets.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="9783"),true);
    assert.equal(initialRetryHoldTargets.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="9784"),false);
    assert.equal(initialRetryHoldTargets.some(target=>target.targetId==="64000000-0000-4000-8000-000000000004"),false);
    assert.equal(initialRetryHoldTargets.some(target=>target.targetId==="63900000-0000-4000-8000-000000000005"),false);
    assert.equal(initialRetryHoldTargets.some(target=>target.targetId==="63900000-0000-4000-8000-000000000006"),false);
    const sharedDeliveryStates=await tenant(retryHoldTenant,()=>app.query(`SELECT idempotency_key,state
      FROM delivery_outbox WHERE id=ANY($1::uuid[]) ORDER BY idempotency_key`,[[
      "64400000-0000-4000-8000-000000000003","64400000-0000-4000-8000-000000000004",
      "64400000-0000-4000-8000-000000000005",
    ]]));
    assert.deepEqual(sharedDeliveryStates.rows,[
      {idempotency_key:"privacy-shared-ambiguous",state:"SENT"},
      {idempotency_key:"privacy-shared-queued",state:"PRIVACY_CANCELLED"},
      {idempotency_key:"privacy-shared-sent",state:"SENT"},
    ]);
    const frozenConstraintStates=await tenant(retryHoldTenant,()=>app.query(`SELECT
      idempotency_key,state,manual_retry_allowed,blocked_by_delivery_id::text
      FROM delivery_outbox WHERE id=ANY($1::uuid[]) ORDER BY idempotency_key`,[[
      "64400000-0000-4000-8000-000000000006","64400000-0000-4000-8000-000000000007",
    ]]));
    assert.deepEqual(frozenConstraintStates.rows,[
      {idempotency_key:"privacy-shared-blocked",state:"PRIVACY_CANCELLED",manual_retry_allowed:false,blocked_by_delivery_id:null},
      {idempotency_key:"privacy-shared-failed-terminal",state:"PRIVACY_CANCELLED",manual_retry_allowed:false,blocked_by_delivery_id:null},
    ]);
    const retainedTargetIds=new Set([
      "9771",
      "64000000-0000-4000-8000-000000000002",
      "63900000-0000-4000-8000-000000000002",
    ]);
    const retainedTargets=initialRetryHoldTargets.filter(target=>retainedTargetIds.has(target.targetId));
    assert.deepEqual(retainedTargets.map(target=>target.type).sort(),["MEDIA_OBJECT","NORMALIZED_MESSAGE","ZAMMAD_TICKET"]);
    assert.ok(initialRetryHoldTargets.every(target=>target.state==="PENDING"&&target.attempts===0));
    assert.equal(await retryHoldRepository.fail(initialRetryHoldJob,initialRetryHoldJob.leaseId,{
      retryable:true,code:"RETRY_HOLD_PROBE",safeError:"Retry hold revalidation proof",retryAt:new Date(Date.now()-1_000).toISOString(),
    }),true);
    await tenant(retryHoldTenant,()=>app.query(`INSERT INTO privacy_legal_holds
      (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
      VALUES ($1,'ZAMMAD_USER','977',repeat('9',64),'Queued deletion must respect a new hold',
        '20200000-0000-4000-8000-000000000002')`,[retryHoldTenant]));
    const retryLease="64300000-0000-4000-8000-000000000002";
    const reclaimedRetryHoldJob=(await retryHoldRepository.claim(retryHoldTenant,retryLease,25))
      .find(job=>job.id===initialRetryHoldJob.id);
    assert.ok(reclaimedRetryHoldJob);
    assert.equal(reclaimedRetryHoldJob.stage,"EXTERNAL");
    await assert.rejects(()=>retryHoldRepository.discover(reclaimedRetryHoldJob,retryLease),error=>error instanceof PrivacyLegalHoldError);
    assert.equal(await retryHoldRepository.fail(reclaimedRetryHoldJob,retryLease,{
      retryable:false,legalHold:true,code:"LEGAL_HOLD_ACTIVE",safeError:"An active legal hold blocks this privacy deletion",
    }),true);
    assert.equal((await tenant(retryHoldTenant,()=>app.query("SELECT state FROM privacy_jobs WHERE id=$1",[initialRetryHoldJob.id]))).rows[0].state,"BLOCKED_LEGAL_HOLD");
    assert.deepEqual(await privacyTargetSnapshot(initialRetryHoldJob),initialRetryHoldTargets);
    await tenant(retryHoldTenant,()=>app.query(`INSERT INTO privacy_legal_holds
      (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
      VALUES ($1,'REFERENCE','SHARED-HELD-9782',repeat('a',64),'Shared ticket records must stay intact',
        '20200000-0000-4000-8000-000000000002')`,[retryHoldTenant]));
    await tenant(retryHoldTenant,()=>app.query("UPDATE retention_policies SET next_sweep_at=now()-interval '1 hour'"));
    const freshRetentionId=await retryHoldRepository.ensureMaintenanceJob(retryHoldTenant);
    assert.ok(freshRetentionId&&freshRetentionId!==initialRetryHoldJob.id);
    const freshRetentionLease="64200000-0000-4000-8000-000000000005";
    const freshRetentionJob=(await retryHoldRepository.claim(retryHoldTenant,freshRetentionLease,25)).find(job=>job.id===freshRetentionId);
    assert.ok(freshRetentionJob);
    assert.equal(freshRetentionJob.stage,"DISCOVER");
    await retryHoldRepository.discover(freshRetentionJob,freshRetentionLease);
    const freshRetentionSnapshot=await privacyTargetSnapshot(freshRetentionJob);
    assert.equal(freshRetentionSnapshot.some(target=>retainedTargetIds.has(target.targetId)),false);
    assert.equal(freshRetentionSnapshot.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="9782"),false);
    for(const id of ["9781","9783"])assert.ok(freshRetentionSnapshot.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId===id));
    for(const target of await retryHoldRepository.targets(freshRetentionJob)){
      await retryHoldRepository.beginTargetExternal(freshRetentionJob,freshRetentionLease,target);
      await assert.rejects(tenant(retryHoldTenant,()=>app.query(`INSERT INTO privacy_legal_holds
        (tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
        VALUES ($1,'REFERENCE','LATE-HOLD-PROBE',repeat('b',64),'External work fences late holds',
          '20200000-0000-4000-8000-000000000002')`,[retryHoldTenant])),error=>error?.code==="55000");
      await retryHoldRepository.markTargetExternal(freshRetentionJob,freshRetentionLease,target);
    }
    const freshRetentionSummary=await retryHoldRepository.finalize(freshRetentionJob,freshRetentionLease);
    assert.equal(await retryHoldRepository.complete(freshRetentionJob,freshRetentionLease,freshRetentionSummary),true);
    const retainedRows=await tenant(retryHoldTenant,()=>app.query(`SELECT
      (SELECT count(*)::integer FROM case_correlations WHERE zammad_ticket_id='9771') AS ticket,
      (SELECT count(*)::integer FROM normalized_messages WHERE id='64000000-0000-4000-8000-000000000002') AS message,
      (SELECT count(*)::integer FROM media_objects WHERE id='63900000-0000-4000-8000-000000000002') AS media,
      (SELECT count(*)::integer FROM message_links WHERE zammad_ticket_id='9771') AS link`));
    assert.deepEqual(retainedRows.rows,[{ticket:1,message:1,media:1,link:1}]);
    const sharedRows=await tenant(retryHoldTenant,()=>app.query(`SELECT
      (SELECT count(*)::integer FROM case_correlations WHERE zammad_ticket_id='9781') AS cleaned_ticket,
      (SELECT count(*)::integer FROM case_correlations WHERE zammad_ticket_id='9782') AS held_ticket,
      (SELECT count(*)::integer FROM normalized_messages WHERE id='64000000-0000-4000-8000-000000000003') AS message,
      (SELECT count(*)::integer FROM media_objects WHERE id='63900000-0000-4000-8000-000000000003') AS inbound_media,
      (SELECT count(*)::integer FROM media_objects WHERE id='63900000-0000-4000-8000-000000000004') AS outbound_media,
      (SELECT count(*)::integer FROM message_links WHERE external_message_id='shared-hold-message' AND zammad_ticket_id='9781') AS cleaned_link,
      (SELECT count(*)::integer FROM message_links WHERE external_message_id='shared-hold-message' AND zammad_ticket_id='9782') AS held_link,
      (SELECT count(*)::integer FROM delivery_media WHERE id='64500000-0000-4000-8000-000000000004'
        AND state='READY' AND media_object_id='63900000-0000-4000-8000-000000000004') AS outbound_descriptor,
      (SELECT count(*)::integer FROM delivery_media WHERE id='64500000-0000-4000-8000-000000000005'
        AND state='READY' AND media_object_id='63900000-0000-4000-8000-000000000004') AS retry_descriptor`));
    assert.deepEqual(sharedRows.rows,[{
      cleaned_ticket:0,held_ticket:1,message:1,inbound_media:1,outbound_media:1,
      cleaned_link:0,held_link:1,outbound_descriptor:1,retry_descriptor:1,
    }]);
    const retainedSharedDeliveries=await tenant(retryHoldTenant,()=>app.query(`SELECT idempotency_key,state
      FROM delivery_outbox WHERE id=ANY($1::uuid[]) ORDER BY idempotency_key`,[[
      "64400000-0000-4000-8000-000000000003","64400000-0000-4000-8000-000000000004",
      "64400000-0000-4000-8000-000000000005","64400000-0000-4000-8000-000000000006",
      "64400000-0000-4000-8000-000000000007",
    ]]));
    assert.deepEqual(retainedSharedDeliveries.rows,[
      {idempotency_key:"privacy-shared-ambiguous",state:"SENT"},
      {idempotency_key:"privacy-shared-blocked",state:"PRIVACY_CANCELLED"},
      {idempotency_key:"privacy-shared-failed-terminal",state:"PRIVACY_CANCELLED"},
      {idempotency_key:"privacy-shared-queued",state:"PRIVACY_CANCELLED"},
      {idempotency_key:"privacy-shared-sent",state:"SENT"},
    ]);
    const retainedLiveReferences=await tenant(retryHoldTenant,()=>app.query(`SELECT
      (SELECT count(*)::integer FROM case_correlations WHERE zammad_ticket_id='9783') AS cleaned_ticket,
      (SELECT count(*)::integer FROM case_correlations WHERE zammad_ticket_id='9784') AS live_ticket,
      (SELECT count(*)::integer FROM normalized_messages WHERE id='64000000-0000-4000-8000-000000000004') AS message,
      (SELECT count(*)::integer FROM media_objects WHERE id='63900000-0000-4000-8000-000000000005') AS inbound_media,
      (SELECT count(*)::integer FROM media_objects WHERE id='63900000-0000-4000-8000-000000000006') AS outbound_media,
      (SELECT count(*)::integer FROM message_links WHERE external_message_id='shared-live-message' AND zammad_ticket_id='9783') AS cleaned_message_link,
      (SELECT count(*)::integer FROM message_links WHERE external_message_id='shared-live-message' AND zammad_ticket_id='9784') AS live_message_link,
      (SELECT count(*)::integer FROM delivery_outbox WHERE id='64400000-0000-4000-8000-000000000008' AND zammad_ticket_id='9783') AS stale_primary,
      (SELECT count(*)::integer FROM delivery_outbox WHERE id='64400000-0000-4000-8000-000000000008' AND zammad_ticket_id='9784' AND state='SENT') AS live_primary,
      (SELECT count(*)::integer FROM delivery_ticket_links WHERE delivery_id='64400000-0000-4000-8000-000000000008' AND zammad_ticket_id='9783') AS cleaned_delivery_link,
      (SELECT count(*)::integer FROM delivery_ticket_links WHERE delivery_id='64400000-0000-4000-8000-000000000008' AND zammad_ticket_id='9784') AS live_delivery_link,
      (SELECT count(*)::integer FROM zammad_status_outbox WHERE delivery_id='64400000-0000-4000-8000-000000000008' AND zammad_ticket_id='9784') AS live_status,
      (SELECT count(*)::integer FROM zammad_status_outbox WHERE delivery_id='64400000-0000-4000-8000-000000000008' AND zammad_ticket_id='9783') AS stale_status,
      (SELECT count(*)::integer FROM zammad_status_outbox WHERE delivery_id='64400000-0000-4000-8000-000000000008'
        AND zammad_ticket_id='[removed]:'||id::text AND external_message_id IS NULL AND completed_at IS NOT NULL) AS removed_status,
      (SELECT count(*)::integer FROM delivery_media WHERE id='64500000-0000-4000-8000-000000000006'
        AND state='READY' AND media_object_id='63900000-0000-4000-8000-000000000006') AS descriptor`));
    assert.deepEqual(retainedLiveReferences.rows,[{
      cleaned_ticket:0,live_ticket:1,message:1,inbound_media:1,outbound_media:1,
      cleaned_message_link:0,live_message_link:1,stale_primary:0,live_primary:1,
      cleaned_delivery_link:0,live_delivery_link:1,live_status:1,stale_status:0,removed_status:1,descriptor:1,
    }]);
    await tenant(retryHoldTenant,()=>app.query(`INSERT INTO case_correlations
      (tenant_id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,created_at,updated_at)
      VALUES ($1,'26000000-0000-4000-8000-000000000002','FINALIZE-RETRY-9791','9791','9791','RESOLVED',
        now()-interval '40 days',now()-interval '40 days')`,[retryHoldTenant]));
    const finalizeRetryJob=privacyJob(
      "64100000-0000-4000-8000-000000000003",retryHoldTenant,
      "64200000-0000-4000-8000-000000000003","DELETE","ZAMMAD_TICKET","9791",
    );
    await insertPrivacyJob(finalizeRetryJob);
    await retryHoldRepository.discover(finalizeRetryJob,finalizeRetryJob.leaseId);
    const finalizeRetryTargets=await retryHoldRepository.targets(finalizeRetryJob);
    assert.equal(finalizeRetryTargets.some(target=>target.type==="ZAMMAD_TICKET"&&target.targetId==="9791"),true);
    for(const target of finalizeRetryTargets){
      await retryHoldRepository.beginTargetExternal(finalizeRetryJob,finalizeRetryJob.leaseId,target);
      await retryHoldRepository.markTargetExternal(finalizeRetryJob,finalizeRetryJob.leaseId,target);
    }
    const firstFinalizeSummary=await retryHoldRepository.finalize(finalizeRetryJob,finalizeRetryJob.leaseId);
    assert.deepEqual((await tenant(retryHoldTenant,()=>app.query(`SELECT target.state,target.attempts,
      (SELECT count(*)::integer FROM case_correlations WHERE zammad_ticket_id='9791') AS local_rows
      FROM privacy_job_targets target WHERE target.job_id=$1 AND target.target_type='ZAMMAD_TICKET' AND target.target_id='9791'`,[
      finalizeRetryJob.id,
    ]))).rows,[{state:"COMPLETE",attempts:1,local_rows:0}]);
    assert.equal(await retryHoldRepository.fail(finalizeRetryJob,finalizeRetryJob.leaseId,{
      retryable:true,code:"FINALIZE_COMPLETE_RETRY",safeError:"Completion acknowledgement retry proof",
      retryAt:new Date(Date.now()-1_000).toISOString(),
    }),false);
    assert.deepEqual((await tenant(retryHoldTenant,()=>app.query(`SELECT state,attempts FROM privacy_job_targets
      WHERE job_id=$1 AND target_type='ZAMMAD_TICKET' AND target_id='9791'`,[finalizeRetryJob.id]))).rows,[{
      state:"COMPLETE",attempts:1,
    }]);
    assert.equal(await retryHoldRepository.complete(finalizeRetryJob,finalizeRetryJob.leaseId,firstFinalizeSummary),true);
    assert.deepEqual((await tenant(retryHoldTenant,()=>app.query("SELECT state,stage FROM privacy_jobs WHERE id=$1",[
      finalizeRetryJob.id,
    ]))).rows,[{state:"SUCCEEDED",stage:"DONE"}]);
  }finally{await retryHoldRepository.close()}

  sharedCoreSummary=JSON.stringify({migrations:migrationFiles.length,postgres_rls:"passed",cross_tenant:"blocked",tenant_administration_cross_tenant:"blocked",invitation_mailer_role_isolation:"passed",invitation_mailer_shared_discovery:"passed",invitation_mailer_delivery_fencing:"passed",identity_policy_activation_role_isolation:"passed",identity_policy_activation_fencing:"passed",metering_ingest_role_isolation:"passed",metering_hourly_capture:"passed",platform_operations_role_isolation:"passed",metering_exact_replay:"passed",metering_changed_replay:"blocked",support_role_isolation:"passed",tenant_resume_role_isolation:"passed",tenant_resume_idempotency:"passed",tenant_resume_stale_fence:"blocked",tenant_resume_evidence_gate:"passed",tenant_resume_atomic_materialization:"passed",waha_registry_role_isolation:"passed",waha_operator_role_isolation:"passed",waha_rollout_gate_role_isolation:"passed",waha_rollout_active_assignment_removal:"blocked",waha_rollout_empty_disabled_removal:"passed",waha_rollout_identity_change:"blocked",waha_rollout_out_of_set_registration:"blocked",waha_rollout_out_of_set_reactivation:"blocked",waha_assignment_fencing:"passed",duplicate_waha_identity:"blocked",onboarding_scan_acknowledgement:"passed",webhook_route_lookup:"passed",oidc_membership_discovery:"passed",durable_scheduler:"passed",operational_metrics:"passed",delivery_claims:claimed.rowCount,duplicate_claims:0,recovered_expired_leases:1,connection_operation_claims:1,recovered_connection_operation_leases:1,stale_operation_fence:"blocked",lifecycle_public_execute:"revoked",provider_status_generation_fence:"passed",provider_status_timestamp_fence:"passed",provider_status_lifecycle_fence:"passed",lifecycle_route_pause_transaction:"passed",secret_cleanup_role_isolation:"passed",secret_cleanup_claims:1,recovered_secret_cleanup_leases:1,secret_cleanup_tenant_delete_order:"passed",inbound_claims:1,recovered_inbound_leases:1,inbound_e2e:"passed",privacy_group_uuid_canonicalization:"passed",privacy_finalize_atomic_completion:"passed",retention_retry_hold_fresh_sweep:"passed",retention_shared_reference_hold:"passed",retention_shared_live_reference:"passed",status_claims:status.rowCount,audit_append_only:"passed"});
}catch(error){
  sharedCoreFailure=error;
  metaLifecycleFailures.push(error);
  if(sharedCorePrerequisitesPassed){
    console.error("Shared PostgreSQL core failed; remaining shared scenario is blocked",error);
    console.log(JSON.stringify({postgresSharedCore:"FAILED",sharedRemainder:"BLOCKED",independentTail:"REQUIRES_SHARED_CLEANUP"}));
  }
}finally{
  const closed=await Promise.allSettled([fixtureAdmin.end(),app.end(),cleanup.end(),provisioning.end(),support.end(),wahaRegistry.end(),wahaOperator.end(),wahaRolloutGate.end(),invitationMailer.end(),identityPolicy.end(),meteringIngest.end(),platformOperations.end(),connectorWorker.end(),workspaceProvider.end(),workspaceStore.close()]);
  globalThis.fetch=sharedCoreFetch;
  for(const key of Object.keys(process.env))if(!(key in sharedCoreEnvironment))delete process.env[key];
  Object.assign(process.env,sharedCoreEnvironment);
  sharedCoreCleanupFailures=closed.filter(result=>result.status==="rejected").map(result=>result.reason);
  printScenarioTiming("sharedCore",sharedCoreStartedAt);
}
if(sharedCoreCleanupFailures.length)throw new AggregateError([...metaLifecycleFailures,...sharedCoreCleanupFailures],"Shared PostgreSQL cleanup failed; independent suites are blocked");
if(!sharedCorePrerequisitesPassed)throw sharedCoreFailure;
return sharedCoreSummary;
}

await prepareDatabase();
const sharedCoreSummary=shouldRun("sharedCore")?await runSharedCore():undefined;

// Independent suites own their clients/tenants; prerequisite or cleanup failure never reaches this boundary.
if(shouldRun("currentOperatorLocks"))try{process.stdout.write(`${JSON.stringify(await runRegisteredScenario("currentOperatorLocks",()=>verifyCurrentOperatorLocks(adminUrl,appUrl,connectorWorkerConfig)))}\n`)}catch(error){metaLifecycleFailures.push(error);console.error("Current operator lock PostgreSQL failed",error)}
if(shouldRun("nativeMembership"))try{process.stdout.write(`${JSON.stringify(await runRegisteredScenario("nativeMembership",()=>verifyNativeMembership(adminUrl)))}\n`)}catch(error){metaLifecycleFailures.push(error);console.error("Native membership PostgreSQL failed",error)}
if(shouldRun("nativeRouting"))try{process.stdout.write(`${JSON.stringify(await runRegisteredScenario("nativeRouting",()=>verifyNativeRouting(adminUrl)))}\n`)}catch(error){metaLifecycleFailures.push(error);console.error("Native routing PostgreSQL failed",error)}
  // Lifecycle rotation retains append-only audit fixtures until the owned database is removed.
  // Run them after shared scheduler inventory assertions so no fixture changes their expected work set.
  for(const [name,verify] of [
    ["worker",()=>verifyMetaLifecycleWorker(adminUrl,connectorWorkerConfig)],
    ["consumers",()=>verifyMetaLifecycleConsumers(adminUrl,connectorWorkerConfig,appUrl)],
    ["ingress",()=>verifyMetaLifecycleIngress(adminUrl,appUrl)],
  ]){
    const scenario="metaLifecycle/"+name;
    if(!shouldRun(scenario))continue;
    try{console.log(JSON.stringify({metaLifecycle:name,result:await runRegisteredScenario(scenario,verify)}))}catch(error){metaLifecycleFailures.push(error);console.error(`Meta lifecycle ${name} failed`,error)}
  }
  if(shouldRun("metaNumberRelease"))try { console.log(JSON.stringify({ metaNumberRelease: await runRegisteredScenario("metaNumberRelease",()=>verifyMetaNumberRelease(adminUrl,appUrl,connectorWorkerConfig,cleanupUrl.toString())) })); } catch(error) { metaLifecycleFailures.push(error); console.error("Meta number release PostgreSQL failed",error); }
  if(shouldRun("metaSignup"))try { console.log(JSON.stringify({ metaSignup: await runRegisteredScenario("metaSignup",()=>verifyMetaSignup(adminUrl,appUrl,connectorWorkerConfig,cleanupUrl.toString())) })); } catch(error) { metaLifecycleFailures.push(error); console.error("Meta signup PostgreSQL failed",error); }
  // One explicit synthetic registry is shared only as immutable fixture input.
  const managedRuntimeEvidence=syntheticMetaManagedRuntimeEvidence();
  const metaCostOptions={adminUrl,workerConfig:connectorWorkerConfig,appUrl,
    platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:managedRuntimeEvidence};
  // Each suite owns its fixture tenant; collect independent failures before rejecting the wave.
  // Runtime registry inputs remain synthetic, never installed-image or live financial proof.
  for(const [name,verify] of [
    ["metaDeletion",()=>verifyMetaDeletionPostgres(adminUrl,appUrl,connectorWorkerConfig,platformOperationsUrl.toString(),cleanupUrl.toString())],
    ["metaPricingObservations",()=>verifyMetaPricingReceipts(adminUrl,connectorWorkerConfig,appUrl)],
    ["metaPublicTariffAcceptance",()=>verifyMetaPublicTariffAcceptance(metaCostOptions)],
    ["metaCostProducer",()=>verifyMetaCostFixtureProducers(metaCostOptions)],
    ["metaCostTariffAdmissions",()=>verifyMetaCostTariffAdmissions(metaCostOptions)],
    ["metaCostSelectorSemantics",()=>verifyMetaCostSelectorSemantics(metaCostOptions)],
    ["metaCostCustomerHistory",()=>verifyMetaCostCustomerHistory(metaCostOptions)],
    ["metaCostMoney",()=>verifyMetaCostMoneyAndCorrections(metaCostOptions)],
    ["metaCostCausalOrders",()=>verifyMetaCostCausalOrders(metaCostOptions)],
    ["metaCostHistoricalRepair",()=>verifyMetaCostHistoricalRepair(metaCostOptions)],
    ["metaCostFactInterleavings",()=>verifyMetaCostFactInterleavings(metaCostOptions)],
    ["metaCostActivationInterleaving",()=>verifyMetaCostActivationInterleaving(metaCostOptions)],
    ["metaCostPrivacyFences",()=>verifyMetaCostPrivacyFences(metaCostOptions)],
    ["metaCostRetention",()=>verifyMetaCostRetention(metaCostOptions)],
    ["metaCostLookupPrivacy",()=>verifyMetaCostLookupAndPrivacy(metaCostOptions)],
    ["metaCostSnapshotBound",()=>verifyMetaCostSnapshotBound(metaCostOptions)],
    ["metaCostFactAndBatchBounds",()=>verifyMetaCostFactAndBatchBounds(metaCostOptions)],
    ["metaCostStatements",()=>verifyMetaCostStatementsPostgres(metaCostOptions)],
    ["metaCostAgedExpiry",()=>verifyMetaCostAgedExpiry(metaCostOptions)],

    ["metaDirectIdentity",()=>verifyMetaDirectIdentityPostgres(adminUrl,connectorWorkerConfig,appUrl,platformOperationsUrl.toString(),metaIdentityRoutingHistory)],
    ["metaBillingDiagnostics",()=>verifyMetaBillingDiagnostics(adminUrl,connectorWorkerConfig,appUrl)],
    ["metaAccountPolicy",()=>verifyMetaAccountPolicy(adminUrl,connectorWorkerConfig,appUrl)],
    ["metaLegacyNullBilling",()=>verifyMetaLegacyNullBilling(adminUrl,connectorWorkerConfig,appUrl,true)],
    ["metaManagedSoftware",()=>verifyMetaManagedSoftware({
      adminUrl,workerConfig:connectorWorkerConfig,appUrl,platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:managedRuntimeEvidence,
    })],
    ["metaTransitionExecution",()=>verifyMetaTransitionExecution({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:syntheticMetaManagedRuntimeEvidence()})],
    ["metaTransitionSuccessors",()=>verifyMetaTransitionSuccessors({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:syntheticMetaManagedRuntimeEvidence()})],
    ["metaAccountIdentitySuccessor",()=>verifyMetaAccountIdentitySuccessorPostgres({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:syntheticMetaManagedRuntimeEvidence()})],
    ["metaTransitionObserverRenewal",()=>verifyMetaTransitionObserverRenewal({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:syntheticMetaManagedRuntimeEvidence()})],
    ["metaTemplatePreparation",()=>verifyMetaTemplatePreparation({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:managedRuntimeEvidence})],
    ["metaLegacyMigration",()=>verifyMetaLegacyMigration({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:managedRuntimeEvidence})],
    ["metaTransitionOperatorReviews",()=>verifyMetaTransitionOperatorReviews({adminUrl,workerConfig:connectorWorkerConfig,appUrl,cleanupUrl:cleanupUrl.toString(),platformOperationsUrl:platformOperationsUrl.toString(),runtimeEvidence:syntheticMetaManagedRuntimeEvidence()})],
  ]){
    if(!shouldRun(name))continue;
    try{console.log(JSON.stringify({[name]:await runRegisteredScenario(name,verify)}))}catch(error){metaLifecycleFailures.push(error);console.error(`Meta PostgreSQL ${name} failed`,error)}
  }
  if(metaLifecycleFailures.length)throw new AggregateError(metaLifecycleFailures,"Canonical shared/native/Meta PostgreSQL failure union");
if(sharedCoreSummary!==undefined)process.stdout.write(`${sharedCoreSummary}\n`);

if(shard!==undefined){
  if(shouldRun("postgresLoadRecovery")){
    await runRegisteredScenario("postgresLoadRecovery",()=>execFileSync(
      process.execPath,["--test","tests/postgres-load-recovery.test.mjs"],{stdio:"inherit",windowsHide:true},
    ));
  }
  verifyPostgresShard(shard,executed);
  if(report!==undefined)await writeFile(report,JSON.stringify({shard,scenarios:executed})+"\n");
}


function printScenarioTiming(scenario, startedAt) {
  console.log(JSON.stringify({ kind: "postgres-scenario-timing", scenario, durationMs: Math.round(performance.now() - startedAt) }));
}

async function timeScenario(scenario, run) {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    printScenarioTiming(scenario, startedAt);
  }
}

function required(name){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value}
function runtimeUrl(username,password){const value=new URL(appUrl);value.username=username;value.password=password;return value}
async function waitUntil(timestamp){const delay=timestamp-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay))}

async function proveFreshMigrationResume(){
  const database=`wasalx_migration_resume_${process.pid}_${Date.now()}`;
  const directory=await mkdtemp(resolve(tmpdir(),"wasalx-migration-resume-"));
  const maintenanceUrl=new URL(adminUrl);maintenanceUrl.pathname="/postgres";
  const databaseUrl=new URL(adminUrl);databaseUrl.pathname=`/${database}`;
  const legacyUrl=new URL(appUrl);legacyUrl.pathname=`/${database}`;
  const maintenance=new Client({connectionString:maintenanceUrl.toString()});
  const blockedSql="CREATE TABLE public.resume_probe (id integer);\nSELECT pg_advisory_xact_lock(8724591308);\n";
  let blocker;let inspector;let legacy;let created=false;let maintenanceConnected=false;let failure;
  const migrations=[];
  const previousAdminUrl=process.env.DATABASE_ADMIN_URL;
  try{
    await Promise.all([
      writeFile(resolve(directory,"0001_control_plane.sql"),"CREATE TABLE public.tenants (id uuid PRIMARY KEY);\n"),
      writeFile(resolve(directory,"0002_blocked_step.sql"),blockedSql),
      writeFile(resolve(directory,"0133_commercial_go_boundaries.sql"),"SELECT 1;\n"),
    ]);
    await maintenance.connect();maintenanceConnected=true;
    await maintenance.query(`CREATE DATABASE "${database}"`);created=true;
    blocker=new Client({connectionString:databaseUrl.toString()});
    inspector=new Client({connectionString:databaseUrl.toString()});
    await Promise.all([blocker.connect(),inspector.connect()]);
    await blocker.query("SELECT pg_advisory_lock(8724591308)");
    process.env.DATABASE_ADMIN_URL=databaseUrl.toString();
    const interrupted=migrate(directory).catch(error=>error);
    migrations.push(interrupted);
    let migrationPid;
    for(let attempt=0;attempt<200&&!migrationPid;attempt+=1){
      migrationPid=(await inspector.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='wasalx-migration' AND wait_event_type='Lock'`)).rows[0]?.pid;
      if(!migrationPid)await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(migrationPid,"fresh migration did not reach the blocked step");
    assert.deepEqual((await inspector.query("SELECT pg_terminate_backend($1) AS terminated",[migrationPid])).rows,[{terminated:true}]);
    const interruption=await interrupted;
    assert.ok(interruption?.code==="57P01"||interruption?.message==="Connection terminated unexpectedly");
    assert.deepEqual((await inspector.query("SELECT name FROM wasalx_schema_migrations ORDER BY name")).rows.map(({name})=>name),[
      "0001_control_plane.sql","__wasalx_clean_install_0133__",
    ]);
    assert.equal((await inspector.query("SELECT to_regclass('public.resume_probe')::text AS relation")).rows[0].relation,null);

    const markerChecksum=(await inspector.query("SELECT checksum_sha256 FROM wasalx_schema_migrations WHERE name='__wasalx_clean_install_0133__'")).rows[0].checksum_sha256;
    await writeFile(resolve(directory,"0002_blocked_step.sql"),`${blockedSql}-- manifest drift\n`);
    const drifted=migrate(directory);migrations.push(drifted);
    await assert.rejects(drifted,error=>error?.code==="55000");
    await writeFile(resolve(directory,"0002_blocked_step.sql"),blockedSql);

    await inspector.query("GRANT SELECT,INSERT,UPDATE,DELETE ON wasalx_schema_migrations TO wasalx_app");
    legacy=new Client({connectionString:legacyUrl.toString()});await legacy.connect();
    await legacy.query("UPDATE wasalx_schema_migrations SET checksum_sha256=$1 WHERE name='__wasalx_clean_install_0133__'",["0".repeat(64)]);
    const tampered=migrate(directory);migrations.push(tampered);
    await assert.rejects(tampered,error=>error?.code==="55000");
    assert.equal((await inspector.query("SELECT count(*)::integer AS count FROM wasalx_schema_migrations WHERE name='0133_commercial_go_boundaries.sql'")).rows[0].count,0);
    await inspector.query("UPDATE wasalx_schema_migrations SET checksum_sha256=$1 WHERE name='__wasalx_clean_install_0133__'",[markerChecksum]);
    await assert.rejects(legacy.query("SELECT name FROM wasalx_schema_migrations"),error=>error?.code==="42501");

    await inspector.query("GRANT SELECT,INSERT,UPDATE,DELETE ON wasalx_schema_migrations TO wasalx_app");
    await legacy.query("BEGIN");
    await legacy.query("UPDATE wasalx_schema_migrations SET checksum_sha256=checksum_sha256 WHERE name='__wasalx_clean_install_0133__'");
    const resumed=migrate(directory);migrations.push(resumed);
    let ledgerWait=false;
    for(let attempt=0;attempt<200&&!ledgerWait;attempt+=1){
      ledgerWait=(await inspector.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='wasalx-migration' AND wait_event_type='Lock'`)).rows[0].count===1;
      if(!ledgerWait)await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.equal(ledgerWait,true,"migration did not fence the in-flight legacy ledger writer");
    await legacy.query("COMMIT");
    for(let attempt=0;attempt<200;attempt+=1){
      const wait=(await inspector.query(`SELECT wait_event FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='wasalx-migration'`)).rows[0]?.wait_event;
      if(wait==="advisory")break;
      if(attempt===199)assert.fail("resumed migration did not reach the blocked transactional step");
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    for(const statement of [
      "SELECT name FROM wasalx_schema_migrations",
      "INSERT INTO wasalx_schema_migrations(name,checksum_sha256) VALUES ('unauthorized','"+"1".repeat(64)+"')",
      "UPDATE wasalx_schema_migrations SET checksum_sha256=checksum_sha256",
      "DELETE FROM wasalx_schema_migrations WHERE false",
    ])await assert.rejects(legacy.query(statement),error=>error?.code==="42501");
    await blocker.query("SELECT pg_advisory_unlock(8724591308)");
    await resumed;
    assert.deepEqual((await inspector.query("SELECT name FROM wasalx_schema_migrations ORDER BY name")).rows.map(({name})=>name),[
      "0001_control_plane.sql","0002_blocked_step.sql","0133_commercial_go_boundaries.sql",
    ]);
    assert.equal((await inspector.query("SELECT to_regclass('public.resume_probe')::text AS relation")).rows[0].relation,"resume_probe");
    assert.deepEqual((await inspector.query(`SELECT
      has_table_privilege('wasalx_app','public.wasalx_schema_migrations','SELECT') AS select_allowed,
      has_table_privilege('wasalx_app','public.wasalx_schema_migrations','INSERT') AS insert_allowed,
      has_table_privilege('wasalx_app','public.wasalx_schema_migrations','UPDATE') AS update_allowed,
      has_table_privilege('wasalx_app','public.wasalx_schema_migrations','DELETE') AS delete_allowed`)).rows,[{
      select_allowed:false,insert_allowed:false,update_allowed:false,delete_allowed:false,
    }]);
  }catch(error){failure=error}
  if(previousAdminUrl===undefined)delete process.env.DATABASE_ADMIN_URL;else process.env.DATABASE_ADMIN_URL=previousAdminUrl;
  const cleanupErrors=[];
  const cleanup=async operation=>{try{await operation()}catch(error){cleanupErrors.push(error)}};
  await cleanup(async()=>{if(legacy)await legacy.query("ROLLBACK")});
  await cleanup(async()=>{if(blocker)await blocker.query("SELECT pg_advisory_unlock(8724591308)")});
  await cleanup(async()=>{await Promise.allSettled(migrations)});
  for(const client of [legacy,blocker,inspector])if(client)await cleanup(()=>client.end());
  if(created)await cleanup(async()=>{
    await maintenance.query(`DROP DATABASE "${database}"`);
    assert.equal((await maintenance.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1",[database])).rows[0].count,0);
  });
  if(maintenanceConnected)await cleanup(()=>maintenance.end());
  await cleanup(()=>rm(directory,{recursive:true,force:true}));
  if(failure||cleanupErrors.length)throw new AggregateError([...(failure?[failure]:[]),...cleanupErrors],"fresh migration recovery proof failed");
}
