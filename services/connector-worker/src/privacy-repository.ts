import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { discoverCoexistencePrivacy, finalizeCoexistencePrivacy, exportCoexistencePrivacy } from "./meta-coexistence-privacy.js";
import { discoverMetaRoutingPrivacy,finalizeMetaRoutingPrivacy,exportMetaRoutingPrivacy } from "./meta-routing-privacy.js";

export type PrivacyJob = {
  id: string;
  tenantId: string;
  requestId?: string;
  jobType: "RETENTION_SWEEP" | "EXPORT" | "DELETE";
  scopeType: "TENANT" | "ZAMMAD_TICKET" | "REFERENCE" | "PARTICIPANT" | "ZAMMAD_USER";
  scopeValue: string;
  disposition: "RETENTION_DELETE" | "EXPORT_ONLY" | "DELETE_TICKETS" | "ZAMMAD_USER_DATA_PRIVACY";
  state: string;
  stage: "DISCOVER" | "EXTERNAL" | "EXPORT" | "LOCAL" | "DONE";
  attempts: number;
  maxAttempts: number;
  fencingToken: number;
  createdAt: string;
  zammadBaseUrl: string;
  zammadPrivacySecretReference: string;
  unmatchedDiagnosticHours: number;
  exportTtlHours: number;
};

export type PrivacyTarget = {
  id: string;
  type: "ZAMMAD_TICKET" | "ZAMMAD_USER" | "MEDIA_OBJECT" | "EXPORT_ARTIFACT" | "EXPORT_OBJECT" | "NORMALIZED_MESSAGE" | "DELIVERY" | "META_DIRECT_ALIAS" | "META_DIRECT_IDENTITY_EVENT"
    | "META_COEXISTENCE_MESSAGE" | "META_COEXISTENCE_CONTACT" | "META_COEXISTENCE_EVENT" | "META_COEXISTENCE_SUBJECT_CUTOFF" | "META_ROUTING_EVENT" | "META_ROUTING_ACTION" | "META_COST_SOURCE" | "FINANCE_SOURCE_REVIEW" | "META_COST_RECORD" | "META_SIGNUP_METADATA";
  targetId: string;
  state: "PENDING" | "EXTERNAL_COMPLETE" | "COMPLETE" | "SKIPPED";
  attempts: number;
  externalOperationId?: string;
  externalStartedAt?: string;
  objectKey?: string;
};

const PRIVACY_WORK_COUNTERS = [
  "zammadTickets",
  "botConversations",
  "normalizedMessages",
  "deliveryBodies",
  "participantIdentities",
  "metaDirectAliases",
  "metaDirectIdentityEvents",
  "metaRoutingEvents",
  "metaRoutingActions",
  "metaSignupAttempts",
  "groupWorkspaceParticipants",
  "mediaObjects",
  "exportArtifacts",
  "exportObjects",
  "unmatchedDiagnostics",
  "META_COEXISTENCE_MESSAGE",
  "META_COEXISTENCE_CONTACT",
  "META_COEXISTENCE_EVENT",
  "metaCostSourcesPurged",
  "metaCostSourcesRetained",
  "metaCostRecordsPurged",
  "metaCostRecordsRetained",
] as const;

export function shouldAuditPrivacySuccess(job: Pick<PrivacyJob, "jobType">, summary: Record<string, unknown>) {
  return job.jobType !== "RETENTION_SWEEP" || PRIVACY_WORK_COUNTERS.some((counter) => Number(summary[counter] ?? 0) !== 0);
}

type JobRow = {
  id: string;
  tenant_id: string;
  request_id: string | null;
  job_type: PrivacyJob["jobType"];
  scope_type: PrivacyJob["scopeType"];
  scope_value: string;
  disposition: PrivacyJob["disposition"];
  state: string;
  stage: PrivacyJob["stage"];
  attempts: number;
  max_attempts: number;
  fencing_token: string | number;
  created_at: string | Date;
  zammad_base_url: string;
  zammad_privacy_secret_reference: string;
  unmatched_diagnostic_hours: number;
  export_ttl_hours: number;
};

const APPLICABLE_MESSAGE_HOLD_SQL = `EXISTS (
  SELECT 1 FROM message_links protected_link
   WHERE protected_link.tenant_id=message.tenant_id
     AND protected_link.connection_id=message.connection_id
     AND protected_link.external_message_id=message.external_message_id
     AND app.has_applicable_privacy_hold('ZAMMAD_TICKET',protected_link.zammad_ticket_id)
)`;

const APPLICABLE_DELIVERY_HOLD_SQL = `(
  (delivery.zammad_ticket_id IS NOT NULL
    AND app.has_applicable_privacy_hold('ZAMMAD_TICKET',delivery.zammad_ticket_id))
  OR EXISTS (
    SELECT 1 FROM delivery_ticket_links protected_link
     WHERE protected_link.tenant_id=delivery.tenant_id
       AND protected_link.delivery_id=delivery.id
       AND app.has_applicable_privacy_hold('ZAMMAD_TICKET',protected_link.zammad_ticket_id)
  )
  OR EXISTS (
    SELECT 1
      FROM privacy_legal_holds hold
      LEFT JOIN group_bindings held_binding
        ON held_binding.tenant_id=delivery.tenant_id
       AND held_binding.id=delivery.group_binding_id
     WHERE hold.tenant_id=delivery.tenant_id
       AND hold.state='ACTIVE'
       AND (hold.expires_at IS NULL OR hold.expires_at>now())
       AND (
         hold.scope_type='TENANT'
         OR (hold.scope_type='GROUP_BINDING' AND lower(hold.scope_value)=delivery.group_binding_id::text)
         OR (hold.scope_type='WHATSAPP_GROUP' AND lower(hold.scope_value)=COALESCE(delivery.group_workspace_group_id,held_binding.whatsapp_group_id)::text)
         OR (hold.scope_type='PARTICIPANT' AND (
           (hold.scope_value=delivery.external_chat_id OR (delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,hold.scope_value)))
           OR hold.scope_value=ANY(delivery.mentions)
           OR EXISTS (
             SELECT 1
               FROM normalized_messages quoted_message
               JOIN whatsapp_groups quoted_group
                 ON quoted_group.tenant_id=quoted_message.tenant_id
                AND quoted_group.connection_id=quoted_message.connection_id
                AND quoted_group.external_group_id=quoted_message.external_group_id
              WHERE quoted_message.tenant_id=delivery.tenant_id
                AND quoted_message.connection_id=delivery.connection_id
                AND quoted_message.external_message_id=delivery.reply_to_message_id
                AND quoted_group.id=COALESCE(delivery.group_workspace_group_id,held_binding.whatsapp_group_id)
                AND quoted_message.external_participant_id=hold.scope_value
           )
         ))
       )
  )
)`;

const TARGETED_DELIVERY_SQL = `EXISTS (
  SELECT 1 FROM privacy_job_targets target
   WHERE target.tenant_id=delivery.tenant_id
     AND target.job_id=$2
     AND target.target_type='DELIVERY'
     AND target.target_id=delivery.id::text
)`;

// Shared deliveries remain retained, but their unresolved outcomes still fence ticket deletion.
const RELATED_DELIVERY_SQL = `(${TARGETED_DELIVERY_SQL} OR EXISTS (
  SELECT 1 FROM privacy_job_targets target
   WHERE target.tenant_id=delivery.tenant_id AND target.job_id=$2
     AND target.target_type='ZAMMAD_TICKET'
     AND (target.target_id=delivery.zammad_ticket_id OR EXISTS (
       SELECT 1 FROM delivery_ticket_links link
        WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id
          AND link.zammad_ticket_id=target.target_id
     ))
))`;

const NON_TARGET_MESSAGE_REFERENCE_SQL = `EXISTS (
  SELECT 1 FROM message_links retained_link
   WHERE retained_link.tenant_id=message.tenant_id
     AND retained_link.connection_id=message.connection_id
     AND retained_link.external_message_id=message.external_message_id
     AND NOT EXISTS (
       SELECT 1 FROM privacy_job_targets targeted_ticket
        WHERE targeted_ticket.tenant_id=retained_link.tenant_id
          AND targeted_ticket.job_id=$2
          AND targeted_ticket.target_type='ZAMMAD_TICKET'
          AND targeted_ticket.target_id=retained_link.zammad_ticket_id
     )
)`;

const NON_TARGET_DELIVERY_REFERENCE_SQL = `(
  (delivery.zammad_ticket_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM privacy_job_targets targeted_ticket
     WHERE targeted_ticket.tenant_id=delivery.tenant_id
       AND targeted_ticket.job_id=$2
       AND targeted_ticket.target_type='ZAMMAD_TICKET'
       AND targeted_ticket.target_id=delivery.zammad_ticket_id
  ))
  OR EXISTS (
    SELECT 1 FROM delivery_ticket_links retained_link
     WHERE retained_link.tenant_id=delivery.tenant_id
       AND retained_link.delivery_id=delivery.id
       AND NOT EXISTS (
         SELECT 1 FROM privacy_job_targets targeted_ticket
          WHERE targeted_ticket.tenant_id=retained_link.tenant_id
            AND targeted_ticket.job_id=$2
            AND targeted_ticket.target_type='ZAMMAD_TICKET'
            AND targeted_ticket.target_id=retained_link.zammad_ticket_id
       )
  )
)`;

export class PrivacyLegalHoldError extends Error {
  constructor() {
    super("An active legal hold blocks this privacy deletion");
    this.name = "PrivacyLegalHoldError";
  }
}

export class PrivacyRepository {
  constructor(private readonly pool: Pool) {}

  async expireHolds(tenantId: string) {
    return this.tenant(tenantId, async (client) => {
      const expired = (
        await client.query<{ id: string; scope_type: string; scope_sha256: string; expires_at: Date | string }>(
          `UPDATE privacy_legal_holds
              SET state='EXPIRED',released_at=expires_at,updated_at=now()
            WHERE tenant_id=$1 AND state='ACTIVE' AND expires_at<=now()
        RETURNING id,scope_type,scope_sha256,expires_at`,
          [tenantId],
        )
      ).rows;
      for (const hold of expired) {
        await client.query(
          `INSERT INTO audit_events
             (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
           VALUES ($1,'SYSTEM','privacy-worker','privacy.legal_hold_expired','privacy_legal_hold',$2,$3,$4,$5)`,
          [
            tenantId,
            hold.id,
            { state: "ACTIVE", scope_type: hold.scope_type, scope_sha256: hold.scope_sha256 },
            { state: "EXPIRED", expires_at: new Date(hold.expires_at).toISOString() },
            `privacy:hold-expiry:${hold.id}`,
          ],
        );
      }
      return expired.length;
    });
  }

  async ensureMaintenanceJob(tenantId: string) {
    return this.tenant(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${tenantId}`]);
      const policy = (
        await client.query<{ state: string; next_sweep_at: Date | string; unmatched_diagnostic_hours: number }>(
          "SELECT state,next_sweep_at,unmatched_diagnostic_hours FROM retention_policies WHERE tenant_id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      if (!policy || new Date(policy.next_sweep_at).getTime() > Date.now()) return null;
      const existing = (await client.query<{id:string}>(`SELECT id FROM privacy_jobs
        WHERE tenant_id=$1 AND job_type='RETENTION_SWEEP' AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
        ORDER BY created_at DESC,id DESC LIMIT 1`,[tenantId])).rows[0];
      if (existing) {
        await client.query("UPDATE retention_policies SET next_sweep_at=GREATEST(next_sweep_at+interval '1 hour',now()+interval '1 hour'),updated_at=now() WHERE tenant_id=$1",[tenantId]);
        return existing.id;
      }
      const period = Math.floor(new Date(policy.next_sweep_at).getTime() / 3_600_000);
      const created = (
        await client.query<{ id: string }>(
          `WITH candidate AS (SELECT gen_random_uuid() AS id)
           INSERT INTO privacy_jobs
             (id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,unmatched_diagnostic_hours_snapshot)
           SELECT id,$1::uuid,'RETENTION_SWEEP','TENANT',($1::uuid)::text,'RETENTION_DELETE',
                  'privacy:maintenance:'||$1::text||':'||$2::text||':'||id::text,$3
             FROM candidate
           RETURNING id`,
          [tenantId, period, policy.unmatched_diagnostic_hours],
        )
      ).rows[0]?.id ?? null;
      await client.query("UPDATE retention_policies SET next_sweep_at=GREATEST(next_sweep_at+interval '1 hour',now()+interval '1 hour'),updated_at=now() WHERE tenant_id=$1",[tenantId]);
      return created;
    });
  }

  async claim(tenantId: string, leaseId: string, limit = 10): Promise<PrivacyJob[]> {
    return this.tenant(tenantId, async (client) => {
      const rows = (
        await client.query<JobRow>(
          `WITH claimed AS (SELECT * FROM app.claim_privacy_jobs($1,$2))
           SELECT j.id,j.tenant_id,j.request_id,j.job_type,j.scope_type,j.scope_value,j.disposition,
                   j.state,j.stage,j.attempts,j.max_attempts,j.fencing_token,
                   to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                  z.base_url AS zammad_base_url,
                  z.privacy_secret_reference AS zammad_privacy_secret_reference,
                  COALESCE(j.unmatched_diagnostic_hours_snapshot,p.unmatched_diagnostic_hours) AS unmatched_diagnostic_hours,p.export_ttl_hours
             FROM claimed j
             JOIN zammad_instances z ON z.tenant_id=j.tenant_id
             JOIN retention_policies p ON p.tenant_id=j.tenant_id`,
          [leaseId, limit],
        )
      ).rows;
      for (const row of rows) {
        if (row.request_id) {
          await client.query(
            "UPDATE privacy_requests SET state='RUNNING',error_code=NULL,safe_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state IN ('QUEUED','FAILED_RETRYABLE')",
            [tenantId, row.request_id],
          );
        }
      }
      return rows.map(jobFromRow);
    });
  }

  async discover(job: PrivacyJob, leaseId: string) {
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${job.tenantId}`]);
      // A resumed retention manifest is immutable. Leave it blocked and let the
      // existing maintenance scheduler discover a fresh, hold-filtered sweep.
      if ((job.jobType === "DELETE" || (job.jobType === "RETENTION_SWEEP" && job.stage !== "DISCOVER"))
        && await this.hasApplicableHold(client, job)) throw new PrivacyLegalHoldError();
      await this.expireAbandonedBotUploads(client,job);
      await this.assertPrivacyWorkDrained(client,job);
      if (job.stage !== "DISCOVER") {
        if(job.jobType!=="EXPORT")await client.query("SELECT app.discover_meta_cost_privacy($1,$2,$3)",[job.id,leaseId,job.fencingToken]);
        return this.targetCounts(client, job);
      }

      await this.signupPrivacy(client,job,leaseId,"discover");
      if (job.scopeType === "ZAMMAD_USER" && job.jobType !== "EXPORT") {
        await this.insertTarget(client, job, "ZAMMAD_USER", job.scopeValue);
      }
      if (job.jobType === "EXPORT") {
        const ticketIds = await this.ticketIdsForScope(client, job);
        if (ticketIds.length > 250) throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many tickets; choose a narrower scope", false);
        for (const ticketId of ticketIds) await this.insertTarget(client, job, "ZAMMAD_TICKET", ticketId);
      }
      if (job.jobType !== "EXPORT") {
        await this.insertTicketTargets(client, job);
        await this.insertNormalizedTargets(client, job);
        await this.insertDeliveryTargets(client, job);
        await this.insertMediaTargets(client, job);
        await this.insertMetaDirectIdentityTargets(client, job);
        await discoverCoexistencePrivacy(client, job);
        await discoverMetaRoutingPrivacy(client,job);
        if (job.jobType === "DELETE") {
          await this.insertActiveArtifactTargets(client, job);
          await this.insertPendingCleanupTargets(client, job);
        }
        await this.freezeDeliveries(client, job);
      }
      if (job.jobType === "RETENTION_SWEEP") {
        await this.insertExpiredArtifactTargets(client, job);
      }
      if(job.jobType!=="EXPORT")await client.query("SELECT app.discover_meta_cost_privacy($1,$2,$3)",[job.id,leaseId,job.fencingToken]);
      await this.snapshotObjectKeys(client, job);

