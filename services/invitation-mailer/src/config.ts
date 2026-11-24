import { randomUUID } from "node:crypto";

export type InvitationMailerConfig = {
  port: number;
  databaseUrl: string;
  tenantId?: string;
  workerId: string;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  secretSidecarUrl: URL;
  secretSidecarToken: string;
  privateKeyReferences: ReadonlyMap<string, string>;
  providerUrl: URL;
  providerSecretReference: string;
  sender: string;
  templateId: string;
  testRecipients?: ReadonlySet<string>;
  portalOrigin: string;
};

export function loadInvitationMailerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): InvitationMailerConfig {
  const production = environment.NODE_ENV === "production";
  const secretSidecarUrl = serviceUrl(
    required(environment.SECRET_SIDECAR_URL, "SECRET_SIDECAR_URL"),
    "SECRET_SIDECAR_URL",
    production,
  );
  const providerUrl = emailProviderUrl(
    required(environment.INVITATION_EMAIL_PROVIDER_URL, "INVITATION_EMAIL_PROVIDER_URL"),
    "INVITATION_EMAIL_PROVIDER_URL",
    production,
  );
  const portalUrl = new URL(required(environment.PORTAL_PUBLIC_ORIGIN, "PORTAL_PUBLIC_ORIGIN"));
  if (
    !["http:", "https:"].includes(portalUrl.protocol) ||
    portalUrl.pathname !== "/" || portalUrl.search || portalUrl.hash ||
    (production && portalUrl.protocol !== "https:")
  ) {
    throw new Error("PORTAL_PUBLIC_ORIGIN must be a secure HTTP(S) origin without a path");
  }

  return {
    port: integer(environment.PORT, 8085, 1, 65_535, "PORT"),
    databaseUrl: required(environment.INVITATION_MAILER_DATABASE_URL, "INVITATION_MAILER_DATABASE_URL"),
    tenantId: environment.INVITATION_MAILER_TENANT_ID
      ? uuid(environment.INVITATION_MAILER_TENANT_ID, "INVITATION_MAILER_TENANT_ID")
      : undefined,
    workerId: environment.INVITATION_MAILER_WORKER_ID
      ? uuid(environment.INVITATION_MAILER_WORKER_ID, "INVITATION_MAILER_WORKER_ID")
      : randomUUID(),
    pollIntervalMs: integer(environment.INVITATION_MAILER_POLL_INTERVAL_MS, 2_000, 250, 60_000, "INVITATION_MAILER_POLL_INTERVAL_MS"),
    batchSize: integer(environment.INVITATION_MAILER_BATCH_SIZE, 10, 1, 100, "INVITATION_MAILER_BATCH_SIZE"),
    maxAttempts: integer(environment.INVITATION_MAILER_MAX_ATTEMPTS, 8, 1, 25, "INVITATION_MAILER_MAX_ATTEMPTS"),
    secretSidecarUrl,
    secretSidecarToken: boundedSecret(required(environment.SECRET_SIDECAR_TOKEN, "SECRET_SIDECAR_TOKEN"), "SECRET_SIDECAR_TOKEN"),
    privateKeyReferences: parsePrivateKeyReferences(
      required(environment.INVITATION_TOKEN_PRIVATE_KEY_REFERENCES_JSON, "INVITATION_TOKEN_PRIVATE_KEY_REFERENCES_JSON"),
    ),
    providerUrl,
    providerSecretReference: secretReference(
      required(environment.INVITATION_EMAIL_PROVIDER_SECRET_REFERENCE, "INVITATION_EMAIL_PROVIDER_SECRET_REFERENCE"),
      "INVITATION_EMAIL_PROVIDER_SECRET_REFERENCE",
    ),
    sender: canonicalEmail(required(environment.INVITATION_EMAIL_FROM, "INVITATION_EMAIL_FROM"), "INVITATION_EMAIL_FROM"),
    templateId: boundedToken(required(environment.INVITATION_EMAIL_TEMPLATE_ID, "INVITATION_EMAIL_TEMPLATE_ID"), "INVITATION_EMAIL_TEMPLATE_ID"),
    testRecipients: parseTestRecipients(environment.WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST),
    portalOrigin: portalUrl.origin,
  };
}

function parseTestRecipients(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const name = "WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST";
  let entries: unknown;
  try {
    entries = JSON.parse(raw.trim() || "[]");
  } catch {
    throw new Error(`${name} must be a JSON array of email addresses`);
  }
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) {
    throw new Error(`${name} must be a JSON array of email addresses`);
  }
  return new Set(entries.map((entry, index) => canonicalEmail(entry, `${name}[${index}]`)));
}

function parsePrivateKeyReferences(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVITATION_TOKEN_PRIVATE_KEY_REFERENCES_JSON must be valid JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("INVITATION_TOKEN_PRIVATE_KEY_REFERENCES_JSON must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 10) {
    throw new Error("INVITATION_TOKEN_PRIVATE_KEY_REFERENCES_JSON must contain 1-10 key versions");
  }
  return new Map(entries.map(([version, reference]) => [
    boundedToken(version, "Invitation token key version"),
    secretReference(String(reference), "Invitation token private-key reference"),
  ]));
}

function serviceUrl(value: string, name: string, production: boolean) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.hash ||
    (production && url.protocol !== "https:")
  ) {
    throw new Error(`${name} must be an HTTPS service URL in production`);
  }
  return url;
}

function emailProviderUrl(value: string, name: string, production: boolean) {
  const url = new URL(value);
  const reservedHost = /(?:^|\.)(?:example|invalid|local|localhost|test)$/u.test(url.hostname)
    || /(?:^|\.)example\.(?:com|net|org)$/u.test(url.hostname)
    || ["127.0.0.1", "[::1]"].includes(url.hostname);
  const web = ["http:", "https:"].includes(url.protocol)
    && !url.username && !url.password && !url.hash
    && (!production || url.protocol === "https:");
  const smtp = ["smtp:", "smtps:"].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash
    && (url.pathname === "" || url.pathname === "/")
    && ((url.protocol === "smtp:" && url.port === "587")
      || (url.protocol === "smtps:" && url.port === "465"));
  if (reservedHost || (!web && !smtp)) {
    throw new Error(`${name} must be an HTTPS endpoint or credential-free SMTP submission URL`);
  }
  return url;
}

function secretReference(value: string, name: string) {
  if (value.length > 512 || !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function canonicalEmail(value: string, name: string) {
  const normalized = value.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  if (
    normalized.length > 320 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(normalized) ||
    /(?:^|\.)(?:invalid|local|localhost|example|test)$/u.test(domain) ||
    /(?:^|\.)example\.(?:com|net|org)$/u.test(domain)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function boundedToken(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || hasControlCharacter(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function boundedSecret(value: string, name: string) {
  if (value.length < 16 || value.length > 4_096 || hasControlCharacter(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function uuid(value: string, name: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function integer(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
