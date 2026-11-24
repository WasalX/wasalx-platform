import { renderNumberedChoices } from "../../core/src/outbound-text.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { recordStructuredLog, safeRequestId } from "@wasalx/observability";
import type { DirectProviderMessage, MessagingProviderAdapter, ProviderGroup, ProviderMessage, ProviderMessageMutation, ProviderReceipt, SendMessage } from "./types.js";
import { ProviderError } from "./types.js";
import { parseWahaTestRecipientAllowlist, wahaMessageRecipient, wahaTestRecipientAllowed, type WahaTestRecipientAllowlist } from "../../core/src/waha-test-recipient-scope.js";

type WahaConfig = { baseUrl: string; apiKey: string; sessionFor: (connectionId: string) => string };

export type WahaSessionStatus =
  | "STOPPED"
  | "STARTING"
  | "SCAN_QR_CODE"
  | "PASSKEY_REQUIRED"
  | "PASSKEY_CONFIRMATION_REQUIRED"
  | "WORKING"
  | "FAILED"
  | "UNKNOWN";

export type WahaSessionSnapshot = {
  sessionId: string;
  status: WahaSessionStatus;
  engine?: string;
  reconciled?: true;
};

export function normalizeWahaPhone(value: string) {
  const digits = value.trim().replace(/[\s()-]/gu, "");
  const normalized = digits.startsWith("+") ? digits : `+${digits}`;
  return /^\+[1-9]\d{5,19}$/.test(normalized) ? normalized : undefined;
}

export type WahaReceiptRejection = "PAYLOAD" | "RECEIPT_ID" | "PARTICIPANT" | "ID_SUFFIX" | "STATUS" | "TIMESTAMP" | "ACK_STATUS";

export type WahaSessionCreateOptions = {
  start?: boolean;
  config?: Record<string, unknown>;
  /** Expected durable worker engine; used only to reconcile ambiguous creates. */
  expectedEngine?: "GOWS" | "NOWEB";
};

export type WahaQrCode = {
  mimeType: "image/png";
  data: string;
};

type WahaAuthenticatorTransport = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

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

