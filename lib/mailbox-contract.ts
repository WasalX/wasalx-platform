export type MailboxConfig = {
  email: string; name: string; team_id: string;
  inbound: { host: string; port: number; user: string; folder: string; security: "TLS" | "STARTTLS" };
  outbound: { host: string; port: number; user: string; security: "TLS" | "STARTTLS" };
};
export type MailboxRow = {
  id: string; config: MailboxConfig; version: string; active: boolean; editable: boolean; team_name: string | null;
  inbound_credential_configured: boolean; outbound_credential_configured: boolean;
  verification: "NOT_VERIFIED" | "RUNNING" | "VERIFIED" | "FAILED" | "UNKNOWN";
  verification_operation_id: string | null; verification_version: string | null;
};
export type MailboxOperation = "MAILBOX_LIST" | "MAILBOX_SHOW" | "MAILBOX_CREATE" | "MAILBOX_SAVE" |
  "MAILBOX_VERIFY_START" | "MAILBOX_VERIFY_STATUS" | "MAILBOX_VERIFY_RECHECK" | "MAILBOX_ACTIVATE" | "MAILBOX_PAUSE" | "MAILBOX_RECEIPT" |
  "MAILBOX_SIGNATURE_SHOW" | "MAILBOX_SIGNATURE_SAVE";
export type MailboxExecute = <T>(operation: MailboxOperation, input: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;
