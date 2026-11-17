import assert from "node:assert/strict";
import test from "node:test";
import { parseMetaThreadIntent, metaThreadActionMatches, metaThreadIntentSettled, type MetaThreadIntent } from "../lib/meta-thread-intent.ts";
import type { MetaThreadRoutingDto } from "../lib/meta-routing-contract.ts";
import { allowedPlatformProxyRoute } from "../lib/platform-proxy-routes.ts";
import { validMetaRoutingAssetId, validMetaRoutingReviewEvidence } from "../lib/meta-routing-input.ts";

const intent: MetaThreadIntent = { key: "44000000-0000-4000-8000-000000000007", body: {
  action: "pass", targetRole: "customer_service", expectedRoutingEpoch: 3, expectedConfigurationVersion: 2, expectedReviewVersion: 4,
} };
const matched = (): NonNullable<MetaThreadRoutingDto["correlation"]> & { state: "MATCHED" } => ({ state: "MATCHED",
  command: { ...intent.body }, action: { id: "55000000-0000-4000-8000-000000000007", action: "pass", targetRole: "customer_service",
    state: "SUCCEEDED", requestId: "synthetic-meta-control-receipt", reason: null, retryable: false } });

test("routing recovery preserves the exact bounded non-secret command", () => {
  assert.deepEqual(parseMetaThreadIntent(JSON.stringify(intent)), intent);
  const inputs = [null, [], {}, { ...intent, key: "" }, { ...intent, accessToken: "never-store" },
    { ...intent, body: { ...intent.body, phone: "15550123456" } },
    { ...intent, body: { ...intent.body, action: "take" } },
    { ...intent, body: { ...intent.body, targetRole: "unknown" } },
    { ...intent, body: { ...intent.body, expectedRoutingEpoch: -1 } },
    { ...intent, body: { ...intent.body, expectedRoutingEpoch: "3" } },
    { ...intent, body: { ...intent.body, expectedRoutingEpoch: Number.MAX_SAFE_INTEGER + 1 } }];
  for (const value of inputs) assert.equal(parseMetaThreadIntent(JSON.stringify(value)), null);
  assert.equal(parseMetaThreadIntent("{"), null);
  assert.equal(parseMetaThreadIntent(" ".repeat(2049)), null);
});

test("only an exact persisted terminal correlation settles a lost response", () => {
  assert.equal(metaThreadIntentSettled(intent, null), false);
  assert.equal(metaThreadIntentSettled(intent, { state: "ABSENT" }), false);
  for (const state of ["RUNNING", "OUTCOME_UNKNOWN", "SUCCEEDED", "FAILED"] as const) {
    const value = matched(); value.action.state = state;
    assert.equal(metaThreadIntentSettled(intent, value), state === "SUCCEEDED" || state === "FAILED");
  }
  for (const field of ["expectedRoutingEpoch", "expectedConfigurationVersion", "expectedReviewVersion"] as const) {
    const value = matched(); value.command[field]++;
    assert.equal(metaThreadIntentSettled(intent, value), false);
  }
  const wrongAction = matched(); wrongAction.action.action = "release";
  const wrongTarget = matched(); wrongTarget.command.targetRole = "marketing";
  const wrongReceiptTarget = matched(); wrongReceiptTarget.action.targetRole = null;
  for (const value of [wrongAction, wrongTarget, wrongReceiptTarget]) assert.equal(metaThreadIntentSettled(intent, value), false);
});

test("operator observation uses the finite existing platform proxy boundary", () => {
  const path = "operations/tenants/11000000-0000-4000-8000-000000000007/connections/12000000-0000-4000-8000-000000000007/meta-routing-review";
  assert.equal(allowedPlatformProxyRoute("GET", path), true);
  assert.equal(allowedPlatformProxyRoute("POST", path), true);
  for (const method of ["PUT", "DELETE", "PATCH"]) assert.equal(allowedPlatformProxyRoute(method, path), false);
  for (const extra of ["/control", "/../credentials", "?override=OWN"]) assert.equal(allowedPlatformProxyRoute("POST", path + extra), false);
});

test("POST and correlated reads reject missing or malformed persisted action proof", () => {
  const original = matched();
  for (const state of ["RUNNING", "OUTCOME_UNKNOWN", "SUCCEEDED", "FAILED"] as const) {
    const action = { ...original.action, state, requestId: state === "SUCCEEDED" ? "synthetic-meta-control-receipt" : null };
    assert.equal(metaThreadActionMatches(intent.body, action), true);
    assert.equal(metaThreadIntentSettled(intent, { ...original, action }), state === "SUCCEEDED" || state === "FAILED");
  }
  const missingFields = Object.keys(original.action).map(field => {
    const action: Record<string, unknown> = { ...original.action }; delete action[field]; return action;
  });
  const invalid: unknown[] = [null, [], {}, ...missingFields,
    { state: "SUCCEEDED", action: "pass", targetRole: "customer_service" },
    ...["", "not-an-id", 42].map(id => ({ ...original.action, id })),
    { ...original.action, state: "QUEUED" }, { ...original.action, action: "take" },
    { ...original.action, targetRole: "not-a-role" }, { ...original.action, targetRole: null },
    ...[{}, "", "x".repeat(513), "unsafe\nrequest"].map(requestId => ({ ...original.action, requestId })),
    { ...original.action, requestId: null },
    ...[{}, "", "lowercase", "UNKNOWN\nVALUE", "X".repeat(101)].map(reason => ({ ...original.action, reason })),
    { ...original.action, retryable: true }];
  for (const action of invalid) {
    assert.equal(metaThreadActionMatches(intent.body, action), false);
    assert.equal(metaThreadIntentSettled(intent, { ...original, action } as MetaThreadRoutingDto["correlation"]), false);
  }
  const take = { ...intent.body, action: "take" as const, targetRole: undefined };
  assert.equal(metaThreadActionMatches(take, { ...original.action, action: "take", targetRole: null }), true);
  assert.equal(metaThreadActionMatches(take, { ...original.action, action: "take", targetRole: "customer_service" }), false);
});

test("operator preflight admits exact asset and observation contract boundaries", () => {
  for (const value of ["1", "9".repeat(32)]) assert.equal(validMetaRoutingAssetId(value), true);
  for (const value of [null, 1, "", "9".repeat(33), " 1", "1x", "١٢٣"]) assert.equal(validMetaRoutingAssetId(value), false);
  const now = Date.parse("2026-10-07T12:00:00.000Z"), hash = "a".repeat(64);
  for (const reference of ["a", "a".repeat(200), "review:case/123-4_a.b"]) {
    assert.equal(validMetaRoutingReviewEvidence(now, hash, reference, now), true);
  }
  for (const observedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, now + 1]) {
    assert.equal(validMetaRoutingReviewEvidence(observedAt, hash, "review/1", now), false);
  }
  for (const reference of ["", "a".repeat(201), "review with spaces", "review?case=1", "-review", "review\n1", "مراجعة"]) {
    assert.equal(validMetaRoutingReviewEvidence(now, hash, reference, now), false);
  }
  assert.equal(validMetaRoutingReviewEvidence(now, "A".repeat(64), "review/1", now), false);
  assert.equal(validMetaRoutingReviewEvidence(1, hash, "review/1", now), true);
});