const SESSION_STATUSES = new Set<WahaSessionStatus>([
  "STOPPED",
  "STARTING",
  "SCAN_QR_CODE",
  "PASSKEY_REQUIRED",
  "PASSKEY_CONFIRMATION_REQUIRED",
  "WORKING",
  "FAILED",
]);
const PASSKEY_TRANSPORTS = new Set<WahaAuthenticatorTransport>(["ble", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const BASE64_VALUE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MESSAGE_ID_TOKEN = /^[A-Za-z0-9-]{1,256}$/;
const FULL_MESSAGE_ID = /^(?:true|false)_[^\s_]{1,512}_[A-Za-z0-9-]{1,256}(?:_[^\s]{1,256})?$/;
const MAX_RESPONSE_BYTES = 3_000_000;

export class WahaAdapter implements MessagingProviderAdapter {
  readonly provider = "waha" as const;
  private readonly config: WahaConfig;
  private participantNames?: { session: string; expiresAt: number; names: ReadonlyMap<string, string> };
  private readonly testRecipients: WahaTestRecipientAllowlist;

  constructor(config: WahaConfig) {
    this.config = config;
    this.testRecipients = parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST);
  }

  private async request<T>(path: string, init: RequestInit = {}, outcomeMayBeUnknown = false,recognizeError?:(status:number,body:Uint8Array)=>ProviderError|undefined): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(new URL(path, this.config.baseUrl), {
        ...init,
        headers: { "x-api-key": this.config.apiKey, "content-type": "application/json", ...init.headers },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        if(recognizeError){const body=await readBoundedResponse(response,true);const recognized=recognizeError(response.status,body);if(recognized)throw recognized}
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ProviderError(
          `WAHA request failed (${response.status})`,
          retryable,
          "WAHA_HTTP",
          response.status,
          !(outcomeMayBeUnknown && retryable),
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw invalidResponse("WAHA returned an oversized response", !outcomeMayBeUnknown);
      }
      const bytes = await readBoundedResponse(response, !outcomeMayBeUnknown);
      if (bytes.byteLength === 0) return undefined as T;
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
      } catch {
        throw invalidResponse("WAHA returned a non-JSON response", !outcomeMayBeUnknown);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "WAHA request timed out or the network was unavailable",
        true,
        "WAHA_NETWORK",
        undefined,
        !outcomeMayBeUnknown,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private session(connectionId: string) {
    const session = this.config.sessionFor(connectionId);
    if (!session || session.length > 256 || Array.from(session).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })) {
      throw new ProviderError("WAHA session identifier is invalid", false, "WAHA_INVALID_REQUEST");
    }
    return session;
  }

  private async lifecycle(connectionId: string, action: "start" | "restart" | "stop") {
    const session = this.session(connectionId);
    const result = await this.request<unknown>(`/api/sessions/${encodeURIComponent(session)}/${action}`, {
      method: "POST",
      body: "{}",
    },action!=="stop");
    return sessionSnapshot(result, session);
  }

  private async contractSession(session: string, options: WahaSessionCreateOptions): Promise<unknown> {
    const value = await this.request<unknown>(`/api/sessions/${encodeURIComponent(session)}`);
    let snapshot: WahaSessionSnapshot;
    try { snapshot = sessionSnapshot(value, session); } catch { throw reconciliationMismatch(); }
    const record = objectValue(value);
    const engine = objectValue(record?.engine);
    // Stopped GOWS sessions omit runtime engine evidence. Attest the same worker,
    // never substitute configured intent for an explicit provider identity.
    if (snapshot.status === "STOPPED" && engine && Object.keys(engine).length === 0) {
      const version = objectValue(await this.request<unknown>("/api/server/version"));
      const serverEngine = wahaEngineValue(version?.engine);
      if (!options.expectedEngine || serverEngine !== options.expectedEngine) throw reconciliationMismatch();
      return { ...record, engine: serverEngine };
    }
    return value;
  }

  async createSession(connectionId: string, options: WahaSessionCreateOptions = {}): Promise<WahaSessionSnapshot> {
    const session = this.session(connectionId);
    const body: Record<string, unknown> = { name: session };
    if (options.start !== undefined) body.start = options.start;
    if (options.config !== undefined) body.config = options.config;
    try{
      const result = await this.request<unknown>("/api/sessions", { method: "POST", body: JSON.stringify(body) },true,(status,responseBody)=>alreadyExistsError(status,responseBody,session));
      const snapshot=sessionSnapshot(result, session);
      if(options.expectedEngine&&snapshot.engine!==options.expectedEngine)throw reconciliationMismatch();
      return snapshot;
    }catch(error){
      if(!(error instanceof ProviderError)||(!isAmbiguousCreate(error)&&error.code!=="WAHA_SESSION_ALREADY_EXISTS"))throw error;
      let existing:unknown;
      try{existing=await this.contractSession(session,options)}catch(reconciliationError){
        if(reconciliationError instanceof ProviderError&&reconciliationError.code==="WAHA_SESSION_RECONCILIATION_MISMATCH")throw reconciliationError;
        if(reconciliationError instanceof ProviderError&&reconciliationError.status===404)throw error;
        throw new ProviderError("WAHA session reconciliation could not be completed",true,"WAHA_SESSION_RECONCILIATION_UNAVAILABLE");
      }
      verifySessionCreateContract(existing,session,options);
      return{...sessionSnapshot(existing,session),reconciled:true};
    }
  }

  async verifySessionContract(connectionId: string, options: WahaSessionCreateOptions) {
    const session = this.session(connectionId);
    const existing = await this.contractSession(session, options);
    verifySessionCreateContract(existing, session, options);
    return sessionSnapshot(existing, session);
  }

  async reconcileSessionContract(connectionId: string, options: WahaSessionCreateOptions) {
    const session = this.session(connectionId);
    const existing = await this.contractSession(session, options);
    const snapshot = verifySessionIdentityContract(existing, session, options);
    if (sessionConfigMatches(existing, options)) return snapshot;
    try {
      await this.request<unknown>(`/api/sessions/${encodeURIComponent(session)}`, {
        method: "PUT",
        body: JSON.stringify({ config: options.config }),
      }, true);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.outcomeKnown) throw error;
      try {
        const reconciled = await this.contractSession(session, options);
        verifySessionCreateContract(reconciled, session, options);
        return { ...sessionSnapshot(reconciled, session), reconciled: true as const };
      } catch {
        throw error;
      }
    }
    const updated = await this.contractSession(session, options);
    verifySessionCreateContract(updated, session, options);
    return { ...sessionSnapshot(updated, session), reconciled: true as const };
  }

  async startSession(connectionId: string) {
    return this.lifecycle(connectionId, "start");
  }

  async restartSession(connectionId: string) {
    return this.lifecycle(connectionId, "restart");
  }

  async stopSession(connectionId: string) {
    return this.lifecycle(connectionId, "stop");
  }

  async deleteSession(connectionId: string): Promise<{ sessionId: string; deleted: true }> {
    const session = this.session(connectionId);
    await this.request<unknown>(`/api/sessions/${encodeURIComponent(session)}`, { method: "DELETE" });
    return { sessionId: session, deleted: true };
  }

  async getQr(connectionId: string): Promise<WahaQrCode> {
    const session = this.session(connectionId);
    const result = await this.request<unknown>(`/api/${encodeURIComponent(session)}/auth/qr?format=image`, {
      headers: { accept: "application/json" },
    });
    const record = objectValue(result);
    const mimeType = stringValue(record?.mimetype);
    const rawData = stringValue(record?.data);
    const data = rawData?.startsWith("data:image/png;base64,") ? rawData.slice("data:image/png;base64,".length) : rawData;
    if (mimeType !== "image/png" || !data || data.length > 2_000_000 || !BASE64_VALUE.test(data)) {
      throw invalidResponse("WAHA returned an invalid QR code");
    }
    return { mimeType, data };
  }

  async requestPairingCode(connectionId: string, phoneNumber: string): Promise<{ code: string }> {
    const session = this.session(connectionId);
    if (!/^\+?[1-9]\d{5,19}$/.test(phoneNumber)) {
      throw new ProviderError("A valid international phone number is required", false, "WAHA_INVALID_REQUEST");
    }
    const result = await this.request<unknown>(`/api/${encodeURIComponent(session)}/auth/request-code`, {
      method: "POST",
      body: JSON.stringify({ phoneNumber: phoneNumber.replace(/^\+/, "") }),
    });
    const code = stringValue(objectValue(result)?.code);
    if (!code || code.length > 32 || !/^[A-Za-z0-9-]+$/.test(code)) throw invalidResponse("WAHA returned an invalid pairing code");
    return { code };
  }

  async getPasskeyChallenge(connectionId: string): Promise<WahaPasskeyChallenge> {
    const session = this.session(connectionId);
    const result = await this.request<unknown>(`/api/${encodeURIComponent(session)}/auth/passkey/challenge`);
    return passkeyChallenge(result);
  }

  async submitPasskey(connectionId: string, assertion: WahaPasskeyAssertion): Promise<{ accepted: true }> {
    const session = this.session(connectionId);
    const body = passkeyAssertion(assertion);
    await this.request<unknown>(`/api/${encodeURIComponent(session)}/auth/passkey`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { accepted: true };
  }

  async getPasskeyConfirmation(connectionId: string): Promise<{ code: string }> {
    const session = this.session(connectionId);
    const result = await this.request<unknown>(`/api/${encodeURIComponent(session)}/auth/passkey/confirmation`);
    const code = stringValue(objectValue(result)?.code);
    if (!code || code.length > 32 || !/^[A-Za-z0-9-]+$/.test(code)) {
      throw invalidResponse("WAHA returned an invalid passkey confirmation code");
    }
    return { code };
  }

  async confirmPasskey(connectionId: string): Promise<{ confirmed: true }> {
    const session = this.session(connectionId);
    await this.request<unknown>(`/api/${encodeURIComponent(session)}/auth/passkey/confirm`, {
      method: "POST",
      body: "{}",
    });
    return { confirmed: true };
  }

  async getState(connectionId: string) {
    const session = this.session(connectionId);
    const result = await this.request<unknown>(`/api/sessions/${encodeURIComponent(session)}`);
    const snapshot=sessionSnapshot(result,session);
    const mapping: Record<string, "AWAITING_AUTH" | "CONNECTING" | "WORKING" | "FAILED" | "PAUSED"> = {
      SCAN_QR_CODE: "AWAITING_AUTH",
      PASSKEY_REQUIRED: "AWAITING_AUTH",
      PASSKEY_CONFIRMATION_REQUIRED: "AWAITING_AUTH",
      STARTING: "CONNECTING",
      WORKING: "WORKING",
      FAILED: "FAILED",
      STOPPED: "PAUSED",
    };
    return { state: mapping[snapshot.status] ?? "CONNECTING", detail: snapshot.status,...(snapshot.engine?{engine:snapshot.engine}:{}) };
  }

  async getIdentity(connectionId: string) {
    const session = this.session(connectionId);
    const result = await this.request<unknown>(`/api/sessions/${encodeURIComponent(session)}/me`);
    const response = objectValue(result);
    // Current WAHA returns identity fields directly. Keep the former wrapped
    // `me` form as a compatibility fallback for one pinned release window.
    const identity = objectValue(response?.me) ?? response;
    const id = stringValue(identity?.id);
    const displayName = stringValue(identity?.pushName);
    if (!id || id.length > 256 || !id.includes("@") || hasControlCharacters(id)) {
      throw invalidResponse("WAHA returned an invalid session identity");
    }
    if (displayName && (displayName.length > 256 || hasControlCharacters(displayName))) {
      throw invalidResponse("WAHA returned an invalid session identity");
    }
    return { phone: id.split("@")[0], ...(displayName ? { displayName } : {}), sessionId: session };
  }

  async listGroups(connectionId: string, cursor?: string) {
    if (this.testRecipients !== undefined && ![...this.testRecipients].some(id => id.endsWith("@g.us"))) {
      return { groups: [], nextCursor: undefined };
    }
    const session = this.session(connectionId);
    const offset = Number(cursor ?? 0);
    const response = await this.request<unknown>(
      `/api/${encodeURIComponent(session)}/groups?limit=100&offset=${offset}${this.testRecipients === undefined ? "" : "&exclude=participants"}`,
    );
    if (!Array.isArray(response)) throw invalidResponse("WAHA returned an invalid groups page");
    let groups = this.testRecipients === undefined ? response.map(parseWahaGroup) : response.flatMap(value => {
      const group = objectValue(value);
      if ([group?.participants, group?.Participants].some(value => value != null && (!Array.isArray(value) || value.length > 0))) {
        throw new ProviderError("WAHA returned unsafe test group metadata", false, "WAHA_TEST_GROUP_METADATA_INVALID");
      }
      const id = boundedIdentifier(group?.id, 512) ?? boundedIdentifier(group?.JID, 512);
      if (!id || !wahaTestRecipientAllowed(this.testRecipients, id)) return [];
      const count = numberValue(group?.participantCount) ?? numberValue(group?.ParticipantCount);
      if ((group?.id !== undefined && group.id !== id) || (group?.JID !== undefined && group.JID !== id)
        || count === undefined) {
        throw new ProviderError("WAHA returned unsafe test group metadata", false, "WAHA_TEST_GROUP_METADATA_INVALID");
      }
      return [parseWahaGroup({ id, name: group?.name ?? group?.Name, participantCount: count })];
    });
    if (this.testRecipients === undefined && groups.some((group) => group.participantRoster?.some((participant) => !participant.displayName))) {
      const names = await this.groupParticipantNames(session).catch(() => new Map<string, string>());
      groups = groups.map((group) => ({
        ...group,
        ...(group.participantRoster ? { participantRoster: group.participantRoster.map((participant) => ({
          ...participant,
          ...(participant.displayName || !names.get(participant.id) ? {} : { displayName: names.get(participant.id)! }),
        })) } : {}),
      }));
    }
    return {
      groups,
      nextCursor: response.length === 100 ? String(offset + 100) : undefined,
    };
  }

  private async groupParticipantNames(session: string) {
    if (this.participantNames?.session === session && this.participantNames.expiresAt > Date.now()) return this.participantNames.names;
    const response = await this.request<unknown>(`/api/contacts/all?session=${encodeURIComponent(session)}`);
    if (!Array.isArray(response)) throw invalidResponse("WAHA returned an invalid contacts list");
    const names = new Map<string, string>();
    for (const value of response) {
      const contact = objectValue(value);
      const id = boundedIdentifier(contact?.id, 128);
      const name = singleLineName(contact?.pushname, 160) ?? singleLineName(contact?.pushName, 160) ?? singleLineName(contact?.name, 160);
      if (id && /^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/u.test(id) && name) names.set(id, name);
    }
    this.participantNames = { session, expiresAt: Date.now() + 60_000, names };
    return names;
  }

  async normalizeWebhook(connectionId: string, payload: unknown, headers: Headers): Promise<ProviderMessage | null> {
    const body = objectValue(payload);
    const event = stringValue(body?.event);
    if (event !== "message" && event !== "message.any" && event !== "message.reaction") return null;
    const normalized = objectValue(body?.payload) ?? body;
    if (!normalized) return null;
    const from = boundedIdentifier(normalized.chatId, 512) ?? boundedIdentifier(normalized.from, 512);
    const messageId = wahaMessageId(normalized.id);
    const participantId = boundedIdentifier(normalized.participant, 256) ?? boundedIdentifier(normalized.author, 256);
    const eventId = boundedIdentifier(headers.get("x-webhook-request-id"), 1_024)
      ?? boundedIdentifier(headers.get("x-request-id"), 1_024)
      ?? wahaMessageId(body?.id)
      ?? messageId;
    const timestamp = wahaEventTimestamp(normalized.timestamp);
    if (!from?.endsWith("@g.us") || from === "status@broadcast" || !messageId || !participantId || !eventId || !timestamp) return null;
    const reply = normalized.replyTo;
    const quotedMessageId = reply == null ? undefined : wahaMessageId(reply);
    if (reply != null && !quotedMessageId) return null;
    const media = mediaValue(normalized.media);
    const location = wahaLocation(normalized.location);
    const reactionKind = event === "message.reaction" || normalized.type === "reaction";
    const reaction = reactionKind ? objectValue(normalized.reaction) : undefined;
    if (reactionKind && !reaction) return null;
    const reactionEmoji = reaction ? stringValue(reaction.text) : undefined;
    const reactionTarget = reaction ? wahaMessageId(reaction.messageId) : undefined;
    if (reaction && (!reactionTarget || (reactionEmoji !== undefined && ([...reactionEmoji].length > 16 || /\s/u.test(reactionEmoji))))) return null;
    const text = (reaction
      ? reactionEmoji ? `Reacted with ${reactionEmoji}` : "Removed a reaction"
      : location ? wahaLocationText(location) : contactText(normalized.vCards) ?? stringValue(normalized.body) ?? "").normalize("NFC");
    if ([...text].length > 65_536 || hasControlCharactersExceptWhitespace(text)) return null;
    const participantName = wahaSenderName(normalized).name;
    return {
      provider: "waha",
      connectionId,
      eventId,
      messageId,
      groupId: from,
      participantId,
      ...(participantName ? { participantName } : {}),
      ...(reaction ? { eventKind: "REACTION" as const } : {}),
      text,
      ...((reactionTarget ?? quotedMessageId) ? { quotedMessageId: reactionTarget ?? quotedMessageId } : {}),
      fromApi: normalized.source === "api" || normalized.fromApi === true,
      fromMe: normalized.fromMe === true,
      timestamp,
      media,
    };
  }

  async normalizeDirectWebhook(connectionId: string, payload: unknown, headers: Headers): Promise<DirectProviderMessage | null> {
    const body = objectValue(payload);
    const event = stringValue(body?.event);
    if (event === "poll.vote") {
      const vote = objectValue(objectValue(body?.payload)?.vote);
      const poll = objectValue(objectValue(body?.payload)?.poll);
      const selected = Array.isArray(vote?.selectedOptions) ? vote.selectedOptions.filter((value): value is string => typeof value === "string") : [];
      const chatId = stringValue(vote?.from);
      const messageId = wahaMessageId(vote?.id);
      const timestamp = wahaEventTimestamp(vote?.timestamp);
      if (!directChatId(chatId) || vote?.to !== "me" || !messageId || !timestamp || selected.length !== 1 || selected[0]!.length > 80 || poll?.fromMe !== true) return null;
      return {
        provider: "waha", connectionId,
        eventId: headers.get("x-webhook-request-id") ?? headers.get("x-request-id") ?? wahaMessageId(body?.id) ?? messageId,
        messageId, chatId, senderId: chatId,
        input: { type: "choice", label: selected[0]! },
        fromApi: false, fromMe: false,
        timestamp,
      };
    }
    if (event !== "message" && event !== "message.any" && event !== "message.reaction") return null;
    const message = objectValue(body?.payload) ?? body;
    const chatId = stringValue(message?.chatId) ?? stringValue(message?.from);
    const messageId = wahaMessageId(message?.id);
    const timestamp = wahaEventTimestamp(message?.timestamp);
    if (!directChatId(chatId) || !messageId || !timestamp) return null;
    const location = wahaLocation(message?.location);
    const reactionKind = event === "message.reaction" || message?.type === "reaction";
    const reaction = reactionKind ? objectValue(message?.reaction) : undefined;
    if (reactionKind && !reaction) return null;
    const reactionEmoji = reaction ? stringValue(reaction.text) : undefined;
    const reactionTarget = reaction ? wahaMessageId(reaction.messageId) : undefined;
    if (reaction && (!reactionTarget || (reactionEmoji !== undefined && ([...reactionEmoji].length > 16 || /\s/u.test(reactionEmoji))))) return null;
    const text = (stringValue(message?.body) ?? contactText(message?.vCards) ?? "").normalize("NFC");
    const input: DirectProviderMessage["input"] = reaction
      ? { type: "reaction", ...(reactionEmoji ? { emoji: reactionEmoji } : {}), removed: !reactionEmoji }
      : location
      ? { type: "location", ...location }
      : { type: "text", text };
    if (input.type === "text" && ([...text].length > 65_536 || hasControlCharactersExceptWhitespace(text))) return null;
    const reply=message?.replyTo;const replyTarget=reply==null?undefined:wahaMessageId(reply);
    if(reply!=null&&!replyTarget)return null;
    const quotedMessageId=reactionTarget??replyTarget;
    const media=mediaValue(message?.media);
    const info = objectValue(objectValue(message?._data)?.Info) ?? objectValue(message?.Info);
    const { name: senderName, quality: senderNameQuality } = wahaSenderName(message);
    const senderAlt = stringValue(info?.SenderAlt) ?? stringValue(info?.senderAlt);
    const senderPhone = senderAlt ? normalizeWahaPhone(senderAlt.split("@")[0] ?? "") : undefined;
    return {
      provider: "waha", connectionId,
      eventId: headers.get("x-webhook-request-id") ?? headers.get("x-request-id") ?? wahaMessageId(body?.id) ?? messageId,
      messageId, chatId, senderId: chatId,
      ...(senderName ? { senderName } : {}),
      ...(senderNameQuality ? { senderNameQuality } : {}),
      ...(senderPhone ? { senderPhone } : {}),
      input,
      ...(quotedMessageId?{quotedMessageId}:{}),
      ...(media?{media}:{}),
      fromApi: message?.source === "api" || message?.fromApi === true,
      fromMe: message?.fromMe === true,
      timestamp,
    };
  }

  async normalizeMutationWebhook(
    connectionId: string,
    payload: unknown,
    headers: Headers,
  ): Promise<ProviderMessageMutation | null> {
    const body = objectValue(payload);
    const event = stringValue(body?.event);
    if (event !== "message.edited" && event !== "message.revoked") return null;
    const normalized = objectValue(body?.payload);
    if (!normalized) return null;
    const action = event === "message.revoked" ? objectValue(normalized.after) : normalized;
    if (!action) return null;
    const actionMessageId = wahaMessageId(action.id);
    const parsedActionId = actionMessageId ? parseMessageId(actionMessageId) : undefined;
    const groupId = boundedIdentifier(action.chatId, 512) ?? boundedIdentifier(action.from, 512) ?? parsedActionId?.chatId;
    const isDirect=directChatId(groupId);
    const participantId = boundedIdentifier(action.participant, 256) ?? boundedIdentifier(action.author, 256) ?? parsedActionId?.participantId ?? (isDirect?groupId:undefined);
    const target = wahaMessageId(event === "message.edited" ? normalized.editedMessageId : normalized.revokedMessageId);
    if (
      !actionMessageId
      || !parsedActionId || !groupId || groupId !== parsedActionId.chatId || (!groupId.endsWith("@g.us")&&!isDirect)
      || groupId === "status@broadcast"
      || !participantId
      || !target
    ) return null;
    const targetMessageIdCandidates = mutationTargetCandidates(target, groupId, participantId, parsedActionId.fromMe);
    if (targetMessageIdCandidates.length === 0) return null;
    const replacementText = event === "message.edited" ? stringValue(action.body) : undefined;
    if (replacementText !== undefined && (replacementText.length > 4096 || hasControlCharactersExceptWhitespace(replacementText))) {
      return null;
    }
    const participantName = wahaSenderName(action).name;
    const timestamp = wahaEventTimestamp(action.timestamp) ?? wahaEventTimestamp(normalized.timestamp) ?? wahaEventTimestamp(body?.timestamp);
    if (!timestamp) return null;
    const eventId = boundedIdentifier(headers.get("x-webhook-request-id"), 1_024)
      ?? boundedIdentifier(headers.get("x-request-id"), 1_024)
      ?? boundedIdentifier(body?.id, 1_024)
      ?? actionMessageId;
    if (!eventId) return null;
    return {
      provider: "waha",
      connectionId,
      eventId,
      actionMessageId,
      kind: event === "message.edited" ? "EDITED" : "REVOKED",
      targetMessageIdCandidates,
      groupId,
      participantId,
      ...(participantName ? { participantName } : {}),
      ...(replacementText !== undefined ? { replacementText } : {}),
      fromApi: action.source === "api" || action.fromApi === true,
      fromMe: typeof action.fromMe === "boolean" ? action.fromMe : parsedActionId.fromMe,
      timestamp,
    };
  }

  async normalizeReceipts(connectionId: string, payload: unknown, receivedAt?: string, connectionEngine?: "GOWS" | "NOWEB", reject?: (reason: WahaReceiptRejection) => void): Promise<ProviderReceipt[]> {
    const body = objectValue(payload);
    // WasalX manages groups only. WAHA documents message.ack for contacts and
    // the dedicated message.ack.group event for per-participant group acks.
    // Subscribing to the dedicated event avoids status/contact noise.
    if (body?.event !== "message.ack.group") return [];
    const receipt = objectValue(body.payload);
    if (!receipt) { reject?.("PAYLOAD"); return []; }
    const rawReceiptId = stringValue(receipt?.id);
    const participant = stringValue(receipt?.participant);
    const engine = connectionEngine ?? stringValue(body.engine)?.toUpperCase();
    // Pinned GOWS builds receipt IDs with the original message sender, so the
    // receipt ID already equals the ID returned by send. Other engines use the
    // documented `${messageId}_${acknowledgingParticipant}` projection.
    const participantSuffix = participant ? `_${participant}` : undefined;
    const externalMessageId = engine === "GOWS"
      ? rawReceiptId
      : rawReceiptId && participantSuffix && rawReceiptId.endsWith(participantSuffix)
        ? rawReceiptId.slice(0, -participantSuffix.length)
        : undefined;
    const providerStatus = stringValue(receipt?.ackName)?.toUpperCase();
    const ack = numberValue(receipt?.ack);
    const timestamp = wahaEventTimestamp(body.timestamp) ?? wahaEventTimestamp(receivedAt);
    if (!rawReceiptId || rawReceiptId.length > 768 || hasControlCharacters(rawReceiptId)) { reject?.("RECEIPT_ID"); return []; }
    if (!participant || participant.length > 256 || hasControlCharacters(participant)) { reject?.("PARTICIPANT"); return []; }
    if (!externalMessageId || externalMessageId.length > 512 || hasControlCharacters(externalMessageId)) { reject?.("ID_SUFFIX"); return []; }
    if (engine === "GOWS" && !parseMessageId(externalMessageId)) { reject?.("RECEIPT_ID"); return []; }
    if (!providerStatus) { reject?.("STATUS"); return []; }
    if (!timestamp) { reject?.("TIMESTAMP"); return []; }
    const status = wahaReceiptStatus(providerStatus, ack);
    if (!status) { reject?.("ACK_STATUS"); return []; }
    return [{
      provider: "waha",
      connectionId,
      externalMessageId,
      receiptKey: await providerReceiptKey(["WAHA", rawReceiptId, participant, providerStatus, timestamp]),
      // WAHA explicitly documents this event as one participant acknowledging
      // a group message. It is evidence, never an aggregate delivery state.
      scope: "PARTICIPANT_OBSERVED",
      status,
      providerStatus,
      timestamp,
      errorCodes: status === "FAILED" ? ["ERROR"] : [],
      metadata: {
        ...(Number.isInteger(ack) ? { ack: ack! } : {}),
        ...(engine && /^[A-Z0-9_-]{1,32}$/.test(engine) ? { engine } : {}),
        groupReceipt: true,
      },
    }];
  }

  async send(input: SendMessage) {
    assertWahaTestOutboundAllowed(input, this.testRecipients);
    const session = this.session(input.connectionId);
    const media=input.media;
    if(input.template||input.flow)throw new ProviderError("Official templates and WhatsApp Flows require an official API connection",false,"WAHA_UNSUPPORTED_MESSAGE");
    if (Number(Boolean(media)) + Number(Boolean(input.choices)) + Number(Boolean(input.location)) + Number(Boolean(input.reaction)) > 1) throw new ProviderError("WAHA message content is ambiguous", false, "WAHA_INVALID_REQUEST");
    if(input.reaction){
      const emoji=input.reaction.removed?"":input.reaction.emoji;
      if(input.recipientType==="DIRECT"||!input.groupId.endsWith("@g.us")||input.text||input.replyToMessageId||input.mentions?.length||!boundedIdentifier(input.reaction.messageId,512)||(input.reaction.removed&&input.reaction.emoji!=="")||(!input.reaction.removed&&!emoji)||[...emoji].length>16||/\s/u.test(emoji))
        throw new ProviderError("Reaction content is invalid",false,"WAHA_INVALID_REQUEST");
      await this.request<unknown>("/api/reaction",{method:"PUT",body:JSON.stringify({session,messageId:input.reaction.messageId,reaction:emoji})},true);
      const identity=createHash("sha256").update(`${input.idempotencyKey}\u001f${input.reaction.messageId}\u001f${emoji}`).digest("hex");
      return{externalMessageId:`reaction:${identity}`,state:"SENT" as const};
    }
    const mentions=input.mentions?.map(wahaMentionId)??[];
    if(mentions.length&&(input.recipientType==="DIRECT"||media||input.choices||input.location))throw new ProviderError("Mentions require a group text message",false,"WAHA_INVALID_REQUEST");
    const numberedChoices=input.recipientType==="DIRECT"&&input.choices
      ?renderNumberedChoices(input.text,input.choices.options)
      :undefined;
    const endpoint=numberedChoices?"/api/sendText":input.choices?"/api/sendPoll":input.location?"/api/sendLocation":media?wahaMediaEndpoint(media.mimeType):"/api/sendText";
    const body=numberedChoices?{session,chatId:input.groupId,text:numberedChoices}:input.choices?{
      session,chatId:input.groupId,poll:{name:input.text,options:input.choices.options.map((option)=>option.label),multipleAnswers:false},
    }:input.location?{
      session,chatId:input.groupId,latitude:input.location.latitude,longitude:input.location.longitude,title:input.location.name??input.location.address??"Location",
    }:media?{
      session,
      chatId:input.groupId,
      file:{mimetype:media.mimeType,filename:media.filename,data:Buffer.from(media.bytes).toString("base64")},
      ...(input.text?{caption:input.text}:{}),
      reply_to:input.replyToMessageId,
      ...(endpoint==="/api/sendVideo"?{convert:false}:endpoint==="/api/sendVoice"?{convert:true}:{}),
    }:{session,chatId:input.groupId,text:input.text,reply_to:input.replyToMessageId,...(mentions.length?{mentions}:{})};
    const result = await this.request<{ id?: string }>(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    }, true);
    if (!result.id) throw invalidResponse("WAHA response did not include a message ID", false);
    return { externalMessageId: result.id, state: "SENT" as const };
  }
}

