/**
 * Tenant shell re-validation policy.
 *
 * Returning to the window re-checks workspace access silently. The full
 * "verifying access" cover is only shown after a long absence or when the
 * check fails or reports a different workspace. While a silent check is in
 * flight, mutating requests wait for it, so nothing is submitted against a
 * tenant that is no longer current.
 */
export const SHELL_COVER_AFTER_MS = 5 * 60_000;

/** A hung workspace check must end in a failure verdict, not block every mutation indefinitely. */
export const ACCESS_CHECK_TIMEOUT_MS = 15_000;

/** The caller's signal (abort = no verdict) combined with the check deadline (TimeoutError = failure). */
export function accessCheckSignal(signal?: AbortSignal, timeoutMs = ACCESS_CHECK_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function shouldCoverOnReturn(awayStartedAt: number | null, now: number) {
  return awayStartedAt !== null && now - awayStartedAt >= SHELL_COVER_AFTER_MS;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export function isMutatingRequest(input: FetchInput, init?: FetchInit) {
  const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export class StaleWorkspaceError extends Error {
  constructor() {
    super("Workspace access is being re-verified. Try again in a moment.");
    this.name = "StaleWorkspaceError";
  }
}

/**
 * Publishes an access check as the gate's pending check and, unless it is
 * superseded or aborted, its result as the verified state before waiting
 * mutations resume.
 */
export function trackAccessCheck(
  check: Promise<boolean>,
  pending: { current: Promise<boolean> | null },
  verified: { current: boolean },
  signal?: AbortSignal,
): Promise<boolean> {
  let accepted = false;
  const tracked: Promise<boolean> = check.then(result => (accepted = result === true)).finally(() => {
    if (pending.current === tracked) {
      // An abort (tab hidden, refresh disabled, unmount) is not an access verdict.
      if (!signal?.aborted) verified.current = accepted;
      pending.current = null;
    }
  });
  pending.current = tracked;
  return tracked;
}

/**
 * Wraps fetch so mutating requests wait for any in-flight access check and
 * are refused unless the shell is verified afterwards. Reads pass through.
 */
export function gateMutations(
  fetchImpl: typeof fetch,
  pending: () => Promise<unknown> | null,
  verified: () => boolean,
): typeof fetch {
  return async (input, init) => {
    if (isMutatingRequest(input, init)) {
      for (let check = pending(); check; check = pending()) {
        await check.catch(() => undefined);
        if (pending() === check) break;
      }
      if (!verified()) throw new StaleWorkspaceError();
    }
    return fetchImpl(input, init);
  };
}

/**
 * Installs the shell's only fetch wrapper: optional mutation gate, then
 * tenant/role headers on same-origin shell requests, then the captured fetch.
 * Composing both in one install keeps a re-install from leaving stale headers
 * in the chain; the returned cleanup restores exactly what it replaced.
 */
export function installShellFetch(
  target: { fetch: typeof fetch; location: { origin: string } },
  shell: { tenantId: string; role: string; onUnauthorized: () => void; gate?: { pending: () => Promise<unknown> | null; verified: () => boolean } },
) {
  const originalFetch = target.fetch;
  const baseFetch = originalFetch.bind(target);
  const boundFetch: typeof fetch = async (input, init) => {
    const requestUrl = new URL(typeof Request !== "undefined" && input instanceof Request ? input.url : String(input), target.location.origin);
    const shellRequest = requestUrl.origin === target.location.origin && (requestUrl.pathname.startsWith("/api/") || requestUrl.pathname === "/auth/logout");
    let nextInit = init;
    if (shellRequest) {
      const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      headers.set("x-wasalx-shell-tenant-id", shell.tenantId);
      headers.set("x-wasalx-shell-role", shell.role);
      nextInit = { ...init, headers };
    }
    const response = await baseFetch(input, nextInit);
    if (response.status === 401 && shellRequest) shell.onUnauthorized();
    return response;
  };
  const installed = shell.gate ? gateMutations(boundFetch, shell.gate.pending, shell.gate.verified) : boundFetch;
  target.fetch = installed;
  return () => { if (target.fetch === installed) target.fetch = originalFetch; };
}
