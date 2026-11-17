// Explicit simulation mode is outside locale/role loops and browser prerequisites.
if (process.argv.includes('--simulation-manifest')) {
 const index=process.argv.indexOf('--simulation-manifest');
 if(index!==2 || process.argv.length!==4) throw Error('Usage: --simulation-manifest <file>');
 const {runSimulationManifest}=await import('./release/simulation-manifest.mjs');
 try{await runSimulationManifest(process.argv[3],{collectionStartedAt:process.env.WASALX_COLLECTION_STARTED_AT??new Date().toISOString()});}
 catch(error){const {createHash}=await import('node:crypto');const errorClass=typeof error?.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)?error.name:'Error';process.stderr.write(JSON.stringify({status:'failed',errorClass,messageSha256:createHash('sha256').update(String(error?.message??error)).digest('hex')})+'\n');process.exit(1);}
 process.exit(0);
}
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { browserShard, browserShardArguments } from "./release/browser-shards.mjs";
browserShard(process.env.WASALX_E2E_SHARD);
const { runRoleSuites, validateRoleSuites } = await import("./application-e2e-pool.mjs");
const { chromium } = await import("@playwright/test");

const supportedRoles = [
  "tenant_owner",
  "tenant_admin",
  "supervisor",
  "agent",
  "auditor",
];

const roles = (process.env.WASALX_E2E_ROLES ?? supportedRoles.join(","))
  .split(",")
  .map((role) => role.trim())
  .filter(Boolean);

if (!roles.length || new Set(roles).size !== roles.length || roles.some((role) => !supportedRoles.includes(role))) {
  process.stderr.write(
    `WASALX_E2E_ROLES must contain only: ${supportedRoles.join(", ")}\n`,
  );
  process.exit(2);
}

const supportedLocales = ["en", "ar"];
const locales = (process.env.WASALX_E2E_LOCALES ?? supportedLocales.join(","))
  .split(",")
  .map((locale) => locale.trim())
  .filter(Boolean);
if (!locales.length || new Set(locales).size !== locales.length || locales.some((locale) => !supportedLocales.includes(locale))) {
  process.stderr.write("WASALX_E2E_LOCALES must contain only: en, ar\n");
  process.exit(2);
}

const explicitPath = process.env.WASALX_E2E_BROWSER_PATH;
const basePort = Number(process.env.WASALX_E2E_PORT ?? 3191);
const isolatedFixtures = !process.env.WASALX_E2E_PLATFORM_URL;
validateRoleSuites(locales, roles, basePort, isolatedFixtures);
const candidates = [
  explicitPath,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

let browserPath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    browserPath = candidate;
    break;
  } catch {
    // Keep looking. The package path can exist in metadata before the browser
    // download is installed, while a system Chromium may still be available.
  }
}

if (!browserPath) {
  process.stderr.write(
    "Application E2E requires a Chromium-compatible browser. Install Playwright Chromium or set WASALX_E2E_BROWSER_PATH.\n",
  );
  process.exit(1);
}

const nodeBin = dirname(process.execPath);
let failed = false;

if (process.env.WASALX_E2E_SKIP_BUILD !== "1") {
  process.stdout.write("\n=== Building the production portal for application E2E ===\n");
  const buildResult = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["run", "build"],
      {
        env: {
          ...process.env,
          PATH: `${nodeBin}${delimiter}${process.env.PATH ?? ""}`,
          WRANGLER_LOG_PATH: ".wrangler/e2e-build.log",
        },
        stdio: "inherit",
      },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (buildResult.signal || buildResult.code !== 0) {
    process.stderr.write("The production portal build required by application E2E failed.\n");
    process.exit(1);
  }
}

await runRoleSuites(locales, roles, basePort, async (locale, role, port) => {
  const shardArguments = browserShardArguments({ ...process.env, WASALX_E2E_LOCALE: locale, WASALX_E2E_ROLE: role });
  process.stdout.write(`\n=== WasalX application E2E · ${locale} · ${role} ===\n`);
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.application.config.ts", ...shardArguments],
      {
        env: {
          ...process.env,
          PATH: `${nodeBin}${delimiter}${process.env.PATH ?? ""}`,
          WASALX_E2E_BROWSER_PATH: browserPath,
          WASALX_E2E_LOCALE: locale,
          WASALX_E2E_ROLE: role,
          WASALX_E2E_PORT: String(port),
          WASALX_E2E_REUSE_SERVER: "0",
        },
        stdio: "inherit",
      },
    );
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });

  if (result.signal || result.code !== 0) {
    failed = true;
    process.stderr.write(
      `Application E2E failed for ${locale}/${role}${result.signal ? ` (${result.signal})` : ""}. Remaining combinations will still run.\n`,
    );
  }
}, isolatedFixtures);

process.exit(failed ? 1 : 0);
