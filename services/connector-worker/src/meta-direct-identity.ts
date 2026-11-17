import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DirectProviderMessage } from "../../../packages/connectors/src/types.js";
import { assertMetaDirectAccountProof, MetaDirectIdentityError, parseMetaDirectIdentity, parseMetaIdentityChange,metaDirectTransitionEvidence,parseMetaDirectTransitionEvidence,parseMetaDirectTransitionReceipt, type MetaIdentityChange } from "../../../packages/core/src/meta-direct-identity.js";
import { assertMetaCredentialProof, assertMetaLifecycleAccess, metaLifecyclePayloadSha256, parseMetaLifecycleState } from "../../../packages/core/src/meta-account-relation.js";
import type { InboundEvent } from "./types.js";
import { bindMetaPrimaryRouting, assertMetaInboundRouting } from './meta-routing.js';

type Asset = { providerSessionId: string; phoneNumberId: string; wabaId: string | null };
type Source = { asset: Asset; originalAsset: Asset; pinned: boolean; verified: boolean; payloadHash: string };
type Alias = { id: string; participant_identity_id: string; kind: "PHONE" | "BSUID"; value: string; state: string; external_participant_id: string };

function wire(event: InboundEvent) {
  const body=event.payload as {entry?:Array<{changes?:Array<{value?:{messages?:Array<Record<string,unknown>>;contacts?:unknown}}>}>};
  const entries=body.entry, changes=entries?.[0]?.changes, value=changes?.[0]?.value;
  const message=value?.messages?.[0];
  if (!Array.isArray(entries)||entries.length!==1||!Array.isArray(changes)||changes.length!==1
    ||!Array.isArray(value?.messages)||value.messages.length!==1||!message||message.group_id) throw new MetaDirectIdentityError();
  return {message,contacts:value.contacts};
}

async function source(client: PoolClient, event: InboundEvent, leaseId: string, appId: string, negative = false): Promise<Source> {
  const privacy = (await client.query<{ clear: boolean }>(`SELECT
    pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0))
    AND NOT EXISTS (SELECT 1 FROM privacy_jobs WHERE tenant_id=$1::uuid AND job_type='DELETE'
      AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) AS clear`, [event.tenantId])).rows[0];
  if (privacy?.clear !== true) throw new MetaDirectIdentityError();
  const connection = (await client.query<{ state: string; secret_reference: string }>(
    "SELECT state,secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' FOR NO KEY UPDATE", [event.tenantId,event.connectionId])).rows[0];
  const sessions = (await client.query<{ id: string; state: string; opaque_session_id: string; provider_state_data: Record<string,unknown> }>(
    "SELECT id,state,opaque_session_id,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR NO KEY UPDATE", [event.tenantId,event.connectionId])).rows;
  const inbox = (await client.query<{ payload: unknown; payload_sha256: string; meta_direct_asset: Asset | null }>(`SELECT payload,payload_sha256,meta_direct_asset
    FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider='META' AND event_type='messages'
      AND status='PROCESSING' AND lease_id=$4 AND lease_expires_at>clock_timestamp() FOR NO KEY UPDATE`, [event.tenantId,event.connectionId,event.id,leaseId])).rows[0];
  if (!connection || sessions.length !== 1 || !inbox
    || metaLifecyclePayloadSha256(inbox.payload) !== metaLifecyclePayloadSha256(event.payload)) throw new MetaDirectIdentityError();
  const session=sessions[0]!;
  if (!negative && (connection.state !== "WORKING" || session.state !== "WORKING")) throw new MetaDirectIdentityError();
  const data=session.provider_state_data;
  const asset={providerSessionId:session.id,phoneNumberId:session.opaque_session_id,wabaId:typeof data.wabaId === "string" ? data.wabaId : null};
  const pin=inbox.meta_direct_asset;
  if (pin && (pin.providerSessionId !== asset.providerSessionId || pin.phoneNumberId !== asset.phoneNumberId || pin.wabaId !== asset.wabaId)) {
    // Only signed identity-system safety evidence can retain a predecessor pin.
    // Ordinary old messages and explicit queued effects remain non-current.
    if (!negative || !parseMetaIdentityChange(wire(event).message)) throw new MetaDirectIdentityError();
    const lineage=(await client.query<{ valid:boolean }>(
      "SELECT app.meta_account_identity_asset_ancestor($1,$2::jsonb,$3::jsonb) AS valid",
      [event.connectionId,JSON.stringify(pin),JSON.stringify(asset)])).rows[0];
    if(lineage?.valid!==true)throw new MetaDirectIdentityError();
  }
  let verified=false;
  if (!negative) {
    const lifecycle=parseMetaLifecycleState(data.metaLifecycle);assertMetaLifecycleAccess(lifecycle);
    const guard=(await client.query<{ revision_matches:boolean;blocked:boolean;unresolved_hold:boolean }>(
      "SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
      [event.connectionId,asset.providerSessionId,asset.phoneNumberId,asset.wabaId,appId,lifecycle?.revision??0])).rows;
    if (guard.length !== 1 || !guard[0]!.revision_matches || guard[0]!.blocked || guard[0]!.unresolved_hold) throw new MetaDirectIdentityError();
    const proof=data.metaAccountProof as Record<string,unknown>|undefined;
    const metadata=assertMetaCredentialProof(proof,{appId});
    if (metadata) {
      assertMetaDirectAccountProof(proof,{...asset,tenantId:event.tenantId,connectionId:event.connectionId,secretReference:connection.secret_reference,appId});
      verified=true;
    }
  }
  return {asset,originalAsset:pin??asset,pinned:Boolean(pin),verified,payloadHash:inbox.payload_sha256};
}

