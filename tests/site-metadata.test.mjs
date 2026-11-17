import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutUrl = new URL("../app/layout.tsx", import.meta.url);

test("site metadata uses a request-scoped origin and no promotional image", async () => {
  const layout = await readFile(layoutUrl, "utf8");

  assert.match(layout, /export async function generateMetadata/);
  assert.match(layout, /requestHeaders\.get\("x-forwarded-host"\)/);
  assert.match(layout, /metadataBase: new URL\(origin\)/);
  assert.doesNotMatch(layout, /wasalx-social\.png|summary_large_image/);
});

test("host-derived metadata fails closed for malformed hosts", async () => {
  const layout = await readFile(layoutUrl, "utf8");

  assert.match(layout, /if \(!host \|\| \/\[\\s\/@\\\\\]\/u\.test\(host\)\)/);
  assert.match(layout, /return "https:\/\/wasalx\.invalid"/);
});

test("tenant deep links use the canonical localized view title", async () => {
  const [page, titles] = await Promise.all([
    readFile(new URL("../app/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/tenant-view-titles.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /tenantViewTitle\(requested\)/u);
  assert.doesNotMatch(page, /· WasalX/u);
  for (const view of ["connections", "groups", "automation", "plugins", "routing", "deliveries"])
    assert.match(titles, new RegExp(`\\b${view}:`));
});
