import { createHash } from "node:crypto";

export type MetaAccountRelation = {
  schemaVersion: 1;
  claim: "PHONE_ACCOUNT_RELATION_VERIFIED";
  phoneNumberId: string;
  wabaId: string;
  graphVersion: string;
  verifiedAt: string;
  responseSha256: string;
  displayPhoneNumber?: string;
  credentialMetadata?: MetaCredentialMetadata;
};

export type MetaConnectionBinding = {
  secretReference: string;
  providerSessionId: string;
  phoneNumberId: string;
  wabaId: string;
};

export type MetaAccountProof = MetaAccountRelation & MetaConnectionBinding & {
  tenantId: string;
  connectionId: string;
  credentialFingerprint: string;
  operationId: string;
  fencingToken: number;
};

export class MetaAccountRelationError extends Error {
  readonly code = "META_PHONE_ACCOUNT_RELATION_INVALID";
  constructor() {
    super("Meta could not verify this phone number in the selected WhatsApp Business Account.");
  }
}

// Both API admission and worker activation use the same bounded provider contract.
// Transport, credential handling and provider error classification remain with each caller.
export async function verifyMetaAccountRelation(
  phoneNumberId: string,
  wabaId: string,
  graphVersion: string,
  readPage: (query: Record<string, string>, signal: AbortSignal) => Promise<unknown>,
): Promise<MetaAccountRelation> {
  if (!numericId(phoneNumberId) || !numericId(wabaId) || !/^v\d{1,3}\.\d{1,3}$/u.test(graphVersion)) {
    throw new MetaAccountRelationError();
  }
  const signal = AbortSignal.timeout(30_000);
  const seen = new Set<string>();
  const hash = createHash("sha256");
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    signal.throwIfAborted();
    const value = record(await readPage({ fields: "id,display_phone_number", limit: "100", ...(after ? { after } : {}) }, signal));
    signal.throwIfAborted();
    if (!Array.isArray(value?.data) || value.data.length > 100) throw new MetaAccountRelationError();
    const ids = value.data.map((item) => record(item)?.id);
    if (ids.some((id) => !numericId(id))) throw new MetaAccountRelationError();
    hash.update(JSON.stringify({ after: after ?? null, ids }));
    const matches = value.data.filter((item) => record(item)?.id === phoneNumberId);
    if (matches.length > 1) throw new MetaAccountRelationError();
    if (matches.length === 1) {
      const matched = record(matches[0])!;
      const displayPhoneNumber = matched.display_phone_number === undefined ? undefined : normalizeMetaDisplayPhoneNumber(matched.display_phone_number);
      if (matched.display_phone_number !== undefined && !displayPhoneNumber) throw new MetaAccountRelationError();
      // Only the provider's exact Graph-ID row contributes a display-phone identity.
      // Absence preserves legacy relation proof, but cannot narrow a phone-scoped lifecycle event.
      if (displayPhoneNumber) hash.update(JSON.stringify({ phoneNumberId, displayPhoneNumber }));
      return {
        schemaVersion: 1, claim: "PHONE_ACCOUNT_RELATION_VERIFIED", phoneNumberId, wabaId,
        graphVersion, verifiedAt: new Date().toISOString(), responseSha256: hash.digest("hex"),
        ...(displayPhoneNumber ? { displayPhoneNumber } : {}),
      };
    }
    if (value.paging === undefined) break;
    const paging = record(value.paging);
    if (!paging) throw new MetaAccountRelationError();
    if (paging.next === undefined) break;
    const cursor = record(paging.cursors)?.after;
    if (typeof paging.next !== "string" || !paging.next || paging.next.length > 8_192
      || typeof cursor !== "string" || !/^[A-Za-z0-9_+/=-]{1,2048}$/u.test(cursor) || seen.has(cursor)) {
      throw new MetaAccountRelationError();
    }
    // Only the opaque cursor is used. Never follow a provider-supplied URL with a bearer token.
    seen.add(cursor);
    after = cursor;
  }
  throw new MetaAccountRelationError();
}

export function sameMetaConnectionBinding(left: MetaConnectionBinding, right: MetaConnectionBinding) {
  return left.secretReference === right.secretReference && left.providerSessionId === right.providerSessionId
    && left.phoneNumberId === right.phoneNumberId && left.wabaId === right.wabaId;
}

function numericId(value: unknown): value is string {
  return typeof value === "string" && /^\d{5,32}$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}


