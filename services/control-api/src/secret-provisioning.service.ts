import { Injectable, OnModuleDestroy } from "@nestjs/common";

type ProvisionedWebhookSecret = {
  routeToken: string;
  hmacKey: string;
};

type ProvisionedMetaCredential = {
  accessToken: string;
  registrationPin?: string;
};
type ProvisionedRoutingCredential = { accessToken?: string;refreshToken?: string;hmacKey:string };

/**
 * Write-only client for the secret manager sidecar. Runtime secret resolution is
 * deliberately owned by WebhookSecretService and the connector worker instead.
 */
@Injectable()
export class SecretProvisioningService implements OnModuleDestroy {
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  private readonly controller = new AbortController();

  constructor() {
    this.baseUrl = new URL(required("SECRET_SIDECAR_URL"));
    this.bearerToken = secretSidecarWriteToken();
    if (process.env.NODE_ENV === "production" && this.baseUrl.protocol !== "https:") {
      throw new Error("Secret sidecar must use HTTPS in production");
    }
  }

  async storeWebhookSecret(reference: string, value: ProvisionedWebhookSecret) {
    validateReference(reference);
    validateSecret(value);
    await this.request("/v1/store", { reference, value }, false);
  }

  async storeMetaCredential(reference: string, value: ProvisionedMetaCredential) {
    validateReference(reference);
    validateMetaCredential(value);
    await this.request("/v1/store", { reference, value }, false);
  }

  async storeBotActionCredential(reference: string, accessToken: string) {
    validateReference(reference);
    validateToken(accessToken, "action credential");
    await this.request("/v1/store", { reference, value: { accessToken } }, false);
  }

  async storeRoutingCredential(reference:string,value:ProvisionedRoutingCredential){validateReference(reference);if(value.accessToken!==undefined)validateToken(value.accessToken,"access token");validateToken(value.hmacKey,"HMAC key");if(value.refreshToken!==undefined)validateToken(value.refreshToken,"refresh token");await this.request("/v1/store",{reference,value},false)}

  /** Deletion is intentionally idempotent so compensation can be safely retried. */
  async deleteSecret(reference: string) {
    validateReference(reference);
    await this.request("/v1/delete", { reference }, true);
  }

  async ready() {
    try {
      const response = await fetch(new URL("/health", this.baseUrl), {
        headers: { authorization: `Bearer ${this.bearerToken}`, accept: "application/json" },
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(2_000)]),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request(path: string, body: unknown, notFoundIsSuccess: boolean) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch {
      throw new SecretSidecarWriteError(
        "SECRET_SIDECAR_UNAVAILABLE",
        "The secret manager is temporarily unavailable.",
        true,
      );
    }
    if (notFoundIsSuccess && response.status === 404) return;
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new SecretSidecarWriteError(
        retryable ? "SECRET_SIDECAR_TEMPORARY_FAILURE" : "SECRET_SIDECAR_REQUEST_REJECTED",
        retryable
          ? "The secret manager is temporarily unavailable."
          : "The secret manager rejected the cleanup request.",
        retryable,
      );
    }
  }

  onModuleDestroy() {
    this.controller.abort();
  }
}

export class SecretSidecarWriteError extends Error {
  constructor(
    readonly code: string,
    readonly safeError: string,
    readonly retryable: boolean,
  ) {
    super(safeError);
    this.name = "SecretSidecarWriteError";
  }
}

function validateReference(reference: string) {
  if (Buffer.byteLength(reference, "utf8") > 512 || !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/.test(reference)) {
    throw new Error("Invalid secret reference");
  }
}

function validateSecret(value: ProvisionedWebhookSecret) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value.routeToken) || !/^[A-Za-z0-9_-]{32,256}$/.test(value.hmacKey)) {
    throw new Error("Invalid generated webhook secret");
  }
}

function validateMetaCredential(value: ProvisionedMetaCredential) {
  validateToken(value.accessToken,"access token");
  if (value.registrationPin !== undefined && !/^\d{6}$/u.test(value.registrationPin)) throw new Error("Invalid registration PIN");
}

function validateToken(value:string,label:string){if(!value||value.length<16||value.length>4_096||Array.from(value).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127}))throw new Error(`Invalid ${label}`)}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secretSidecarWriteToken() {
  const dedicated = process.env.SECRET_SIDECAR_WRITE_TOKEN;
  if (dedicated) {
    if (process.env.NODE_ENV === "production" && dedicated === process.env.SECRET_SIDECAR_TOKEN) {
      throw new Error("Secret sidecar read and write credentials must be distinct in production");
    }
    return dedicated;
  }
  if (process.env.NODE_ENV !== "production") return required("SECRET_SIDECAR_TOKEN");
  throw new Error("SECRET_SIDECAR_WRITE_TOKEN is required in production");
}
