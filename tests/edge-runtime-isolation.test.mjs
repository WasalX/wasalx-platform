import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("only the isolated fixture can expose portal ingress and service endpoints", async () => {
  const files = await Promise.all([
    "app/webhooks/meta/route.ts",
    "app/webhooks/waha/[token]/route.ts",
    "app/internal/v1/zammad/outbound/route.ts",
    "app/internal/v1/zammad/article-status/route.ts",
    "app/internal/v1/zammad/health/route.ts",
    "app/internal/v1/zammad/retry/route.ts",
  ].map(read));

  for (const source of files) {
    assert.doesNotMatch(source, /from\s+["']cloudflare:workers["']/u);
    assert.match(source, /!isFixtureBackend\(\)/u);
    assert.match(source, /status:\s*404/u);
  }
});

test("legacy Meta edge ingress has explicit routing and no demo tenant fallback", async () => {
  const source = await read("app/webhooks/meta/route.ts");
  assert.match(source, /META_EDGE_TENANT_ID/u);
  assert.match(source, /META_EDGE_CONNECTION_ID/u);
  assert.match(source, /constantTimeEqual/u);
  assert.doesNotMatch(source, /tenant_northstar|conn_meta/u);
});

test("unsigned WAHA ingress is confined to local fixture mode", async () => {
  const source = await read("app/webhooks/waha/[token]/route.ts");
  assert.match(source, /portalDataBackend\(\)\s*===\s*"fixture"\s*&&\s*local/u);
  assert.doesNotMatch(source, /!secret\s*&&\s*!local/u);
});
