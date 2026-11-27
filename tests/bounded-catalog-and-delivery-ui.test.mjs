import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("automation and routing use bounded catalogs with on-demand details", async () => {
  const [automation, routing] = await Promise.all([
    source("app/BotAutomation.tsx"),
    source("app/ClientRouting.tsx"),
  ]);
  assert.match(automation, /\/api\/bot-flows\/catalog\?limit=25/);
  assert.match(automation, /\/api\/bot-flows\/actions\/catalog\?limit=50/);
  assert.match(automation, /\/api\/bot-flows\/\$\{encodeURIComponent\(selectedId\)\}/);
  assert.match(automation, /\/api\/bot-flows\/actions\/\$\{encodeURIComponent\(String\(row\.action_key\)\)\}/);
  assert.doesNotMatch(automation, /fetch\("\/api\/bot-flows", \{ cache: "no-store", signal \}\)/);
  assert.match(routing, /\/api\/client-routing\/catalog\$\{query\}/);
  assert.match(routing, /\/api\/client-routing\/\$\{encodeURIComponent\(selectedId\)\}/);
  assert.doesNotMatch(routing, /fetch\("\/api\/client-routing", \{ cache: "no-store" \}\)/);
});

test("direct assignment attribution is revision fenced", async () => {
  const automation = await source("app/BotAutomation.tsx");
  assert.match(automation, /assignments\/\$\{encodeURIComponent\(String\(attributionTarget\.id\)\)\}\/attribution/);
  assert.match(automation, /agentPrefix: agentPrefix\.trim\(\)/);
  assert.match(automation, /agentIdentityPlacement/);
  assert.match(automation, /expectedRevision: Number\(attributionTarget\.revision\)/);
});

test("delivery rows and details render only projected hold metadata", async () => {
  const [portal, english, arabic] = await Promise.all([
    readTenantPortalSource(),
    source("lib/i18n/messages/en/tenant.ts"),
    source("lib/i18n/messages/ar/tenant.ts"),
  ]);
  assert.match(portal, /row\.hold_reason \? <DeliveryHoldSummary/);
  assert.match(portal, /detail\.hold_reason/);
  assert.match(portal, /row\.available_at\?\?row\.delivery_next_attempt_at/);
  assert.match(portal, /row\.hold_expires_at\?\?row\.delivery_hold_expires_at/);
  for (const messages of [english, arabic]) {
    assert.match(messages, /tenant\.deliveries\.hold\.reason\.waiting_for_inbound/);
    assert.match(messages, /tenant\.deliveries\.hold\.nextAttempt/);
    assert.match(messages, /tenant\.deliveries\.hold\.expires/);
  }
});
