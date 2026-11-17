import type { TicketEventTransaction } from "./ticket-event-runtime.js";
import { assertMetaDirectAccountProof, parseMetaDirectIdentity, parseMetaDirectRecipientSnapshot } from "./meta-direct-identity.js";
import { metaTestPhoneAllowed } from "./meta-test-recipient-scope.js";
import type { WahaTestRecipientAllowlist } from "./waha-test-recipient-scope.js";

export type MetaTestRecipientLink = {
  conversationId: string; participantId: string; phone: string; bsuid: string;
  bsuidAliasId: string; bsuidAliasRevision: string; phoneAliasId: string; phoneAliasRevision: string;
  sourceEventId: string; sourcePayloadSha256: string;
  providerSessionId: string; phoneNumberId: string; wabaId: string;
};

type LinkInput = {
  tenantId: string; connectionId: string; deliveryId: string; appId: string; scope: WahaTestRecipientAllowlist;
};

/** One snapshot distinguishes a completed source from a still-leased producer. */
async function readMetaTestRecipientCandidate(client: TicketEventTransaction, input: LinkInput): Promise<{
  link: MetaTestRecipientLink; processed: boolean;
} | undefined> {
  if (input.scope === undefined) return undefined;
  const rows = (await client.query<{
    snapshot: unknown; conversation_id: string; participant_id: string; phone: string; bsuid: string;
    bsuid_alias_id: string; bsuid_revision: string; phone_alias_id: string; phone_revision: string;
    source_id: string; source_hash: string; source_status: "PROCESSED" | "PROCESSING"; payload: { entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: { metadata?: { phone_number_id?: string }; messages?: unknown[]; contacts?: unknown } }> }> };
    session_id: string; phone_id: string; waba_id: string; proof: unknown; secret_reference: string;
  }>(`/* meta_test_conversation_recipient_link */
    SELECT delivery.meta_direct_recipient AS snapshot, conversation.id AS conversation_id, participant.id AS participant_id,
      phone.value AS phone, alias.value AS bsuid, alias.id AS bsuid_alias_id, alias.revision::text AS bsuid_revision,
      phone.id AS phone_alias_id, phone.revision::text AS phone_revision,
      source.id AS source_id, source.payload_sha256 AS source_hash, source.status AS source_status, source.payload,
      session.id AS session_id, session.opaque_session_id AS phone_id, alias.waba_id,
      session.provider_state_data->'metaAccountProof' AS proof, connection.secret_reference
    FROM public.delivery_outbox delivery
    JOIN public.bot_conversations conversation ON conversation.tenant_id=delivery.tenant_id
      AND conversation.id=delivery.bot_conversation_id AND conversation.connection_id=delivery.connection_id
      AND conversation.external_chat_id=delivery.external_chat_id
    JOIN public.connections connection ON connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id
      AND connection.provider='META' AND connection.state<>'REVOKED'
    JOIN public.participant_identities participant ON participant.tenant_id=conversation.tenant_id
      AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
    JOIN public.meta_direct_identity_aliases alias ON alias.tenant_id=participant.tenant_id
      AND alias.connection_id=participant.connection_id AND alias.participant_identity_id=participant.id
      AND alias.kind='BSUID' AND alias.state='ACTIVE'
    JOIN public.meta_direct_identity_aliases phone ON phone.tenant_id=alias.tenant_id AND phone.connection_id=alias.connection_id
      AND phone.participant_identity_id=alias.participant_identity_id AND phone.provider_session_id=alias.provider_session_id
      AND phone.phone_number_id=alias.phone_number_id AND phone.waba_id=alias.waba_id AND phone.kind='PHONE' AND phone.state='ACTIVE'
    JOIN public.provider_sessions session ON session.tenant_id=alias.tenant_id AND session.connection_id=alias.connection_id
      AND session.id=alias.provider_session_id AND session.ownership_state='ACTIVE'
      AND session.opaque_session_id=alias.phone_number_id AND session.provider_state_data->>'wabaId'=alias.waba_id
    JOIN LATERAL (
      SELECT source.id,source.payload_sha256,source.payload,source.status FROM public.bot_conversation_events event
      JOIN public.event_inbox source ON source.tenant_id=event.tenant_id AND source.connection_id=conversation.connection_id
        AND source.id=event.event_inbox_id AND source.provider='META' AND source.event_type='messages'
        AND (source.status='PROCESSED' OR (source.status='PROCESSING' AND source.lease_id IS NOT NULL AND source.lease_expires_at>clock_timestamp()))
        AND source.meta_direct_identity_change IS NULL
        AND source.meta_direct_asset=jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)
      WHERE event.tenant_id=conversation.tenant_id AND event.conversation_id=conversation.id
        AND CASE WHEN source.payload#>>'{entry,0,changes,0,field}'='messages' THEN EXISTS(
          SELECT 1 FROM app.meta_direct_source_identity(source.payload) identity
          WHERE identity.joint_contact AND identity.phone=phone.value AND identity.bsuid=alias.value
        ) ELSE false END
      ORDER BY (source.status='PROCESSED') DESC,source.received_at,source.id LIMIT 1 FOR SHARE OF source
    ) source ON true
    WHERE delivery.tenant_id=$1 AND delivery.connection_id=$2 AND delivery.id=$3
      AND delivery.bot_conversation_id IS NOT NULL AND delivery.content_redacted_at IS NULL
      AND delivery.meta_direct_recipient->>'claim'='ALIAS_VERIFIED'
      AND ((delivery.meta_direct_recipient#>>'{recipient,kind}'='BSUID'
        AND alias.id::text=delivery.meta_direct_recipient->>'aliasId'
        AND alias.revision::text=delivery.meta_direct_recipient->>'aliasRevision'
        AND alias.value=delivery.meta_direct_recipient#>>'{recipient,value}')
        OR (delivery.meta_direct_recipient#>>'{recipient,kind}'='PHONE'
        AND delivery.meta_direct_recipient->'testPhoneSender'='true'::jsonb
        AND phone.id::text=delivery.meta_direct_recipient->>'aliasId'
        AND phone.revision::text=delivery.meta_direct_recipient->>'aliasRevision'
        AND phone.value=delivery.meta_direct_recipient#>>'{recipient,value}'))
      AND app.meta_direct_alias_source_valid(alias.id,conversation.external_chat_id,conversation.zammad_customer_id::text)
      AND app.meta_direct_alias_source_valid(phone.id,conversation.external_chat_id,conversation.zammad_customer_id::text)
      AND app.meta_direct_identity_guard(connection.id,session.id,alias.phone_number_id,alias.waba_id,participant.id)
      AND NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=$1 AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
    FOR SHARE OF delivery,conversation,participant,alias,phone,session`,
    [input.tenantId, input.connectionId, input.deliveryId])).rows;
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  try {
    const snapshot = parseMetaDirectRecipientSnapshot(row.snapshot);
    const phoneSelected = snapshot.recipient.kind === "PHONE";
    if (snapshot.claim !== "ALIAS_VERIFIED"
      || (phoneSelected && snapshot.testPhoneSender !== true)
      || snapshot.recipient.value !== (phoneSelected ? row.phone : row.bsuid)
      || snapshot.aliasId !== (phoneSelected ? row.phone_alias_id : row.bsuid_alias_id)
      || String(snapshot.aliasRevision) !== (phoneSelected ? row.phone_revision : row.bsuid_revision) || snapshot.participantId !== row.participant_id
      || snapshot.asset.providerSessionId !== row.session_id || snapshot.asset.phoneNumberId !== row.phone_id
      || snapshot.asset.wabaId !== row.waba_id || !metaTestPhoneAllowed(input.scope, row.phone)) return undefined;
    assertMetaDirectAccountProof(row.proof, { tenantId: input.tenantId, connectionId: input.connectionId,
      secretReference: row.secret_reference, appId: input.appId, ...snapshot.asset });
    const entries = row.payload.entry, changes = entries?.[0]?.changes, value = changes?.[0]?.value;
    if (entries?.length !== 1 || entries[0]?.id !== row.waba_id || changes?.length !== 1
      || changes[0]?.field !== "messages" || value?.metadata?.phone_number_id !== row.phone_id || value.messages?.length !== 1) return undefined;
    const identity = parseMetaDirectIdentity(value.messages[0], value.contacts).identity;
    if (!identity.jointContact || identity.phone !== row.phone || identity.bsuid !== row.bsuid || identity.parentBsuid) return undefined;
    return { processed: row.source_status === "PROCESSED", link: { conversationId: row.conversation_id, participantId: row.participant_id, phone: row.phone, bsuid: row.bsuid,
      bsuidAliasId: row.bsuid_alias_id, bsuidAliasRevision: row.bsuid_revision,
      phoneAliasId: row.phone_alias_id, phoneAliasRevision: row.phone_revision,
      sourceEventId: row.source_id, sourcePayloadSha256: row.source_hash,
      providerSessionId: row.session_id, phoneNumberId: row.phone_id, wabaId: row.waba_id } };
  } catch { return undefined; }
}

