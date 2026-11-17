import { Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { traceCarrierHeaders } from "@wasalx/observability";
import type {
  TenantProvisioningDriverRequest,
  TenantProvisioningDriverResult,
} from "./tenant-provisioning.types.js";

export interface TenantProvisioningDriver {
  isConfigured(): boolean;
  execute(
    request: TenantProvisioningDriverRequest,
  ): Promise<TenantProvisioningDriverResult>;
}

export class ProvisioningDriverError extends Error {
  constructor(
    readonly code: string,
    readonly safeError: string,
    readonly retryable: boolean,
  ) {
    super(safeError);
    this.name = "ProvisioningDriverError";
  }
}

@Injectable()
export class HttpTenantProvisioningDriver implements TenantProvisioningDriver {
  private readonly endpoint?: URL;
  private readonly signingSecret?: Uint8Array;
  private readonly timeoutMs: number;

  constructor() {
    this.timeoutMs = boundedInteger(
      process.env.PROVISIONING_DRIVER_TIMEOUT_MS,
      60_000,
      5_000,
      120_000,
    );
    const rawUrl = process.env.PROVISIONING_DRIVER_URL;
    const rawSecret = process.env.PROVISIONING_DRIVER_JWT_SECRET;
    if (!rawUrl || !rawSecret || Buffer.byteLength(rawSecret, "utf8") < 32) return;
    try {
      const endpoint = new URL(rawUrl);
      const insecureDevelopment =
        process.env.NODE_ENV !== "production" &&
        process.env.ALLOW_INSECURE_PROVISIONING_DRIVER === "true";
      if (
        (endpoint.protocol !== "https:" &&
          !(endpoint.protocol === "http:" && insecureDevelopment)) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      ) {
        return;
      }
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/internal/v1/tenant-provisioning/execute`;
      this.endpoint = endpoint;
      this.signingSecret = new TextEncoder().encode(rawSecret);
    } catch {
      return;
    }
  }

  isConfigured() {
    return Boolean(this.endpoint && this.signingSecret);
  }

  async execute(request: TenantProvisioningDriverRequest) {
    if (!this.endpoint || !this.signingSecret) {
      throw new ProvisioningDriverError(
        "DRIVER_NOT_CONFIGURED",
        "A real tenant provisioning driver is not configured.",
        false,
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    const requestBody = JSON.stringify(request);
    const token = await new SignJWT({
      scope: "tenant:provision",
      tenant_id: request.tenantId,
      operation_id: request.operationId,
      zammad_instance_id: request.zammadInstanceId,
      action: request.action,
      step: request.step,
      resume_phase: request.resumePhase,
      fencing_token: request.fencingToken,
      idempotency_key: request.idempotencyKey,
      request_sha256: createHash("sha256").update(requestBody).digest("hex"),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("wasalx-control-plane")
      .setAudience("wasalx-provisioning-driver")
      .setSubject("tenant-provisioning-worker")
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(this.signingSecret);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": request.idempotencyKey,
          ...traceCarrierHeaders(),
        },
        body: requestBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProvisioningDriverError(
        "DRIVER_UNREACHABLE",
        error instanceof Error && error.name === "TimeoutError"
          ? "The tenant provisioning driver timed out."
          : "The tenant provisioning driver is temporarily unreachable.",
        true,
      );
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 65_536) {
      throw new ProvisioningDriverError(
        "DRIVER_RESPONSE_INVALID",
        "The tenant provisioning driver returned an oversized response.",
        false,
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 65_536) {
      throw new ProvisioningDriverError(
        "DRIVER_RESPONSE_INVALID",
        "The tenant provisioning driver returned an oversized response.",
        false,
      );
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const retryable =
        [408, 425, 429].includes(response.status) || response.status >= 500;
      throw new ProvisioningDriverError(
        `DRIVER_HTTP_${response.status}`,
        retryable
          ? "The tenant provisioning driver reported a temporary failure."
          : "The tenant provisioning driver rejected the requested operation.",
        retryable,
      );
    }
    return validateDriverResult(body, request);
  }
}

export function validateDriverResult(
  value: unknown,
  request: TenantProvisioningDriverRequest,
): TenantProvisioningDriverResult {
  if (!isRecord(value)) {
    throw invalidDriverResult();
  }
  if (
    value.status !== "SUCCEEDED" ||
    value.operationId !== request.operationId ||
    value.zammadInstanceId !== request.zammadInstanceId ||
    value.tenantId !== request.tenantId ||
    value.action !== request.action ||
    value.fencingToken !== request.fencingToken ||
    value.idempotencyKey !== request.idempotencyKey ||
    (request.step !== undefined && value.step !== request.step) ||
    (request.step === undefined && value.step !== undefined)
    || value.resumePhase !== request.resumePhase
  ) {
    throw invalidDriverResult();
  }
  const outputs = sanitizeOutputs(value.outputs);
  return {
    status: "SUCCEEDED",
    operationId: request.operationId,
    zammadInstanceId: request.zammadInstanceId,
    tenantId: request.tenantId,
    action: request.action,
    ...(request.step ? { step: request.step } : {}),
    ...(request.resumePhase ? { resumePhase: request.resumePhase } : {}),
    fencingToken: request.fencingToken,
    idempotencyKey: request.idempotencyKey,
    outputs,
  };
}

function sanitizeOutputs(value: unknown) {
  const sanitized = sanitizeValue(value, 0, "outputs");
  if (!isRecord(sanitized)) throw invalidDriverResult();
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > 32_768) {
    throw invalidDriverResult();
  }
  return sanitized;
}

function sanitizeValue(value: unknown, depth: number, path: string): unknown {
  if (depth > 6) throw invalidDriverResult();
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (
      value.length > 2_048 ||
      hasControlCharacters(value) ||
      containsEmbeddedCredential(value)
    ) {
      throw invalidDriverResult();
    }
    if (path.endsWith("secret_reference") && !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(value)) {
      throw invalidDriverResult();
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw invalidDriverResult();
    return value.map((entry, index) =>
      sanitizeValue(entry, depth + 1, `${path}[${index}]`),
    );
  }
  if (!isRecord(value) || Object.keys(value).length > 100) {
    throw invalidDriverResult();
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(key)) throw invalidDriverResult();
    const lower = key.toLowerCase();
    const lifecycleCredentialEvidence =
      lower === "credentials_disabled" || lower === "credentials_enabled";
    if (lifecycleCredentialEvidence && entry !== true) throw invalidDriverResult();
    if (
      (/(password|token|api_?key|private_?key|credential|authorization|cookie|message_?body)/u.test(
        lower,
      ) && !lifecycleCredentialEvidence) ||
      (lower.includes("secret") && !lower.endsWith("secret_reference"))
    ) {
      throw invalidDriverResult();
    }
    result[key] = sanitizeValue(entry, depth + 1, `${path}.${lower}`);
  }
  return result;
}

function invalidDriverResult() {
  return new ProvisioningDriverError(
    "DRIVER_RESPONSE_INVALID",
    "The tenant provisioning driver returned an invalid or sensitive response.",
    false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function containsEmbeddedCredential(value: string) {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(value)) return true;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return true;
  }
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Provisioning driver timeout must be between ${minimum} and ${maximum} milliseconds`,
    );
  }
  return value;
}
