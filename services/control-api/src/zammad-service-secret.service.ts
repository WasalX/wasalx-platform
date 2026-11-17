import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { isOwnedSecretReference } from "@wasalx/core/secret-reference";

const MAX_RESPONSE_BYTES = 16_384;

@Injectable()
export class ZammadServiceSecretService implements OnModuleDestroy {
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  private readonly controller = new AbortController();

  constructor() {
    this.baseUrl = new URL(required("SECRET_SIDECAR_URL"));
    this.bearerToken = required("SECRET_SIDECAR_TOKEN");
    if (process.env.NODE_ENV === "production" && this.baseUrl.protocol !== "https:") {
      throw new Error("Secret sidecar must use HTTPS in production");
    }
  }

  async resolveSigningSecret(reference: string, owner: { tenantId: string; instanceId: string }) {
    return (await this.resolveCredentials(reference, owner)).jwtSecret;
  }

  async resolveApiToken(reference: string, owner: { tenantId: string; instanceId: string }) {
    return (await this.resolveCredentials(reference, owner)).apiToken;
  }

  async resolveCredentials(reference: string, owner: { tenantId: string; instanceId: string }) {
    validateReference(reference);
    validateInstanceId(owner.instanceId);
    if (!isOwnedSecretReference(reference, { kind: "zammad", tenantId: owner.tenantId, purpose: "service" })) throw invalidSecret();
    let response: Response;
    try {
      response = await fetch(new URL("/v1/resolve", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ reference }),
        redirect: "error",
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]),
      });
    } catch {
      throw invalidSecret();
    }
    if (!response.ok) throw invalidSecret();
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw invalidSecret();
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw invalidSecret();
    }
    // Keep the connector worker's least-privilege Zammad REST API `token`
    // cryptographically separate from the package-to-control signing key.
    const secret = objectValue(value);
    const token = secret?.jwt_secret;
    const apiToken = secret?.token;
    const instanceId = secret?.instance_id;
    if (
      typeof token !== "string" ||
      Buffer.byteLength(token, "utf8") < 32 ||
      Buffer.byteLength(token, "utf8") > 512 ||
      hasControlCharacters(token) ||
      typeof apiToken !== "string" ||
      Buffer.byteLength(apiToken, "utf8") < 16 ||
      Buffer.byteLength(apiToken, "utf8") > 4_096 ||
      hasControlCharacters(apiToken) ||
      token === apiToken ||
      token === this.bearerToken ||
      apiToken === this.bearerToken ||
      instanceId !== owner.instanceId
    ) {
      throw invalidSecret();
    }
    return { jwtSecret: token, apiToken };
  }

  // Configuration proof crosses the private signed bridge as hashes, never credential values.
  async resolvePrivacyToken(reference: string, owner: { tenantId: string; instanceId: string }) {
    validateReference(reference); validateInstanceId(owner.instanceId);
    if (!isOwnedSecretReference(reference, { kind: "zammad", tenantId: owner.tenantId, purpose: "privacy" })) throw invalidSecret();
    let response: Response;
    try {
      response = await fetch(new URL("/v1/resolve", this.baseUrl), { method: "POST",
        headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ reference }), redirect: "error",
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]) });
    } catch { throw invalidSecret(); }
    if (!response.ok) throw invalidSecret();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, MAX_RESPONSE_BYTES))); }
    catch { throw invalidSecret(); }
    const token = objectValue(value)?.token;
    if (typeof token !== "string" || Buffer.byteLength(token) < 16 || Buffer.byteLength(token) > 4096 || hasControlCharacters(token)
      || token === this.bearerToken) throw invalidSecret();
    return token;
  }

  onModuleDestroy() {
    this.controller.abort();
  }
}

class ZammadServiceSecretError extends Error {
  constructor() {
    super("Secure Zammad service credentials could not be resolved.");
    this.name = "ZammadServiceSecretError";
  }
}

function invalidSecret() {
  return new ZammadServiceSecretError();
}

function validateReference(reference: string) {
  if (
    Buffer.byteLength(reference, "utf8") > 512 ||
    !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(reference)
  ) {
    throw invalidSecret();
  }
}

function validateInstanceId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw invalidSecret();
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

async function readBounded(response: Response, limit: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw invalidSecret();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