export function assertWahaTestOutboundAllowed(input: Pick<SendMessage, "groupId" | "replyToMessageId" | "reaction">,
  allowlist=parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST)) {
  const targetIds = [input.replyToMessageId, input.reaction?.messageId].filter(value => value !== undefined);
  if (!wahaTestRecipientAllowed(allowlist, input.groupId)
    || (allowlist !== undefined && targetIds.some(value => wahaMessageRecipient(value) !== wahaMessageRecipient(`false_${input.groupId}_scope`)))) {
    const errorCode = "WAHA_TEST_RECIPIENT_NOT_ALLOWED";
    recordStructuredLog("warn", "waha.test_recipient_scope_refused", {
      request_id: safeRequestId(), component: "waha-connector", error_code: errorCode,
    });
    throw new ProviderError("WAHA recipient is outside the configured test scope", false, errorCode);
  }
}

function wahaMentionId(value:string){
  if(!/^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/u.test(value))throw new ProviderError("Mentioned participant is invalid",false,"WAHA_INVALID_REQUEST");
  return value.replace(/@s\.whatsapp\.net$/u,"@c.us");
}

function directChatId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 512 && !hasControlCharacters(value) && (value.endsWith("@c.us") || value.endsWith("@lid") || value.endsWith("@s.whatsapp.net")));
}

