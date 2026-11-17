import { renderNumberedChoices } from "../../core/src/outbound-text.js";
import { readMetaTemplateInventory } from './meta-template-read.js';
import { metaTemplateCopyBody, type MetaTemplateCopyRequest } from './meta-template-copy.js';
import { MetaAccountTransitionCalls } from './meta-account-transition-execute.js';
import { createHash } from "node:crypto";
import { metaAccountFundingProof } from "../../core/src/meta-account-policy.js";
import {readMetaTransitionInventory} from './meta-account-transition-read.js';
import type {
  ConnectionState,
  DirectProviderMessage,
  DirectProviderIdentityChange,
  MessagingProviderAdapter,
  ProviderGroup,
  ProviderMessage,
  ProviderReceipt,
  SendMessage,
} from "./types.js";
import { ProviderError } from "./types.js";
import { providerOutboundMediaRule } from "../../core/src/provider-media-capabilities.js";
import { MetaAccountRelationError, verifyMetaAccountRelation } from "../../core/src/meta-account-relation.js";
import { metaId, metaSignupHealth, metaSignupPhone } from "../../core/src/meta-signup.js";
import { metaPricingObservation } from "../../core/src/meta-pricing-observation.js";
import { parseWahaTestRecipientAllowlist, type WahaTestRecipientAllowlist } from "../../core/src/waha-test-recipient-scope.js";
import { metaTestSendAllowed, metaTestBsuidRecipient, metaTestPhoneAllowed } from "../../core/src/meta-test-recipient-scope.js";

import { MetaDirectIdentityError, parseMetaDirectIdentity, parseMetaIdentityChange, metaDirectRecipientFields, metaReceiptIdentityParts } from "../../core/src/meta-direct-identity.js";

const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 1_048_576;
const MAX_GROUP_PAGE_SIZE = 1_024;
// Graph object IDs used by the Groups API are numeric or URL-safe/base64-like.
// Some official group IDs include trailing base64 padding. Do not allow path
// separators or arbitrary punctuation because these values become URL paths.
const META_ID = /^[A-Za-z0-9_-]{1,510}={0,2}$/u;
// WhatsApp message IDs (wamid.*) have a wider provider-defined alphabet than
// Graph object IDs, but still must remain one bounded value.
const META_MESSAGE_ID = /^[A-Za-z0-9._:=+-]{1,512}$/u;
const GRAPH_VERSION = /^v\d{1,3}\.\d{1,3}$/u;
const INVITE_LINK = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,256}$/u;

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

export type MetaGroupInfo = ProviderGroup & {
  description?: string;
  suspended: boolean;
  joinApprovalMode?: "approval_required" | "auto_approve";
  creationTimestamp?: string;
};

export type MetaCreateGroupInput = {
  subject: string;
  description?: string;
  joinApprovalMode?: "approval_required" | "auto_approve";
};

export type MetaUpdateGroupInput = {
  subject?: string;
  description?: string;
};

export type MetaConfig = {
  accessToken: string;
  graphVersion: string;
  phoneNumberIdFor: (connectionId: string) => string;
  wabaIdFor?: (connectionId: string) => string;
  baseUrl?: string;
  timeoutMs?: number;
  beforeRequest?: () => Promise<void>;
  /** Exact final Messages HTTP admission, after upload/preparation. */
  beforeFinancialMutation?: (requestSha256: string) => Promise<void>;
  /** Distinct nonfinancial template-copy effect; stable transition checkpoint is mandatory. */
  beforeTemplateMutation?: (requestSha256: string) => Promise<void>;
  /** Final legacy migration registration is a distinct transition stage. */
  beforeLegacyMigrationMutation?: (requestSha256: string) => Promise<void>;
  beforeMessageSend?: (requestSha256:string,phoneNumberId:string) => Promise<void>;
  /** Server-private, exact-delivery conversation evidence; never a provider body field. */
  authorizeTestRecipient?: (bsuid: string) => Promise<string | undefined>;
};

type MetaMessage = {
  id?: unknown;
  type?: unknown;
  group_id?: unknown;
  from?: unknown;
  from_user_id?: unknown;
  from_parent_user_id?: unknown;
  system?: unknown;
  timestamp?: unknown;
  text?: { body?: unknown };
  context?: { id?: unknown };
  interactive?: { button_reply?: { id?: unknown; title?: unknown }; list_reply?: { id?: unknown; title?: unknown }; nfm_reply?: { response_json?: unknown } };
  button?: { payload?: unknown; text?: unknown };
  location?: { latitude?: unknown; longitude?: unknown; name?: unknown; address?: unknown };
  contacts?: unknown;
  reaction?: { message_id?: unknown; emoji?: unknown };
  image?: MetaMedia;
  video?: MetaMedia;
  audio?: MetaMedia;
  document?: MetaMedia;
  sticker?: MetaMedia;
};

type MetaWebhook = {
  entry?: Array<{
    id?: unknown;
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: unknown };
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
        contacts?: Array<{ profile?: { name?: unknown }; wa_id?: unknown; user_id?: unknown; parent_user_id?: unknown }>;
      };
    }>;
  }>;
};

type MetaStatus = {
  pricing?: unknown;
  id?: unknown;
  status?: unknown;
  timestamp?: unknown;
  recipient_id?: unknown;
  recipient_user_id?: unknown;
  recipient_parent_user_id?: unknown;
  errors?: Array<{ code?: unknown }>;
};

type MetaMedia = {
  id?: unknown;
  mime_type?: unknown;
  filename?: unknown;
  caption?: unknown;
};

type GraphRequestSemantics = "read" | "upload" | "mutation";

