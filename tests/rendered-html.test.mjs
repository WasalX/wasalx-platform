import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

let port;
let server;
let serverError = "";
let serverExit;
const origin = () => `http://127.0.0.1:${port}`;

before(async () => {
  port = await freePort();
  server = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start", "-p", String(port)], {
    cwd: new URL("../", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORTAL_DATA_BACKEND: "fixture",
      PORTAL_FIXTURE_ROLE: "tenant_owner",
      WRANGLER_LOG_PATH: ".wrangler/test.log",
    },
  });
  server.stdout.on("data", (chunk) => { serverError += String(chunk); });
  server.stderr.on("data", (chunk) => { serverError += String(chunk); });
  server.once("exit", (code, signal) => { serverExit = { code, signal }; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (serverExit) throw new Error(`Test server exited before readiness (${JSON.stringify(serverExit)}). ${serverError}`);
    try { const response = await fetch(`${origin()}/api/health`); if (response.ok) return; } catch (error) { if (error instanceof Error) serverError += `\n${error.message}`; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Test server did not start. ${serverError}`);
});

after(() => { server?.kill("SIGTERM"); });

async function render(path = "/app") { return fetch(`${origin()}${path}`, { headers: { accept: "text/html" } }); }

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address(); assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("server-renders the WasalX operational portal", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Operational overview · WasalX<\/title>/i);
  assert.doesNotMatch(html, /WasalX · WasalX/i);
  assert.match(html, /Operational overview/);
  assert.match(html, /Northstar Logistics/);
  assert.match(html, /aria-label="Rules"/);
  assert.match(html, /Workspace(?:<!-- -->)? needs attention/);
  assert.match(html, /Case workspace needs attention/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("includes semantic navigation without promotional social images", async () => {
  const html = await (await render()).text();
  assert.doesNotMatch(html, /wasalx-social\.png/);
  assert.match(html, /aria-label="Primary navigation"/);
  assert.match(html, /aria-label="Switch to (?:light|dark) theme"/);
});

test("rules sample keeps an explicit accessible label with prefilled text", async () => {
  const html = await (await render("/app?view=rules")).text();
  assert.match(html, /<label for="rule-test-sample">/);
  assert.match(html, /<span id="rule-test-sample-label">Sample WhatsApp message<\/span>/);
  assert.match(html, /<textarea[^>]*id="rule-test-sample"[^>]*aria-labelledby="rule-test-sample-label"[^>]*>[^<]+<\/textarea>/);
});

test("public and app pages serve the WX browser icon with a purple X", async () => {
  for (const path of ["/", "/app"]) {
    const html = await (await render(path)).text();
    const link = html.match(/<link\b(?=[^>]*rel="icon")(?=[^>]*href="([^"]+)")[^>]*>/u);
    assert.ok(link, `${path} has a browser icon`);
    assert.equal(link[1], "/favicon.svg?v=wx-1");
    const icon = await fetch(new URL(link[1], origin()));
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /image\/svg\+xml/u);
    const svg = await icon.text();
    assert.match(svg, /aria-label="W"/u);
    assert.match(svg, /aria-label="X"[^>]+fill="#6557d8"/u);
    assert.doesNotMatch(svg, /<script|<image|<text|<foreignObject/u);
  }
});

test("server-renders the public product landing page", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /One shared inbox for your team · WasalX/iu);
  assert.match(html, /All your conversations/iu);
  assert.match(html, /Your team’s workspace/iu);
  assert.match(html, /Shipment #4821/iu);
  assert.match(html, /Handed over by bot/iu);
  assert.match(html, /mailto:contact@example\.invalid/u);
  assert.match(html, /Customer support/u);
  assert.match(html, /Technical support/u);
  assert.match(html, /href="\/auth\/login\?return_to=\/app"/u);
});

test("unknown and inherited invitation states render the safe failure page", async () => {
  for (const state of ["unknown", "constructor", "__proto__"]) {
    const response = await render(`/invitations/result?state=${state}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /We couldn.t complete the invitation/u);
    assert.match(html, /Reopen the original invitation link/u);
    assert.match(html, /noindex/u);
    assert.match(html, /no-referrer/u);
  }
});

test("legacy tenant deep links redirect to the route-backed console", async () => {
  const response = await fetch(`${origin()}/?view=connections&connection=connection-1`, { redirect: "manual" });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/app?view=connections&connection=connection-1");
});

test("reports /app first-load JavaScript as DESIGN.md Speed measures it (#183)", async (t) => {
  const html = await (await render()).text();
  const dist = new URL("../dist/", import.meta.url);
  const manifest = (await import(new URL("server/__vite_rsc_assets_manifest.js", dist).href)).default;
  // Client references /app renders are the manifest ids present in its server-rendered payload.
  const refs = Object.entries(manifest.clientReferenceDeps).filter(([id]) => html.includes(id));
  assert.ok(refs.some(([, deps]) => /\/WasalXApp-[^/]*\.js$/u.test(deps.js[0])), "the /app shell reference is rendered");
  const files = new Set([...manifest.clientEntryDeps.js, ...refs.flatMap(([, deps]) => deps.js)]);
  let raw = 0, gzip = 0, brotli = 0;
  for (const file of files) {
    const body = await readFile(new URL(`client${file}`, dist));
    raw += body.length;
    gzip += gzipSync(body, { level: 9 }).length;
    brotli += brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  }
  t.diagnostic(`/app first-load JS: ${JSON.stringify({ references: refs.length, files: files.size, raw, gzip, brotli })}`);
});
