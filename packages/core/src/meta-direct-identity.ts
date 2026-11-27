import { assertMetaCredentialProof,assertMetaLifecycleAccess,parseMetaLifecycleState } from "./meta-account-relation.js";
import {createHash} from "node:crypto";
import type {TicketEventTransaction} from "./ticket-event-runtime.js";
import { metaRoutingRuntime } from './meta-routing.js';

/** Retained Meta BSUID contract: updated 2026-09-15, captured 2026-10-07.
 * Identifiers are evidence only: callers must bind their exact sending asset and canonical alias.
 */
export type MetaDirectRecipient = { kind: "PHONE"; value: string } | { kind: "BSUID"; value: string };
export type MetaDirectRecipientSnapshot = {
  schemaVersion: 1;
  recipient: MetaDirectRecipient;
  asset: { providerSessionId: string; phoneNumberId: string; wabaId: string | null };
} & ({ claim: "LEGACY_PHONE_CONTEXT" } | { claim: "ALIAS_VERIFIED"; participantId: string; aliasId: string; aliasRevision: number; testPhoneSender?: true });

export type MetaDirectIdentity = {
  phone?: string;
  bsuid?: string;
  parentBsuid?: string;
  /** Only the unique jointly matching signed contact can authorize alias association. */
  jointContact: boolean;
};

export type MetaIdentityChange = {
  kind: "USER_CHANGED_NUMBER" | "USER_CHANGED_USER_ID";
  previous: { phone?: string; bsuid?: string; parentBsuid?: string };
  current: { phone?: string; bsuid?: string; parentBsuid?: string };
};

export const MAX_META_DIRECT_TRANSITION_STEPS=32;
export type MetaDirectTransitionEvidence={
  schemaVersion:1; change:MetaIdentityChange; providerTimestamp:string;
  messageIdSha256:string; payloadSha256:string;
  asset:{providerSessionId:string;phoneNumberId:string;wabaId:string};
};
export type MetaDirectTransitionReceipt={
  schemaVersion:1;state:"APPLIED"|"DUPLICATE";evidenceSha256:string;
  participantId:string;canonical:string;nativeCustomerId:string;anchorEventId:string;
  predecessorAliases:Array<{id:string;revision:number}>;
  successorAliases:Array<{id:string;revision:number}>;
  appliedEventId:string;
  accountTransitionId?:string;
  targetAsset?:MetaDirectTransitionEvidence["asset"];
};

export class MetaDirectIdentityError extends Error {
  readonly code = "META_DIRECT_IDENTITY_INVALID";
  constructor() { super("The Meta direct identity is invalid or unsupported."); }
}

/** Verified aliases require the current credential and its exact tenant/connection/asset binding. */
export function assertMetaDirectAccountProof(proof: unknown, expected: {
  tenantId:string;connectionId:string;secretReference:string;providerSessionId:string;phoneNumberId:string;wabaId:string|null;appId:string;accessToken?:string;
}) {
  const value=record(proof);
  const metadata=assertMetaCredentialProof(proof,expected);
  if (!metadata || !value || value.schemaVersion!==1 || value.claim!=="PHONE_ACCOUNT_RELATION_VERIFIED" || !expected.wabaId
    || value.tenantId!==expected.tenantId || value.connectionId!==expected.connectionId || value.secretReference!==expected.secretReference
    || value.providerSessionId!==expected.providerSessionId || value.phoneNumberId!==expected.phoneNumberId || value.wabaId!==expected.wabaId) throw new MetaDirectIdentityError();
}

// ISO 3166-1 alpha-2; never infer a phone or business portfolio from this prefix.
const COUNTRIES = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" "));

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function phone(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{2,14}$/u.test(value)) throw new MetaDirectIdentityError();
  return value;
}

function bsuid(value: unknown, parent = false): string {
  if (typeof value !== "string" || !COUNTRIES.has(value.slice(0, 2))
    || !(parent ? /^[A-Z]{2}\.ENT\.[A-Za-z0-9]{1,128}$/u : /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/u).test(value)) {
    throw new MetaDirectIdentityError();
  }
  return value;
}

function optional(value: unknown, parser: (value: unknown) => string): string | undefined {
  return value === undefined ? undefined : parser(value);
}

