import type { PoolClient } from "pg";
import { coexistencePhone, coexistenceSubjectDigest, type CoexistenceUnit } from "../../../packages/core/src/meta-coexistence.js";
import { PrivacyLegalHoldError, type PrivacyJob } from "./privacy-repository.js";

type Context = { id: string; app_id: string; phone_id: string; waba_id: string; provider_session_id: string; connection_id: string };
async function contexts(client: PoolClient, job: PrivacyJob) {
  return (await client.query<Context>("SELECT id,app_id,phone_id,waba_id,provider_session_id,connection_id FROM meta_coexistence_contexts WHERE tenant_id=$1 ORDER BY id FOR UPDATE", [job.tenantId])).rows;
}
async function subjects(client: PoolClient, job: PrivacyJob, context: Context) {
  if (!["TENANT", "PARTICIPANT", "ZAMMAD_USER"].includes(job.scopeType)) return [];
  const requested = coexistencePhone(job.scopeValue);
  const candidates = (await client.query<{ phone: string }>(`SELECT DISTINCT phone FROM (
      SELECT subject_phone AS phone FROM meta_coexistence_messages WHERE tenant_id=$1 AND context_id=$2
      UNION SELECT subject_phone FROM meta_coexistence_contacts WHERE tenant_id=$1 AND context_id=$2
      UNION SELECT alias.value FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=$1 AND alias.connection_id=$3 AND alias.kind='PHONE'
      UNION SELECT item->>'subject' FROM event_inbox inbox CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(inbox.payload->'messages','[]')||COALESCE(inbox.payload->'contacts','[]')) item
        WHERE inbox.tenant_id=$1 AND inbox.meta_coexistence_admission->>'contextId'=$2::text
      UNION SELECT $4::text) phones WHERE phone IS NOT NULL`, [job.tenantId, context.id, context.connection_id, requested ?? null])).rows;
  const selected: string[] = [];
  for (const { phone } of candidates) {
    if (!coexistencePhone(phone)) continue;
    const matches = job.scopeType === "TENANT" || (job.scopeType === "PARTICIPANT" && (phone === requested ||
      (await client.query<{ matches: boolean }>("SELECT app.meta_direct_participant_matches($1,$2,$3) AS matches", [context.connection_id, phone, job.scopeValue])).rows[0]?.matches === true))
      // Privacy reads historical native provenance even after ordinary content
      // expires. The shared validator, not capsule JSON, establishes identity;
      // current-effect admission remains separate from export/deletion scope.
      || (job.scopeType === "ZAMMAD_USER" && (await client.query(`SELECT 1 FROM normalized_messages message
        JOIN event_inbox source ON source.tenant_id=message.tenant_id AND source.id=message.event_inbox_id
        WHERE message.tenant_id=$1 AND message.connection_id=$2 AND source.connection_id=$2
          AND source.event_type='messages' AND source.meta_direct_asset=$5::jsonb
          AND message.provider_metadata->>'zammad_customer_id'=$3
          AND app.meta_direct_participant_matches(message.connection_id,message.external_participant_id,$4)
        UNION ALL SELECT 1 FROM participant_identities participant JOIN event_inbox source
          ON source.tenant_id=participant.tenant_id AND source.connection_id=participant.connection_id
        WHERE participant.tenant_id=$1 AND participant.connection_id=$2 AND source.meta_direct_asset=$5::jsonb
          AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL AND source.status IN('PROCESSED','REDACTED')
          AND app.meta_direct_participant_matches(participant.connection_id,participant.external_participant_id,$4)
          AND app.meta_direct_transition_anchor_valid(source.id,participant.id,$3,false) LIMIT 1`,
      [job.tenantId, context.connection_id, job.scopeValue, phone,
        { providerSessionId: context.provider_session_id, phoneNumberId: context.phone_id, wabaId: context.waba_id }])).rowCount === 1);
    if (matches) selected.push(phone);
  }
  return selected;
}
async function target(client: PoolClient, job: PrivacyJob, type: string, id: string) {
  await client.query(`INSERT INTO privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
    VALUES($1,$2,$3,$4,encode(sha256(convert_to($4,'UTF8')),'hex')) ON CONFLICT DO NOTHING`, [job.tenantId, job.id, type, id]);
}
async function expired(client: PoolClient, job: PrivacyJob, item: { subject: string; timestamp: number }) {
  return (await client.query<{ expired: boolean }>(`SELECT to_timestamp($2)<=$3::timestamptz-make_interval(days=>resolved_case_days)
    AND state='ACTIVE' AND NOT app.has_applicable_privacy_hold('PARTICIPANT',$4) AS expired FROM retention_policies WHERE tenant_id=$1`,
  [job.tenantId, item.timestamp, job.createdAt, item.subject])).rows[0]?.expired === true;
}

