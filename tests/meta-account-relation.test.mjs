import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { verifyMetaCredentialMetadata, assertMetaCredentialProof } from "../packages/core/dist/meta-account-relation.js";
import { HttpMetaGroupsClient } from "../services/control-api/dist/meta-groups.client.js";
import { MetaGroupsAdapter } from "../services/connector-worker/dist/packages/connectors/src/meta.js";

const token = "synthetic-meta-token-for-contract-tests";
const phone = "123456789";
const waba = "987654321";
for (const transport of ["admission", "worker"]) {
  const verify = () => transport === "admission"
    ? new HttpMetaGroupsClient(new URL("https://graph.facebook.com"), "v24.0", token, phone).verifyPhoneAccountRelationship(waba)
    : new MetaGroupsAdapter({ accessToken: token, graphVersion: "v24.0", phoneNumberIdFor: () => phone, wabaIdFor: () => waba }).verifyPhoneAccountRelationship("connection");

  test(`${transport}: verifies exact membership on a later page without following a paging URL`, async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input); calls.push(url);
      assert.equal(url.origin, "https://graph.facebook.com");
      assert.equal(url.pathname, `/v24.0/${waba}/phone_numbers`);
      assert.equal(url.searchParams.get("fields"), "id,display_phone_number");
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      return Response.json(calls.length === 1
        ? { data: [{ id: "111111111" }], paging: { next: "https://untrusted.example/leak", cursors: { after: "page_2=" } } }
        : { data: [{ id: "222222222", display_phone_number: "+44 20 0000 0000" }, { id: phone, display_phone_number: "+16505550100" }] });
    };
    try {
      const proof = await verify();
      assert.equal(proof.claim, "PHONE_ACCOUNT_RELATION_VERIFIED");
      assert.equal(proof.wabaId, waba); assert.equal(proof.phoneNumberId, phone);
      assert.equal(proof.displayPhoneNumber, "+16505550100");
      assert.match(proof.responseSha256, /^[a-f0-9]{64}$/);
      assert.equal(calls.length, 2); assert.equal(calls[1].searchParams.get("after"), "page_2=");
      assert.doesNotMatch(JSON.stringify(proof), /token|owner|payer/i);
    } finally { globalThis.fetch = original; }
  });

  for (const [label, response] of [
    ["malformed matched display", { data: [{ id: phone, display_phone_number: "local-number" }] }],
    ["numeric matched display", { data: [{ id: phone, display_phone_number: 16505550100 }] }],
    ["ambiguous matched Graph row", { data: [{ id: phone, display_phone_number: "+16505550100" }, { id: phone, display_phone_number: "+16505550101" }] }],
    ["wrong account with readable phone", { data: [{ id: "111111111" }] }],
    ["empty account", { data: [] }], ["missing data", {}],
    ["unsafe numeric id", { data: [{ id: 9007199254740992 }] }],
    ["numeric primitive", { data: [{ id: 123456789 }] }],
    ["malformed id next to correct id", { data: [{ id: phone }, { id: "../foreign" }] }],
    ["missing pagination cursor", { data: [], paging: { next: "https://graph.facebook.com/next" } }],
    ["repeated cursor", { data: [], paging: { next: "https://graph.facebook.com/next", cursors: { after: "same" } } }],
  ]) test(`${transport}: fails closed on ${label}`, async () => {
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(response); };
    try {
      await assert.rejects(verify, error => error.code === "META_PHONE_ACCOUNT_RELATION_INVALID" && !error.retryable);
      assert.ok(calls <= 2);
    } finally { globalThis.fetch = original; }
  });


  test(`${transport}: missing provider display remains explicitly unavailable, never inferred from Graph ID`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [{ id: phone }] });
    try {
      const proof = await verify();
      assert.equal(proof.displayPhoneNumber, undefined);
      assert.equal(Object.hasOwn(proof, "displayPhoneNumber"), false);
    } finally { globalThis.fetch = original; }
  });

  test(`${transport}: bounds the account walk and preserves provider error classification`, async () => {
    const original = globalThis.fetch; let calls = 0;
    try {
      globalThis.fetch = async () => Response.json({ data: [], paging: { next: "https://graph.facebook.com/next", cursors: { after: `page${++calls}` } } });
      await assert.rejects(verify, { code: "META_PHONE_ACCOUNT_RELATION_INVALID" });
      assert.equal(calls, 20);
      for (const [status, code, expected, retryable] of [[401,190,"META_AUTHENTICATION_FAILED",false],[403,10,"META_PERMISSION_REQUIRED",false],[429,613,"META_RATE_LIMITED",true]]) {
        globalThis.fetch = async () => Response.json({ error: { code, message: token } }, { status });
        await assert.rejects(verify, error => error.code === expected && error.retryable === retryable && !error.message.includes(token));
      }
    } finally { globalThis.fetch = original; }
  });
}


