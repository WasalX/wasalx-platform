import { Injectable, OnModuleDestroy } from "@nestjs/common";

@Injectable()
export class WahaAdminSecretService implements OnModuleDestroy {
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  private readonly controller = new AbortController();

  constructor() {
    this.baseUrl = new URL(required("SECRET_SIDECAR_URL"));
    this.bearerToken = required("SECRET_SIDECAR_TOKEN");
    if (
      process.env.NODE_ENV === "production" &&
      this.baseUrl.protocol !== "https:"
    ) {
      throw new Error("Secret sidecar must use HTTPS in production");
    }
  }

  async resolveApiKey(reference: string) {
    validateReference(reference);
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(5_000),
    ]);
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
        signal,
      });
    } catch {
      throw new WahaAdminSecretError(
        "WAHA_ADMIN_SECRET_UNAVAILABLE",
        "Secure WhatsApp credentials are temporarily unavailable.",
        true,
      );
    }
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      throw new WahaAdminSecretError(
        "WAHA_ADMIN_SECRET_RESOLUTION_FAILED",
        retryable
          ? "Secure WhatsApp credentials are temporarily unavailable."
          : "Secure WhatsApp credentials could not be resolved.",
        retryable,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 16_384) {
      throw invalidSecret();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 16_384) throw invalidSecret();
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw invalidSecret();
    }
    const apiKey =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).apiKey === "string"
        ? String((value as Record<string, unknown>).apiKey)
        : undefined;
    if (
      !apiKey ||
      apiKey.length < 16 ||
      apiKey.length > 512 ||
      Array.from(apiKey).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      throw invalidSecret();
    }
    return apiKey;
  }

  onModuleDestroy() {
    this.controller.abort();
  }
}

export class WahaAdminSecretError extends Error {
  constructor(
    readonly code: string,
    readonly safeError: string,
    readonly retryable: boolean,
  ) {
    super(safeError);
    this.name = "WahaAdminSecretError";
  }
}

function invalidSecret() {
  return new WahaAdminSecretError(
    "WAHA_ADMIN_SECRET_INVALID",
    "Secure WhatsApp credentials could not be resolved.",
    false,
  );
}

function validateReference(reference: string) {
  if (
    Buffer.byteLength(reference, "utf8") > 512 ||
    !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/.test(reference)
  ) {
    throw invalidSecret();
  }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