/** No contact/name/username fallback: an actual message identifier must be present. */
export function parseMetaDirectIdentity(message: unknown, contacts?: unknown): { identity: MetaDirectIdentity; contactIndex?: number } {
  const value = record(message);
  if (!value || value.type === "system") throw new MetaDirectIdentityError();
  const messagePhone = optional(value.from, phone);
  const messageBsuid = optional(value.from_user_id, bsuid);
  const messageParent = optional(value.from_parent_user_id, (id) => bsuid(id, true));
  if (!messagePhone && !messageBsuid) throw new MetaDirectIdentityError();
  if (contacts !== undefined && (!Array.isArray(contacts) || contacts.length > 100)) throw new MetaDirectIdentityError();
  const matches: Array<{ index: number; phone?: string; bsuid?: string; parentBsuid?: string }> = [];
  for (const [index, item] of ((contacts as unknown[] | undefined) ?? []).entries()) {
    const contact = record(item);
    if (!contact) throw new MetaDirectIdentityError();
    const contactPhone = optional(contact.wa_id, phone);
    const contactBsuid = optional(contact.user_id, bsuid);
    const contactParent = optional(contact.parent_user_id, (id) => bsuid(id, true));
    if (!(messagePhone && contactPhone === messagePhone) && !(messageBsuid && contactBsuid === messageBsuid)) continue;
    if ((messagePhone && contactPhone && messagePhone !== contactPhone)
      || (messageBsuid && contactBsuid && messageBsuid !== contactBsuid)
      || (messageParent && contactParent && messageParent !== contactParent)) throw new MetaDirectIdentityError();
    matches.push({ index, phone: contactPhone, bsuid: contactBsuid, parentBsuid: contactParent });
  }
  if (matches.length > 1 || (Array.isArray(contacts) && contacts.length > 0 && matches.length !== 1)) throw new MetaDirectIdentityError();
  const matched = matches[0];
  const senderPhone = messagePhone ?? matched?.phone;
  const senderBsuid = messageBsuid ?? matched?.bsuid;
  const senderParent = messageParent ?? matched?.parentBsuid;
  return {
    identity: {
      ...(senderPhone ? { phone: senderPhone } : {}),
      ...(senderBsuid ? { bsuid: senderBsuid } : {}),
      ...(senderParent ? { parentBsuid: senderParent } : {}),
      jointContact: Boolean(matched?.phone && matched.bsuid),
    },
    ...(matched ? { contactIndex: matched.index } : {}),
  };
}

/** Run before ordinary direct normalization; never parse IDs from system.body. */
export function parseMetaIdentityChange(message: unknown): MetaIdentityChange | undefined {
  const value = record(message);
  if (!value || value.type !== "system") return undefined;
  const system = record(value.system);
  if (!system || (system.type !== "user_changed_number" && system.type !== "user_changed_user_id")) throw new MetaDirectIdentityError();
  const oldPhone = optional(value.from, phone);
  // Validate known supplied message identifiers without guessing their old/new semantics.
  optional(value.from_user_id, bsuid);
  optional(value.from_parent_user_id, (id) => bsuid(id, true));
  const newPhone = optional(system.wa_id, phone);
  const currentBsuid = optional(system.user_id, bsuid);
  const previousBsuid = optional(system.previous_user_id, bsuid);
  if (!newPhone && !currentBsuid) throw new MetaDirectIdentityError();
  if (system.type === "user_changed_user_id" && (!previousBsuid || !currentBsuid)) throw new MetaDirectIdentityError();
  const previousParent = optional(system.previous_parent_user_id, (id) => bsuid(id, true));
  const currentParent = optional(system.parent_user_id, (id) => bsuid(id, true));
  return {
    kind: system.type === "user_changed_number" ? "USER_CHANGED_NUMBER" : "USER_CHANGED_USER_ID",
    previous: { ...(oldPhone ? { phone: oldPhone } : {}), ...(previousBsuid ? { bsuid: previousBsuid } : {}), ...(previousParent ? { parentBsuid: previousParent } : {}) },
    current: { ...(newPhone ? { phone: newPhone } : {}), ...(currentBsuid ? { bsuid: currentBsuid } : {}), ...(currentParent ? { parentBsuid: currentParent } : {}) },
  };
}

