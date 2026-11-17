import { createHash } from "node:crypto";

export const META_PRICING_MODELS = ["PMP", "CBP"] as const;
export const META_PRICING_CATEGORIES = ["marketing", "utility", "authentication", "service", "referral_conversion", "general_purpose_ai"] as const;
export const META_PRICING_TYPES = ["regular", "free_customer_service", "free_entry_point"] as const;
export type MetaPricingObservation = {
  version: 1;
  state: "ABSENT" | "VALID" | "UNAVAILABLE";
  reason: "SHAPE" | "SIZE" | "FIELDS" | "VALUE" | null;
  model: typeof META_PRICING_MODELS[number] | null;
  category: typeof META_PRICING_CATEGORIES[number] | null;
  type: typeof META_PRICING_TYPES[number] | null;
  billable: boolean | null;
  /** Signed envelope context only. Neither ID proves a charged account or payer. */
  observedEnvelopeAccountId: string | null;
  observedPhoneNumberId: string | null;
  /** Observation revision, never a charge identity or a monetary amount. */
  revisionSha256: string;
};

// Both ingress and normalization use this projection. Unsupported provider values
// survive only in the digest; they must not become safe metadata or public errors.
export function metaPricingObservation(status: { pricing?: unknown }, accountId?: unknown, phoneId?: unknown): MetaPricingObservation {
  const present = Object.hasOwn(status, "pricing");
  const pricing = present ? status.pricing : null;
  const observedEnvelopeAccountId = observedId(accountId);
  const observedPhoneNumberId = observedId(phoneId);
  const observation: MetaPricingObservation = {
    version: 1, state: present ? "UNAVAILABLE" : "ABSENT", reason: null,
    model: null, category: null, type: null, billable: null,
    observedEnvelopeAccountId, observedPhoneNumberId,
    revisionSha256: metaStatusPayloadSha256({ version: 1, present, pricing, observedEnvelopeAccountId, observedPhoneNumberId }),
  };
  if (!present) return observation;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return { ...observation, reason: "SHAPE" };
  const fields = pricing as Record<string, unknown>;
  if (Object.keys(fields).length > 32 || Object.entries(fields).some(([key, value]) => key.length > 64 || (typeof value === "string" && value.length > 4096))) return { ...observation, reason: "SIZE" };
  if (Object.keys(fields).sort().join(",") !== "billable,category,pricing_model,type") return { ...observation, reason: "FIELDS" };
  if (!includes(META_PRICING_MODELS, fields.pricing_model) || !includes(META_PRICING_CATEGORIES, fields.category)
    || !includes(META_PRICING_TYPES, fields.type) || typeof fields.billable !== "boolean") return { ...observation, reason: "VALUE" };
  return { ...observation, state: "VALID", model: fields.pricing_model, category: fields.category, type: fields.type, billable: fields.billable };
}

function observedId(value: unknown): string | null { return typeof value === "string" && /^[0-9]{1,32}$/u.test(value) ? value : null; }
function includes<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === "string" && values.includes(value as T); }

// Status JSON is already bounded by the signed webhook body limit. An iterative
// canonical hash also handles deeply nested unsupported pricing without losing an
// otherwise valid delivery status. Raw-body HMAC verification is unchanged.
export function metaStatusPayloadSha256(value: unknown): string {
  const hash = createHash("sha256");
  const pending: Array<{ value: unknown } | { token: string }> = [{ value }];
  let size = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if ("token" in next) { size += next.token.length; if (size > 3_000_000) throw new Error("Meta status payload exceeds its bound"); hash.update(next.token); continue; }
    const item = next.value;
    if (item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) pending.push({ token: JSON.stringify(item) });
    else if (Array.isArray(item)) {
      pending.push({ token: "]" });
      for (let index = item.length - 1; index >= 0; index--) { pending.push({ value: item[index] }); if (index) pending.push({ token: "," }); }
      pending.push({ token: "[" });
    } else if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const object = item as Record<string, unknown>, keys = Object.keys(object).sort();
      pending.push({ token: "}" });
      for (let index = keys.length - 1; index >= 0; index--) { const key = keys[index]!; pending.push({ value: object[key] }, { token: ":" }, { token: JSON.stringify(key) }); if (index) pending.push({ token: "," }); }
      pending.push({ token: "{" });
    } else throw new Error("Meta status payload must be JSON");
  }
  return hash.digest("hex");
}