const appId = "12025550130";
const appSecret = "synthetic-configured-app-secret";
const now = new Date("2026-10-07T12:00:00.000Z");
const expiry = Math.floor(now.getTime() / 1000) + 3600;
const scopes = ["whatsapp_business_messaging", "whatsapp_business_management"];
const debug = (overrides = {}) => ({ data: { is_valid: true, app_id: appId, scopes, expires_at: expiry, ...overrides } });
const fingerprint = createHash("sha256").update(token).digest("hex");
const metadata = () => verifyMetaCredentialMetadata(debug(), { appId, now });
const invalidMetadata = error => error.code === "META_CREDENTIAL_METADATA_INVALID" && !error.message.includes(token);

test("credential metadata is a redacted canonical validity claim, not ownership or granular grants", () => {
  const proof = verifyMetaCredentialMetadata(debug({ scopes: [...scopes, scopes[0]], user_id: "private-user",
    granular_scopes: [{ scope: scopes[0], target_ids: [waba] }], application: token }), { appId, now });
  assert.deepEqual(proof.scopes, [...scopes].sort());
  assert.equal(proof.claim, "CREDENTIAL_METADATA_VERIFIED");
  assert.equal(proof.verifiedAt, now.toISOString());
  assert.equal(proof.responseSha256, metadata().responseSha256);
  assert.doesNotMatch(JSON.stringify(proof), /private-user|target_ids|granular|synthetic|owner|payer/iu);
  for (const expiresAt of [0, expiry]) {
    assert.equal(verifyMetaCredentialMetadata(debug({ expires_at: expiresAt, data_access_expires_at: 0 }), { appId, now }).expiresAt, expiresAt);
  }
});

for (const [label, value] of [
  ["missing wrapper", {}], ["wrong wrapper", { data: [] }],
  ["false validity", debug({ is_valid: false })], ["typed validity", debug({ is_valid: "true" })],
  ["wrong app", debug({ app_id: "999999999" })], ["numeric app", debug({ app_id: Number(appId) })],
  ["missing scopes", debug({ scopes: undefined })], ["missing messaging", debug({ scopes: [scopes[1]] })],
  ["typed scopes", debug({ scopes: scopes.join(",") })], ["malformed scope", debug({ scopes: [...scopes, {}] })],
  ...[undefined, null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, expiry - 3600, expiry - 3601]
    .map(value => [`invalid expiry ${String(value)}`, debug({ expires_at: value })]),
  ...[null, "0", -1, expiry - 3600].map(value => [`invalid data expiry ${String(value)}`, debug({ data_access_expires_at: value })]),
]) test(`credential metadata rejects ${label}`, () => {
  assert.throws(() => verifyMetaCredentialMetadata(value, { appId, now }), invalidMetadata);
});

test("credential guard preserves absent legacy metadata while binding any supplied resolved token", () => {
  for (const proof of [undefined, null, { credentialFingerprint: fingerprint }]) {
    assert.equal(assertMetaCredentialProof(proof, { appId, accessToken: token, now }), undefined);
  }
  assert.throws(() => assertMetaCredentialProof({ credentialFingerprint: "different" }, { appId, accessToken: token, now }), invalidMetadata);
  const proof = { credentialFingerprint: fingerprint, credentialMetadata: metadata() };
  assert.deepEqual(assertMetaCredentialProof(proof, { appId, accessToken: token, credentialFingerprint: fingerprint, now }), proof.credentialMetadata);
  assert.throws(() => assertMetaCredentialProof(proof, { appId, accessToken: token, credentialFingerprint: "different", now }), invalidMetadata);
});