function validCoordinate(value: number | undefined, minimum: number, maximum: number): value is number {
  return value !== undefined && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function safeLabel(value: unknown, maximum: number) {
  const result = stringValue(value);
  return result && result.length <= maximum && !hasControlCharactersExceptWhitespace(result) ? result : undefined;
}

function boundedIdentifier(value: unknown, maximum: number) {
  const result = stringValue(value);
  return result && result.length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(result) ? result : undefined;
}

function singleLineName(value: unknown, maximum: number) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const cleaned = raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const bounded = [...cleaned].slice(0, maximum).join("").trim();
  return bounded || undefined;
}

async function providerReceiptKey(parts: string[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wahaReceiptStatus(providerStatus: string, ack: number | undefined): ProviderReceipt["status"] | undefined {
  if (providerStatus === "ERROR" || ack === -1) return "FAILED";
  if (providerStatus === "SERVER" || ack === 1) return "SENT";
  if (providerStatus === "DEVICE" || ack === 2) return "DELIVERED";
  if (providerStatus === "READ" || providerStatus === "PLAYED" || ack === 3 || ack === 4) return "READ";
  return undefined;
}

function wahaEventTimestamp(value: unknown) {
  const numeric = numberValue(value);
  const date = numeric !== undefined && numeric > 0
    ? new Date(numeric < 1e12 ? numeric * 1_000 : numeric)
    : typeof value === "string" ? new Date(value) : undefined;
  if (!date) return undefined;
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function wahaMediaEndpoint(mimeType:string){const normalized=mimeType.split(";",1)[0]?.trim().toLowerCase()??"";if(normalized.startsWith("image/"))return"/api/sendImage";if(normalized==="video/mp4")return"/api/sendVideo";if(normalized.startsWith("audio/"))return"/api/sendVoice";return"/api/sendFile"}

async function readBoundedResponse(response:Response,outcomeKnown:boolean){if(!response.body)return new Uint8Array();const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;try{while(true){const{done,value}=await reader.read();if(done)break;if(!value?.byteLength)continue;total+=value.byteLength;if(total>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>undefined);throw invalidResponse("WAHA returned an oversized response",outcomeKnown)}chunks.push(value)}}finally{reader.releaseLock()}const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}return bytes}

function sessionSnapshot(value: unknown, expectedSession: string): WahaSessionSnapshot {
  const record = objectValue(value);
  const name = stringValue(record?.name);
  const rawStatus = stringValue(record?.status);
  if (name !== expectedSession || !rawStatus) throw invalidResponse("WAHA returned an invalid session response");
  const engine = wahaEngineValue(record?.engine);
  const status = SESSION_STATUSES.has(rawStatus as WahaSessionStatus) ? (rawStatus as WahaSessionStatus) : "UNKNOWN";
  return { sessionId: expectedSession, status, ...(engine ? { engine } : {}) };
}

function wahaEngineValue(value: unknown) {
  const direct = stringValue(value) ?? stringValue(objectValue(value)?.engine);
  if (direct && /^[A-Z0-9_-]{1,32}$/u.test(direct)) return direct.toUpperCase();
  const engine = objectValue(value);
  const gows = objectValue(engine?.gows);
  // The pinned GOWS release reports runtime evidence rather than a label:
  // `{ engine: { gows: { found, connected }, grpc: ... } }`.
  if (gows?.found === true) return "GOWS";
  return undefined;
}

function alreadyExistsError(status:number,body:Uint8Array,session:string){
  if(status!==409&&status!==422)return undefined;
  let value:unknown;
  try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body))}catch{return undefined}
  const message=stringValue(objectValue(value)?.message);
  if(!message)return undefined;
  const escaped=session.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  if(message!=="Session already exists"&&!new RegExp(`^Session ["']?${escaped}["']? already exists$`).test(message))return undefined;
  return new ProviderError("WAHA session already exists",false,"WAHA_SESSION_ALREADY_EXISTS",status,true);
}

