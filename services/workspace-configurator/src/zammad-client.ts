import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DefaultsConfig, OidcConfig, PackageConfig } from "./config.js";
import { startupRequest } from "./startup-request.js";

export class ConfiguratorRuntimeError extends Error {
  constructor(readonly code: string) {
    super("The workspace operation did not pass read-after-write verification.");
    this.name = "ConfiguratorRuntimeError";
  }
}

export class ZammadAdminClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}

  async configurePackage(config: PackageConfig) {
    const artifact = await readFile(config.packagePath);
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (digest !== config.packageSha256) fail("PACKAGE_ARTIFACT_MISMATCH");
    const metadata = packageMetadata(artifact);
    if (metadata.name !== "wasalx" || metadata.version !== config.packageVersion) fail("PACKAGE_IDENTITY_MISMATCH");

    const readiness = await this.readiness(config.tenantId);
    const installed = packageRecord(readiness.package);
    if (installed.name !== "wasalx" || installed.version !== config.packageVersion || installed.state !== "installed" || record(readiness.package).sha256 !== digest) {
      fail("PACKAGE_VERIFY_FAILED");
    }
    return {
      status: "SUCCEEDED",
      action: "package",
      tenant_id: config.tenantId,
      package: { name: installed.name, version: installed.version, state: "installed", sha256: digest },
      verified_at: new Date().toISOString(),
    };
  }

  async configureOidc(config: OidcConfig) {
    const desired = {
      client_id: config.clientId,
      issuer: config.issuer.toString().replace(/\/$/u, ""),
      uid_field: "sub",
      scope: "openid email profile",
      pkce: true,
    };
    const oidc = record((await this.readiness(config.tenantId)).oidc);
    if (Object.entries(desired).some(([key, value]) => oidc[key] !== value) || oidc.enabled !== true || oidc.password_login_disabled !== true) fail("OIDC_VERIFY_FAILED");
    return {
      status: "SUCCEEDED", action: "oidc", tenant_id: config.tenantId,
      oidc: { issuer: desired.issuer, client_id: desired.client_id, pkce: true, password_login_disabled: true },
      verified_at: new Date().toISOString(),
    };
  }

  async configureDefaults(config: DefaultsConfig) {
    const readiness = await this.readiness(config.tenantId);
    if (!Array.isArray(readiness.groups)) fail("GROUPS_RESPONSE_INVALID");
    const groups = readiness.groups.map(groupRecord);
    const verified = groups.find((entry) => entry.name === config.initialGroup && entry.active === true);
    if (!verified) fail("DEFAULTS_VERIFY_FAILED");
    return {
      status: "SUCCEEDED", action: "defaults", tenant_id: config.tenantId,
      defaults: { zammad_group_id: String(verified.id), zammad_group: verified.name, retention_days: config.retentionDays, backup_policy: config.backupPolicy },
      verified_at: new Date().toISOString(),
    };
  }

  private async readiness(tenantId: string) {
    const value = record(await this.json("/api/v1/wasalx/service/readiness"));
    if (value.tenant_id !== tenantId) fail("WORKSPACE_IDENTITY_MISMATCH");
    return value;
  }

  private async json(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(path, this.baseUrl);
      const response = await startupRequest(this.request, url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        headers: {
          Authorization: `Token token=${this.token}`, "User-Agent": "WasalX-Workspace-Configurator/0.1",
          Accept: "application/json", "Content-Type": "application/json", ...init.headers,
        },
      });
      if (![200, 201].includes(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        fail(response.status >= 500 ? "ZAMMAD_UNAVAILABLE" : "ZAMMAD_REQUEST_REJECTED");
      }
      const bytes = await boundedBytes(response);
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        fail("ZAMMAD_RESPONSE_INVALID");
      }
    } catch (error) {
      if (error instanceof ConfiguratorRuntimeError) throw error;
      fail("ZAMMAD_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function boundedBytes(response: Response) {
  const maximum = 5 * 1_024 * 1_024;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    void response.body?.cancel().catch(() => undefined);
    fail("ZAMMAD_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => undefined);
        fail("ZAMMAD_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function packageMetadata(artifact: Buffer) {
  try {
    const value = record(JSON.parse(new TextDecoder().decode(artifact)));
    if (typeof value.name !== "string" || typeof value.version !== "string") fail("PACKAGE_IDENTITY_MISMATCH");
    return { name: value.name, version: value.version };
  } catch (error) {
    if (error instanceof ConfiguratorRuntimeError) throw error;
    fail("PACKAGE_ARTIFACT_INVALID");
  }
}

function packageRecord(value: unknown) {
  const item = record(value);
  if (typeof item.name !== "string" || typeof item.version !== "string" || typeof item.state !== "string") fail("PACKAGE_RESPONSE_INVALID");
  return { name: item.name, version: item.version, state: item.state };
}

function groupRecord(value: unknown) {
  const item = record(value);
  if (!Number.isSafeInteger(item.id) || typeof item.name !== "string" || typeof item.active !== "boolean") fail("GROUPS_RESPONSE_INVALID");
  return { id: item.id as number, name: item.name, active: item.active };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ZAMMAD_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function fail(code: string): never {
  throw new ConfiguratorRuntimeError(code);
}