test("credential guard rejects provided malformed, changed, wrong-app and expired metadata", () => {
  for (const change of [null, {}, { ...metadata(), schemaVersion: 2 }, { ...metadata(), appId: "999999999" },
    { ...metadata(), scopes: [...scopes] }, { ...metadata(), responseSha256: "0".repeat(64) },
    { ...metadata(), verifiedAt: "invalid" }, { ...metadata(), verifiedAt: "2026-10-08T00:00:00.000Z" },
    { ...metadata(), expiresAt: expiry - 3600 }, { ...metadata(), unexpected: token }]) {
    assert.throws(() => assertMetaCredentialProof({ credentialFingerprint: fingerprint, credentialMetadata: change }, { appId, now }), invalidMetadata);
  }
  assert.throws(() => assertMetaCredentialProof({ credentialMetadata: metadata() }, { appId, now }), invalidMetadata);
  assert.throws(() => assertMetaCredentialProof({ credentialFingerprint: fingerprint, credentialMetadata: metadata() }, { appId, accessToken: "different-resolved-token", now }), invalidMetadata);
});

test("debug_token separates configured app bearer from subject and keeps pinned Graph transport", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    const url = new URL(input);
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(url.pathname, "/v24.0/debug_token");
    assert.equal(url.searchParams.get("input_token"), token);
    assert.equal(url.searchParams.has("access_token"), false);
    assert.equal(init.headers.authorization, `Bearer ${appId}|${appSecret}`);
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
    return Response.json(debug({ expires_at: 0 }));
  };
  try {
    const proof = await new HttpMetaGroupsClient(new URL("https://graph.facebook.com"), "v24.0", token, phone).verifyCredentialMetadata(appId, appSecret);
    assert.equal(proof.appId, appId); assert.equal(proof.expiresAt, 0); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("debug_token failures are classified and redact both credentials and provider free text", async () => {
  const original = globalThis.fetch;
  const client = new HttpMetaGroupsClient(new URL("https://graph.facebook.com"), "v24.0", token, phone);
  try {
    globalThis.fetch = async () => Response.json(debug({ app_id: "999999999", expires_at: 0 }));
    await assert.rejects(() => client.verifyCredentialMetadata(appId, appSecret), error => invalidMetadata(error) && error.outcomeKnown && !error.retryable);
    for (const [status, code, expected, retryable] of [[401,190,"META_AUTHENTICATION_FAILED",false],[403,10,"META_PERMISSION_REQUIRED",false],[429,613,"META_RATE_LIMITED",true]]) {
      globalThis.fetch = async () => Response.json({ error: { code, message: `${token}:${appSecret}` } }, { status });
      await assert.rejects(() => client.verifyCredentialMetadata(appId, appSecret), error => error.code === expected && error.retryable === retryable && error.outcomeKnown && !error.message.includes(token) && !error.message.includes(appSecret));
    }
    globalThis.fetch = async () => { throw new Error(`${token}:${appSecret}`); };
    await assert.rejects(() => client.verifyCredentialMetadata(appId, appSecret), error => error.code === "META_NETWORK" && error.outcomeKnown && !error.message.includes(token) && !error.message.includes(appSecret));
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`${token}:${appSecret}`)); } }));
    await assert.rejects(() => client.verifyCredentialMetadata(appId, appSecret), error => error.code === "META_NETWORK" && error.outcomeKnown && !error.message.includes(token) && !error.message.includes(appSecret));
  } finally { globalThis.fetch = original; }
});

