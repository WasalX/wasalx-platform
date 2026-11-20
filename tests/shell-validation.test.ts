import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { accessCheckSignal, fetchAccessCheck, gateMutations, installShellFetch, isMutatingRequest, SHELL_COVER_AFTER_MS, shouldCoverOnReturn, StaleWorkspaceError, trackAccessCheck } from "../lib/shell-validation.ts";

test("short absences re-verify silently; five minutes away shows the cover", () => {
  const now = 1_000_000_000;
  assert.equal(shouldCoverOnReturn(null, now), false);
  assert.equal(shouldCoverOnReturn(now - 30_000, now), false);
  assert.equal(shouldCoverOnReturn(now - SHELL_COVER_AFTER_MS + 1, now), false);
  assert.equal(shouldCoverOnReturn(now - SHELL_COVER_AFTER_MS, now), true);
  assert.equal(SHELL_COVER_AFTER_MS, 5 * 60_000);
});

test("only mutating requests are gated", () => {
  assert.equal(isMutatingRequest("/api/team"), false);
  assert.equal(isMutatingRequest("/api/team", { method: "head" }), false);
  assert.equal(isMutatingRequest("/api/team", { method: "POST" }), true);
  assert.equal(isMutatingRequest("/api/team/members/x", { method: "delete" }), true);
  assert.equal(isMutatingRequest(new Request("http://local/api/rules", { method: "PATCH" })), true);
});

test("mutations wait for an in-flight access check and are refused unless still verified", async () => {
  const calls: string[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0]) => { calls.push(String(input)); return new Response("{}"); }) as typeof fetch;
  let pending: Promise<boolean> | null = null;
  let verified = true;
  const gated = gateMutations(fake, () => pending, () => verified);

  let finish!: (value: boolean) => void;
  pending = new Promise<boolean>((resolve) => { finish = resolve; }).finally(() => { pending = null; });
  const write = gated("/api/rules", { method: "POST" });
  await gated("/api/dashboard");
  assert.deepEqual(calls, ["/api/dashboard"], "reads are not delayed and the write waits");
  finish(true);
  await write;
  assert.deepEqual(calls, ["/api/dashboard", "/api/rules"]);

  pending = new Promise<boolean>((resolve) => { finish = resolve; }).finally(() => { pending = null; });
  const stale = gated("/api/rules", { method: "POST" });
  verified = false;
  finish(false);
  await assert.rejects(stale, StaleWorkspaceError);
  assert.equal(calls.length, 2, "a write is never sent after the check reports a changed or failed workspace");
});

test("initial settings POST reads wait for verified access before dispatch", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: false };
  let finish!: (accepted: boolean) => void;
  const check = trackAccessCheck(new Promise<boolean>(resolve => { finish = resolve; }), pending, verified);
  const calls: string[] = [];
  const gated = gateMutations((async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)).operation); return new Response("{}");
  }) as typeof fetch, () => pending.current, () => verified.current);
  const reads = ["MAILBOX_LIST", "TEAM_LIST"].map(operation => gated("/api/inbox", { method: "POST", body: JSON.stringify({ operation, input: {} }) }));
  await Promise.resolve();
  assert.deepEqual(calls, []);
  assert.equal(pending.current, check);
  finish(true);
  await Promise.all(reads);
  assert.deepEqual(calls, ["MAILBOX_LIST", "TEAM_LIST"]);
  assert.equal(verified.current, true);
  assert.equal(pending.current, null);
});

test("failed or rejected access checks never dispatch waiting settings reads", async () => {
  for (const reject of [false, true]) {
    const pending = { current: null as Promise<boolean> | null }, verified = { current: true };
    let finish!: () => void;
    trackAccessCheck(new Promise<boolean>((resolve, fail) => { finish = () => reject ? fail(new Error("unavailable")) : resolve(false); }), pending, verified);
    let calls = 0;
    const gated = gateMutations((async () => { calls++; return new Response("{}"); }) as typeof fetch, () => pending.current, () => verified.current);
    const refused = assert.rejects(gated("/api/inbox", { method: "POST" }), StaleWorkspaceError);
    finish();
    await refused;
    assert.equal(calls, 0);
    assert.equal(verified.current, false);
    assert.equal(pending.current, null);
  }
});

