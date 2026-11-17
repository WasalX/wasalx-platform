export type MailerSecret = {
  apiKey?: string;
  smtpUsername?: string;
  token?: string;
  value?: string;
  privateKeyPem?: string;
  keyVersion?: string;
};

export interface MailerSecretResolver {
  resolve(reference: string): Promise<MailerSecret>;
  ready(): Promise<boolean>;
}

export class MailerSecretError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(
    code: string,
    retryable: boolean,
  ) {
    super("A required mailer secret is unavailable");
    this.name = "MailerSecretError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class SidecarMailerSecretResolver implements MailerSecretResolver {
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  constructor(
    baseUrl: URL,
    bearerToken: string,
  ) {
    this.baseUrl = baseUrl;
    this.bearerToken = bearerToken;
  }

  async resolve(reference: string) {
    if (!/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{0,510}$/u.test(reference)) {
      throw new MailerSecretError("SECRET_REFERENCE_INVALID", false);
    }
    try {
      const response = await fetch(new URL("/v1/resolve", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ reference }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new MailerSecretError(
          response.status === 404 ? "SECRET_NOT_FOUND" : "SECRET_RESOLVER_REJECTED",
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const value = await response.json() as MailerSecret;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new MailerSecretError("SECRET_VALUE_INVALID", false);
      }
      return value;
    } catch (error) {
      if (error instanceof MailerSecretError) throw error;
      throw new MailerSecretError("SECRET_RESOLVER_UNAVAILABLE", true);
    }
  }

  async ready() {
    try {
      const response = await fetch(new URL("/health", this.baseUrl), {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
