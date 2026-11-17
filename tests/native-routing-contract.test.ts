import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalNativeRoutingManifest, parseDepartmentDefaults, parseNativeRoutingSyncCommand, serializeNativeRoutingManifest } from "../packages/core/src/native-routing-contract.ts";
import { advanceBotFlow, parseBotFlow, resolveBotHandoff } from "../packages/core/src/bot-flow.ts";

const binding = "10000000-0000-4000-8000-000000000001";
const policy = "20000000-0000-4000-8000-000000000002";
const manifest = () => ({ group_references: [{ group_id: "2", owner_ids: ["7", "10"] }, { group_id: "10", owner_ids: [] }], assignments: [{ key: `group-binding:${binding}`, source_kind: "GROUP_BINDING", source_id: binding, source_revision: "3", group_id: "2", owner_id: "7" }], department_defaults: [{ key: policy, group_id: "2", owner_id: "7", enabled: true }], client_routing: null });

test("native routing canonical manifest matches the native shared ASCII vector", () => {
  const original = manifest();
  const canonical = serializeNativeRoutingManifest(original);
  assert.equal(createHash("sha256").update(canonical).digest("hex"), "7d4b40e0810bdb3c1f1b4b3284c932df990c56eb0f7825fdbd870002fba94500");
  original.group_references.reverse(); original.group_references.find(row => row.group_id === "2")!.owner_ids.reverse();
  assert.equal(serializeNativeRoutingManifest(original), canonical);
  assert.deepEqual(canonicalNativeRoutingManifest(original).group_references.map(row => row.group_id), ["10", "2"]);
});

test("department defaults are deliberate, bounded, unique policies with no inferred owner", () => {
  assert.deepEqual(parseDepartmentDefaults([]), []);
  const value = { id: policy, zammadGroupId: "2", zammadOwnerId: "7", enabled: false };
  assert.deepEqual(parseDepartmentDefaults([value]), [value]);
  for (const invalid of [[{ ...value, zammadOwnerId: null }], [value, value], [value, { ...value, id: binding }], Array(101).fill(value), [{ ...value, enabled: 1 }], [{ ...value, admin: true }]]) assert.throws(() => parseDepartmentDefaults(invalid), /NATIVE_ROUTING_VALIDATION_ERROR/u);
});

test("sync commands require exact shapes and safe integer revision fences", () => {
  assert.deepEqual(parseNativeRoutingSyncCommand({ action: "CHECK", expectedRevision: 0 }), { action: "CHECK", expectedRevision: 0 });
  assert.deepEqual(parseNativeRoutingSyncCommand({ action: "SAVE_DEFAULTS", expectedRevision: 4, departmentDefaults: [] }), { action: "SAVE_DEFAULTS", expectedRevision: 4, departmentDefaults: [] });
  for (const value of [{ action: "APPLY", expectedRevision: 1 }, { action: "CHECK", expectedRevision: "1" }, { action: "RECONCILE", expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { action: "CHECK", expectedRevision: 1, force: true }, { action: "SAVE_DEFAULTS", expectedRevision: 1 }]) assert.throws(() => parseNativeRoutingSyncCommand(value), /NATIVE_ROUTING_VALIDATION_ERROR/u);
});

test("disabled defaults retain exact IDs without requiring a currently eligible native target", () => {
  const value = { group_references: [], assignments: [], client_routing: null, department_defaults: [{ key: policy, group_id: "2", owner_id: "7", enabled: false }] };
  assert.deepEqual(canonicalNativeRoutingManifest(value).department_defaults, value.department_defaults);
  assert.throws(() => canonicalNativeRoutingManifest({ ...value, department_defaults: [{ ...value.department_defaults[0], enabled: true }] }));
  assert.throws(() => canonicalNativeRoutingManifest({ ...value, department_defaults: [{ ...value.department_defaults[0], owner_id: "foreign" }] }));
});

test("native manifests reject arbitrary actions, unreferenced owners and ambiguous ownership keys", () => {
  assert.throws(() => serializeNativeRoutingManifest({ ...manifest(), script: "private" }), /NATIVE_ROUTING_VALIDATION_ERROR/u);
  const missing = manifest(); missing.group_references = []; assert.throws(() => serializeNativeRoutingManifest(missing));
  const owner = manifest(); owner.assignments[0]!.owner_id = "3"; assert.throws(() => serializeNativeRoutingManifest(owner));
  const duplicate = manifest(); duplicate.assignments.push(duplicate.assignments[0]!); assert.throws(() => serializeNativeRoutingManifest(duplicate));
  const unsafe = manifest(); unsafe.assignments[0]!.source_revision = "9007199254740992"; assert.throws(() => serializeNativeRoutingManifest(unsafe));
});

test("new FIXED handoff owner survives parsing/effects while omitted legacy owner stays absent", () => {
  const definition = { schemaVersion: 1, name: "Finance", start: "agent", maxSteps: 2, nodes: [{ id: "agent", type: "handoff", target: "FIXED", zammadGroupId: "5", zammadOwnerId: "7", priority: "2 normal" }] };
  const flow = parseBotFlow(definition);
  const effect = advanceBotFlow(flow, "agent").effects[0]!;
  assert.equal(effect.type, "handoff");
  if (effect.type === "handoff") assert.deepEqual(resolveBotHandoff(effect, "2", "6"), { groupId: "5", ownerId: "7" });
  const legacy = parseBotFlow({ ...definition, nodes: [{ ...definition.nodes[0], zammadOwnerId: undefined }] });
  const legacyEffect = advanceBotFlow(legacy, "agent").effects[0]!;
  if (legacyEffect.type === "handoff") assert.deepEqual(resolveBotHandoff(legacyEffect, "2", "6"), { groupId: "5" });
  for (const patch of [{ target: "CLIENT_PRIMARY" }, { zammadOwnerId: "0" }, { zammadOwnerId: "9007199254740992" }]) assert.throws(() => parseBotFlow({ ...definition, nodes: [{ ...definition.nodes[0], ...patch }] }));
});
