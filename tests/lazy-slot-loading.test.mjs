import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("lazy slots in panels, drawers and dialogs use a compact, accurately labelled loading state", async () => {
  const [source, english, arabic] = await Promise.all([
    read("app/WasalXApp.tsx"),
    read("lib/i18n/messages/en/tenant.ts"),
    read("lib/i18n/messages/ar/tenant.ts"),
  ]);
  const views = ["BotAutomation", "PluginCatalog", "ClientRouting", "InboxWorkspace", "CaseLifecycle"];
  const wrapped = (fallback) => [...source.matchAll(new RegExp(String.raw`<Suspense fallback=\{<${fallback} />\}>\s*(?:\{[^<]*)?<(\w+)`, "gu"))].map((match) => match[1]);
  assert.deepEqual(wrapped("WorkspaceLoading"), views, "WorkspaceLoading is only for whole views");
  const slots = wrapped("SectionLoading");
  for (const slot of ["MetaCostUsage", "SupportTeams", "MailboxAdministration", "ConnectedDataServices", "MetaNumberRelease", "MetaTemplatePreparation", "MetaSignup", "NativeRoutingSync", "WorkspaceAccess"]) {
    assert.ok(slots.includes(slot), `${slot} must load with the compact SectionLoading state`);
  }
  assert.equal(slots.filter((slot) => slot === "MetaSignup").length, 2, "the reconnect section and the add-connection dialog both stay compact");
  assert.match(source, /function SectionLoading\(\) \{[\s\S]*?className="review-loading compact" role="status" aria-live="polite" aria-busy="true"[\s\S]*?t\("tenant\.loading\.section"\)/u);
  assert.match(english, /"tenant\.loading\.section": "Loading this section…"/u);
  assert.match(arabic, /"tenant\.loading\.section": "جارٍ تحميل هذا القسم…"/u);
});
