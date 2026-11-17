/** Undefined means the operator explicitly disabled the fence with the literal "*". */
export type WahaTestRecipientAllowlist = ReadonlySet<string> | undefined;

function recipientKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128 || value !== value.trim()) return undefined;
  if (/^\+?[1-9][0-9]{5,19}$/u.test(value)) return `${value.replace(/^\+/u, "")}@c.us`;
  if (/^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/u.test(value)) {
    return value.replace(/@s\.whatsapp\.net$/u, "@c.us");
  }
  return /^[1-9][0-9-]{4,63}@g\.us$/u.test(value) ? value : undefined;
}

export function parseWahaTestRecipientAllowlist(raw: string | undefined): WahaTestRecipientAllowlist {
  if (raw === "*") return undefined;
  if (raw === undefined || raw.trim() === "") return new Set();
  if (raw.length > 8_192) throw new Error("WASALX_TEST_RECIPIENT_ALLOWLIST is invalid");
  let values: unknown;
  try { values = JSON.parse(raw); } catch { throw new Error("WASALX_TEST_RECIPIENT_ALLOWLIST must be a JSON array"); }
  if (!Array.isArray(values) || values.length > 64) throw new Error("WASALX_TEST_RECIPIENT_ALLOWLIST is invalid");
  const keys = values.map(recipientKey);
  if (keys.some(key => key === undefined)) throw new Error("WASALX_TEST_RECIPIENT_ALLOWLIST contains an invalid recipient");
  return new Set(keys as string[]);
}

export function wahaTestRecipientAllowed(allowlist: WahaTestRecipientAllowlist, recipient: unknown): boolean {
  if (allowlist === undefined) return true;
  const key = recipientKey(recipient);
  return key !== undefined && allowlist.has(key);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function messageId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value);
  return typeof object?._serialized === "string" ? object._serialized
    : typeof object?.id === "string" ? object.id : undefined;
}

export function wahaMessageRecipient(value: unknown): string | undefined {
  const id = messageId(value);
  const match = id?.match(/^(?:true|false)_([^_\s]+)_[A-Za-z0-9-]+(?:_[^\s]+)?$/u);
  return match ? recipientKey(match[1]) : undefined;
}

function pollVoteAllowed(allowlist: ReadonlySet<string>, payload: Record<string, unknown>): boolean {
  const vote = record(payload.vote), poll = record(payload.poll);
  if (!vote || !poll) return false;
  const sender = recipientKey(vote.from);
  if (!sender || sender.endsWith("@g.us")) return false;
  const chats: string[] = [];
  for (const value of [vote.id, poll.id]) {
    if (value === undefined) continue;
    const chat = wahaMessageRecipient(value);
    if (!chat) return false;
    chats.push(chat);
  }
  for (const value of [vote.to, poll.to]) {
    if (value === undefined || value === "me") continue;
    const chat = recipientKey(value);
    if (!chat) return false;
    chats.push(chat);
  }
  // A group voter is a participant, not the chat destination. A direct voter
  // is the peer and must agree with the poll/vote message identities.
  if (!chats.some(chat => chat.endsWith("@g.us"))) {
    chats.push(sender);
  }
  return chats.length > 0 && new Set(chats).size === 1 && allowlist.has(chats[0]);
}

function contextualGowsReply(body: Record<string, unknown>, action: Record<string, unknown> | undefined, chat: string): boolean {
  const reply = record(action?.replyTo), source = record(action?._data);
  const message = record(source?.Message), id = reply?.id;
  // GOWS bare quote IDs belong to the signed containing message's chat/context.
  return body.engine === "GOWS" && (body.event === "message" || body.event === "message.any")
    && typeof id === "string" && /^[A-Za-z0-9]{1,1024}$/u.test(id)
    && reply?._serialized === undefined
    && wahaMessageRecipient(action?.id) === chat
    && recipientKey(record(source?.Info)?.Chat) === chat
    && message !== undefined && Object.values(message).some(content => {
      const context = record(record(content)?.contextInfo);
      return context?.stanzaID === id && record(context.quotedMessage) !== undefined;
    });
}

/** Called only after provider signature, timestamp and session ownership validation. */
export function wahaTestWebhookAllowed(allowlist: WahaTestRecipientAllowlist, body: Record<string, unknown>): boolean {
  if (allowlist === undefined) return true;
  if (allowlist.size === 0) return false;
  // Lifecycle observations carry no chat. The normal ownership gates still apply.
  if (body.event === "session.status") return true;
  const payload = record(body.payload);
  if (!payload) return false;
  if (body.event === "poll.vote") return pollVoteAllowed(allowlist, payload);
  const action = body.event === "message.revoked" ? record(payload.after) : payload;
  const reaction = record(action?.reaction);
  const primary = [recipientKey(action?.chatId),
    recipientKey(action?.fromMe === true && action?.to !== "me" ? action.to : action?.from),
    wahaMessageRecipient(action?.id)]
    .filter((key): key is string => key !== undefined);
  if (new Set(primary).size !== 1) return false;
  const recipients: string[] = [];
  for (const value of [action?.chatId, action?.from, action?.to]) {
    if (value === undefined || value === null || value === "me") continue;
    const key = recipientKey(value);
    if (!key) return false;
    recipients.push(key);
  }
  for (const value of [action?.id]) {
    const key = wahaMessageRecipient(value);
    if (key) recipients.push(key);
  }
  for (const value of [payload.editedMessageId, payload.revokedMessageId, reaction?.messageId]) {
    if (value === undefined || value === null) continue;
    const key = wahaMessageRecipient(value);
    if (!key || !primary.includes(key)) return false;
    recipients.push(key);
  }
  const quote = action?.replyTo;
  if (quote !== undefined && quote !== null) {
    const key = wahaMessageRecipient(quote);
    if (key) {
      if (!primary.includes(key)) return false;
      recipients.push(key);
    } else if (!contextualGowsReply(body, action, primary[0])) return false;
  }
  return recipients.length > 0 && recipients.every(key => allowlist.has(key));
}