function isAmbiguousCreate(error:ProviderError){return error.outcomeKnown===false}

function verifySessionCreateContract(value:unknown,session:string,options:WahaSessionCreateOptions){
  verifySessionIdentityContract(value,session,options);
  if(!sessionConfigMatches(value,options))throw reconciliationMismatch();
}

function verifySessionIdentityContract(value:unknown,session:string,options:WahaSessionCreateOptions){
  let snapshot:WahaSessionSnapshot;
  try{snapshot=sessionSnapshot(value,session)}catch{throw reconciliationMismatch()}
  if(!options.expectedEngine||snapshot.engine!==options.expectedEngine)throw reconciliationMismatch();
  return snapshot;
}

function sessionConfigMatches(value:unknown,options:WahaSessionCreateOptions){
  const expectedConfig=objectValue(options.config);
  const actualConfig=objectValue(objectValue(value)?.config);
  const expectedMetadata=objectValue(expectedConfig?.metadata);
  const actualMetadata=objectValue(actualConfig?.metadata);
  const expectedConnectionId=stringValue(expectedMetadata?.connectionId);
  if(!expectedConnectionId||stringValue(actualMetadata?.connectionId)!==expectedConnectionId)return false;
  const expectedWebhooks=Array.isArray(expectedConfig?.webhooks)?expectedConfig.webhooks:undefined;
  const actualWebhooks=Array.isArray(actualConfig?.webhooks)?actualConfig.webhooks:undefined;
  if(!expectedWebhooks||expectedWebhooks.length!==1||!actualWebhooks||actualWebhooks.length!==1)return false;
  const expectedWebhook=objectValue(expectedWebhooks[0]);
  const actualWebhook=objectValue(actualWebhooks[0]);
  const expectedHmac=objectValue(expectedWebhook?.hmac);
  const actualHmac=objectValue(actualWebhook?.hmac);
  const expectedRetries=objectValue(expectedWebhook?.retries);
  const actualRetries=objectValue(actualWebhook?.retries);
  return Boolean(expectedWebhook&&actualWebhook)
    &&stringValue(actualWebhook?.url)===stringValue(expectedWebhook?.url)
    &&sameStringSet(actualWebhook?.events,expectedWebhook?.events)
    &&stringValue(actualHmac?.key)===stringValue(expectedHmac?.key)
    &&stringValue(actualRetries?.policy)===stringValue(expectedRetries?.policy)
    &&numberValue(actualRetries?.delaySeconds)===numberValue(expectedRetries?.delaySeconds)
    &&numberValue(actualRetries?.attempts)===numberValue(expectedRetries?.attempts);
}