// Credential validity is distinct from phone/account membership, ownership and billing.
export type MetaCredentialMetadata = {
  schemaVersion: 1;
  claim: "CREDENTIAL_METADATA_VERIFIED";
  appId: string;
  scopes: string[];
  expiresAt: number;
  dataAccessExpiresAt?: number;
  verifiedAt: string;
  responseSha256: string;
};

export class MetaCredentialMetadataError extends Error {
  readonly code = "META_CREDENTIAL_METADATA_INVALID";
  constructor() {
    super("Meta credentials could not be verified for the configured application.");
  }
}

export function verifyMetaCredentialMetadata(
  payload: unknown,
  expected: { appId: string; now?: Date; purpose?: "WHATSAPP" | "FINANCIAL" },
): MetaCredentialMetadata {
  const now = expected.now ?? new Date();
  const seconds = Math.floor(now.getTime() / 1_000);
  const data = record(record(payload)?.data);
  if (!Number.isSafeInteger(seconds) || !numericId(expected.appId) || !data
    || data.is_valid !== true || data.app_id !== expected.appId
    || !Array.isArray(data.scopes) || data.scopes.length > 100
    || data.scopes.some((scope) => typeof scope !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(scope))
    || !credentialExpiry(data.expires_at, seconds)
    || (data.data_access_expires_at !== undefined && !credentialExpiry(data.data_access_expires_at, seconds))) {
    throw new MetaCredentialMetadataError();
  }
  const scopes = [...new Set(data.scopes as string[])].sort();
  if (expected.purpose === "FINANCIAL" ? !scopes.includes("business_management")
    : !scopes.includes("whatsapp_business_management") || !scopes.includes("whatsapp_business_messaging")) {
    throw new MetaCredentialMetadataError();
  }
  // Only verified fields enter evidence. User IDs, granular target IDs and free text are not grants.
  const parsed = {
    is_valid: true, app_id: expected.appId, scopes, expires_at: data.expires_at as number,
    ...(data.data_access_expires_at === undefined ? {} : { data_access_expires_at: data.data_access_expires_at as number }),
  };
  return {
    schemaVersion: 1, claim: "CREDENTIAL_METADATA_VERIFIED", appId: expected.appId, scopes,
    expiresAt: parsed.expires_at,
    ...(parsed.data_access_expires_at === undefined ? {} : { dataAccessExpiresAt: parsed.data_access_expires_at }),
    verifiedAt: now.toISOString(), responseSha256: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
  };
}

// Identity/current-session equality is enforced by callers under their existing CAS/lease boundary.
// Missing metadata is explicitly legacy, never an application/ownership verification claim.
export function assertMetaCredentialProof(
  proof: unknown,
  expected: { appId: string; credentialFingerprint?: string; accessToken?: string; now?: Date; purpose?: "WHATSAPP" | "FINANCIAL" },
): MetaCredentialMetadata | undefined {
  if (proof === undefined || proof === null) return undefined;
  const value = record(proof);
  if (!value) throw new MetaCredentialMetadataError();
  const tokenFingerprint = expected.accessToken === undefined ? undefined
    : createHash("sha256").update(expected.accessToken).digest("hex");
  if ((expected.credentialFingerprint !== undefined && value.credentialFingerprint !== expected.credentialFingerprint)
    || (tokenFingerprint !== undefined && value.credentialFingerprint !== tokenFingerprint)) {
    throw new MetaCredentialMetadataError();
  }
  if (value.credentialMetadata === undefined) return undefined;
  const metadata = record(value.credentialMetadata);
  if (!metadata || metadata.schemaVersion !== 1 || metadata.claim !== "CREDENTIAL_METADATA_VERIFIED"
    || metadata.appId !== expected.appId || typeof value.credentialFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.credentialFingerprint)
    || typeof metadata.verifiedAt !== "string" || !Number.isFinite(Date.parse(metadata.verifiedAt))
    || new Date(metadata.verifiedAt).toISOString() !== metadata.verifiedAt
    || Date.parse(metadata.verifiedAt) > (expected.now ?? new Date()).getTime()
    || Object.keys(metadata).some((key) => ![
      "schemaVersion", "claim", "appId", "scopes", "expiresAt", "dataAccessExpiresAt", "verifiedAt", "responseSha256",
    ].includes(key))) throw new MetaCredentialMetadataError();
  const checked = verifyMetaCredentialMetadata({ data: {
    is_valid: true, app_id: metadata.appId, scopes: metadata.scopes, expires_at: metadata.expiresAt,
    ...(metadata.dataAccessExpiresAt === undefined ? {} : { data_access_expires_at: metadata.dataAccessExpiresAt }),
  } }, expected);
  if (checked.responseSha256 !== metadata.responseSha256
    || JSON.stringify(checked.scopes) !== JSON.stringify(metadata.scopes)) throw new MetaCredentialMetadataError();
  return metadata as MetaCredentialMetadata;
}

