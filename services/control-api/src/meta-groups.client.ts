import { readMetaTemplateInventory } from '@wasalx/core/meta-template-inventory';
import { Injectable } from "@nestjs/common";
import { recordStructuredLog, safeRequestId } from "@wasalx/observability";
import { metaThreadControlBody, type MetaRoutingRole } from "@wasalx/core/meta-routing";
import { parseWahaTestRecipientAllowlist } from "@wasalx/core/waha-test-recipient-scope";
import { metaTestSendAllowed } from "@wasalx/core/meta-test-recipient-scope";
import { MetaAccountRelationError, MetaCredentialMetadataError, verifyMetaAccountRelation, verifyMetaCredentialMetadata, type MetaAccountRelation, type MetaCredentialMetadata } from "@wasalx/core/meta-account-relation";

const GRAPH_VERSION = /^v\d{1,3}\.\d{1,3}$/u;
const META_ID = /^[A-Za-z0-9_-]{1,510}={0,2}$/u;
const INVITE_LINK = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,256}$/u;
const MAX_JSON_BYTES = 1_048_576;

export const META_GROUPS_DOCUMENTATION_URL =
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/";

export type MetaGroupsCapability = {
  eligible: boolean;
  state:
    | "AVAILABLE"
    | "CREDENTIAL_INVALID"
    | "PERMISSION_REQUIRED"
    | "NOT_ELIGIBLE"
    | "TEMPORARILY_UNAVAILABLE";
  reasonCode?: string;
  checkedAt: string;
  evidence: "provider_probe";
  constraints: {
    officialBusinessAccountRequired: true;
    inviteOnly: true;
    maxParticipants: 8;
    maxGroupsPerNumber: 10_000;
    unavailableForBusinessAppNumbers: true;
    unavailableForMultiSolutionConversations: true;
  };
  documentationUrl: typeof META_GROUPS_DOCUMENTATION_URL;
};

export type CreateOfficialGroupInput = {
  subject: string;
  description?: string;
  joinApprovalMode?: "approval_required" | "auto_approve";
};

export type UpdateOfficialGroupInput = {
  subject?: string;
  description?: string;
};

export interface MetaGroupsControlClient {
  threadControl(action: "take" | "pass" | "release", targetRole: MetaRoutingRole | undefined, recipient: {kind:"PHONE"|"BSUID";value:string}, operationId: string): Promise<{requestId:string}>;
  verifyPhoneNumber(): Promise<void>;
  verifyCredentialMetadata(appId: string, appSecret: string, purpose?: "WHATSAPP" | "FINANCIAL"): Promise<MetaCredentialMetadata>;
  verifyPhoneAccountRelationship(wabaId: string): Promise<MetaAccountRelation>;
  capability(): Promise<MetaGroupsCapability>;
  createGroup(input: CreateOfficialGroupInput): Promise<{ requestId: string }>;
  getInviteLink(groupId: string): Promise<{ inviteLink: string }>;
  resetInviteLink(groupId: string): Promise<{ inviteLink: string }>;
  updateGroup(groupId: string, input: UpdateOfficialGroupInput): Promise<{ updated: true }>;
}

export interface MetaGroupsClientProvider {
  create(accessToken: string, phoneNumberId: string, beforeRequest?: () => Promise<void>): MetaGroupsControlClient;
}

@Injectable()
export class MetaGroupsClientFactory implements MetaGroupsClientProvider {
  private readonly graphVersion: string;
  private readonly baseUrl: URL;

  constructor() {
    this.graphVersion = process.env.META_GRAPH_VERSION ?? "";
    if (!GRAPH_VERSION.test(this.graphVersion)) {
      throw new Error("META_GRAPH_VERSION must use the form vNN.N");
    }
    this.baseUrl = graphBaseUrl(process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com");
  }

  create(accessToken: string, phoneNumberId: string, beforeRequest?: () => Promise<void>) {
    return new HttpMetaGroupsClient(this.baseUrl, this.graphVersion, accessToken, phoneNumberId, beforeRequest);
  }
}

export class HttpMetaGroupsClient implements MetaGroupsControlClient {
  private readonly testRecipients = parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST);
  constructor(
    private readonly baseUrl: URL,
    private readonly graphVersion: string,
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly beforeRequest?: () => Promise<void>,
  ) {
    validateAccessToken(accessToken);
    validatedId(phoneNumberId, "phone-number ID");
  }


  templateInventory(accountId: string) {
    const signal = AbortSignal.timeout(10_000);
    return readMetaTemplateInventory(accountId, (path, query) => this.request(path, "GET", "read", undefined, query, signal));
  }

