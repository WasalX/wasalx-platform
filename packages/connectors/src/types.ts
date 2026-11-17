import type { MetaDirectIdentity, MetaDirectRecipient, MetaIdentityChange } from "../../core/src/meta-direct-identity.js";

export type Provider = "waha" | "meta";
export type ConnectionState = "PROVISIONING"|"AWAITING_AUTH"|"CONNECTING"|"WORKING"|"DEGRADED"|"ACTION_REQUIRED"|"FAILED"|"PAUSED"|"REVOKED";
export type DeliveryState = "QUEUED"|"CLAIMED"|"SENDING"|"SENT"|"DELIVERED"|"READ"|"FAILED_RETRYABLE"|"FAILED_TERMINAL"|"OUTCOME_UNKNOWN";

export type ProviderMessage = {
  provider: Provider;
  connectionId: string;
  eventId: string;
  messageId: string;
  groupId: string;
  participantId: string;
  participantName?: string;
  participantPhone?: string;
  eventKind?: "MESSAGE" | "REACTION";
  text: string;
  quotedMessageId?: string;
  fromApi: boolean;
  fromMe?: boolean;
  timestamp: string;
  media?: { type: "image"|"video"|"audio"|"document"; url?: string; mimeType?: string; fileName?: string; isSticker?: boolean };
};

export type DirectProviderIdentityChange = {
  provider: "meta";
  connectionId: string;
  eventId: string;
  messageId: string;
  timestamp: string;
  change: MetaIdentityChange;
};

export type DirectProviderMessage = {
  provider: Provider;
  connectionId: string;
  eventId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  senderNameQuality?: "PUSH" | "NOTIFY" | "VERIFIED" | "CONTACT";
  senderPhone?: string;
  /** Signed provider evidence; resolve canonical identity before any direct customer/effect. */
  metaIdentity?: MetaDirectIdentity;
  input:
    | { type: "text"; text: string }
    | { type: "choice"; choiceId?: string; label: string; source?: never }
    | { type: "choice"; choiceId: string; label: string; source: "META_NATIVE" }
    | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
    | { type: "reaction"; emoji?: string; removed: boolean }
    | { type: "unsupported"; text: string }
    | { type: "flow_response"; flowToken: string; data: Record<string, string> };
  fromApi: boolean;
  fromMe: boolean;
  timestamp: string;
  quotedMessageId?: string;
  media?: ProviderMessage["media"];
};

export type ProviderMessageMutation = {
  provider: "waha";
  connectionId: string;
  eventId: string;
  actionMessageId: string;
  kind: "EDITED" | "REVOKED";
  targetMessageIdCandidates: string[];
  groupId: string;
  participantId: string;
  participantName?: string;
  replacementText?: string;
  fromApi: boolean;
  fromMe: boolean;
  timestamp: string;
};

export type ProviderReceipt = {
  metaPricingObservation?: import("../../core/src/meta-pricing-observation.js").MetaPricingObservation;
  provider: Provider;
  connectionId: string;
  externalMessageId: string;
  /** SHA-256 of provider receipt identity fields; never contains a recipient ID. */
  receiptKey: string;
  /** MESSAGE can advance the delivery projection; PARTICIPANT_OBSERVED is evidence only. */
  scope: "MESSAGE" | "PARTICIPANT_OBSERVED";
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  providerStatus: string;
  timestamp: string;
  errorCodes: string[];
  /** Bounded, non-sensitive operational facts only. */
  metadata: Record<string, string | number | boolean>;
};

export type SendMessage = {
  connectionId: string;
  groupId: string;
  text: string;
  recipientType?: "GROUP" | "DIRECT";
  /** META DIRECT only; project the immutable, asset-bound outbox snapshot. */
  metaDirectRecipient?: MetaDirectRecipient;
  /** Server-projected immutable account policy; never selected by a recipient. */
  messagingAccountId?: string;
  replyToMessageId?: string;
  reaction?: { messageId: string; emoji: string; removed: boolean };
  mentions?: string[];
  idempotencyKey: string;
  choices?: { buttonLabel?: string; options: Array<{ id: string; label: string }> };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  template?: { name: string; languageCode: string; bodyParameters: string[] };
  flow?: { id: string; token: string; buttonLabel: string; screen?: string; data: Record<string, string> };
  media?: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    providerMediaId?: string;
  };
};

export type PreparedProviderMedia = { providerMediaId: string };

export type ProviderGroupParticipant = { id:string; normalizedPhone?:string; displayName?:string };
export type ProviderGroup = { id:string; name:string; participants:number; pictureUrl?:string; participantRoster?:ProviderGroupParticipant[] };
export type ProviderIdentity = { phone:string; displayName?:string; sessionId:string };

export interface MessagingProviderAdapter {
  readonly provider: Provider;
  getState(connectionId:string): Promise<{state:ConnectionState;detail?:string}>;
  getIdentity(connectionId:string): Promise<ProviderIdentity>;
  listGroups(connectionId:string,cursor?:string): Promise<{groups:ProviderGroup[];nextCursor?:string}>;
  normalizeWebhook(connectionId:string,payload:unknown,headers:Headers): Promise<ProviderMessage|null>;
  normalizeDirectWebhook?(connectionId:string,payload:unknown,headers:Headers): Promise<DirectProviderMessage|null>;
  normalizeIdentityChangeWebhook?(connectionId:string,payload:unknown): Promise<DirectProviderIdentityChange|null>;
  normalizeMutationWebhook?(connectionId:string,payload:unknown,headers:Headers): Promise<ProviderMessageMutation|null>;
  normalizeReceipts?(connectionId:string,payload:unknown,receivedAt?:string,connectionEngine?:"GOWS"|"NOWEB"): Promise<ProviderReceipt[]>;
  prepareMedia?(input:SendMessage): Promise<PreparedProviderMedia>;
  send(input:SendMessage): Promise<{externalMessageId:string;state:DeliveryState}>;
}

export class ProviderError extends Error {
  constructor(
    message:string,
    public readonly retryable:boolean,
    public readonly code:string,
    public readonly status?:number,
    public readonly outcomeKnown=true,
  ) { super(message); this.name="ProviderError"; }
}
