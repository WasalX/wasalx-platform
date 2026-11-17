import assert from "node:assert/strict";
import test from "node:test";
import { clientRoutingQueueWarnings } from "../lib/client-routing-availability.ts";
import type { ClientRoutingDefinition } from "../packages/core/src/client-routing.ts";

const definition: ClientRoutingDefinition = {
  schemaVersion: 1, name: "Synthetic routing", supportGroupIds: ["2", "5"], fallback: { zammadGroupId: "2" }, sources: [],
  clients: [{ id: "synthetic", name: "Synthetic client", routeSourceId: "manual", zammadGroupId: "7", escalationGroupId: "9", matchers: [] }],
};
const groups = [
  { id: "2", name: "Operations", active: true, serviceIdentityCanCreate: true },
  { id: "5", name: "Support", active: true, serviceIdentityCanCreate: true },
  { id: "7", name: "Finance", active: true, serviceIdentityCanCreate: true },
  { id: "9", name: "Escalation", active: true, serviceIdentityCanCreate: true },
];

test("routing availability checks entry, fallback, client and escalation queues without replacing saved references", () => {
  const before = structuredClone(definition);
  Object.freeze(definition.supportGroupIds);
  Object.freeze(definition.fallback);
  Object.freeze(definition.clients[0]);
  Object.freeze(definition.clients);
  Object.freeze(definition);
  const changed = groups.filter(group => group.id !== "9").map(group => ({
    ...group, active: group.id !== "2", serviceIdentityCanCreate: group.id !== "7",
  }));
  assert.deepEqual(clientRoutingQueueWarnings(definition, changed), [
    { id: "2", name: "Operations", reasons: ["inactive"] },
    { id: "7", name: "Finance", reasons: ["noServiceAccess"] },
    { id: "9", name: undefined, reasons: ["unavailable"] },
  ]);
  assert.deepEqual(definition, before);
});

test("routing availability reflects rename, combined problems and restoration from the current catalog", () => {
  assert.deepEqual(clientRoutingQueueWarnings(definition, groups), []);
  const unavailable = groups.map(group => group.id === "2"
    ? { ...group, name: "Renamed operations", active: false, serviceIdentityCanCreate: false } : group);
  assert.deepEqual(clientRoutingQueueWarnings(definition, unavailable), [
    { id: "2", name: "Renamed operations", reasons: ["inactive", "noServiceAccess"] },
  ]);
  assert.deepEqual(clientRoutingQueueWarnings(definition, groups), []);
  assert.equal(clientRoutingQueueWarnings(definition, []).length, 4, "duplicate references produce one warning per queue");
});

test("legacy absent support scope and absent escalation do not invent queue references", () => {
  const legacy = { ...definition };
  delete legacy.supportGroupIds;
  assert.deepEqual(clientRoutingQueueWarnings({ ...legacy, clients: [] }, []), [
    { id: "2", name: undefined, reasons: ["unavailable"] },
  ]);
});