function credentialExpiry(value: unknown, nowSeconds: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && (value === 0 || value > nowSeconds);
}

// Provider lifecycle evidence is independent of credentials and local PAUSE/REVOKE.
export const META_LIFECYCLE_REASONS = [
  "ACCOUNT_DELETED", "ACCOUNT_OFFBOARDED", "PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED",
  "ACCOUNT_DISABLED", "ACCOUNT_SCHEDULED_DISABLE", "RESTRICTED_BIZ_INITIATED_MESSAGING",
  "RESTRICTED_CUSTOMER_INITIATED_MESSAGING", "RESTRICTED_DIRECT_SEND_UTILITY_TEMPLATES",
  "UNRESOLVED_PHONE", "LIFECYCLE_CONFLICT",
] as const;
export type MetaLifecycleReason = typeof META_LIFECYCLE_REASONS[number];
export type MetaLifecycleStamp = { event: string; observedAt: string; payloadSha256: string };
export type MetaLifecycleObservation = MetaLifecycleStamp & {
  kind: "BLOCK" | "RECOVERY" | "OBSERVATION";
  reasons: MetaLifecycleReason[];
};
export type MetaLifecycleState = {
  schemaVersion: 1;
  revision: number;
  lastObservedAt: string;
  lastEvent: string;
  lastPayloadSha256: string;
  reasonStates: Array<{
    reason: MetaLifecycleReason;
    negative?: MetaLifecycleStamp;
    recovery?: MetaLifecycleStamp;
    clearedThrough?: MetaLifecycleStamp;
    blocked: boolean;
    conflict?: true;
  }>;
};
export class MetaLifecycleError extends Error {
  readonly code = "META_ACCOUNT_LIFECYCLE_HELD";
  constructor() { super("Meta account access requires lifecycle reconciliation."); }
}