test("current-credential prefetch rejection makes no HTTP request and is not a network failure", async () => {
  const original = globalThis.fetch; let calls = 0;
  const rejected = new Error("known-not-sent");
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    const client = new HttpMetaGroupsClient(new URL("https://graph.facebook.com"), "v24.0", token, phone, async () => { throw rejected; });
    await assert.rejects(() => client.getInviteLink("123456789"), error => error === rejected);
    await assert.rejects(() => client.verifyCredentialMetadata(appId, appSecret), error => error === rejected);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

const lifecycle = await import("../packages/core/dist/meta-account-relation.js");
const { classifyMetaLifecycleValue, applyMetaLifecycleObservation, parseMetaLifecycleState,
  metaLifecycleBlockingReasons, assertMetaLifecycleAccess, recoverMetaLifecycleReasons,
  normalizeMetaDisplayPhoneNumber, metaLifecyclePayloadSha256 } = lifecycle;
const lifecycleApp = "12025550130";
const stamp = (event, second, hash = "a", extra = {}) => ({
  ...classifyMetaLifecycleValue({ event, ...extra }, lifecycleApp),
  observedAt: new Date(Date.UTC(2026, 9, 7, 12, 0, second)).toISOString(), payloadSha256: hash.repeat(64),
});
const apply = (state, observation) => applyMetaLifecycleObservation(state, observation).state;

// Official account_update and Business app onboarding contracts describe two
// PARTNER_REMOVED addresses. These synthetic fixtures preserve their shapes.
for (const [consumer, module] of [["admission", lifecycle], ["worker", await import("../services/connector-worker/dist/packages/core/src/meta-account-relation.js")]]) {
  const accountId = module.metaLifecycleAccountId;
  const coexistence = { event: "PARTNER_REMOVED", phone_number: "+16505550100" };
  const details = { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" };
  test(`${consumer}: lifecycle addressing preserves both removal variants and portfolio precedence`, () => {
    assert.equal(accountId(waba, coexistence), waba);
    assert.equal(accountId(waba, { ...coexistence, disconnection_info: details }), waba);
    for (const event of ["PARTNER_REMOVED", "PARTNER_ADDED", "PARTNER_APP_INSTALLED", "PARTNER_APP_UNINSTALLED"])
      assert.equal(accountId(phone, { ...coexistence, event, waba_info: { waba_id: waba }, disconnection_info: details }), waba);
    assert.equal(accountId(waba, { event: "ACCOUNT_OFFBOARDED" }), waba);
  });
  test(`${consumer}: lifecycle addressing rejects malformed metadata instead of changing variants`, () => {
    for (const waba_info of [undefined, null, {}, [], "invalid", { waba_id: null }, { waba_id: 987654321 }, { waba_id: "bad" }])
      assert.throws(() => accountId(waba, { ...coexistence, waba_info }), { code: "META_ACCOUNT_LIFECYCLE_HELD" });
    for (const phone_number of [undefined, null, 16505550100, "", "invalid-display-phone", "+16505550100 ext 1"])
      assert.throws(() => accountId(waba, { ...coexistence, phone_number, disconnection_info: details }));
    for (const event of ["PARTNER_ADDED", "PARTNER_APP_INSTALLED", "PARTNER_APP_UNINSTALLED", "PARTNER_UNKNOWN"])
      assert.throws(() => accountId(waba, { ...coexistence, event, disconnection_info: details }));
    for (const id of [undefined, null, 987654321, "bad"])
      assert.throws(() => accountId(id, coexistence));
  });
}

test("semantic lifecycle hash survives JSONB nested key reorder but preserves array order", () => {
  const a = { entry: { time: 1700000000, id: "123456789" }, value: { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "ONE", expiration: 1 }, { restriction_type: "TWO" }] } };
  const reordered = { value: { restriction_info: [{ expiration: 1, restriction_type: "ONE" }, { restriction_type: "TWO" }], event: "ACCOUNT_RESTRICTION" }, entry: { id: "123456789", time: 1700000000 } };
  assert.equal(metaLifecyclePayloadSha256(a), metaLifecyclePayloadSha256(reordered));
  assert.notEqual(metaLifecyclePayloadSha256(a), metaLifecyclePayloadSha256({ ...reordered, value: { ...reordered.value, restriction_info: [...reordered.value.restriction_info].reverse() } }));
  let deep = null; for (let i = 0; i < 34; i++) deep = { nested: deep };
  for (const invalid of [undefined, NaN, Infinity, 1n, () => {}, { missing: undefined }, new Date(), deep, Array(1)])
    assert.throws(() => metaLifecyclePayloadSha256(invalid));
});

test("provider display phone normalization has no local country-code inference", () => {
  assert.equal(normalizeMetaDisplayPhoneNumber("+16505550100"), "+16505550100");
  assert.equal(normalizeMetaDisplayPhoneNumber("+12025550142"), "+12025550142");
  for (const value of [null, 12025550142, "invalid-display-phone", "12025550142 ext 1", "invalid-display-phone", "966/501234567", "invalid-display-phone"])
    assert.equal(normalizeMetaDisplayPhoneNumber(value), undefined);
});
test("per-reason negative ordering retains older unrelated blockers after a newer warning", () => {
  let state = apply(undefined, stamp("ACCOUNT_VIOLATION", 40));
  state = apply(state, stamp("ACCOUNT_OFFBOARDED", 10));
  state = apply(state, stamp("PARTNER_REMOVED", 20));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["ACCOUNT_OFFBOARDED", "PARTNER_REMOVED"]);
  assert.equal(state.lastObservedAt, stamp("ACCOUNT_VIOLATION", 40).observedAt);
  assert.throws(() => assertMetaLifecycleAccess(state), { code: "META_ACCOUNT_LIFECYCLE_HELD" });
});
test("recovery is per reason, observation-only, and explicit activation preserves unrelated blocks", () => {
  let state = apply(undefined, stamp("ACCOUNT_OFFBOARDED", 10));
  state = apply(state, stamp("PARTNER_REMOVED", 11));
  state = apply(state, stamp("ACCOUNT_RECONNECTED", 20));
  assert.equal(metaLifecycleBlockingReasons(state).length, 2);
  assert.throws(() => recoverMetaLifecycleReasons(state, state.revision, ["PARTNER_REMOVED"]));
  assert.throws(() => recoverMetaLifecycleReasons(state, state.revision - 1, ["ACCOUNT_OFFBOARDED"]));
  state = recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]);
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["PARTNER_REMOVED"]);
});
test("recovery-first delivery can qualify an older matching negative only through explicit activation", () => {
  let state = apply(undefined, stamp("ACCOUNT_RECONNECTED", 20));
  state = apply(state, stamp("ACCOUNT_OFFBOARDED", 10));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["ACCOUNT_OFFBOARDED"]);
  state = recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]);
  const duplicate = applyMetaLifecycleObservation(state, stamp("ACCOUNT_OFFBOARDED", 10));
  assert.equal(duplicate.outcome, "DUPLICATE");
  assert.deepEqual(metaLifecycleBlockingReasons(duplicate.state), []);
  // A previously unseen older negative is also covered by the already activated newer recovery.
  state = apply(state, stamp("ACCOUNT_OFFBOARDED", 15, "b"));
  assert.deepEqual(metaLifecycleBlockingReasons(state), []);
  state = apply(state, stamp("ACCOUNT_OFFBOARDED", 30, "c"));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["ACCOUNT_OFFBOARDED"]);
  assert.throws(() => recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]));
});
test("same-reason newer negative supersedes older negative without suppressing another reason", () => {
  let state = apply(undefined, stamp("ACCOUNT_OFFBOARDED", 30));
  const older = applyMetaLifecycleObservation(state, stamp("ACCOUNT_OFFBOARDED", 10, "b"));
  assert.equal(older.outcome, "IGNORED_STALE"); assert.deepEqual(older.state, state);
  state = apply(state, stamp("PARTNER_REMOVED", 5));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["ACCOUNT_OFFBOARDED", "PARTNER_REMOVED"]);
});
test("newer unactivated recovery never widens an already activated recovery watermark", () => {
  let state = apply(undefined, stamp("ACCOUNT_OFFBOARDED", 10));
  state = apply(state, stamp("ACCOUNT_RECONNECTED", 20));
  state = recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]);
  const activated = state.reasonStates[0].clearedThrough;
  assert.deepEqual(activated, { event: "ACCOUNT_RECONNECTED", observedAt: stamp("ACCOUNT_RECONNECTED", 20).observedAt, payloadSha256: "a".repeat(64) });
  state = apply(state, stamp("ACCOUNT_RECONNECTED", 40, "b"));
  assert.deepEqual(state.reasonStates[0].clearedThrough, activated);
  state = apply(state, stamp("ACCOUNT_OFFBOARDED", 15, "b"));
  assert.deepEqual(metaLifecycleBlockingReasons(state), []);
  state = apply(state, stamp("ACCOUNT_OFFBOARDED", 30, "c"));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["ACCOUNT_OFFBOARDED"]);
  state = recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]);
  assert.equal(state.reasonStates[0].clearedThrough.observedAt, stamp("ACCOUNT_RECONNECTED", 40).observedAt);
  assert.deepEqual(metaLifecycleBlockingReasons(state), []);
  const slot = state.reasonStates[0];
  for (const changed of [{ ...slot, clearedThrough: undefined },
    { ...slot, clearedThrough: { ...slot.clearedThrough, event: "PARTNER_ADDED" } },
    { ...slot, clearedThrough: { ...slot.clearedThrough, observedAt: stamp("ACCOUNT_RECONNECTED", 50).observedAt } },
    { ...slot, clearedThrough: { ...slot.clearedThrough, payloadSha256: "f".repeat(64) } }])
    assert.throws(() => parseMetaLifecycleState({ ...state, reasonStates: [changed] }));
});
test("equal-time conflicting negatives and positive/negative ties hold in both arrival orders", () => {
  const a = stamp("ACCOUNT_OFFBOARDED", 10), b = stamp("ACCOUNT_OFFBOARDED", 10, "b");
  for (const [first, second] of [[a, b], [b, a], [a, stamp("ACCOUNT_RECONNECTED", 10)], [stamp("ACCOUNT_RECONNECTED", 10), a]]) {
    const state = apply(apply(undefined, first), second);
    assert.ok(metaLifecycleBlockingReasons(state).includes("LIFECYCLE_CONFLICT"));
    assert.throws(() => recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]));
    assert.deepEqual(parseMetaLifecycleState(state), state);
  }
});
test("conflicting recovery after explicit activation preserves its immutable watermark and valid conflict hold", () => {
  for (const [first, second] of [["a", "b"], ["b", "a"]]) {
    let state = apply(undefined, stamp("ACCOUNT_OFFBOARDED", 10));
    state = apply(state, stamp("ACCOUNT_RECONNECTED", 20, first));
    state = recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]);
    const accepted = { ...state.reasonStates[0].clearedThrough };
    state = apply(state, stamp("ACCOUNT_RECONNECTED", 20, second));
    assert.deepEqual(state.reasonStates[0].clearedThrough, accepted);
    assert.deepEqual(parseMetaLifecycleState(state), state);
    assert.ok(metaLifecycleBlockingReasons(state).includes("LIFECYCLE_CONFLICT"));
    assert.throws(() => recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_OFFBOARDED"]));
    state = apply(state, stamp("ACCOUNT_VIOLATION", 30));
    assert.deepEqual(parseMetaLifecycleState(state), state);
    assert.ok(metaLifecycleBlockingReasons(state).includes("LIFECYCLE_CONFLICT"));
  }
});
test("other-app positive and negative observations never change this app's access", () => {
  let state = apply(undefined, stamp("PARTNER_APP_UNINSTALLED", 10, "a", { waba_info: { partner_app_id: lifecycleApp } }));
  state = apply(state, stamp("PARTNER_APP_INSTALLED", 20, "b", { waba_info: { partner_app_id: "999999999" } }));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["PARTNER_APP_UNINSTALLED"]);
  assert.throws(() => recoverMetaLifecycleReasons(state, state.revision, ["PARTNER_APP_UNINSTALLED"]));
  assert.equal(classifyMetaLifecycleValue({ event: "PARTNER_APP_UNINSTALLED", waba_info: { partner_app_id: "999999999" } }, lifecycleApp).kind, "OBSERVATION");
});
test("finite restrictions and disabled/reinstate mapping do not infer recovery from expiry", () => {
  const utilityCreationOnly = classifyMetaLifecycleValue({ event: "ACCOUNT_RESTRICTION", restriction_info: [
    { restriction_type: "RESTRICTED_UTILITY_TEMPLATES" },
  ] }, lifecycleApp);
  assert.deepEqual(utilityCreationOnly, { event: "ACCOUNT_RESTRICTION", kind: "OBSERVATION", reasons: [] });
  assert.equal(assertMetaLifecycleAccess(apply(undefined, { ...stamp("ACCOUNT_VIOLATION", 10), ...utilityCreationOnly })), undefined);
  assert.deepEqual(classifyMetaLifecycleValue({ event: "ACCOUNT_RESTRICTION", restriction_info: [
    { restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: 1 },
    { restriction_type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION" },
  ] }, lifecycleApp).reasons, ["RESTRICTED_BIZ_INITIATED_MESSAGING"]);
  const disabled = stamp("DISABLED_UPDATE", 10, "a", { ban_info: { waba_ban_state: "DISABLE" } });
  let state = apply(undefined, disabled);
  state = apply(state, stamp("DISABLED_UPDATE", 20, "b", { ban_info: { waba_ban_state: "REINSTATE" } }));
  assert.deepEqual(metaLifecycleBlockingReasons(state), ["ACCOUNT_DISABLED"]);
  assert.deepEqual(metaLifecycleBlockingReasons(recoverMetaLifecycleReasons(state, state.revision, ["ACCOUNT_DISABLED"])), []);
  for (const value of [{ event: "DISABLED_UPDATE" }, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: "UNKNOWN" } },
    { event: "ACCOUNT_RESTRICTION", restriction_info: [] }, { event: "PARTNER_APP_INSTALLED" }])
    assert.throws(() => classifyMetaLifecycleValue(value, lifecycleApp));
});
test("deletion and unresolved phone cannot be recovered by a valid credential or unrelated signal", () => {
  let state = apply(undefined, stamp("ACCOUNT_DELETED", 10));
  state = apply(state, { ...stamp("ACCOUNT_OFFBOARDED", 11), reasons: ["UNRESOLVED_PHONE"] });
  state = apply(state, stamp("ACCOUNT_RECONNECTED", 20));
  for (const reason of ["ACCOUNT_DELETED", "UNRESOLVED_PHONE"])
    assert.throws(() => recoverMetaLifecycleReasons(state, state.revision, [reason]));
});
test("lifecycle parser is fail-closed for present malformed state and guard allows genuine absence", () => {
  assert.equal(parseMetaLifecycleState(undefined), undefined); assert.throws(() => parseMetaLifecycleState(null));
  assert.equal(assertMetaLifecycleAccess(undefined), undefined);
  const state = apply(undefined, stamp("ACCOUNT_OFFBOARDED", 10));
  for (const changed of [{}, { ...state, revision: 0 }, { ...state, schemaVersion: 2 },
    { ...state, extra: "untrusted" }, { ...state, reasonStates: [...state.reasonStates, ...state.reasonStates] },
    { ...state, reasonStates: [{ ...state.reasonStates[0], blocked: false }] },
    { ...state, reasonStates: [{ ...state.reasonStates[0], recovery: { ...state.reasonStates[0].negative, event: "PARTNER_ADDED" } }] }])
    assert.throws(() => parseMetaLifecycleState(changed));
  const copy = parseMetaLifecycleState(state); copy.reasonStates[0].blocked = false;
  assert.equal(state.reasonStates[0].blocked, true);
});