  async threadControl(action: "take" | "pass" | "release", targetRole: MetaRoutingRole | undefined, recipient: {kind:"PHONE"|"BSUID";value:string}, operationId: string) {
    this.assertTestScope({ recipient_type: "individual", ...(recipient.kind === "PHONE" ? { to: recipient.value } : { recipient: recipient.value }) });
    const value = await this.request(`/${encodeURIComponent(this.phoneNumberId)}/thread_control`, "POST", "mutation",
      metaThreadControlBody(action, targetRole, recipient, operationId));
    const body = objectValue(value), requestId = body?.request_id;
    if (body?.messaging_product !== "whatsapp" || typeof requestId !== "string" || !/^[A-Za-z0-9._:=-]{1,512}$/u.test(requestId))
      throw invalidResponse("Meta returned an uncertain thread-control receipt.", false);
    return { requestId };
  }

  async verifyCredentialMetadata(appId: string, appSecret: string, purpose: "WHATSAPP" | "FINANCIAL" = "WHATSAPP"): Promise<MetaCredentialMetadata> {
    if (!/^\d{5,32}$/u.test(appId)) throw invalidInput("The configured Meta application is invalid.");
    validateAccessToken(appSecret);
    if (appSecret.includes("|")) throw invalidInput("The configured Meta application credentials are invalid.");
    try {
      // The subject token is inspected using the separately configured app credential.
      const value = await this.request("/debug_token", "GET", "read", undefined,
        { input_token: this.accessToken }, undefined, `${appId}|${appSecret}`);
      return verifyMetaCredentialMetadata(value, { appId, purpose });
    } catch (error) {
      if (error instanceof MetaCredentialMetadataError) throw new MetaGraphClientError(error.code, error.message, false, undefined, true);
      throw error;
    }
  }

  async verifyPhoneNumber(): Promise<void> {
    const value = objectValue(await this.request(
      `/${encodeURIComponent(this.phoneNumberId)}`,
      "GET",
      "read",
      undefined,
      { fields: "id" },
    ));
    if (value?.id !== this.phoneNumberId) {
      throw invalidResponse("Meta credentials do not match this phone number.", true);
    }
  }

  async verifyPhoneAccountRelationship(wabaId: string): Promise<MetaAccountRelation> {
    try {
      return await verifyMetaAccountRelation(this.phoneNumberId, wabaId, this.graphVersion,
        (query, signal) => this.request(`/${encodeURIComponent(wabaId)}/phone_numbers`, "GET", "read", undefined, query, signal));
    } catch (error) {
      if (error instanceof MetaAccountRelationError) throw new MetaGraphClientError(error.code, error.message, false, undefined, true);
      throw error;
    }
  }

  async capability(): Promise<MetaGroupsCapability> {
    this.assertTestScope();
    try {
      const value = await this.request(
        `/${encodeURIComponent(this.phoneNumberId)}/groups`,
        "GET",
        "read",
        undefined,
        { fields: "id,subject,total_participant_count", limit: "1" },
      );
      if (!Array.isArray(objectValue(value)?.data)) {
        throw invalidResponse("Meta returned an invalid Groups capability response.", true);
      }
      return capability(true, "AVAILABLE");
    } catch (error) {
      if (!(error instanceof MetaGraphClientError)) throw error;
      if (error.code.startsWith("META_CREDENTIAL_")) throw error;
      if (error.retryable) return capability(false, "TEMPORARILY_UNAVAILABLE", error.code);
      if (error.code === "META_AUTHENTICATION_FAILED") {
        return capability(false, "CREDENTIAL_INVALID", error.code);
      }
      if (error.providerStatus === 403) {
        return capability(false, "PERMISSION_REQUIRED", error.code);
      }
      return capability(false, "NOT_ELIGIBLE", error.code);
    }
  }

  async createGroup(input: CreateOfficialGroupInput) {
    this.assertTestScope();
    const value = await this.request(
      `/${encodeURIComponent(this.phoneNumberId)}/groups`,
      "POST",
      "mutation",
      validatedCreate(input),
    );
    const requestId = boundedString(objectValue(value)?.request_id, 512);
    if (!requestId) {
      throw invalidResponse(
        "Meta accepted the group request but returned an invalid operation response.",
        false,
      );
    }
    return { requestId };
  }

  async getInviteLink(groupId: string) {
    this.assertTestScope();
    const id = validatedId(groupId, "group ID");
    const value = await this.request(
      `/${encodeURIComponent(id)}/invite_link`,
      "GET",
      "read",
    );
    return { inviteLink: inviteLink(value, true) };
  }

