import { setTimeout as delay } from "node:timers/promises";

export async function startupRequest(request: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(url, init);
    } catch (error) {
      // New pods can reach DNS before their network policy has converged.
      // Retry refused reads only; never replay writes or relax TLS checks.
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      if ((init.method ?? "GET") !== "GET" || code !== "ECONNREFUSED" || attempt >= 3) throw error;
      await delay(1_000 * 2 ** attempt, undefined, { signal: init.signal ?? undefined });
    }
  }
}
