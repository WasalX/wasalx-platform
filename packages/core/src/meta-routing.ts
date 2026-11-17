import { metaLifecyclePayloadSha256 } from "./meta-account-relation.js";
import { parseMetaDirectIdentity, metaDirectRecipientFields } from "./meta-direct-identity.js";

import { META_ROUTING_ROLES, type MetaRoutingRole, type MetaRoutingReviewBody } from "./meta-routing-contract.js";
export { META_ROUTING_ROLES, type MetaRoutingRole } from "./meta-routing-contract.js";
export type MetaRoutingCategory = "PRIMARY_MESSAGE" | "OWN_MESSAGE_STATUS" | "STANDBY_MESSAGE" | "STANDBY_ECHO" | "STANDBY_STATUS" | "CONTROL_PASSED" | "CONTROL_TAKEN" | "UNRESOLVED_ROUTING";
export type MetaRoutingEvidence = {
  schemaVersion: 1; category: MetaRoutingCategory; accountId: string; phoneNumberId: string;
  observedAt: string; payloadSha256: string; peer?: { kind: "PHONE" | "BSUID"; value: string };
};
export type MetaRoutingState = { state: "OWN" | "STANDBY" | "IDLE" | "UNKNOWN"; epoch: number; observedAt: string; sourceHash: string; lastCustomerMessageAt?: string };
export class MetaRoutingError extends Error {
  readonly code = "META_ROUTING_HELD";
  constructor() { super("Meta conversation routing requires reconciliation."); }
}
export type MetaRoutingRuntime = { mode: "LIVE" | "SIMULATED"; graphOrigin: string; graphVersion: string; simulationBindingSha256?: string };
/** Server configuration only. A request body cannot select or promote evidence mode. */
export function metaRoutingRuntime(environment: Record<string, string | undefined>): MetaRoutingRuntime {
  const url = new URL(environment.META_GRAPH_BASE_URL ?? "https://graph.facebook.com");
  const graphVersion = environment.META_GRAPH_VERSION ?? "";
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^v[0-9]{1,3}\.[0-9]{1,3}$/u.test(graphVersion)) throw new MetaRoutingError();
  const binding = environment.META_ROUTING_SIMULATION_BINDING_SHA256;
  // An admitted private DNS/TLS simulator can retain the canonical Graph origin.
  // The server-only marker takes precedence; browser input cannot select mode.
  if (binding !== undefined && binding !== "") {
    if (environment.NODE_ENV === "production" || !/^[0-9a-f]{64}$/u.test(binding)) throw new MetaRoutingError();
    return { mode: "SIMULATED", graphOrigin: url.origin, graphVersion, simulationBindingSha256: binding };
  }
  if (url.origin === "https://graph.facebook.com") return { mode: "LIVE", graphOrigin: url.origin, graphVersion };
  throw new MetaRoutingError();
}

