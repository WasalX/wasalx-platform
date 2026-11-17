import { Injectable } from "@nestjs/common";

export type WahaAuthenticatorTransport =
  | "ble"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export type WahaPasskeyChallenge = {
  challenge: string;
  timeout?: number;
  rpId: "web.whatsapp.com";
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: WahaAuthenticatorTransport[];
  }>;
  userVerification?: "discouraged" | "preferred" | "required";
};

export type WahaPasskeyAssertion = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
};

export interface WahaAuthorizationClient {
  getQr(): Promise<{ mimeType: "image/png"; data: string }>;
  requestPairingCode(phoneNumber: string): Promise<{ code: string }>;
  getPasskeyChallenge(): Promise<WahaPasskeyChallenge>;
  submitPasskey(assertion: WahaPasskeyAssertion): Promise<{ accepted: true }>;
  getPasskeyConfirmation(): Promise<{ code: string }>;
  confirmPasskey(): Promise<{ confirmed: true }>;
}

export interface WahaAuthorizationClientProvider {
  create(apiKey: string, opaqueSessionId: string, baseUrl: string): WahaAuthorizationClient;
}

const AUTHENTICATOR_TRANSPORTS = new Set<WahaAuthenticatorTransport>([
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
const BASE64_VALUE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_JSON_BYTES = 3_000_000;

@Injectable()
export class WahaAuthorizationClientFactory
  implements WahaAuthorizationClientProvider
{
  create(apiKey: string, opaqueSessionId: string, baseUrl: string): WahaAuthorizationClient {
    return new HttpWahaAuthorizationClient(
      privateWahaBaseUrl(baseUrl),
      validatedApiKey(apiKey),
      validatedSessionId(opaqueSessionId),
    );
  }
}

export class HttpWahaAuthorizationClient implements WahaAuthorizationClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly apiKey: string,
    private readonly sessionId: string,
  ) {}

  async getQr() {
    const value = await this.request(
      `/api/${encodeURIComponent(this.sessionId)}/auth/qr?format=image`,
    );
    const record = objectValue(value);
    const mimeType = stringValue(record?.mimetype);
    const raw = stringValue(record?.data);
    const data = raw?.startsWith("data:image/png;base64,")
      ? raw.slice("data:image/png;base64,".length)
      : raw;
    if (mimeType !== "image/png" || !data || !validPngBase64(data)) {
      throw invalidResponse("WAHA returned an invalid QR image.");
    }
    return { mimeType, data } as const;
  }

  async requestPairingCode(phoneNumber: string) {
    const normalized = normalizeInternationalPhone(phoneNumber);
    const value = await this.request(
      `/api/${encodeURIComponent(this.sessionId)}/auth/request-code`,
      {
        method: "POST",
        body: JSON.stringify({ phoneNumber: normalized.slice(1) }),
      },
    );
    const code = stringValue(objectValue(value)?.code);
    if (!code || code.length > 32 || !/^[A-Za-z0-9-]+$/.test(code)) {
      throw invalidResponse("WAHA returned an invalid pairing code.");
    }
    return { code };
  }

  async getPasskeyChallenge() {
    const value = await this.request(
      `/api/${encodeURIComponent(this.sessionId)}/auth/passkey/challenge`,
    );
    return sanitizedPasskeyChallenge(value);
  }

  async submitPasskey(assertion: WahaPasskeyAssertion) {
    await this.request(
      `/api/${encodeURIComponent(this.sessionId)}/auth/passkey`,
      {
        method: "POST",
        body: JSON.stringify(sanitizedPasskeyAssertion(assertion)),
      },
    );
    return { accepted: true } as const;
  }

  async getPasskeyConfirmation() {
    const value = await this.request(
      `/api/${encodeURIComponent(this.sessionId)}/auth/passkey/confirmation`,
    );
    const code = stringValue(objectValue(value)?.code);
    if (!code || code.length > 32 || !/^[A-Za-z0-9-]+$/.test(code)) {
      throw invalidResponse("WAHA returned an invalid passkey confirmation code.");
    }
    return { code };
  }

  async confirmPasskey() {
    await this.request(
      `/api/${encodeURIComponent(this.sessionId)}/auth/passkey/confirm`,
      { method: "POST", body: "{}" },
    );
    return { confirmed: true } as const;
  }

  private async request(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new WahaAuthorizationProviderError(
          response.status === 404 || response.status === 409 || response.status === 422
            ? "WAHA_AUTH_STATE_CHANGED"
            : "WAHA_AUTH_REJECTED",
          response.status === 404 || response.status === 409 || response.status === 422
            ? "The WhatsApp authorization step changed. Refresh the connection and try the action shown there."
            : retryable
              ? "WhatsApp authorization is temporarily unavailable."
              : "WhatsApp rejected the authorization request.",
          retryable,
          response.status,
          true,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
        throw invalidResponse("WAHA returned an oversized authorization response.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_JSON_BYTES) {
        throw invalidResponse("WAHA returned an oversized authorization response.");
      }
      if (bytes.byteLength === 0) return undefined;
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw invalidResponse("WAHA returned an invalid authorization response.");
      }
    } catch (error) {
      if (error instanceof WahaAuthorizationProviderError) throw error;
      throw new WahaAuthorizationProviderError(
        "WAHA_AUTH_NETWORK",
        "WhatsApp authorization is temporarily unavailable.",
        true,
        undefined,
        false,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class WahaAuthorizationProviderError extends Error {
  constructor(
    readonly code: string,
    readonly safeError: string,
    readonly retryable: boolean,
    readonly providerStatus: number | undefined,
    /** False means the provider might have received a mutating request. */
    readonly outcomeKnown: boolean,
  ) {
    super(safeError);
    this.name = "WahaAuthorizationProviderError";
  }
}

export function normalizeInternationalPhone(value: string) {
  const normalized = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{5,19}$/.test(normalized)) {
    throw new WahaAuthorizationProviderError(
      "WAHA_AUTH_INVALID_PHONE",
      "Enter a valid phone number in international format, for example +9665XXXXXXXX.",
      false,
      undefined,
      true,
    );
  }
  return normalized;
}

export function sanitizedPasskeyAssertion(value: unknown): WahaPasskeyAssertion {
  const record = objectValue(value);
  const response = objectValue(record?.response);
  const id = boundedBase64(record?.id);
  const rawId = boundedBase64(record?.rawId);
  const clientDataJSON = boundedBase64(response?.clientDataJSON, 65_536);
  const authenticatorData = boundedBase64(response?.authenticatorData, 65_536);
  const signature = boundedBase64(response?.signature, 65_536);
  if (
    !id ||
    !rawId ||
    record?.type !== "public-key" ||
    !clientDataJSON ||
    !authenticatorData ||
    !signature
  ) {
    throw new WahaAuthorizationProviderError(
      "WAHA_AUTH_INVALID_ASSERTION",
      "The passkey response is invalid. Start the passkey step again.",
      false,
      undefined,
      true,
    );
  }
  const userHandle =
    response?.userHandle === null
      ? null
      : boundedBase64(response?.userHandle, 65_536);
  return {
    id,
    rawId,
    type: "public-key",
    response: {
      clientDataJSON,
      authenticatorData,
      signature,
      ...(userHandle !== undefined ? { userHandle } : {}),
    },
  };
}

function sanitizedPasskeyChallenge(value: unknown): WahaPasskeyChallenge {
  const record = objectValue(value);
  const challenge = boundedBase64(record?.challenge);
  const rpId = stringValue(record?.rpId);
  if (!challenge || rpId !== "web.whatsapp.com") {
    throw invalidResponse("WAHA returned an invalid passkey challenge.");
  }
  const result: WahaPasskeyChallenge = { challenge, rpId };
  const timeout = numberValue(record?.timeout);
  if (timeout !== undefined && timeout > 0 && timeout <= 300_000) {
    result.timeout = timeout;
  }
  const verification = stringValue(record?.userVerification);
  if (
    verification === "discouraged" ||
    verification === "preferred" ||
    verification === "required"
  ) {
    result.userVerification = verification;
  }
  if (record?.allowCredentials !== undefined) {
    if (
      !Array.isArray(record.allowCredentials) ||
      record.allowCredentials.length > 100
    ) {
      throw invalidResponse("WAHA returned invalid passkey credentials.");
    }
    result.allowCredentials = record.allowCredentials.map((value) => {
      const credential = objectValue(value);
      const id = boundedBase64(credential?.id);
      if (!id || credential?.type !== "public-key") {
        throw invalidResponse("WAHA returned invalid passkey credentials.");
      }
      const transports = Array.isArray(credential.transports)
        ? credential.transports.filter(
            (transport): transport is WahaAuthenticatorTransport =>
              typeof transport === "string" &&
              AUTHENTICATOR_TRANSPORTS.has(
                transport as WahaAuthenticatorTransport,
              ),
          )
        : undefined;
      return {
        id,
        type: "public-key" as const,
        ...(transports?.length ? { transports } : {}),
      };
    });
  }
  return result;
}

export function privateWahaBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("WAHA_ADMIN_BASE_URL must be a valid private URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !isPrivateHost(parsed.hostname)
  ) {
    throw new Error("WAHA_ADMIN_BASE_URL must target a private WAHA endpoint");
  }
  return parsed;
}

function isPrivateHost(rawHostname: string) {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".svc") ||
    hostname.endsWith(".svc.cluster.local") ||
    (!hostname.includes(".") && /^[a-z0-9][a-z0-9-]*$/.test(hostname))
  ) {
    return true;
  }
  const parts = hostname.split(".").map(Number);
  if (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }
  return hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8");
}

function validPngBase64(value: string) {
  if (value.length > 2_000_000 || !BASE64_VALUE.test(value)) return false;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(normalized, "base64");
    return (
      bytes.byteLength >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  } catch {
    return false;
  }
}

function invalidResponse(message: string) {
  return new WahaAuthorizationProviderError(
    "WAHA_AUTH_INVALID_RESPONSE",
    message,
    false,
    undefined,
    true,
  );
}

function validatedApiKey(value: string) {
  if (
    value.length < 16 ||
    value.length > 512 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("WAHA administrative secret is invalid");
  }
  return value;
}

function validatedSessionId(value: string) {
  if (
    !value ||
    value.length > 256 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("WAHA session identifier is invalid");
  }
  return value;
}

function boundedBase64(value: unknown, maxLength = 16_384) {
  const normalized = stringValue(value);
  return normalized &&
    normalized.length <= maxLength &&
    BASE64_VALUE.test(normalized)
    ? normalized
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