function sameStringSet(actual:unknown,expected:unknown){
  if(!Array.isArray(actual)||!Array.isArray(expected)||actual.length!==expected.length||!actual.every(value=>typeof value==="string")||!expected.every(value=>typeof value==="string"))return false;
  return [...new Set(actual)].length===actual.length&&[...new Set(expected)].length===expected.length&&actual.every(value=>expected.includes(value));
}

function reconciliationMismatch(){return new ProviderError("Existing WAHA session does not match the expected WasalX provisioning contract",false,"WAHA_SESSION_RECONCILIATION_MISMATCH")}

function passkeyChallenge(value: unknown): WahaPasskeyChallenge {
  const record = objectValue(value);
  const challenge = boundedBase64(record?.challenge);
  const rpId = stringValue(record?.rpId);
  if (!challenge || rpId !== "web.whatsapp.com") throw invalidResponse("WAHA returned an invalid passkey challenge");
  const result: WahaPasskeyChallenge = { challenge, rpId };
  const timeout = numberValue(record?.timeout);
  if (timeout !== undefined && timeout > 0 && timeout <= 300_000) result.timeout = timeout;
  const verification = stringValue(record?.userVerification);
  if (verification === "discouraged" || verification === "preferred" || verification === "required") {
    result.userVerification = verification;
  }
  if (record?.allowCredentials !== undefined) {
    if (!Array.isArray(record.allowCredentials) || record.allowCredentials.length > 100) {
      throw invalidResponse("WAHA returned invalid passkey credentials");
    }
    result.allowCredentials = record.allowCredentials.map((value) => {
      const credential = objectValue(value);
      const id = boundedBase64(credential?.id);
      if (!id || credential?.type !== "public-key") throw invalidResponse("WAHA returned invalid passkey credentials");
      const transports = Array.isArray(credential.transports)
        ? credential.transports.filter((transport): transport is WahaAuthenticatorTransport =>
            typeof transport === "string" && PASSKEY_TRANSPORTS.has(transport as WahaAuthenticatorTransport),
          )
        : undefined;
      return { id, type: "public-key" as const, ...(transports?.length ? { transports } : {}) };
    });
  }
  return result;
}