/** Signed ingress records a durable hold before a worker can consume or redact the event. */
export function metaDirectIdentityChangeEvidence(payload: unknown, payloadSha256: string) {
  const entries = record(payload)?.entry;
  const changes = Array.isArray(entries) ? record(entries[0])?.changes : undefined;
  const messages = Array.isArray(changes) ? record(record(changes[0])?.value)?.messages : undefined;
  const message = Array.isArray(messages) ? record(messages[0]) : undefined;
  if (!message || message.group_id || message.type !== "system") return null;
  if (!/^[a-f0-9]{64}$/u.test(payloadSha256)) throw new MetaDirectIdentityError();
  let previous: MetaDirectRecipient[] = [];
  try {
    const identity = parseMetaIdentityChange(message)?.previous;
    if (identity?.phone) previous.push({ kind: "PHONE", value: identity.phone });
    if (identity?.bsuid) previous.push({ kind: "BSUID", value: identity.bsuid });
  } catch (error) {
    if (!(error instanceof MetaDirectIdentityError)) throw error;
    previous = [];
  }
  return { schemaVersion: 1, scope: previous.length ? "ALIASES" : "ASSET", previous, payloadSha256 };
}

/** Complete signed source evidence is persisted at ingress, before raw redaction.
 * Invalid/unsupported system units retain the existing hold marker but no apply grant. */
export function metaDirectTransitionEvidence(payload:unknown,payloadSha256:string,asset:unknown):MetaDirectTransitionEvidence|null {
  const entries=record(payload)?.entry;
  if(!Array.isArray(entries)||entries.length!==1)return null;
  const changes=record(entries[0])?.changes;
  if(!Array.isArray(changes)||changes.length!==1)return null;
  const unit=record(changes[0]),value=record(unit?.value),messages=value?.messages;
  if(unit?.field!=="messages"||!Array.isArray(messages)||messages.length!==1)return null;
  const message=record(messages[0]);
  if(!message||Object.hasOwn(message,"group_id")||message.type!=="system")return null;
  try{
    const change=parseMetaIdentityChange(message),pin=record(asset);
    if(!change||!pin||record(entries[0])?.id!==pin.wabaId||record(value?.metadata)?.phone_number_id!==pin.phoneNumberId
      ||typeof message.id!=="string"||message.id.length<1||message.id.length>512||/[\p{Cc}\p{Cf}\s]/u.test(message.id)
      ||typeof message.timestamp!=="string"||!/^\d{1,13}$/u.test(message.timestamp))return null;
    const seconds=Number(message.timestamp);if(!Number.isSafeInteger(seconds)||seconds<=0||seconds>253402300799)return null;
    return parseMetaDirectTransitionEvidence({schemaVersion:1,change,providerTimestamp:new Date(seconds*1000).toISOString(),
      messageIdSha256:createHash("sha256").update(message.id).digest("hex"),payloadSha256,asset:pin});
  }catch{return null;}
}

