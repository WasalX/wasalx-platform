import assert from "node:assert/strict";
import test from "node:test";
import { smokeZammadAssets } from "../scripts/release/smoke-zammad-assets.mjs";

test("desktop smoke checks emitted assets and rejects HTML-only readiness", async () => {
  const html = '<script type="module" src="/assets/frontend/vite/assets/desktop-test.js"></script>';
  for (const [page, status, type, body, pass] of [
    [html, 200, "text/javascript; charset=utf-8", "export{}", true],
    [html, 404, "text/html", "missing", false],
    [html, 200, "text/html", "fallback", false],
    [html, 200, "text/javascript", "", false],
    ["<p>Loading</p>", 200, "text/javascript", "export{}", false],
  ]) {
    const run = smokeZammadAssets("https://support.example", async url => new Response(
      url.pathname === "/desktop" ? page : body,
      { status: url.pathname === "/desktop" ? 200 : status, headers: { "content-type": type } },
    ));
    if (pass) assert.deepEqual(await run, { scriptsVerified: 1 });
    else await assert.rejects(run);
  }
});