// Financial-token inspection reuses app/fingerprint/expiry parsing while the
// existing messaging callers retain their default two WhatsApp scopes.
test("financial credential purpose requires business management without fabricating messaging access", () => {
  const financial = verifyMetaCredentialMetadata(debug({ scopes: ["business_management"] }), { appId, now, purpose: "FINANCIAL" });
  assert.deepEqual(financial.scopes, ["business_management"]);
  const proof = { credentialFingerprint: createHash("sha256").update(token).digest("hex"), credentialMetadata: financial };
  assert.equal(assertMetaCredentialProof(proof, { appId, accessToken: token, now, purpose: "FINANCIAL" }).appId, appId);
  assert.throws(() => assertMetaCredentialProof(proof, { appId, accessToken: token, now }), invalidMetadata);
  assert.throws(() => verifyMetaCredentialMetadata(debug(), { appId, now, purpose: "FINANCIAL" }), invalidMetadata);
  assert.throws(() => assertMetaCredentialProof(proof, { appId, accessToken: "wrong-token", now, purpose: "FINANCIAL" }), invalidMetadata);
  assert.throws(() => verifyMetaCredentialMetadata(debug({ scopes: ["business_management"], expires_at: expiry - 3600 }), { appId, now, purpose: "FINANCIAL" }), invalidMetadata);
});