test("an aborted check leaves verified unchanged", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: true };
  const controller = new AbortController();
  let finish!: (accepted: boolean) => void;
  const check = trackAccessCheck(new Promise<boolean>(resolve => { finish = resolve; }), pending, verified, controller.signal);
  controller.abort();
  finish(false); await check;
  assert.equal(verified.current, true);
  assert.equal(pending.current, null);
  let calls = 0;
  const gated = gateMutations((async () => { calls++; return new Response("{}"); }) as typeof fetch, () => pending.current, () => verified.current);
  await gated("/api/inbox", { method: "POST" });
  assert.equal(calls, 1);
});

test("an aborted check never authorizes an unverified shell", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: false };
  const controller = new AbortController();
  const check = trackAccessCheck(Promise.resolve(true), pending, verified, controller.signal);
  controller.abort(); await check;
  assert.equal(verified.current, false);
});

test("a non-aborted false verdict still revokes", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: true };
  await trackAccessCheck(Promise.resolve(false), pending, verified, new AbortController().signal);
  assert.equal(verified.current, false);
  const gated = gateMutations((async () => new Response("{}")) as typeof fetch, () => pending.current, () => verified.current);
  await assert.rejects(gated("/api/inbox", { method: "POST" }), StaleWorkspaceError);
});

test("a superseded check cannot authorize or clear the current access check", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: false };
  let finishOld!: (accepted: boolean) => void, finishCurrent!: (accepted: boolean) => void;
  const old = trackAccessCheck(new Promise<boolean>(resolve => { finishOld = resolve; }), pending, verified);
  const current = trackAccessCheck(new Promise<boolean>(resolve => { finishCurrent = resolve; }), pending, verified);
  finishOld(true); await old;
  assert.equal(pending.current, current);
  assert.equal(verified.current, false);
  finishCurrent(false); await current;
  assert.equal(pending.current, null);
  assert.equal(verified.current, false);
});

test("masking the shell revokes a pending check before it settles", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: true };
  let finish!: (accepted: boolean) => void;
  const check = trackAccessCheck(new Promise<boolean>(resolve => { finish = resolve; }), pending, verified);
  pending.current = null; verified.current = false;
  finish(true); await check;
  assert.equal(verified.current, false);
  let calls = 0;
  const gated = gateMutations((async () => { calls++; return new Response("{}"); }) as typeof fetch, () => pending.current, () => verified.current);
  await assert.rejects(gated("/api/inbox", { method: "POST" }), StaleWorkspaceError);
  assert.equal(calls, 0);
});

test("an immediately successful check publishes verification before waiting requests resume", async () => {
  const pending = { current: null as Promise<boolean> | null }, verified = { current: false };
  trackAccessCheck(Promise.resolve(true), pending, verified);
  let calls = 0;
  const gated = gateMutations((async () => { calls++; assert.equal(verified.current, true); return new Response("{}"); }) as typeof fetch, () => pending.current, () => verified.current);
  await gated("/api/inbox", { method: "POST" });
  assert.equal(calls, 1);
});

const hungFetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal;
  assert.ok(signal, "the hung request fixture requires an abort signal");
  if (signal.aborted) { reject(signal.reason); return; }
  // A pending request owns a live resource; AbortSignal.timeout alone is unref'd in Node.
  const pendingRequest = setInterval(() => {}, 1000);
  signal.addEventListener("abort", () => {
    clearInterval(pendingRequest);
    reject(signal.reason);
  }, { once: true });
})) as typeof fetch;