export type MetaRoutingDeclaration = { expectedVersion: number; expectedSessionId: string; fallback: "HOLD" };
export function parseMetaRoutingDeclaration(value: unknown): MetaRoutingDeclaration {
  const v = record(value);
  if (!v || Object.keys(v).some(key => !["expectedVersion", "expectedSessionId", "fallback"].includes(key))
    || !revision(v.expectedVersion, true) || !uuid(v.expectedSessionId) || v.fallback !== "HOLD") throw new MetaRoutingError();
  return { expectedVersion: v.expectedVersion as number, expectedSessionId: v.expectedSessionId as string, fallback: "HOLD" };
}
export type MetaRoutingReviewInput = MetaRoutingReviewBody;
export function parseMetaRoutingReview(value: unknown, now = Date.now()): MetaRoutingReviewInput {
  const v = record(value), keys = ["expectedSessionId", "expectedConfigurationVersion", "expectedReviewVersion", "disposition", "observedAt", "evidenceSha256", "evidenceReference", "scope", "roles", "targets", "fields", "termsAccepted", "threadControlEnabled", "personallyObserved"];
  if (!v || Object.keys(v).some(key => !keys.includes(key)) || keys.some(key => !(key in v)) || !uuid(v.expectedSessionId)
    || !revision(v.expectedConfigurationVersion, true) || !revision(v.expectedReviewVersion, true)
    || typeof v.disposition !== "string" || !["REVIEWED", "REVOKED"].includes(v.disposition)
    || typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt)) || new Date(v.observedAt).toISOString() !== v.observedAt || Date.parse(v.observedAt) > now || Date.parse(v.observedAt) <= 0
    || typeof v.evidenceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(v.evidenceSha256)
    || typeof v.evidenceReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(v.evidenceReference)
    || typeof v.scope !== "string" || !["PHONE_OVERRIDE", "ACCOUNT_DEFAULT"].includes(v.scope)
    || !finiteList(v.roles, META_ROUTING_ROLES) || !finiteList(v.targets, META_ROUTING_ROLES)
    || !finiteList(v.fields, ["messages", "standby", "messaging_handovers"])
    || typeof v.termsAccepted !== "boolean" || typeof v.threadControlEnabled !== "boolean" || v.personallyObserved !== true) throw new MetaRoutingError();
  if (v.disposition === "REVIEWED" && (!(v.roles as string[]).length || v.termsAccepted !== true || !(v.fields as string[]).includes("messages") || !(v.fields as string[]).includes("messaging_handovers"))) throw new MetaRoutingError();
  return v as unknown as MetaRoutingReviewInput;
}
function uuid(v: unknown): v is string { return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v); }
function revision(v: unknown, zero = false): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= (zero ? 0 : 1); }
function finiteList(v: unknown, allowed: readonly string[]): v is string[] { return Array.isArray(v) && v.length <= allowed.length && new Set(v).size === v.length && v.every(item => typeof item === "string" && allowed.includes(item)); }
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const id = (v: unknown): v is string => typeof v === "string" && /^[0-9]{1,32}$/u.test(v);
function timestamp(v: unknown): string {
  if ((typeof v !== "string" && typeof v !== "number") || !/^[0-9]{1,12}$/u.test(String(v))) throw new MetaRoutingError();
  const value = Number(v);
  if (!Number.isSafeInteger(value) || value <= 0 || value > Date.now() / 1000 + 300) throw new MetaRoutingError();
  return new Date(value * 1000).toISOString();
}
function peer(kind: "PHONE" | "BSUID", value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new MetaRoutingError();
  const checked = metaDirectRecipientFields({ kind, value });
  return { kind, value: "to" in checked ? checked.to : checked.recipient };
}

/** Called only after raw-body HMAC verification. Never turns passive payloads into live messages. */
export function metaRoutingUnits(accountId: unknown, field: string, value: unknown): Array<{ field: string; value: Record<string, unknown>; evidence: MetaRoutingEvidence }> {
  const v = record(value);
  if (!id(accountId) || !v || v.messaging_product !== "whatsapp") throw new MetaRoutingError();
  const metadata = record(v.metadata), recipient = record(v.recipient);
  const phoneNumberId = field === "messaging_handovers" ? recipient?.phone_number_id : metadata?.phone_number_id;
  if (!id(phoneNumberId)) throw new MetaRoutingError();
  const result: ReturnType<typeof metaRoutingUnits> = [];
  const add = (category: MetaRoutingCategory, unit: Record<string, unknown>, time: unknown, identity?: MetaRoutingEvidence["peer"]) => {
    const payload = { object: "whatsapp_business_account", entry: [{ id: accountId, changes: [{ field, value: unit }] }] };
    result.push({ field, value: unit, evidence: { schemaVersion: 1, category, accountId, phoneNumberId,
      observedAt: timestamp(time), payloadSha256: metaLifecyclePayloadSha256(payload), ...(identity ? { peer: identity } : {}) } });
  };
  if (field === "messaging_handovers") {
    if (["messages", "statuses", "standby", "history", "state_sync", "message_echoes"].some(key => key in v)) throw new MetaRoutingError();
    if (v.type !== "control_passed" && v.type !== "control_taken") throw new MetaRoutingError();
    if (v[v.type] !== undefined && !record(v[v.type])) throw new MetaRoutingError();
    // The official handover reference documents only sender.phone_number. Missing sender is not a fabricated BSUID.
    const sender = record(v.sender);
    if (v.sender !== undefined && !sender) throw new MetaRoutingError();
    add(v.type === "control_passed" ? "CONTROL_PASSED" : "CONTROL_TAKEN", v, v.timestamp, peer("PHONE", sender?.phone_number));
    return result;
  }
  const passive = field === "standby";
  if (field !== "messages" && !passive) throw new MetaRoutingError();
  if ((passive ? ["messages", "statuses", "message_echoes", "history", "state_sync"] : ["standby", "history", "state_sync", "message_echoes"]).some(key => key in v)) throw new MetaRoutingError();
  const body = passive ? record(v.standby) : v;
  if (!body) throw new MetaRoutingError();
  for (const key of passive ? ["messages", "message_echoes", "statuses"] : ["messages", "statuses"]) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key]) || body[key].length === 0 || body[key].length > 1000) throw new MetaRoutingError();
    for (const item of body[key]) {
      const message = record(item);
      if (!message || message.group_id !== undefined) throw new MetaRoutingError();
      if (key === "messages" && message.type === "system" && !passive) continue;
      const unit = { ...v };
      // A unit cannot retain an adjacent live message or another responder's receipt.
      delete unit.messages; delete unit.statuses; delete unit.message_echoes;
      if (passive) unit.standby = { ...(body.contacts === undefined ? {} : { contacts: body.contacts }), [key]: [message] };
      else unit[key] = [message];
      let identity: MetaRoutingEvidence["peer"];
      if (key === "messages") {
        const parsed = parseMetaDirectIdentity(message, body.contacts ?? v.contacts).identity;
        identity = parsed.bsuid ? peer("BSUID", parsed.bsuid) : peer("PHONE", parsed.phone);
      } else if (key === "message_echoes") {
        // Send-time parameters are passive context. Do not interpret a missing/undocumented identifier.
        identity = message.recipient !== undefined ? peer("BSUID", message.recipient) : peer("PHONE", message.to);
      }
      add(key === "messages" ? passive ? "STANDBY_MESSAGE" : "PRIMARY_MESSAGE"
        : key === "message_echoes" ? "STANDBY_ECHO" : passive ? "STANDBY_STATUS" : "OWN_MESSAGE_STATUS", unit, message.timestamp, identity);
    }
  }
  if (!result.length && passive) throw new MetaRoutingError();
  return result;
}

