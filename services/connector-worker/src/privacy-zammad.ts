export type ZammadPrivacyTask = { id: string; state: string };
export type PrivacyNativeContext = { jobId: string; leaseId: string; fencingToken: number };
type PrivacyNativeTarget = { id: string; attempts: number };

export class PrivacyZammadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PrivacyZammadError";
  }
}

export class PrivacyZammadClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly token: string, private readonly timeoutMs = 30_000, private readonly context?: PrivacyNativeContext) {
    try {
      this.baseUrl = new URL(baseUrl);
    } catch {
      throw new PrivacyZammadError("Zammad privacy endpoint is invalid", "ZAMMAD_ENDPOINT_INVALID", false);
    }
    if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password) {
      throw new PrivacyZammadError("Zammad privacy endpoint is invalid", "ZAMMAD_ENDPOINT_INVALID", false);
    }
    if (!token || token.length > 4_096) {
      throw new PrivacyZammadError("Zammad privacy credential is invalid", "ZAMMAD_PRIVACY_CREDENTIAL_INVALID", false);
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new PrivacyZammadError("Zammad privacy timeout is invalid", "ZAMMAD_TIMEOUT_INVALID", false);
    }
  }

  async deleteTicket(ticketId: string, target: PrivacyNativeTarget) {
    requireNumericId(ticketId, "ticket");
    await this.operation("DELETE_TICKET", ticketId, target);
  }

  async getTicket(ticketId: string) {
    requireNumericId(ticketId, "ticket");
    return this.operation<Record<string, unknown>>("READ_TICKET", ticketId);
  }

  async getTicketArticles(ticketId: string) {
    requireNumericId(ticketId, "ticket");
    return (await this.operation<Array<Record<string, unknown>>>("READ_ARTICLES", ticketId, undefined, { maximumBytes: 20_000_000 })) ?? [];
  }

  async createUserDataPrivacyTask(userId: string, target: PrivacyNativeTarget): Promise<ZammadPrivacyTask> {
    requireNumericId(userId, "user");
    const result = await this.operation<Record<string, unknown>>("CREATE_USER_TASK", userId, target);
    return privacyTask(result);
  }

  async getDataPrivacyTask(taskId: string, target: PrivacyNativeTarget): Promise<ZammadPrivacyTask> {
    requireNumericId(taskId, "data-privacy task");
    return privacyTask(await this.operation<Record<string, unknown>>("READ_USER_TASK", taskId, target));
  }

  private operation<T>(operation: string, nativeId: string, target?: PrivacyNativeTarget, options: { allowNotFound?: boolean; maximumBytes?: number } = {}) {
    if (!this.context) throw new PrivacyZammadError("Privacy job admission is required", "ZAMMAD_PRIVACY_ADMISSION_REQUIRED", false);
    return this.request<T>("/api/v1/wasalx/privacy", { method: "POST", body: JSON.stringify({
      job_id: this.context.jobId, lease_id: this.context.leaseId, fencing_token: this.context.fencingToken,
      ...(target ? { target_id: target.id } : {}), attempt: target?.attempts ?? 0, operation, native_id: nativeId,
    }) }, options);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { allowNotFound?: boolean; maximumBytes?: number } = {},
  ): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Token token=${this.token}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (options.allowNotFound && response.status === 404) return null;
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new PrivacyZammadError(
          response.status === 401 || response.status === 403
            ? "Zammad privacy permission is unavailable"
            : "Zammad privacy request failed",
          response.status === 401 || response.status === 403 ? "ZAMMAD_PRIVACY_PERMISSION_DENIED" : "ZAMMAD_PRIVACY_HTTP",
          retryable,
          response.status,
        );
      }
      if (response.status === 204 || init.method === "DELETE") return null;
      const bytes = await boundedResponse(response, options.maximumBytes ?? 10_000_000);
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } catch {
        throw new PrivacyZammadError("Zammad privacy response was invalid", "ZAMMAD_PRIVACY_RESPONSE_INVALID", false);
      }
    } catch (error) {
      if (error instanceof PrivacyZammadError) throw error;
      throw new PrivacyZammadError(
        "Zammad privacy request timed out or the network was unavailable",
        "ZAMMAD_PRIVACY_NETWORK",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function privacyTask(value: Record<string, unknown> | null): ZammadPrivacyTask {
  if (!value || (!Number.isSafeInteger(value.id) && typeof value.id !== "string") || typeof value.state !== "string") {
    throw new PrivacyZammadError("Zammad privacy task response was invalid", "ZAMMAD_PRIVACY_RESPONSE_INVALID", false);
  }
  const id = String(value.id);
  requireNumericId(id, "data-privacy task");
  return { id, state: value.state.trim().toLowerCase() };
}

function requireNumericId(value: string, label: string) {
  if (!/^[1-9]\d{0,18}$/u.test(value)) {
    throw new PrivacyZammadError(`Zammad ${label} ID is invalid`, "ZAMMAD_ID_INVALID", false);
  }
}

async function boundedResponse(response: Response, maximumBytes: number) {
  const lengthValue = response.headers.get("content-length");
  if (lengthValue && Number(lengthValue) > maximumBytes) {
    throw new PrivacyZammadError("Zammad privacy response is too large", "ZAMMAD_PRIVACY_RESPONSE_TOO_LARGE", false);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PrivacyZammadError("Zammad privacy response is too large", "ZAMMAD_PRIVACY_RESPONSE_TOO_LARGE", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
