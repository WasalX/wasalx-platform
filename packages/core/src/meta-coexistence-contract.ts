/** Inert Business app read model. None of these records grants messaging or identity authority. */
export type MetaCoexistenceConsent = { version: "2026-10-07"; history: boolean; contacts: boolean; echoes: true };
export type MetaCoexistenceRequestState = "NOT_REQUESTED" | "QUEUED" | "CLAIMED" | "ACCEPTED" | "REJECTED" | "UNKNOWN" | "EXPIRED" | "STOPPED" | "HELD_CONTACTS_UNKNOWN";
export type MetaCoexistenceSummary = {
  revision: number;
  consent: { history: boolean; contacts: boolean; echoes: boolean };
  contactsRequest: MetaCoexistenceRequestState;
  historyRequest: MetaCoexistenceRequestState;
  historyObservation: "WAITING" | "RECEIVING" | "PROVIDER_FINISHED" | "DECLINED" | "PARTIAL";
  windowEvidence: "UNKNOWN" | "TIMESTAMP_OBSERVED";
  providerProgress: number | null;
  processedChunks: number;
  messageCount: number;
  contactCount: number;
  lastActivityAt: string | null;
  holdReason: "STOPPED" | "REVIEW_REQUIRED" | "MEDIA_UNAVAILABLE" | null;
};
export type MetaCoexistenceContactView = { threadId: string; phone: string; name: string | null; lastChangedAt: string; removed: boolean };
export type MetaCoexistenceMessageView = {
  id: string; threadId: string; direction: "INBOUND" | "OUTBOUND"; source: "LIVE" | "HISTORY" | "ECHO";
  timestamp: string; type: string; text: string | null; media: "NOT_APPLICABLE" | "PLACEHOLDER" | "REFERENCE_ONLY";
};
export type MetaCoexistencePage<T> = { items: T[]; nextCursor: string | null };
export type MetaCoexistenceConsentRequest = { expectedRevision: number; history: false; contacts: false; echoes: false };
export type MetaSignupSessionLogRequest = {
  challenge: string; event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" | "CANCEL" | "ERROR";
  sessionInfoVersion: "3"; sourceOrigin: "https://www.facebook.com" | "https://web.facebook.com";
  traceSha256: string;
};