/** Seconds are not a total order. Conflicting same-time states hold in either arrival order. */
export function reduceMetaRouting(previous: MetaRoutingState | undefined, evidence: MetaRoutingEvidence, configured: boolean): MetaRoutingState | undefined {
  if (["OWN_MESSAGE_STATUS", "STANDBY_ECHO", "STANDBY_STATUS"].includes(evidence.category)) return previous;
  if ((evidence.category === "PRIMARY_MESSAGE" || evidence.category === "CONTROL_PASSED") && !evidence.peer) return previous;
  const desired = evidence.category === "UNRESOLVED_ROUTING" ? "UNKNOWN" : evidence.category === "PRIMARY_MESSAGE" || evidence.category === "CONTROL_PASSED" ? configured ? "OWN" : "UNKNOWN" : "STANDBY";
  if (previous && evidence.observedAt < previous.observedAt) return previous;
  if (previous && evidence.payloadSha256 === previous.sourceHash) return previous;
  const expired = !!previous?.lastCustomerMessageAt && Date.parse(evidence.observedAt) - Date.parse(previous.lastCustomerMessageAt) >= 86_400_000;
  const state = previous && evidence.observedAt === previous.observedAt && (previous.state === "UNKNOWN" || previous.state !== desired) ? "UNKNOWN" : desired;
  const epoch = previous ? previous.epoch + (previous.state !== state || expired ? 1 : 0) : 1;
  return { state, epoch, observedAt: evidence.observedAt, sourceHash: evidence.payloadSha256,
    ...(evidence.category === "PRIMARY_MESSAGE" || evidence.category === "STANDBY_MESSAGE"
      ? { lastCustomerMessageAt: evidence.observedAt } : previous?.lastCustomerMessageAt ? { lastCustomerMessageAt: previous.lastCustomerMessageAt } : {}) };
}

export function metaThreadControlBody(action: unknown, targetRole: unknown, recipient: { kind: "PHONE" | "BSUID"; value: string }, operationId: string) {
  if (typeof action !== "string" || !["take", "pass", "release"].includes(action) || (targetRole !== undefined && (action !== "pass" || !META_ROUTING_ROLES.includes(targetRole as MetaRoutingRole)))) throw new MetaRoutingError();
  const checked = peer(recipient.kind, recipient.value);
  if (!checked || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) throw new MetaRoutingError();
  return { messaging_product: "whatsapp", action, ...(recipient.kind === "BSUID" ? { recipient: checked.value } : { to: checked.value }),
    metadata: operationId, ...(targetRole === undefined ? {} : { control_pass: { target_role: targetRole } }) };
}