      const updated = await client.query(
        `UPDATE privacy_jobs SET stage=$1,updated_at=now()
          WHERE tenant_id=$2 AND id=$3 AND state='RUNNING' AND lease_id=$4
            AND fencing_token=$5 AND lease_expires_at>=now()`,
        [job.jobType === "EXPORT" ? "EXPORT" : "EXTERNAL", job.tenantId, job.id, leaseId, job.fencingToken],
      );
      if (updated.rowCount !== 1) throw new Error("Privacy job lease was lost during discovery");
      return this.targetCounts(client, job);
    },true);
  }

  async hasPendingFinanceReview(job:PrivacyJob){
    return this.tenant(job.tenantId,async client=>Boolean((await client.query(
      "SELECT 1 FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2 AND target_type='FINANCE_SOURCE_REVIEW' AND state='PENDING' LIMIT 1",
      [job.tenantId,job.id])).rowCount));
  }

  async targets(job: PrivacyJob): Promise<PrivacyTarget[]> {
    return this.tenant(job.tenantId, async (client) => (
      await client.query<{
        id: string;
        target_type: PrivacyTarget["type"];
        target_id: string;
        state: PrivacyTarget["state"];
        external_operation_id: string | null;
        external_started_at: Date | string | null;
        object_key: string | null;
        attempts: number;
      }>(
        `SELECT target.id,target.target_type,target.target_id,target.state,target.external_operation_id,target.external_started_at,
                target.object_key_snapshot AS object_key,target.attempts
           FROM privacy_job_targets target
          WHERE target.tenant_id=$1 AND target.job_id=$2
            AND target.target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','META_COST_SOURCE')
            AND target.state='PENDING'
          ORDER BY CASE target.target_type
            WHEN 'ZAMMAD_TICKET' THEN 1 WHEN 'ZAMMAD_USER' THEN 2
            WHEN 'MEDIA_OBJECT' THEN 3 WHEN 'EXPORT_ARTIFACT' THEN 4 WHEN 'EXPORT_OBJECT' THEN 5 ELSE 6 END,
            target.created_at,target.id
          LIMIT 25`,
        [job.tenantId, job.id],
      )
    ).rows.map((row) => ({
      id: row.id,
      type: row.target_type,
      targetId: row.target_id,
      state: row.state,
      attempts: Number(row.attempts),
      ...(row.external_operation_id ? { externalOperationId: row.external_operation_id } : {}),
      ...(row.external_started_at ? { externalStartedAt: new Date(row.external_started_at).toISOString() } : {}),
      ...(row.object_key ? { objectKey: row.object_key } : {}),
    })));
  }

  async hasPendingExternalTargets(job: PrivacyJob) {
    return this.tenant(job.tenantId, async client => (await client.query(
      `SELECT 1 FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2
        AND target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','META_COST_SOURCE')
        AND state='PENDING'
      UNION ALL SELECT 1 WHERE app.meta_cost_privacy_has_remaining($2) LIMIT 1`,
      [job.tenantId, job.id],
    )).rows.length > 0);
  }

  async setTargetOperation(job: PrivacyJob, leaseId: string, target: PrivacyTarget, operationId: string) {
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      const result = await client.query(
        `UPDATE privacy_job_targets
            SET external_operation_id=COALESCE(external_operation_id,$1),updated_at=now()
          WHERE tenant_id=$2 AND job_id=$3 AND id=$4 AND state='PENDING'
            AND (external_operation_id IS NULL OR external_operation_id=$1)`,
        [operationId, job.tenantId, job.id, target.id],
      );
      if (result.rowCount !== 1) throw new Error("Privacy target operation could not be fenced");
    });
  }

  async markTargetExternal(job: PrivacyJob, leaseId: string, target: PrivacyTarget) {
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      const result = await client.query(
        `UPDATE privacy_job_targets
            SET state='EXTERNAL_COMPLETE',error_code=NULL,safe_error=NULL,
                completed_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND job_id=$2 AND id=$3
            AND state IN ('PENDING','EXTERNAL_COMPLETE') AND external_started_at IS NOT NULL`,
        [job.tenantId, job.id, target.id],
      );
      if (result.rowCount !== 1) throw new Error("Privacy target completion could not be fenced");
    });
  }

  async renew(job: PrivacyJob, leaseId: string) {
    return this.tenant(job.tenantId, async (client) => {
      const renewed = await client.query(
        `UPDATE privacy_jobs SET lease_expires_at=now()+interval '15 minutes',updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND state='RUNNING' AND lease_id=$3
            AND fencing_token=$4 AND lease_expires_at>=now()`,
        [job.tenantId, job.id, leaseId, job.fencingToken],
      );
      if (renewed.rowCount !== 1) throw new Error("Privacy job lease was lost");
    });
  }

  async beginTargetExternal(job: PrivacyJob, leaseId: string, target: PrivacyTarget) {
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      const begun = await client.query<{ attempts: number }>(
        `UPDATE privacy_job_targets
            SET attempts=attempts+1,external_started_at=COALESCE(external_started_at,now()),updated_at=now()
          WHERE tenant_id=$1 AND job_id=$2 AND id=$3 AND state='PENDING'
          RETURNING attempts`,
        [job.tenantId, job.id, target.id],
      );
      if (begun.rows.length !== 1) throw new Error("Privacy target effect could not be fenced");
      const renewed = await client.query(
        `UPDATE privacy_jobs SET lease_expires_at=now()+interval '15 minutes',updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND state='RUNNING' AND lease_id=$3
            AND fencing_token=$4 AND lease_expires_at>=clock_timestamp()`,
        [job.tenantId, job.id, leaseId, job.fencingToken],
      );
      if (renewed.rowCount !== 1) throw new Error("Privacy job lease was lost");
      return Number(begun.rows[0]!.attempts);
    });
  }

  async exportData(job: PrivacyJob, leaseId: string) {
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      // Export the admitted native manifest; newly linked tickets need a new job.
      const ticketIds = (await client.query<{target_id:string}>(
        "SELECT target_id FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2 AND target_type='ZAMMAD_TICKET' ORDER BY target_id LIMIT 251",
        [job.tenantId,job.id],
      )).rows.map(row=>row.target_id);
      if (ticketIds.length > 250) throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many tickets; choose a narrower scope", false);
      const messages = (
        await client.query<Record<string, unknown>>(
          `${messageScopeCte(job)}
           SELECT message.id,message.external_message_id,message.external_group_id,
                  message.external_participant_id,message.participant_name,message.message_text,
                  message.quoted_external_message_id,message.from_api,message.from_me,
                  message.provider_timestamp,message.provider_metadata,message.created_at
             FROM normalized_messages message
            WHERE message.tenant_id=$1 AND ${messageScopePredicate(job)}
            ORDER BY message.provider_timestamp,message.id LIMIT 5001`,
          scopeParameters(job),
        )
      ).rows;
      if (messages.length > 5_000) throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many messages; choose a narrower scope", false);
      const correlations = (
        await client.query<Record<string, unknown>>(
          `SELECT id,group_binding_id,normalized_reference,zammad_ticket_id,zammad_ticket_number,
                  state,latest_external_message_id,created_at,updated_at
             FROM case_correlations
            WHERE tenant_id=$1 AND zammad_ticket_id=ANY($2::text[])
            ORDER BY created_at,id`,
          [job.tenantId, ticketIds],
        )
      ).rows;
      const botConversations = (
        await client.query<Record<string, unknown>>(
          `SELECT id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,
                  variables,step_count,zammad_ticket_id,zammad_ticket_number,last_external_message_id,
                  last_activity_at,resolved_at,created_at,updated_at
             FROM bot_conversations
            WHERE tenant_id=$1 AND zammad_ticket_id=ANY($2::text[])
            ORDER BY created_at,id LIMIT 251`,
          [job.tenantId, ticketIds],
        )
      ).rows;
      if (botConversations.length > 250) throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many direct conversations; choose a narrower scope", false);
      const conversationIds = botConversations.map((row) => String(row.id));
      const botEvents = conversationIds.length ? (
        await client.query<Record<string, unknown>>(
          `SELECT id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata,created_at
             FROM bot_conversation_events
            WHERE tenant_id=$1 AND conversation_id::text=ANY($2::text[])
            ORDER BY created_at,id LIMIT 25001`,
          [job.tenantId, conversationIds],
        )
      ).rows : [];
      if (botEvents.length > 25_000) throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many bot events; choose a narrower scope", false);
      const botActions = conversationIds.length ? (
        await client.query<Record<string, unknown>>(
          `SELECT id,conversation_id,action_node_id,request_input,state,response_variables,safe_error,
                  created_at,updated_at,completed_at
             FROM bot_action_jobs
            WHERE tenant_id=$1 AND conversation_id::text=ANY($2::text[])
            ORDER BY created_at,id LIMIT 25001`,
          [job.tenantId, conversationIds],
        )
      ).rows : [];
      if (botActions.length > 25_000) throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many bot actions; choose a narrower scope", false);
      const participantIds = job.scopeType === "PARTICIPANT"
        ? [job.scopeValue]
        : [...new Set([
            ...messages.map((message) => message.external_participant_id),
            ...botConversations.map((conversation) => conversation.external_chat_id),
          ].filter((value): value is string => typeof value === "string" && value.length > 0))];
      const identityParameters = job.scopeType === "TENANT" ? [job.tenantId] : [job.tenantId, participantIds];
      const identityPredicate = job.scopeType === "TENANT" ? "true" : "EXISTS(SELECT 1 FROM unnest($2::text[]) requested(value) WHERE app.meta_direct_participant_matches(participant_identities.connection_id,participant_identities.external_participant_id,requested.value))";
      const participantIdentities = job.scopeType === "TENANT" || participantIds.length > 0
        ? (
          await client.query<Record<string, unknown>>(
            `SELECT id,connection_id,external_participant_id,display_name,normalized_phone,created_at
               FROM participant_identities
              WHERE tenant_id=$1 AND ${identityPredicate}
              ORDER BY created_at,id LIMIT 5001`,
            identityParameters,
          )
        ).rows
        : [];
      if (participantIdentities.length > 5_000) {
        throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many participant identities; choose a narrower scope", false);
      }
      const groupWorkspaceParticipants = job.scopeType === "TENANT" || participantIds.length > 0
        ? (
          await client.query<Record<string, unknown>>(
            `SELECT whatsapp_group_id,external_participant_id,normalized_phone,display_name,synchronized_at
               FROM group_workspace_participants
              WHERE tenant_id=$1 AND ${job.scopeType === "TENANT" ? "true" : "external_participant_id=ANY($2::text[])"}
              ORDER BY synchronized_at,whatsapp_group_id,external_participant_id LIMIT 5001`,
            identityParameters,
          )
        ).rows
        : [];
      if (groupWorkspaceParticipants.length > 5_000) {
        throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export contains too many group participants; choose a narrower scope", false);
      }
      const metaDirectAliases=(await client.query<Record<string,unknown>>(`
        SELECT alias.id,alias.connection_id,alias.participant_identity_id,alias.provider_session_id,alias.phone_number_id,
          alias.waba_id,alias.kind,alias.value,alias.state,alias.revision,alias.source_event_id,alias.source_payload_sha256,alias.created_at,alias.account_transition_id,alias.predecessor_alias_id,
          app.meta_account_alias_export_receipt(alias.id) AS account_identity_receipt
        FROM meta_direct_identity_aliases alias JOIN participant_identities participant
          ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
        WHERE alias.tenant_id=$1 AND ($2::boolean OR EXISTS(SELECT 1 FROM unnest($3::text[]) requested(value)
          WHERE app.meta_direct_participant_matches(alias.connection_id,participant.external_participant_id,requested.value)))
        ORDER BY alias.created_at,alias.id LIMIT 5001`,[job.tenantId,job.scopeType==="TENANT",participantIds])).rows;
      const metaDirectIdentityEvents=(await client.query<Record<string,unknown>>(`
        SELECT source.id,source.connection_id,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.meta_direct_native_anchor,source.received_at
        FROM event_inbox source WHERE source.tenant_id=$1 AND (source.meta_direct_identity_change IS NOT NULL OR source.meta_direct_native_anchor IS NOT NULL)
          AND ($2::boolean OR EXISTS(SELECT 1 FROM unnest($3::text[]) requested(value) WHERE app.meta_direct_event_matches_scope(source.id,requested.value)))
        ORDER BY source.received_at,source.id LIMIT 5001`,[job.tenantId,job.scopeType==="TENANT",participantIds])).rows;
      if(metaDirectAliases.length>5000||metaDirectIdentityEvents.length>5000)throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE","Export contains too many direct identities; choose a narrower scope",false);
      const metaDirectRecipients=(await client.query<Record<string,unknown>>(`
        SELECT delivery.id AS delivery_id,delivery.connection_id,delivery.zammad_ticket_id,delivery.zammad_article_id,
          delivery.direct_origin,delivery.state,delivery.created_at,delivery.updated_at,delivery.meta_direct_recipient,
          receipt.id AS receipt_id,receipt.receipt_status,receipt.applied_state,receipt.provider_timestamp,receipt.receipt_key_sha256
        FROM delivery_outbox delivery LEFT JOIN delivery_receipts receipt
          ON receipt.tenant_id=delivery.tenant_id AND receipt.delivery_id=delivery.id
        WHERE delivery.tenant_id=$1 AND delivery.direct_origin IS NOT NULL AND delivery.content_redacted_at IS NULL
          AND delivery.meta_direct_recipient IS NOT NULL AND NOT (delivery.meta_direct_recipient ? 'redacted')
          AND ($2='TENANT' OR ($2='PARTICIPANT' AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,$3))
            OR delivery.zammad_ticket_id=ANY($4::text[]) OR EXISTS(SELECT 1 FROM delivery_ticket_links link
              WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id AND link.zammad_ticket_id=ANY($4::text[])))
        ORDER BY delivery.created_at,delivery.id,receipt.provider_timestamp,receipt.id LIMIT 5001`,
        [job.tenantId,job.scopeType,job.scopeValue,ticketIds])).rows;
      if(metaDirectRecipients.length>5000)throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE","Export contains too many direct delivery records; choose a narrower scope",false);
      const metaCoexistence = await exportCoexistencePrivacy(client, job);
      const metaBillingEvidence=(await client.query<Record<string,unknown>>(`SELECT delivery.id AS delivery_id,delivery.connection_id,delivery.state,delivery.created_at,
        delivery.meta_billing_snapshot,attempt.id AS attempt_id,attempt.attempt_number,attempt.state AS attempt_state,
        attempt.meta_billing_admission,attempt.meta_template_admission,attempt.external_message_id,attempt.started_at,attempt.finished_at
        FROM delivery_outbox delivery LEFT JOIN delivery_attempts attempt ON attempt.tenant_id=delivery.tenant_id AND attempt.delivery_id=delivery.id
        WHERE delivery.tenant_id=$1 AND delivery.content_redacted_at IS NULL
          AND (delivery.meta_billing_snapshot IS NOT NULL OR attempt.meta_billing_admission IS NOT NULL OR attempt.meta_template_admission IS NOT NULL)
          AND NOT(COALESCE(delivery.meta_billing_snapshot ? 'redacted',false))
          AND NOT(COALESCE(attempt.meta_billing_admission ? 'redacted',false))
          AND NOT(COALESCE(attempt.meta_template_admission ? 'redacted',false))
          AND ($2='TENANT' OR ($2='PARTICIPANT' AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,$3))
            OR delivery.zammad_ticket_id=ANY($4::text[]) OR EXISTS(SELECT 1 FROM delivery_ticket_links link WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id AND link.zammad_ticket_id=ANY($4::text[])))
        ORDER BY delivery.created_at,delivery.id,attempt.attempt_number LIMIT 5001`,[job.tenantId,job.scopeType,job.scopeValue,ticketIds])).rows;
      // Shared business-account settings belong to tenant export, never broaden a participant export.
      const metaAccountPolicies=job.scopeType==='TENANT' ? (await client.query<Record<string,unknown>>(`SELECT account.id,account.provider_account_id,account.observed_owner_business_id,
        account.independent_customer_ownership,account.state,account.authority_revision,account.funding_status,account.primary_funding_id,account.funding_response_sha256,account.funding_observed_at,account.funding_expires_at,account.actual_payer,
        observation.id AS funding_observation_operation_id,observation.payload->'metaAccountPolicy' AS funding_observation_binding,
        observation.result->'metaAccountFundingProof' AS private_funding_proof,
        policy.id AS policy_id,policy.version,policy.mode,policy.terms_version,policy.created_at,
        policy.commercial_terms_version_id,policy.accepted_tariff_version_id,policy.arrangement_version_id,
        binding.connection_id,binding.provider_session_id,binding.phone_number_id,binding.revision AS binding_revision,binding.state AS binding_state
        FROM meta_messaging_accounts account LEFT JOIN meta_billing_policy_versions policy ON policy.tenant_id=account.tenant_id AND policy.account_id=account.id
        LEFT JOIN meta_connection_account_bindings binding ON binding.tenant_id=account.tenant_id AND binding.account_id=account.id
        LEFT JOIN connection_operations observation ON observation.tenant_id=account.tenant_id
          AND observation.operation_type='VERIFY_META_BILLING' AND observation.payload#>>'{metaAccountPolicy,accountId}'=account.id::text
          AND observation.result ? 'metaAccountFundingProof' AND NOT(observation.result->'metaAccountFundingProof' ? 'redacted')
        WHERE account.tenant_id=$1 ORDER BY account.id,policy.version,binding.id,observation.created_at,observation.id LIMIT 5001`,[job.tenantId])).rows : [];
      if(metaBillingEvidence.length>5000||metaAccountPolicies.length>5000)throw new PrivacyRepositoryError('EXPORT_SCOPE_TOO_LARGE','Export contains too many payment-policy records; choose a narrower scope',false);
      const metaAccountTransitions=job.scopeType==='TENANT'?(await client.query<Record<string,unknown>>(`SELECT id,source_account_id,initiating_connection_id,
        requested_mode,target_currency,state,revision,created_at,updated_at,cancelled_at,observed_at,expires_at,
        execution_state,provider_status,provider_migration_id,target_account_id,reconciled_at,
        transition_kind,template_target_connection_id,template_state,template_observation_sha256,
        legacy_state,legacy_template_operation_id,legacy_review_operation_id,legacy_readback_operation_id,legacy_target_binding_id
        FROM meta_account_transitions WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 5001`,[job.tenantId])).rows:[];
      if(metaAccountTransitions.length>5000)throw new PrivacyRepositoryError('EXPORT_SCOPE_TOO_LARGE','Export contains too many account previews; choose a narrower scope',false);
      const metaRouting=await exportMetaRoutingPrivacy(client,job.tenantId,job.scopeType==="TENANT",participantIds);
      const metaManagedAuthority=job.scopeType==='TENANT' ? (await client.query<Record<string,unknown>>(`SELECT id,account_id,family_id,version,kind,evidence_mode,state,payer_authority_version_id,effective_scope_sha256,
        commercial_terms_version_id,allocation_line_version_id,expires_at,created_at,redacted_at,private_evidence_sha256
        FROM public.meta_funding_arrangement_versions WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 5001`,[job.tenantId])).rows : [];
      const metaFinancialEffects=job.scopeType==='TENANT' ? (await client.query<Record<string,unknown>>(`SELECT id,account_id,owner_kind,owner_id,stage,original_operation_id,
        original_fencing_token,authority_revision,policy_version_id,arrangement_version_id,runtime_execution,request_sha256,
        outcome,result,result_sha256,attempted_at,settled_at FROM public.meta_provider_effect_checkpoints
        WHERE tenant_id=$1 ORDER BY attempted_at,id LIMIT 5001`,[job.tenantId])).rows : [];
      if(metaManagedAuthority.length>5000||metaFinancialEffects.length>5000)throw new PrivacyRepositoryError('EXPORT_SCOPE_TOO_LARGE','Export contains too many managed account records; choose a narrower scope',false);
      const metaCostAssessments=(await client.query<Record<string,unknown>>(`
        SELECT assessment.* FROM meta_cost_assessments assessment JOIN delivery_outbox delivery
          ON delivery.tenant_id=assessment.tenant_id AND delivery.id=assessment.delivery_id
        WHERE assessment.tenant_id=$1 AND assessment.evidence_redacted_at IS NULL AND delivery.content_redacted_at IS NULL
          AND ($2='TENANT' OR ($2='PARTICIPANT' AND app.meta_cost_subject_delivery_matches(delivery,$3))
            OR delivery.zammad_ticket_id=ANY($4::text[]) OR EXISTS(SELECT 1 FROM delivery_ticket_links link
              WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id AND link.zammad_ticket_id=ANY($4::text[])))
        ORDER BY assessment.created_at,assessment.id LIMIT 5001`,[job.tenantId,job.scopeType,job.scopeValue,ticketIds])).rows;
      const metaCostTariffs=job.scopeType==='TENANT'?(await client.query<Record<string,unknown>>(
        'SELECT * FROM meta_cost_tariff_versions WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 5001',[job.tenantId])).rows:[];
      if(metaCostAssessments.length>5000||metaCostTariffs.length>5000)throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE","Export contains too much cost history; choose a narrower scope",false);
      const finance=(await client.query<{value:{metaCostStatements:Array<Record<string,unknown>>;metaCostSourceReviewStatus:Array<Record<string,unknown>>}}>(
        'SELECT app.export_meta_cost_statements($1,$2,$3,$4) value',[job.id,leaseId,job.fencingToken,ticketIds])).rows[0]?.value;
      if(!finance)throw new PrivacyRepositoryError("FINANCE_EXPORT_UNAVAILABLE","Financial privacy export is unavailable",false);
      const {metaCostStatements,metaCostSourceReviewStatus}=finance;
      const metaSignupAttempts = (await this.signupPrivacy(client,job,leaseId,"export")) as Array<Record<string,unknown>>;
      return { metaSignupAttempts, metaCostStatements, metaCostSourceReviewStatus, metaCostAssessments, metaCostTariffs, ticketIds, messages, participantIdentities, metaDirectAliases, metaDirectIdentityEvents, metaDirectRecipients, metaCoexistence, metaRouting, metaBillingEvidence, metaAccountPolicies, metaAccountTransitions, metaManagedAuthority, metaFinancialEffects, groupWorkspaceParticipants, correlations, botConversations, botEvents, botActions };
    });
  }

  async persistArtifact(job: PrivacyJob, leaseId: string, input: { objectKey: string; sha256: string; byteSize: number }) {
    if (!job.requestId) throw new Error("Export job has no request");
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${job.tenantId}`]);
      const pending = await client.query(
        "SELECT 1 FROM privacy_object_cleanup WHERE tenant_id=$1 AND job_id=$2 AND object_key=$3 AND state='PENDING' FOR UPDATE",
        [job.tenantId, job.id, input.objectKey],
      );
      if (pending.rows.length !== 1) throw new Error("Export upload cleanup intent is unavailable");
      const previous = (await client.query<{ object_key: string }>(
        "SELECT object_key FROM privacy_export_artifacts WHERE tenant_id=$1 AND request_id=$2 FOR UPDATE",
        [job.tenantId, job.requestId],
      )).rows[0]?.object_key;
      const artifact = (
        await client.query<{ id: string; expires_at: Date | string }>(
          `INSERT INTO privacy_export_artifacts
             (tenant_id,request_id,object_key,sha256,byte_size,expires_at)
           VALUES ($1,$2,$3,$4,$5,now()+make_interval(hours=>$6))
           ON CONFLICT (tenant_id,request_id) DO UPDATE
             SET object_key=EXCLUDED.object_key,sha256=EXCLUDED.sha256,
                 byte_size=EXCLUDED.byte_size,expires_at=EXCLUDED.expires_at,downloaded_at=NULL
           RETURNING id,expires_at`,
          [job.tenantId, job.requestId, input.objectKey, input.sha256, input.byteSize, job.exportTtlHours],
        )
      ).rows[0]!;
      await client.query(
        "UPDATE privacy_jobs SET stage='LOCAL',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_id=$3 AND fencing_token=$4",
        [job.tenantId, job.id, leaseId, job.fencingToken],
      );
      // Export targets authorize reads only. Mark their manifest complete with
      // the saved artifact, never route them through destructive external work.
      await client.query(
        "UPDATE privacy_job_targets SET state='COMPLETE',completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND job_id=$2 AND target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','META_SIGNUP_METADATA') AND state='PENDING'",
        [job.tenantId, job.id],
      );
      await client.query(
        "DELETE FROM privacy_object_cleanup WHERE tenant_id=$1 AND job_id=$2 AND object_key=$3",
        [job.tenantId, job.id, input.objectKey],
      );
      if (previous && previous !== input.objectKey) {
        await client.query(
          `INSERT INTO privacy_object_cleanup (tenant_id,job_id,object_key,state)
           VALUES ($1,$2,$3,'PENDING') ON CONFLICT (tenant_id,object_key) DO NOTHING`,
          [job.tenantId, job.id, previous],
        );
      }
      return { id: artifact.id, expiresAt: new Date(artifact.expires_at).toISOString() };
    });
  }

  async reserveArtifactUpload(job: PrivacyJob, leaseId: string, objectKey: string) {
    if (!job.requestId || objectKey !== `tenants/${job.tenantId}/privacy-exports/${job.requestId}-${job.fencingToken}.json`) {
      throw new Error("Export object key is invalid");
    }
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      await client.query(
        `INSERT INTO privacy_object_cleanup (tenant_id,job_id,object_key,state)
         VALUES ($1,$2,$3,'PENDING') ON CONFLICT (tenant_id,object_key) DO NOTHING`,
        [job.tenantId, job.id, objectKey],
      );
    });
  }

  async finalize(job: PrivacyJob, leaseId: string) {
    return this.tenant(job.tenantId, async (client) => {
      await this.assertLease(client, job, leaseId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${job.tenantId}`]);
      if (job.jobType === "DELETE" && await this.hasApplicableHold(client, job)) throw new PrivacyLegalHoldError();
      await this.assertPrivacyWorkDrained(client,job);
      const pendingExternal = await client.query(
        `SELECT 1 FROM privacy_job_targets
          WHERE tenant_id=$1 AND job_id=$2
            AND target_type IN ('ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','META_COST_SOURCE')
             AND state='PENDING' LIMIT 1`,
        [job.tenantId, job.id],
      );
      if (pendingExternal.rowCount) throw new Error("Privacy external cleanup is incomplete");

      const targetCounts = await this.targetCounts(client, job);
      // A saved export has a read manifest, never deletion authority. Return
      // before any redaction, detachment or cleanup of tenant business data.
      if (job.jobType === "EXPORT") {
        if (Object.keys(targetCounts).some(type => !["ZAMMAD_TICKET", "ZAMMAD_USER", "META_SIGNUP_METADATA"].includes(type))) {
          throw new Error("Export manifest contains a destructive target");
        }
        return {
          zammadTickets: targetCounts.ZAMMAD_TICKET ?? 0,
          botConversations: 0, normalizedMessages: 0, deliveryBodies: 0,
          participantIdentities: 0, groupWorkspaceParticipants: 0,
          mediaObjects: 0, exportArtifacts: 0, exportObjects: 0, unmatchedDiagnostics: 0,
        };
      }

      const unmatched = job.jobType === "RETENTION_SWEEP"
        ? Number((await client.query<{ count: string | number }>(
          "SELECT app.purge_expired_unmatched_events(make_interval(hours=>$1),$2::timestamptz) AS count",
          [job.unmatchedDiagnosticHours,job.createdAt],
        )).rows[0]?.count ?? 0)
        : 0;

      const ticketCount = targetCounts.ZAMMAD_TICKET ?? 0;
      const normalizedCount = targetCounts.NORMALIZED_MESSAGE ?? 0;
      let deliveryBodies = 0;
      const unresolvedDelivery = await client.query(
          `SELECT 1 FROM delivery_outbox delivery
            WHERE delivery.tenant_id=$1 AND (
                delivery.state IN ('SENDING','OUTCOME_UNKNOWN')
                OR (delivery.state='CLAIMED' AND delivery.lease_expires_at>=now())
              )
              AND ${RELATED_DELIVERY_SQL}
            LIMIT 1`,
          [job.tenantId,job.id],
        );
        if (unresolvedDelivery.rowCount) {
          throw new PrivacyRepositoryError("DELIVERY_OUTCOME_UNRESOLVED", "A related delivery must be resolved before privacy processing can continue", true);
        }
      const local = await client.query(`UPDATE privacy_jobs SET stage='LOCAL',updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND state='RUNNING' AND stage IN ('EXTERNAL','LOCAL')
            AND lease_id=$3 AND fencing_token=$4 AND lease_expires_at>=clock_timestamp()
          RETURNING id`,[job.tenantId,job.id,leaseId,job.fencingToken]);
      if (local.rowCount !== 1) throw new Error("Privacy job lease or local stage was lost");
      const metaSignupAttempts = targetCounts.META_SIGNUP_METADATA
        ? Number(await this.signupPrivacy(client,job,leaseId,"redact")) : 0;
      // Forward-seal only still-present ordinary completion evidence before
      // its authorized content purge. No seal is reconstructed from a redacted history.
      if(normalizedCount && (job.jobType==='RETENTION_SWEEP'||(job.jobType==='DELETE'&&job.scopeType==='ZAMMAD_TICKET')))await client.query(`UPDATE event_inbox source SET
          meta_direct_native_anchor=COALESCE(source.meta_direct_native_anchor,jsonb_build_object('schemaVersion',1,'participantId',participant.id::text,'nativeCustomerId',message.provider_metadata->>'zammad_customer_id','payloadSha256',source.payload_sha256)),
          meta_direct_anchor_retention_job_id=$2, payload='{}'::jsonb,provider_event_id='redacted:'||source.provider_event_id_sha256,status='REDACTED',safe_error=NULL
          FROM normalized_messages message JOIN participant_identities participant ON participant.tenant_id=message.tenant_id AND participant.connection_id=message.connection_id AND participant.external_participant_id=message.external_participant_id
          WHERE source.tenant_id=$1 AND message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id AND source.provider='META'
            AND source.event_type='messages' AND source.payload#>>'{entry,0,changes,0,field}'='messages'
            AND source.meta_direct_asset IS NOT NULL AND source.meta_direct_identity_change IS NULL AND source.status NOT IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED')
            AND message.provider_metadata->'direct'='true' AND EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=message.tenant_id AND target.job_id=$2
              AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text AND target.state IN('PENDING','EXTERNAL_COMPLETE'))
            AND app.meta_direct_anchor_needed(source.id,$2::uuid)`,[job.tenantId,job.id]);
      await finalizeMetaRoutingPrivacy(client,job);
      await finalizeCoexistencePrivacy(client, job);
      // Exact LOCAL target references remain present for admission minimization.
      if(job.jobType==='DELETE')await client.query('SELECT app.redact_meta_template_admissions($1,$2,$3)',[job.id,leaseId,job.fencingToken]);
      let botConversations = 0;
      if (ticketCount) {
        await client.query(`WITH replacement AS (
          SELECT delivery.tenant_id,delivery.id,min(link.zammad_ticket_id) AS zammad_ticket_id
          FROM delivery_outbox delivery JOIN delivery_ticket_links link ON link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id
          WHERE delivery.tenant_id=$1
            AND EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=delivery.tenant_id AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=delivery.zammad_ticket_id)
            AND NOT EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=link.tenant_id AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=link.zammad_ticket_id)
          GROUP BY delivery.tenant_id,delivery.id
        ) UPDATE delivery_outbox delivery SET zammad_ticket_id=replacement.zammad_ticket_id,updated_at=now()
          FROM replacement WHERE delivery.tenant_id=replacement.tenant_id AND delivery.id=replacement.id
        `,[job.tenantId,job.id]);
        await client.query(`UPDATE zammad_status_outbox status
          SET zammad_ticket_id='[removed]:'||status.id::text,external_message_id=NULL,
              completed_at=COALESCE(status.completed_at,now()),lease_id=NULL,lease_expires_at=NULL,
              safe_error='Content removed by privacy lifecycle.',updated_at=now()
          WHERE status.tenant_id=$1 AND EXISTS (
            SELECT 1 FROM privacy_job_targets target
             WHERE target.tenant_id=status.tenant_id AND target.job_id=$2
               AND target.target_type='ZAMMAD_TICKET' AND target.target_id=status.zammad_ticket_id
          )`,[job.tenantId,job.id]);
        await client.query(`DELETE FROM delivery_ticket_links link WHERE link.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=link.tenant_id AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=link.zammad_ticket_id)`,[job.tenantId,job.id]);
        await client.query(`DELETE FROM message_links link WHERE link.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=link.tenant_id AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=link.zammad_ticket_id)`,[job.tenantId,job.id]);
      }
      await client.query(
          `UPDATE quarantine_records review
              SET state='DISCARDED',safe_summary='Content removed by privacy lifecycle.',safe_metadata='{}'::jsonb,
                  reprocess_event_id=NULL,resolution_code='PRIVACY_DELETED',resolved_by=NULL,
                  resolved_at=COALESCE(review.resolved_at,now()),version=review.version+1,updated_at=now()
             FROM delivery_outbox delivery
            WHERE review.tenant_id=$1 AND review.delivery_id=delivery.id
              AND delivery.tenant_id=review.tenant_id
              AND ${TARGETED_DELIVERY_SQL}
              AND NOT ${APPLICABLE_DELIVERY_HOLD_SQL}
              AND NOT ${NON_TARGET_DELIVERY_REFERENCE_SQL}`,
          [job.tenantId,job.id],
        );
        await client.query(
          `UPDATE zammad_status_outbox status
              SET zammad_ticket_id='[removed]:'||status.id::text,external_message_id=NULL,
                  completed_at=COALESCE(status.completed_at,now()),lease_id=NULL,lease_expires_at=NULL,
                  safe_error='Content removed by privacy lifecycle.',updated_at=now()
             FROM delivery_outbox delivery
            WHERE status.tenant_id=$1 AND status.delivery_id=delivery.id
              AND delivery.tenant_id=status.tenant_id
              AND ${TARGETED_DELIVERY_SQL}
              AND NOT ${APPLICABLE_DELIVERY_HOLD_SQL}
              AND NOT ${NON_TARGET_DELIVERY_REFERENCE_SQL}`,
          [job.tenantId,job.id],
        );
        await client.query(`UPDATE delivery_attempts attempt SET meta_billing_admission=CASE WHEN attempt.meta_billing_admission IS NULL THEN NULL
          ELSE jsonb_build_object('redacted',true,'sha256',encode(digest(attempt.meta_billing_admission::text,'sha256'),'hex')) END,external_message_id=NULL
          FROM delivery_outbox delivery WHERE attempt.tenant_id=$1 AND delivery.tenant_id=attempt.tenant_id AND delivery.id=attempt.delivery_id
            AND ${TARGETED_DELIVERY_SQL} AND NOT ${APPLICABLE_DELIVERY_HOLD_SQL} AND NOT ${NON_TARGET_DELIVERY_REFERENCE_SQL}`,[job.tenantId,job.id]);
        await client.query(
          `UPDATE delivery_outbox delivery
              SET state=CASE WHEN delivery.state IN ('SENT','DELIVERED','READ','FAILED_TERMINAL','PRIVACY_CANCELLED')
                    THEN delivery.state ELSE 'PRIVACY_CANCELLED' END,
                  group_binding_id=NULL,group_workspace_group_id=NULL,bot_conversation_id=NULL,ticket_event_execution_id=NULL,
                  zammad_ticket_id=NULL,zammad_article_id=NULL,message_body='',content_type='text/plain',
                  mentions='{}'::text[],reply_to_message_id=NULL,external_chat_id=NULL,bot_content=NULL,
                  meta_direct_recipient=CASE WHEN delivery.meta_direct_recipient IS NULL THEN NULL
                    ELSE jsonb_build_object('redacted',true,'sha256',encode(digest(delivery.meta_direct_recipient::text,'sha256'),'hex')) END,
                  meta_billing_snapshot=CASE WHEN delivery.meta_billing_snapshot IS NULL THEN NULL
                    ELSE jsonb_build_object('redacted',true,'sha256',encode(digest(delivery.meta_billing_snapshot::text,'sha256'),'hex')) END,
                  external_message_id=NULL,
                  direct_origin=NULL,agent_display_name=NULL,agent_prefix_snapshot=NULL,
                  agent_identity_placement_snapshot=NULL,manual_retry_allowed=false,
                  blocked_by_delivery_id=NULL,lease_id=NULL,lease_expires_at=NULL,
                  safe_error='Content removed by privacy lifecycle.',
                  content_redacted_at=COALESCE(delivery.content_redacted_at,now()),updated_at=now()
            WHERE delivery.tenant_id=$1
              AND delivery.content_redacted_at IS NULL
              AND ${TARGETED_DELIVERY_SQL}
              AND NOT ${APPLICABLE_DELIVERY_HOLD_SQL}
              AND NOT ${NON_TARGET_DELIVERY_REFERENCE_SQL}`,
          [job.tenantId,job.id],
        );
        await client.query(
          `UPDATE group_disclosure_deliveries disclosure SET external_message_id=NULL,updated_at=now()
             FROM delivery_outbox delivery
            WHERE disclosure.tenant_id=$1 AND disclosure.delivery_id=delivery.id
              AND delivery.tenant_id=disclosure.tenant_id AND delivery.content_redacted_at IS NOT NULL
              AND ${TARGETED_DELIVERY_SQL}`,
          [job.tenantId,job.id],
        );
        await client.query(
          `UPDATE delivery_receipts receipt SET external_message_id=NULL
             FROM delivery_outbox delivery
            WHERE receipt.tenant_id=$1 AND receipt.delivery_id=delivery.id
              AND delivery.tenant_id=receipt.tenant_id AND delivery.content_redacted_at IS NOT NULL
              AND receipt.external_message_id IS NOT NULL AND ${TARGETED_DELIVERY_SQL}`,
          [job.tenantId,job.id],
        );
        await client.query(
          `UPDATE event_inbox inbox SET payload='{}'::jsonb,
                   provider_event_id='redacted:'||inbox.provider_event_id_sha256,
                   status='REDACTED',safe_error=NULL,
                  processed_at=COALESCE(inbox.processed_at,now()),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE inbox.tenant_id=$1 AND EXISTS (
              SELECT 1 FROM delivery_receipts receipt JOIN delivery_outbox delivery
                ON delivery.tenant_id=receipt.tenant_id AND delivery.id=receipt.delivery_id
               WHERE receipt.tenant_id=inbox.tenant_id AND receipt.event_inbox_id=inbox.id
                 AND delivery.content_redacted_at IS NOT NULL AND ${TARGETED_DELIVERY_SQL}
            )`,
          [job.tenantId,job.id],
        );
        deliveryBodies = Number((await client.query<{ count: string | number }>(
          `SELECT count(*) AS count FROM delivery_outbox delivery
            WHERE delivery.tenant_id=$1 AND delivery.content_redacted_at IS NOT NULL
              AND ${TARGETED_DELIVERY_SQL}`,
          [job.tenantId,job.id],
        )).rows[0]?.count ?? 0);
      if (ticketCount) {
        // Preserve unresolved receipts; the migration guard independently checks
        // the still-visible conversation before known terminal detachment.
        await client.query(`DELETE FROM direct_customer_close_commands command WHERE command.tenant_id=$1
          AND command.state IN ('SUCCEEDED','FAILED_TERMINAL') AND EXISTS(SELECT 1 FROM bot_conversations conversation
            JOIN privacy_job_targets target ON target.tenant_id=conversation.tenant_id AND target.target_id=conversation.zammad_ticket_id
            WHERE conversation.tenant_id=command.tenant_id AND conversation.id=command.conversation_id
              AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET')`,[job.tenantId,job.id]);
        // Detach redacted delivery receipts before cascading their case executions.
        await client.query(`DELETE FROM case_correlations correlation WHERE correlation.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=correlation.tenant_id AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=correlation.zammad_ticket_id)`,[job.tenantId,job.id]);
        const targetedTicket = `EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=$1 AND target.job_id=$2 AND target.target_type='ZAMMAD_TICKET' AND target.target_id=zammad_ticket_id)`;
        botConversations = (await client.query(`DELETE FROM bot_conversations conversation WHERE conversation.tenant_id=$1 AND ${targetedTicket}
          AND NOT EXISTS (SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=conversation.tenant_id
            AND delivery.bot_conversation_id=conversation.id)`,[job.tenantId,job.id])).rowCount ?? 0;
      }
      // Account configuration is shared business data; only a tenant deletion retires it.
      // Historical IDs/policy versions remain attributable; no active authority survives.
      let metaManagedAuthority=0,metaFinancialEffects=0;
      if(job.jobType==='DELETE'&&job.scopeType==='TENANT') {
        await client.query('SELECT app.redact_meta_legacy_migrations($1,$2,$3)',[job.id,leaseId,job.fencingToken]);
        // Template effects are checked before any template intent is cancelled or minimized.
        await client.query('SELECT app.redact_meta_template_preparations($1,$2,$3)',[job.id,leaseId,job.fencingToken]);
        // Local tenant erasure cancels only read plans; it performs no provider or funding effect.
        await client.query(`UPDATE meta_account_transitions SET state='CANCELLED',revision=revision+1,cancelled_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND state<>'CANCELLED' AND execution_state='UNPREPARED' AND transition_kind='CURRENCY'`,[job.tenantId]);
        await client.query('SELECT app.redact_meta_transition_observer_proofs($1,$2,$3)',[job.id,leaseId,job.fencingToken]);
        await client.query('SELECT app.redact_meta_transition_private_scope($1,$2,$3)',[job.id,leaseId,job.fencingToken]);
        await client.query('UPDATE meta_account_transitions SET requested_by=NULL WHERE tenant_id=$1 AND requested_by IS NOT NULL',[job.tenantId]);
        await client.query(`UPDATE connection_operations SET result=jsonb_build_object('redacted',true,'sha256',encode(digest(result::text,'sha256'),'hex'))
          WHERE tenant_id=$1 AND operation_type IN('PREVIEW_META_ACCOUNT_TRANSITION','EXECUTE_META_ACCOUNT_TRANSITION') AND result IS NOT NULL AND NOT(result ? 'redacted')`,[job.tenantId]);
        metaFinancialEffects=(await client.query(`UPDATE public.meta_provider_effect_checkpoints SET result=jsonb_build_object('redacted',true,'sha256',encode(digest(result::text,'sha256'),'hex'))
          WHERE tenant_id=$1 AND outcome NOT IN('ATTEMPTED','UNKNOWN') AND result IS NOT NULL AND NOT(result ? 'redacted')`,[job.tenantId])).rowCount??0;
        metaManagedAuthority=(await client.query(`UPDATE public.meta_funding_arrangement_versions SET state='REVOKED',financial_secret_reference='[removed]',
          financial_credential_metadata=jsonb_build_object('redacted',true,'sha256',encode(digest(financial_credential_metadata::text,'sha256'),'hex')),
          private_evidence_sha256=encode(digest((to_jsonb(meta_funding_arrangement_versions)-ARRAY['redacted_at','private_evidence_sha256'])::text,'sha256'),'hex'),redacted_at=clock_timestamp()
          WHERE tenant_id=$1 AND redacted_at IS NULL`,[job.tenantId])).rowCount??0;
        await client.query(`UPDATE meta_connection_account_bindings SET state='RETIRED',secret_reference='[removed]',
          credential_fingerprint=repeat('0',64),proof_sha256=repeat('0',64),revision=revision+1,updated_at=now()
          WHERE tenant_id=$1 AND state<>'RETIRED'`,[job.tenantId]);
        await client.query(`UPDATE meta_messaging_accounts SET state='RETIRED',observed_owner_business_id=NULL,
          primary_funding_id=NULL,funding_status='UNAVAILABLE',funding_expires_at=NULL,authority_revision=authority_revision+1,updated_at=now()
          WHERE tenant_id=$1 AND state<>'RETIRED'`,[job.tenantId]);
        await client.query(`UPDATE connection_operations SET result=jsonb_set(result,'{metaAccountFundingProof}',
          jsonb_build_object('redacted',true,'sha256',encode(digest((result->'metaAccountFundingProof')::text,'sha256'),'hex')))
          WHERE tenant_id=$1 AND result ? 'metaAccountFundingProof' AND NOT(result->'metaAccountFundingProof' ? 'redacted')`,[job.tenantId]);
      }
      let participantIdentities = 0;
      let metaDirectAliases = 0;
      let metaDirectIdentityEvents = 0;
      let groupWorkspaceParticipants = 0;
      if (job.jobType === "DELETE" && (job.scopeType === "TENANT" || job.scopeType === "PARTICIPANT")) {
        const values = job.scopeType === "TENANT" ? [job.tenantId] : [job.tenantId, [job.scopeValue]];
        const predicate = job.scopeType === "TENANT" ? "true" : "external_participant_id=ANY($2::text[])";
        groupWorkspaceParticipants = (
          await client.query(`DELETE FROM group_workspace_participants WHERE tenant_id=$1 AND ${predicate}`, values)
        ).rowCount ?? 0;
        participantIdentities = (
          await client.query(`DELETE FROM participant_identities participant WHERE participant.tenant_id=$1
          AND ($2::text IS NULL OR app.meta_direct_participant_matches(participant.connection_id,participant.external_participant_id,$2))
          AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id
            AND alias.participant_identity_id=participant.id AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target
              WHERE target.tenant_id=alias.tenant_id AND target.job_id=$3 AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text))`,
          [job.tenantId,job.scopeType==="TENANT"?null:job.scopeValue,job.id])
        ).rowCount ?? 0;
      } else if (job.jobType === "DELETE" && job.scopeType === "ZAMMAD_USER") {
        groupWorkspaceParticipants = (await client.query(`DELETE FROM group_workspace_participants participant WHERE participant.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM normalized_messages message JOIN privacy_job_targets target ON target.tenant_id=message.tenant_id AND target.job_id=$2 AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
          WHERE message.tenant_id=participant.tenant_id AND message.external_participant_id=participant.external_participant_id)`,[job.tenantId,job.id])).rowCount ?? 0;
        participantIdentities = (await client.query(`DELETE FROM participant_identities participant WHERE participant.tenant_id=$1 AND (EXISTS (
          SELECT 1 FROM normalized_messages message JOIN privacy_job_targets target ON target.tenant_id=message.tenant_id AND target.job_id=$2 AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
          WHERE message.tenant_id=participant.tenant_id AND message.connection_id=participant.connection_id
          AND (message.external_participant_id=participant.external_participant_id OR
           (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,participant.external_participant_id))))
          OR EXISTS(SELECT 1 FROM event_inbox anchor WHERE anchor.tenant_id=participant.tenant_id AND anchor.connection_id=participant.connection_id
            AND anchor.meta_direct_native_anchor->>'participantId'=participant.id::text AND anchor.meta_direct_native_anchor->>'nativeCustomerId'=$3))
          AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id AND alias.participant_identity_id=participant.id
            AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=alias.tenant_id AND target.job_id=$2
              AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text))`,[job.tenantId,job.id,job.scopeValue])).rowCount ?? 0;
      }
      // Local identity evidence is discovered and lease-fenced exactly like other privacy targets.
      await client.query(`UPDATE quarantine_records review SET state='DISCARDED',safe_metadata='{}'::jsonb,
        safe_summary='Content removed by privacy lifecycle.',reprocess_event_id=NULL,resolution_code='PRIVACY_DELETED',
        resolved_by=NULL,resolved_at=COALESCE(resolved_at,now()),version=version+1,updated_at=now()
        WHERE review.tenant_id=$1 AND (EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=review.tenant_id
          AND target.job_id=$2 AND target.target_type='META_DIRECT_IDENTITY_EVENT' AND target.target_id=review.source_event_inbox_id::text)
          OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias JOIN privacy_job_targets target
            ON target.tenant_id=alias.tenant_id AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text
            WHERE alias.tenant_id=review.tenant_id AND alias.source_event_id=review.source_event_inbox_id AND target.job_id=$2))`,[job.tenantId,job.id]);
      metaDirectIdentityEvents=(await client.query(`UPDATE event_inbox source SET payload='{}'::jsonb,
        meta_direct_identity_change=CASE WHEN source.meta_direct_identity_change IS NULL THEN NULL
          WHEN source.meta_direct_identity_change->'redacted'='true'::jsonb THEN source.meta_direct_identity_change
          ELSE jsonb_build_object('redacted',true,'scope','ASSET','payloadSha256',source.payload_sha256,
            'sha256',encode(digest(source.meta_direct_identity_change::text,'sha256'),'hex')) END,
        meta_direct_identity_transition=CASE WHEN source.meta_direct_identity_transition IS NULL OR source.meta_direct_identity_transition->'redacted'='true'::jsonb THEN source.meta_direct_identity_transition
          ELSE jsonb_build_object('redacted',true,'sha256',encode(digest(source.meta_direct_identity_transition::text,'sha256'),'hex')) END,
        meta_direct_identity_resolution=CASE WHEN source.meta_direct_identity_resolution IS NULL OR source.meta_direct_identity_resolution->'redacted'='true'::jsonb THEN source.meta_direct_identity_resolution
          ELSE jsonb_build_object('redacted',true,'sha256',encode(digest(source.meta_direct_identity_resolution::text,'sha256'),'hex')) END,
        meta_direct_native_anchor=CASE WHEN source.meta_direct_native_anchor IS NULL OR source.meta_direct_native_anchor->'redacted'='true'::jsonb THEN source.meta_direct_native_anchor
          ELSE jsonb_build_object('redacted',true,'sha256',encode(digest(source.meta_direct_native_anchor::text,'sha256'),'hex')) END,
        meta_direct_anchor_retention_job_id=NULL,
        provider_event_id='redacted:'||source.provider_event_id_sha256,status='REDACTED',safe_error=NULL,
        processed_at=COALESCE(processed_at,now()),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE source.tenant_id=$1 AND EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=source.tenant_id
          AND target.job_id=$2 AND target.target_type='META_DIRECT_IDENTITY_EVENT' AND target.target_id=source.id::text)
          AND NOT ($3::boolean AND app.meta_direct_anchor_needed(source.id,$2::uuid))`,[job.tenantId,job.id,job.jobType==='RETENTION_SWEEP'||(job.jobType==='DELETE'&&job.scopeType==='ZAMMAD_TICKET')])).rowCount??0;
      await client.query(`DELETE FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=$1
        AND EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=alias.tenant_id AND target.job_id=$2
          AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text)`,[job.tenantId,job.id]);
      if((await client.query(`SELECT 1 FROM meta_direct_identity_aliases alias JOIN privacy_job_targets target
        ON target.tenant_id=alias.tenant_id AND target.target_id=alias.id::text AND target.target_type='META_DIRECT_ALIAS'
        WHERE alias.tenant_id=$1 AND target.job_id=$2 LIMIT 1`,[job.tenantId,job.id])).rowCount) {
        throw new PrivacyRepositoryError("PRIVACY_IDENTITY_RETAINED","Direct identity evidence remains retained",false);
      }
      metaDirectAliases=targetCounts.META_DIRECT_ALIAS??0;
      if (normalizedCount) {
        await client.query(`DELETE FROM group_action_executions execution
          USING normalized_messages message,privacy_job_targets target
          WHERE execution.tenant_id=$1 AND message.tenant_id=execution.tenant_id
            AND message.event_inbox_id=execution.event_inbox_id
            AND target.tenant_id=message.tenant_id AND target.job_id=$2
            AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
            AND execution.state IN ('SUCCEEDED','FAILED_TERMINAL')`,[job.tenantId,job.id]);
        await client.query(`UPDATE event_inbox inbox SET payload='{}'::jsonb,
          provider_event_id='redacted:'||inbox.provider_event_id_sha256,
          status='REDACTED',safe_error=NULL,
          processed_at=COALESCE(inbox.processed_at,now()),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE inbox.tenant_id=$1 AND EXISTS (SELECT 1 FROM normalized_messages message JOIN privacy_job_targets target
            ON target.tenant_id=message.tenant_id AND target.job_id=$2 AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
            WHERE message.tenant_id=inbox.tenant_id AND message.event_inbox_id=inbox.id)`,[job.tenantId,job.id]);
        await client.query(`DELETE FROM normalized_messages message WHERE message.tenant_id=$1
          AND EXISTS (SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=message.tenant_id AND target.job_id=$2 AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text)
          AND NOT EXISTS (SELECT 1 FROM message_links link WHERE link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id AND link.external_message_id=message.external_message_id)`,[job.tenantId,job.id]);
      }
      await client.query(
        `UPDATE normalized_messages message
            SET provider_metadata=(message.provider_metadata-'media_object_id')
                  || jsonb_build_object('media_scan_state','EXPIRED')
          WHERE message.tenant_id=$1
            AND message.provider_metadata->>'media_object_id' IN (
              SELECT target_id FROM privacy_job_targets
               WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT' AND state='EXTERNAL_COMPLETE'
            )`,
        [job.tenantId, job.id],
      );
      await client.query(
        `UPDATE bot_media_assets asset
            SET state='PURGED',filename='[removed]',request_sha256=NULL,declared_sha256=NULL,content_sha256=NULL,
                media_object_id=NULL,updated_at=now()
          WHERE asset.tenant_id=$1 AND asset.media_object_id::text IN (
            SELECT target_id FROM privacy_job_targets
             WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT' AND state='EXTERNAL_COMPLETE'
          ) AND asset.state IN ('READY','RETIRED','PURGE_PENDING')`,
        [job.tenantId,job.id],
      );
      await client.query(
        `UPDATE quarantine_records review
            SET media_object_id=NULL,state='DISCARDED',safe_summary='Content removed by privacy lifecycle.',
                safe_metadata='{}'::jsonb,reprocess_event_id=NULL,resolution_code='PRIVACY_DELETED',
                resolved_by=NULL,resolved_at=COALESCE(review.resolved_at,now()),
                version=review.version+1,updated_at=now()
          WHERE review.tenant_id=$1 AND review.media_object_id::text IN (
            SELECT target_id FROM privacy_job_targets
             WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT' AND state='EXTERNAL_COMPLETE'
          )`,
        [job.tenantId,job.id],
      );
      await client.query(
        `DELETE FROM delivery_media descriptor
          WHERE descriptor.tenant_id=$1
            AND (
              descriptor.media_object_id::text IN (
                SELECT target_id FROM privacy_job_targets
                 WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT' AND state='EXTERNAL_COMPLETE'
              )
              OR EXISTS (
                SELECT 1 FROM privacy_job_targets target
                JOIN delivery_outbox delivery
                  ON delivery.tenant_id=target.tenant_id
                 AND delivery.id::text=target.target_id
                 WHERE target.tenant_id=descriptor.tenant_id AND target.job_id=$2
                   AND target.target_type='DELIVERY' AND target.target_id=descriptor.delivery_id::text
                   AND delivery.content_redacted_at IS NOT NULL
              )
            )`,
        [job.tenantId, job.id],
      );
      await client.query(
        `DELETE FROM media_objects media
          WHERE media.tenant_id=$1 AND media.id::text IN (
            SELECT target_id FROM privacy_job_targets
             WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT' AND state='EXTERNAL_COMPLETE'
          )`,
        [job.tenantId, job.id],
      );
      await client.query(
        `DELETE FROM privacy_export_artifacts artifact
          WHERE artifact.tenant_id=$1 AND artifact.id::text IN (
            SELECT target_id FROM privacy_job_targets
             WHERE tenant_id=$1 AND job_id=$2 AND target_type='EXPORT_ARTIFACT' AND state='EXTERNAL_COMPLETE'
          )`,
        [job.tenantId, job.id],
      );
      await client.query(
        `DELETE FROM privacy_object_cleanup cleanup
          WHERE cleanup.tenant_id=$1 AND EXISTS (
            SELECT 1 FROM privacy_job_targets target
             WHERE target.tenant_id=cleanup.tenant_id AND target.job_id=$2
               AND target.target_type='EXPORT_OBJECT' AND target.object_key_snapshot=cleanup.object_key
               AND target.state='EXTERNAL_COMPLETE'
          )`,
        [job.tenantId, job.id],
      );
      let financeSummary={metaCostSourcesPurged:0,metaCostSourcesRetained:0,metaCostRecordsPurged:0,metaCostRecordsRetained:0};
      try{
        const value=(await client.query<{value:typeof financeSummary}>('SELECT app.finalize_meta_cost_source_privacy($1,$2,$3) value',[job.id,leaseId,job.fencingToken])).rows[0]?.value;
        if(!value)throw new Error("Financial privacy finalization returned no result");
        financeSummary=value;
      }catch(error){
        if(error&&typeof error==="object"&&"code" in error&&error.code==="55000")throw new PrivacyRepositoryError("FINANCE_RETENTION_REVIEW_REQUIRED","Financial records require a retention or source review before completion",false);
        throw error;
      }
      await client.query(
        "UPDATE privacy_job_targets SET state='COMPLETE',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE tenant_id=$1 AND job_id=$2 AND target_type NOT IN ('FINANCE_SOURCE_REVIEW','META_COST_RECORD') AND state IN ('PENDING','EXTERNAL_COMPLETE')",
        [job.tenantId, job.id],
      );
      await this.assertLease(client, job, leaseId);
      const summary = {
        ...financeSummary,
        zammadTickets: ticketCount,
        botConversations,
        normalizedMessages: normalizedCount,
        deliveryBodies,
        participantIdentities,
        metaManagedAuthority,
        metaFinancialEffects,
        metaDirectAliases,
        metaDirectIdentityEvents,
        metaRoutingEvents: targetCounts.META_ROUTING_EVENT ?? 0,
        metaRoutingActions: targetCounts.META_ROUTING_ACTION ?? 0,
        metaSignupAttempts,
        groupWorkspaceParticipants,
        mediaObjects: targetCounts.MEDIA_OBJECT ?? 0,
        exportArtifacts: targetCounts.EXPORT_ARTIFACT ?? 0,
        exportObjects: targetCounts.EXPORT_OBJECT ?? 0,
        unmatchedDiagnostics: unmatched,
      };
      const completed=(await client.query<{completed:boolean}>(
          "SELECT app.complete_privacy_job($1,$2,$3,$4::jsonb) AS completed",
          [job.id,leaseId,job.fencingToken,JSON.stringify({...summary,...targetCounts})],
        )).rows[0]?.completed===true;
        if(!completed)throw new Error("Privacy job lease was lost during finalization");
        if(shouldAuditPrivacySuccess(job,{...summary,...targetCounts}))await this.audit(client,job,"privacy.job_succeeded",{...summary,...targetCounts});
      return summary;
    });
  }

  async complete(job: PrivacyJob, leaseId: string, summary: Record<string, unknown>) {
    return this.tenant(job.tenantId, async (client) => {
      const alreadyComplete=(await client.query<{state:string}>(
        "SELECT state FROM privacy_jobs WHERE tenant_id=$1 AND id=$2",
        [job.tenantId,job.id],
      )).rows[0]?.state==="SUCCEEDED";
      if(alreadyComplete)return true;
      const completed = (
        await client.query<{ completed: boolean }>(
          "SELECT app.complete_privacy_job($1,$2,$3,$4::jsonb) AS completed",
          [job.id, leaseId, job.fencingToken, JSON.stringify(summary)],
        )
      ).rows[0]?.completed === true;
      if (completed && shouldAuditPrivacySuccess(job, summary)) await this.audit(client, job, "privacy.job_succeeded", summary);
      return completed;
    });
  }

  async defer(job: PrivacyJob, leaseId: string, nextAttemptAt: string) {
    return this.tenant(job.tenantId, async (client) => (
      await client.query<{ deferred: boolean }>(
        "SELECT app.defer_privacy_job($1,$2,$3,$4) AS deferred",
        [job.id, leaseId, job.fencingToken, nextAttemptAt],
      )
    ).rows[0]?.deferred === true);
  }

  async fail(job: PrivacyJob, leaseId: string, failure: { retryable: boolean; code: string; safeError: string; retryAt?: string; legalHold?: boolean }) {
    return this.tenant(job.tenantId, async (client) => {
      const failed = (
        await client.query<{ failed: boolean }>(
          "SELECT app.fail_privacy_job($1,$2,$3,$4,$5,$6,$7,$8) AS failed",
          [job.id, leaseId, job.fencingToken, failure.retryable, failure.code, failure.safeError, failure.retryAt ?? null, failure.legalHold ?? false],
        )
      ).rows[0]?.failed === true;
      if (failed) await this.audit(client, job, "privacy.job_failed", { code: failure.code, retryable: failure.retryable, legal_hold: failure.legalHold ?? false });
      return failed;
    });
  }

  async ready() {
    return (await this.pool.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok === 1;
  }

  async close() {
    await this.pool.end();
  }

  private async insertTicketTargets(client: PoolClient, job: PrivacyJob) {
    if (job.jobType === "RETENTION_SWEEP") {
      await client.query(
        `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
         SELECT $1::uuid,$2::uuid,'ZAMMAD_TICKET',candidate.zammad_ticket_id,
                encode(digest(candidate.zammad_ticket_id,'sha256'),'hex')
           FROM (
             SELECT DISTINCT correlation.zammad_ticket_id
               FROM case_correlations correlation
               JOIN group_bindings binding
                 ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
               JOIN retention_policies policy ON policy.tenant_id=correlation.tenant_id
              WHERE correlation.tenant_id=$1 AND policy.state='ACTIVE'
                AND (correlation.state='RESOLVED' OR policy.include_open_cases)
                AND correlation.updated_at <= $3::timestamptz-make_interval(days=>LEAST(policy.resolved_case_days,binding.retention_days))
                AND NOT app.has_applicable_privacy_hold('ZAMMAD_TICKET',correlation.zammad_ticket_id)
           ) candidate
         ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
        [job.tenantId, job.id,job.createdAt],
      );
      await client.query(
        `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
         SELECT $1::uuid,$2::uuid,'ZAMMAD_TICKET',candidate.zammad_ticket_id,
                encode(digest(candidate.zammad_ticket_id,'sha256'),'hex')
           FROM (
             SELECT DISTINCT conversation.zammad_ticket_id
               FROM bot_conversations conversation
               JOIN retention_policies policy ON policy.tenant_id=conversation.tenant_id
              WHERE conversation.tenant_id=$1 AND policy.state='ACTIVE'
                AND (conversation.state='RESOLVED' OR policy.include_open_cases)
                AND conversation.last_activity_at <= $3::timestamptz-make_interval(days=>policy.resolved_case_days)
                AND NOT app.has_applicable_privacy_hold('ZAMMAD_TICKET',conversation.zammad_ticket_id)
           ) candidate
         ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
        [job.tenantId, job.id,job.createdAt],
      );
      return;
    }
    const ids = await this.ticketIdsForScope(client, job);
    for (const ticketId of ids) {
      if ((await client.query<{held:boolean}>(
        `SELECT app.has_applicable_privacy_hold('ZAMMAD_TICKET',$2) OR EXISTS (
           SELECT 1 FROM delivery_outbox delivery
           LEFT JOIN group_bindings binding ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
          WHERE delivery.tenant_id=$1 AND (delivery.zammad_ticket_id=$2 OR EXISTS (
            SELECT 1 FROM delivery_ticket_links link
             WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id AND link.zammad_ticket_id=$2
          )) AND ${APPLICABLE_DELIVERY_HOLD_SQL}
        ) AS held`,
        [job.tenantId,ticketId],
      )).rows[0]?.held === true) throw new PrivacyLegalHoldError();
      await this.insertTarget(client, job, "ZAMMAD_TICKET", ticketId);
    }
  }

  private async ticketIdsForScope(client: PoolClient, job: PrivacyJob) {
    if (job.scopeType === "ZAMMAD_TICKET") return [job.scopeValue];
    if (job.scopeType === "ZAMMAD_USER") return (
      await client.query<{ zammad_ticket_id: string }>(
        `SELECT DISTINCT zammad_ticket_id FROM (SELECT link.zammad_ticket_id
           FROM normalized_messages message
           JOIN message_links link
             ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id
            AND link.external_message_id=message.external_message_id
          WHERE message.tenant_id=$1 AND message.provider_metadata->>'zammad_customer_id'=$2
          UNION ALL SELECT conversation.zammad_ticket_id FROM bot_conversations conversation
            WHERE conversation.tenant_id=$1 AND conversation.zammad_customer_id::text=$2) known_tickets ORDER BY zammad_ticket_id`,
        [job.tenantId, job.scopeValue],
      )
    ).rows.map((row) => row.zammad_ticket_id);
    const predicate = job.scopeType === "TENANT"
      ? "true"
      : job.scopeType === "REFERENCE"
        ? "correlation.normalized_reference=$2"
        : `EXISTS (
            SELECT 1 FROM message_links link
            JOIN normalized_messages message
              ON message.tenant_id=link.tenant_id AND message.connection_id=link.connection_id
             AND message.external_message_id=link.external_message_id
           WHERE link.tenant_id=correlation.tenant_id
             AND link.zammad_ticket_id=correlation.zammad_ticket_id
             AND (message.external_participant_id=$2 OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,$2)))
          )`;
    const correlationIds = (
      await client.query<{ zammad_ticket_id: string }>(
        `SELECT DISTINCT correlation.zammad_ticket_id
           FROM case_correlations correlation
          WHERE correlation.tenant_id=$1 AND ${predicate}
          ORDER BY correlation.zammad_ticket_id`,
        job.scopeType === "TENANT" ? [job.tenantId] : [job.tenantId, job.scopeValue],
      )
    ).rows.map((row) => row.zammad_ticket_id);
    const directIds = (
      await client.query<{ zammad_ticket_id: string }>(
        `SELECT DISTINCT conversation.zammad_ticket_id
           FROM bot_conversations conversation
           WHERE conversation.tenant_id=$1 AND conversation.zammad_ticket_id IS NOT NULL AND ${job.scopeType === "TENANT"
            ? "true"
            : job.scopeType === "REFERENCE"
              ? "conversation.normalized_reference=$2"
              : "app.meta_direct_participant_matches(conversation.connection_id,conversation.external_chat_id,$2)"}
          ORDER BY conversation.zammad_ticket_id`,
        job.scopeType === "TENANT" ? [job.tenantId] : [job.tenantId, job.scopeValue],
      )
    ).rows.map((row) => row.zammad_ticket_id);
    const deliveryIds = (job.scopeType === "TENANT" || job.scopeType === "PARTICIPANT") ? (
      await client.query<{ zammad_ticket_id: string }>(
        `SELECT DISTINCT referenced.zammad_ticket_id
           FROM delivery_outbox delivery
           LEFT JOIN group_bindings binding
             ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
           CROSS JOIN LATERAL (
             SELECT delivery.zammad_ticket_id WHERE delivery.zammad_ticket_id IS NOT NULL
             UNION
             SELECT link.zammad_ticket_id FROM delivery_ticket_links link
              WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id
           ) referenced
          WHERE delivery.tenant_id=$1 AND ($2::text IS NULL
            OR delivery.external_chat_id=$2 OR (delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,$2))
            OR $2=ANY(delivery.mentions)
            OR EXISTS (
              SELECT 1 FROM normalized_messages quoted
              JOIN whatsapp_groups message_group
                ON message_group.tenant_id=quoted.tenant_id
               AND message_group.connection_id=quoted.connection_id
               AND message_group.external_group_id=quoted.external_group_id
             WHERE quoted.tenant_id=delivery.tenant_id
               AND quoted.connection_id=delivery.connection_id
               AND quoted.external_message_id=delivery.reply_to_message_id
               AND quoted.external_participant_id=$2
               AND message_group.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
            ))
          ORDER BY referenced.zammad_ticket_id`,
        [job.tenantId,job.scopeType === "PARTICIPANT" ? job.scopeValue : null],
      )
    ).rows.map((row) => row.zammad_ticket_id) : [];
    return [...new Set([...correlationIds, ...directIds, ...deliveryIds])].sort();
  }

  private async insertMetaDirectIdentityTargets(client:PoolClient,job:PrivacyJob){
    await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
      SELECT $1::uuid,$2::uuid,'META_DIRECT_ALIAS',alias.id::text,encode(digest(alias.id::text,'sha256'),'hex')
      FROM meta_direct_identity_aliases alias JOIN participant_identities participant
        ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
      WHERE alias.tenant_id=$1 AND alias.created_at<=(SELECT created_at FROM privacy_jobs WHERE tenant_id=$1 AND id=$2)
        AND (($3='DELETE' AND ($4='TENANT' OR ($4='PARTICIPANT' AND app.meta_direct_participant_matches(alias.connection_id,participant.external_participant_id,$5))
          OR($4='ZAMMAD_USER' AND EXISTS(SELECT 1 FROM event_inbox anchor WHERE anchor.tenant_id=alias.tenant_id AND anchor.connection_id=alias.connection_id
             AND anchor.meta_direct_native_anchor->>'participantId'=participant.id::text AND anchor.meta_direct_native_anchor->>'nativeCustomerId'=$5))))
          OR EXISTS(SELECT 1 FROM normalized_messages message JOIN privacy_job_targets target
            ON target.tenant_id=message.tenant_id AND target.job_id=$2 AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
            WHERE message.tenant_id=alias.tenant_id AND message.connection_id=alias.connection_id AND message.provider_metadata->'direct'='true'::jsonb
              AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,participant.external_participant_id)))
        AND NOT app.has_applicable_privacy_hold('PARTICIPANT',participant.external_participant_id)
        AND NOT EXISTS(SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=alias.tenant_id
          AND conversation.connection_id=alias.connection_id AND conversation.external_chat_id=participant.external_participant_id
          AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=conversation.tenant_id AND target.job_id=$2
            AND target.target_type='ZAMMAD_TICKET' AND target.target_id=conversation.zammad_ticket_id))
        AND NOT EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=alias.tenant_id AND message.connection_id=alias.connection_id
          AND message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,participant.external_participant_id)
          AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=message.tenant_id AND target.job_id=$2
            AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text))
        AND NOT EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=alias.tenant_id AND delivery.connection_id=alias.connection_id
          AND delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,participant.external_participant_id)
          AND delivery.content_redacted_at IS NULL AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target
            WHERE target.tenant_id=delivery.tenant_id AND target.job_id=$2 AND target.target_type='DELIVERY' AND target.target_id=delivery.id::text))
      ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId,job.id,job.jobType,job.scopeType,job.scopeValue]);
    await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
      SELECT $1::uuid,$2::uuid,'META_DIRECT_IDENTITY_EVENT',source.id::text,encode(digest(source.id::text,'sha256'),'hex')
      FROM event_inbox source WHERE source.tenant_id=$1 AND source.received_at<=(SELECT created_at FROM privacy_jobs WHERE tenant_id=$1 AND id=$2)
        AND (($3='DELETE' AND (source.meta_direct_identity_change IS NOT NULL OR source.meta_direct_native_anchor IS NOT NULL) AND ($4='TENANT' OR ($4='PARTICIPANT' AND app.meta_direct_event_matches_scope(source.id,$5))
          OR($4='ZAMMAD_USER' AND (source.meta_direct_native_anchor->>'nativeCustomerId'=$5 OR source.meta_direct_identity_resolution->>'nativeCustomerId'=$5))))
          OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias JOIN privacy_job_targets target
            ON target.tenant_id=alias.tenant_id AND target.job_id=$2 AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text
            WHERE alias.tenant_id=source.tenant_id AND alias.source_event_id=source.id))
        AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases retained WHERE retained.tenant_id=source.tenant_id AND retained.source_event_id=source.id
          AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=retained.tenant_id AND target.job_id=$2
            AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=retained.id::text))
        AND NOT EXISTS(SELECT 1 FROM normalized_messages retained WHERE retained.tenant_id=source.tenant_id AND retained.event_inbox_id=source.id
          AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=retained.tenant_id AND target.job_id=$2
            AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=retained.id::text))
      ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId,job.id,job.jobType,job.scopeType,job.scopeValue]);
  }

  private async insertNormalizedTargets(client: PoolClient, job: PrivacyJob) {
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT DISTINCT $1::uuid,$2::uuid,'NORMALIZED_MESSAGE',message.id::text,
              encode(digest(message.id::text,'sha256'),'hex')
         FROM privacy_job_targets ticket
         JOIN message_links link
           ON link.tenant_id=ticket.tenant_id AND link.zammad_ticket_id=ticket.target_id
         JOIN normalized_messages message
           ON message.tenant_id=link.tenant_id AND message.connection_id=link.connection_id
          AND message.external_message_id=link.external_message_id
        WHERE ticket.tenant_id=$1 AND ticket.job_id=$2 AND ticket.target_type='ZAMMAD_TICKET'
          AND NOT ${APPLICABLE_MESSAGE_HOLD_SQL}
          AND NOT ${NON_TARGET_MESSAGE_REFERENCE_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_groups group_record
            LEFT JOIN group_bindings binding
              ON binding.tenant_id=group_record.tenant_id AND binding.whatsapp_group_id=group_record.id
            JOIN privacy_legal_holds hold
              ON hold.tenant_id=group_record.tenant_id AND hold.state='ACTIVE'
             AND (hold.expires_at IS NULL OR hold.expires_at>now())
             AND (
               (hold.scope_type='GROUP_BINDING' AND lower(hold.scope_value)=binding.id::text)
               OR (hold.scope_type='WHATSAPP_GROUP' AND lower(hold.scope_value)=group_record.id::text)
             )
           WHERE group_record.tenant_id=message.tenant_id
             AND group_record.connection_id=message.connection_id
             AND group_record.external_group_id=message.external_group_id
           )
          AND NOT EXISTS (SELECT 1 FROM quarantine_records review
            WHERE review.tenant_id=message.tenant_id AND review.source_event_inbox_id=message.event_inbox_id
              AND review.state='REPROCESS_QUEUED')
        ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id],
    );
    if(job.jobType!=="RETENTION_SWEEP"){
      if(job.scopeType==="TENANT"||job.scopeType==="PARTICIPANT")await client.query(
        `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
         SELECT $1::uuid,$2::uuid,'NORMALIZED_MESSAGE',message.id::text,
                encode(digest(message.id::text,'sha256'),'hex')
           FROM normalized_messages message
          WHERE message.tenant_id=$1
            AND ($3::text IS NULL OR (message.external_participant_id=$3 OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,$3))))
            AND NOT EXISTS (SELECT 1 FROM quarantine_records review
              WHERE review.tenant_id=message.tenant_id AND review.source_event_inbox_id=message.event_inbox_id
                AND review.state='REPROCESS_QUEUED')
         ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
        [job.tenantId,job.id,job.scopeType==="PARTICIPANT"?job.scopeValue:null],
      );
      return;
    }
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT $1::uuid,$2::uuid,'NORMALIZED_MESSAGE',message.id::text,
              encode(digest(message.id::text,'sha256'),'hex')
         FROM normalized_messages message
         JOIN whatsapp_groups group_record
           ON group_record.tenant_id=message.tenant_id
          AND group_record.connection_id=message.connection_id
          AND group_record.external_group_id=message.external_group_id
         JOIN group_workspace_settings workspace
           ON workspace.tenant_id=group_record.tenant_id
          AND workspace.whatsapp_group_id=group_record.id
        WHERE message.tenant_id=$1 AND message.history_captured_at IS NOT NULL
          AND message.provider_timestamp<=$3::timestamptz-make_interval(days=>workspace.retention_days)
          AND NOT ${APPLICABLE_MESSAGE_HOLD_SQL}
          AND NOT app.has_applicable_privacy_hold('PARTICIPANT',message.external_participant_id)
          AND NOT EXISTS (SELECT 1 FROM quarantine_records review
            WHERE review.tenant_id=message.tenant_id AND review.source_event_inbox_id=message.event_inbox_id
              AND review.state='REPROCESS_QUEUED')
          AND NOT EXISTS (
            SELECT 1 FROM privacy_legal_holds hold
            LEFT JOIN group_bindings binding
              ON binding.tenant_id=group_record.tenant_id
             AND binding.whatsapp_group_id=group_record.id
            WHERE hold.tenant_id=message.tenant_id AND hold.state='ACTIVE'
              AND (hold.expires_at IS NULL OR hold.expires_at>now())
              AND (
                (hold.scope_type='GROUP_BINDING' AND lower(hold.scope_value)=binding.id::text)
                OR (hold.scope_type='WHATSAPP_GROUP' AND lower(hold.scope_value)=group_record.id::text)
              )
           )
        ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId,job.id,job.createdAt],
    );
  }

  private async insertDeliveryTargets(client: PoolClient, job: PrivacyJob) {
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT delivery.tenant_id,$2::uuid,'DELIVERY',delivery.id::text,
              encode(digest(delivery.id::text,'sha256'),'hex')
         FROM delivery_outbox delivery
         LEFT JOIN group_bindings delivery_binding
           ON delivery_binding.tenant_id=delivery.tenant_id
          AND delivery_binding.id=delivery.group_binding_id
        WHERE delivery.tenant_id=$1
          AND delivery.content_redacted_at IS NULL
          AND (
            ($3::text='DELETE' AND $4::text='TENANT')
            OR EXISTS (
              SELECT 1 FROM privacy_job_targets ticket_target
               WHERE ticket_target.tenant_id=delivery.tenant_id
                 AND ticket_target.job_id=$2
                 AND ticket_target.target_type='ZAMMAD_TICKET'
                 AND (ticket_target.target_id=delivery.zammad_ticket_id OR EXISTS (
                   SELECT 1 FROM delivery_ticket_links ticket_link
                    WHERE ticket_link.tenant_id=delivery.tenant_id
                      AND ticket_link.delivery_id=delivery.id
                      AND ticket_link.zammad_ticket_id=ticket_target.target_id
                 ))
            )
            OR ($3::text='DELETE' AND EXISTS (
              SELECT 1
                FROM privacy_job_targets message_target
                JOIN normalized_messages message
                  ON message.tenant_id=message_target.tenant_id
                 AND message.id::text=message_target.target_id
                JOIN whatsapp_groups message_group
                  ON message_group.tenant_id=message.tenant_id
                 AND message_group.connection_id=message.connection_id
                 AND message_group.external_group_id=message.external_group_id
               WHERE message_target.tenant_id=delivery.tenant_id
                 AND message_target.job_id=$2
                 AND message_target.target_type='NORMALIZED_MESSAGE'
                 AND message.connection_id=delivery.connection_id
                 AND message.external_message_id=delivery.reply_to_message_id
                 AND message_group.id=COALESCE(delivery.group_workspace_group_id,delivery_binding.whatsapp_group_id)
            ))
            OR ($3::text='DELETE' AND $4::text='PARTICIPANT' AND (
              delivery.external_chat_id=$5 OR (delivery.direct_origin IS NOT NULL AND app.meta_direct_participant_matches(delivery.connection_id,delivery.external_chat_id,$5)) OR $5=ANY(delivery.mentions)
            ))
            OR ($3::text='RETENTION_SWEEP' AND EXISTS (
              SELECT 1
                FROM group_workspace_settings workspace
                JOIN whatsapp_groups group_record
                  ON group_record.tenant_id=workspace.tenant_id
                 AND group_record.id=workspace.whatsapp_group_id
               WHERE workspace.tenant_id=delivery.tenant_id
                 AND workspace.whatsapp_group_id=COALESCE(delivery.group_workspace_group_id,delivery_binding.whatsapp_group_id)
                 AND group_record.connection_id=delivery.connection_id
                 AND delivery.created_at>=workspace.enabled_at
                  AND delivery.created_at<=$6::timestamptz-make_interval(days=>workspace.retention_days)
            ))
          )
          AND NOT ${APPLICABLE_DELIVERY_HOLD_SQL}
          AND NOT ${NON_TARGET_DELIVERY_REFERENCE_SQL}
        ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId,job.id,job.jobType,job.scopeType,job.scopeValue,job.createdAt],
    );
  }

  private async insertMediaTargets(client: PoolClient, job: PrivacyJob) {
    const tenantDeletion=job.jobType==="DELETE"&&job.scopeType==="TENANT";
    if(tenantDeletion||job.jobType==="RETENTION_SWEEP")await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT $1::uuid,$2::uuid,'MEDIA_OBJECT',media.id::text,encode(digest(media.id::text,'sha256'),'hex')
         FROM media_objects media
        WHERE media.tenant_id=$1 AND media.scan_state='STAGING'
          AND media.created_at<clock_timestamp()-interval '5 minutes'
          AND media.created_at<=$3::timestamptz
       ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId,job.id,job.createdAt],
    );
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT $1::uuid,$2::uuid,'MEDIA_OBJECT',media.id::text,encode(digest(media.id::text,'sha256'),'hex')
         FROM media_objects media
        WHERE media.tenant_id=$1 AND media.scan_state='CLEAN'
          AND (
            EXISTS (
              SELECT 1 FROM normalized_messages message
              JOIN privacy_job_targets target
                ON target.tenant_id=message.tenant_id AND target.job_id=$2
               AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
              WHERE message.tenant_id=media.tenant_id
                AND message.provider_metadata->>'media_object_id'=media.id::text
            )
            OR EXISTS (
              SELECT 1 FROM delivery_media descriptor
              JOIN privacy_job_targets target
                ON target.tenant_id=descriptor.tenant_id AND target.job_id=$2
               AND target.target_type='DELIVERY' AND target.target_id=descriptor.delivery_id::text
              WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
            )
            OR $3::boolean
          )
          AND NOT EXISTS (
            SELECT 1 FROM bot_media_assets asset
             WHERE asset.tenant_id=media.tenant_id AND asset.media_object_id=media.id
               AND NOT $3::boolean
          )
          AND NOT EXISTS (
            SELECT 1 FROM normalized_messages message
             WHERE message.tenant_id=media.tenant_id
               AND message.provider_metadata->>'media_object_id'=media.id::text
               AND ${APPLICABLE_MESSAGE_HOLD_SQL}
          )
          AND NOT EXISTS (
            SELECT 1 FROM normalized_messages message
             WHERE message.tenant_id=media.tenant_id
               AND message.provider_metadata->>'media_object_id'=media.id::text
               AND ${NON_TARGET_MESSAGE_REFERENCE_SQL}
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_media descriptor
            JOIN delivery_outbox delivery
              ON delivery.tenant_id=descriptor.tenant_id AND delivery.id=descriptor.delivery_id
           WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
             AND ${APPLICABLE_DELIVERY_HOLD_SQL}
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_media descriptor
            JOIN delivery_outbox delivery
              ON delivery.tenant_id=descriptor.tenant_id AND delivery.id=descriptor.delivery_id
           WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
             AND ${NON_TARGET_DELIVERY_REFERENCE_SQL}
          )
          AND NOT EXISTS (
            SELECT 1 FROM normalized_messages message
             WHERE message.tenant_id=media.tenant_id
               AND message.provider_metadata->>'media_object_id'=media.id::text
               AND NOT EXISTS (
                 SELECT 1 FROM privacy_job_targets target
                  WHERE target.tenant_id=message.tenant_id AND target.job_id=$2
                    AND target.target_type='NORMALIZED_MESSAGE' AND target.target_id=message.id::text
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_media descriptor
            WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
              AND NOT EXISTS (
                SELECT 1 FROM privacy_job_targets target
                 WHERE target.tenant_id=descriptor.tenant_id AND target.job_id=$2
                   AND target.target_type='DELIVERY' AND target.target_id=descriptor.delivery_id::text
              )
          )
       ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id,tenantDeletion],
    );
    if (job.jobType !== "RETENTION_SWEEP") {await this.fenceBotMediaTargets(client,job);return}

    // Media has its own retention clock.  Existing deduplicated objects use
    // their latest inbound/outbound reference time so a later reuse is not
    // expired based on the first upload's timestamp.  Scoped holds are checked
    // through the same containment function used for explicit deletions.
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT $1::uuid,$2::uuid,'MEDIA_OBJECT',media.id::text,encode(digest(media.id::text,'sha256'),'hex')
         FROM media_objects media
         JOIN retention_policies policy ON policy.tenant_id=media.tenant_id AND policy.state='ACTIVE'
         LEFT JOIN LATERAL (
           SELECT max(reference.created_at) AS latest_at
             FROM (
               SELECT message.created_at
                 FROM normalized_messages message
                WHERE message.tenant_id=media.tenant_id
                  AND message.provider_metadata->>'media_object_id'=media.id::text
               UNION ALL
               SELECT descriptor.created_at
                 FROM delivery_media descriptor
                WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
               UNION ALL
               SELECT asset.created_at
                 FROM bot_media_assets asset
                WHERE asset.tenant_id=media.tenant_id AND asset.media_object_id=media.id
             ) reference
         ) latest_reference ON true
        WHERE media.tenant_id=$1 AND media.scan_state='CLEAN'
          AND (
            media.expires_at<=$3::timestamptz
            OR COALESCE(latest_reference.latest_at,media.created_at)
                 <= $3::timestamptz-make_interval(days=>policy.media_days)
          )
          AND NOT EXISTS (
            SELECT 1 FROM bot_media_assets asset
            JOIN bot_flow_media_asset_pins pin ON pin.tenant_id=asset.tenant_id AND pin.bot_media_asset_id=asset.id
            JOIN bot_flow_versions flow ON flow.tenant_id=pin.tenant_id AND flow.id=pin.bot_flow_version_id
             WHERE asset.tenant_id=media.tenant_id AND asset.media_object_id=media.id
               AND (flow.state='ACTIVE' OR EXISTS (
                 SELECT 1 FROM bot_conversations conversation
                  WHERE conversation.tenant_id=pin.tenant_id
                    AND conversation.flow_version_id=pin.bot_flow_version_id
                    AND conversation.state<>'RESOLVED'
               ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_legal_holds hold
             WHERE hold.tenant_id=media.tenant_id AND hold.state='ACTIVE'
               AND (hold.expires_at IS NULL OR hold.expires_at>now())
               AND hold.scope_type='TENANT'
          )
          AND NOT EXISTS (
            SELECT 1 FROM normalized_messages message
             WHERE message.tenant_id=media.tenant_id
               AND message.provider_metadata->>'media_object_id'=media.id::text
               AND app.has_applicable_privacy_hold('PARTICIPANT',message.external_participant_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM normalized_messages message
             WHERE message.tenant_id=media.tenant_id
               AND message.provider_metadata->>'media_object_id'=media.id::text
               AND ${APPLICABLE_MESSAGE_HOLD_SQL}
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_media descriptor
            JOIN delivery_outbox delivery
              ON delivery.tenant_id=descriptor.tenant_id AND delivery.id=descriptor.delivery_id
             WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
               AND (delivery.state IN ('QUEUED','FAILED_RETRYABLE','CLAIMED','SENDING','BLOCKED','OUTCOME_UNKNOWN')
                 OR ${APPLICABLE_DELIVERY_HOLD_SQL})
          )
          AND NOT EXISTS (
            SELECT 1 FROM normalized_messages message
            JOIN whatsapp_groups group_record
              ON group_record.tenant_id=message.tenant_id
             AND group_record.connection_id=message.connection_id
             AND group_record.external_group_id=message.external_group_id
            LEFT JOIN group_bindings binding
              ON binding.tenant_id=group_record.tenant_id
             AND binding.whatsapp_group_id=group_record.id
            JOIN privacy_legal_holds hold
              ON hold.tenant_id=message.tenant_id AND hold.state='ACTIVE'
             AND (hold.expires_at IS NULL OR hold.expires_at>now())
             AND (
               (hold.scope_type='GROUP_BINDING' AND lower(hold.scope_value)=binding.id::text)
               OR (hold.scope_type='WHATSAPP_GROUP' AND lower(hold.scope_value)=group_record.id::text)
             )
           WHERE message.tenant_id=media.tenant_id
             AND message.provider_metadata->>'media_object_id'=media.id::text
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_media descriptor
            JOIN delivery_outbox delivery
              ON delivery.tenant_id=descriptor.tenant_id AND delivery.id=descriptor.delivery_id
            LEFT JOIN group_bindings binding
              ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
            JOIN privacy_legal_holds hold
              ON hold.tenant_id=delivery.tenant_id AND hold.state='ACTIVE'
             AND (hold.expires_at IS NULL OR hold.expires_at>now())
             AND (
               (hold.scope_type='GROUP_BINDING' AND lower(hold.scope_value)=binding.id::text)
               OR (hold.scope_type='WHATSAPP_GROUP'
                 AND lower(hold.scope_value)=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)::text)
             )
           WHERE descriptor.tenant_id=media.tenant_id AND descriptor.media_object_id=media.id
           )
        ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id,job.createdAt],
    );
    await this.fenceBotMediaTargets(client,job);
  }

  private async fenceBotMediaTargets(client:PoolClient,job:PrivacyJob){
    const tenantDeletion=job.jobType==="DELETE"&&job.scopeType==="TENANT";
    await client.query(`UPDATE bot_media_assets asset SET state='PURGE_PENDING',updated_at=now()
      WHERE asset.tenant_id=$1 AND asset.state IN ('READY','RETIRED') AND asset.media_object_id::text IN (
        SELECT target_id FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT'
      ) AND ($3::boolean OR NOT EXISTS (
        SELECT 1 FROM bot_media_assets protected
         WHERE protected.tenant_id=asset.tenant_id AND protected.media_object_id=asset.media_object_id AND (
           EXISTS (SELECT 1 FROM bot_flow_media_asset_pins pin JOIN bot_flow_versions flow
             ON flow.tenant_id=pin.tenant_id AND flow.id=pin.bot_flow_version_id
             WHERE pin.tenant_id=protected.tenant_id AND pin.bot_media_asset_id=protected.id AND flow.state='ACTIVE')
           OR EXISTS (SELECT 1 FROM bot_flow_media_asset_pins pin JOIN bot_conversations conversation
             ON conversation.tenant_id=pin.tenant_id AND conversation.flow_version_id=pin.bot_flow_version_id
             WHERE pin.tenant_id=protected.tenant_id AND pin.bot_media_asset_id=protected.id AND conversation.state<>'RESOLVED')
         )
      ))`,[job.tenantId,job.id,tenantDeletion]);
    await client.query(`DELETE FROM privacy_job_targets target WHERE target.tenant_id=$1 AND target.job_id=$2
      AND target.target_type='MEDIA_OBJECT' AND EXISTS (SELECT 1 FROM bot_media_assets asset
        WHERE asset.tenant_id=target.tenant_id AND asset.media_object_id::text=target.target_id
          AND asset.state IN ('READY','RETIRED'))`,[job.tenantId,job.id]);
  }

  private async insertExpiredArtifactTargets(client: PoolClient, job: PrivacyJob) {
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT $1::uuid,$2::uuid,'EXPORT_ARTIFACT',artifact.id::text,encode(digest(artifact.id::text,'sha256'),'hex')
         FROM privacy_export_artifacts artifact
        WHERE artifact.tenant_id=$1 AND artifact.expires_at<=$3::timestamptz
       ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id,job.createdAt],
    );
    await this.insertPendingCleanupTargets(client, job);
  }

  private async insertPendingCleanupTargets(client: PoolClient, job: PrivacyJob) {
    await client.query(
      `INSERT INTO privacy_job_targets
         (tenant_id,job_id,target_type,target_id,target_sha256,object_key_snapshot)
       SELECT $1::uuid,$2::uuid,'EXPORT_OBJECT',cleanup.object_key,
              encode(digest(cleanup.object_key,'sha256'),'hex'),cleanup.object_key
         FROM privacy_object_cleanup cleanup
        WHERE cleanup.tenant_id=$1 AND cleanup.state='PENDING'
       ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id],
    );
  }

  private async insertActiveArtifactTargets(client: PoolClient, job: PrivacyJob) {
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       SELECT $1::uuid,$2::uuid,'EXPORT_ARTIFACT',artifact.id::text,
              encode(digest(artifact.id::text,'sha256'),'hex')
         FROM privacy_export_artifacts artifact
        WHERE artifact.tenant_id=$1
       ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id],
    );
  }

  private async snapshotObjectKeys(client: PoolClient, job: PrivacyJob) {
    await client.query(
      `UPDATE privacy_job_targets target
          SET object_key_snapshot=source.object_key,updated_at=now()
         FROM (
           SELECT media.tenant_id,media.id::text AS target_id,'MEDIA_OBJECT'::text AS target_type,media.object_key
             FROM media_objects media
           UNION ALL
           SELECT artifact.tenant_id,artifact.id::text,'EXPORT_ARTIFACT',artifact.object_key
             FROM privacy_export_artifacts artifact
         ) source
        WHERE target.tenant_id=$1 AND target.job_id=$2
          AND target.state='PENDING' AND target.object_key_snapshot IS NULL
          AND target.target_type=source.target_type AND target.target_id=source.target_id
          AND target.tenant_id=source.tenant_id`,
      [job.tenantId, job.id],
    );
  }

  private async freezeDeliveries(client: PoolClient, job: PrivacyJob) {
    if (job.jobType === "EXPORT") return;
    await client.query(
      `WITH cancelled AS (UPDATE delivery_outbox delivery
          SET state='PRIVACY_CANCELLED',manual_retry_allowed=false,blocked_by_delivery_id=NULL,
              lease_id=NULL,lease_expires_at=NULL,
              safe_error='Delivery cancelled by privacy lifecycle.',updated_at=now()
        WHERE delivery.tenant_id=$1
          AND ${TARGETED_DELIVERY_SQL}
          AND (delivery.state IN ('QUEUED','FAILED_RETRYABLE','BLOCKED')
            OR (delivery.state='CLAIMED' AND delivery.lease_expires_at<now())
            OR (delivery.state='FAILED_TERMINAL' AND delivery.manual_retry_allowed))
        RETURNING delivery.tenant_id,delivery.id), released_disclosure AS (
          UPDATE group_disclosure_deliveries disclosure
             SET state='FAILED',updated_at=now()
            FROM cancelled
           WHERE disclosure.tenant_id=cancelled.tenant_id
             AND disclosure.delivery_id=cancelled.id AND disclosure.state='QUEUED'
          RETURNING disclosure.delivery_id)
       UPDATE delivery_attempts attempt
          SET state='PRIVACY_CANCELLED',safe_error='Delivery cancelled by privacy lifecycle.',finished_at=COALESCE(attempt.finished_at,now())
         FROM cancelled
        WHERE attempt.tenant_id=cancelled.tenant_id AND attempt.delivery_id=cancelled.id
          AND attempt.finished_at IS NULL`,
      [job.tenantId,job.id],
    );
    const expiredAmbiguous = await client.query(
      `SELECT 1 FROM delivery_outbox delivery
        WHERE delivery.tenant_id=$1 AND (
            delivery.state IN ('SENDING','OUTCOME_UNKNOWN')
            OR (delivery.state='CLAIMED' AND delivery.lease_expires_at>=now())
          )
          AND ${RELATED_DELIVERY_SQL}
        LIMIT 1`,
      [job.tenantId,job.id],
    );
    if (expiredAmbiguous.rowCount) {
      throw new PrivacyRepositoryError("DELIVERY_OUTCOME_UNRESOLVED", "A related outbound delivery must be resolved before deletion", true);
    }
    await client.query(
      `UPDATE delivery_outbox delivery
          SET manual_retry_allowed=false,
              safe_error=CASE WHEN delivery.state='FAILED_TERMINAL'
                THEN 'Related media expired under the tenant retention policy.'
                ELSE delivery.safe_error END,
              updated_at=now()
         FROM delivery_media descriptor
        WHERE descriptor.tenant_id=delivery.tenant_id AND descriptor.delivery_id=delivery.id
          AND delivery.tenant_id=$1 AND descriptor.media_object_id::text IN (
            SELECT target_id FROM privacy_job_targets
             WHERE tenant_id=$1 AND job_id=$2 AND target_type='MEDIA_OBJECT'
          )`,
      [job.tenantId, job.id],
    );
  }

  private async assertPrivacyWorkDrained(client:PoolClient,job:PrivacyJob){
    if(job.jobType==="EXPORT")return;
    const finance=await client.query(`SELECT 1 FROM public.meta_provider_effect_checkpoints WHERE tenant_id=$1 AND outcome IN('ATTEMPTED','UNKNOWN') LIMIT 1`,[job.tenantId]);
    if(finance.rowCount)throw new PrivacyRepositoryError('META_FINANCIAL_OUTCOME_UNRESOLVED','An original financial outcome must be resolved before privacy processing can continue',true);
    // Cancel only positively unattempted queued dispatch. No provider revoke.
    await client.query(`UPDATE public.connection_operations operation SET state='CANCELLED',completed_at=COALESCE(completed_at,clock_timestamp()),safe_error='Funding operation cancelled by privacy lifecycle.'
      WHERE operation.tenant_id=$1 AND operation.state='QUEUED' AND operation.lease_id IS NULL AND operation.payload ? 'metaManagedFunding'
        AND NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints effect WHERE effect.tenant_id=operation.tenant_id AND effect.original_operation_id=operation.id)`,[job.tenantId]);
    const fundingWork=await client.query(`SELECT 1 FROM public.connection_operations WHERE tenant_id=$1 AND payload ? 'metaManagedFunding' AND state IN('RUNNING','FAILED_RETRYABLE') LIMIT 1`,[job.tenantId]);
    if(fundingWork.rowCount)throw new PrivacyRepositoryError('TENANT_WORK_IN_FLIGHT','An admitted funding operation must finish before privacy processing can continue',true);
    await client.query(`UPDATE direct_customer_close_commands SET state='FAILED_TERMINAL',native_action_snapshot=$1,
      native_result=$2,completed_at=now(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=$3 AND state='QUEUED'
        AND ($4='DELETE' OR EXISTS(SELECT 1 FROM bot_conversations conversation JOIN privacy_job_targets target
          ON target.tenant_id=conversation.tenant_id AND target.target_id=conversation.zammad_ticket_id
          WHERE conversation.tenant_id=direct_customer_close_commands.tenant_id AND conversation.id=direct_customer_close_commands.conversation_id
            AND target.job_id=$5 AND target.target_type='ZAMMAD_TICKET'))`,
      [{cancelled_by_privacy_job:job.id},{state:'NOT_ATTEMPTED',reason:'PRIVACY_CANCELLED'},job.tenantId,job.jobType,job.id]);
    const active=await client.query(`SELECT 1 FROM privacy_jobs privacy
      WHERE privacy.tenant_id=$1 AND privacy.id=$2 AND (
        EXISTS (SELECT 1 FROM event_inbox event
          WHERE event.tenant_id=privacy.tenant_id AND event.received_at<=privacy.created_at
            -- Typed inert imports have no external effects; this privacy transaction
            -- locks/reduces their exact subjects before local completion.
            AND NOT (event.meta_coexistence_admission IS NOT NULL AND event.meta_direct_asset IS NULL
              AND event.event_type IN('meta.coexistence.history','meta.coexistence.history_media','meta.coexistence.contacts','meta.coexistence.echo','meta.coexistence.declined'))
            AND event.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE'))
        OR EXISTS (SELECT 1 FROM direct_native_reply_intents intent WHERE intent.tenant_id=privacy.tenant_id AND intent.state IN ('PENDING','OUTCOME_UNKNOWN'))
        OR EXISTS (SELECT 1 FROM meta_thread_control_actions action WHERE action.tenant_id=privacy.tenant_id AND action.state IN ('RUNNING','OUTCOME_UNKNOWN'))
        OR EXISTS (SELECT 1 FROM direct_customer_close_commands command JOIN bot_conversations conversation
          ON conversation.tenant_id=command.tenant_id AND conversation.id=command.conversation_id
          WHERE command.tenant_id=privacy.tenant_id AND (command.state IN ('ATTEMPTED','OUTCOME_UNKNOWN')
            OR (command.state='SUCCEEDED' AND conversation.state IN ('BOT','HUMAN') AND conversation.fencing_token=command.conversation_fencing_token)))
        OR EXISTS (SELECT 1 FROM bot_action_jobs action
          LEFT JOIN event_inbox source ON source.tenant_id=action.tenant_id AND source.id=action.source_event_id
          WHERE action.tenant_id=privacy.tenant_id AND COALESCE(source.received_at,action.created_at)<=privacy.created_at
            AND action.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN'))
        OR EXISTS (SELECT 1 FROM bot_handoff_jobs handoff
          JOIN event_inbox source ON source.tenant_id=handoff.tenant_id AND source.id=handoff.source_event_id
          WHERE handoff.tenant_id=privacy.tenant_id AND source.received_at<=privacy.created_at
            AND handoff.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE'))
        OR EXISTS (SELECT 1 FROM group_action_executions action
          JOIN event_inbox source ON source.tenant_id=action.tenant_id AND source.id=action.event_inbox_id
          WHERE action.tenant_id=privacy.tenant_id AND source.received_at<=privacy.created_at
             AND action.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN'))
        OR EXISTS (SELECT 1 FROM quarantine_records review
          JOIN event_inbox source ON source.tenant_id=review.tenant_id AND source.id=review.source_event_inbox_id
          WHERE review.tenant_id=privacy.tenant_id AND review.state='REPROCESS_QUEUED'
            AND source.received_at<=privacy.created_at)
        OR EXISTS (SELECT 1 FROM media_objects media
          WHERE media.tenant_id=privacy.tenant_id AND media.scan_state='STAGING'
            AND media.created_at<=privacy.created_at
            AND media.created_at>=clock_timestamp()-interval '5 minutes')
        OR EXISTS (SELECT 1 FROM bot_media_assets asset
          WHERE asset.tenant_id=privacy.tenant_id AND asset.state='UPLOADING'
            AND asset.created_at<=privacy.created_at)
      )`,[job.tenantId,job.id]);
    if(active.rowCount)throw new PrivacyRepositoryError(
      "TENANT_WORK_IN_FLIGHT",
      "Tenant work admitted before privacy processing must finish first",
      true,
    );
  }

  private async expireAbandonedBotUploads(client:PoolClient,job:PrivacyJob){
    if(job.jobType==="EXPORT")return;
    await client.query(`WITH expired AS (
      UPDATE bot_media_assets SET state='FAILED',filename='[removed]',request_sha256=NULL,declared_sha256=NULL,
        safe_error='Media upload expired before completion.',updated_at=now()
       WHERE tenant_id=$1 AND state='UPLOADING' AND upload_expires_at<=$2::timestamptz
       RETURNING id,mime_type,byte_size
    ) INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
      SELECT $1,'SYSTEM','connector-worker','bot_media_asset.upload_expired','bot_media_asset',id,
        jsonb_build_object('state','FAILED','result_code','UPLOAD_EXPIRED','mime_type',mime_type,'byte_size',byte_size),
        'bot-media:'||id::text||':expired' FROM expired`,[job.tenantId,job.createdAt]);
  }

  private async signupPrivacy(client:PoolClient,job:PrivacyJob,leaseId:string,phase:"discover"|"export"|"redact") {
    if(job.scopeType!=="TENANT")return phase==="export"?[]:0;
    const sql = phase==="discover" ? "SELECT app.discover_meta_signup_privacy($1,$2,$3) AS value"
      : phase==="export" ? "SELECT app.export_meta_signup_privacy($1,$2,$3) AS value"
      : "SELECT app.redact_meta_signup_privacy($1,$2,$3) AS value";
    try{return (await client.query<{value:unknown}>(sql,[job.id,leaseId,job.fencingToken])).rows[0]?.value}
    catch(error){
      const message=error instanceof Error?error.message:"";
      if(message==="signup privacy legal hold")throw new PrivacyLegalHoldError();
      if(message==="signup privacy outcome unresolved")throw new PrivacyRepositoryError("META_SIGNUP_OUTCOME_UNRESOLVED","Signup evidence must be resolved before privacy deletion can continue",true);
      if(message==="signup privacy scope too large")throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE","Signup metadata exceeds the bounded privacy scope",false);
      throw error;
    }
  }

  private async insertTarget(client: PoolClient, job: PrivacyJob, type: PrivacyTarget["type"], targetId: string) {
    await client.query(
      `INSERT INTO privacy_job_targets (tenant_id,job_id,target_type,target_id,target_sha256)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,job_id,target_type,target_sha256) DO NOTHING`,
      [job.tenantId, job.id, type, targetId, createHash("sha256").update(targetId).digest("hex")],
    );
  }

  private async hasApplicableHold(client: PoolClient, job: PrivacyJob) {
    return (await client.query<{ held: boolean }>(
      "SELECT app.has_applicable_privacy_hold($1,$2) AS held",
      [job.scopeType, job.scopeValue],
    )).rows[0]?.held === true;
  }

  private async targetCounts(client: PoolClient, job: PrivacyJob) {
    return (
      await client.query<{ target_type: string; count: string | number }>(
        "SELECT target_type,count(*) AS count FROM privacy_job_targets WHERE tenant_id=$1 AND job_id=$2 GROUP BY target_type",
        [job.tenantId, job.id],
      )
    ).rows.reduce<Record<string, number>>((result, row) => {
      result[row.target_type] = Number(row.count);
      return result;
    }, {});
  }

  private async assertLease(client: PoolClient, job: PrivacyJob, leaseId: string) {
    const row = await client.query(
      "SELECT 1 FROM privacy_jobs WHERE tenant_id=$1 AND id=$2 AND state='RUNNING' AND lease_id=$3 AND fencing_token=$4 AND lease_expires_at>=clock_timestamp() FOR UPDATE",
      [job.tenantId, job.id, leaseId, job.fencingToken],
    );
    if (row.rowCount !== 1) throw new Error("Privacy job lease was lost");
  }

  private async audit(client: PoolClient, job: PrivacyJob, action: string, value: Record<string, unknown>) {
    await client.query(
      `INSERT INTO audit_events
         (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
       VALUES ($1,'SYSTEM','privacy-worker',$2,'privacy_job',$3,$4,$5)`,
      [job.tenantId, action, job.id, value, `privacy:${job.id}:${job.fencingToken}`],
    );
  }

  private async tenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>,repeatableRead=false) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if(repeatableRead)await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PrivacyRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "PrivacyRepositoryError";
  }
}

