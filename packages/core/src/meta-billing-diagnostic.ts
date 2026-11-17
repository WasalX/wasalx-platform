import { createHash } from "node:crypto";
import { assertMetaCredentialProof, metaLifecyclePayloadSha256, parseMetaLifecycleState } from "./meta-account-relation.js";

export type MetaBillingDiagnosticBinding = {
  schemaVersion: 1; secretReference: string; providerSessionId: string | null;
  phoneNumberId: string | null; wabaId: string | null; proofSha256: string;
  appId: string; lifecycleRevision: number | null;
};

export function metaBillingDiagnosticBinding(secretReference: string,
  session: { id: string; opaqueSessionId: string; providerStateData: Record<string, unknown> } | undefined,
  appId: string): MetaBillingDiagnosticBinding {
  const data = session?.providerStateData ?? {};
  let lifecycleRevision: number | null;
  try { lifecycleRevision = parseMetaLifecycleState(Object.hasOwn(data, "metaLifecycle") ? data.metaLifecycle : undefined)?.revision ?? 0; }
  catch { lifecycleRevision = null; }
  return { schemaVersion: 1, secretReference, providerSessionId: session?.id ?? null,
    phoneNumberId: session?.opaqueSessionId ?? null, wabaId: typeof data.wabaId === "string" ? data.wabaId : null,
    proofSha256: metaLifecyclePayloadSha256(data.metaAccountProof ?? null), appId, lifecycleRevision };
}

export function metaBillingDiagnosticProofCurrent(binding: MetaBillingDiagnosticBinding, value: unknown,
  expected: {tenantId:string;connectionId:string;now?:Date}): boolean {
  const proof = record(value);
  try {
    return !!proof && proof.schemaVersion === 1 && proof.claim === "PHONE_ACCOUNT_RELATION_VERIFIED"
      && proof.tenantId === expected.tenantId && proof.connectionId === expected.connectionId
      && proof.secretReference === binding.secretReference && proof.providerSessionId === binding.providerSessionId
      && proof.phoneNumberId === binding.phoneNumberId && proof.wabaId === binding.wabaId
      && !!assertMetaCredentialProof(proof, {appId:binding.appId,now:expected.now});
  } catch { return false; }
}

export type MetaBillingDiagnostic = {
  schemaVersion: 1;
  paymentMethod: "PRESENT" | "NONE" | "UNAVAILABLE";
  accountOwner: "REPORTED" | "UNAVAILABLE";
  actualPayer: "UNVERIFIED";
  customerOwnership: "UNVERIFIED";
  cardVerified: false;
  checkedAt: string;
  reason: "OBSERVED" | "ACCESS_HELD" | "READ_UNAVAILABLE" | "BINDING_CHANGED";
  responseSha256?: string;
};

export function unavailableMetaBillingDiagnostic(reason: Exclude<MetaBillingDiagnostic["reason"], "OBSERVED">): MetaBillingDiagnostic {
  return { schemaVersion: 1, paymentMethod: "UNAVAILABLE", accountOwner: "UNAVAILABLE", actualPayer: "UNVERIFIED",
    customerOwnership: "UNVERIFIED", cardVerified: false, checkedAt: new Date().toISOString(), reason };
}

/** Only presence is observed. Neither field proves a card, payer or customer title. */
export function metaBillingDiagnosticFromResponses(accountId: string, ownerResponse: unknown, fundingResponse: unknown): MetaBillingDiagnostic {
  const owner = record(ownerResponse), funding = record(fundingResponse), business = record(owner?.owner_business);
  const ownerId = numericId(business?.id) && (owner?.id === undefined || owner.id === accountId) ? business.id : undefined;
  if (!funding || (funding.id !== undefined && funding.id !== accountId)
    || (funding.primary_funding_id !== undefined && (typeof funding.primary_funding_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(funding.primary_funding_id)))) {
    return unavailableMetaBillingDiagnostic("READ_UNAVAILABLE");
  }
  const primary = funding.primary_funding_id;
  return { schemaVersion: 1, paymentMethod: primary === undefined ? "NONE" : "PRESENT", accountOwner: ownerId ? "REPORTED" : "UNAVAILABLE",
    actualPayer: "UNVERIFIED", customerOwnership: "UNVERIFIED", cardVerified: false, checkedAt: new Date().toISOString(), reason: "OBSERVED",
    responseSha256: createHash("sha256").update(JSON.stringify({ accountId, ownerId: ownerId ?? null, primaryFundingId: primary ?? null })).digest("hex") };
}

/** Public projection is explicit; raw provider or financial fields never pass through. */
export function publicMetaBillingDiagnostic(value: unknown): Omit<MetaBillingDiagnostic, "responseSha256"> | null {
  const v = record(value);
  if (!v || v.schemaVersion !== 1 || !["PRESENT", "NONE", "UNAVAILABLE"].includes(String(v.paymentMethod))
    || !["REPORTED", "UNAVAILABLE"].includes(String(v.accountOwner)) || v.actualPayer !== "UNVERIFIED"
    || v.customerOwnership !== "UNVERIFIED" || v.cardVerified !== false
    || !["OBSERVED", "ACCESS_HELD", "READ_UNAVAILABLE", "BINDING_CHANGED"].includes(String(v.reason))
    || typeof v.checkedAt !== "string" || !Number.isFinite(Date.parse(v.checkedAt))) return null;
  return { schemaVersion: 1, paymentMethod: v.paymentMethod as MetaBillingDiagnostic["paymentMethod"], accountOwner: v.accountOwner as MetaBillingDiagnostic["accountOwner"],
    actualPayer: "UNVERIFIED", customerOwnership: "UNVERIFIED", cardVerified: false, checkedAt: v.checkedAt, reason: v.reason as MetaBillingDiagnostic["reason"] };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function numericId(value: unknown): value is string { return typeof value === "string" && /^[0-9]{1,32}$/u.test(value); }