type GraphPage<T> = {
  data?: T[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
};

type GraphErrorEnvelope = {
  error?: {
    code?: unknown;
    error_subcode?: unknown;
    type?: unknown;
  };
};

/**
 * Strict adapter for Meta's official WhatsApp Groups API.
 *
 * A successful Groups collection probe is the only signal treated as proof of
 * eligibility. Local configuration and account claims never manufacture an
 * eligible state. Mutating calls preserve outcome ambiguity so callers cannot
 * duplicate sends or group mutations after a timeout.
 */
export class MetaGroupsAdapter implements MessagingProviderAdapter {
  readonly provider = "meta" as const;
  private readonly config: MetaConfig;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly testRecipients = parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST);

  constructor(config: MetaConfig) {
    this.config = config;
    this.baseUrl = validatedBaseUrl(config.baseUrl ?? DEFAULT_GRAPH_BASE_URL);
    this.timeoutMs = validatedTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    validateAccessToken(config.accessToken);
    if (!GRAPH_VERSION.test(config.graphVersion)) {
      throw new Error("Meta Graph version must use the form vNN.N");
    }
  }

  async checkGroupsCapability(connectionId: string): Promise<MetaGroupsCapability> {
    await this.assertTestGroupScope();
    try {
      await this.listGroupsPage(connectionId, undefined, 1);
      return capability(true, "AVAILABLE");
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.code?.startsWith("META_CREDENTIAL_")) throw error;
      if (error.retryable) {
        return capability(false, "TEMPORARILY_UNAVAILABLE", error.code);
      }
      if (error.code === "META_AUTHENTICATION_FAILED") {
        return capability(false, "CREDENTIAL_INVALID", error.code);
      }
      if (error.status === 403) {
        return capability(false, "PERMISSION_REQUIRED", error.code);
      }
      return capability(false, "NOT_ELIGIBLE", error.code);
    }
  }

  async getState(connectionId: string): Promise<{ state: ConnectionState; detail?: string }> {
    const result = await this.checkGroupsCapability(connectionId);
    if (result.eligible) return { state: "WORKING" };
    if (result.state === "TEMPORARILY_UNAVAILABLE") {
      return { state: "DEGRADED", detail: result.reasonCode };
    }
    return { state: "ACTION_REQUIRED", detail: result.reasonCode ?? result.state };
  }

  async getIdentity(connectionId: string) {
    const phoneNumberId = this.phoneNumberId(connectionId);
    const data = await this.request<unknown>(
      `/${encodeURIComponent(phoneNumberId)}`,
      {
        method: "GET",
        query: { fields: "display_phone_number,verified_name" },
      },
      "read",
    );
    const record = objectValue(data);
    const phone = boundedString(record?.display_phone_number, 64);
    const displayName = boundedString(record?.verified_name, 256);
    if (!phone) throw invalidResponse("Meta returned an invalid phone-number identity.", true);
    return {
      phone,
      ...(displayName ? { displayName } : {}),
      sessionId: phoneNumberId,
    };
  }

  async listGroups(connectionId: string, cursor?: string) {
    // This phone-only test scope cannot identify an official Graph group.
    if (this.testRecipients !== undefined) return { groups: [], nextCursor: undefined };
    return this.listGroupsPage(connectionId, cursor, 100);
  }

  async getGroup(connectionId: string, groupId: string): Promise<MetaGroupInfo> {
    await this.assertTestGroupScope();
    // Resolve the connection first. This ensures a caller cannot use an adapter
    // configured for one phone number as an unscoped Graph object client.
    this.phoneNumberId(connectionId);
    const id = validatedId(groupId, "group ID");
    const value = await this.request<unknown>(
      `/${encodeURIComponent(id)}`,
      {
        method: "GET",
        query: {
          fields:
            "id,subject,description,suspended,total_participant_count,join_approval_mode,creation_timestamp",
        },
      },
      "read",
    );
    return parseGroup(value);
  }

  async createGroup(connectionId: string, input: MetaCreateGroupInput) {
    await this.assertTestGroupScope();
    const phoneNumberId = this.phoneNumberId(connectionId);
    const body = validatedCreateGroup(input);
    const value = await this.request<unknown>(
      `/${encodeURIComponent(phoneNumberId)}/groups`,
      { method: "POST", body },
      "mutation",
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

  async getGroupInviteLink(connectionId: string, groupId: string) {
    await this.assertTestGroupScope();
    this.phoneNumberId(connectionId);
    const id = validatedId(groupId, "group ID");
    const value = await this.request<unknown>(
      `/${encodeURIComponent(id)}/invite_link`,
      { method: "GET" },
      "read",
    );
    return { inviteLink: validatedInviteLink(value) };
  }

  async resetGroupInviteLink(connectionId: string, groupId: string) {
    await this.assertTestGroupScope();
    this.phoneNumberId(connectionId);
    const id = validatedId(groupId, "group ID");
    const value = await this.request<unknown>(
      `/${encodeURIComponent(id)}/invite_link`,
      { method: "POST", body: { messaging_product: "whatsapp" } },
      "mutation",
    );
    return { inviteLink: validatedInviteLink(value, false) };
  }

  async updateGroup(connectionId: string, groupId: string, input: MetaUpdateGroupInput) {
    await this.assertTestGroupScope();
    this.phoneNumberId(connectionId);
    const id = validatedId(groupId, "group ID");
    const body = validatedUpdateGroup(input);
    const value = await this.request<unknown>(
      `/${encodeURIComponent(id)}`,
      { method: "POST", body },
      "mutation",
    );
    const record = objectValue(value);
    const success = record?.success === true || record?.messaging_product === "whatsapp";
    if (!success) {
      throw invalidResponse(
        "Meta accepted the group update but returned an invalid operation response.",
        false,
      );
    }
    return { updated: true as const };
  }

  async subscribeWaba(connectionId: string) {
    const wabaId = this.wabaId(connectionId);
    let value: unknown;
    try {
      value = await this.request<unknown>(
        `/${encodeURIComponent(wabaId)}/subscribed_apps`,
        { method: "POST", body: {} },
        "mutation",
      );
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== "META_PERMISSION_REQUIRED") throw error;
      const app = objectValue(await this.request<unknown>("/app", { method: "GET", query: { fields: "id" } }, "read"));
      const apps = objectValue(await this.request<unknown>(
        `/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "GET" }, "read",
      ));
      const appId = boundedString(app?.id, 64);
      if (!appId || !Array.isArray(apps?.data) || !apps.data.some(
        (item) => objectValue(objectValue(item)?.whatsapp_business_api_data)?.id === appId,
      )) throw error;
      return { subscribed: true as const };
    }
    if (objectValue(value)?.success !== true) {
      throw invalidResponse(
        "Meta accepted the webhook subscription but returned an invalid response.",
        false,
      );
    }
    return { subscribed: true as const };
  }

  async verifySignupOwner(connectionId: string, businessId: string) {
    if (!metaId(businessId)) throw invalidResponse("The Meta account-owning portfolio could not be verified.", true);
    const wabaId = this.wabaId(connectionId);
    const account = objectValue(await this.request<unknown>(`/${wabaId}`, { method: "GET", query: { fields: "id,owner_business{id}" } }, "read"));
    if (account?.id !== wabaId || objectValue(account.owner_business)?.id !== businessId
      || !(await this.signupList(`/${businessId}/owned_whatsapp_business_accounts`, "id")).some(row => row.id === wabaId)) {
      throw invalidResponse("The Meta account-owning portfolio could not be verified.", true);
    }
  }

  async signupPhone(connectionId: string) {
    const id = this.phoneNumberId(connectionId);
    const rows = await this.signupList(`/${this.wabaId(connectionId)}/phone_numbers`, "id,status,code_verification_status,account_mode,host_platform");
    const row = rows.find(item => item.id === id);
    const variant = objectValue(await this.request<unknown>(`/${id}`, { method: "GET", query: { fields: "id,is_on_biz_app,platform_type" } }, "read"));
    return metaSignupPhone(row && variant?.id === id ? { ...row, is_on_biz_app: variant.is_on_biz_app, platform_type: variant.platform_type } : undefined, id);
  }

  async registerSignupPhone(connectionId: string, pin: string) {
    if (!/^\d{6}$/u.test(pin)) throw new ProviderError("Secure registration details are unavailable.", false, "META_SIGNUP_REGISTRATION_REJECTED");
    const result = objectValue(await this.request<unknown>(`/${this.phoneNumberId(connectionId)}/register`,
      { method: "POST", body: { messaging_product: "whatsapp", pin } }, "mutation"));
    if (result?.success !== true) throw invalidResponse("Meta registration returned an unknown outcome.", false);
  }

  async syncBusinessAppData(connectionId: string, kind: "contacts" | "history", beforeDispatch: () => Promise<void>) {
    await this.assertTestGroupScope(); // The provider has no per-recipient sync filter.
    const result = objectValue(await this.request<unknown>(`/${this.phoneNumberId(connectionId)}/smb_app_data`,
      { method: "POST", body: { messaging_product: "whatsapp", sync_type: kind === "contacts" ? "smb_app_state_sync" : "history" }, beforeDispatch }, "mutation"));
    if (typeof result?.request_id !== "string" || !result.request_id.length || result.request_id.length > 512 || /\p{Cc}/u.test(result.request_id)) {
      throw invalidResponse("Meta synchronization returned an unknown outcome.", false);
    }
    return result.request_id;
  }

  async registerLegacyMigrationPhone(connectionId: string, pin: string) {
    if (typeof pin !== 'string' || !/^\d{6}$/u.test(pin)) throw new ProviderError(
      'Secure migration details are unavailable.', false, 'META_MIGRATION_NOT_ATTEMPTED', undefined, true);
    const result = objectValue(await this.request<unknown>(`/${this.phoneNumberId(connectionId)}/register`,
      { method: 'POST', body: { messaging_product: 'whatsapp', pin } }, 'mutation', false, false, false, true));
    if (result?.success !== true) throw invalidResponse('Meta migration registration returned an unknown outcome.', false);
    return { registered: true as const };
  }

  async signupReadiness(connectionId: string, appId: string) {
    const wabaId = this.wabaId(connectionId);
    const apps = await this.signupList(`/${wabaId}/subscribed_apps`, "id,whatsapp_business_api_data");
    const subscribed = apps.some(item => objectValue(item.whatsapp_business_api_data)?.id === appId);
    const health = await this.request<unknown>(`/${this.phoneNumberId(connectionId)}`, { method: "GET", query: { fields: "health_status" } }, "read");
    return { subscribed, messaging: metaSignupHealth(health, { phoneId: this.phoneNumberId(connectionId), wabaId, appId }) };
  }

  private async signupList(path: string, fields: string) {
    const rows: Record<string, unknown>[] = [];
    const cursors = new Set<string>(); let after: string | undefined;
    const signal = AbortSignal.timeout(30_000);
    for (let page = 0; page < 20; page++) {
      const value = objectValue(await this.request<unknown>(path, { method: "GET", query: { fields, limit: "100", ...(after ? { after } : {}) }, signal }, "read"));
      if (!Array.isArray(value?.data) || value.data.length > 100) throw invalidResponse("Meta account facts are unavailable.", true);
      for (const item of value.data) { const row = objectValue(item); if (!row) throw invalidResponse("Meta account facts are unavailable.", true); rows.push(row); }
      const paging = objectValue(value.paging);
      if (value.paging !== undefined && !paging) throw invalidResponse("Meta account facts are unavailable.", true);
      if (paging?.next === undefined) return rows;
      const cursor = objectValue(paging.cursors)?.after;
      if (typeof paging.next !== "string" || typeof cursor !== "string" || !/^[A-Za-z0-9_+/=-]{1,2048}$/u.test(cursor) || cursors.has(cursor)) throw invalidResponse("Meta account facts are unavailable.", true);
      cursors.add(cursor); after = cursor;
    }
    throw invalidResponse("Meta account facts are unavailable.", true);
  }

  async verifyPhoneAccountRelationship(connectionId: string) {
    const wabaId = this.wabaId(connectionId);
    try {
      return await verifyMetaAccountRelation(this.phoneNumberId(connectionId), wabaId, this.config.graphVersion,
        (query, signal) => this.request(`/${encodeURIComponent(wabaId)}/phone_numbers`, { method: "GET", query, signal }, "read"));
    } catch (error) {
      if (error instanceof MetaAccountRelationError) throw new ProviderError(error.message, false, error.code, undefined, true);
      throw error;
    }
  }

  async normalizeWebhook(connectionId: string, payload: unknown): Promise<ProviderMessage | null> {
    const body = objectValue(payload) as MetaWebhook | undefined;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const messageId = boundedString(message?.id, 512);
    const groupId = boundedString(message?.group_id, 512);
    const participantId = boundedString(message?.from, 256);
    const timestamp = unixTimestamp(message?.timestamp);
    if (!message || !messageId || !groupId || !participantId || !timestamp) return null;

    const type = boundedString(message?.type, 32);
    const media = mediaFor(type, message);
    const text = metaMessageText(message, type, media);
    const participantName = metaSenderName(value?.contacts, participantId);
    const quotedMessageId = metaQuotedMessageId(message);
    return {
      provider: "meta",
      connectionId,
      eventId: messageId,
      messageId,
      groupId,
      participantId,
      ...(participantName ? { participantName } : {}),
      ...(type === "reaction" ? { eventKind: "REACTION" as const } : {}),
      text,
      ...(quotedMessageId ? { quotedMessageId } : {}),
      fromApi: false,
      timestamp,
      ...(media
        ? {
            media: {
              type: media.type,
              ...(media.url ? { url: media.url } : {}),
              ...(media.mimeType ? { mimeType: media.mimeType } : {}),
              ...(media.fileName ? { fileName: media.fileName } : {}),
              ...(media.isSticker ? { isSticker: true } : {}),
            },
          }
        : {}),
    };
  }

  async normalizeIdentityChangeWebhook(connectionId: string, payload: unknown): Promise<DirectProviderIdentityChange | null> {
    const body = objectValue(payload) as MetaWebhook | undefined;
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.group_id || message.type !== "system") return null;
    const messageId = boundedString(message.id, 512);
    const timestamp = unixTimestamp(message.timestamp);
    if (!messageId || !META_MESSAGE_ID.test(messageId) || !timestamp) throw directIdentityError();
    try {
      const change = parseMetaIdentityChange(message);
      if (!change) throw new MetaDirectIdentityError();
      return { provider: "meta", connectionId, eventId: messageId, messageId, timestamp, change };
    } catch (error) {
      if (error instanceof MetaDirectIdentityError) throw directIdentityError();
      throw error;
    }
  }

  async normalizeDirectWebhook(connectionId: string, payload: unknown): Promise<DirectProviderMessage | null> {
    const body = objectValue(payload) as MetaWebhook | undefined;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const messageId = boundedString(message?.id, 512);
    const timestamp = unixTimestamp(message?.timestamp);
    // System identity changes must never become ordinary unsupported bot input.
    if (!message || message.group_id || message.type === "system" || !messageId || !META_MESSAGE_ID.test(messageId) || !timestamp) return null;
    let parsed: ReturnType<typeof parseMetaDirectIdentity>;
    try { parsed = parseMetaDirectIdentity(message, value?.contacts); }
    catch (error) { if (error instanceof MetaDirectIdentityError) throw directIdentityError(); throw error; }
    const chatId = parsed.identity.phone ?? parsed.identity.bsuid!;
    const choice = message.interactive?.button_reply ?? message.interactive?.list_reply;
    const flowResponse = parseFlowResponse(message.interactive?.nfm_reply?.response_json);
    const location = metaLocation(message.location);
    const type=boundedString(message.type,32);
    const media=mediaFor(type,message);
    const quotedMessageId=metaQuotedMessageId(message);
    let input: DirectProviderMessage["input"] | undefined;
    if (flowResponse) {
      input = { type: "flow_response", ...flowResponse };
    } else if (choice) {
      const choiceId = boundedString(choice.id, 64);
      const label = boundedString(choice.title, 80);
      if (!choiceId || !label || !quotedMessageId) return null;
      input = { type: "choice", choiceId, label, source: "META_NATIVE" };
    } else if (message.button) {
      const choiceId = boundedString(message.button.payload, 64);
      const label = boundedString(message.button.text, 80);
      if (!choiceId || !label || !quotedMessageId) return null;
      input = { type: "choice", choiceId, label, source: "META_NATIVE" };
    } else if (type === "reaction") {
      const emoji = boundedString(message.reaction?.emoji, 32, true);
      input = { type: "reaction", ...(emoji ? { emoji } : {}), removed: emoji === "" };
    } else if (location) {
      input = { type: "location", ...location };
    } else if (!isSupportedDirectType(type)) {
      input = { type: "unsupported", text: "This WhatsApp message type is not supported yet." };
    } else {
      input = { type: "text", text: metaMessageText(message, type, media) };
    }
    input ??= { type: "text", text: metaMessageText(message, type, media) };
    const senderName=singleLine(parsed.contactIndex === undefined ? undefined : value?.contacts?.[parsed.contactIndex]?.profile?.name,256);
    return { provider: "meta", connectionId, eventId: messageId, messageId, chatId, senderId: chatId, metaIdentity: parsed.identity, ...(parsed.identity.phone ? {senderPhone:`+${parsed.identity.phone}`} : {}), ...(senderName?{senderName,senderNameQuality:"CONTACT" as const}:{}), input, fromApi: false, fromMe: false, timestamp,
      ...(quotedMessageId?{quotedMessageId}:{}),...(media?{media:{type:media.type,...(media.url?{url:media.url}:{}),...(media.mimeType?{mimeType:media.mimeType}:{}),...(media.fileName?{fileName:media.fileName}:{}),...(media.isSticker?{isSticker:true}:{})}}:{}) };
  }

  async normalizeReceipts(connectionId: string, payload: unknown): Promise<ProviderReceipt[]> {
    const body = objectValue(payload) as MetaWebhook | undefined;
    const result: ProviderReceipt[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const item of change.value?.statuses ?? []) {
          const externalMessageId = boundedString(item.id, 512);
          const rawStatus = boundedString(item.status, 32)?.toLowerCase();
          const timestamp = unixTimestamp(item.timestamp);
          const status = metaReceiptStatus(rawStatus);
          if (!externalMessageId || !META_MESSAGE_ID.test(externalMessageId) || !timestamp || !status || !rawStatus) continue;
          const errorCodes = [...new Set((item.errors ?? [])
            .map((error) => safeMetaReceiptErrorCode(error.code))
            .filter((code): code is string => Boolean(code)))]
            .slice(0, 20);
          let recipientIdentity: string[];
          try { recipientIdentity = metaReceiptIdentityParts(item); }
          catch (error) { if (error instanceof MetaDirectIdentityError) throw directIdentityError(); throw error; }
          const observation = metaPricingObservation(item, entry.id, change.value?.metadata?.phone_number_id);
          result.push({
            provider: "meta",
            connectionId,
            externalMessageId,
            receiptKey: await providerReceiptKey([
              "META", externalMessageId, rawStatus, timestamp, ...recipientIdentity, ...errorCodes, "PRICING_V1", observation.revisionSha256,
            ]),
            scope: "MESSAGE",
            status,
            providerStatus: rawStatus.toUpperCase(),
            timestamp,
            errorCodes,
            metadata: { errorCount: errorCodes.length },
            metaPricingObservation: observation,
          });
        }
      }
    }
    return result;
  }

  async prepareMedia(input: SendMessage) {
    await this.assertTestRecipient({ recipient_type: input.recipientType === "DIRECT" ? "individual" : "group", ...this.recipientFields(input) });
    const phoneId = this.phoneNumberId(input.connectionId);
    if (!input.media) {
      throw new ProviderError("Meta media is required.", false, "META_INVALID_REQUEST");
    }
    const media = validatedOutboundMedia(input.media);
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set(
      "file",
      new Blob([new Uint8Array(media.bytes)], { type: media.mimeType }),
      media.filename,
    );
    const value = await this.request<unknown>(
      `/${encodeURIComponent(phoneId)}/media`,
      { method: "POST", formData: form, beforeDispatch: () => this.assertTestRecipient({
        recipient_type: input.recipientType === "DIRECT" ? "individual" : "group", ...this.recipientFields(input),
      }) },
      // Uploading a media object cannot deliver it to a recipient. Orphaned
      // uploads are safe to retry and are cleaned up by Meta retention.
      "upload",
    );
    const providerMediaId = boundedString(objectValue(value)?.id, 512);
    if (!providerMediaId || !META_ID.test(providerMediaId)) {
      throw invalidResponse("Meta returned an invalid media upload response.", true);
    }
    return { providerMediaId };
  }

  /** Read-only diagnostic; presence grants no funding, payer or ownership authority. */
  async transitionPreviewInventory(accountId:string){
    return readMetaTransitionInventory(accountId,(path,query)=>this.request(path,{method:'GET',query},'read'));
  }

  async billingDiagnostic(accountId: string) {
    return (await this.billingAccountProof(accountId)).diagnostic;
  }

  /** Private same-token evidence; never expose funding identifiers in the portal. */
  async billingAccountProof(accountId: string) {
    if (!/^[0-9]{1,32}$/u.test(accountId)) throw new ProviderError("Meta account context is unavailable.", false, "META_ACCOUNT_CONTEXT_INVALID");
    let owner: unknown;
    try { owner = await this.request(`/${encodeURIComponent(accountId)}`, { method: "GET", query: { fields: "id,owner_business{id}" } }, "read"); }
    catch (error) { if (!(error instanceof ProviderError)) throw error; }
    const funding = await this.request(`/${encodeURIComponent(accountId)}`, { method: "GET", query: { fields: "primary_funding_id" } }, "read");
    let currency:unknown;
    // Optional evidence cannot turn a supported funding observation into a
    // failed send admission. No requested-currency fallback is permitted.
    if(this.config.graphVersion==="v24.0")try{
      currency=await this.request(`/${encodeURIComponent(accountId)}`,{method:"GET",query:{fields:"id,currency"}},"read");
    }catch(error){if(!(error instanceof ProviderError))throw error;}
    return metaAccountFundingProof(accountId, owner, funding,new Date(),{value:currency,graphVersion:this.config.graphVersion});
  }

  async send(input: SendMessage) {
    if (input.messagingAccountId !== undefined && !/^[0-9]{1,32}$/u.test(input.messagingAccountId))
      throw new ProviderError("Meta account context is unavailable.",false,"META_ACCOUNT_CONTEXT_INVALID");
    if(input.reaction)throw new ProviderError("Reactions are unavailable for this WhatsApp connection.",false,"META_UNSUPPORTED_MESSAGE");
    const phoneId = this.phoneNumberId(input.connectionId);
    const recipientFields = this.recipientFields(input);
    await this.assertTestRecipient({ recipient_type: input.recipientType === "DIRECT" ? "individual" : "group", ...recipientFields });
    if ((!input.media && !input.text && !input.location && !input.template && !input.flow) || [...input.text].length > 4_096 || Number(Boolean(input.media)) + Number(Boolean(input.choices)) + Number(Boolean(input.location)) + Number(Boolean(input.template)) + Number(Boolean(input.flow)) > 1) {
      throw new ProviderError("The message is empty, too large, or ambiguous.", false, "META_INVALID_REQUEST");
    }
    if ((input.template || input.flow) && input.recipientType !== "DIRECT") throw new ProviderError("Templates and WhatsApp Flows require a direct recipient.", false, "META_INVALID_REQUEST");
    const messageContent = input.location
      ? { type: "location", location: { latitude: input.location.latitude, longitude: input.location.longitude, ...(input.location.name ? { name: input.location.name } : {}), ...(input.location.address ? { address: input.location.address } : {}) } }
      : input.choices
      ? metaChoiceMessage(input.text,input.choices.options,input.choices.buttonLabel)
      : input.template
      ? metaTemplateMessage(input.template)
      : input.flow
      ? metaFlowMessage(input.text,input.flow)
      : input.media
      ? metaMediaMessage(input.media, input.text)
      : { type: "text", text: { body: input.text } };
    const result = await this.request<unknown>(
      `/${encodeURIComponent(phoneId)}/messages`,
      {
        method: "POST",
        body: {
          messaging_product: "whatsapp",
          ...(input.messagingAccountId ? { messaging_account_id: input.messagingAccountId } : {}),
          recipient_type: input.recipientType === "DIRECT" ? "individual" : "group",
          ...recipientFields,
          ...messageContent,
          ...(input.replyToMessageId
            ? { context: { message_id: validatedMessageId(input.replyToMessageId) } }
            : {}),
        },
      },
      "mutation", true,
    );
    const record = objectValue(result);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    const id = boundedString(objectValue(messages[0])?.id, 512);
    if (!id) {
      throw invalidResponse(
        "Meta accepted the message but returned no message identifier.",
        false,
      );
    }
    return { externalMessageId: id, state: "SENT" as const };
  }

  /** Private approved-arrangement consumer only: access token belongs to the
   * configured financial holder, never to an arbitrary tenant-supplied URL. */
  async readExtendedCreditLines(holderBusinessId:string){
    const holder=financialGraphId(holderBusinessId);
    const raw=objectValue(await this.request<unknown>(`/${holder}/extendedcredits`,{method:"GET",query:{fields:"id",limit:"100"}},"read"));
    if(!raw||!Array.isArray(raw.data)||raw.data.length>100||objectValue(raw.paging)?.next!==undefined)
      throw invalidResponse("Complete financial-holder evidence is unavailable.",true);
    const ids=raw.data.map(value=>{const item=objectValue(value);return financialGraphId(item?.id);});
    if(new Set(ids).size!==ids.length)throw invalidResponse("Financial-holder evidence conflicts.",true);
    return ids;
  }
  /** The unfinished clone may not expose final phones or send readiness yet. */
  async transitionCloneAccess(accountId:string,appId:string,currency:string){
    const account=financialGraphId(accountId),app=financialGraphId(appId);
    const value=objectValue(await this.request<unknown>(`/${account}`,{method:'GET',query:{fields:'id,currency'}},'read'));
    const apps=await this.signupList(`/${account}/subscribed_apps`,'id,whatsapp_business_api_data');
    if(value?.id!==account||value.currency!==currency||apps.filter(item=>objectValue(item.whatsapp_business_api_data)?.id===app).length!==1)
      throw invalidResponse('The migration clone account access is unavailable.',true);
    return {claim:'CLONE_ACCOUNT_ACCESS_VERIFIED' as const,accountId:account,appId:app,currency,verifiedAt:new Date().toISOString(),
      responseSha256:createHash('sha256').update(JSON.stringify({account:value,apps})).digest('hex')};
  }

  async verifyTemplateAccountAccess(accountId: string, businessId: string) {
    const account = financialGraphId(accountId), business = financialGraphId(businessId);
    const value = objectValue(await this.request<unknown>(`/${account}`, {method: 'GET', query: {fields: 'id,owner_business{id}'}}, 'read'));
    if (value?.id !== account || objectValue(value.owner_business)?.id !== business
      || !(await this.signupList(`/${business}/owned_whatsapp_business_accounts`, 'id')).some(item => item.id === account))
      throw invalidResponse('The account access and owning Meta portfolio are unverified.', true);
  }

  templatePreparationCalls() {
    return {
      inventory: (accountId: string) => readMetaTemplateInventory(accountId,
        (path, query) => this.request(path, {method: 'GET', query}, 'read')),
      copy: (request: MetaTemplateCopyRequest): Promise<unknown> => {
        const body = metaTemplateCopyBody(request);
        return this.request(`/${request.targetAccountId}/migrate_message_templates`,
          {method: 'POST', body}, 'mutation', false, false, true);
      },
    };
  }

  accountTransitionCalls(){
    return new MetaAccountTransitionCalls((requestPath,init,semantics,financialMutation)=>
      this.request(requestPath,init,semantics,false,financialMutation));
  }

  async attachApprovedCreditLine(lineId:string,messagingAccountId:string,currency:string){
    if(!["AUD","EUR","GBP","IDR","INR","USD"].includes(currency))
      throw new ProviderError("Approved credit currency is unavailable.",false,"META_CREDIT_NOT_ATTEMPTED",undefined,true);
    const account=financialGraphId(messagingAccountId),line=financialGraphId(lineId);
    const raw=objectValue(await this.request<unknown>(`/${line}/whatsapp_credit_sharing_and_attach`,{method:"POST",query:{waba_currency:currency,waba_id:account}},"mutation",false,true));
    if(!raw||raw.waba_id!==account||typeof raw.allocation_config_id!=="string"||!/^[0-9]{1,32}$/u.test(raw.allocation_config_id))
      throw invalidResponse("Credit attachment outcome requires reconciliation.",false);
    return{allocationConfigId:raw.allocation_config_id,messagingAccountId:account};
  }
  async readPartnerSolutionAuthority(solutionId:string,appId:string){
    const solution=financialGraphId(solutionId),app=financialGraphId(appId);
    // Both projections are documented on the retained MPS page. Do not infer
    // ACTIVE from readable details or from one historical onboarding receipt.
    const state=objectValue(await this.request<unknown>(`/${solution}`,{method:"GET",query:{fields:"name,status,partners"}},"read"));
    const accepted=objectValue(state?.partners);
    if(!state||state.status!=="ACTIVE"||(state.id!==undefined&&state.id!==solution)||!Array.isArray(accepted?.data)
      ||accepted.data.length>100||objectValue(accepted.paging)?.next!==undefined)throw invalidResponse("Approved solution is unavailable.",true);
    const selected=accepted.data.map(objectValue).filter(v=>objectValue(v?.partner_app)?.id===app);
    if(selected.length!==1||selected[0]?.status!=="ACCEPTED")throw invalidResponse("Approved solution app is unavailable.",true);
    const details=objectValue(await this.request<unknown>(`/${solution}`,{method:"GET",query:{fields:"name,owner_permissions,partners{partner_permissions,partner_app}"}},"read"));
    const partners=objectValue(details?.partners);
    if(!details||(details.id!==undefined&&details.id!==solution)||!Array.isArray(partners?.data)||partners.data.length>100
      ||objectValue(partners.paging)?.next!==undefined)throw invalidResponse("Approved solution permissions are unavailable.",true);
    const matching=partners.data.map(objectValue).filter(v=>objectValue(v?.partner_app)?.id===app);
    // owner_permissions describe the other partner; they cannot authorize the
    // exact selected app. Full MANAGE is documented only with MESSAGING.
    const owner=details.owner_permissions,permissions=matching[0]?.partner_permissions;
    if(matching.length!==1||!Array.isArray(owner)||!Array.isArray(permissions)||![...owner,...permissions].every(v=>typeof v==="string")
      ||(!permissions.includes("MANAGE_BILLING")&&!(permissions.includes("MANAGE")&&permissions.includes("MESSAGING"))))throw invalidResponse("Approved solution billing authority is unavailable.",true);
    return{solutionId:solution,appId:app,state:"ACTIVE" as const,billingPermission:"MANAGE_BILLING" as const};
  }
  async readCreditAllocation(allocationConfigId:string){
    const allocation=financialGraphId(allocationConfigId);
    const raw=objectValue(await this.request<unknown>(`/${allocation}`,{method:"GET",query:{fields:"receiving_credential"}},"read"));
    const credential=objectValue(raw?.receiving_credential);
    if(!raw||!credential||typeof credential.id!=="string"||!/^[A-Za-z0-9._:-]{1,128}$/u.test(credential.id)
      ||raw.id!==allocation)throw invalidResponse("Credit allocation readback is unavailable.",true);
    return{allocationConfigId:allocation,receivingCredential:credential.id};
  }
  /** Read only the explicitly approved receiver on the explicitly approved line.
   * The allocation ID is discovered, never attached or inferred from account owner. */
  async readDerivedCreditAllocation(lineId:string,receivingBusinessId:string,expectedFundingId:string){
    const line=financialGraphId(lineId),business=financialGraphId(receivingBusinessId);
    if(!/^[A-Za-z0-9._:-]{1,128}$/u.test(expectedFundingId))throw invalidResponse('Exact target funding is unavailable.',true);
    const raw=objectValue(await this.request<unknown>(`/${line}/owning_credit_allocation_configs`,
      {method:'GET',query:{receiving_business_id:business,fields:'id,receiving_business'}},'read'));
    if(!raw||objectValue(raw.receiving_business)?.id!==business)throw invalidResponse('Approved receiver allocation is unavailable.',true);
    const allocation=await this.readCreditAllocation(financialGraphId(raw.id));
    if(allocation.receivingCredential!==expectedFundingId)throw invalidResponse('Allocation does not fund the captured target.',true);
    return {...allocation,receivingBusinessId:business,creditLineId:line};
  }
  async readOwningCreditAllocation(lineId:string,receivingBusinessId:string,expectedAllocationId:string){
    const line=financialGraphId(lineId),business=financialGraphId(receivingBusinessId),allocation=financialGraphId(expectedAllocationId);
    const raw=objectValue(await this.request<unknown>(`/${line}/owning_credit_allocation_configs`,
      {method:"GET",query:{receiving_business_id:business,fields:"id,receiving_business"}},"read"));
    const receiving=objectValue(raw?.receiving_business);
    if(!raw||raw.id!==allocation||receiving?.id!==business)
      throw invalidResponse("Exact financial-holder allocation authority is unavailable.",true);
    return{allocationConfigId:allocation,receivingBusinessId:business};
  }
  async revokeApprovedCreditAllocation(allocationConfigId:string){
    const allocation=financialGraphId(allocationConfigId);
    const raw=objectValue(await this.request<unknown>(`/${allocation}`,{method:"DELETE"},"mutation",false,true));
    if(raw?.success!==true)throw invalidResponse("Credit revocation outcome requires reconciliation.",false);
    return{allocationConfigId:allocation,accepted:true as const};
  }
  async readCreditAllocationRevocation(allocationConfigId:string,receivingBusinessId:string){
    const allocation=financialGraphId(allocationConfigId),business=financialGraphId(receivingBusinessId);
    const raw=objectValue(await this.request<unknown>(`/${allocation}`,{method:"GET",query:{fields:"receiving_business,request_status"}},"read"));
    if(!raw||objectValue(raw.receiving_business)?.id!==business||typeof raw.request_status!=="string"||!/^[A-Z_]{1,64}$/u.test(raw.request_status)
      ||(raw.id!==undefined&&raw.id!==allocation))throw invalidResponse("Credit revocation readback is unavailable.",true);
    return{allocationConfigId:allocation,deleted:raw.request_status==="DELETED",requestStatus:raw.request_status};
  }

  private recipientFields(input: SendMessage): { to: string } | { recipient: string } {
    if (input.recipientType !== "DIRECT") {
      if (input.metaDirectRecipient !== undefined) throw directIdentityError();
      return { to: validatedId(input.groupId, "group ID") };
    }
    try {
      // No raw BSUID fallback: only an explicit immutable-snapshot projection can select it.
      return metaDirectRecipientFields(input.metaDirectRecipient === undefined ? { kind: "PHONE", value: input.groupId } : input.metaDirectRecipient);
    } catch (error) {
      if (error instanceof MetaDirectIdentityError) throw directIdentityError();
      throw error;
    }
  }

  private async listGroupsPage(connectionId: string, cursor: string | undefined, limit: number) {
    await this.assertTestGroupScope();
    const phoneNumberId = this.phoneNumberId(connectionId);
    const safeCursor = cursor === undefined ? undefined : validatedCursor(cursor);
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_GROUP_PAGE_SIZE);
    const value = await this.request<unknown>(
      `/${encodeURIComponent(phoneNumberId)}/groups`,
      {
        method: "GET",
        query: {
          fields: "id,subject,total_participant_count",
          limit: String(safeLimit),
          ...(safeCursor ? { after: safeCursor } : {}),
        },
      },
      "read",
    );
    const page = objectValue(value) as GraphPage<unknown> | undefined;
    if (!page || !Array.isArray(page.data)) {
      throw invalidResponse("Meta returned an invalid groups page.", true);
    }
    const groups = page.data.map(parseGroup);
    const nextCursor = boundedString(page.paging?.cursors?.after, 2_048);
    return {
      groups,
      ...(page.paging?.next && nextCursor ? { nextCursor } : {}),
    };
  }

  private phoneNumberId(connectionId: string) {
    return validatedId(this.config.phoneNumberIdFor(connectionId), "phone-number ID");
  }

  private wabaId(connectionId: string) {
    if (!this.config.wabaIdFor) {
      throw new ProviderError(
        "The WhatsApp Business Account is not configured for webhook subscription.",
        false,
        "META_WABA_ID_MISSING",
      );
    }
    return validatedId(this.config.wabaIdFor(connectionId), "WhatsApp Business Account ID");
  }

  private async request<T>(
    path: string,
    init: {
      method: "GET" | "POST" | "DELETE";
      query?: Record<string, string>;
      body?: unknown;
      formData?: FormData;
      headers?: HeadersInit;
      signal?: AbortSignal;
      beforeDispatch?: () => Promise<void>;
    },
    semantics: GraphRequestSemantics,
    messageSend = false,
    financialMutation = false,
    templateMutation = false,
    legacyMigrationMutation = false,
  ): Promise<T> {
    const url = new URL(`/${this.config.graphVersion}${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }
    // A rejected preflight proves that no request was dispatched. Keep its
    // classification outside the network/unknown-effect error boundary.
    if (messageSend) await this.assertTestRecipient(init.body);
    await this.config.beforeRequest?.();
    await init.beforeDispatch?.();
    if (messageSend) {
      const phoneNumberId=/^\/([0-9]{1,32})\/messages$/u.exec(path)?.[1];
      if(!phoneNumberId)throw new ProviderError('Messages request context is unavailable.',false,'META_MESSAGE_NOT_ATTEMPTED',undefined,true);
      await this.assertTestRecipient(init.body);
      await this.config.beforeMessageSend?.(createHash('sha256').update(JSON.stringify(init.body)).digest('hex'),phoneNumberId);
      // Check the exact final transport body after asynchronous preflights too.
      await this.assertTestRecipient(init.body);
    }
    if(financialMutation){
      if(!this.config.beforeFinancialMutation)throw new ProviderError("Financial mutation requires its durable approved checkpoint.",false,"META_CREDIT_NOT_ATTEMPTED",undefined,true);
      const requestSha256=createHash("sha256").update(JSON.stringify({method:init.method,url:url.toString(),body:init.body??null})).digest("hex");
      await this.config.beforeFinancialMutation(requestSha256);
    }
    if (templateMutation) {
      if (!this.config.beforeTemplateMutation) throw new ProviderError('Template mutation requires its durable checkpoint.', false, 'META_TEMPLATE_NOT_ATTEMPTED', undefined, true);
      const requestSha256 = createHash('sha256').update(JSON.stringify({method: init.method, url: url.toString(), body: init.body ?? null})).digest('hex');
      await this.config.beforeTemplateMutation(requestSha256);
    }
    if (legacyMigrationMutation) {
      if (!this.config.beforeLegacyMigrationMutation) throw new ProviderError(
        'Migration requires its original durable checkpoint.', false, 'META_MIGRATION_NOT_ATTEMPTED', undefined, true);
      const requestSha256 = createHash('sha256').update(JSON.stringify({ method: init.method, url: url.toString(), body: init.body ?? null })).digest('hex');
      await this.config.beforeLegacyMigrationMutation(requestSha256);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.formData
          ? { body: init.formData }
          : init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      });
      const retryableStatus = isRetryableStatus(response.status);
      // A concrete non-retryable 4xx proves that a mutation was rejected. A
      // retryable status, malformed 2xx, timeout, or truncated response does
      // not prove whether Meta committed a message/group mutation.
      const transportOutcomeKnown = semantics !== "mutation";
      const raw = await readBounded(response, MAX_JSON_BYTES, transportOutcomeKnown);
      const parsed = parseJson(raw);
      if (!response.ok) {
        const code = metaErrorCode(response.status, parsed);
        const retryable = retryableStatus || code === "META_RATE_LIMITED" || code === "META_SERVER_ERROR";
        const providerError = objectValue(objectValue(parsed)?.error);
        const concreteRejection = typeof providerError?.code === "number" && Number.isSafeInteger(providerError.code)
          && providerError.code >= 0 && typeof providerError.message === "string"
          && boundedString(providerError.message, 4096) !== undefined && !hasControlCharacters(providerError.message);
        const rejectedOutcomeKnown = semantics !== "mutation" || (concreteRejection && !retryable);
        throw new ProviderError(
          safeMetaError(response.status, code, retryable, parsed),
          retryable,
          code,
          response.status,
          rejectedOutcomeKnown,
        );
      }
      if (parsed === undefined) {
        throw invalidResponse(
          "Meta returned an empty or non-JSON response.",
          transportOutcomeKnown,
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      return Promise.reject(
        new ProviderError(
          "Meta is temporarily unavailable.",
          true,
          "META_NETWORK",
          undefined,
          semantics !== "mutation",
        ),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async assertTestRecipient(body: unknown) {
    if (metaTestSendAllowed(this.testRecipients, body)) return;
    const bsuid = metaTestBsuidRecipient(body);
    if (bsuid && this.config.authorizeTestRecipient) {
      const phone = await this.config.authorizeTestRecipient(bsuid);
      if (typeof phone === "string" && metaTestPhoneAllowed(this.testRecipients, phone) && metaTestBsuidRecipient(body) === bsuid) return;
    }
    assertMetaTestRequestAllowed(body, this.testRecipients);
  }

  private async assertTestGroupScope() {
    await this.assertTestRecipient({ recipient_type: "group" });
  }
}

/** Also used before delivery credential reads, native writes and media staging. */
export function assertMetaTestOutboundAllowed(input: SendMessage, scope = parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST)) {
  assertMetaTestRequestAllowed({ recipient_type: input.recipientType === "DIRECT" ? "individual" : "group",
    ...(input.metaDirectRecipient?.kind === "BSUID" ? { recipient: input.metaDirectRecipient.value }
      : { to: input.metaDirectRecipient?.value ?? input.groupId }) }, scope);
}

function assertMetaTestRequestAllowed(body: unknown, scope: WahaTestRecipientAllowlist) {
  if (metaTestSendAllowed(scope, body)) return;
  console.warn("Meta test recipient scope refused outbound request");
  throw new ProviderError("The recipient is outside the configured test scope.", false, "META_TEST_RECIPIENT_NOT_ALLOWED", undefined, true);
}

function metaChoiceMessage(text:string,options:Array<{id:string;label:string}>,buttonLabel="Choose"){
  if(options.length<1||options.length>10||options.some(option=>!/^[a-z][a-z0-9_-]{0,63}$/u.test(option.id)||option.label!==option.label.trim()||[...option.label].length<1||[...option.label].length>80))throw new ProviderError("Meta choices are invalid.",false,"META_INVALID_REQUEST");
  if(buttonLabel!==buttonLabel.trim()||[...buttonLabel].length<1||[...buttonLabel].length>20)throw new ProviderError("Meta choice button label is invalid.",false,"META_INVALID_REQUEST");
  if(options.length<=3&&options.every(option=>[...option.label].length<=20)&&[...text].length<=1_024)return{type:"interactive",interactive:{type:"button",body:{text},action:{buttons:options.map(option=>({type:"reply",reply:{id:option.id,title:option.label}}))}}};
  if(options.every(option=>[...option.label].length<=24))return{type:"interactive",interactive:{type:"list",body:{text},action:{button:buttonLabel,sections:[{rows:options.map(option=>({id:option.id,title:option.label}))}]}}};
  const body=renderNumberedChoices(text,options);
  if([...body].length>4_096)throw new ProviderError("Meta choice text exceeds the provider limit.",false,"META_INVALID_REQUEST");
  return{type:"text",text:{body}};
}

function metaTemplateMessage(template:NonNullable<SendMessage["template"]>){
  if(!/^[a-z0-9_]{1,512}$/u.test(template.name)||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(template.languageCode)||template.bodyParameters.length>20||template.bodyParameters.some(value=>value!==value.trim()||[...value].length<1||[...value].length>1024))throw new ProviderError("Meta template configuration is invalid.",false,"META_INVALID_REQUEST");
  return{type:"template",template:{name:template.name,language:{code:template.languageCode},...(template.bodyParameters.length?{components:[{type:"body",parameters:template.bodyParameters.map(text=>({type:"text",text}))}]}:{})}};
}

function metaFlowMessage(text:string,flow:NonNullable<SendMessage["flow"]>){
  if(!/^[1-9][0-9]{0,31}$/u.test(flow.id)||!META_ID.test(flow.token)||flow.buttonLabel!==flow.buttonLabel.trim()||[...flow.buttonLabel].length<1||[...flow.buttonLabel].length>30||containsEmoji(flow.buttonLabel)||flow.screen!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(flow.screen))throw new ProviderError("Meta Flow configuration is invalid.",false,"META_INVALID_REQUEST");
  const entries=Object.entries(flow.data);if(entries.length>25||entries.some(([key,value])=>!/^[a-z][a-z0-9_.-]{0,127}$/u.test(key)||value!==value.trim()||[...value].length<1||[...value].length>2000))throw new ProviderError("Meta Flow data is invalid.",false,"META_INVALID_REQUEST");
  return{type:"interactive",interactive:{type:"flow",body:{text},action:{name:"flow",parameters:{flow_message_version:"3",flow_action:"navigate",flow_token:flow.token,flow_id:flow.id,flow_cta:flow.buttonLabel,...(flow.screen||entries.length?{flow_action_payload:{...(flow.screen?{screen:flow.screen}:{}),...(entries.length?{data:flow.data}:{})}}:{})}}}};
}

function parseFlowResponse(value:unknown):{flowToken:string;data:Record<string,string>}|undefined{
  const raw=boundedString(value,65_536);if(!raw)return undefined;let parsed:unknown;try{parsed=JSON.parse(raw)}catch{return undefined}const record=objectValue(parsed);if(!record)return undefined;
  const flowToken=boundedString(record.flow_token,512);if(!flowToken||!META_ID.test(flowToken))return undefined;
  const entries=Object.entries(record).filter(([key])=>key!=="flow_token");if(entries.length>25)return undefined;const data:Record<string,string>={};
  for(const[key,item]of entries){if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(key))return undefined;let scalar:string;if(typeof item==="string")scalar=item;else if((typeof item==="number"&&Number.isFinite(item))||typeof item==="boolean")scalar=String(item);else if(Array.isArray(item)&&item.length<=20&&item.every(entry=>typeof entry==="string"||(typeof entry==="number"&&Number.isFinite(entry))||typeof entry==="boolean"))scalar=JSON.stringify(item);else return undefined;if(scalar!==scalar.trim()||[...scalar].length<1||[...scalar].length>2000)return undefined;data[key]=scalar}
  return{flowToken,data};
}

function metaReceiptStatus(value: string | undefined): ProviderReceipt["status"] | undefined {
  if (value === "sent") return "SENT";
  if (value === "delivered") return "DELIVERED";
  if (value === "read") return "READ";
  if (value === "failed") return "FAILED";
  return undefined;
}

function safeMetaReceiptErrorCode(value: unknown) {
  const code = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : boundedString(value, 64);
  return code && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code.toUpperCase() : undefined;
}

async function providerReceiptKey(parts: string[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function validatedCreateGroup(input: MetaCreateGroupInput) {
  const subject = cleanText(input.subject, 128, false);
  const description = input.description === undefined
    ? undefined
    : cleanText(input.description, 2_048, true);
  const joinApprovalMode = input.joinApprovalMode ?? "auto_approve";
  if (joinApprovalMode !== "auto_approve" && joinApprovalMode !== "approval_required") {
    throw new ProviderError("The group join-approval mode is invalid.", false, "META_INVALID_REQUEST");
  }
  return {
    messaging_product: "whatsapp",
    subject,
    ...(description !== undefined ? { description } : {}),
    join_approval_mode: joinApprovalMode,
  };
}

function validatedUpdateGroup(input: MetaUpdateGroupInput) {
  const result: Record<string, string> = { messaging_product: "whatsapp" };
  if (input.subject !== undefined) result.subject = cleanText(input.subject, 128, false);
  if (input.description !== undefined) result.description = cleanText(input.description, 2_048, true);
  if (Object.keys(result).length === 1) {
    throw new ProviderError("At least one group setting is required.", false, "META_INVALID_REQUEST");
  }
  return result;
}

function parseGroup(value: unknown): MetaGroupInfo {
  const record = objectValue(value);
  const id = boundedString(record?.id, 512);
  const name = boundedString(record?.subject, 128);
  const participants = integerValue(record?.total_participant_count, 0, 8);
  if (!id || !name || participants === undefined) {
    throw invalidResponse("Meta returned invalid group metadata.", true);
  }
  const description = boundedString(record?.description, 2_048, true);
  const joinApprovalMode = boundedString(record?.join_approval_mode, 32);
  const creationTimestamp = unixTimestamp(record?.creation_timestamp);
  return {
    id,
    name,
    participants,
    suspended: record?.suspended === true,
    ...(description !== undefined ? { description } : {}),
    ...(joinApprovalMode === "approval_required" || joinApprovalMode === "auto_approve"
      ? { joinApprovalMode }
      : {}),
    ...(creationTimestamp ? { creationTimestamp } : {}),
  };
}

function mediaFor(type: string | undefined, message: MetaMessage): (NonNullable<ProviderMessage["media"]> & { caption?: string }) | undefined {
  if (type !== "image" && type !== "video" && type !== "audio" && type !== "document" && type !== "sticker") return undefined;
  const raw = message[type];
  const mediaId = boundedString(raw?.id, 512);
  if (!mediaId) return undefined;
  return {
    type: type === "sticker" ? "image" as const : type,
    // Meta media IDs are resolved through the authenticated media endpoint by
    // the media service. Never expose an access token in a URL.
    url: `meta-media://${mediaId}`,
    mimeType: boundedString(raw?.mime_type, 256),
    fileName: boundedString(raw?.filename, 512),
    ...(type === "sticker" ? { isSticker: true } : {}),
    caption: boundedString(raw?.caption, 65_536, true),
  };
}

function metaMessageText(message: MetaMessage, type: string | undefined, media: ReturnType<typeof mediaFor>) {
  if (type === "text") return boundedString(message.text?.body, 65_536, true) ?? "";
  if (type === "contacts") return metaContactText(message.contacts) ?? "Shared contact";
  if (type === "sticker") return "Sticker";
  if (type === "reaction") {
    const emoji = boundedString(message.reaction?.emoji, 32, true);
    return emoji === "" ? "Removed a reaction" : emoji && !/\s/u.test(emoji) && [...emoji].length <= 16 ? `Reacted with ${emoji}` : "Reaction received";
  }
  const location = metaLocation(message.location);
  if (location) return ["Shared location", ...(location.name ? [`Name: ${location.name}`] : []), ...(location.address ? [`Address: ${location.address}`] : []), `Coordinates: ${location.latitude}, ${location.longitude}`].join("\n");
  const choice = message.interactive?.button_reply ?? message.interactive?.list_reply;
  const choiceLabel = singleLine(choice?.title, 80) ?? singleLine(message.button?.text, 80);
  if (choiceLabel) return choiceLabel;
  if (parseFlowResponse(message.interactive?.nfm_reply?.response_json)) return "WhatsApp form response received";
  if (media) return media.caption ?? "";
  return "This WhatsApp message type is not supported yet.";
}

function isSupportedDirectType(type: string | undefined) {
  return type === "text" || type === "contacts" || type === "sticker" || type === "reaction"
    || type === "location" || type === "interactive" || type === "button"
    || type === "image" || type === "video" || type === "audio" || type === "document";
}

function metaQuotedMessageId(message: MetaMessage) {
  const value = boundedString(message.reaction?.message_id, 512) ?? boundedString(message.context?.id, 512);
  return value && META_MESSAGE_ID.test(value) ? value : undefined;
}

function metaLocation(value: MetaMessage["location"]) {
  const latitude = typeof value?.latitude === "number" && Number.isFinite(value.latitude) ? value.latitude : undefined;
  const longitude = typeof value?.longitude === "number" && Number.isFinite(value.longitude) ? value.longitude : undefined;
  if (latitude === undefined || longitude === undefined || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  const name = singleLine(value?.name, 160);
  const address = singleLine(value?.address, 500);
  return { latitude, longitude, ...(name ? { name } : {}), ...(address ? { address } : {}) };
}

function metaContactText(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, 10).map((item) => {
    const contact = objectValue(item);
    const name = objectValue(contact?.name);
    const fallbackName = [name?.first_name, name?.middle_name, name?.last_name]
      .map((part) => singleLine(part, 80)).filter(Boolean).join(" ").slice(0, 160);
    const formattedName = singleLine(name?.formatted_name, 160) ?? (fallbackName || undefined);
    const phones = Array.isArray(contact?.phones) ? contact.phones : [];
    const firstPhone = objectValue(phones[0]);
    const phone = safePhone(firstPhone?.phone) ?? safePhone(firstPhone?.wa_id);
    return ["Shared contact", ...(formattedName ? [`Name: ${formattedName}`] : []), ...(phone ? [`Phone: ${phone}`] : [])].join("\n");
  }).join("\n\n");
}

function metaSenderName(value: Array<{ profile?: { name?: unknown }; wa_id?: unknown }> | undefined, senderId: string) {
  const match = value?.find((contact) => boundedString(contact.wa_id, 256) === senderId);
  return singleLine(match?.profile?.name, 256);
}

function singleLine(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > maximum * 4) return undefined;
  const normalized = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized && [...normalized].length <= maximum ? normalized : undefined;
}

function safePhone(value: unknown) {
  const phone = singleLine(value, 64);
  return phone && /^\+?[0-9 ()-]{3,64}$/u.test(phone) ? phone : undefined;
}

function validatedInviteLink(value: unknown, outcomeKnown = true) {
  const link = boundedString(objectValue(value)?.invite_link, 512);
  if (!link || !INVITE_LINK.test(link)) {
    throw invalidResponse("Meta returned an invalid group invite link.", outcomeKnown);
  }
  return link;
}

function validatedOutboundMedia(media: NonNullable<SendMessage["media"]>) {
  const mimeType = media.mimeType.trim().toLowerCase();
  const policy = providerOutboundMediaRule("META", mimeType);
  const filename = media.filename.trim().normalize("NFC");
  if (
    !policy ||
    !(media.bytes instanceof Uint8Array) ||
    media.bytes.byteLength < 1 ||
    media.bytes.byteLength > policy.maximumBytes ||
    !filename ||
    filename.length > 512 ||
    hasUnsafeCharacters(filename)
  ) {
    throw new ProviderError(
      "The media file is unsupported or exceeds Meta's safe upload limit.",
      false,
      "META_MEDIA_INVALID",
    );
  }
  return { ...media, filename, mimeType, type: policy.kind };
}

function metaMediaMessage(media: NonNullable<SendMessage["media"]>, caption: string) {
  const validated = validatedOutboundMedia(media);
  const providerMediaId = validatedId(media.providerMediaId, "media ID");
  const content: Record<string, string> = { id: providerMediaId };
  if (validated.type === "document") content.filename = validated.filename;
  if (caption && validated.type !== "audio") {
    if ([...caption].length > 1_024 || hasUnsafeCharacters(caption)) {
      throw new ProviderError(
        "The Meta media caption is invalid or too large.",
        false,
        "META_INVALID_REQUEST",
      );
    }
    content.caption = caption;
  }
  return { type: validated.type, [validated.type]: content };
}

function validatedId(value: unknown, label: string) {
  if (typeof value !== "string" || !META_ID.test(value)) {
    throw new ProviderError(`The Meta ${label} is invalid.`, false, "META_INVALID_REQUEST");
  }
  return value;
}

function validatedMessageId(value: unknown) {
  if (typeof value !== "string" || !META_MESSAGE_ID.test(value)) {
    throw new ProviderError("The Meta reply message ID is invalid.", false, "META_INVALID_REQUEST");
  }
  return value;
}

function validatedCursor(value: string) {
  if (!value || value.length > 2_048 || hasControlCharacters(value)) {
    throw new ProviderError("The Meta pagination cursor is invalid.", false, "META_INVALID_REQUEST");
  }
  return value;
}

function cleanText(value: unknown, maxLength: number, allowEmpty: boolean) {
  if (typeof value !== "string" || hasUnsafeCharacters(value)) {
    throw new ProviderError("The group text is invalid.", false, "META_INVALID_REQUEST");
  }
  const normalized = value.trim().normalize("NFC");
  if ((!allowEmpty && !normalized) || [...normalized].length > maxLength) {
    throw new ProviderError("The group text is invalid.", false, "META_INVALID_REQUEST");
  }
  return normalized;
}

function validateAccessToken(value: string) {
  if (!value || value.length < 16 || value.length > 4_096 || hasControlCharacters(value)) {
    throw new Error("Meta access token is invalid");
  }
}

function validatedBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.hostname !== "graph.facebook.com" && process.env.NODE_ENV === "production")
  ) {
    throw new Error("Meta Graph base URL is invalid");
  }
  return url;
}

function validatedTimeout(value: number) {
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error("Meta request timeout is invalid");
  }
  return value;
}

async function readBounded(response: Response, limit: number, outcomeKnown: boolean) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
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
      if (total > limit) {
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

function metaErrorCode(status: number, value: unknown) {
  const envelope = objectValue(value) as GraphErrorEnvelope | undefined;
  const error = objectValue(envelope?.error);
  const graphCode = integerValue(error?.code, 0, Number.MAX_SAFE_INTEGER);
  if (graphCode === 131047) return "META_CUSTOMER_WINDOW_CLOSED";
  if (graphCode === 131030) return "META_TEST_RECIPIENT_NOT_ALLOWED";
  if (status === 401 || graphCode === 190) return "META_AUTHENTICATION_FAILED";
  if (graphCode === 131005) return "META_PERMISSION_REQUIRED";
  if (graphCode === 131062) return "META_UNSUPPORTED_MESSAGE";
  if (graphCode === 131009) return "META_INVALID_REQUEST";
  if (graphCode === 131026 || graphCode === 131050 || graphCode === 131051 || graphCode === 131052 || graphCode === 131053) return "META_DELIVERY_REJECTED";
  if (status === 429 || graphCode === 4 || graphCode === 17 || graphCode === 32 || graphCode === 613 || graphCode === 130429 || graphCode === 131056) {
    return "META_RATE_LIMITED";
  }
  if (status >= 500 || graphCode === 2 || graphCode === 80007 || graphCode === 131000 || graphCode === 131016) return "META_SERVER_ERROR";
  if (status === 403) return "META_PERMISSION_REQUIRED";
  if (status === 400 || status === 404) return "META_GROUPS_UNAVAILABLE";
  return "META_HTTP_ERROR";
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function safeMetaError(status: number, code: string, retryable: boolean, value: unknown) {
  const diagnostics = safeMetaDiagnostics(value);
  let message: string;
  if (code === "META_TEST_RECIPIENT_NOT_ALLOWED") message = "Meta rejected this recipient for the test number.";
  else if (code === "META_AUTHENTICATION_FAILED") message = "Meta credentials are invalid or expired.";
  else if (code === "META_CUSTOMER_WINDOW_CLOSED") message = "The customer-service window is closed; send an approved template instead.";
  else if (code === "META_PERMISSION_REQUIRED") message = "This Meta number is not permitted to perform the requested action.";
  else if (code === "META_GROUPS_UNAVAILABLE") message = "The requested Meta action is unavailable for this number.";
  else if (code === "META_UNSUPPORTED_MESSAGE") message = "This message type does not support the selected Meta recipient.";
  else if (code === "META_INVALID_REQUEST") message = "Meta rejected the message configuration.";
  else if (code === "META_DELIVERY_REJECTED") message = "Meta rejected delivery to this recipient.";
  else if (retryable) message = "Meta is temporarily unavailable.";
  else message = `Meta rejected the request (${status}).`;
  return diagnostics ? `${message} ${diagnostics}` : message;
}

function safeMetaDiagnostics(value: unknown) {
  const error = objectValue(objectValue(value)?.error);
  const code = integerValue(error?.code, 0, Number.MAX_SAFE_INTEGER);
  const subcode = integerValue(error?.error_subcode, 0, Number.MAX_SAFE_INTEGER);
  const type = boundedString(error?.type, 64)?.replace(/[^A-Za-z0-9_.-]/gu, "_");
  const fields = [code === undefined ? undefined : `code=${code}`, subcode === undefined ? undefined : `subcode=${subcode}`, type ? `type=${type}` : undefined].filter(Boolean);
  return fields.length ? `[provider ${fields.join(" ")}]` : "";
}

function containsEmoji(value: string) {
  return /\p{Extended_Pictographic}/u.test(value);
}

function invalidResponse(message: string, outcomeKnown: boolean) {
  return new ProviderError(message, false, "META_INVALID_RESPONSE", undefined, outcomeKnown);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maxLength || hasUnsafeCharacters(value)) return undefined;
  if (!allowEmpty && value.length === 0) return undefined;
  return value;
}

function integerValue(value: unknown, minimum: number, maximum: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : undefined;
}

function unixTimestamp(value: unknown) {
  const seconds = integerValue(value, 1, 253_402_300_799);
  if (seconds === undefined) return undefined;
  const timestamp = new Date(seconds * 1_000);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
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

function directIdentityError() {
  return new ProviderError("The Meta direct identity is invalid or unsupported.", false, "META_DIRECT_IDENTITY_INVALID");
}

function financialGraphId(value:unknown):string{
 if(typeof value!=="string"||!/^[0-9]{1,32}$/u.test(value))
  throw new ProviderError("Approved financial asset is unavailable.",false,"META_CREDIT_NOT_ATTEMPTED",undefined,true);
 return value;
}