/** Freeze exact identities before aliases and raw source bodies are removed. */
export async function discoverCoexistencePrivacy(client: PoolClient, job: PrivacyJob) {
  for (const context of await contexts(client, job)) {
    const selected = await subjects(client, job, context);
    if (job.jobType === "DELETE") for (const phone of selected) {
      if ((await client.query<{ held: boolean }>("SELECT app.has_applicable_privacy_hold('PARTICIPANT',$1) AS held", [phone])).rows[0]?.held) {
        throw new PrivacyLegalHoldError();
      }
      await target(client, job, "META_COEXISTENCE_SUBJECT_CUTOFF", coexistenceSubjectDigest(job.tenantId, context.app_id, context.phone_id, phone));
    }
    for (const [table, kind] of [["meta_coexistence_messages", "META_COEXISTENCE_MESSAGE"], ["meta_coexistence_contacts", "META_COEXISTENCE_CONTACT"]] as const) {
      const rows = (await client.query<{ id: string }>(`SELECT row.id FROM ${table} row JOIN retention_policies policy ON policy.tenant_id=row.tenant_id
        WHERE row.tenant_id=$1 AND row.context_id=$2
          AND (($3='DELETE' AND ($6='TENANT' OR row.subject_digest=ANY($4::text[]))) OR ($3='RETENTION_SWEEP' AND policy.state='ACTIVE'
            AND row.provider_timestamp<=$5::timestamptz-make_interval(days=>policy.resolved_case_days)))
          AND CASE WHEN row.subject_phone IS NULL THEN true ELSE NOT app.has_applicable_privacy_hold('PARTICIPANT',row.subject_phone) END FOR UPDATE OF row`,
      [job.tenantId, context.id, job.jobType, selected.map(phone => coexistenceSubjectDigest(job.tenantId, context.app_id, context.phone_id, phone)), job.createdAt, job.scopeType])).rows;
      for (const row of rows) await target(client, job, kind, row.id);
    }
    const events = (await client.query<{ id: string; payload: CoexistenceUnit }>(`SELECT inbox.id,inbox.payload FROM event_inbox inbox
      WHERE inbox.tenant_id=$1 AND inbox.meta_coexistence_admission->>'contextId'=$2
        AND inbox.payload ? 'messages' FOR UPDATE`, [job.tenantId, context.id])).rows;
    const selectedSet = new Set(selected);
    for (const event of events) {
      const items = [...event.payload.messages, ...event.payload.contacts];
      if (job.jobType === "DELETE" && (job.scopeType === "TENANT" || items.some(item => selectedSet.has(item.subject)))) {
        await target(client, job, "META_COEXISTENCE_EVENT", event.id);
      } else if (job.jobType === "RETENTION_SWEEP") {
        for (const item of items) if (await expired(client, job, item)) { await target(client, job, "META_COEXISTENCE_EVENT", event.id); break; }
      }
    }
  }
}