test("a hung access check times out as a failure that revokes access and releases waiting writes", async () => {
  const caller = new AbortController();
  const pending = { current: null as Promise<boolean> | null }, verified = { current: true };
  let failure: unknown;
  // Mirrors loadWorkspaces: only AbortError is "no verdict"; anything else is a failed check.
  const check = hungFetch("/api/workspaces", { signal: accessCheckSignal(caller.signal, 20) }).then(() => true, error => { failure = error; return false; });
  trackAccessCheck(check, pending, verified, caller.signal);
  let calls = 0;
  const gated = gateMutations((async () => { calls++; return new Response("{}"); }) as typeof fetch, () => pending.current, () => verified.current);
  await assert.rejects(gated("/api/inbox", { method: "POST" }), StaleWorkspaceError);
  assert.equal((failure as DOMException).name, "TimeoutError", "a timeout is not mistaken for a caller abort");
  assert.equal(caller.signal.aborted, false);
  assert.equal(verified.current, false);
  assert.equal(pending.current, null);
  assert.equal(calls, 0);
});

test("a caller abort under the check deadline stays an abort, not a verdict", async () => {
  const caller = new AbortController();
  const pending = { current: null as Promise<boolean> | null }, verified = { current: true };
  let failure: unknown;
  const check = hungFetch("/api/workspaces", { signal: accessCheckSignal(caller.signal, 60_000) }).then(() => true, error => { failure = error; return false; });
  const tracked = trackAccessCheck(check, pending, verified, caller.signal);
  caller.abort();
  await tracked;
  assert.equal((failure as DOMException).name, "AbortError");
  assert.equal(verified.current, true);
  assert.equal(pending.current, null);
});

test("a transient workspace-check failure retries once; 401 and a second failure do not", async () => {
  const run = async (...results: Array<number | Error>) => {
    let calls = 0;
    const response = await fetchAccessCheck(async () => {
      const next = results[calls++];
      if (next instanceof Error) throw next;
      return new Response("{}", { status: next });
    }, undefined, 0).then(value => value.status, (error: Error) => error.name);
    return { response, calls };
  };
  assert.deepEqual(await run(503, 200), { response: 200, calls: 2 }, "transient then success becomes ready");
  assert.deepEqual(await run(new TypeError("network"), 200), { response: 200, calls: 2 });
  assert.deepEqual(await run(new DOMException("deadline", "TimeoutError"), 200), { response: 200, calls: 2 });
  assert.deepEqual(await run(401, 200), { response: 401, calls: 1 }, "401 never retries");
  assert.deepEqual(await run(403, 200), { response: 403, calls: 1 });
  assert.deepEqual(await run(404, 200), { response: 404, calls: 1 }, "a non-5xx response is a verdict, not a transient");
  assert.deepEqual(await run(503, 502), { response: 502, calls: 2 }, "two transients become failed");
  assert.deepEqual(await run(new TypeError("network"), new TypeError("network")), { response: "TypeError", calls: 2 });

  const caller = new AbortController();
  let calls = 0;
  const aborted = fetchAccessCheck(async signal => { calls++; caller.abort(); throw signal.reason; }, caller.signal, 0);
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal(calls, 1, "a caller abort is never retried");

  const backoff = new AbortController();
  let backoffCalls = 0;
  const duringBackoff = fetchAccessCheck(async () => { backoffCalls++; return new Response("{}", { status: 503 }); }, backoff.signal, 50);
  setTimeout(() => backoff.abort(), 10);
  await assert.rejects(duringBackoff, { name: "AbortError" });
  assert.equal(backoffCalls, 1, "an abort during the backoff ends the check without a retry");
});

test("each workspace-check attempt gets its own deadline", async () => {
  const signals: AbortSignal[] = [];
  const response = await fetchAccessCheck(signal => {
    signals.push(signal);
    // The first attempt hangs until its deadline; the second must start with a fresh one.
    if (signals.length === 1) return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    assert.equal(signal.aborted, false);
    return Promise.resolve(new Response("{}"));
  }, undefined, 0, 20);
  assert.equal(response.status, 200);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].reason.name, "TimeoutError");
  assert.notEqual(signals[0], signals[1]);
});