export function parseMetaDirectTransitionEvidence(input:unknown):MetaDirectTransitionEvidence {
  const value=record(input),change=record(value?.change),previous=record(change?.previous),current=record(change?.current),asset=record(value?.asset);
  const uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
  const graph=(v:unknown)=>typeof v==="string"&&/^[0-9]{1,32}$/u.test(v);
  const hash=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{64}$/u.test(v);
  if(!value||value.schemaVersion!==1||!change||!previous||!current||!asset
    ||Object.keys(value).sort().join(',')!=="asset,change,messageIdSha256,payloadSha256,providerTimestamp,schemaVersion"
    ||Object.keys(change).sort().join(',')!=="current,kind,previous"
    ||Object.keys(previous).some(k=>!["phone","bsuid","parentBsuid"].includes(k))
    ||Object.keys(current).some(k=>!["phone","bsuid","parentBsuid"].includes(k))
    ||Object.keys(asset).sort().join(',')!=="phoneNumberId,providerSessionId,wabaId"
    ||!uuid(asset.providerSessionId)||!graph(asset.phoneNumberId)||!graph(asset.wabaId)
    ||!hash(value.payloadSha256)||!hash(value.messageIdSha256)||typeof value.providerTimestamp!=="string"
    ||!Number.isFinite(Date.parse(value.providerTimestamp))||new Date(value.providerTimestamp).toISOString()!==value.providerTimestamp)throw new MetaDirectIdentityError();
  const normalized=parseMetaIdentityChange({type:"system",...(previous.phone===undefined?{}:{from:previous.phone}),system:{
    type:change.kind==="USER_CHANGED_NUMBER"?"user_changed_number":change.kind==="USER_CHANGED_USER_ID"?"user_changed_user_id":"unsupported",
    ...(previous.bsuid===undefined?{}:{previous_user_id:previous.bsuid}),...(previous.parentBsuid===undefined?{}:{previous_parent_user_id:previous.parentBsuid}),
    ...(current.phone===undefined?{}:{wa_id:current.phone}),...(current.bsuid===undefined?{}:{user_id:current.bsuid}),...(current.parentBsuid===undefined?{}:{parent_user_id:current.parentBsuid})}});
  if(!normalized)throw new MetaDirectIdentityError();
  return{schemaVersion:1,change:normalized,providerTimestamp:value.providerTimestamp,messageIdSha256:value.messageIdSha256 as string,
    payloadSha256:value.payloadSha256 as string,asset:asset as MetaDirectTransitionEvidence["asset"]};
}

/** Semantic duplicates do not share source identity. Each event seals its own evidence hash. */
export function metaDirectTransitionEdgeKey(evidence:MetaDirectTransitionEvidence):string {
  const value=parseMetaDirectTransitionEvidence(evidence),{previous,current,kind}=value.change;
  return createHash("sha256").update(JSON.stringify([value.asset.providerSessionId,value.asset.phoneNumberId,value.asset.wabaId,kind,
    previous.phone??null,previous.bsuid??null,current.phone??null,current.bsuid??null])).digest("hex");
}

export function parseMetaDirectTransitionReceipt(input:unknown):MetaDirectTransitionReceipt {
  const value=record(input),uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
  if(!value||value.schemaVersion!==1||!["APPLIED","DUPLICATE"].includes(String(value.state))||!uuid(value.participantId)||!uuid(value.anchorEventId)||!uuid(value.appliedEventId)
    ||typeof value.evidenceSha256!=="string"||!/^[a-f0-9]{64}$/u.test(value.evidenceSha256)||typeof value.canonical!=="string"||!value.canonical||value.canonical.length>512||/[\p{Cc}\p{Cf}\s]/u.test(value.canonical)
    ||typeof value.nativeCustomerId!=="string"||!/^[1-9][0-9]{0,15}$/u.test(value.nativeCustomerId)
    ||Object.keys(value).some(key=>!["schemaVersion","state","evidenceSha256","participantId","canonical","nativeCustomerId","anchorEventId","predecessorAliases","successorAliases","appliedEventId","accountTransitionId","targetAsset"].includes(key)))throw new MetaDirectIdentityError();
  const bridged=Object.hasOwn(value,"accountTransitionId")||Object.hasOwn(value,"targetAsset");
  if(bridged){
    const asset=record(value.targetAsset);
    if(!uuid(value.accountTransitionId)||!asset||!uuid(asset.providerSessionId)
      ||typeof asset.phoneNumberId!=="string"||!/^[0-9]{1,32}$/u.test(asset.phoneNumberId)
      ||typeof asset.wabaId!=="string"||!/^[0-9]{1,32}$/u.test(asset.wabaId)
      ||Object.keys(asset).sort().join(',')!=="phoneNumberId,providerSessionId,wabaId")throw new MetaDirectIdentityError();
  }
  for(const [name,minimum] of [["predecessorAliases",0],["successorAliases",1]] as const){
    const aliases=value[name];if(!Array.isArray(aliases)||aliases.length<minimum||aliases.length>2)throw new MetaDirectIdentityError();
    if(new Set(aliases.map(slot=>record(slot)?.id)).size!==aliases.length)throw new MetaDirectIdentityError();
    for(const slot of aliases){const row=record(slot);if(!row||!uuid(row.id)||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||Object.keys(row).sort().join(',')!=="id,revision")throw new MetaDirectIdentityError();}
  }
  return value as MetaDirectTransitionReceipt;
}

