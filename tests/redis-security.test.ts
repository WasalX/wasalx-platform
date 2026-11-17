import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validatedRedisUrl } from "../packages/core/src/redis-security.ts";

test("Redis URLs fail closed outside explicit local development and test", () => {
  const production = { NODE_ENV: "production", WASALX_ENVIRONMENT: "production" };
  assert.throws(
    () => validatedRedisUrl("redis://redis.internal:6379", production),
    /authenticated TLS/,
  );
  assert.throws(
    () => validatedRedisUrl("redis://127.0.0.1:6379", production),
    /authenticated TLS/,
  );
  assert.throws(
    () => validatedRedisUrl("rediss://redis.internal:6379", production),
    /ACL username and password/,
  );
  assert.throws(
    () => validatedRedisUrl("rediss://default:secret@redis.internal:6379", production),
    /dedicated ACL user/,
  );
  assert.equal(
    validatedRedisUrl("rediss://portal:secret@redis.internal:6379", production),
    "rediss://portal:secret@redis.internal:6379",
  );
  assert.equal(
    validatedRedisUrl("redis://redis:6379", { NODE_ENV: "development" }),
    "redis://redis:6379",
  );
  assert.equal(
    validatedRedisUrl("redis://redis:6379", { NODE_ENV: "production", WASALX_ENVIRONMENT: "local-full" }),
    "redis://redis:6379",
  );
});

test("every WasalX Redis client validates the URL before connecting", async () => {
  for (const path of [
    "lib/portal-session-store.ts",
    "lib/platform-portal-session-store.ts",
    "services/control-api/src/tenant-drain.service.ts",
    "services/connector-worker/src/main.ts",
  ]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /validatedRedisUrl/u, path);
  }
});

test("production Helm and tenant Zammad receive secret-backed TLS Redis contracts", async () => {
  const [workloads, resources, provider, terraform] = await Promise.all([
    readFile(new URL("../infra/helm/wasalx/templates/workloads.yaml", import.meta.url), "utf8"),
    readFile(new URL("../services/tenant-provisioner/src/controller/resources.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/workspace-provider/src/kubernetes.ts", import.meta.url), "utf8"),
    readFile(new URL("../infra/terraform/main.tf", import.meta.url), "utf8"),
  ]);
  for (const name of ["PORTAL_SESSION_REDIS_URL", "PLATFORM_PORTAL_SESSION_REDIS_URL", "REDIS_URL"]) {
    assert.match(workloads, new RegExp(`name: ${name}[^\\n]+secretKeyRef`));
  }
  for (const property of ["redis_url", "redis_password", "redis_acl", "redis_ca", "redis_cert", "redis_key"]) {
    assert.match(resources, new RegExp(`secretProperty\\([^\\n]+${property}`));
  }
  assert.match(resources, /"--port", "0", "--tls-port", "6379"/u);
  assert.match(resources, /"--aclfile", "\/run\/wasalx\/redis\/users\.acl"/u);
  assert.match(resources, /secretEnv\("REDIS_URL", secretName, "REDIS_URL"\)/u);
  assert.match(resources, /SSL_CERT_FILE/u);
  assert.match(provider, /redis_host/u);
  assert.match(provider, /redis_username: "zammad"/u);
  assert.match(terraform, /portal_secret_name/u);
  assert.match(terraform, /control_api_secret_name/u);
  assert.match(terraform, /connector_worker_secret_name/u);
});
