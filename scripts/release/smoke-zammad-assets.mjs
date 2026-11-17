import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function smokeZammadAssets(origin, fetcher = fetch) {
  const page = await fetcher(new URL("/desktop", origin), { signal: AbortSignal.timeout(20000) });
  assert.equal(page.status, 200, "Zammad desktop must load");
  const html = await page.text();
  const assets = [...new Set([...html.matchAll(/<script\b[^>]*\bsrc=["'](\/assets\/frontend\/vite\/assets\/[^"']+\.js)["'][^>]*>/giu)].map(match => match[1]))];
  assert.ok(assets.length > 0 && assets.length <= 8, "Expected bounded Zammad desktop scripts");
  for (const path of assets) {
    const response = await fetcher(new URL(path, origin), { redirect: "error", signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, "Zammad desktop script must load");
    assert.ok(/^(?:application|text)\/javascript(?:;|$)/iu.test(response.headers.get("content-type") ?? ""), "Expected JavaScript content type");
    assert.ok((await response.arrayBuffer()).byteLength > 0, "Expected nonempty desktop script");
  }
  return { scriptsVerified: assets.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await smokeZammadAssets(process.argv[2])));
}