/** This is a transport projection, not permission or a mutable recipient resolver. */
export function metaDirectRecipientFields(recipient: unknown): { to: string } | { recipient: string } {
  const value = record(recipient);
  if (!value || Object.keys(value).some((key) => key !== "kind" && key !== "value")) throw new MetaDirectIdentityError();
  if (value.kind === "PHONE") return { to: phone(value.value) };
  if (value.kind === "BSUID") return { recipient: bsuid(value.value) };
  throw new MetaDirectIdentityError();
}

export function parseMetaDirectRecipientSnapshot(snapshot: unknown): MetaDirectRecipientSnapshot {
  const value=record(snapshot), asset=record(value?.asset), recipient=record(value?.recipient);
  const uuid=(id:unknown)=>typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id);
  const graphId=(id:unknown)=>typeof id==="string"&&/^[0-9]{1,32}$/u.test(id);
  if (!value || value.schemaVersion!==1 || !asset || !recipient
    || !uuid(asset.providerSessionId) || !graphId(asset.phoneNumberId) || (asset.wabaId!==null&&!graphId(asset.wabaId))
    || Object.keys(asset).some(key=>!["providerSessionId","phoneNumberId","wabaId"].includes(key))) throw new MetaDirectIdentityError();
  metaDirectRecipientFields(recipient);
  const common=["schemaVersion","claim","recipient","asset"];
  if (value.claim==="ALIAS_VERIFIED") {
    if (!graphId(asset.wabaId) || !uuid(value.participantId) || !uuid(value.aliasId)
      || !Number.isSafeInteger(value.aliasRevision) || Number(value.aliasRevision)<1
      || Object.keys(value).some(key=>![...common,"participantId","aliasId","aliasRevision","testPhoneSender"].includes(key))
      || (Object.hasOwn(value,"testPhoneSender") && (value.testPhoneSender!==true || recipient.kind!=="PHONE"))) throw new MetaDirectIdentityError();
  } else if (value.claim!=="LEGACY_PHONE_CONTEXT" || recipient.kind!=="PHONE" || Object.keys(value).some(key=>!common.includes(key))) {
    throw new MetaDirectIdentityError();
  }
  return value as MetaDirectRecipientSnapshot;
}

/** Receipt identity is dedupe evidence only; never establishes or updates an alias. */
export function metaReceiptIdentityParts(status: unknown): string[] {
  const value = record(status);
  if (!value) throw new MetaDirectIdentityError();
  const rawId = value.recipient_id;
  if (rawId !== undefined && (typeof rawId !== "string" || !/^[A-Za-z0-9._:=+@-]{1,512}$/u.test(rawId))) throw new MetaDirectIdentityError();
  const userId = optional(value.recipient_user_id, bsuid);
  const parentId = optional(value.recipient_parent_user_id, (id) => bsuid(id, true));
  return [typeof rawId === "string" ? rawId : "", ...(userId ? ["BSUID", userId] : []), ...(parentId ? ["PARENT_BSUID", parentId] : [])];
}


export type MetaDirectEffectCurrentInput = {
  tenantId: string; conversationId: string; connectionId?: string; ticketId?: string;
  sourceEventIds?: readonly string[]; appId: string; nonwaiting?: boolean;
  /** Server-created immutable reservation only; no raw ownership bypass flag. */
  routingActionId?: string;
  /** Native precommit reservation whose original external epoch cannot be repinned. */
  routingNativeIntentId?: string;
  /** Only for a ticket template selection. Routing ownership still applies. */
  ticketTemplate?: true;
};
export class MetaDirectEffectNotAttempted extends Error {
  readonly code = "META_DIRECT_EFFECT_NOT_ATTEMPTED";
  readonly outcomeKnown = true;
  constructor(readonly reason:"HELD"|"BUSY"="HELD") { super("Meta direct identity is held or no longer current; no external request was dispatched."); }
}

/** Caller owns the transaction and proves its exact job/intent lease and fence.
 * This checks effect authority only; never apply it to historical receipt reads. */
