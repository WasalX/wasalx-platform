import type { PoolClient } from "pg";
import { coexistenceHash, coexistenceSubjectDigest, type CoexistenceUnit } from "../../../packages/core/src/meta-coexistence.js";
import type { InboundEvent } from "./types.js";

/** Inert projection only. This module has no provider, bot, delivery or native identity dependencies. */
export async function projectCoexistence(client: PoolClient, event: InboundEvent, leaseId: string, appId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${event.tenantId}`]);
  const inbox = (await client.query<{ payload: CoexistenceUnit; payload_sha256: string; context_id: string; received_at: Date }>(`SELECT inbox.payload,inbox.payload_sha256,
    inbox.meta_coexistence_admission->>'contextId' AS context_id,inbox.received_at
    FROM event_inbox inbox WHERE tenant_id=$1 AND id=$2 AND connection_id=$3 AND provider='META'
      AND event_type=$4 AND status='PROCESSING' AND lease_id=$5 AND lease_expires_at>=clock_timestamp()
      AND meta_coexistence_admission->>'appId'=$6
      AND meta_coexistence_admission->>'sourceSha256'=payload_sha256
      AND meta_coexistence_admission->>'typedSha256'=encode(sha256(convert_to(payload::text,'UTF8')),'hex') FOR UPDATE`,
  [event.tenantId, event.id, event.connectionId, event.eventType, leaseId, appId])).rows[0];
  if (!inbox) throw new Error("Business app inbox lease or admission changed");
  const unit = inbox.payload;
  const context = (await client.query<{ id: string; app_id: string; phone_id: string; consent_history: boolean; consent_contacts: boolean;
    consent_echoes: boolean; history_observation: string; resolved_case_days: number; unmatched_diagnostic_hours: number; retention_state: string }>(`SELECT context.*,
      policy.resolved_case_days,policy.unmatched_diagnostic_hours,policy.state AS retention_state
    FROM meta_coexistence_contexts context JOIN retention_policies policy ON policy.tenant_id=context.tenant_id
    JOIN connections connection ON connection.tenant_id=context.tenant_id AND connection.id=context.connection_id
    JOIN provider_sessions session ON session.tenant_id=context.tenant_id AND session.id=context.provider_session_id
    JOIN webhook_routes route ON route.tenant_id=context.tenant_id AND route.connection_id=context.connection_id AND route.reservation_release_id IS NULL
    WHERE context.tenant_id=$1 AND context.id=$2 AND context.connection_id=$3 AND context.app_id=$4
      AND context.phone_id=$5 AND context.waba_id=$6 AND context.business_phone=$7
      AND connection.state='WORKING' AND session.state='WORKING' AND session.ownership_state='ACTIVE'
      AND session.opaque_session_id=context.phone_id AND session.provider_state_data->>'wabaId'=context.waba_id
      AND session.provider_state_data->'metaAccountProof'->>'credentialFingerprint'=context.credential_fingerprint
      AND route.state='ACTIVE' AND route.external_key=context.phone_id AND context.consent_echoes
      AND EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(context.connection_id,session.id,context.phone_id,context.waba_id,context.app_id,
        COALESCE((session.provider_state_data->'metaLifecycle'->>'revision')::integer,0)) WHERE revision_matches AND NOT unresolved_hold)
    FOR UPDATE OF context`, [event.tenantId, inbox.context_id, event.connectionId, appId, unit.phoneId, unit.wabaId, unit.businessPhone])).rows[0];
  if (!context || (unit.kind === "CONTACTS" ? !context.consent_contacts : unit.kind !== "ECHO" && !context.consent_history)) {
    await finish(client, event, leaseId, "IGNORED", "META_COEXISTENCE_CAPTURE_STOPPED"); return;
  }
  if (unit.schemaVersion !== 1 || event.eventType !== `meta.coexistence.${unit.kind.toLowerCase()}` || !Array.isArray(unit.messages) || !Array.isArray(unit.contacts)) {
    throw new Error("Business app typed admission is invalid");
  }
  await client.query("SAVEPOINT coexistence_projection");
  let pending = false, conflict = false;
  if (context.history_observation === "DECLINED" && ["HISTORY", "HISTORY_MEDIA"].includes(unit.kind)) conflict = true;
  for (const message of unit.messages) {
    if (await blocked(client, context.id, message.subject, unit.kind, message.timestamp)) continue;
    if (context.retention_state === "ACTIVE" && await expired(client, message.subject, message.timestamp, context.resolved_case_days)) continue;
    const subject = coexistenceSubjectDigest(event.tenantId, context.app_id, context.phone_id, message.subject);
    const hash = coexistenceHash(message);
    if ((await client.query(`SELECT 1 FROM normalized_messages live WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3
      AND (live.from_me<>$4 OR NOT app.meta_direct_participant_matches($2,live.external_participant_id,$5)
        OR ($6='text' AND live.message_text IS DISTINCT FROM $7)) LIMIT 1`,
    [event.tenantId, event.connectionId, message.id, message.direction === "OUTBOUND", message.subject, message.type, message.text])).rowCount) {
      conflict = true; continue;
    }
    const existing = (await client.query<{ id: string; subject_digest: string; direction: string; content_sha256: string; message_type: string; media_id: string | null }>(
      `SELECT id,subject_digest,direction,content_sha256,message_type,media_id FROM meta_coexistence_messages
        WHERE tenant_id=$1 AND context_id=$2 AND external_message_id=$3 FOR UPDATE`, [event.tenantId, context.id, message.id])).rows[0];
    if (unit.kind === "HISTORY_MEDIA") {
      if (!existing) { pending = true; continue; }
      if (existing.subject_digest !== subject || (existing.message_type !== "media_placeholder" && existing.media_id !== message.mediaId)) { conflict = true; continue; }
      if (existing.message_type === "media_placeholder") await client.query(`UPDATE meta_coexistence_messages
        SET media_id=$3,message_type=$4,message_text=$5 WHERE tenant_id=$1 AND id=$2`, [event.tenantId, existing.id, message.mediaId, message.type, message.text]);
      continue;
    }
    if (existing) {
      if (existing.subject_digest !== subject || existing.direction !== message.direction || existing.content_sha256 !== hash) conflict = true;
      // Preserve the original provenance; the read model may prefer a matching observed echo.
      else if (unit.kind === "ECHO") await client.query("UPDATE meta_coexistence_messages SET echo_observed=true WHERE tenant_id=$1 AND id=$2", [event.tenantId, existing.id]);
      continue;
    }
    await client.query(`INSERT INTO meta_coexistence_messages(tenant_id,context_id,connection_id,external_message_id,subject_digest,subject_phone,
      direction,source,provider_timestamp,message_type,message_text,media_id,quoted_id,content_sha256,source_event_id,source_sha256,phase,chunk_order)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [event.tenantId, context.id, event.connectionId, message.id, subject, message.subject, message.direction, unit.kind === "ECHO" ? "ECHO" : "HISTORY",
      message.timestamp, message.type, message.text, message.mediaId, message.quotedId, hash, event.id, inbox.payload_sha256, unit.phase, unit.chunkOrder]);
  }
  for (const contact of unit.contacts) {
    if (await blocked(client, context.id, contact.subject, "CONTACTS", contact.timestamp)) continue;
    const subject = coexistenceSubjectDigest(event.tenantId, context.app_id, context.phone_id, contact.subject), hash = coexistenceHash(contact);
    const old = (await client.query<{ provider_timestamp: Date; content_sha256: string; redacted_at: Date | null }>(`SELECT provider_timestamp,content_sha256,redacted_at
      FROM meta_coexistence_contacts WHERE tenant_id=$1 AND context_id=$2 AND subject_digest=$3 FOR UPDATE`, [event.tenantId, context.id, subject])).rows[0];
    if (old && old.provider_timestamp.getTime() >= contact.timestamp * 1000) {
      if (old.provider_timestamp.getTime() === contact.timestamp * 1000 && old.content_sha256 !== hash) conflict = true;
      continue;
    }
    const redact = context.retention_state === "ACTIVE" && await expired(client, contact.subject, contact.timestamp, context.resolved_case_days);
    await client.query(`INSERT INTO meta_coexistence_contacts(tenant_id,context_id,subject_digest,subject_phone,display_name,action,provider_timestamp,content_sha256,source_event_id,redacted_at)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),$8,$9,CASE WHEN $10 THEN clock_timestamp() END)
      ON CONFLICT(tenant_id,context_id,subject_digest) DO UPDATE SET subject_phone=EXCLUDED.subject_phone,display_name=EXCLUDED.display_name,
        action=EXCLUDED.action,provider_timestamp=EXCLUDED.provider_timestamp,content_sha256=EXCLUDED.content_sha256,source_event_id=EXCLUDED.source_event_id,redacted_at=EXCLUDED.redacted_at`,
    [event.tenantId, context.id, subject, redact ? null : contact.subject, redact ? null : contact.name, contact.action, contact.timestamp, hash, event.id, redact]);
  }
  if (pending || conflict) {
    await client.query("ROLLBACK TO SAVEPOINT coexistence_projection");
    const expiredPending = Date.now() - inbox.received_at.getTime() >= context.unmatched_diagnostic_hours * 3_600_000 || event.attempts >= 8;
    if (pending && !conflict && !expiredPending) {
      await client.query(`UPDATE event_inbox SET status='FAILED_RETRYABLE',available_at=clock_timestamp()+interval '5 minutes',
        safe_error='META_COEXISTENCE_MEDIA_PENDING',lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND lease_id=$3`, [event.tenantId, event.id, leaseId]);
      return;
    }
    await client.query(`UPDATE meta_coexistence_contexts SET history_observation='PARTIAL',hold_reason=$3,last_activity_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`, [event.tenantId, context.id, conflict ? "REVIEW_REQUIRED" : "MEDIA_UNAVAILABLE"]);
    await finish(client, event, leaseId, "IGNORED", conflict ? "META_COEXISTENCE_CONFLICT" : "META_COEXISTENCE_MEDIA_UNAVAILABLE"); return;
  }
  await client.query(`UPDATE meta_coexistence_contexts SET history_observation=CASE
      WHEN $3='DECLINED' THEN 'DECLINED' WHEN history_observation IN('DECLINED','PARTIAL') THEN history_observation
      WHEN $4=100 THEN 'PROVIDER_FINISHED' WHEN $3='HISTORY' AND history_observation='WAITING' THEN 'RECEIVING' ELSE history_observation END,
    provider_progress=CASE WHEN $4::integer IS NULL THEN provider_progress ELSE GREATEST(COALESCE(provider_progress,0),$4) END,
    processed_chunks=processed_chunks+CASE WHEN $3='HISTORY' THEN 1 ELSE 0 END,last_activity_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND id=$2`, [event.tenantId, context.id, unit.kind, unit.progress]);
  await finish(client, event, leaseId, "PROCESSED", null);
}
async function blocked(client: PoolClient, contextId: string, subject: string, kind: string, timestamp: number) {
  return (await client.query<{ blocked: boolean }>("SELECT app.meta_coexistence_subject_blocked($1,$2,$3,to_timestamp($4)) AS blocked", [contextId, subject, kind, timestamp])).rows[0]?.blocked !== false;
}
async function expired(client: PoolClient, subject: string, timestamp: number, days: number) {
  return (await client.query<{ expired: boolean }>(`SELECT to_timestamp($1)<clock_timestamp()-make_interval(days=>$2)
    AND NOT app.has_applicable_privacy_hold('PARTICIPANT',$3) AS expired`, [timestamp, days, subject])).rows[0]?.expired === true;
}
async function finish(client: PoolClient, event: InboundEvent, leaseId: string, status: string, reason: string | null) {
  const result = await client.query(`UPDATE event_inbox SET status=$4,payload='{}',provider_event_id='redacted:'||provider_event_id_sha256,
    safe_error=$5,processed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND id=$2 AND lease_id=$3`, [event.tenantId, event.id, leaseId, status, reason]);
  if (result.rowCount !== 1) throw new Error("Business app inbox lease was lost");
}
