import { ConflictException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { CoexistenceUnit } from "@wasalx/core/meta-coexistence";
import type { WebhookRoute } from "./database.service.js";

export type CoexistenceIngressInput = { unit: CoexistenceUnit; sourceSha256: string; appId: string };
export async function acceptCoexistence(client: PoolClient, route: WebhookRoute, input: CoexistenceIngressInput) {
  const { unit } = input;
  const eventId = `coexistence:${unit.kind}:${unit.key}`;
  if ((await client.query<{ active: boolean }>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0]?.active !== true) unavailable();
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${route.tenant_id}`]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('webhook-admission:'||app.webhook_event_id_sha256($1,$2,'META',$3),0))", [route.tenant_id, route.connection_id, eventId]);
  const duplicate = (await client.query<{ id: string; payload_sha256: string }>(`SELECT id,payload_sha256 FROM event_inbox
    WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'META',$3)`,
  [route.tenant_id, route.connection_id, eventId])).rows[0];
  if (duplicate) {
    if (duplicate.payload_sha256 !== input.sourceSha256) throw new ConflictException("Business app data conflicts with an earlier event");
    return { id: duplicate.id, duplicate: true };
  }
  const context = (await client.query<{ id: string; provider_session_id: string; consent_history: boolean; consent_contacts: boolean; consent_echoes: boolean;
    contacts_state: string; history_state: string }>(`SELECT context.id,context.provider_session_id,context.consent_history,context.consent_contacts,context.consent_echoes,
      context.contacts_request->>'state' AS contacts_state,context.history_request->>'state' AS history_state
    FROM meta_coexistence_contexts context JOIN connections connection ON connection.tenant_id=context.tenant_id AND connection.id=context.connection_id
    JOIN provider_sessions session ON session.tenant_id=context.tenant_id AND session.id=context.provider_session_id
    JOIN webhook_routes route ON route.tenant_id=context.tenant_id AND route.connection_id=context.connection_id AND route.reservation_release_id IS NULL
    WHERE context.tenant_id=$1 AND context.connection_id=$2 AND context.app_id=$3 AND context.waba_id=$4 AND context.phone_id=$5
      AND context.business_phone=$6 AND connection.state='WORKING' AND session.state='WORKING' AND session.ownership_state='ACTIVE'
      AND session.opaque_session_id=context.phone_id AND session.provider_state_data->>'wabaId'=context.waba_id
      AND session.provider_state_data->'metaAccountProof'->>'credentialFingerprint'=context.credential_fingerprint
      AND route.provider='META' AND route.state='ACTIVE' AND route.external_key=context.phone_id AND route.hmac_secret_reference=$7
      AND EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(context.connection_id,session.id,context.phone_id,context.waba_id,context.app_id,
        COALESCE((session.provider_state_data->'metaLifecycle'->>'revision')::integer,0)) WHERE revision_matches AND NOT unresolved_hold)
    FOR SHARE OF context,connection,session,route`,
  [route.tenant_id, route.connection_id, input.appId, unit.wabaId, unit.phoneId, unit.businessPhone, route.hmac_secret_reference])).rows[0];
  if (!context || !context.consent_echoes) unavailable();
  if (unit.kind === "CONTACTS" ? !context.consent_contacts || !["CLAIMED", "ACCEPTED", "UNKNOWN"].includes(context.contacts_state)
    : unit.kind !== "ECHO" && (!context.consent_history || !["CLAIMED", "ACCEPTED", "UNKNOWN"].includes(context.history_state))) unavailable();
  const messages: typeof unit.messages = [], contacts: typeof unit.contacts = [];
  for (const item of unit.messages) if (!await blocked(client, context.id, item.subject, unit.kind, item.timestamp)) messages.push(item);
  for (const item of unit.contacts) if (!await blocked(client, context.id, item.subject, unit.kind, item.timestamp)) contacts.push(item);
  const payload = { ...unit, messages, contacts };
  const inserted = (await client.query<{ id: string }>(`INSERT INTO event_inbox
    (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_coexistence_admission)
    VALUES($1,$2,'META',$3,$4,$5,$6,'ACCEPTED',$7) RETURNING id`,
  [route.tenant_id, route.connection_id, eventId, `meta.coexistence.${unit.kind.toLowerCase()}`, payload, input.sourceSha256,
    { contextId: context.id, providerSessionId: context.provider_session_id, appId: input.appId, sourceSha256: input.sourceSha256 }])).rows[0]!;
  return { id: inserted.id, duplicate: false };
}
async function blocked(client: PoolClient, contextId: string, subject: string, kind: string, timestamp: number) {
  return (await client.query<{ blocked: boolean }>("SELECT app.meta_coexistence_subject_blocked($1,$2,$3,to_timestamp($4)) AS blocked",
    [contextId, subject, kind, timestamp])).rows[0]?.blocked !== false;
}
function unavailable(): never { throw new NotFoundException("Business app capture is not available"); }
