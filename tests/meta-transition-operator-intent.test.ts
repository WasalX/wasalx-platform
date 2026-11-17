import assert from "node:assert/strict";
import test from "node:test";
import { operatorReviewStorageKey, parseOperatorReviewIntent, operatorReviewSettled, isOperatorReview, type OperatorReviewIntent } from "../lib/meta-transition-operator-intent.ts";
import { platformOperatorRecoveryScope } from "../lib/platform-operator-recovery-scope.ts";
import { parseMetaTransitionOperatorRequest } from "../packages/core/src/meta-transition-operator-contract.ts";
const id = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = () => ({ expectedRevision: 3, expectedReviewSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), confirmed: true as const, sourcePayment: "CARD" as const });
const intent = (): OperatorReviewIntent => ({ scope: "c".repeat(64), tenantId: id(1), planId: id(2), key: id(3), action: "PREREQUISITES", request: body() });
const result = () => ({ tenantId: id(1), planId: id(2), requestKey: id(3), action: "PREREQUISITES", request: body(), state: "APPLIED", commandReceiptId: id(4), approvalReceiptId: id(5), duplicate: false });

test("operator recovery is scoped to issuer and authenticated subject, not tenant, email or refreshed CSRF", async () => {
  const a = await platformOperatorRecoveryScope("https://identity.example/platform", "operator-a");
  const b = await platformOperatorRecoveryScope("https://identity.example/platform", "operator-b");
  assert.equal(a, await platformOperatorRecoveryScope("https://identity.example/platform", "operator-a"));
  assert.notEqual(a, b); assert.notEqual(a, await platformOperatorRecoveryScope("https://identity.example/other", "operator-a"));
  const saved = { ...intent(), scope: a }, raw = JSON.stringify(saved);
  assert.notEqual(operatorReviewStorageKey(a, id(1), id(2)), operatorReviewStorageKey(b, id(1), id(2)));
  assert.deepEqual(parseOperatorReviewIntent(raw, a, id(1), id(2)), saved);
  assert.equal(parseOperatorReviewIntent(raw, b, id(1), id(2)), null);
  for (const [tenant, plan] of [[id(9), id(2)], [id(1), id(9)]]) assert.equal(parseOperatorReviewIntent(raw, a, tenant!, plan!), null);
});
test("only exact original command and complete terminal receipts settle a held review", () => {
  const original = intent(), success = result(); assert.equal(operatorReviewSettled(original, success), true);
  assert.equal(operatorReviewSettled(original, { ...success, state: "NO_EFFECT", approvalReceiptId: null, duplicate: true }), true);
  for (const delta of [
    { requestKey: id(9) }, { tenantId: id(9) }, { planId: id(9) }, { action: "COMPLETION" },
    { request: { ...body(), expectedRevision: 4 } }, { request: { ...body(), evidenceSha256: "f".repeat(64) } },
    { request: { ...body(), extraAuthority: true } }, { commandReceiptId: null }, { approvalReceiptId: null },
    { state: "NO_EFFECT" }, { state: "RUNNING" }, { duplicate: undefined },
  ]) assert.equal(operatorReviewSettled(original, { ...success, ...delta }), false, JSON.stringify(delta));
  assert.equal(operatorReviewSettled(original, null), false);
  // Revision growth and a bare success envelope are never correlated proof.
  assert.equal(operatorReviewSettled(original, { revision: 4, state: "APPLIED" }), false);
});
test("retained managed approval preserves every reviewed field and uses the shared byte bounds", () => {
  const managed = { arrangementVersionId: id(7), targetReceivingBusinessId: "9", targetTermsDocumentText: "الشروط المعتمدة", targetTermsVersion: "2026.10" };
  const request = parseMetaTransitionOperatorRequest("PREREQUISITES", { ...body(), sourcePayment: "LINE", managed }); assert.ok(request);
  const saved = { ...intent(), request }; assert.deepEqual(parseOperatorReviewIntent(JSON.stringify(saved), saved.scope, saved.tenantId, saved.planId), saved);
  assert.equal(operatorReviewSettled(saved, { ...result(), request }), true);
  assert.equal(operatorReviewSettled(saved, { ...result(), request: { ...request, managed: { ...managed, targetReceivingBusinessId: "8" } } }), false);
  assert.equal(parseMetaTransitionOperatorRequest("PREREQUISITES", { ...request, managed: { ...managed, targetTermsDocumentText: "ع".repeat(16385) } }), null);
  for (const raw of ["{", "[]", JSON.stringify({ ...saved, token: "forbidden" })]) assert.equal(parseOperatorReviewIntent(raw, saved.scope, saved.tenantId, saved.planId), null);
});
test("review projection validates current actor-visible capabilities without treating pending content as proof", () => {
  const view = { id: id(2), tenantId: id(1), name: "Review account", revision: 3, requestedMode: "CUSTOMER", sourceCurrency: "USD", targetCurrency: "SAR", phase: "RESERVED", evidenceMode: "SIMULATED", reviewSha256: "a".repeat(64), connectionNames: ["Connection"], connectionCount: 1, providerStatus: null, checkpoints: [], proof: { sourceScope: "CURRENT", targetAccess: "NONE", payment: "VERIFIED", renewedObserver: "ABSENT", prerequisiteApproval: "MISSING", targetReview: "MISSING" }, actions: { PREREQUISITES: true, TARGET: false, COMPLETION: false }, reasons: [], arrangements: [], originalGrant: null, pendingCommand: null };
  assert.equal(isOperatorReview(view, id(1), id(2)), true);
  for (const delta of [{ tenantId: id(8) }, { id: id(8) }, { evidenceMode: "LIVE" }, { actions: { ...view.actions, TARGET: "yes" } }, { proof: { ...view.proof, payment: "ASSUMED" } }, { originalGrant: { sourcePayment: "LINE", managed: null } }]) assert.equal(isOperatorReview({ ...view, ...delta }, id(1), id(2)), false);
  assert.equal(isOperatorReview({ ...view, pendingCommand: { state: "APPLIED" } }, id(1), id(2)), true);
  assert.equal(operatorReviewSettled(intent(), { state: "APPLIED" }), false);
});