test("tenant shell wires silent re-verification, the gate and the reload on a changed workspace", async () => {
  const source = await readFile(new URL("../app/WasalXApp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /addEventListener\("blur",maskShell\)/u, "leaving the window no longer covers the page");
  assert.match(source, /window\.addEventListener\("blur",leave\)/u);
  assert.match(source, /shouldCoverOnReturn\(awayStartedAt,Date\.now\(\)\)/u);
  assert.match(source, /gate: runtime === "CONTROL_PLANE" \? \{ pending: \(\) => accessCheck\.current, verified: \(\) => shellVerified\.current \}/u);
  assert.doesNotMatch(source, /window\.fetch\s*=/u, "the shell installs fetch wrappers only through installShellFetch");
  assert.match(source, /message === "workspace_changed"[\s\S]{0,400}window\.location\.reload\(\)/u);
  assert.match(source, /window\.addEventListener\("pagehide",maskShell\)/u);
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*const controller = new AbortController\(\);[\s\S]{0,250}void trackAccessCheck\(load,accessCheck,shellVerified,controller\.signal\);/u, "the initial check is published before child mount effects send requests");
  assert.match(source, /trackAccessCheck\(loadWorkspaces\(signal\),accessCheck,shellVerified,signal\)/u);
  assert.equal((source.match(/loadWorkspaces\(/gu) ?? []).length, 2, "the initial, focus, retry and background checks all use a tracked path");
  assert.match(source, /accessCheck\.current=null;shellVerified\.current=false/u);
  assert.match(source, /fetchAccessCheck\(attempt => fetch\("\/api\/workspaces", \{ cache: "no-store", signal: attempt \}\), signal\)/u, "the workspace check has a deadline per attempt and one transient retry");
  assert.match(source, /error\.name === "AbortError"\) \{[\s\S]{0,200}if\(workspaceLoadFence\.current\.isCurrent\(request\)\)\{[^}]*setShellValidationState\(current=>current==="checking"\?"failed":current\)\}\s*return false;/u, "an aborted check that still owns the cover leaves Retry instead of a dead end");
  assert.match(source, /if\(isCurrent\(\)\)\{setWorkspaceLoadState\("failed"\);setShellValidationState\("failed"\)\}/u, "a timeout falls through to the failed verdict with Retry");
  assert.match(source, /useEffect\(\(\)=>\{if\(shellValidationState==="failed"\)shellRetryRef\.current\?\.focus\(\{preventScroll:true\}\)\},\[shellValidationState\]\);/u, "the failed cover moves keyboard focus to Retry only when it appears");
  assert.match(source, /role=\{shellValidationState==="failed"\?"alert":"status"\}[\s\S]{0,400}<button ref=\{shellRetryRef\} type="button" className="button primary" onClick=\{\(\)=>void verifyWorkspaces\(\)\}>/u, "the focused Retry belongs to the announced failed cover");
});

test("re-installing the shell fetch on a workspace or role change sends only the new identity and teardown restores fetch", async () => {
  const sent: Array<string | null> = [];
  const native = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push(`${headers.get("x-wasalx-shell-tenant-id")}/${headers.get("x-wasalx-shell-role")}`);
    return new Response("{}", { status: sent.length === 3 ? 401 : 200 });
  }) as typeof fetch;
  const target = { fetch: native, location: { origin: "https://portal.test" } };
  let expired = 0;
  let verified = true;
  const gate = { pending: () => null, verified: () => verified };
  const install = (tenantId: string, role: string) => installShellFetch(target, { tenantId, role, onUnauthorized: () => { expired += 1; }, gate });

  // Same commit order React uses for a changed dependency: cleanup, then setup.
  let restore = install("tenant-a", "owner");
  await target.fetch("/api/dashboard");
  restore();
  restore = install("tenant-b", "agent");
  await target.fetch("/api/dashboard", { headers: { "x-wasalx-shell-tenant-id": "forged" } });
  await target.fetch("/api/dashboard");
  await target.fetch("https://other.test/api/dashboard");
  assert.deepEqual(sent, ["tenant-a/owner", "tenant-b/agent", "tenant-b/agent", "null/null"]);
  assert.equal(expired, 1, "only a same-origin shell 401 expires the session");

  verified = false;
  await assert.rejects(target.fetch("/api/rules", { method: "POST" }), StaleWorkspaceError);
  assert.equal(sent.length, 4);

  restore();
  assert.equal(target.fetch, native, "teardown restores exactly the fetch it replaced");
});
