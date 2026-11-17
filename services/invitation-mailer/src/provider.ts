import {
  constants,
  createHash,
  createPrivateKey,
  privateDecrypt,
} from "node:crypto";
import nodemailer from "nodemailer";
import { canonicalEmail } from "./config.js";
import type { MailerSecretResolver } from "./secrets.js";

const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class InvitationDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;
  constructor(
    code: string,
    retryable: boolean,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "InvitationDeliveryError";
    this.code = code;
    this.retryable = retryable;
    this.safeMessage = safeMessage;
  }
}

export type TransactionalEmailInput = {
  recipient: string;
  sender: string;
  templateId: string;
  acceptanceUrl: string;
  expiresAt?: string;
  idempotencyKey: string;
  deliveryId: string;
};

export interface TransactionalEmailProvider {
  send(input: TransactionalEmailInput): Promise<{ messageId: string }>;
}

export async function invitationDeliverySecretsReady(input: {
  providerSecretReference: string;
  privateKeyReferences: ReadonlyMap<string, string>;
  secrets: MailerSecretResolver;
}) {
  try {
    const provider = await input.secrets.resolve(input.providerSecretReference);
    const credential = provider.apiKey ?? provider.token ?? provider.value;
    if (!credential || credential.length < 8 || credential.length > 4_096 || hasControlCharacter(credential)) {
      return false;
    }
    for (const [version, reference] of input.privateKeyReferences) {
      const secret = await input.secrets.resolve(reference);
      if (secret.keyVersion !== undefined && secret.keyVersion !== version) return false;
      const pem = secret.privateKeyPem ?? secret.value;
      if (!pem || pem.length > 16_384) return false;
      createPrivateKey(pem);
    }
    return true;
  } catch {
    return false;
  }
}

export class HttpsTransactionalEmailProvider implements TransactionalEmailProvider {
  private readonly endpoint: URL;
  private readonly secretReference: string;
  private readonly secrets: MailerSecretResolver;
  constructor(
    endpoint: URL,
    secretReference: string,
    secrets: MailerSecretResolver,
  ) {
    this.endpoint = endpoint;
    this.secretReference = secretReference;
    this.secrets = secrets;
  }

  async send(input: TransactionalEmailInput) {
    validateTransactionalEmailInput(input);
    const secret = await this.secrets.resolve(this.secretReference);
    const apiKey = secret.apiKey ?? secret.token ?? secret.value;
    if (!apiKey || apiKey.length < 8 || apiKey.length > 4_096 || hasControlCharacter(apiKey)) {
      throw new InvitationDeliveryError(
        "EMAIL_PROVIDER_CREDENTIAL_INVALID",
        false,
        "The transactional email credential is invalid.",
      );
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.sender,
          to: [input.recipient],
          template_id: input.templateId,
          personalization: {
            acceptance_url: input.acceptanceUrl,
            ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new InvitationDeliveryError(
        "EMAIL_PROVIDER_UNAVAILABLE",
        true,
        "The transactional email provider is temporarily unavailable.",
      );
    }

    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409 ||
        response.status === 425 || response.status === 429 || response.status >= 500;
      throw new InvitationDeliveryError(
        `EMAIL_PROVIDER_${response.status}`,
        retryable,
        retryable
          ? "The transactional email provider temporarily rejected delivery."
          : "The transactional email provider rejected the invitation.",
      );
    }

    const receipt = await boundedJson(response);
    const candidate = isRecord(receipt)
      ? receipt.id ?? receipt.message_id ?? receipt.messageId
      : undefined;
    if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 512 || hasControlCharacter(candidate)) {
      throw new InvitationDeliveryError(
        "EMAIL_PROVIDER_RECEIPT_INVALID",
        true,
        "The transactional email provider did not return a valid receipt.",
      );
    }
    return { messageId: candidate.trim() };
  }

  async ready() {
    return true;
  }
}

type SmtpDeliveryResult = {
  accepted?: unknown[];
  rejected?: unknown[];
  pending?: unknown[];
  messageId?: unknown;
};
type SmtpMailer = {
  verify(): Promise<unknown>;
  sendMail(message: ReturnType<typeof smtpInvitationMessage>): Promise<SmtpDeliveryResult>;
  close(): void;
};
type SmtpMailerFactory = (options: ReturnType<typeof smtpTransportOptions>) => SmtpMailer;
const createSmtpMailer: SmtpMailerFactory = options => nodemailer.createTransport(options);
const SMTP_READY_SUCCESS_CACHE_MS = 60_000;
const SMTP_READY_FAILURE_CACHE_MS = 60_000;

export class SmtpTransactionalEmailProvider implements TransactionalEmailProvider {
  private readonly endpoint: URL;
  private readonly secretReference: string;
  private readonly secrets: MailerSecretResolver;
  private readonly sender: string;
  private readonly mailerFactory: SmtpMailerFactory;
  private readonly now: () => number;
  private verifiedUntil = 0;
  private verificationFailedUntil = 0;
  private verificationInFlight: Promise<boolean> | undefined;
  constructor(
    endpoint: URL,
    secretReference: string,
    secrets: MailerSecretResolver,
    sender: string,
    mailerFactory: SmtpMailerFactory = createSmtpMailer,
    now: () => number = Date.now,
  ) {
    this.endpoint = endpoint;
    this.secretReference = secretReference;
    this.secrets = secrets;
    this.sender = sender;
    this.mailerFactory = mailerFactory;
    this.now = now;
  }

