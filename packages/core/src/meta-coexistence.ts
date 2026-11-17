import { createHash } from "node:crypto";
import { metaId, object } from "./meta-signup.js";
import { metaLifecyclePayloadSha256 } from "./meta-account-relation.js";
export type * from "./meta-coexistence-contract.js";

export type CoexistenceMessage = {
  id: string; subject: string; direction: "INBOUND" | "OUTBOUND"; timestamp: number;
  type: string; text: string | null; mediaId: string | null; quotedId: string | null;
};
export type CoexistenceContact = { subject: string; name: string | null; action: "add" | "remove"; timestamp: number };
export type CoexistenceUnit = {
  schemaVersion: 1; kind: "HISTORY" | "HISTORY_MEDIA" | "CONTACTS" | "ECHO" | "DECLINED";
  wabaId: string; phoneId: string; businessPhone: string; key: string; sourceSha256: string;
  phase: number | null; chunkOrder: number | null; progress: number | null;
  messages: CoexistenceMessage[]; contacts: CoexistenceContact[];
};

/** Normalize only explicitly supported direct data. Never fall back to live messages. */
export function metaCoexistenceUnits(entryId: unknown, field: unknown, value: unknown, now = Date.now()): CoexistenceUnit[] {
  if (!["history", "smb_app_state_sync", "smb_message_echoes"].includes(String(field))) return [];
  const row = object(value), metadata = object(row?.metadata);
  if (!metaId(entryId) || !row || row.messaging_product !== "whatsapp" || !metaId(metadata?.phone_number_id)) invalid();
  if (Object.hasOwn(row, "group_id") || Object.hasOwn(metadata!, "group_id")) invalid();
  const businessPhone = coexistencePhone(metadata?.display_phone_number);
  if (!businessPhone) invalid();
  const base = { schemaVersion: 1 as const, wabaId: entryId, phoneId: metadata!.phone_number_id as string, businessPhone,
    phase: null, chunkOrder: null, progress: null, messages: [], contacts: [] };
  // Hash the selected original provider unit before typing; companion batching and
  // object-key ordering do not alter its identity. Raw-body HMAC remains separate.
  const sourceHash = (selected: Record<string, unknown>) => metaLifecyclePayloadSha256({ entryId, field,
    value: { messaging_product: row.messaging_product, metadata: row.metadata, ...selected } });
  const shapes = ["history", "messages", "state_sync", "message_echoes"].filter(key => Object.hasOwn(row, key));
  if (shapes.length !== 1 || (field === "history" ? !["history", "messages"].includes(shapes[0]!)
    : shapes[0] !== (field === "smb_app_state_sync" ? "state_sync" : "message_echoes"))) invalid();
  if (field === "smb_app_state_sync") {
    const contacts = boundedArray(row.state_sync, 1000).map(item => {
      const state = object(item), contact = object(state?.contact);
      const subject = coexistencePhone(contact?.phone_number);
      if (state?.type !== "contact" || !subject || !["add", "remove"].includes(String(state.action))) invalid();
      return { subject, action: state.action as "add" | "remove", timestamp: timestamp(object(state.metadata)?.timestamp, now),
        name: state.action === "remove" ? null : optionalText(contact?.full_name ?? contact?.first_name, 160) };
    });
    return [{ ...base, kind: "CONTACTS", key: coexistenceHash(contacts), sourceSha256: sourceHash({ state_sync: row.state_sync }), contacts }];
  }
  if (field === "smb_message_echoes") {
    return boundedArray(row.message_echoes, 1000).map(item => {
      const message = parseMessage(item, businessPhone, undefined, now, true);
      return { ...base, kind: "ECHO", key: coexistenceHash(message.id), sourceSha256: sourceHash({ message_echoes: [item] }), messages: [message] };
    });
  }
  if (shapes[0] === "messages") {
    return boundedArray(row.messages, 1000).map(item => {
      const message = parseMessage(item, businessPhone, undefined, now, false);
      if (!message.mediaId) invalid();
      // The documented supplement's from is the customer even for an outbound placeholder.
      // Direction is resolved against the retained placeholder, never inferred as live inbound.
      return { ...base, kind: "HISTORY_MEDIA", key: coexistenceHash(message.id), sourceSha256: sourceHash({ messages: [item] }), messages: [message] };
    });
  }
  let count = 0;
  return boundedArray(row.history, 100).map(item => {
    const chunk = object(item);
    if (!chunk) invalid();
    if (Object.hasOwn(chunk, "errors")) {
      if (Object.hasOwn(chunk, "threads") || Object.hasOwn(chunk, "metadata")
        || boundedArray(chunk.errors, 10).some(error => object(error)?.code !== 2593109)) invalid();
      return { ...base, kind: "DECLINED", key: "declined", sourceSha256: sourceHash({ history: [item] }) };
    }
    const meta = object(chunk.metadata);
    const phase = boundedNumber(meta?.phase, 0, 2), chunkOrder = boundedNumber(meta?.chunk_order, 0, 1_000_000);
    const progress = boundedNumber(meta?.progress, 0, 100);
    const messages: CoexistenceMessage[] = [];
    for (const thread of boundedArray(chunk.threads, 1000)) {
      const threadRow = object(thread), subject = coexistencePhone(threadRow?.id);
      if (!subject || subject === businessPhone || Object.hasOwn(threadRow!, "group_id")) invalid();
      for (const message of boundedArray(threadRow?.messages, 1000)) {
        if (++count > 5000) invalid();
        messages.push(parseMessage(message, businessPhone, subject, now, false));
      }
    }
    return { ...base, kind: "HISTORY", key: `${phase}:${chunkOrder}`, sourceSha256: sourceHash({ history: [item] }), phase, chunkOrder, progress, messages };
  });
}

