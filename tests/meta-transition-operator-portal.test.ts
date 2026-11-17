import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { platformOperatorRecoveryScope } from "../lib/platform-operator-recovery-scope.ts";
import { allowedPlatformProxyRoute } from "../lib/platform-proxy-routes.ts";

// Authored unit proof: real platform auth, BFF parser and body reader; only the
// session store and upstream transport are substituted. No installed-session claim.
const globals = globalThis as typeof globalThis & { reviewTestSubject?: string };
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "./platform-portal-session-store.ts" && context.parentURL?.includes("/lib/platform-request-auth.ts")) return { url: 'data:text/javascript,export async function loadStoredPlatformSession(){return {subject:globalThis.reviewTestSubject,csrfToken:"synthetic-csrf",accessToken:"synthetic-access"}}', shortCircuit: true };
  if (context.parentURL && decodeURIComponent(context.parentURL).endsWith("/app/api/platform-console/[...path]/route.ts") && specifier.startsWith("../../../../lib/") && !specifier.endsWith(".ts")) return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  return nextResolve(specifier, context);
} });
const route = await import("../app/api/platform-console/[...path]/route.ts").finally(() => hook.deregister());
const id = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = `operations/tenants/${id(1)}/meta/account-transitions`, review = `${base}/${id(2)}/review`;
const body = { expectedRevision: 3, expectedReviewSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), confirmed: true, sourcePayment: "CARD" };
test("finite review proxy routes exclude provider execution and arbitrary query/action expansion", () => {
  assert.equal(allowedPlatformProxyRoute("GET", base), true); assert.equal(allowedPlatformProxyRoute("GET", review), true);
  for (const action of ["prerequisites", "target", "completion"]) for (const suffix of ["", "/resolve"]) assert.equal(allowedPlatformProxyRoute("POST", `${review}/${action}${suffix}`), true);
  for (const action of ["initiate", "complete", "observe", "reconcile", "delete"]) assert.equal(allowedPlatformProxyRoute("POST", `${review}/${action}`), false);
  assert.equal(allowedPlatformProxyRoute("PUT", `${review}/target`), false);
  assert.equal(allowedPlatformProxyRoute("GET", base.replace(id(1), "-".repeat(36))), false);
});
test("actual BFF binds current operator before dispatch and preserves original key/body/query", async () => {
  const environment = { PORTAL_DATA_BACKEND: "control-plane", PORTAL_COOKIE_SECURE: "false", PORTAL_PUBLIC_ORIGIN: "https://portal.example", CONTROL_API_URL: "https://control.example", PLATFORM_OPERATOR_OIDC_ISSUER: "https://identity.example/platform", PLATFORM_OPERATOR_OIDC_CLIENT_ID: "platform-client", PLATFORM_OPERATOR_OIDC_AUDIENCE: "platform-api", PLATFORM_OPERATOR_OIDC_REDIRECT_URI: "https://portal.example/platform/auth/callback" };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])), previousFetch = globalThis.fetch, previousSubject = globals.reviewTestSubject;
  Object.assign(process.env, environment); globals.reviewTestSubject = "operator-a";
  const scope = await platformOperatorRecoveryScope(environment.PLATFORM_OPERATOR_OIDC_ISSUER, "operator-a"), calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ pendingCommand: null }); };
  const headers = { cookie: "wasalx_platform_session=" + "s".repeat(43), origin: "https://portal.example", "content-type": "application/json", "x-wasalx-platform-csrf": "synthetic-csrf", "x-wasalx-platform-recovery-scope": scope, "idempotency-key": id(3) };
  const invoke = (path: string, method: "GET" | "POST", value?: string, changed: Record<string, string> = {}) => route[method](new Request(`https://portal.example/api/platform-console/${path}`, { method, headers: { ...headers, ...changed }, ...(method === "POST" ? { body: value } : {}) }), { params: Promise.resolve({ path: path.split("?")[0]!.split("/") }) });
  try {
    assert.equal((await invoke(`${review}/prerequisites`, "POST", JSON.stringify(body))).status, 200);
    assert.equal(calls.length, 1); assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), body); assert.equal(new Headers(calls[0]!.init?.headers).get("idempotency-key"), id(3));
    assert.equal(new Headers(calls[0]!.init?.headers).get("x-wasalx-platform-recovery-scope"), null, "local scope is not forwarded as backend authority");
    assert.equal((await invoke(`${review}?requestKey=${id(3)}`, "GET")).status, 200); assert.equal(calls.at(-1)!.url, `https://control.example/platform/v1/${review}?requestKey=${id(3)}`);
    for (const query of ["?requestKey=bad", `?requestKey=${id(3)}&requestKey=${id(3)}`, "?operator=other"]) { const n: number = calls.length; assert.equal((await invoke(review + query, "GET")).status, 400); assert.equal(calls.length, n); }
    for (const [changes, expected] of [[{ origin: "https://other.example" }, 403], [{ "x-wasalx-platform-csrf": "wrong" }, 403], [{ cookie: "" }, 401], [{ "x-wasalx-tenant-id": id(1) }, 401], [{ "x-wasalx-platform-recovery-scope": "" }, 403], [{ "idempotency-key": "bad" }, 400]] as const) {
      const n: number = calls.length; assert.equal((await invoke(`${review}/prerequisites`, "POST", JSON.stringify(body), changes as Record<string, string>)).status, expected); assert.equal(calls.length, n);
    }
    for (const [value, status] of [
      ["{", 400],
      [JSON.stringify({ ...body, accountId: id(9) }), 400],
      [JSON.stringify({ ...body, evidenceSha256: 1 }), 400],
      [JSON.stringify({ ...body, managed: { arrangementVersionId: id(8), targetReceivingBusinessId: "9", targetTermsDocumentText: "ع".repeat(33000), targetTermsVersion: "1" } }), 413],
    ] as const) {
      const n: number = calls.length; assert.equal((await invoke(`${review}/prerequisites`, "POST", value)).status, status); assert.equal(calls.length, n);
    }
    // A different login in the same browser changes the cookie's session while
    // the old page still carries operator A's scope. Nothing reaches the API.
    globals.reviewTestSubject = "operator-b";
    for (const path of [base, review + `?requestKey=${id(3)}`, `${review}/prerequisites/resolve`]) {
      const n: number = calls.length; assert.equal((await invoke(path, path.endsWith("resolve") ? "POST" : "GET", JSON.stringify(body))).status, 403); assert.equal(calls.length, n);
    }
    globals.reviewTestSubject = "operator-a";
    assert.equal((await invoke(`${review}/prerequisites/resolve`, "POST", JSON.stringify(body))).status, 200);
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.init?.body)), body); assert.equal(new Headers(calls.at(-1)!.init?.headers).get("idempotency-key"), id(3));
  } finally { globalThis.fetch = previousFetch; if (previousSubject === undefined) delete globals.reviewTestSubject; else globals.reviewTestSubject = previousSubject; for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