  async resetInviteLink(groupId: string) {
    this.assertTestScope();
    const id = validatedId(groupId, "group ID");
    const value = await this.request(
      `/${encodeURIComponent(id)}/invite_link`,
      "POST",
      "mutation",
      { messaging_product: "whatsapp" },
    );
    return { inviteLink: inviteLink(value, false) };
  }

  async updateGroup(groupId: string, input: UpdateOfficialGroupInput) {
    this.assertTestScope();
    const id = validatedId(groupId, "group ID");
    const value = await this.request(
      `/${encodeURIComponent(id)}`,
      "POST",
      "mutation",
      validatedUpdate(input),
    );
    const record = objectValue(value);
    if (record?.success !== true && record?.messaging_product !== "whatsapp") {
      throw invalidResponse(
        "Meta accepted the group update but returned an invalid operation response.",
        false,
      );
    }
    return { updated: true as const };
  }

  private assertTestScope(body: unknown = { recipient_type: "group" }) {
    if (metaTestSendAllowed(this.testRecipients, body)) return;
    const errorCode = "META_TEST_RECIPIENT_NOT_ALLOWED";
    recordStructuredLog("warn", "meta.test_recipient_scope_refused", {
      request_id: safeRequestId(), component: "meta-groups-client", error_code: errorCode,
    });
    throw new MetaGraphClientError(errorCode, "The recipient is outside the configured test scope.", false, undefined, true);
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    semantics: "read" | "mutation",
    body?: unknown,
    query?: Record<string, string>,
    signal?: AbortSignal,
    bearerToken: string = this.accessToken,
  ) {
    return metaGraphRequest({ baseUrl: this.baseUrl, graphVersion: this.graphVersion, beforeRequest: this.beforeRequest }, path, method, semantics, body, query, signal, bearerToken);
  }
}

export async function metaGraphRequest(
  config: { baseUrl: URL; graphVersion: string; beforeRequest?: () => Promise<void> },
  path: string, method: "GET" | "POST", semantics: "read" | "mutation",
  body?: unknown, query?: Record<string, string>, signal?: AbortSignal, bearerToken?: string,
) {
    const url = new URL(`/${config.graphVersion}${path}`, config.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    // A failed current-credential guard is known not sent, not a transport failure.
    await config.beforeRequest?.();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MetaGraphClientError(
        "META_NETWORK",
        "Meta is temporarily unavailable.",
        true,
        undefined,
        semantics === "read",
      );
    }
    const retryableStatus = isRetryableStatus(response.status);
    const transportOutcomeKnown = semantics === "read";
    let raw: Uint8Array;
    try {
      raw = await boundedResponse(response, transportOutcomeKnown);
    } catch (error) {
      if (error instanceof MetaGraphClientError) throw error;
      // Stream errors can include a debug-token URL; never expose the transport exception.
      throw new MetaGraphClientError("META_NETWORK", "Meta is temporarily unavailable.", true, undefined, transportOutcomeKnown);
    }
    const value = parseJson(raw);
    if (!response.ok) {
      const code = errorCode(response.status, value);
      const retryable = retryableStatus || code === "META_RATE_LIMITED";
      // A JSON proxy body or incomplete error is not a provider rejection receipt.
      const providerError = objectValue(objectValue(value)?.error);
      const rejected = providerError !== undefined && integerValue(providerError.code) !== undefined
        && boundedString(providerError.message, 4096) !== undefined;
      const outcomeKnown = semantics === "read" || (rejected && !retryable);
      throw new MetaGraphClientError(
        code,
        safeError(response.status, code, retryable),
        retryable,
        response.status,
        outcomeKnown,
      );
    }
    if (value === undefined) {
      throw invalidResponse("Meta returned an empty or non-JSON response.", transportOutcomeKnown);
    }
    return value;
}

export class MetaGraphClientError extends Error {
  constructor(
    readonly code: string,
    readonly safeError: string,
    readonly retryable: boolean,
    readonly providerStatus: number | undefined,
    readonly outcomeKnown: boolean,
  ) {
    super(safeError);
    this.name = "MetaGraphClientError";
  }
}

function capability(
  eligible: boolean,
  state: MetaGroupsCapability["state"],
  reasonCode?: string,
): MetaGroupsCapability {
  return {
    eligible,
    state,
    ...(reasonCode ? { reasonCode } : {}),
    checkedAt: new Date().toISOString(),
    evidence: "provider_probe",
    constraints: {
      officialBusinessAccountRequired: true,
      inviteOnly: true,
      maxParticipants: 8,
      maxGroupsPerNumber: 10_000,
      unavailableForBusinessAppNumbers: true,
      unavailableForMultiSolutionConversations: true,
    },
    documentationUrl: META_GROUPS_DOCUMENTATION_URL,
  };
}