  async send(input: TransactionalEmailInput) {
    validateTransactionalEmailInput(input);
    if (input.sender !== this.sender) {
      throw new InvitationDeliveryError("EMAIL_PROVIDER_SENDER_INVALID", false, "The SMTP sender is invalid.");
    }
    const { username, password } = await this.credentials();
    const transporter = this.mailerFactory(smtpTransportOptions(this.endpoint, username, password));
    try {
      const result = await transporter.sendMail(smtpInvitationMessage(input));
      const accepted = (result.accepted ?? []).map(String);
      const rejected = result.rejected ?? [];
      const pending = result.pending ?? [];
      if (accepted.length !== 1 || accepted[0].toLowerCase() !== input.recipient.toLowerCase() || rejected.length || pending.length) {
        throw new InvitationDeliveryError(
          pending.length ? "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN" : "EMAIL_PROVIDER_SMTP_REJECTED",
          false,
          pending.length ? "SMTP delivery requires operator verification." : "The SMTP provider rejected the invitation.",
        );
      }
      const messageId = typeof result.messageId === "string" ? result.messageId.trim() : "";
      if (!messageId || messageId.length > 512 || hasControlCharacter(messageId)) {
        throw new InvitationDeliveryError(
          "EMAIL_PROVIDER_RECEIPT_INVALID",
          false,
          "The SMTP provider did not return a valid receipt.",
        );
      }
      return { messageId };
    } catch (error) {
      if (error instanceof InvitationDeliveryError) throw error;
      const failure = classifySmtpFailure(error);
      throw new InvitationDeliveryError(
        failure.code,
        failure.retryable,
        failure.retryable
          ? "The SMTP provider is temporarily unavailable before delivery."
          : "SMTP delivery requires operator verification before any resend.",
      );
    } finally {
      transporter.close();
    }
  }

  async ready() {
    const now = this.now();
    if (now < this.verifiedUntil) return true;
    if (now < this.verificationFailedUntil) return false;
    if (this.verificationInFlight) return this.verificationInFlight;
    const verification = this.verifyReady();
    this.verificationInFlight = verification;
    try {
      return await verification;
    } finally {
      if (this.verificationInFlight === verification) this.verificationInFlight = undefined;
    }
  }

  private async verifyReady() {
    let transporter: SmtpMailer | undefined;
    try {
      const { username, password } = await this.credentials();
      transporter = this.mailerFactory(smtpTransportOptions(this.endpoint, username, password));
      await transporter.verify();
      this.verifiedUntil = this.now() + SMTP_READY_SUCCESS_CACHE_MS;
      this.verificationFailedUntil = 0;
      return true;
    } catch {
      this.verificationFailedUntil = this.now() + SMTP_READY_FAILURE_CACHE_MS;
      return false;
    } finally {
      transporter?.close();
    }
  }

  private async credentials() {
    const secret = await this.secrets.resolve(this.secretReference);
    const password = secret.apiKey ?? secret.token ?? secret.value;
    if (!password || password.length < 8 || password.length > 4_096 || hasControlCharacter(password)) {
      throw new InvitationDeliveryError(
        "EMAIL_PROVIDER_CREDENTIAL_INVALID",
        false,
        "The transactional email credential is invalid.",
      );
    }
    let username = this.sender;
    if (secret.smtpUsername !== undefined) {
      try {
        username = canonicalEmail(secret.smtpUsername, "SMTP login");
      } catch {
        throw new InvitationDeliveryError(
          "EMAIL_PROVIDER_CREDENTIAL_INVALID", false, "The transactional email credential is invalid.",
        );
      }
    }
    return { username, password };
  }
}

function validateTransactionalEmailInput(input: TransactionalEmailInput) {
  try {
    if (canonicalEmail(input.recipient, "Invitation recipient") !== input.recipient) throw new Error();
  } catch {
    throw new InvitationDeliveryError("EMAIL_PROVIDER_RECIPIENT_INVALID", false, "The invitation recipient is invalid.");
  }
  try {
    if (canonicalEmail(input.sender, "Invitation sender") !== input.sender) throw new Error();
  } catch {
    throw new InvitationDeliveryError("EMAIL_PROVIDER_SENDER_INVALID", false, "The invitation sender is invalid.");
  }
  if (!UUID.test(input.deliveryId)) {
    throw new InvitationDeliveryError("EMAIL_PROVIDER_DELIVERY_ID_INVALID", false, "The invitation delivery identity is invalid.");
  }
}

