import { delimiter, dirname, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const tenantRoles = [
  "tenant_owner",
  "tenant_admin",
  "supervisor",
  "agent",
  "auditor",
] as const;

const configuredRole = process.env.WASALX_E2E_ROLE ?? "tenant_owner";
if (!(tenantRoles as readonly string[]).includes(configuredRole)) {
  throw new Error(`WASALX_E2E_ROLE must be one of ${tenantRoles.join(", ")}.`);
}

const role = configuredRole as (typeof tenantRoles)[number];
const language = process.env.WASALX_E2E_LOCALE ?? "en";
if (language !== "en" && language !== "ar") {
  throw new Error("WASALX_E2E_LOCALE must be en or ar.");
}
const port = Number(process.env.WASALX_E2E_PORT ?? "3191");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("WASALX_E2E_PORT must be a non-privileged TCP port.");
}

// An operator run reuses an explicitly authenticated control-plane server.
// It never starts the fixture backend, grants a role, or creates a session.
const platformPage = process.env.WASALX_E2E_PLATFORM_URL;
const platformUrl = platformPage ? new URL(platformPage) : null;
if (platformUrl && (platformUrl.username || platformUrl.password || !["http:", "https:"].includes(platformUrl.protocol))) {
  throw new Error("WASALX_E2E_PLATFORM_URL must be an HTTP(S) page URL without credentials.");
}
const baseURL = platformUrl?.origin ?? `http://localhost:${port}`;
const browserPath = process.env.WASALX_E2E_BROWSER_PATH;
const nodeBin = dirname(process.execPath);
const artifactSuite = process.env.WASALX_E2E_LOCALES === "en" ? "application-en" : "application";
const artifactRoot = resolve("output", "playwright", artifactSuite, language);

const tabletOnly = /(?:^|\s)@tablet-only(?:\s|$)/u;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: platformUrl ? ["meta-cost-operator.spec.ts", "meta-transition-operator.spec.ts", "meta-deletion-operator.spec.ts"] : language === "ar" ? ["arabic.spec.ts", "public-site.spec.ts", "meta-billing-diagnostic.spec.ts", "meta-account-policy.spec.ts", "meta-account-transition.spec.ts", "meta-managed-policy.spec.ts", "meta-cost.spec.ts", "meta-cost-statements.spec.ts", "meta-account-transition-execution.spec.ts", "meta-transition-operator.spec.ts"] : ["application.spec.ts", "public-site.spec.ts", "meta-billing-diagnostic.spec.ts", "meta-account-policy.spec.ts", "meta-account-transition.spec.ts", "meta-managed-policy.spec.ts", "meta-cost.spec.ts", "meta-cost-statements.spec.ts", "meta-account-transition-execution.spec.ts", "meta-transition-operator.spec.ts"],
  outputDir: resolve(artifactRoot, "results", role),
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: resolve(artifactRoot, "report", role), open: "never" }],
    ["./scripts/release/browser-shard-reporter.mjs"],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    headless: true,
    launchOptions: browserPath ? { executablePath: browserPath } : {},
    locale: language === "ar" ? "ar-SA" : "en-US",
    storageState: {
      cookies: [{
        name: "wasalx_locale",
        value: language,
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      }],
      origins: [],
    },
    screenshot: "only-on-failure",
    timezoneId: "Asia/Riyadh",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      grepInvert: tabletOnly,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1_440, height: 1_000 },
      },
    },
    {
      name: "mobile-390",
      grepInvert: /(?:^|\s)@(?:tablet|desktop)-only(?:\s|$)/u,
      use: {
        browserName: "chromium",
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "tablet-820",
      // Cover shell and inbox layouts, the audit table, group drawer, and Arabic RTL.
      grep: /(?:^|\s)@tablet(?:\s|$)/u,
      use: {
        browserName: "chromium",
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 820, height: 1_180 },
      },
    },
  ],
  webServer: platformUrl ? undefined : {
    command: `"${process.execPath}" node_modules/vinext/dist/cli.js start -p ${port} -H localhost`,
    stdout: "pipe",
    env: {
      ...process.env,
      PATH: `${nodeBin}${delimiter}${process.env.PATH ?? ""}`,
      MINIFLARE_REGISTRY_PATH: `.wrangler/e2e-${language}-${role}-registry`,
      PORTAL_DATA_BACKEND: "fixture",
      PORTAL_COOKIE_SECURE: "false",
      PORTAL_FIXTURE_ROLE: role,
      PORTAL_PUBLIC_ORIGIN: baseURL,
      WRANGLER_LOG_PATH: `.wrangler/e2e-${language}-${role}.log`,
    },
    reuseExistingServer: process.env.WASALX_E2E_REUSE_SERVER === "1",
    timeout: 120_000,
    url: `${baseURL}/api/health`,
  },
});
