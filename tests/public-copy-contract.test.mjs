import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tenantPortalFiles } from "./helpers/tenant-portal-source.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("focused marketing skip link keeps contrasting foreground above the anchor reset", async () => {
  const css = await read("app/marketing.css");
  assert.match(css, /\.marketing-shell \.marketing-skip\s*\{[^}]*background: var\(--text\);\s*color: var\(--bg\);/u);
});

const tenantFacingFiles = [
  ...tenantPortalFiles,
  "app/BotAutomation.tsx",
  "app/CaseLifecycle.tsx",
  "app/ClientRouting.tsx",
  "app/layout.tsx",
  "lib/backend.ts",
  "lib/i18n/messages/en/marketing.ts",
  "lib/i18n/messages/ar/marketing.ts",
];

test("tenant-facing copy uses WasalX customer language", async () => {
  const source = (await Promise.all(tenantFacingFiles.map(read))).join("\n");
  const forbiddenPublicCopy = [
    /\bPILOT\b/u,
    /Fixture preview/iu,
    /Synthetic private demo/iu,
    /private WAHA worker/iu,
    /WAHA engine/iu,
    /recommended GOWS engine/iu,
    /NOWEB compatibility engine/iu,
    /Zammad-grade/iu,
    /Zammad (?:workspace|ticket|group|case|route|calendar|SLA|destination|user)/iu,
    /Delivery outbox/iu,
    /managed control plane/iu,
    /RULE SNAPSHOT/iu,
    /idempotency key/iu,
    /Worker stage/iu,
    /Request ID/iu,
    /Webhook route/iu,
    /Provider state/iu,
  ];
  for (const pattern of forbiddenPublicCopy) {
    assert.doesNotMatch(source, pattern, `public source contains ${pattern}`);
  }
  assert.doesNotMatch(source, />\s*(?:PILOT|WAHA|GOWS|NOWEB)\s*</iu);
  const dataBoundaries = await Promise.all(["lib/control-plane-data.ts", "lib/data.ts", "lib/fixture-data.ts"].map(read));
  for (const boundary of dataBoundaries) assert.doesNotMatch(boundary, /Pending verification/u);
});

test("public health response exposes no dependency inventory", async () => {
  const source = await read("app/api/health/route.ts");
  assert.doesNotMatch(source, /\bchecks\s*:/u);
  assert.doesNotMatch(source, /(?:latency_ms|secret_manager|control_api|session_store)\s*:/u);
  assert.match(source, /status:ready\?"operational":"failed",timestamp:/u);
});

test("public metadata describes WasalX without implementation vendors", async () => {
  const [source, messages] = await Promise.all([
    read("app/layout.tsx"),
    read("lib/i18n/messages/en/common.ts"),
  ]);
  assert.match(source, /translate\("common\.metadata\.defaultTitle"\)/u);
  assert.match(source, /translate\("common\.metadata\.description"\)/u);
  assert.match(messages, /"common\.metadata\.defaultTitle": "WasalX — Connected support operations"/u);
  const metadataMessages = messages
    .split("\n")
    .filter((line) => line.includes('"common.metadata.'))
    .join("\n");
  assert.doesNotMatch(metadataMessages, /Zammad|WAHA|GOWS|NOWEB/iu);
});

test("public mobile controls keep a 44px coarse-pointer target without changing desktop density", async () => {
  const [page, css] = await Promise.all([read("app/page.tsx"), read("app/marketing.css")]);
  for (const className of [
    "marketing-brand",
    "marketing-header-actions",
    "marketing-hero-actions",
    "marketing-close",
  ]) assert.match(page, new RegExp(`className="${className}(?:\\s|")`, "u"));
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"), css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const selector of [
    ".marketing-brand",
    ".marketing-header-actions button",
    ".marketing-header-actions .wx-button",
    ".marketing-hero-actions .wx-button",
    ".marketing-close .wx-button",
    ".marketing-skip:focus-visible",
  ]) assert.ok(coarse.includes(selector), `${selector} must receive the coarse-pointer target floor`);
  assert.match(coarse, /min-block-size: 2\.75rem/u);
});
