import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;


const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
  // Route handlers execute inside the Cloudflare worker isolate, while the RSC
  // renderer can execute in the host process during local development. Mirror
  // the explicitly selected portal mode into the worker so both surfaces use
  // the same backend. Never forward arbitrary host environment variables.
  vars: Object.fromEntries(
    [
      ["PUBLIC_CONTACT_EMAIL", process.env.PUBLIC_CONTACT_EMAIL],
      ["PORTAL_DATA_BACKEND", process.env.PORTAL_DATA_BACKEND],
      ["PORTAL_FIXTURE_ROLE", process.env.PORTAL_FIXTURE_ROLE],
      ["CONTROL_API_URL", process.env.CONTROL_API_URL],
      ["PORTAL_PUBLIC_ORIGIN", process.env.PORTAL_PUBLIC_ORIGIN],
      ["PORTAL_COOKIE_SECURE", process.env.PORTAL_COOKIE_SECURE],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  ),
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
