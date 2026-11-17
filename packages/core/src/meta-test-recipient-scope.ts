import { parseMetaDirectIdentity } from "./meta-direct-identity.js";
import { normalizeMetaDisplayPhoneNumber } from "./meta-account-relation.js";
import type { CoexistenceUnit } from "./meta-coexistence.js";
import type { MetaRoutingEvidence } from "./meta-routing.js";
import { metaPricingObservation, metaStatusPayloadSha256 } from "./meta-pricing-observation.js";
import { wahaTestRecipientAllowed, type WahaTestRecipientAllowlist } from "./waha-test-recipient-scope.js";

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:=+@-]{1,512}$/u.test(value);

/** A Graph group ID or opaque user ID must never be guessed to be a phone. */
export function metaTestPhoneAllowed(scope: WahaTestRecipientAllowlist, phone: unknown): boolean {
  return scope === undefined || (typeof phone === "string" && /^[1-9][0-9]{2,14}$/u.test(phone) && wahaTestRecipientAllowed(scope, phone));
}

export function metaTestSendAllowed(scope: WahaTestRecipientAllowlist, body: unknown): boolean {
  if (scope === undefined) return true;
  const value = record(body);
  return value?.recipient_type === "individual" && !["recipient", "group_id", "recipient_user_id", "recipient_parent_user_id"].some(key => Object.hasOwn(value, key)) && metaTestPhoneAllowed(scope, value.to);
}

/** Only a server-side conversation lookup may authorize this exclusive wire shape. */
export function metaTestBsuidRecipient(body: unknown): string | undefined {
  const value = record(body);
  return value?.recipient_type === "individual" && typeof value.recipient === "string"
    && /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/u.test(value.recipient)
    && !["to", "group_id", "recipient_user_id", "recipient_parent_user_id"].some(key => Object.hasOwn(value, key))
    ? value.recipient : undefined;
}

/** Run only after raw-body HMAC verification, before an inbox/raw payload write.
 * The original unit remains a digest; projected bytes get their own inbox hash.
 * Split before ordinary parsing so an excluded malformed neighbor cannot erase a hold. */
export function metaTestWebhookUnits(scope: WahaTestRecipientAllowlist, value: Record<string, unknown>, now = Date.now(), linkedStatusAllowed?: (status: Record<string, unknown>) => boolean): { values: Record<string, unknown>[]; dropped: number } {
  if (scope === undefined) return { values: [value], dropped: 0 };
  if (scope.size === 0) return { values: [], dropped: (Array.isArray(value.messages) ? value.messages.length : 0) + (Array.isArray(value.statuses) ? value.statuses.length : 0) };
  const metadata = record(value.metadata);
  const displayPhone = normalizeMetaDisplayPhoneNumber(metadata?.display_phone_number);
  const groupEnvelope = Object.hasOwn(value, "group_id") || (metadata !== undefined && Object.hasOwn(metadata, "group_id"));
  const base = { ...(value.messaging_product === "whatsapp" ? { messaging_product: "whatsapp" } : {}), metadata: {
    phone_number_id: metadata?.phone_number_id,
    ...(displayPhone === undefined ? {} : { display_phone_number: displayPhone }),
  } };
  const values: Record<string, unknown>[] = [];
  let dropped = 0;
  const sourceBase = { ...value };
  delete sourceBase.messages;
  delete sourceBase.statuses;
  delete sourceBase.errors;
  const fresh = (item: Record<string, unknown>) => {
    const seconds = Number(item.timestamp), current = Math.floor(now / 1000);
    return identifier(item.id) && typeof item.timestamp === "string" && /^\d{1,12}$/u.test(item.timestamp)
      && Number.isSafeInteger(seconds) && seconds >= current - 7 * 86400 && seconds <= current + 300;
  };
  for (const raw of Array.isArray(value.messages) ? value.messages : []) {
    const message = record(raw);
    if (!message) { dropped++; continue; }
    if (message.type === "system") {
      const source = metaStatusPayloadSha256({ ...sourceBase, messages: [message] });
      // No old/new identity or system body survives. This deliberately yields an
      // ASSET hold, never a valid transition/alias or an automatic activation.
      values.push({ ...base, test_recipient_source_sha256: source, messages: [{
        id: identifier(message.id) ? message.id : `guarded-identity:${source}`, type: "system",
      }] });
      continue;
    }
    if (groupEnvelope || Object.hasOwn(message, "group_id") || (message.recipient_type !== undefined && message.recipient_type !== "individual")
      || !fresh(message) || message.type === "contacts" || Object.hasOwn(message, "history_context")
      || ["history", "state_sync", "message_echoes"].some(key => Object.hasOwn(value, key))) { dropped++; continue; }
    try {
      const parsed = parseMetaDirectIdentity(message, value.contacts);
      const context = record(message.context);
      if (!metaTestPhoneAllowed(scope, parsed.identity.phone)
        || (context?.from !== undefined && context.from !== parsed.identity.phone)) { dropped++; continue; }
      const projected: Record<string, unknown> = {};
      for (const key of ["id", "timestamp", "type", "from", "from_user_id", "from_parent_user_id", "context", "text", "image", "video", "audio", "document", "sticker", "interactive", "button", "reaction", "location"])
        if (Object.hasOwn(message, key)) projected[key] = message[key];
      const contact = parsed.contactIndex === undefined ? undefined : record((value.contacts as unknown[])[parsed.contactIndex]);
      // Only the identity-matched contact can carry a display name. No neighboring roster.
      const profile = record(contact?.profile);
      const contacts = contact === undefined ? undefined : [{
        ...Object.fromEntries(["wa_id", "user_id", "parent_user_id"].filter(key => Object.hasOwn(contact, key)).map(key => [key, contact[key]])),
        ...(typeof profile?.name === "string" && profile.name.length <= 256 ? { profile: { name: profile.name } } : {}),
      }];
      const source = metaStatusPayloadSha256({ ...sourceBase, messages: [message] });
      values.push({ ...base, test_recipient_source_sha256: source, ...(contacts ? { contacts } : {}), messages: [projected] });
    } catch { dropped++; }
  }
  for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
    const status = record(raw);
    const linked = status !== undefined && linkedStatusAllowed?.(status) === true;
    if (!status || groupEnvelope || !fresh(status) || !identifier(status.status)
      || (status.recipient_type !== undefined && status.recipient_type !== "individual")
      || ["group_id", "recipient", "recipient_parent_user_id"].some(key => Object.hasOwn(status, key))
      || (!linked && (!metaTestPhoneAllowed(scope, status.recipient_id) || Object.hasOwn(status, "recipient_user_id")))) { dropped++; continue; }
    const projected: Record<string, unknown> = { id: status.id, timestamp: status.timestamp, status: status.status,
      ...(status.recipient_id === undefined ? {} : { recipient_id: status.recipient_id }),
      ...(linked ? { recipient_user_id: status.recipient_user_id } : {}) };
    if (Object.hasOwn(status, "pricing")) {
      const observation = metaPricingObservation(status);
      // Unsupported pricing must remain unavailable, never become valid by
      // stripping an unknown field. Its original shape survives only as a digest.
      projected.pricing = observation.state === "VALID" ? { billable: observation.billable, pricing_model: observation.model, category: observation.category, type: observation.type }
        : { test_recipient_source_sha256: metaStatusPayloadSha256(status.pricing) };
    }
    if (Array.isArray(status.errors)) projected.errors = status.errors.flatMap(error => {
      const code = record(error)?.code;
      return typeof code === "number" && Number.isSafeInteger(code) && code >= 0 ? [{ code }] : [];
    });
    values.push({ ...base, test_recipient_source_sha256: metaStatusPayloadSha256({ ...sourceBase, statuses: [status] }), statuses: [projected] });
  }
  // Existing ingress strips provider error text; account-wide errors have no chat target.
  if (Array.isArray(value.errors) && value.errors.length) values.push({ ...base, errors: value.errors });
  return { values, dropped };
}