async function assertClear(client: PoolClient, event: InboundEvent, asset: Asset, participantId?: string) {
  const result=(await client.query<{ clear: boolean }>("SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) AS clear",
    [event.connectionId,asset.providerSessionId,asset.phoneNumberId,asset.wabaId,participantId??null])).rows[0];
  if (result?.clear !== true) throw new MetaDirectIdentityError();
}

/** Canonical identity is resolved once, before customer creation, routing or any native effect. */
export async function resolveMetaDirectMessage(client: PoolClient, event: InboundEvent, leaseId: string, message: DirectProviderMessage, appId: string) {
  const admitted=await source(client,event,leaseId,appId);
  const signed=wire(event), identity=parseMetaDirectIdentity(signed.message,signed.contacts).identity;
  if (!message.metaIdentity || message.provider !== "meta" || message.connectionId !== event.connectionId
    || message.messageId!==signed.message.id || metaLifecyclePayloadSha256(identity)!==metaLifecyclePayloadSha256(message.metaIdentity)) throw new MetaDirectIdentityError();
  const {asset}=admitted;
  if (!admitted.pinned || !admitted.verified || !asset.wabaId) {
    const participant=(await client.query<{id:string}>('SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[event.tenantId,event.connectionId,identity.phone??null])).rows[0];
    await assertClear(client,event,asset,participant?.id);
    // Old numeric-only connections keep their recorded behavior but cannot create verified aliases.
    if (!identity.phone) throw new MetaDirectIdentityError();
    const alreadyBound=await client.query(`SELECT 1 FROM meta_direct_identity_aliases alias JOIN participant_identities participant
      ON participant.tenant_id=alias.tenant_id AND participant.id=alias.participant_identity_id
      WHERE alias.tenant_id=$1 AND alias.connection_id=$2
        AND ((alias.kind='PHONE' AND alias.value=$3) OR participant.external_participant_id=$3) LIMIT 1`,
      [event.tenantId,event.connectionId,identity.phone]);
    if (alreadyBound.rowCount) throw new MetaDirectIdentityError();
    const legacyParticipant=(await client.query<{id:string}>("SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3",[event.tenantId,event.connectionId,identity.phone])).rows[0];
    await bindMetaPrimaryRouting(client,event,asset,legacyParticipant?.id??null,appId);
    return {...message,chatId:identity.phone,senderId:identity.phone,senderPhone:`+${identity.phone}`};
  }
  const aliases=(await client.query<Alias>(`SELECT alias.id,alias.participant_identity_id,alias.kind,alias.value,alias.state,participant.external_participant_id
    FROM meta_direct_identity_aliases alias JOIN participant_identities participant
      ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
    WHERE alias.tenant_id=$1 AND alias.connection_id=$2 AND alias.provider_session_id=$3 AND alias.phone_number_id=$4 AND alias.waba_id=$5
      AND ((alias.kind='PHONE' AND alias.value=$6) OR (alias.kind='BSUID' AND alias.value=$7)) FOR UPDATE OF alias,participant`,
    [event.tenantId,event.connectionId,asset.providerSessionId,asset.phoneNumberId,asset.wabaId,identity.phone??null,identity.bsuid??null])).rows;
  if (aliases.some(alias=>alias.state !== "ACTIVE") || new Set(aliases.map(alias=>alias.participant_identity_id)).size > 1) throw new MetaDirectIdentityError();
  if (identity.phone && identity.bsuid && !identity.jointContact && aliases.length !== 2) throw new MetaDirectIdentityError();
  let participant=aliases[0] ? {id:aliases[0].participant_identity_id,external_participant_id:aliases[0].external_participant_id} : undefined;
  const existingPhone=identity.phone ? (await client.query<{ id:string;external_participant_id:string;foreign_asset:boolean }>(`SELECT participant.id,participant.external_participant_id,
      EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id AND alias.participant_identity_id=participant.id
        AND (alias.provider_session_id<>$4 OR alias.phone_number_id<>$5 OR alias.waba_id<>$6)
        AND NOT(alias.state='RETIRED' AND app.meta_account_identity_asset_ancestor(participant.connection_id,
          jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id),
          jsonb_build_object('providerSessionId',$4::text,'phoneNumberId',$5::text,'wabaId',$6::text)))) AS foreign_asset
    FROM participant_identities participant WHERE participant.tenant_id=$1 AND participant.connection_id=$2 AND participant.external_participant_id=$3 FOR UPDATE`,
    [event.tenantId,event.connectionId,identity.phone,asset.providerSessionId,asset.phoneNumberId,asset.wabaId])).rows[0] : undefined;
  if (participant && existingPhone && !existingPhone.foreign_asset && participant.id !== existingPhone.id) throw new MetaDirectIdentityError();
  if (!participant && existingPhone && !existingPhone.foreign_asset) participant=existingPhone;
  if (!participant) await assertClear(client,event,asset);
  if (!participant) {
    const canonical=identity.phone && !existingPhone ? identity.phone : `meta:${randomUUID()}`;
    participant=(await client.query<{ id:string;external_participant_id:string }>(`INSERT INTO participant_identities
      (tenant_id,connection_id,external_participant_id,normalized_phone) VALUES ($1,$2,$3,$4) RETURNING id,external_participant_id`,
      [event.tenantId,event.connectionId,canonical,identity.phone?`+${identity.phone}`:null])).rows[0];
  }
  if (!participant) throw new MetaDirectIdentityError();
  await assertClear(client,event,asset,participant.id);
  const slots=(await client.query<{kind:"PHONE"|"BSUID";value:string}>(`SELECT kind,value FROM meta_direct_identity_aliases
    WHERE tenant_id=$1 AND connection_id=$2 AND participant_identity_id=$3
      AND provider_session_id=$4 AND phone_number_id=$5 AND waba_id=$6 AND state<>'RETIRED' FOR UPDATE`,
    [event.tenantId,event.connectionId,participant.id,asset.providerSessionId,asset.phoneNumberId,asset.wabaId])).rows;
  if (slots.some(alias => (alias.kind === "PHONE" ? identity.phone : identity.bsuid)
    && alias.value !== (alias.kind === "PHONE" ? identity.phone : identity.bsuid))) throw new MetaDirectIdentityError();
  for (const [kind,value] of [["PHONE",identity.phone],["BSUID",identity.bsuid]] as const) {
    if (!value || aliases.some(alias=>alias.kind === kind && alias.value === value)) continue;
    await client.query(`INSERT INTO meta_direct_identity_aliases
      (tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,state,revision,source_event_id,source_payload_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',1,$9,$10)`,
      [event.tenantId,event.connectionId,participant.id,asset.providerSessionId,asset.phoneNumberId,asset.wabaId,kind,value,event.id,admitted.payloadHash]);
  }
  await assertClear(client,event,asset,participant.id);
  const phone=(await client.query<{ value:string }>(`SELECT value FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2
    AND participant_identity_id=$3 AND provider_session_id=$4 AND phone_number_id=$5 AND waba_id=$6 AND kind='PHONE' AND state='ACTIVE'`,
    [event.tenantId,event.connectionId,participant.id,asset.providerSessionId,asset.phoneNumberId,asset.wabaId])).rows;
  if (phone.length > 1) throw new MetaDirectIdentityError();
  await bindMetaPrimaryRouting(client,event,asset,participant.id,appId);
  return {...message,chatId:participant.external_participant_id,senderId:participant.external_participant_id,senderPhone:phone[0]?`+${phone[0].value}`:undefined};
}

/** New complete signed transitions are metadata-only. Old redacted markers
 * have no successor evidence and remain held; no customer/native/provider work. */
export async function applyMetaIdentityTransition(client:PoolClient,event:InboundEvent,leaseId:string,change:MetaIdentityChange,appId:string){
  const historical=(await client.query<{meta_direct_identity_transition:unknown;meta_direct_identity_resolution:unknown;valid:boolean}>(`SELECT meta_direct_identity_transition,meta_direct_identity_resolution,
    app.meta_direct_transition_receipt_valid(id) AS valid FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider='META'`,[event.tenantId,event.connectionId,event.id])).rows[0];
  if(historical?.valid===true)return{state:'DUPLICATE' as const,receipt:parseMetaDirectTransitionReceipt(historical.meta_direct_identity_resolution)};
  const drain=async(holdOnly:boolean)=>{
    const result=(await client.query<{result:{state:'APPLIED'|'DUPLICATE'|'HELD';receipt?:unknown}}>('SELECT app.drain_meta_direct_transitions($1,$2,$3) AS result',[event.id,leaseId,holdOnly])).rows[0]?.result;
    if(!result)throw new MetaDirectIdentityError();
    return result.receipt?{state:result.state,receipt:parseMetaDirectTransitionReceipt(result.receipt)}:{state:result.state};
  };
  let admitted:Source;
  try{admitted=await source(client,event,leaseId,appId,true);}catch(error){
    // A denied source/privacy/lease read is not authority for the processor's
    // generic failure writer. Leave the original source untouched.
    if(error instanceof MetaDirectIdentityError)return{state:'HELD' as const};
    throw error;
  }
  if(!historical?.meta_direct_identity_transition||!admitted.pinned||!admitted.asset.wabaId){
    const signed=parseMetaIdentityChange(wire(event).message);
    if(!signed||metaLifecyclePayloadSha256(signed)!==metaLifecyclePayloadSha256(change))throw new MetaDirectIdentityError();
    return drain(true);
  }
  const evidence=parseMetaDirectTransitionEvidence(historical.meta_direct_identity_transition),expected=admitted.originalAsset.wabaId?metaDirectTransitionEvidence(event.payload,admitted.payloadHash,{...admitted.originalAsset,wabaId:admitted.originalAsset.wabaId}):undefined;
  if(!expected||metaLifecyclePayloadSha256(expected)!==metaLifecyclePayloadSha256(evidence)||metaLifecyclePayloadSha256(evidence.change)!==metaLifecyclePayloadSha256(change))throw new MetaDirectIdentityError();
  const context=(await client.query<{secret_reference:string;provider_state_data:Record<string,unknown>}>(`SELECT connection.secret_reference,session.provider_state_data FROM connections connection JOIN provider_sessions session
    ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id WHERE connection.tenant_id=$1 AND connection.id=$2 AND session.id=$3 AND session.ownership_state='ACTIVE'`,[event.tenantId,event.connectionId,admitted.asset.providerSessionId])).rows[0];
  let lifecycle:ReturnType<typeof parseMetaLifecycleState>;
  try{
    if(!context)throw new MetaDirectIdentityError();
    assertMetaDirectAccountProof(context.provider_state_data.metaAccountProof,{...admitted.asset,tenantId:event.tenantId,connectionId:event.connectionId,secretReference:context.secret_reference,appId});
    lifecycle=parseMetaLifecycleState(context.provider_state_data.metaLifecycle);assertMetaLifecycleAccess(lifecycle);
  }catch{return drain(true);}
  // Database failures remain observable; only validated negative observations
  // take the conservative path. Do not terminally hold on an SQL/tooling error.
  const life=(await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>('SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)',[event.connectionId,admitted.asset.providerSessionId,admitted.asset.phoneNumberId,admitted.asset.wabaId,appId,lifecycle?.revision??0])).rows;
  if(life.length!==1||!life[0]!.revision_matches||life[0]!.blocked||life[0]!.unresolved_hold)return drain(true);
  return drain(false);
}

export async function assertMetaDirectIdentityCurrent(client: PoolClient, event: InboundEvent, leaseId: string, canonical: string, appId: string) {
  const {asset,verified,pinned}=await source(client,event,leaseId,appId);
  const participant=(await client.query<{ id:string;has_alias:boolean;current_alias:boolean }>(`SELECT participant.id,EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
    WHERE alias.tenant_id=participant.tenant_id AND alias.participant_identity_id=participant.id) AS has_alias
    ,EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=participant.tenant_id AND alias.participant_identity_id=participant.id
      AND alias.provider_session_id=$4 AND alias.phone_number_id=$5 AND alias.waba_id=$6 AND alias.state='ACTIVE') AS current_alias
    FROM participant_identities participant WHERE participant.tenant_id=$1 AND participant.connection_id=$2 AND participant.external_participant_id=$3`,
    [event.tenantId,event.connectionId,canonical,asset.providerSessionId,asset.phoneNumberId,asset.wabaId])).rows[0];
  if (participant?.has_alias && !verified) throw new MetaDirectIdentityError();
  if (verified && pinned) {
    if (!participant?.current_alias) throw new MetaDirectIdentityError();
  } else {
    const signed=wire(event), identity=parseMetaDirectIdentity(signed.message,signed.contacts).identity;
    if (canonical!==identity.phone || participant?.has_alias) throw new MetaDirectIdentityError();
  }
  await assertClear(client,event,asset,participant?.id);
  await assertMetaInboundRouting(client,event,asset,participant?.id??null,appId);
}

/** P03a records an unresolved hold; it never replaces identifiers or runs customer workflows. */
export async function holdMetaIdentityChange(client: PoolClient, event: InboundEvent, leaseId: string, change: MetaIdentityChange, appId: string) {
  const historical=(await client.query<{valid:boolean}>(`SELECT app.meta_direct_transition_receipt_valid(id) AS valid
    FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider='META'`,[event.tenantId,event.connectionId,event.id])).rows[0];
  if(historical?.valid===true)return;
  try{await source(client,event,leaseId,appId,true);}catch(error){
    if(error instanceof MetaDirectIdentityError)return;
    throw error;
  }
  const signed=parseMetaIdentityChange(wire(event).message);
  if (!signed || metaLifecyclePayloadSha256(signed)!==metaLifecyclePayloadSha256(change)) throw new MetaDirectIdentityError();
  const result=(await client.query<{result:{state:string}}>('SELECT app.drain_meta_direct_transitions($1,$2,$3) AS result',[event.id,leaseId,true])).rows[0]?.result;
  if(!result||!['HELD','DUPLICATE'].includes(result.state))throw new MetaDirectIdentityError();
}

/** Reconsider scoped known settlements plus one bounded READY metadata page.
 * Callback-only settlement and step overflow need no new external job.
 * No source replay, UNKNOWN retry or permanent-hold recovery. */
export async function reconsiderMetaIdentityTransitions(client:PoolClient,tenantId:string,scope:{conversationIds:string[];deliveryIds:string[];ticketIds:string[];sourceEventIds?:string[]},appId:string){
  if(scope.conversationIds.length+scope.deliveryIds.length+scope.ticketIds.length>200)throw new MetaDirectIdentityError();
  const candidates=(await client.query<{id:string;connection_id:string;provider_session_id:string;phone_number_id:string;waba_id:string;secret_reference:string;provider_state_data:Record<string,unknown>}>(`SELECT DISTINCT ON(scope_owner.id) source.id,source.connection_id,session.id AS provider_session_id,session.opaque_session_id AS phone_number_id,
    session.provider_state_data->>'wabaId' AS waba_id,connection.secret_reference,session.provider_state_data
    FROM event_inbox source JOIN connections connection ON connection.tenant_id=source.tenant_id AND connection.id=source.connection_id
    JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
    JOIN participant_identities scope_owner ON scope_owner.tenant_id=source.tenant_id AND scope_owner.connection_id=source.connection_id
      AND (EXISTS(SELECT 1 FROM meta_direct_identity_aliases owned WHERE owned.tenant_id=scope_owner.tenant_id
        AND owned.connection_id=scope_owner.connection_id AND owned.participant_identity_id=scope_owner.id AND owned.state IN('ACTIVE','HELD')
        AND owned.provider_session_id=session.id AND owned.phone_number_id=session.opaque_session_id AND owned.waba_id=session.provider_state_data->>'wabaId'
        AND ((owned.kind='PHONE' AND owned.value=source.meta_direct_identity_transition#>>'{change,previous,phone}')
         OR(owned.kind='BSUID' AND owned.value=source.meta_direct_identity_transition#>>'{change,previous,bsuid}')))
       OR(source.meta_direct_identity_transition#>>'{change,previous,phone}'=scope_owner.external_participant_id
         AND source.meta_direct_identity_transition#>>'{change,previous,bsuid}' IS NULL
         AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=scope_owner.tenant_id AND prior.participant_identity_id=scope_owner.id)))
    WHERE source.tenant_id=$1 AND source.status='QUARANTINED' AND source.safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_CURRENT')
      AND source.meta_direct_identity_resolution IS NULL AND source.meta_direct_identity_transition->'schemaVersion'='1'
      AND app.meta_account_identity_asset_ancestor(source.connection_id,source.meta_direct_asset,jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId'))
      AND connection.state='WORKING' AND session.state='WORKING' AND EXISTS(SELECT 1 FROM bot_conversations conversation
        JOIN participant_identities participant ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
        WHERE participant.tenant_id=source.tenant_id AND participant.connection_id=source.connection_id AND participant.id=scope_owner.id
          AND (conversation.id=ANY($2::uuid[]) OR conversation.zammad_ticket_id=ANY($4::text[]) OR EXISTS(SELECT 1 FROM delivery_outbox delivery
            WHERE delivery.tenant_id=conversation.tenant_id AND (delivery.bot_conversation_id=conversation.id OR (delivery.direct_origin IS NOT NULL AND delivery.connection_id=conversation.connection_id AND delivery.external_chat_id=conversation.external_chat_id AND delivery.zammad_ticket_id=conversation.zammad_ticket_id)) AND delivery.id=ANY($3::uuid[]) AND delivery.state IN('SENT','DELIVERED','READ','FAILED_TERMINAL','PRIVACY_CANCELLED'))))
    ORDER BY scope_owner.id,source.processed_at,source.id`,[tenantId,scope.conversationIds,scope.deliveryIds,scope.ticketIds])).rows;
  const supplied=scope.sourceEventIds??[];
  if(supplied.length>32||supplied.some(id=>!(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u).test(id)))throw new MetaDirectIdentityError();
  const ids=[...new Set([...candidates.map(row=>row.id),...supplied])];
  for(const id of ids){
    const candidate=candidates.find(row=>row.id===id)??(await client.query<{id:string;connection_id:string;provider_session_id:string;phone_number_id:string;waba_id:string;secret_reference:string;provider_state_data:Record<string,unknown>}>(`SELECT source.id,source.connection_id,session.id AS provider_session_id,session.opaque_session_id AS phone_number_id,session.provider_state_data->>'wabaId' AS waba_id,connection.secret_reference,session.provider_state_data
      FROM event_inbox source JOIN connections connection ON connection.tenant_id=source.tenant_id AND connection.id=source.connection_id
      JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
      WHERE source.tenant_id=$1 AND source.id=$2 AND source.provider='META' AND source.status='QUARANTINED'
       AND source.meta_direct_identity_resolution IS NULL AND source.safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_CURRENT')
       AND connection.state='WORKING' AND session.state='WORKING'
       AND app.meta_account_identity_asset_ancestor(source.connection_id,source.meta_direct_asset,jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId'))`,[tenantId,id])).rows[0];
    if(!candidate)continue;
    // The same immutable proof is revalidated now, not inherited from the
    // historical send result that made this participant eligible for inspection.
    try{
      assertMetaDirectAccountProof(candidate.provider_state_data.metaAccountProof,{tenantId,connectionId:candidate.connection_id,providerSessionId:candidate.provider_session_id,phoneNumberId:candidate.phone_number_id,wabaId:candidate.waba_id,secretReference:candidate.secret_reference,appId});
      assertMetaLifecycleAccess(parseMetaLifecycleState(candidate.provider_state_data.metaLifecycle));
    }catch{
      // A failed local proof grants no write authority. Keep the original hold;
      // current SQL admission excludes stale proof from READY metadata work.
      continue;
    }
    await client.query('SELECT app.drain_meta_direct_transitions($1,NULL)',[candidate.id]);
  }
}
