import assert from "node:assert/strict";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import ts from "typescript";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui.ts";
import { localizedUiError } from "../lib/ui-error.ts";

// Source-executed trust-boundary and asynchronous state tests; real browser and native policy checks remain separate.
const source = ts.createSourceFile("WasalXApp.tsx", readTenantPortalSource(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function top(name, bindings = {}) {
  const node = source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node, name);
  const code = ts.transpileModule(node.getText().replace(/^export /u, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code};return ${name};`)(...Object.values(bindings));
}
function callback(owner, name, bindings) {
  const component = source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === owner);
  let expression;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText() === name) expression = node.initializer; ts.forEachChild(node, visit); }
  visit(component);
  assert.ok(expression, `${owner}.${name}`);
  if (ts.isCallExpression(expression) && expression.expression.getText() === "useCallback") expression = expression.arguments[0];
  const code = ts.transpileModule(`const value=${expression.getText()};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code};return value;`)(...Object.values(bindings));
}
function counter() {
  let current = 0;
  return { begin: () => ++current, invalidate: () => ++current, isCurrent: value => value === current };
}
const sha = "a".repeat(64);
test("only a complete, matching native identity readback can become a selection", () => {
  const parse = top("parsePrivacyTargetSelection");
  const row = { scope_type: "ZAMMAD_TICKET", display: "#0001042 · Delivery request", selection_sha256: sha };
  assert.deepEqual(parse(row, "ZAMMAD_TICKET"), row);
  for (const invalid of [null, [], { ...row, display: "" }, { ...row, selection_sha256: "not-a-hash" }, { ...row, scope_type: "ZAMMAD_USER" }]) assert.throws(() => parse(invalid, "ZAMMAD_TICKET"));
  assert.throws(() => parse({ ...row, scope_type: "REFERENCE" }, "REFERENCE"));
});
test("historic native IDs and customer identity never become public scope labels", () => {
  const readback = top("privacyScopeReadback"), t = key => key;
  assert.equal(readback("ZAMMAD_TICKET", "987654321", t), "tenant.privacy.common.restricted");
  assert.equal(readback("ZAMMAD_TICKET", "#0001042", t), "#0001042");
  assert.equal(readback("ZAMMAD_USER", "customer@example.invalid", t), "tenant.privacy.common.restricted");
  assert.equal(readback("REFERENCE", "ORDER1042", t), "ORDER1042");
});
test("input, mode and unmount invalidation prevent old target responses from becoming current", () => {
  const current = { current: { context: "original", mounted: true } };
  const fence = { current: counter() }, requests = { current: { controller: null, begin() { this.controller?.abort(); return this.controller = new AbortController(); } } };
  const isActive = callback("usePrivacyTargetSelection", "isActive", { current, context: "original" });
  const begin = callback("usePrivacyTargetSelection", "begin", { fence, requests, isActive });
  const first = begin(); assert.equal(first.isCurrent(), true);
  const next = begin(); assert.equal(first.isCurrent(), false); assert.equal(next.isCurrent(), true);
  current.current.context = "edited"; assert.equal(next.isCurrent(), false);
  current.current.context = "original"; current.current.mounted = false; assert.equal(next.isCurrent(), false);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function privacyLoad(fetch) {
  const calls = [], privacyDirty = { current: false }, privacyLifetime = { current: { mounted: true } }, privacyLoadFence = { current: counter() };
  const bindings = { operatorFailureMessage, operatorLocalFailure, fetch, privacyDirty, privacyLifetime, privacyLoadFence, isPrivateDemo: false, privacyPolicyForm: top("privacyPolicyForm"),
    t: key => key, apiError: async () => "tenant.privacy.error.load", isAbortError: error => error instanceof DOMException && error.name === "AbortError" };
  for (const name of ["Policy", "PolicyForm", "SavedPolicyForm", "Holds", "Requests", "Loading", "Error", "HoldOpen", "RequestType", "ReleaseHold", "RetryRequest", "DetailId", "Download", "Busy"]) bindings[`set${name}`] = value => calls.push([name, value]);
  return { calls, privacyDirty, privacyLifetime, privacyLoadFence, load: callback("PrivacySettings", "load", bindings) };
}
const policy = version => ({ state: "ACTIVE", version, resolved_case_days: 180, include_open_cases: false, media_days: 30, unmatched_diagnostic_hours: 12, export_ttl_hours: 24 });
test("a delayed refresh preserves the dirty draft, saved baseline and original optimistic version", async () => {
  const decode = deferred(), entered = deferred();
  const fixture = privacyLoad(async url => ({ ok: true, json: () => url.endsWith("policy") ? (entered.resolve(), decode.promise) : Promise.resolve([]) }));
  const work = fixture.load(true);
  await entered.promise; fixture.privacyDirty.current = true; decode.resolve(policy(8)); await work;
  assert.ok(!fixture.calls.some(([name]) => ["Policy", "PolicyForm", "SavedPolicyForm"].includes(name)));
  assert.ok(fixture.calls.some(([name]) => name === "Holds"));
});
test("aborted decode and older overlapping reads cannot overwrite the latest privacy snapshot", async () => {
  const decode = deferred(), entered = deferred(); let batch = 0, request = 0;
  const fixture = privacyLoad(async url => {
    const generation = Math.floor(request++ / 3); batch = generation;
    return { ok: true, json: () => url.endsWith("policy") ? generation === 0 ? (entered.resolve(), decode.promise) : Promise.resolve(policy(9)) : Promise.resolve([]) };
  });
  const first = fixture.load(true); await entered.promise;
  await fixture.load(true); decode.resolve(policy(2)); await first;
  assert.equal(batch, 1);
  assert.deepEqual(fixture.calls.filter(([name]) => name === "Policy").map(([, value]) => value.version), [9]);
  const waiting = deferred(), decoding = deferred(), controller = new AbortController();
  const aborted = privacyLoad(async url => ({ ok: true, json: () => url.endsWith("policy") ? (decoding.resolve(), waiting.promise) : Promise.resolve([]) }));
  const run = aborted.load(true, controller.signal); await decoding.promise; controller.abort(); waiting.resolve(policy(4)); await run;
  assert.ok(!aborted.calls.some(([name]) => ["Policy", "PolicyForm", "SavedPolicyForm", "Holds", "Requests"].includes(name)));
  const unmountedDecode = deferred(), unmountedStarted = deferred();
  const unmounted = privacyLoad(async url => ({ ok: true, json: () => url.endsWith("policy") ? (unmountedStarted.resolve(), unmountedDecode.promise) : Promise.resolve([]) }));
  const initial = unmounted.load(false); await unmountedStarted.promise; unmounted.privacyLifetime.current.mounted = false; unmounted.privacyLoadFence.current.invalidate();
  unmountedDecode.resolve(policy(6)); await initial;
  assert.ok(!unmounted.calls.some(([name]) => ["Policy", "PolicyForm", "SavedPolicyForm", "Holds", "Requests"].includes(name)));
});
test("a denied privacy read clears displayed records and active identity dialogs", async () => {
  const fixture = privacyLoad(async () => ({ ok: false, status: 403 }));
  await fixture.load(true);
  assert.ok(fixture.calls.some(([name, value]) => name === "Policy" && value === null));
  assert.ok(fixture.calls.some(([name, value]) => name === "HoldOpen" && value === false));
  assert.ok(fixture.calls.some(([name, value]) => name === "RequestType" && value === null));
  assert.ok(fixture.calls.some(([name, value]) => name === "Loading" && value === false));
});

test("friendly case references normalize without changing leading zeros or customer email", () => {
  const normalize = top("privacyFriendlyScopeValue");
  assert.equal(normalize("ZAMMAD_TICKET", " #0001042 "), "0001042");
  assert.equal(normalize("ZAMMAD_USER", " customer@example.test "), "customer@example.test");
});
const operationId = "10000000-0000-4000-8000-000000000001";
test("the persisted pending intent contains only a UUID and operation kind", () => {
  const parse = top("parsePrivacyPendingSubmission"), intent = { operationId, kind: "EXPORT" };
  assert.deepEqual(parse(JSON.stringify(intent)), intent);
  for (const value of [{ ...intent, email: "customer@example.test" }, { ...intent, reason: "private" }, { ...intent, kind: "INVALID" }, { ...intent, kind: ["EXPORT"] }, { ...intent, operationId: "123" }, null]) assert.throws(() => parse(JSON.stringify(value)));
});
test("only authoritative acknowledgements and terminal cancellation proof resolve pending intents", () => {
  const ack = top("parsePrivacyMutationAcknowledgement"), receipt = top("parsePrivacySubmissionReceipt");
  assert.deepEqual(ack({ id: operationId, state: "QUEUED" }, "EXPORT", "REFERENCE"), { id: operationId, state: "QUEUED" });
  for (const value of [{}, { id: operationId }, { id: operationId, state: "ACTIVE" }, { id: operationId, state: "QUEUED", request_type: "DELETE" }, { id: operationId, state: "QUEUED", scope_type: "TENANT" }]) assert.throws(() => ack(value, "EXPORT", "REFERENCE"));
  assert.deepEqual(receipt({ state: "UNKNOWN" }), { state: "UNKNOWN" });
  assert.deepEqual(receipt({ state: "NOT_APPLIED", terminal: true, effect: "NONE" }), { state: "NOT_APPLIED", terminal: true, effect: "NONE" });
  for (const value of [{}, { state: "APPLIED" }, { state: "NOT_APPLIED" }, { state: "NOT_APPLIED", terminal: true, effect: "UNKNOWN" }]) assert.throws(() => receipt(value));
});
test("both real submit callbacks preserve their pending key and never complete on malformed 2xx", async () => {
  for (const owner of ["PrivacyHoldDialog", "PrivacyRequestDialog"]) {
    let completed = false, finished = false, sent;
    const errors = [], pending = { operationId, kind: owner === "PrivacyHoldDialog" ? "HOLD" : "EXPORT" };
    const bindings = { valid: true, saving: false, inFlight: { current: false }, beforeSubmit: () => {}, recovery: { start: () => pending, finish: () => { finished = true; return true; } },
      target: { begin: () => ({ signal: undefined, isCurrent: () => true }), isActive: () => true, selection: { selection_sha256: sha }, native: true, clear: () => {} },
      fetch: async (_url, init) => { sent = init; return { ok: true, json: async () => ({}) }; }, mutationHeaders: {}, requestType: "EXPORT", scopeType: "ZAMMAD_TICKET", scopeValue: "#0001042", needsValue: true,
      expiresAt: "", reason: "Synthetic hold", confirmation: "", setSaving: () => {}, setError: value => errors.push(value), t: key => key,
      complete: async () => { completed = true; }, privacyFriendlyScopeValue: top("privacyFriendlyScopeValue"), parsePrivacyMutationAcknowledgement: top("parsePrivacyMutationAcknowledgement") };
    await callback(owner, "submit", bindings)({ preventDefault() {} });
    assert.equal(sent.headers["idempotency-key"], operationId);
    assert.equal(JSON.parse(sent.body).scopeValue, "0001042");
    assert.equal(completed, false); assert.equal(finished, false);
    assert.ok(errors.includes("tenant.privacy.recovery.unknown"));
  }
});
test("submission admission writes an ID-only fence before dispatch and blocks a recovered pending intent", () => {
  const values = new Map(), calls = [];
  const bindings = { state: { current: { mounted: true, ready: true, checking: false, pending: null } }, key: "scoped", kind: "DELETE",
    sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { calls.push("persist"); values.set(key, value); } },
    crypto: { randomUUID: () => operationId }, parsePrivacyPendingSubmission: top("parsePrivacyPendingSubmission"), setPending: () => {}, setNotice: () => {}, setReady: () => {}, setError: () => {}, t: key => key };
  const start = callback("usePrivacySubmissionRecovery", "start", bindings);
  assert.deepEqual(start(), { operationId, kind: "DELETE" }); assert.deepEqual(calls, ["persist"]);
  assert.deepEqual(JSON.parse(values.get("scoped")), { operationId, kind: "DELETE" });
  assert.equal(start(), null);
  bindings.state.current.pending = null;
  assert.equal(start(), null); assert.equal(calls.length, 1);
  bindings.state.current.ready = false; values.clear(); assert.equal(start(), null);
});
test("policy draft controls reject changes while a policy save is pending", () => {
  let changes = 0;
  const update = callback("PrivacySettings", "updatePolicy", { busy: "policy", privacyDirty: { current: false }, setPolicyForm: () => changes++, setError: () => {}, setNotice: () => {} });
  update("resolvedCaseDays", "60"); assert.equal(changes, 0);
  const settings = source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === "PrivacySettings").getText();
  assert.match(settings, /readOnly=\{!canManagePolicy\} disabled=\{busy==="policy"\}/u);
  assert.match(settings, /disabled=\{busy==="policy"\} onClick=\{\(\)=>\{if\(busy==="policy"\)return;setPolicyForm\(savedPolicyForm\)/u);
});
test("unknown and malformed receipts keep the fence; confirmed terminal receipts release it", async () => {
  for (const [value, expected] of [[{ state: "UNKNOWN" }, "unknown"], [{}, "unknown"], [{ state: "APPLIED", id: operationId }, "recovered"], [{ state: "NOT_APPLIED", terminal: true, effect: "NONE" }, "cancelled"]]) {
    const calls = [], intent = { operationId, kind: "HOLD" };
    const bindings = { state: { current: { mounted: true, key: "scoped", ready: true, checking: false, pending: intent } }, key: "scoped",
      requests: { current: { begin: () => new AbortController() } }, mutationHeaders: {},
      fetch: async (_url, init) => { assert.deepEqual(JSON.parse(init.body), { ...intent, action: "CANCEL_IF_UNADMITTED" }); return { ok: true, json: async () => value }; },
      setChecking: () => {}, setError: value => { if (value) calls.push("unknown"); }, setNotice: value => { if (value) calls.push("cancelled"); }, t: key => key,
      parsePrivacySubmissionReceipt: top("parsePrivacySubmissionReceipt"), finish: () => { calls.push("finish"); return true; }, recovered: () => calls.push("recovered") };
    await callback("usePrivacySubmissionRecovery", "reconcile", bindings)(true);
    assert.deepEqual(calls, expected === "unknown" ? ["unknown"] : ["finish", expected]);
  }
});
test("a stale receipt response after dialog unmount cannot claim recovery", async () => {
  const response = deferred(), entered = deferred(), calls = [], intent = { operationId, kind: "EXPORT" };
  const state = { current: { mounted: true, key: "scoped", ready: true, checking: false, pending: intent } };
  const bindings = { state, key: "scoped", requests: { current: { begin: () => new AbortController() } }, mutationHeaders: {},
    fetch: async () => { entered.resolve(); return response.promise; }, setChecking: () => {}, setError: () => {}, setNotice: () => {}, t: key => key,
    parsePrivacySubmissionReceipt: top("parsePrivacySubmissionReceipt"), finish: () => { calls.push("finish"); return true; }, recovered: () => calls.push("recovered") };
  const run = callback("usePrivacySubmissionRecovery", "reconcile", bindings)(false); await entered.promise;
  state.current.mounted = false; response.resolve({ ok: true, json: async () => ({ state: "APPLIED", id: operationId }) }); await run;
  assert.deepEqual(calls, []); assert.deepEqual(state.current.pending, intent);
});
test("a delayed policy save cannot erase a later draft because editing is fenced for the admission", async () => {
  const admitted = deferred(), response = deferred(); let busy = null, draft = { ...top("privacyPolicyForm")(policy(1)), resolvedCaseDays: "30" };
  const bindings = { canManagePolicy: true, dirty: true, policyBlockers: [], busy, policy: policy(1), policyForm: draft, mutationHeaders: {}, privacyLoadFence: { current: counter() }, privacyLifetime: { current: { mounted: true } },
    setBusy: value => { busy = value; }, setError: () => {}, setNotice: () => {}, t: key => key, privacyPolicyForm: top("privacyPolicyForm"), setPolicy: () => {}, setPolicyForm: value => { draft = value; }, setSavedPolicyForm: () => {},
    fetch: async () => { admitted.resolve(); return response.promise; } };
  const run = callback("PrivacySettings", "savePolicy", bindings)(); await admitted.promise;
  const update = callback("PrivacySettings", "updatePolicy", { busy, privacyDirty: { current: false }, setPolicyForm: value => { draft = value(draft); }, setError: () => {}, setNotice: () => {} });
  update("resolvedCaseDays", "60"); assert.equal(draft.resolvedCaseDays, "30");
  response.resolve({ ok: true, json: async () => ({ ...policy(2), resolved_case_days: 30 }) }); await run;
  assert.equal(draft.resolvedCaseDays, "30"); assert.equal(busy, null);
});


test("policy and export-download step-up preserves the dirty policy and exposes the existing localized action",async()=>{
 const requiresStepUp=top("requiresPrivilegedReauthentication"),href=top("privilegedStepUpHref");
 assert.equal(href("/app?view=settings"),"/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dsettings");
 for(const locale of["en","ar"]){
  const apiError=top("apiError",{document:{documentElement:{lang:locale}},localizedUiError});
  const response=()=>Response.json({code:"REAUTHENTICATION_REQUIRED",message:"PRIVATE backend error"},{status:403});
  const expected=localizedUiError(locale,{code:"REAUTHENTICATION_REQUIRED",status:403}).message;
  assert.equal(await apiError(response()),expected);assert.equal(requiresStepUp(expected),true);
  const denied=await apiError(Response.json({message:"PRIVATE"},{status:403}));assert.equal(requiresStepUp(denied),false);
  for(const action of["savePolicy","prepareDownload"]){
   const draft={...top("privacyPolicyForm")(policy(1)),resolvedCaseDays:"45"},writes=[];let error,busy;
   const bindings={canManagePolicy:true,dirty:true,policyBlockers:[],busy:null,policy:policy(1),policyForm:draft,mutationHeaders:{},privacyLoadFence:{current:counter()},privacyLifetime:{current:{mounted:true}},
    setBusy:value=>{busy=value;},setError:value=>{error=value;},setNotice:()=>{},t:key=>key,privacyPolicyForm:top("privacyPolicyForm"),
    setPolicy:value=>writes.push(["policy",value]),setPolicyForm:value=>writes.push(["draft",value]),setSavedPolicyForm:value=>writes.push(["baseline",value]),setDownload:value=>{if(value!==null)writes.push(["download",value]);},
    fetch:async()=>response(),apiError,operatorLocalFailure,operatorFailureMessage};
   await callback("PrivacySettings",action,bindings)({id:operationId});
   assert.equal(error,expected);assert.equal(requiresStepUp(error),true);assert.equal(busy,null);assert.deepEqual(writes,[]);assert.equal(draft.resolvedCaseDays,"45");
  }
 }
});