/** Identity evidence only. Send leases/routing and receipt settlement remain caller-owned. */
export async function resolveMetaTestRecipientLink(client: TicketEventTransaction, input: LinkInput): Promise<MetaTestRecipientLink | undefined> {
  const candidate = await readMetaTestRecipientCandidate(client, input);
  return candidate?.processed ? candidate.link : undefined;
}

export async function metaTestRecipientAdmission(client: TicketEventTransaction, input: LinkInput): Promise<
  { state: "READY"; link: MetaTestRecipientLink } | { state: "PENDING" | "DENIED" }
> {
  const candidate = await readMetaTestRecipientCandidate(client, input);
  return candidate ? candidate.processed ? { state: "READY", link: candidate.link } : { state: "PENDING" } : { state: "DENIED" };
}

/** Receipts can settle existing messages; they cannot establish identity or send authority. */
export async function resolveMetaTestStatusRecipientLink(client: TicketEventTransaction, input: {
  tenantId: string; connectionId: string; appId: string; scope: WahaTestRecipientAllowlist; status: Record<string, unknown>;
}): Promise<MetaTestRecipientLink | undefined> {
  const status = input.status;
  if (input.scope === undefined || typeof status.id !== "string" || !/^[A-Za-z0-9._:=+@-]{1,512}$/u.test(status.id) || typeof status.recipient_user_id !== "string"
    || ["group_id", "recipient", "recipient_parent_user_id"].some(key => Object.hasOwn(status, key))) return undefined;
  const deliveries = (await client.query<{ id: string }>(`SELECT id FROM public.delivery_outbox
    WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3 AND bot_conversation_id IS NOT NULL
      AND content_redacted_at IS NULL FOR SHARE`, [input.tenantId, input.connectionId, status.id])).rows;
  if (deliveries.length !== 1) return undefined;
  const link = await resolveMetaTestRecipientLink(client, { ...input, deliveryId: deliveries[0]!.id });
  if (!link || status.recipient_user_id !== link.bsuid
    || (status.recipient_id !== undefined && status.recipient_id !== link.phone && status.recipient_id !== link.bsuid)) return undefined;
  return link;
}
