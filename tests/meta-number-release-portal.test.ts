import assert from "node:assert/strict";
import test, { after } from "node:test";
import { registerHooks } from "node:module";

// Exercise the real route, authentication, CSRF and bounded reader; double only session storage and transport.
const fixture = globalThis as typeof globalThis & {
  releaseSession?: { userId: string; tenantId: string; role: string; csrfToken: string };
  releaseCalls?: unknown[][];
  releaseFailure?: { status: number; code: string };
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "./portal-session-store.ts" && context.parentURL?.endsWith("/lib/portal-session.ts")) {
    return { url: "data:text/javascript,export async function loadStoredPortalSession(){return globalThis.releaseSession}", shortCircuit: true };
  }
  if (context.parentURL && decodeURIComponent(context.parentURL).endsWith("/meta/number-release/route.ts")) {
    if (specifier === "next/server") return nextResolve("vinext/shims/server", context);
    if (specifier.endsWith("/control-plane-data")) return {
      url: 'data:text/javascript,async function invoke(...args){globalThis.releaseCalls.push(args);if(globalThis.releaseFailure)throw Object.assign(new Error("Review the release request"),globalThis.releaseFailure);return args.length===1?{routeId:"78000000-0000-4000-8000-000000000004",phoneNumberId:"1234567890",disconnectOperationId:"78000000-0000-4000-8000-000000000005",releaseId:null,state:"REVOKED",reconnectRequiresNewConnection:true}:{id:"78000000-0000-4000-8000-000000000006",released:true,duplicate:false,reconnectRequiresNewConnection:true};}export const getMetaNumberRelease=invoke;export const requestMetaNumberRelease=invoke;',
      shortCircuit: true,
    };
    if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
  }
  return nextResolve(specifier, context);
} });
const route = await import("../app/api/connections/[id]/meta/number-release/route.ts");
after(() => hooks.deregister());

test("actual number-release BFF preserves exact intent and fences session, roles, origin, CSRF and bounded input", async () => {
  const previousFixtureRole = process.env.PORTAL_FIXTURE_ROLE;
  const env = { PORTAL_DATA_BACKEND: "control-plane", PORTAL_COOKIE_SECURE: "false", PORTAL_PUBLIC_ORIGIN: "https://portal.example" };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const id = "78000000-0000-4000-8000-000000000003", key = "78000000-0000-4000-8000-000000000002";
  fixture.releaseSession = { userId: "release-owner", tenantId: "78000000-0000-4000-8000-000000000001", role: "tenant_owner", csrfToken: "synthetic-csrf" };
  fixture.releaseCalls = [];
  const body = { routeId: "78000000-0000-4000-8000-000000000004", phoneNumberId: "1234567890", disconnectOperationId: "78000000-0000-4000-8000-000000000005" };
  const headers = { cookie: "wasalx_session=synthetic-cookie", origin: env.PORTAL_PUBLIC_ORIGIN, "content-type": "application/json", "x-wasalx-csrf": "synthetic-csrf", "idempotency-key": key };
  const invoke = (method: "GET" | "POST", raw: BodyInit | null = JSON.stringify(body), changed: Record<string, string> = {}, connection = id) => route[method](new Request(`${env.PORTAL_PUBLIC_ORIGIN}/api/connections/${connection}/meta/number-release`, {
    method, headers: { ...headers, ...changed }, ...(method === "POST" ? { body: raw } : {}),
  }), { params: Promise.resolve({ id: connection }) });
  const privateResponse = (response: Response) => assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  try {
    for (const role of ["tenant_owner", "tenant_admin", "supervisor", "auditor", "agent"]) {
      fixture.releaseSession.role = role;
      const read = await invoke("GET"); assert.equal(read.status, 200, role); privateResponse(read);
      const count: number = fixture.releaseCalls.length, response = await invoke("POST");
      const writable = role === "tenant_owner" || role === "tenant_admin";
      assert.equal(response.status, writable ? 200 : 403, role); privateResponse(response);
      assert.equal(fixture.releaseCalls.length, count + (writable ? 1 : 0));
      if (writable) {
        assert.deepEqual(fixture.releaseCalls.at(-1), [id, key, body, env.PORTAL_PUBLIC_ORIGIN]);
        assert.deepEqual(await response.json(), { id: "78000000-0000-4000-8000-000000000006", released: true, duplicate: false, reconnectRequiresNewConnection: true });
      }
    }
    fixture.releaseSession.role = "tenant_owner";
    for (const [changed, status] of [[{ origin: "https://foreign.example" }, 403], [{ "x-wasalx-csrf": "wrong" }, 403], [{ cookie: "" }, 401], [{ "content-type": "text/plain" }, 403], [{ "idempotency-key": "" }, 400], [{ "idempotency-key": "x".repeat(129) }, 400]] as Array<[Record<string, string>, number]>) {
      const count: number = fixture.releaseCalls.length, response = await invoke("POST", JSON.stringify(body), changed);
      assert.equal(response.status, status); privateResponse(response); assert.equal(fixture.releaseCalls.length, count);
    }
    for (const [raw, changed, status] of [["{", {}, 400], [new Uint8Array([0xc3, 0x28]), {}, 400], ["{}", { "content-length": "4097" }, 400], [" ".repeat(4097), {}, 413], [null, {}, 400]] as Array<[BodyInit | null, Record<string, string>, number]>) {
      const count: number = fixture.releaseCalls.length, response = await invoke("POST", raw, changed);
      assert.equal(response.status, status); privateResponse(response);
      assert.deepEqual(await response.json(), { error: "Review the number release details.", code: "META_NUMBER_RELEASE_INVALID" });
      assert.equal(fixture.releaseCalls.length, count, "Invalid bodies never reach a mutation");
    }
    for (const method of ["GET", "POST"] as const) {
      const count: number = fixture.releaseCalls.length, response = await invoke(method, JSON.stringify(body), {}, "invalid-id");
      assert.equal(response.status, 400); privateResponse(response); assert.equal(fixture.releaseCalls.length, count);
    }
    for (const [status, code] of [[400, "META_NUMBER_RELEASE_INVALID"], [403, "REAUTHENTICATION_REQUIRED"], [403, "META_NUMBER_RELEASE_FORBIDDEN"], [404, "NOT_FOUND"], [409, "META_NUMBER_RELEASE_NOT_READY"]] as const) {
      fixture.releaseFailure = { status, code }; const count: number = fixture.releaseCalls.length;
      const response = await invoke("POST"); assert.equal(response.status, status); privateResponse(response);
      assert.deepEqual(await response.json(), { error: "Review the release request", code }); assert.equal(fixture.releaseCalls.length, count + 1);
    }
    delete fixture.releaseFailure;
    process.env.PORTAL_DATA_BACKEND = "fixture";
    process.env.PORTAL_FIXTURE_ROLE = "tenant_owner";
    const count = fixture.releaseCalls.length;
    for (const method of ["GET", "POST"] as const) {
      const response = await route[method](new Request(`http://localhost/api/connections/${id}/meta/number-release`, { method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ id }) });
      assert.equal(response.status, 501); privateResponse(response);
    }
    assert.equal(fixture.releaseCalls.length, count);
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    delete fixture.releaseSession; delete fixture.releaseCalls; delete fixture.releaseFailure;
    if (previousFixtureRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE; else process.env.PORTAL_FIXTURE_ROLE = previousFixtureRole;
  }
});
