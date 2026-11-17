export const BOT_CONVERSATION_PAGE_SIZE = 50;

export type BotConversationRow = Record<string, unknown>;

export type BotConversationPage = {
  items: BotConversationRow[];
  next_cursor: string | null;
};

export type BotConversationPageQuery = {
  cursor?: string;
  limit?: number;
};

export type BotConversationEventRow = {
  id: string;
  kind: string;
  from: string | null;
  to: string | null;
  at: string;
};

export type BotConversationEventPage = {
  items: BotConversationEventRow[];
  next_cursor: string | null;
  overlay_events: Array<Omit<BotConversationEventRow, "id">>;
};

export type BotConversationEventPageQuery = BotConversationPageQuery & {
  conversationId: string;
};

export class BotConversationPageError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Bot conversation page request failed");
    this.name = "BotConversationPageError";
    this.status = status;
  }
}

export class BotConversationEventPageError extends BotConversationPageError {
  constructor(status: number) {
    super(status);
    this.name = "BotConversationEventPageError";
  }
}

export async function fetchBotConversationPage(
  input: BotConversationPageQuery & { signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<BotConversationPage> {
  const limit = input.limit ?? BOT_CONVERSATION_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new BotConversationPageError(400);
  const query = new URLSearchParams({ limit: String(limit) });
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  try {
    const response = await fetcher(`/api/bot-flows/conversations?${query}`, {
      cache: "no-store",
      signal: input.signal,
    });
    if (!response.ok) throw new BotConversationPageError(response.status);
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BotConversationPageError(502);
    const page = value as Partial<BotConversationPage>;
    if (
      !Array.isArray(page.items) ||
      (page.next_cursor !== null && typeof page.next_cursor !== "string")
    ) throw new BotConversationPageError(502);
    return { items: page.items, next_cursor: page.next_cursor };
  } catch (error) {
    if (isAbortError(error) || error instanceof BotConversationPageError) throw error;
    throw new BotConversationPageError(502);
  }
}

export async function fetchBotConversationEventPage(
  input: BotConversationEventPageQuery & { signal?: AbortSignal },
  fetcher: typeof fetch = fetch,
): Promise<BotConversationEventPage> {
  const limit = input.limit ?? BOT_CONVERSATION_PAGE_SIZE;
  if (!input.conversationId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new BotConversationEventPageError(400);
  const query = new URLSearchParams({ limit: String(limit) });
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  try {
    const response = await fetcher(
      `/api/bot-flows/conversations/${encodeURIComponent(input.conversationId)}/events?${query}`,
      { cache: "no-store", signal: input.signal },
    );
    if (!response.ok) throw new BotConversationEventPageError(response.status);
    const value = await response.json() as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BotConversationEventPageError(502);
    const page = value as Partial<BotConversationEventPage>;
    if (
      !Array.isArray(page.items) ||
      !Array.isArray(page.overlay_events) ||
      (page.next_cursor !== null && typeof page.next_cursor !== "string")
    ) throw new BotConversationEventPageError(502);
    return {
      items: page.items,
      next_cursor: page.next_cursor,
      overlay_events: page.overlay_events,
    };
  } catch (error) {
    if (isAbortError(error) || error instanceof BotConversationEventPageError) throw error;
    throw new BotConversationEventPageError(502);
  }
}

export function mergeBotConversationRows(
  current: BotConversationRow[],
  incoming: BotConversationRow[],
) {
  const byId = new Map(current.map((row) => [String(row.id), row]));
  for (const row of incoming) byId.set(String(row.id), row);
  return [...byId.values()].sort(compareBotConversations);
}

export function refreshBotConversationPage(
  current: BotConversationPage,
  head: BotConversationPage,
  retainCursor: boolean,
): BotConversationPage {
  return {
    items: mergeBotConversationRows(current.items, head.items),
    next_cursor: retainCursor ? current.next_cursor : head.next_cursor,
  };
}

export function appendBotConversationPage(
  current: BotConversationPage,
  next: BotConversationPage,
): BotConversationPage {
  return {
    items: mergeBotConversationRows(current.items, next.items),
    next_cursor: next.next_cursor,
  };
}

export function refreshBotConversationEventPage(
  current: BotConversationEventPage,
  head: BotConversationEventPage,
  retainCursor: boolean,
): BotConversationEventPage {
  return {
    items: mergeBotConversationEvents(current.items, head.items),
    next_cursor: retainCursor ? current.next_cursor : head.next_cursor,
    overlay_events: head.overlay_events,
  };
}

export function appendBotConversationEventPage(
  current: BotConversationEventPage,
  next: BotConversationEventPage,
): BotConversationEventPage {
  return {
    items: mergeBotConversationEvents(current.items, next.items),
    next_cursor: next.next_cursor,
    overlay_events: next.overlay_events,
  };
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function compareBotConversations(left: BotConversationRow, right: BotConversationRow) {
  const leftActivity = String(left.last_activity_at ?? "");
  const rightActivity = String(right.last_activity_at ?? "");
  if (leftActivity !== rightActivity) return leftActivity < rightActivity ? 1 : -1;
  const leftId = String(left.id ?? "");
  const rightId = String(right.id ?? "");
  return leftId === rightId ? 0 : leftId < rightId ? 1 : -1;
}

function mergeBotConversationEvents(
  current: BotConversationEventRow[],
  incoming: BotConversationEventRow[],
) {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) => {
    if (left.at !== right.at) return left.at < right.at ? 1 : -1;
    return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
  });
}

export function botConversationTicketNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const number = value.trim().replace(/^#/u, "");
  return /^[1-9][0-9]{0,15}$/u.test(number) ? number : null;
}

export function botSupportTeamName(
  id: string,
  teams: ReadonlyArray<{ id: string; name: string }>,
  unavailable: string,
) {
  return teams.find(team => team.id === id)?.name || unavailable;
}