// Semantic unit identity survives PostgreSQL JSONB key ordering. Raw-body HMAC is separate.
export function metaLifecyclePayloadSha256(payload: unknown): string {
  return createHash("sha256").update(metaLifecycleCanonicalJson(payload, 0)).digest("hex");
}
function metaLifecycleCanonicalJson(value: unknown, depth: number): string {
  if (depth > 32) throw new MetaLifecycleError();
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Sparse arrays and undefined elements are not JSON values.
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new MetaLifecycleError();
    return `[${value.map(item => metaLifecycleCanonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.getOwnPropertySymbols(value).length) throw new MetaLifecycleError();
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${metaLifecycleCanonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
  }
  throw new MetaLifecycleError();
}

// Provider display-phone strings contain a country code. Never infer one from a local number.
export function normalizeMetaDisplayPhoneNumber(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || !/^\+?[0-9() .\u00a0-]+$/u.test(value)) return undefined;
  const digits = value.replace(/[() .\u00a0-]/gu, "").replace(/^\+/u, "");
  return /^[1-9][0-9]{5,14}$/u.test(digits) ? `+${digits}` : undefined;
}

export function metaLifecycleAccountId(entryId: unknown, value: unknown): string {
  const v = record(value);
  if (!numericId(entryId) || !v || typeof v.event !== "string") throw new MetaLifecycleError();
  if (!v.event.startsWith("PARTNER_")) return entryId;
  // Portfolio-addressed partner events identify the customer account explicitly.
  // Present but malformed metadata must never fall back to the envelope's ID.
  if (Object.hasOwn(v, "waba_info")) {
    const accountId = record(v.waba_info)?.waba_id;
    if (!numericId(accountId)) throw new MetaLifecycleError();
    return accountId;
  }
  // Coexistence removal is account-addressed and carries a display phone.
  // Optional disconnection_info describes the reason, not routing authority.
  if (v.event === "PARTNER_REMOVED" && normalizeMetaDisplayPhoneNumber(v.phone_number)) return entryId;
  throw new MetaLifecycleError();
}

// Raw-body signature, entry.time, route lookup and unit hash belong to ingress.
// This helper owns only the finite account_update event/reason classification.
export function classifyMetaLifecycleValue(value: unknown, appId: string): Pick<MetaLifecycleObservation, "event" | "kind" | "reasons"> {
  const v = record(value);
  if (!v || !numericId(appId) || typeof v.event !== "string" || !/^[A-Z_]{1,80}$/u.test(v.event)) throw new MetaLifecycleError();
  let event = v.event;
  let kind: MetaLifecycleObservation["kind"] = "OBSERVATION";
  let reasons: MetaLifecycleReason[] = [];
  if (["PARTNER_APP_UNINSTALLED", "PARTNER_APP_INSTALLED"].includes(event)) {
    const id = record(v.waba_info)?.partner_app_id;
    if (!numericId(id)) throw new MetaLifecycleError();
    if (id !== appId) return { event, kind, reasons };
  }
  if (["ACCOUNT_DELETED", "ACCOUNT_OFFBOARDED", "PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED"].includes(event)) {
    kind = "BLOCK"; reasons = [event as MetaLifecycleReason];
  } else if (event === "DISABLED_UPDATE") {
    const ban = record(v.ban_info)?.waba_ban_state;
    if (!["DISABLE", "SCHEDULE_FOR_DISABLE", "REINSTATE"].includes(String(ban))) throw new MetaLifecycleError();
    event = `${event}:${ban}`;
    kind = ban === "REINSTATE" ? "RECOVERY" : "BLOCK";
    reasons = ban === "REINSTATE" ? ["ACCOUNT_DISABLED", "ACCOUNT_SCHEDULED_DISABLE"]
      : [ban === "DISABLE" ? "ACCOUNT_DISABLED" : "ACCOUNT_SCHEDULED_DISABLE"];
  } else if (event === "ACCOUNT_RESTRICTION") {
    if (!Array.isArray(v.restriction_info) || v.restriction_info.length === 0 || v.restriction_info.length > 20) throw new MetaLifecycleError();
    for (const item of v.restriction_info) {
      const type = record(item)?.restriction_type;
      if (typeof type !== "string" || !/^[A-Z_]{1,100}$/u.test(type)) throw new MetaLifecycleError();
      if (["RESTRICTED_BIZ_INITIATED_MESSAGING", "RESTRICTED_CUSTOMER_INITIATED_MESSAGING",
        "RESTRICTED_DIRECT_SEND_UTILITY_TEMPLATES"].includes(type)) reasons.push(type as MetaLifecycleReason);
    }
    if (reasons.length) kind = "BLOCK";
  } else {
    reasons = recoveryReasons(event);
    if (reasons.length) kind = "RECOVERY";
  }
  return { event, kind, reasons: [...new Set(reasons)].sort() };
}

export function parseMetaLifecycleState(value: unknown): MetaLifecycleState | undefined {
  if (value === undefined) return undefined;
  const v = record(value);
  if (!v || !onlyKeys(v, ["schemaVersion", "revision", "lastObservedAt", "lastEvent", "lastPayloadSha256", "reasonStates"])
    || v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1
    || !validLifecycleStamp({ event: v.lastEvent, observedAt: v.lastObservedAt, payloadSha256: v.lastPayloadSha256 })
    || !Array.isArray(v.reasonStates) || v.reasonStates.length > META_LIFECYCLE_REASONS.length) throw new MetaLifecycleError();
  const seen = new Set<string>();
  for (const item of v.reasonStates) {
    const r = record(item);
    if (!r || !onlyKeys(r, ["reason", "negative", "recovery", "clearedThrough", "blocked", "conflict"])
      || !isLifecycleReason(r.reason) || seen.has(r.reason) || typeof r.blocked !== "boolean"
      || (r.conflict !== undefined && r.conflict !== true)
      || (r.negative !== undefined && !validLifecycleStamp(r.negative))
      || (r.recovery !== undefined && !validLifecycleStamp(r.recovery))
      || (r.clearedThrough !== undefined && (!validLifecycleStamp(r.clearedThrough) || !r.negative || !r.recovery
        || !recoveryReasons((r.clearedThrough as MetaLifecycleStamp).event).includes(r.reason)
        || (r.clearedThrough as MetaLifecycleStamp).observedAt > (r.recovery as MetaLifecycleStamp).observedAt
        || ((r.clearedThrough as MetaLifecycleStamp).observedAt === (r.recovery as MetaLifecycleStamp).observedAt
          && !sameStamp(r.clearedThrough as MetaLifecycleStamp, r.recovery as MetaLifecycleStamp) && r.conflict !== true)))
      || (!r.negative && !r.recovery) || (r.blocked && !r.negative)
      || (r.conflict && !r.blocked)
      || (r.negative && !r.blocked && (!r.clearedThrough || (r.clearedThrough as MetaLifecycleStamp).observedAt <= (r.negative as MetaLifecycleStamp).observedAt))
      || (r.recovery && !recoveryReasons((r.recovery as MetaLifecycleStamp).event).includes(r.reason))) throw new MetaLifecycleError();
    seen.add(r.reason);
  }
  if ([...seen].join("|") !== [...seen].sort().join("|")) throw new MetaLifecycleError();
  return JSON.parse(JSON.stringify(v)) as MetaLifecycleState;
}

export function metaLifecycleBlockingReasons(value: unknown): MetaLifecycleReason[] {
  const state = parseMetaLifecycleState(value);
  const reasons = state?.reasonStates.filter(r => r.blocked).map(r => r.reason) ?? [];
  if (state?.reasonStates.some(r => r.conflict) && !reasons.includes("LIFECYCLE_CONFLICT")) reasons.push("LIFECYCLE_CONFLICT");
  return reasons.sort();
}
export function assertMetaLifecycleAccess(value: unknown): void {
  if (metaLifecycleBlockingReasons(value).length) throw new MetaLifecycleError();
}

export function parseMetaLifecycleObservation(value: unknown): MetaLifecycleObservation {
  const v = record(value);
  if (!v || !onlyKeys(v, ["event", "observedAt", "payloadSha256", "kind", "reasons"])
    || !validLifecycleStamp({ event: v.event, observedAt: v.observedAt, payloadSha256: v.payloadSha256 })
    || !["BLOCK", "RECOVERY", "OBSERVATION"].includes(String(v.kind)) || !Array.isArray(v.reasons)
    || v.reasons.length > META_LIFECYCLE_REASONS.length || v.reasons.some(r => !isLifecycleReason(r))
    || new Set(v.reasons).size !== v.reasons.length
    || (v.kind === "OBSERVATION" && v.reasons.length !== 0) || (v.kind !== "OBSERVATION" && v.reasons.length === 0)
    || (v.kind === "RECOVERY" && v.reasons.some(r => !recoveryReasons(String(v.event)).includes(r)))) throw new MetaLifecycleError();
  return { event: String(v.event), observedAt: String(v.observedAt), payloadSha256: String(v.payloadSha256),
    kind: v.kind as MetaLifecycleObservation["kind"], reasons: [...v.reasons].sort() as MetaLifecycleReason[] };
}

export function applyMetaLifecycleObservation(value: unknown, observation: MetaLifecycleObservation): {
  state: MetaLifecycleState;
  outcome: "APPLIED" | "DUPLICATE" | "IGNORED_STALE";
} {
  const previous = parseMetaLifecycleState(value);
  observation = parseMetaLifecycleObservation(observation);
  const stamp: MetaLifecycleStamp = { event: observation.event, observedAt: observation.observedAt, payloadSha256: observation.payloadSha256 };
  const state: MetaLifecycleState = previous ?? { schemaVersion: 1, revision: 1, lastObservedAt: stamp.observedAt,
    lastEvent: stamp.event, lastPayloadSha256: stamp.payloadSha256, reasonStates: [] };
  let changed = !previous;
  let duplicate = false;
  if (observation.kind !== "OBSERVATION") for (const reason of observation.reasons) {
    let slot = state.reasonStates.find(r => r.reason === reason);
    if (!slot) { slot = { reason, blocked: false }; state.reasonStates.push(slot); }
    const key = observation.kind === "BLOCK" ? "negative" : "recovery";
    const old = slot[key];
    if (old && stamp.observedAt < old.observedAt) continue;
    if (old && sameStamp(old, stamp)) { duplicate = true; continue; }
    const other = slot[key === "negative" ? "recovery" : "negative"];
    if ((old && stamp.observedAt === old.observedAt) || (other && stamp.observedAt === other.observedAt)) {
      // A tie is never resolved by arrival order. Retain one deterministic stamp and an enduring conflict hold.
      slot.conflict = true; slot.blocked = true;
      if (!slot.negative) slot.negative = stamp;
      slot[key] = old && stampKey(old) > stampKey(stamp) ? old : stamp;
      changed = true; continue;
    }
    const wasExplicitlyRecovered = !slot.blocked && slot.negative && slot.clearedThrough && slot.clearedThrough.observedAt > slot.negative.observedAt;
    slot[key] = stamp;
    if (key === "negative" && !(wasExplicitlyRecovered && slot.clearedThrough && stamp.observedAt < slot.clearedThrough.observedAt)) slot.blocked = true;
    changed = true;
  }
  if (observation.kind === "OBSERVATION") {
    const diagnostic = { event: state.lastEvent, observedAt: state.lastObservedAt, payloadSha256: state.lastPayloadSha256 };
    if (previous && sameStamp(diagnostic, stamp)) duplicate = true;
    else if (!previous || stamp.observedAt >= state.lastObservedAt) changed = true;
  }
  if (!changed) return { state, outcome: duplicate ? "DUPLICATE" : "IGNORED_STALE" };
  if (previous) {
    if (state.revision === Number.MAX_SAFE_INTEGER) throw new MetaLifecycleError();
    state.revision++;
  }
  if (stamp.observedAt > state.lastObservedAt || (stamp.observedAt === state.lastObservedAt && stampKey(stamp) > `${state.lastEvent}|${state.lastPayloadSha256}`)) {
    state.lastObservedAt = stamp.observedAt; state.lastEvent = stamp.event; state.lastPayloadSha256 = stamp.payloadSha256;
  }
  state.reasonStates.sort((a, b) => a.reason.localeCompare(b.reason, "en"));
  return { state, outcome: "APPLIED" };
}

// Caller must independently finish a fresh explicit activation under current asset/revision/pending-BLOCK CAS.
// No webhook or credential rotation calls this helper automatically.
export function recoverMetaLifecycleReasons(value: unknown, expectedRevision: number, reasons: readonly MetaLifecycleReason[]): MetaLifecycleState {
  const state = parseMetaLifecycleState(value);
  if (!state || state.revision !== expectedRevision || reasons.length === 0 || new Set(reasons).size !== reasons.length
    || state.revision === Number.MAX_SAFE_INTEGER) throw new MetaLifecycleError();
  for (const reason of reasons) {
    const r = state.reasonStates.find(item => item.reason === reason);
    if (!r?.blocked || r.conflict || !r.negative || !r.recovery || r.recovery.observedAt <= r.negative.observedAt
      || ["ACCOUNT_DELETED", "UNRESOLVED_PHONE", "LIFECYCLE_CONFLICT"].includes(reason)
      || !recoveryReasons(r.recovery.event).includes(reason)) throw new MetaLifecycleError();
  }
  for (const r of state.reasonStates) if (reasons.includes(r.reason)) {
    r.clearedThrough = { ...r.recovery! };
    r.blocked = false;
  }
  state.revision++;
  return state;
}

function recoveryReasons(event: string): MetaLifecycleReason[] {
  if (event === "ACCOUNT_RECONNECTED") return ["ACCOUNT_OFFBOARDED"];
  if (event === "PARTNER_ADDED") return ["PARTNER_REMOVED"];
  if (event === "PARTNER_APP_INSTALLED") return ["PARTNER_APP_UNINSTALLED"];
  if (event === "DISABLED_UPDATE:REINSTATE") return ["ACCOUNT_DISABLED", "ACCOUNT_SCHEDULED_DISABLE"];
  return [];
}
function isLifecycleReason(value: unknown): value is MetaLifecycleReason {
  return typeof value === "string" && (META_LIFECYCLE_REASONS as readonly string[]).includes(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).every(key => keys.includes(key)); }
function validLifecycleStamp(value: unknown): value is MetaLifecycleStamp {
  const v = record(value);
  if (!v || !onlyKeys(v, ["event", "observedAt", "payloadSha256"]) || typeof v.event !== "string"
    || !/^[A-Z_:]{1,100}$/u.test(v.event) || typeof v.observedAt !== "string"
    || typeof v.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(v.payloadSha256)) return false;
  const d = new Date(v.observedAt);
  return Number.isFinite(d.getTime()) && d.getTime() > 0 && d.toISOString() === v.observedAt;
}
function sameStamp(a: MetaLifecycleStamp, b: MetaLifecycleStamp) { return a.observedAt === b.observedAt && a.event === b.event && a.payloadSha256 === b.payloadSha256; }
function stampKey(value: MetaLifecycleStamp) { return `${value.event}|${value.payloadSha256}`; }