function validatedCreate(input: CreateOfficialGroupInput) {
  const joinApprovalMode = input.joinApprovalMode ?? "auto_approve";
  if (joinApprovalMode !== "approval_required" && joinApprovalMode !== "auto_approve") {
    throw invalidInput("The join-approval mode is invalid.");
  }
  return {
    messaging_product: "whatsapp",
    subject: groupText(input.subject, 128, false),
    ...(input.description === undefined
      ? {}
      : { description: groupText(input.description, 2_048, true) }),
    join_approval_mode: joinApprovalMode,
  };
}

function validatedUpdate(input: UpdateOfficialGroupInput) {
  const value: Record<string, string> = { messaging_product: "whatsapp" };
  if (input.subject !== undefined) value.subject = groupText(input.subject, 128, false);
  if (input.description !== undefined) value.description = groupText(input.description, 2_048, true);
  if (Object.keys(value).length === 1) throw invalidInput("At least one group setting is required.");
  return value;
}

function groupText(value: unknown, maximum: number, allowEmpty: boolean) {
  if (typeof value !== "string" || hasUnsafeCharacters(value)) throw invalidInput("The group text is invalid.");
  const normalized = value.trim().normalize("NFC");
  if ((!allowEmpty && !normalized) || [...normalized].length > maximum) {
    throw invalidInput("The group text is invalid.");
  }
  return normalized;
}

function validatedId(value: unknown, label: string) {
  if (typeof value !== "string" || !META_ID.test(value)) throw invalidInput(`The Meta ${label} is invalid.`);
  return value;
}

function validateAccessToken(value: string) {
  if (!value || value.length < 16 || value.length > 4_096 || hasControlCharacters(value)) {
    throw invalidInput("Meta credentials are invalid.");
  }
}

function inviteLink(value: unknown, outcomeKnown: boolean) {
  const link = boundedString(objectValue(value)?.invite_link, 512);
  if (!link || !INVITE_LINK.test(link)) {
    throw invalidResponse("Meta returned an invalid group invite link.", outcomeKnown);
  }
  return link;
}

export function graphBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (process.env.NODE_ENV === "production" && url.hostname !== "graph.facebook.com")
  ) {
    throw new Error("META_GRAPH_BASE_URL is invalid");
  }
  return url;
}

async function boundedResponse(response: Response, outcomeKnown: boolean) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidResponse("Meta returned an oversized response.", outcomeKnown);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse("Meta returned an oversized response.", outcomeKnown);
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

function parseJson(bytes: Uint8Array): unknown | undefined {
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function errorCode(status: number, value: unknown) {
  const graphCode = integerValue(objectValue(objectValue(value)?.error)?.code);
  if (graphCode === 131030) return "META_TEST_RECIPIENT_NOT_ALLOWED";
  if (status === 401 || graphCode === 190) return "META_AUTHENTICATION_FAILED";
  if (status === 429 || graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613) {
    return "META_RATE_LIMITED";
  }
  if (status >= 500) return "META_SERVER_ERROR";
  if (status === 403) return "META_PERMISSION_REQUIRED";
  if (status === 400 || status === 404) return "META_GROUPS_UNAVAILABLE";
  return "META_HTTP_ERROR";
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function safeError(status: number, code: string, retryable: boolean) {
  if (code === "META_TEST_RECIPIENT_NOT_ALLOWED") return "Meta rejected this recipient for the test number (131030).";
  if (code === "META_AUTHENTICATION_FAILED") return "Meta credentials are invalid or expired.";
  if (code === "META_PERMISSION_REQUIRED") return "This Meta number is not permitted to use the requested Groups API action.";
  if (code === "META_GROUPS_UNAVAILABLE") return "The Meta Groups API action is unavailable for this number.";
  if (retryable) return "Meta is temporarily unavailable.";
  return `Meta rejected the Groups API request (${status}).`;
}

function invalidInput(message: string) {
  return new MetaGraphClientError("META_INVALID_REQUEST", message, false, undefined, true);
}

function invalidResponse(message: string, outcomeKnown: boolean) {
  return new MetaGraphClientError("META_INVALID_RESPONSE", message, false, undefined, outcomeKnown);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !hasControlCharacters(value)
    ? value
    : undefined;
}

function integerValue(value: unknown) {
  const numeric = typeof value === "number" ? value : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function hasUnsafeCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  });
}
