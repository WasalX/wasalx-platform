export type InboxTicket = {
  id: string; number: string; title: string; updated_at: string; state: string; closed: boolean;
  team: string; team_id: string; owner: string | null; owner_id: string; customer: string | null; channel: "whatsapp" | "email" | "other";
};
export type InboxEmailDelivery = { state: "SENT" | "UNCONFIRMED"; attempts: number | null; automatic_attempts_ended: boolean; notice: boolean };
export type InboxRecipientDelivery = { state: "CLEAR" | "RECENT_FAILURE" | "UNCONFIRMED"; reason: "INVALID_ADDRESS" | "BOUNCE_OR_DELIVERY_FAILURE" | null };
export type InboxDetail = InboxTicket & {
  teams: Array<{ id: string; name: string }>; owner_team_id: string; upload_constraints: InboxUploadConstraints;
  recipient_delivery?: InboxRecipientDelivery | null;
  can_update: boolean; can_reply: boolean; owners: Array<{ id: string; name: string }>;
  states: Array<{ id: string; name: string; closed: boolean }>;
};
export type InboxArticle = {
  id: string; has_source?: boolean; body: string; body_complete: boolean; body_sha256: string; total_characters: number; internal: boolean; author: string | null; sender: string; created_at: string;
  delivery?: InboxEmailDelivery | null;
  attachments: Array<{ id: string; filename: string; size: number }>;
};
export type InboxPage<T> = { items: T[]; next_cursor: string | null };
export type InboxOperation = "CHECK" | "LIST" | "SHOW" | "ARTICLES" | "REPLY" | "UPDATE" | "RECEIPT" | "CREATE_OPTIONS" | "CREATE_TICKET" | "CREATE_RECEIPT" | "ARTICLE_CONTENT" | "REMOVE_UPLOAD" | "SOURCE_CONTEXT" | "PREVIEW";

export type InboxUpload = { id: string; name: string; bytes: number; mime_type: string };
export type InboxUploadConstraints = { accepted: { mime_type: string; maximum_bytes: number }[] | null; maximum_file_bytes: number; maximum_files: number; maximum_total_bytes: number };
export type InboxCreateOptions = {
  groups: { id: string; name: string }[]; owners: { id: string; name: string }[];
  states: { id: string; name: string; closed: boolean }[];
  customers: { id: string; name: string; email: string | null }[];
  can_create: boolean; channels: { note: boolean; email: boolean };
  upload_constraints: InboxUploadConstraints;
};
export type InboxCreateInput = {
  operation_id: string; title: string; group_id: string; owner_id?: string;
  state_id: string; body: string; internal: boolean; form_id?: string; attachment_ids?: string[];
} & ({ customer_id: string; customer?: never } | { customer: { email: string; name?: string }; customer_id?: never });
export type InboxSourceContext = { group_id: string; message_id: string };
export type InboxArticleContent = { article_id: string; body: string; body_sha256: string; next_offset: number | null; total_characters: number };
export type InboxCompletenessContract = {
  SOURCE_CONTEXT: { input: { ticket_id: string; article_id: string }; output: InboxSourceContext };
  CREATE_OPTIONS: { input: { group_id?: string; query?: string }; output: InboxCreateOptions };
  CREATE_TICKET: { input: InboxCreateInput; output: { state: "APPLIED"; ticket_id: string; ticket_number: string; article_id: string; operation_id: string } };
  CREATE_RECEIPT: { input: { operation_id: string; action: "LOOKUP" | "CANCEL_IF_UNADMITTED" };
    output: { state: "APPLIED" | "UNKNOWN" | "NOT_APPLIED"; terminal?: boolean; ticket_number?: string } };
  ARTICLE_CONTENT: { input: { ticket_id: string; article_id: string; offset?: number; limit?: number; expected_sha256?: string }; output: InboxArticleContent };
};


export type InboxReplyPreview = { draft_sha256: string; ticket_updated_at: string; channel: "internal_note" | "email" | "whatsapp" | "other";
  text: string | null; recipient: string | null; team: string; quoted: boolean; can_send: boolean; handover_required: boolean;
  routing_notice: "INTERNAL_ONLY" | "EMAIL" | "WHATSAPP" | "HANDOVER_REQUIRED" | "UNAVAILABLE" };
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
export function parseInboxCreatePending(raw: string | null): { operation_id: string } | null {
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error("Invalid recovery metadata");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "operation_id" || !("operation_id" in value)
    || typeof value.operation_id !== "string" || !UUID.test(value.operation_id)) throw new Error("Invalid recovery metadata");
  return { operation_id: value.operation_id };
}
export function parseInboxPending(raw: string | null): { ticket_id: string; operation_id: string; kind: "REPLY" | "UPDATE" } | null {
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error("Invalid recovery metadata");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery metadata");
  const keys = Object.keys(value).sort().join(",");
  if (!["operation_id,ticket_id", "kind,operation_id,ticket_id"].includes(keys) || !("ticket_id" in value) || typeof value.ticket_id !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value.ticket_id)
    || !("operation_id" in value) || typeof value.operation_id !== "string" || !UUID.test(value.operation_id)
    || "kind" in value && (typeof value.kind !== "string" || !["REPLY", "UPDATE"].includes(value.kind))) throw new Error("Invalid recovery metadata");
  return { ticket_id: value.ticket_id, operation_id: value.operation_id, kind: "kind" in value && value.kind === "REPLY" ? "REPLY" : "UPDATE" };
}