export function smtpTransportOptions(endpoint: URL, username: string, password: string) {
  return {
    host: endpoint.hostname,
    port: Number(endpoint.port),
    secure: endpoint.protocol === "smtps:",
    requireTLS: endpoint.protocol === "smtp:",
    auth: { user: username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { servername: endpoint.hostname, rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
  };
}

export function smtpInvitationMessage(input: TransactionalEmailInput) {
  const senderDomain = input.sender.slice(input.sender.lastIndexOf("@") + 1).toLowerCase();
  const receiptKey = createHash("sha256").update("wasalx-invitation\0").update(input.deliveryId).digest("hex");
  const expiry = input.expiresAt ? `\n\nThis invitation expires at ${input.expiresAt}.` : "";
  return {
    from: input.sender,
    to: input.recipient,
    subject: "You're invited to WasalX",
    text: `You have been invited to WasalX.\n\nOpen this secure link to accept the invitation:\n${input.acceptanceUrl}${expiry}`,
    html: `<p>You have been invited to WasalX.</p><p><a href="${escapeHtml(input.acceptanceUrl)}">Accept the invitation</a></p>${input.expiresAt ? `<p>This invitation expires at ${escapeHtml(input.expiresAt)}.</p>` : ""}`,
    messageId: `<wasalx-invite-${receiptKey}@${senderDomain}>`,
    headers: { "X-WasalX-Template": input.templateId },
  };
}

export function classifySmtpFailure(error: unknown) {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const command = typeof candidate.command === "string" ? candidate.command.toUpperCase() : "";
  const responseCode = typeof candidate.responseCode === "number" ? candidate.responseCode : 0;
  const preConnect = candidate.code === "EDNS" || candidate.errno === "ECONNREFUSED";
  const preData = /^(?:EHLO|HELO|AUTH(?:\s+\S+)?|MAIL FROM|RCPT TO)$/u.test(command);
  const transient = [421, 450, 451, 452, 454].includes(responseCode);
  if (preConnect || preData) return preConnect || transient
    ? { code: "EMAIL_PROVIDER_SMTP_UNAVAILABLE", retryable: true }
    : { code: "EMAIL_PROVIDER_SMTP_REJECTED", retryable: false };
  return { code: "EMAIL_PROVIDER_SMTP_OUTCOME_UNKNOWN", retryable: false };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

export async function decryptInvitationToken(input: {
  ciphertext: Buffer;
  keyVersion: string;
  privateKeyReferences: ReadonlyMap<string, string>;
  secrets: MailerSecretResolver;
}) {
  const reference = input.privateKeyReferences.get(input.keyVersion);
  if (!reference) {
    throw new InvitationDeliveryError(
      "INVITATION_KEY_VERSION_UNKNOWN",
      false,
      "The invitation encryption key version is unavailable.",
    );
  }
  const secret = await input.secrets.resolve(reference);
  if (secret.keyVersion !== undefined && secret.keyVersion !== input.keyVersion) {
    throw new InvitationDeliveryError(
      "INVITATION_KEY_VERSION_MISMATCH",
      false,
      "The invitation encryption key version does not match.",
    );
  }
  const pem = secret.privateKeyPem ?? secret.value;
  if (!pem || pem.length > 16_384) {
    throw new InvitationDeliveryError(
      "INVITATION_PRIVATE_KEY_INVALID",
      false,
      "The invitation encryption key is invalid.",
    );
  }
  try {
    const plaintext = privateDecrypt(
      {
        key: createPrivateKey(pem),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      input.ciphertext,
    );
    if (plaintext.byteLength > 256) throw new Error("plaintext_too_large");
    const payload = JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
    if (
      !isRecord(payload) || Object.keys(payload).length !== 1 ||
      typeof payload.token !== "string" || !INVITATION_TOKEN.test(payload.token)
    ) {
      throw new Error("invalid_envelope");
    }
    return payload.token;
  } catch {
    throw new InvitationDeliveryError(
      "INVITATION_DECRYPTION_FAILED",
      false,
      "The invitation token could not be decrypted.",
    );
  }
}

export function buildInvitationAcceptanceUrl(portalOrigin: string, token: string) {
  if (!INVITATION_TOKEN.test(token)) {
    throw new InvitationDeliveryError(
      "INVITATION_TOKEN_INVALID",
      false,
      "The invitation token is invalid.",
    );
  }
  const url = new URL("/invitations/accept", portalOrigin);
  // The token stays after `#`, so browsers do not send it in HTTP requests,
  // reverse-proxy logs, Referer headers, or server-rendered page probes.
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

async function boundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 16_384) {
    throw new InvitationDeliveryError(
      "EMAIL_PROVIDER_RECEIPT_TOO_LARGE",
      true,
      "The transactional email provider returned an invalid receipt.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 16_384) {
      await reader.cancel();
      throw new InvitationDeliveryError(
        "EMAIL_PROVIDER_RECEIPT_TOO_LARGE",
        true,
        "The transactional email provider returned an invalid receipt.",
      );
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new InvitationDeliveryError(
      "EMAIL_PROVIDER_RECEIPT_INVALID",
      true,
      "The transactional email provider returned an invalid receipt.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
