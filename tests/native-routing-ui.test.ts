import assert from "node:assert/strict";
import test from "node:test";
import type { DepartmentDefaultPolicy, NativeRoutingSyncStatus } from "../packages/core/src/native-routing-contract.ts";
import { nativeRoutingCanRetry, nativeRoutingDefaultsValid, nativeRoutingDisplayState } from "../lib/native-routing-ui.ts";

const status: NativeRoutingSyncStatus = {
  state: "SYNCED", desiredRevision: 7, appliedRevision: 7, desiredSha256: "a".repeat(64), observedSha256: "a".repeat(64),
  lastCheckedAt: "2026-10-16T10:00:00Z", errorCode: null, safeRetry: false, departmentDefaults: [],
};
const catalog = {
  groups: [{ id: "5", name: "Finance", active: true, serviceIdentityCanCreate: true }, { id: "2", name: "Operations", active: true, serviceIdentityCanCreate: true }],
  owners: [{ id: "7", name: "Finance agent", active: true, groupIds: ["5"] }, { id: "6", name: "Fallback agent", active: true, groupIds: ["2"] }],
};
const policy: DepartmentDefaultPolicy = { id: "10000000-0000-4000-8000-000000000001", zammadGroupId: "5", zammadOwnerId: "7", enabled: true };

test("native sync labels require current matching native readback, not an HTTP success", () => {
  assert.equal(nativeRoutingDisplayState(status), "SYNCED");
  for (const change of [{ appliedRevision: 6 }, { desiredRevision: 0, appliedRevision: 0 }, { observedSha256: null }, { observedSha256: "b".repeat(64) }, { lastCheckedAt: null }]) {
    assert.equal(nativeRoutingDisplayState({ ...status, ...change }), "PENDING");
  }
  for (const state of ["UNCONFIGURED", "PENDING", "APPLYING", "DRIFT", "FAILED", "OUTCOME_UNKNOWN"] as const) {
    assert.equal(nativeRoutingDisplayState({ ...status, state }), state);
  }
});

test("generic native retry is forbidden for drift, unknown, applying and synced states even with an inconsistent safe flag", () => {
  for (const state of ["UNCONFIGURED", "APPLYING", "SYNCED", "DRIFT", "OUTCOME_UNKNOWN"] as const) {
    assert.equal(nativeRoutingCanRetry({ ...status, state, safeRetry: true }), false);
  }
  for (const state of ["PENDING", "FAILED"] as const) {
    assert.equal(nativeRoutingCanRetry({ ...status, state, safeRetry: false }), false);
    assert.equal(nativeRoutingCanRetry({ ...status, state, safeRetry: true }), true);
  }
});

test("queue default editing does not infer a policy or substitute a fallback agent", () => {
  assert.equal(nativeRoutingDefaultsValid([], catalog), true);
  assert.equal(nativeRoutingDefaultsValid([policy], catalog), true);
  assert.equal(nativeRoutingDefaultsValid([{ ...policy, zammadOwnerId: "6" }], catalog), false);
  assert.equal(nativeRoutingDefaultsValid([{ ...policy, zammadOwnerId: "" }], catalog), false);
  assert.equal(nativeRoutingDefaultsValid([{ ...policy, zammadGroupId: "" }], catalog), false);
  for (const groups of [[{ ...catalog.groups[0]!, active: false }], [{ ...catalog.groups[0]!, serviceIdentityCanCreate: false }], []]) {
    assert.equal(nativeRoutingDefaultsValid([policy], { ...catalog, groups }), false);
  }
  assert.equal(nativeRoutingDefaultsValid([policy], { ...catalog, owners: [{ ...catalog.owners[0]!, active: false }] }), false);
});

test("policies retain stable identities and permit explicit disable/removal without duplicate queues", () => {
  assert.equal(nativeRoutingDefaultsValid([{ ...policy, enabled: false }], { groups: [], owners: [] }), true);
  assert.equal(nativeRoutingDefaultsValid([policy, { ...policy, id: "another", enabled: false }], catalog), false);
  assert.equal(nativeRoutingDefaultsValid([policy, { ...policy, zammadGroupId: "2", zammadOwnerId: "6" }], catalog), false);
  assert.equal(nativeRoutingDefaultsValid(Array.from({ length: 101 }, (_, i) => ({ ...policy, id: String(i), zammadGroupId: String(i + 1), enabled: false })), catalog), false);
});
