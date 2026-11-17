export async function readBoundedJson<T>(response: Response, maximumBytes = 262_144, timeoutMs = 15_000): Promise<T> {
  try {
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (contentType !== "application/json") throw new Error("Expected a JSON response");
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const size = Number(declared);
      if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error("JSON response is too large");
    }
    const bytes = await readBoundedBody(response, maximumBytes, timeoutMs);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch (error) {
    // Rejecting headers must also release the upstream connection. Cancellation
    // is best effort: a broken stream must not outlive the admission deadline.
    if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
    throw error;
  }
}

export class BoundedBodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Shared browser-stream admission, extracted from the existing media upload.
 * The deadline includes the complete body and every failure cancels the reader. */
export async function readBoundedBody(source: Pick<Request, "body">, maximumBytes: number, timeoutMs: number, expectedBytes?: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maximumBytes)))
    throw new BoundedBodyError(400, "The request size is invalid");
  const reader = source.body?.getReader();
  if (!reader) throw new BoundedBodyError(400, "The request body was incomplete");
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BoundedBodyError(408, "The request body timed out");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new BoundedBodyError(408, "The request body timed out")), remaining);
      })]).finally(() => { if (timeout) clearTimeout(timeout); });
      if (result.done) break;
      total += result.value.byteLength;
      if (total > (expectedBytes ?? maximumBytes)) throw new BoundedBodyError(413, "The request body is too large");
      chunks.push(result.value);
    }
    if (expectedBytes !== undefined && total !== expectedBytes) throw new BoundedBodyError(400, "The request body was incomplete");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
