import { parseMetaTransitionOperatorRequest, type MetaTransitionOperatorAction, type MetaTransitionOperatorRequest, type MetaTransitionOperatorResult, type MetaTransitionOperatorReview, type MetaTransitionOperatorSummary } from "../packages/core/src/meta-transition-operator-contract.ts";
export type OperatorReviewIntent = { scope: string; tenantId: string; planId: string; key: string; action: MetaTransitionOperatorAction; request: MetaTransitionOperatorRequest };
export const operatorReviewActions = ["PREREQUISITES", "TARGET", "COMPLETION"] as const;
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 2000): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const phases = ["PREVIEW", "RESERVED", "IN_PROGRESS", "READY_TO_COMPLETE", "PROVIDER_COMPLETED", "RECONCILED_PAUSED", "CANCELLED", "HELD"];
export function operatorReviewStorageKey(scope: string, tenantId: string, planId: string) {
  if (!hex(scope) || !uuid(tenantId) || !uuid(planId)) throw Error("Invalid review context");
  return `wasalx.meta.transition-review:${scope}:${tenantId}:${planId}`;
}
export function parseOperatorReviewIntent(raw: string, scope: string, tenantId: string, planId: string): OperatorReviewIntent | null {
  try {
    if (new TextEncoder().encode(raw).byteLength > 68000) return null;
    const v: unknown = JSON.parse(raw);
    if (!object(v) || Object.keys(v).sort().join(",") !== "action,key,planId,request,scope,tenantId" || v.scope !== scope || v.tenantId !== tenantId || v.planId !== planId || !uuid(v.key) || !operatorReviewActions.includes(v.action as MetaTransitionOperatorAction)) return null;
    const action = v.action as MetaTransitionOperatorAction, request = parseMetaTransitionOperatorRequest(action, v.request);
    return request ? { scope, tenantId, planId, key: v.key, action, request } : null;
  } catch { return null; }
}
export function operatorReviewSettled(intent: OperatorReviewIntent, value: unknown): value is MetaTransitionOperatorResult {
  if (!object(value) || value.tenantId !== intent.tenantId || value.planId !== intent.planId || value.requestKey !== intent.key || value.action !== intent.action || !uuid(value.commandReceiptId) || typeof value.duplicate !== "boolean") return false;
  if (value.state === "APPLIED" ? !uuid(value.approvalReceiptId) : value.state !== "NO_EFFECT" || value.approvalReceiptId !== null) return false;
  const request = parseMetaTransitionOperatorRequest(intent.action, value.request);
  return request !== null && JSON.stringify(request) === JSON.stringify(intent.request);
}
function hasOperatorSummaryFields(v: Record<string, unknown>): boolean {
  return uuid(v.id) && text(v.name) && Number.isSafeInteger(v.revision) && Number(v.revision) > 0 && ["CUSTOMER", "WASALX_MANAGED"].includes(String(v.requestedMode)) && phases.includes(String(v.phase)) && (v.sourceCurrency === null || typeof v.sourceCurrency === "string" && /^[A-Z]{3}$/u.test(v.sourceCurrency)) && typeof v.targetCurrency === "string" && /^[A-Z]{3}$/u.test(v.targetCurrency);
}
export function isOperatorReviewSummary(v: unknown): v is MetaTransitionOperatorSummary {
  return object(v) && hasOperatorSummaryFields(v);
}
export function isOperatorReview(v: unknown, tenantId: string, planId: string): v is MetaTransitionOperatorReview {
  if (!object(v) || !hasOperatorSummaryFields(v) || v.id !== planId || v.tenantId !== tenantId || v.evidenceMode !== "SIMULATED" || !hex(v.reviewSha256)) return false;
  if (!Array.isArray(v.connectionNames) || v.connectionNames.length > 2000 || !v.connectionNames.every(x => text(x)) || !Number.isSafeInteger(v.connectionCount) || Number(v.connectionCount) < v.connectionNames.length) return false;
  if (v.providerStatus !== null && !["INITIATED", "ACCEPTED", "IN_PROGRESS", "READY_TO_COMPLETE", "COMPLETED", "FAILED", "FAILED_TO_COMPLETE", "REJECTED"].includes(String(v.providerStatus))) return false;
  if (!Array.isArray(v.checkpoints) || v.checkpoints.length > 2 || !v.checkpoints.every(x => object(x) && ["INITIATE", "COMPLETE"].includes(String(x.stage)) && ["ATTEMPTED", "UNKNOWN", "SUCCEEDED", "REJECTED"].includes(String(x.outcome)))) return false;
  const actions = v.actions;
  if (!object(actions) || !operatorReviewActions.every(a => typeof actions[a] === "boolean") || !object(v.proof)) return false;
  const options: Record<string, readonly string[]> = { sourceScope: ["CURRENT", "UNAVAILABLE"], targetAccess: ["NONE", "CLONE", "FINAL"], payment: ["VERIFIED", "UNAVAILABLE"], renewedObserver: ["CURRENT", "ABSENT", "UNAVAILABLE"], prerequisiteApproval: ["CURRENT", "MISSING"], targetReview: ["CURRENT", "MISSING"] };
  if (!Object.entries(options).every(([key, allowed]) => allowed.includes(String((v.proof as Record<string, unknown>)[key])))) return false;
  const reasons = ["PLAN_CLOSED", "SOURCE_SCOPE_UNAVAILABLE", "TARGET_READ_REQUIRED", "PAYMENT_READ_REQUIRED", "OBSERVER_RENEWAL_REQUIRED", "ORIGINAL_INITIATION_UNRESOLVED", "COMPLETE_ALREADY_ATTEMPTED", "APPROVAL_REQUIRED", "TRANSITION_BUSY"];
  if (!Array.isArray(v.reasons) || v.reasons.length > reasons.length || !v.reasons.every(x => reasons.includes(String(x)))) return false;
  if (!Array.isArray(v.arrangements) || v.arrangements.length > 100 || !v.arrangements.every(x => object(x) && uuid(x.id) && text(x.label) && typeof x.expiresAt === "string" && Number.isFinite(Date.parse(x.expiresAt)))) return false;
  if (v.originalGrant !== null) {
    if (!object(v.originalGrant) || !Object.hasOwn(v.originalGrant, "managed")) return false;
    const grant = parseMetaTransitionOperatorRequest("PREREQUISITES", { expectedRevision: v.revision, expectedReviewSha256: v.reviewSha256, evidenceSha256: v.reviewSha256, confirmed: true, sourcePayment: v.originalGrant.sourcePayment, ...(v.originalGrant.managed === null ? {} : { managed: v.originalGrant.managed }) });
    if (!grant || (v.requestedMode === "CUSTOMER" ? grant.sourcePayment !== "CARD" || grant.managed !== undefined : !grant.managed)) return false;
  }
  return Object.hasOwn(v, "pendingCommand"); // A malformed pending command never settles an intent.
}
