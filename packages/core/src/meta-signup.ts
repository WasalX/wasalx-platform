export type * from "./meta-signup-contract.js";
import type { MetaSignupChoice, MetaSignupReason, MetaSignupVariant } from "./meta-signup-contract.js";

/** One purpose-aware admission rule; provider-derived facts never become caller claims. */
export function metaSignupChoiceAdmission(choice: Pick<MetaSignupChoice, "mode" | "numberState"> & { phoneId: string; wabaId: string }, target?: { phoneNumberId: string; wabaId: string; coexistence?: { contextId: string } }, purpose: "NEW_NUMBER" | "RECONNECT" | "ADD_ACCESS" | "TRANSITION_READBACK" | "LEGACY_MIGRATION" = target ? "RECONNECT" : "NEW_NUMBER", variant: MetaSignupVariant = "STANDARD"): { selectable: boolean; reasonCode?: MetaSignupReason } {
  if ((["RECONNECT", "TRANSITION_READBACK", "LEGACY_MIGRATION"].includes(purpose)) !== !!target) return { selectable: false, reasonCode: "META_SIGNUP_ASSET_CONFLICT" };
  if (target && (choice.phoneId !== target.phoneNumberId || choice.wabaId !== target.wabaId)) return { selectable: false, reasonCode: "META_SIGNUP_ASSET_CONFLICT" };
  if (choice.mode === "COEXISTENCE") return ((variant === "BUSINESS_APP" && purpose === "NEW_NUMBER" && !target)
    || (variant === "STANDARD" && purpose === "RECONNECT" && !!target?.coexistence?.contextId)) && choice.numberState === "REGISTERED"
    ? { selectable: true } : { selectable: false, reasonCode: "META_SIGNUP_COEXISTENCE_REQUIRED" };
  if (choice.mode !== "STANDARD") return { selectable: false, reasonCode: "META_SIGNUP_MODE_UNKNOWN" };
  // Readback-only access never grants registration or messaging authority.
  if (purpose === "TRANSITION_READBACK" || purpose === "LEGACY_MIGRATION") return { selectable: true };
  if (variant === "STANDARD" && !target?.coexistence && choice.numberState === (purpose === "NEW_NUMBER" ? "REGISTRATION_REQUIRED" : "REGISTERED")) return { selectable: true };
  return { selectable: false, reasonCode: purpose === "NEW_NUMBER" && ["REGISTERED", "ACTION_REQUIRED"].includes(choice.numberState) ? "META_SIGNUP_EXISTING_NUMBER_REVIEW" : "META_SIGNUP_PHONE_UNVERIFIED" };
}
/** Provider facts used by signup admission and leased activation. Missing facts are unknown. */
export type MetaSignupPhone = {
  id: string;
  mode: "STANDARD" | "COEXISTENCE" | "UNKNOWN";
  numberState: "REGISTRATION_REQUIRED" | "REGISTERED" | "ACTION_REQUIRED" | "UNKNOWN";
};

export function metaSignupPhone(value: unknown, expectedId: string): MetaSignupPhone {
  const phone = object(value);
  const result: MetaSignupPhone = { id: expectedId, mode: "UNKNOWN", numberState: "UNKNOWN" };
  if (!metaId(expectedId) || phone?.id !== expectedId) return result;
  const cloud = phone.platform_type === "CLOUD_API" && phone.host_platform === "CLOUD_API";
  if (typeof phone.is_on_biz_app !== "boolean" || !cloud || phone.account_mode !== "LIVE") return result;
  result.mode = phone.is_on_biz_app ? "COEXISTENCE" : "STANDARD";
  if (phone.status === "CONNECTED") result.numberState = "REGISTERED";
  else if (phone.status === "PENDING" && phone.code_verification_status === "VERIFIED" && result.mode === "STANDARD") {
    result.numberState = "REGISTRATION_REQUIRED";
  } else if (["BANNED", "DELETED", "DISCONNECTED", "FLAGGED", "MIGRATED", "RATE_LIMITED", "RESTRICTED"].includes(String(phone.status))) {
    result.numberState = "ACTION_REQUIRED";
  }
  return result;
}

/** These are candidates, not new grants or ownership proof. Never select the first entry. */
export function metaSignupGrantCandidates(debugToken: unknown): { userId?: string; accountIds: string[] } {
  const data = object(object(debugToken)?.data);
  const result: { userId?: string; accountIds: string[] } = { accountIds: [] };
  if (!data) return result;
  if (metaId(data.user_id)) result.userId = data.user_id;
  if (!Array.isArray(data.granular_scopes) || data.granular_scopes.length > 100) return result;
  const grants = new Map<string, string[]>();
  for (const item of data.granular_scopes) {
    const row = object(item);
    if (!row || !["whatsapp_business_management", "whatsapp_business_messaging"].includes(String(row.scope))) continue;
    if (grants.has(String(row.scope)) || !Array.isArray(row.target_ids) || row.target_ids.length > 100
      || row.target_ids.some(id => !metaId(id))) return { ...result, accountIds: [] };
    grants.set(String(row.scope), [...new Set(row.target_ids as string[])]);
  }
  const management = grants.get("whatsapp_business_management");
  const messaging = grants.get("whatsapp_business_messaging");
  result.accountIds = management && messaging ? management.filter(id => messaging.includes(id)) : management ?? messaging ?? [];
  return result;
}

export function metaSignupHealth(value: unknown, expected: { phoneId: string; wabaId: string; appId: string }) {
  const health = object(object(value)?.health_status);
  const entities = health?.entities;
  if (!Array.isArray(entities) || entities.length > 100) return "UNKNOWN" as const;
  for (const [kind, id] of [["PHONE_NUMBER", expected.phoneId], ["WABA", expected.wabaId], ["APP", expected.appId]]) {
    const matches = entities.filter(item => object(item)?.entity_type === kind);
    if (matches.length !== 1 || object(matches[0])?.id !== id) return "UNKNOWN" as const;
  }
  const statuses = entities.map(item => object(item)?.can_send_message);
  if (!statuses.every(status => ["AVAILABLE", "LIMITED", "BLOCKED"].includes(String(status)))) return "UNKNOWN" as const;
  const aggregate = statuses.includes("BLOCKED") ? "BLOCKED" : statuses.includes("LIMITED") ? "LIMITED" : "AVAILABLE";
  return health?.can_send_message === aggregate ? aggregate : "UNKNOWN" as const;
}

export function metaId(value: unknown): value is string { return typeof value === "string" && /^\d{5,32}$/u.test(value); }
export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