export async function assertMetaDirectEffectCurrent(client: TicketEventTransaction, input: MetaDirectEffectCurrentInput): Promise<void> {
  const suffix = input.nonwaiting === false ? "" : " NOWAIT";
  try {
    // Discover the trusted connection before locking it. Re-read the conversation below.
    const preliminary=(await client.query<{connection_id:string;provider:string}>(`SELECT conversation.connection_id,connection.provider
      FROM bot_conversations conversation JOIN connections connection
        ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
      WHERE conversation.tenant_id=$1 AND conversation.id=$2`,[input.tenantId,input.conversationId])).rows;
    if(preliminary.length!==1)throw new MetaDirectEffectNotAttempted();
    if(preliminary[0]!.provider!=="META")return; // Existing WAHA path remains caller-owned.
    if(input.connectionId!==undefined&&input.connectionId!==preliminary[0]!.connection_id)throw new MetaDirectEffectNotAttempted();
    const privacy=(await client.query<{acquired:boolean;clear:boolean}>(`SELECT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0)) AS acquired,
      NOT EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=$1::uuid AND job_type='DELETE'
        AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) AS clear`,[input.tenantId])).rows[0];
    if(privacy?.acquired!==true)throw new MetaDirectEffectNotAttempted("BUSY");
    if(privacy?.clear!==true)throw new MetaDirectEffectNotAttempted();
    const connection=(await client.query<{id:string;state:string;secret_reference:string}>(`SELECT id,state,secret_reference FROM connections
      WHERE tenant_id=$1 AND id=$2 AND provider='META' FOR NO KEY UPDATE${suffix}`,[input.tenantId,preliminary[0]!.connection_id])).rows[0];
    if(!connection||connection.state!=="WORKING")throw new MetaDirectEffectNotAttempted();
    const pending=await client.query(`SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2
      AND operation_type IN ('PAUSE','DISCONNECT') AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1`,[input.tenantId,connection.id]);
    if(pending.rowCount)throw new MetaDirectEffectNotAttempted();
    const sessions=(await client.query<{id:string;state:string;opaque_session_id:string;provider_state_data:Record<string,unknown>}>(`SELECT id,state,opaque_session_id,provider_state_data
      FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR NO KEY UPDATE${suffix}`,[input.tenantId,connection.id])).rows;
    if(sessions.length!==1||sessions[0]!.state!=="WORKING")throw new MetaDirectEffectNotAttempted();
    const session=sessions[0]!,data=session.provider_state_data;
    if(!data||typeof data!=="object"||Array.isArray(data))throw new MetaDirectEffectNotAttempted();
    const conversation=(await client.query<{connection_id:string;external_chat_id:string;zammad_ticket_id:string;zammad_customer_id:number}>(`SELECT connection_id,external_chat_id,zammad_ticket_id,zammad_customer_id
      FROM bot_conversations WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE NOWAIT`,[input.tenantId,input.conversationId])).rows[0];
    if(!conversation||conversation.connection_id!==connection.id||!conversation.zammad_customer_id
      ||(input.ticketId!==undefined&&conversation.zammad_ticket_id!==input.ticketId))throw new MetaDirectEffectNotAttempted();
    const asset={providerSessionId:session.id,phoneNumberId:session.opaque_session_id,wabaId:typeof data.wabaId==="string"?data.wabaId:null};
    const lifecycle=parseMetaLifecycleState(data.metaLifecycle);assertMetaLifecycleAccess(lifecycle);
    const life=(await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>("SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
      [connection.id,session.id,asset.phoneNumberId,asset.wabaId,input.appId,lifecycle?.revision??0])).rows;
    if(life.length!==1||life[0]!.revision_matches!==true||life[0]!.blocked!==false||life[0]!.unresolved_hold!==false)throw new MetaDirectEffectNotAttempted();
    const metadata=assertMetaCredentialProof(data.metaAccountProof,{appId:input.appId});
    const proof=record(data.metaAccountProof);
    if(proof&&(proof.schemaVersion!==1||proof.claim!=="PHONE_ACCOUNT_RELATION_VERIFIED"||proof.tenantId!==input.tenantId
      ||proof.connectionId!==connection.id||proof.secretReference!==connection.secret_reference||proof.providerSessionId!==session.id
      ||proof.phoneNumberId!==asset.phoneNumberId||proof.wabaId!==asset.wabaId))throw new MetaDirectEffectNotAttempted();
    const participant=(await client.query<{id:string}>(`SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2
      AND external_participant_id=$3 FOR NO KEY UPDATE${suffix}`,[input.tenantId,connection.id,conversation.external_chat_id])).rows;
    if(participant.length>1)throw new MetaDirectEffectNotAttempted();
    const participantId=participant[0]?.id;
    const aliases=participantId?(await client.query<{id:string;state:string;provider_session_id:string;phone_number_id:string;waba_id:string;source_event_id:string}>(`SELECT id,state,provider_session_id,phone_number_id,waba_id,source_event_id
      FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2 AND participant_identity_id=$3
        AND state<>'RETIRED'
      ORDER BY id FOR SHARE${suffix}`,[input.tenantId,connection.id,participantId])).rows:[];
    if(aliases.length){
      assertMetaDirectAccountProof(data.metaAccountProof,{...asset,tenantId:input.tenantId,connectionId:connection.id,secretReference:connection.secret_reference,appId:input.appId});
      if(!metadata||aliases.some(a=>a.state!=="ACTIVE"||a.provider_session_id!==session.id||a.phone_number_id!==asset.phoneNumberId||a.waba_id!==asset.wabaId))throw new MetaDirectEffectNotAttempted();
    }else{
      const history=participantId?await client.query('SELECT 1 FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2 AND participant_identity_id=$3 LIMIT 1',[input.tenantId,connection.id,participantId]):{rowCount:0};
      if(history.rowCount||!/^[1-9][0-9]{2,14}$/u.test(conversation.external_chat_id))throw new MetaDirectEffectNotAttempted();
    }
    for(const alias of aliases){
      const authority=(await client.query<{valid:boolean}>('SELECT app.meta_direct_alias_source_valid($1,$2,$3) AS valid',[alias.id,conversation.external_chat_id,String(conversation.zammad_customer_id)])).rows[0];
      if(authority?.valid!==true)throw new MetaDirectEffectNotAttempted();
    }
    if(input.sourceEventIds!==undefined&&(!input.sourceEventIds.length||input.sourceEventIds.length>2||new Set(input.sourceEventIds).size!==input.sourceEventIds.length))throw new MetaDirectEffectNotAttempted();
    // Queued work uses its immutable job source; native precommit uses the existing alias source pins.
    const sources=[...new Set(input.sourceEventIds??[])];
    for(const sourceId of sources){
      const source=(await client.query<{meta_direct_asset:unknown;status:string;meta_direct_identity_change:unknown;payload_sha256:string}>(`SELECT meta_direct_asset,status,meta_direct_identity_change,payload_sha256 FROM event_inbox
        WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider='META' AND event_type='messages' FOR SHARE${suffix}`,[input.tenantId,connection.id,sourceId])).rows[0];
      const pin=record(source?.meta_direct_asset);
      if(!source||['REDACTED','QUARANTINED','UNMATCHED','IGNORED'].includes(source.status)||source.meta_direct_identity_change!==null
        ||!pin||pin.providerSessionId!==session.id||pin.phoneNumberId!==asset.phoneNumberId||pin.wabaId!==asset.wabaId
        ||Object.keys(pin).sort().join(',')!=="phoneNumberId,providerSessionId,wabaId")throw new MetaDirectEffectNotAttempted();
      // Alias provenance must establish this same canonical/native customer too;
      // an alias created before ordinary normalized intake completed cannot grant native authority.
      {
        const message=await client.query(`SELECT 1 FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND event_inbox_id=$3
          AND external_group_id=$4 AND external_participant_id=$4 AND provider_metadata->'direct'='true'::jsonb
          AND COALESCE(provider_metadata->>'zammad_customer_id','')=$5 AND processing_status<>'REDACTED'`,
          [input.tenantId,connection.id,sourceId,conversation.external_chat_id,String(conversation.zammad_customer_id)]);
        if(message.rowCount!==1)throw new MetaDirectEffectNotAttempted();
      }
    }
    const privacyTargets=await client.query(`SELECT 1 FROM privacy_jobs job LEFT JOIN privacy_job_targets target ON target.tenant_id=job.tenant_id AND target.job_id=job.id
      WHERE job.tenant_id=$1 AND job.job_type IN ('DELETE','RETENTION_SWEEP') AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
       AND target.state IN ('PENDING','EXTERNAL_COMPLETE','COMPLETE') AND
        ((target.target_type='ZAMMAD_TICKET' AND target.target_id=$2)
         OR(target.target_type='ZAMMAD_USER' AND target.target_id=$3)
         OR(target.target_type='META_DIRECT_ALIAS' AND target.target_id=ANY($4::text[]))
         OR(target.target_type='META_DIRECT_IDENTITY_EVENT' AND target.target_id=ANY($5::text[]))) LIMIT 1`,
      [input.tenantId,conversation.zammad_ticket_id,String(conversation.zammad_customer_id),aliases.map(a=>a.id),[...new Set([...sources,...aliases.map(a=>a.source_event_id)])]]);
    if(privacyTargets.rowCount)throw new MetaDirectEffectNotAttempted();
    const identity=(await client.query<{clear:boolean}>("SELECT app.meta_direct_identity_guard($1,$2,$3,$4,$5) AS clear",[connection.id,session.id,asset.phoneNumberId,asset.wabaId,participantId??null])).rows[0];
    if(identity?.clear!==true)throw new MetaDirectEffectNotAttempted();
    if(input.routingActionId!==undefined){
      const action=await client.query(`SELECT 1 FROM meta_thread_control_actions WHERE tenant_id=$1 AND id=$2 AND connection_id=$3
        AND conversation_id=$4 AND participant_identity_id=$5 AND state='RUNNING'`,[input.tenantId,input.routingActionId,connection.id,input.conversationId,participantId??null]);
      if(action.rowCount!==1)throw new MetaDirectEffectNotAttempted();
    }
    let expectedRoutingEpoch:number|null=null;
    let routingSources=input.sourceEventIds??null;
    let nativePrimarySource:string|null=null;
    if(input.routingNativeIntentId!==undefined){
      const intent=(await client.query<{meta_routing_epoch:string|null;meta_primary_source_event_id:string|null}>(`SELECT intent.meta_routing_epoch,intent.meta_primary_source_event_id FROM direct_native_reply_intents intent WHERE intent.tenant_id=$1 AND intent.id=$2
        AND intent.conversation_id=$3 AND intent.state IN('PENDING','ADMITTED')
        AND(intent.meta_routing_epoch=0 OR EXISTS(SELECT 1 FROM meta_thread_ownership ownership WHERE ownership.tenant_id=intent.tenant_id
          AND ownership.connection_id=$4 AND ownership.provider_session_id=$5 AND ownership.participant_identity_id=$6
          AND intent.created_at>=ownership.epoch_started_at))`,[input.tenantId,input.routingNativeIntentId,input.conversationId,connection.id,session.id,participantId??null])).rows[0];
      if(intent?.meta_routing_epoch==null)throw new MetaDirectEffectNotAttempted();
      expectedRoutingEpoch=Number(intent.meta_routing_epoch);
      nativePrimarySource=intent.meta_primary_source_event_id;
      if(nativePrimarySource){
        if(routingSources&&routingSources.some(id=>id!==nativePrimarySource))throw new MetaDirectEffectNotAttempted();
        routingSources=[nativePrimarySource];
      }
    }
    const templateMode=input.ticketTemplate===true?",true,true":"";
    const routing=(await client.query<{allowed:boolean;claim:string}>(`SELECT allowed,claim FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7::jsonb,$10,$8::uuid[],$9::uuid${templateMode})`,
      [connection.id,session.id,asset.phoneNumberId,asset.wabaId,participantId??null,input.appId,JSON.stringify(metaRoutingRuntime(process.env)),routingSources,input.routingActionId??null,expectedRoutingEpoch])).rows[0];
    if(routing?.allowed!==true||(routing.claim==='PRIMARY_DELIVERY'&&input.routingNativeIntentId!==undefined&&!nativePrimarySource))throw new MetaDirectEffectNotAttempted();
  }catch(error){
    if(error instanceof MetaDirectEffectNotAttempted)throw error;
    // This is pre-request admission: even PG busy/proof rejection is NOT an attempted HTTP outcome.
    throw new MetaDirectEffectNotAttempted((error as {code?:string})?.code==="55P03"?"BUSY":"HELD");
  }
}