export function metaTestCoexistenceUnit(scope: WahaTestRecipientAllowlist, unit: CoexistenceUnit): CoexistenceUnit | null {
  if (scope === undefined) return unit;
  const messages = unit.messages.filter(item => metaTestPhoneAllowed(scope, item.subject) && item.type !== "contacts");
  const contacts = unit.contacts.filter(item => metaTestPhoneAllowed(scope, item.subject));
  return messages.length || contacts.length || unit.kind === "DECLINED" ? { ...unit, messages, contacts } : null;
}

/** Preserve signed negative applicability without persisting an excluded chat. */
export function metaTestRoutingEvidence(scope: WahaTestRecipientAllowlist, evidence: MetaRoutingEvidence): MetaRoutingEvidence | null {
  if (scope === undefined || (evidence.peer?.kind === "PHONE" && metaTestPhoneAllowed(scope, evidence.peer.value))) return evidence;
  if (!["STANDBY_MESSAGE", "CONTROL_TAKEN", "UNRESOLVED_ROUTING"].includes(evidence.category)) return null;
  const asset = { ...evidence };
  delete asset.peer;
  return { ...asset, category: "UNRESOLVED_ROUTING" };
}

/** Classification is validated on the original signed value before this projection.
 * Keep only documented account/asset facts; unknown content survives only as a digest. */
export function metaTestLifecycleValue(scope: WahaTestRecipientAllowlist, value: Record<string, unknown>): Record<string, unknown> {
  if (scope === undefined) return value;
  const result: Record<string, unknown> = { event: value.event, test_recipient_source_sha256: metaStatusPayloadSha256(value) };
  if (Object.hasOwn(value, "phone_number")) result.phone_number = value.phone_number;
  for (const [key, fields, relevant] of [["ban_info", ["waba_ban_state"], value.event === "DISABLED_UPDATE"], ["waba_info", ["waba_id", "partner_app_id"], typeof value.event === "string" && value.event.startsWith("PARTNER_")]] as const) {
    const item = record(value[key]);
    if (relevant && item) result[key] = Object.fromEntries(fields.filter(field => typeof item[field] === "string" && (field === "waba_ban_state" ? ["DISABLE", "SCHEDULE_FOR_DISABLE", "REINSTATE"].includes(item[field]) : /^[0-9]{1,32}$/u.test(item[field]))).map(field => [field, item[field]]));
  }
  if (value.event === "ACCOUNT_RESTRICTION" && Array.isArray(value.restriction_info)) result.restriction_info = value.restriction_info.map(item => ({ restriction_type: record(item)?.restriction_type }));
  return result;
}