function jobFromRow(row: JobRow): PrivacyJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    jobType: row.job_type,
    scopeType: row.scope_type,
    scopeValue: row.scope_value,
    disposition: row.disposition,
    state: row.state,
    stage: row.stage,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    fencingToken: Number(row.fencing_token),
    createdAt: String(row.created_at),
    zammadBaseUrl: row.zammad_base_url,
    zammadPrivacySecretReference: row.zammad_privacy_secret_reference,
    unmatchedDiagnosticHours: Number(row.unmatched_diagnostic_hours),
    exportTtlHours: Number(row.export_ttl_hours),
  };
}

function scopeParameters(job: PrivacyJob) {
  return job.scopeType === "TENANT" ? [job.tenantId] : [job.tenantId, job.scopeValue];
}

function messageScopeCte(job: PrivacyJob) {
  if (job.scopeType === "TENANT" || job.scopeType === "PARTICIPANT") return "";
  if (job.scopeType === "ZAMMAD_USER") return `WITH scoped_tickets AS (
    SELECT DISTINCT link.zammad_ticket_id
      FROM normalized_messages message
      JOIN message_links link
        ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id
       AND link.external_message_id=message.external_message_id
     WHERE message.tenant_id=$1 AND message.provider_metadata->>'zammad_customer_id'=$2
    UNION SELECT zammad_ticket_id FROM bot_conversations WHERE tenant_id=$1 AND zammad_customer_id::text=$2
  )`;
  return `WITH scoped_tickets AS (
    SELECT DISTINCT correlation.zammad_ticket_id
      FROM case_correlations correlation
     WHERE correlation.tenant_id=$1 AND ${job.scopeType === "ZAMMAD_TICKET" ? "correlation.zammad_ticket_id=$2" : "correlation.normalized_reference=$2"}
    UNION
    SELECT DISTINCT conversation.zammad_ticket_id
      FROM bot_conversations conversation
     WHERE conversation.tenant_id=$1
       AND ${job.scopeType === "ZAMMAD_TICKET" ? "conversation.zammad_ticket_id=$2" : "conversation.normalized_reference=$2"}
  )`;
}

function messageScopePredicate(job: PrivacyJob) {
  if (job.scopeType === "TENANT") return "true";
  if (job.scopeType === "PARTICIPANT") return "(message.external_participant_id=$2 OR (message.provider_metadata->'direct'='true'::jsonb AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,$2)))";
  return `EXISTS (
    SELECT 1 FROM message_links link JOIN scoped_tickets ticket ON ticket.zammad_ticket_id=link.zammad_ticket_id
     WHERE link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id
       AND link.external_message_id=message.external_message_id
  )`;
}
