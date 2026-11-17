import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { isOwnedSecretReference } from "@wasalx/core/secret-reference";

const MAX_SECRET_BYTES = 16_384;

@Injectable()
export class MetaCredentialService implements OnModuleDestroy {
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

  async resolveAccessToken(reference: string, owner: { tenantId: string; connectionId: string }) {
    return (await this.resolveOwned(reference, { kind: "meta-connection", ...owner })).accessToken;
  }

  async resolveSignupToken(reference: string, owner: { tenantId: string; attemptId: string }) {
    return (await this.resolveOwned(reference, { kind: "meta-signup", ...owner })).accessToken;
  }

  async resolveSignupConnection(reference: string, owner: { tenantId: string; connectionId: string }) {
    return this.resolveOwned(reference, { kind: "meta-connection", ...owner });
  }

  /** Only an authoritative sidecar 404 proves an absent exact rotation stage. */
  async inspectSignupConnection(reference: string, owner: { tenantId: string; connectionId: string }) {
    return this.resolveOwnedOptional(reference, { kind: "meta-connection", ...owner }, true);
  }

  async resolveFinancialAccessToken() {
    const reference = process.env.META_FINANCIAL_SECRET_REFERENCE;
    if (!reference) throw invalidCredential();
    return (await this.resolveOwned(reference, { kind: "exact", expectedReference: reference })).accessToken;
  }

  private async resolveOwned(reference: string, owner: Parameters<typeof isOwnedSecretReference>[1]) {
    const value = await this.resolveOwnedOptional(reference, owner);
    if (!value) throw invalidCredential();
    return value;
  }

  private async resolveOwnedOptional(reference: string, owner: Parameters<typeof isOwnedSecretReference>[1], allowMissing = false) {
    validateReference(reference);
    if (!isOwnedSecretReference(reference, owner)) throw invalidCredential();
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
      throw new MetaCredentialError(
        "META_CREDENTIAL_UNAVAILABLE",
        "Secure Meta credentials are temporarily unavailable.",
        true,
      );
    }
    if (response.status === 404 && allowMissing) return undefined;
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new MetaCredentialError(
        "META_CREDENTIAL_RESOLUTION_FAILED",
        retryable
          ? "Secure Meta credentials are temporarily unavailable."
          : "Secure Meta credentials could not be resolved.",
        retryable,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SECRET_BYTES) throw invalidCredential();
    const bytes = await readBounded(response, MAX_SECRET_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw invalidCredential();
    }
    const token = objectValue(value)?.accessToken;
    if (
      typeof token !== "string" ||
      token.length < 16 ||
      token.length > 4_096 ||
      hasControlCharacters(token)
    ) {
      throw invalidCredential();
    }
    const pin = objectValue(value)?.registrationPin;
    if (pin !== undefined && (owner.kind !== "meta-connection" || typeof pin !== "string" || !/^\d{6}$/u.test(pin))) throw invalidCredential();
    return { accessToken: token, ...(typeof pin === "string" ? { registrationPin: pin } : {}) };
  }

  onModuleDestroy() {
    this.controller.abort();
  }
}

export class MetaCredentialError extends Error {
  constructor(
    readonly code: string,
    readonly safeError: string,
    readonly retryable: boolean,
  ) {
    super(safeError);
    this.name = "MetaCredentialError";
  }
}

function invalidCredential() {
  return new MetaCredentialError(
    "META_CREDENTIAL_INVALID",
    "Secure Meta credentials could not be resolved.",
    false,
  );
}

function validateReference(reference: string) {
  if (
    Buffer.byteLength(reference, "utf8") > 512 ||
    !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(reference)
  ) {
    throw invalidCredential();
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
        throw invalidCredential();
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