export async function finalizeCoexistencePrivacy(client: PoolClient, job: PrivacyJob) {
  for (const context of await contexts(client, job)) {
    const events = (await client.query<{ id: string; payload: CoexistenceUnit }>(`SELECT inbox.id,inbox.payload FROM event_inbox inbox
      JOIN privacy_job_targets target ON target.tenant_id=inbox.tenant_id AND target.target_id=inbox.id::text
      WHERE inbox.tenant_id=$1 AND target.job_id=$2 AND target.target_type='META_COEXISTENCE_EVENT'
        AND inbox.meta_coexistence_admission->>'contextId'=$3 AND inbox.payload ? 'messages' FOR UPDATE OF inbox`, [job.tenantId, job.id, context.id])).rows;
    const cutoffs = new Set((await client.query<{ target_id: string }>(`SELECT target_id FROM privacy_job_targets
      WHERE tenant_id=$1 AND job_id=$2 AND target_type='META_COEXISTENCE_SUBJECT_CUTOFF'`, [job.tenantId, job.id])).rows.map(row => row.target_id));
    for (const event of events) {
      const messages: typeof event.payload.messages = [], contacts: typeof event.payload.contacts = [];
      for (const item of event.payload.messages) if (job.jobType === "RETENTION_SWEEP" ? !await expired(client, job, item)
        : !cutoffs.has(coexistenceSubjectDigest(job.tenantId, context.app_id, context.phone_id, item.subject))) messages.push(item);
      for (const item of event.payload.contacts) if (job.jobType === "RETENTION_SWEEP" ? !await expired(client, job, item)
        : !cutoffs.has(coexistenceSubjectDigest(job.tenantId, context.app_id, context.phone_id, item.subject))) contacts.push(item);
      await client.query("UPDATE event_inbox SET payload=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [job.tenantId, event.id, job.jobType === "DELETE" && job.scopeType === "TENANT" ? {} : { ...event.payload, messages, contacts }]);
    }
  }
  await client.query(`DELETE FROM meta_coexistence_messages row USING privacy_job_targets target WHERE row.tenant_id=$1
    AND target.tenant_id=row.tenant_id AND target.job_id=$2 AND target.target_type='META_COEXISTENCE_MESSAGE' AND target.target_id=row.id::text`, [job.tenantId, job.id]);
  if (job.jobType === "RETENTION_SWEEP") {
    await client.query(`UPDATE meta_coexistence_contacts row SET display_name=NULL,subject_phone=NULL,redacted_at=clock_timestamp()
      FROM privacy_job_targets target WHERE row.tenant_id=$1 AND target.tenant_id=row.tenant_id AND target.job_id=$2
      AND target.target_type='META_COEXISTENCE_CONTACT' AND target.target_id=row.id::text`, [job.tenantId, job.id]);
  } else {
    await client.query(`DELETE FROM meta_coexistence_contacts row USING privacy_job_targets target WHERE row.tenant_id=$1
      AND target.tenant_id=row.tenant_id AND target.job_id=$2 AND target.target_type='META_COEXISTENCE_CONTACT' AND target.target_id=row.id::text`, [job.tenantId, job.id]);
  }
  if (job.jobType === "DELETE" && job.scopeType === "TENANT") {
    await client.query(`UPDATE meta_coexistence_contexts SET consent_contacts=false,consent_history=false,consent_echoes=false,
      business_phone=NULL,consent_actor=NULL,last_onboarded_time=NULL,hold_reason='STOPPED',revision=revision+1 WHERE tenant_id=$1`, [job.tenantId]);
  }
}

export async function exportCoexistencePrivacy(client: PoolClient, job: PrivacyJob) {
  const messages: Record<string, unknown>[] = [], contacts: Record<string, unknown>[] = [];
  for (const context of await contexts(client, job)) {
    const selected = await subjects(client, job, context);
    messages.push(...(await client.query(`SELECT external_message_id,subject_phone,direction,source,provider_timestamp,message_type,message_text,media_id,quoted_id
      FROM meta_coexistence_messages WHERE tenant_id=$1 AND context_id=$2 AND subject_phone=ANY($3::text[]) ORDER BY provider_timestamp,id LIMIT 5001`,
    [job.tenantId, context.id, selected])).rows);
    contacts.push(...(await client.query(`SELECT subject_phone,display_name,action,provider_timestamp FROM meta_coexistence_contacts
      WHERE tenant_id=$1 AND context_id=$2 AND subject_phone=ANY($3::text[]) ORDER BY provider_timestamp,id LIMIT 5001`, [job.tenantId, context.id, selected])).rows);
    if (messages.length > 5000 || contacts.length > 5000) throw new Error("Business app export exceeds the supported scope");
  }
  return { messages, contacts };
}