export function coexistencePhone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 || !/^\+?[0-9 ()-]+$/u.test(value)) return;
  const phone = value.replace(/[+ ()-]/gu, "");
  return /^[1-9][0-9]{5,19}$/u.test(phone) ? phone : undefined;
}
export function coexistenceHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function coexistenceSubjectDigest(tenantId: string, appId: string, phoneId: string, subject: string) {
  return createHash("sha256").update(`meta-coexistence-v1:${tenantId}:${appId}:${phoneId}:PHONE:${subject}`).digest("hex");
}
function parseMessage(value: unknown, businessPhone: string, thread: string | undefined, now: number, echo: boolean): CoexistenceMessage {
  const row = object(value), from = coexistencePhone(row?.from), to = coexistencePhone(row?.to);
  const subject = thread ?? (from === businessPhone ? to : from);
  if (!row || Object.hasOwn(row, "group_id") || !subject || subject === businessPhone || !from || (echo && from !== businessPhone)
    || (from !== subject && from !== businessPhone) || (row.to !== undefined && to !== subject && to !== businessPhone)
    || (from === businessPhone && to !== undefined && to !== subject)) invalid();
  const type = boundedIdentifier(row.type, 64);
  const content = object(row[type]);
  const text = type === "text" ? optionalText(content?.body, 16000) : optionalText(content?.caption, 4096);
  if (type === "text" && text === null) invalid();
  const media = ["image", "video", "audio", "document", "sticker"].includes(type);
  return { id: boundedIdentifier(row.id, 512), subject, direction: from === businessPhone ? "OUTBOUND" : "INBOUND",
    timestamp: timestamp(row.timestamp, now), type, text,
    mediaId: media && content?.id !== undefined ? boundedIdentifier(content.id, 512) : null,
    quotedId: object(row.context)?.id === undefined ? null : boundedIdentifier(object(row.context)!.id, 512) };
}
function timestamp(value: unknown, now: number) {
  if (typeof value !== "string" || !/^\d{1,12}$/u.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > Math.floor(now / 1000) + 300) invalid();
  return number;
}
function boundedNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
}
function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max) invalid(); return value;
}
function boundedIdentifier(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || /\p{Cc}/u.test(value)) invalid(); return value;
}
function optionalText(value: unknown, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > max || Array.from(value).some(character => /\p{Cc}/u.test(character) && !["\t", "\n", "\r"].includes(character))) invalid();
  return value;
}
function invalid(): never { throw new Error("Invalid Meta Business app data"); }
