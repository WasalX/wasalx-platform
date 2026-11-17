import { isMetaTransitionCurrency, type MetaTransitionPreviewReason,
  type MetaTransitionPreviewRequest } from "./meta-account-transition-contract.js";

/** Worker-only normalized observations. Never accepted from a public request. */
export type MetaTransitionPreviewFacts = {
  currency: string | null;
  coexistence: "ABSENT" | "PRESENT" | "UNVERIFIED";
  authorizedAgent: "ABSENT" | "PRESENT" | "UNVERIFIED";
  adminAuthority: "VERIFIED" | "UNVERIFIED";
  providerVersion: "QUALIFIED" | "UNQUALIFIED";
  phoneInventory: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";
  externalPhoneCount: number | null;
  localScopeCurrent: boolean;
  sourceTemplatesComplete: boolean;
  managedArrangement: "CURRENT" | "STALE" | "UNAVAILABLE";
  readsAvailable: boolean;
  bindingCurrent: boolean;
};

/** A clean preview remains non-executable. Effect-time admission is a later slice. */
export function evaluateMetaTransitionPreview(request: MetaTransitionPreviewRequest,
  facts: MetaTransitionPreviewFacts): { state: "PREVIEW" | "BLOCKED"; reasons: MetaTransitionPreviewReason[]; canExecute: false } {
  const reasons: MetaTransitionPreviewReason[] = [];
  if (!facts.bindingCurrent) reasons.push("CURRENT_BINDING_CHANGED");
  if (!facts.readsAvailable) reasons.push("PROVIDER_READ_UNAVAILABLE");
  if (!isMetaTransitionCurrency(facts.currency)) reasons.push("CURRENCY_UNKNOWN");
  else if (facts.currency === request.targetCurrency) reasons.push("SAME_CURRENCY_TRANSITION_UNSUPPORTED");
  if (facts.coexistence === "PRESENT") reasons.push("COEXISTENCE_UNSUPPORTED");
  else if (facts.coexistence !== "ABSENT") reasons.push("ACCOUNT_VARIANT_UNVERIFIED");
  if (facts.authorizedAgent === "PRESENT") reasons.push("AUTHORIZED_AGENT_UNSUPPORTED");
  else if (facts.authorizedAgent !== "ABSENT" && !reasons.includes("ACCOUNT_VARIANT_UNVERIFIED")) reasons.push("ACCOUNT_VARIANT_UNVERIFIED");
  if (facts.adminAuthority !== "VERIFIED") reasons.push("ADMIN_AUTHORITY_UNVERIFIED");
  if (facts.providerVersion !== "QUALIFIED") reasons.push("PROVIDER_VERSION_UNQUALIFIED");
  if (facts.phoneInventory !== "COMPLETE" || !Number.isSafeInteger(facts.externalPhoneCount) || facts.externalPhoneCount! < 0)
    reasons.push("PHONE_SCOPE_INCOMPLETE");
  else if (facts.externalPhoneCount! > 0) reasons.push("EXTERNAL_PHONE_IMPACT");
  if (!facts.localScopeCurrent) reasons.push("LOCAL_SCOPE_CHANGED");
  if (!facts.sourceTemplatesComplete) reasons.push("TEMPLATE_INVENTORY_INCOMPLETE");
  if (request.requestedMode === "WASALX_MANAGED") {
    if (facts.managedArrangement === "STALE") reasons.push("MANAGED_ARRANGEMENT_STALE");
    else if (facts.managedArrangement !== "CURRENT") reasons.push("MANAGED_ARRANGEMENT_UNAVAILABLE");
  }
  return { state: reasons.length ? "BLOCKED" : "PREVIEW", reasons, canExecute: false };
}