function passkeyAssertion(value: WahaPasskeyAssertion): WahaPasskeyAssertion {
  const record = objectValue(value);
  const response = objectValue(record?.response);
  const id = boundedBase64(record?.id);
  const rawId = boundedBase64(record?.rawId);
  const clientDataJSON = boundedBase64(response?.clientDataJSON, 65_536);
  const authenticatorData = boundedBase64(response?.authenticatorData, 65_536);
  const signature = boundedBase64(response?.signature, 65_536);
  if (!id || !rawId || record?.type !== "public-key" || !clientDataJSON || !authenticatorData || !signature) {
    throw new ProviderError("Passkey assertion is invalid", false, "WAHA_INVALID_REQUEST");
  }
  const userHandle = response?.userHandle === null ? null : boundedBase64(response?.userHandle, 65_536);
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

function boundedBase64(value: unknown, maxLength = 16_384) {
  const normalized = stringValue(value);
  return normalized && normalized.length <= maxLength && BASE64_VALUE.test(normalized) ? normalized : undefined;
}

function invalidResponse(message: string, outcomeKnown = true) {
  return new ProviderError(message, false, "WAHA_INVALID_RESPONSE", undefined, outcomeKnown);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coordinateValue(value: unknown) {
  if (typeof value === "number") return numberValue(value);
  if (typeof value !== "string" || value.length > 32 || !/^-?\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function wahaLocation(value: unknown) {
  const location = objectValue(value);
  const latitude = coordinateValue(location?.latitude) ?? coordinateValue(location?.lat);
  const longitude = coordinateValue(location?.longitude) ?? coordinateValue(location?.lng);
  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) return undefined;
  const name = safeLabel(location?.name, 160);
  const address = safeLabel(location?.address, 500);
  return { latitude, longitude, ...(name ? { name } : {}), ...(address ? { address } : {}) };
}

function wahaLocationText(location: NonNullable<ReturnType<typeof wahaLocation>>) {
  return ["Shared location", ...(location.name ? [`Name: ${location.name}`] : []), ...(location.address ? [`Address: ${location.address}`] : []), `Coordinates: ${location.latitude}, ${location.longitude}`].join("\n");
}

function contactText(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return undefined;
  const contacts = value.map((card) => {
    if (typeof card !== "string" || card.length > 16_384 || hasControlCharactersExceptWhitespace(card)) return "Shared contact";
    const lines = card.replace(/\r?\n[ \t]/gu, "").split(/\r?\n/u);
    const field = (name: string, maximum: number) => {
      const line = lines.find((item) => item.toUpperCase().startsWith(`${name}:`) || item.toUpperCase().startsWith(`${name};`));
      const raw = line?.slice((line.indexOf(":") < 0 ? line.length : line.indexOf(":")) + 1)
        .replace(/\\[nN]/gu, " ").replace(/\\([,;\\])/gu, "$1").trim();
      return safeLabel(raw, maximum);
    };
    const name = field("FN", 160);
    const phone = field("TEL", 64);
    return ["Shared contact", ...(name ? [`Name: ${name}`] : []), ...(phone ? [`Phone: ${phone}`] : [])].join("\n");
  });
  return contacts.join("\n\n");
}

function parseWahaGroup(value: unknown): ProviderGroup {
  const group = objectValue(value);
  if (!group) throw invalidResponse("WAHA returned an invalid group record");

  // The pinned GOWS engine exposes the upstream Go structure with canonical
  // `JID`, `Name`, `Participants`, and `ParticipantCount` fields. NOWEB and
  // older WAHA releases use the lower-case REST projection. Normalize both at
  // the provider boundary so the durable group contract stays engine-neutral.
  const id = boundedIdentifier(group.id, 512) ?? boundedIdentifier(group.JID, 512);
  const name = singleLineName(group.name, 256) ?? singleLineName(group.Name, 256);
  const participantArray = Array.isArray(group.participants)
    ? group.participants
    : Array.isArray(group.Participants)
      ? group.Participants
      : undefined;
  const declaredParticipants = numberValue(group.participantCount) ?? numberValue(group.ParticipantCount);
  // GOWS currently returns ParticipantCount=0 for some populated groups while
  // the Participants array is authoritative. Conversely, privacy-limited
  // responses may expose only a larger numeric count. Retain the strongest
  // bounded evidence; the worker persists the roster only for opted-in groups.
  const participants = Math.max(declaredParticipants ?? 0, participantArray?.length ?? 0);
  const pictureUrl = stringValue(group.pictureUrl) ?? stringValue(group.PictureUrl) ?? stringValue(group.PictureURL);
  const parsedRoster = participantArray
    ? [...new Map(participantArray.slice(0, 5_000).map(parseWahaGroupParticipant).filter((participant) => participant !== undefined).map((participant) => [participant.id, participant])).values()]
    : [];
  const participantRoster = participantArray && (participantArray.length === 0 || parsedRoster.length > 0) ? parsedRoster : undefined;

  if (!id || !name || !Number.isSafeInteger(participants) || participants < 0) {
    throw invalidResponse("WAHA returned an invalid group record");
  }
  return { id, name, participants, ...(pictureUrl ? { pictureUrl } : {}), ...(participantRoster ? { participantRoster } : {}) };
}

function parseWahaGroupParticipant(value: unknown) {
  const participant = objectValue(value);
  if (!participant) return undefined;
  const id = boundedIdentifier(participant.JID, 128) ?? boundedIdentifier(participant.id, 128) ?? boundedIdentifier(participant.LID, 128);
  if (!id || !/^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/u.test(id)) return undefined;
  const rawPhone = boundedIdentifier(participant.PhoneNumber, 128);
  const normalizedPhone = rawPhone ? normalizeWahaPhone(rawPhone.split("@")[0] ?? "") : undefined;
  const displayName = singleLineName(participant.DisplayName, 160) ?? singleLineName(participant.displayName, 160);
  return { id, ...(normalizedPhone ? { normalizedPhone } : {}), ...(displayName ? { displayName } : {}) };
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function hasControlCharactersExceptWhitespace(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") || code === 127;
  });
}

function wahaSenderName(message: Record<string, unknown> | undefined) {
  const info = objectValue(objectValue(message?._data)?.Info) ?? objectValue(message?.Info);
  const verified = objectValue(info?.VerifiedName) ?? objectValue(info?.verifiedName);
  const details = objectValue(verified?.Details) ?? objectValue(verified?.details);
  const verifiedName = singleLineName(details?.verifiedName, 256);
  const notifyName = singleLineName(message?.notifyName, 256);
  const pushName = singleLineName(info?.PushName, 256) ?? singleLineName(info?.pushName, 256);
  return { name: verifiedName ?? notifyName ?? pushName,
    quality: verifiedName ? "VERIFIED" as const : notifyName ? "NOTIFY" as const : pushName ? "PUSH" as const : undefined };
}

function parseMessageId(value: string) {
  if (!FULL_MESSAGE_ID.test(value) || hasControlCharacters(value)) return undefined;
  const firstSeparator = value.indexOf("_");
  const secondSeparator = value.indexOf("_", firstSeparator + 1);
  if (firstSeparator < 4 || secondSeparator < firstSeparator + 3) return undefined;
  const prefix=value.slice(0,firstSeparator);
  if(prefix!=="true"&&prefix!=="false")return undefined;
  const fromMe = prefix === "true";
  const chatId = value.slice(firstSeparator + 1, secondSeparator);
  if (!chatId.endsWith("@g.us")&&!directChatId(chatId)) return undefined;
  const remainder = value.slice(secondSeparator + 1);
  const thirdSeparator = remainder.indexOf("_");
  const token = thirdSeparator < 0 ? remainder : remainder.slice(0, thirdSeparator);
  const participantId = thirdSeparator < 0 ? undefined : remainder.slice(thirdSeparator + 1);
  if (!MESSAGE_ID_TOKEN.test(token) || (participantId && (participantId.length > 256 || hasControlCharacters(participantId)))) {
    return undefined;
  }
  return { fromMe, chatId, participantId };
}

function mutationTargetCandidates(target: string, groupId: string, participantId: string, fromMe: boolean) {
  if (FULL_MESSAGE_ID.test(target)) return parseMessageId(target)?.chatId === groupId ? [target] : [];
  if (!MESSAGE_ID_TOKEN.test(target)) return [];
  const prefix = `${fromMe ? "true" : "false"}_${groupId}_${target}`;
  return [...new Set([`${prefix}_${participantId}`, prefix])];
}

function mediaValue(value: unknown): ProviderMessage["media"] {
  if (!value || typeof value !== "object") return undefined;
  const media = value as Record<string, unknown>;
  const mime = typeof media.mimetype === "string" ? media.mimetype : typeof media.mimeType === "string" ? media.mimeType : undefined;
  if (!mime) return undefined;
  const type = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
  return {
    type,
    url: typeof media.url === "string" ? media.url : undefined,
    mimeType: mime,
    fileName: typeof media.filename === "string" ? media.filename : undefined,
    ...(media.isSticker === true || media.type === "sticker" ? { isSticker: true } : {}),
  };
}

function wahaMessageId(value: unknown) {
  if (typeof value === "string") return boundedIdentifier(value, 1_024);
  const record = objectValue(value);
  if (!record) return undefined;
  return boundedIdentifier(record._serialized, 1_024)
    ?? boundedIdentifier(record.id, 1_024)
    ?? boundedIdentifier(objectValue(record.id)?._serialized, 1_024);
}
