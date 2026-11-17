import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { draftSupportQueues } from "../lib/client-routing-draft.ts";

test("a new routing draft carries support queues forward from the active version", () => {
  assert.deepEqual(draftSupportQueues({ baseIds: ["2", "4"], baseIsActive: true, activeIds: ["2", "4"], eligibleIds: ["2", "3", "4"] }), { ids: ["2", "4"], origin: "active" });
  assert.deepEqual(draftSupportQueues({ baseIds: [], baseIsActive: false, activeIds: ["3"], eligibleIds: ["2", "3"] }), { ids: ["3"], origin: "active" }, "a starter or queue-less copy still inherits the active queues");
  assert.deepEqual(draftSupportQueues({ baseIds: ["4"], baseIsActive: false, activeIds: ["2"], eligibleIds: ["2", "4"] }), { ids: ["2"], origin: "active" }, "the active scope governs new drafts, not a selected draft");
});

test("without an active version only a single eligible queue is preselected", () => {
  assert.deepEqual(draftSupportQueues({ baseIds: undefined, baseIsActive: false, activeIds: undefined, eligibleIds: ["7"] }), { ids: ["7"], origin: "single" });
  assert.deepEqual(draftSupportQueues({ baseIds: undefined, baseIsActive: false, activeIds: undefined, eligibleIds: ["7", "8"] }), { ids: [], origin: null });
  assert.deepEqual(draftSupportQueues({ baseIds: [], baseIsActive: false, activeIds: [], eligibleIds: ['7'] }), { ids: [], origin: 'active' });
  assert.deepEqual(draftSupportQueues({ baseIds: [], baseIsActive: false, activeIds: undefined, hasActiveVersion:true, eligibleIds: ['7'] }), { ids: [], origin: 'active' });
});

test("the routing editor shows where preselected queues came from and activation still warns when empty", async () => {
  const source = await readFile(new URL("../app/ClientRouting.tsx", import.meta.url), "utf8");
  assert.match(source, /draftSupportQueues\(\{/u);
  assert.match(source, /routing\.editor\.supportFromActive/u);
  assert.match(source, /routing\.editor\.supportSingle/u);
  assert.match(source, /routing\.activation\.noSupportEntries/u);
  const english = await readFile(new URL("../lib/i18n/messages/en/automation.ts", import.meta.url), "utf8");
  assert.match(english, /"routing\.editor\.supportFromActive": "Carried over from active version\./u);
});
