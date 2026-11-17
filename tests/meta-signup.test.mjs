import assert from "node:assert/strict";
import test from "node:test";
import { metaSignupGrantCandidates, metaSignupPhone, metaSignupHealth, metaSignupChoiceAdmission } from "../packages/core/dist/meta-signup.js";
import { MetaSignupClient } from "../services/control-api/dist/meta-signup.client.js";
import { SidecarSecretResolver } from "../services/connector-worker/dist/services/connector-worker/src/secrets.js";
import { MetaCredentialService } from "../services/control-api/dist/meta-credential.service.js";
import { isOwnedSecretReference } from "../packages/core/dist/secret-reference.js";
import { MetaSignupService } from "../services/control-api/dist/meta-signup.service.js";

const appId = "12025550130", account = "987654321", business = "333333333", phone = "123456789";
const token = "synthetic-customer-token-never-live";
const config = { appId, configId: "12025550160", graphVersion: "v24.0", origin: "https://portal.example.invalid", secretReference: "secret://platform/meta" };
const standard = { id: phone, is_on_biz_app: false, platform_type: "CLOUD_API", host_platform: "CLOUD_API", account_mode: "LIVE", status: "PENDING", code_verification_status: "VERIFIED" };

test("ADD_ACCESS admits only server-proven standard registered numbers and never new-number registration", () => {
  const choice = { ...metaSignupPhone({ ...standard, status: "CONNECTED" }, phone), phoneId: phone, wabaId: account };
  assert.equal(metaSignupChoiceAdmission(choice, undefined, "ADD_ACCESS").selectable, true);
  assert.equal(metaSignupChoiceAdmission(choice).selectable, false);
  for (const patch of [{ mode: "COEXISTENCE" }, { mode: "UNKNOWN" }, { numberState: "REGISTRATION_REQUIRED" }, { numberState: "UNKNOWN" }, { numberState: "ACTION_REQUIRED" }]) {
    assert.equal(metaSignupChoiceAdmission({ ...choice, ...patch }, undefined, "ADD_ACCESS").selectable, false);
  }
  assert.equal(metaSignupChoiceAdmission(choice, { phoneNumberId: phone, wabaId: account }, "ADD_ACCESS").selectable, false);
  assert.equal(metaSignupChoiceAdmission(choice, undefined, "RECONNECT").selectable, false);
});

test("purpose input cannot be coerced, combined with a target, or change the authorization scope", async () => {
  const noEffect = new Proxy({}, { get: () => () => assert.fail("invalid input must not reach database or provider dependencies") });
  const service = new MetaSignupService(noEffect, noEffect, noEffect, noEffect);
  const body = { name: "Accessible number", payerMode: "CUSTOMER", idempotencyKey: "synthetic-key" };
  for (const purpose of [undefined, null, "RECONNECT", "STANDARD", "", 0, ["ADD_ACCESS"], {}]) {
    await assert.rejects(() => service.start({}, { ...body, purpose }), /invalid/);
  }
  await assert.rejects(() => service.start({}, { ...body, purpose: "ADD_ACCESS", targetConnectionId: "10000000-0000-4000-8000-000000000001" }), /invalid/);
  await assert.rejects(() => service.start({}, { ...body, purpose: "ADD_ACCESS", variant: "BUSINESS_APP",
    coexistenceConsent: { version: "2026-10-07", history: false, contacts: false, echoes: true } }), /invalid/);
  for (const purpose of ["RECONNECT", ["ADD_ACCESS"], {}, ""]) await assert.rejects(() => service.latest({}, undefined, purpose), /invalid/);
  await assert.rejects(() => service.latest({}, "10000000-0000-4000-8000-000000000001", "ADD_ACCESS"), /invalid/);
});

test("reconnect admission uses exact derived registered facts and exact account/phone, without a registration fallback", () => {
  const target = { phoneNumberId: phone, wabaId: account };
  const choice = { ...metaSignupPhone({ ...standard, status: "CONNECTED" }, phone), phoneId: phone, wabaId: account };
  assert.equal(choice.numberState, "REGISTERED");
  assert.equal(metaSignupChoiceAdmission(choice, target).selectable, true);
  assert.equal(metaSignupChoiceAdmission(choice).selectable, false);
  for (const value of [{ ...choice, phoneId: "999999999" }, { ...choice, wabaId: "999999999" },
    { ...choice, mode: "COEXISTENCE" }, { ...choice, mode: "UNKNOWN" }, { ...choice, numberState: "REGISTRATION_REQUIRED" },
    { ...choice, ...metaSignupPhone({ ...standard, status: "REGISTERED" }, phone) }]) {
    assert.equal(metaSignupChoiceAdmission(value, target).selectable, false);
  }
  assert.equal(metaSignupChoiceAdmission({ ...choice, numberState: "REGISTRATION_REQUIRED" }).selectable, true);
});
test("Business app admission stays separate from standard signup and exact paused renewal", () => {
  const choice = { mode: "COEXISTENCE", numberState: "REGISTERED", phoneId: phone, wabaId: account };
  assert.equal(metaSignupChoiceAdmission(choice, undefined, "NEW_NUMBER", "BUSINESS_APP").selectable, true);
  assert.equal(metaSignupChoiceAdmission(choice).selectable, false);
  assert.equal(metaSignupChoiceAdmission(choice, { phoneNumberId: phone, wabaId: account }, "RECONNECT", "BUSINESS_APP").selectable, false);
  for (const value of [{ ...choice, mode: "STANDARD" }, { ...choice, mode: "UNKNOWN" },
    { ...choice, numberState: "REGISTRATION_REQUIRED" }, { ...choice, numberState: "UNKNOWN" }]) {
    assert.equal(metaSignupChoiceAdmission(value, undefined, "NEW_NUMBER", "BUSINESS_APP").selectable, false);
  }
});
test("same-context Business App renewal is purpose-bound and auth-only", () => {
  const choice = { mode: "COEXISTENCE", numberState: "REGISTERED", phoneId: phone, wabaId: account };
  const target = { phoneNumberId: phone, wabaId: account, coexistence: { contextId: "12000000-0000-4000-8000-000000000081" } };
  assert.equal(metaSignupChoiceAdmission(choice, target, "RECONNECT", "STANDARD").selectable, true);
  for (const purpose of ["NEW_NUMBER", "ADD_ACCESS"]) assert.equal(metaSignupChoiceAdmission(choice, target, purpose, "STANDARD").selectable, false);
  assert.equal(metaSignupChoiceAdmission(choice, target, "RECONNECT", "BUSINESS_APP").selectable, false);
  assert.equal(metaSignupChoiceAdmission(choice, { ...target, coexistence: undefined }, "RECONNECT").selectable, false);
  for (const changed of [{ ...choice, phoneId: "999999999" }, { ...choice, wabaId: "999999999" },
    { ...choice, mode: "STANDARD" }, { ...choice, mode: "UNKNOWN" }, { ...choice, numberState: "REGISTRATION_REQUIRED" }]) {
    assert.equal(metaSignupChoiceAdmission(changed, target, "RECONNECT").selectable, false);
  }
  assert.equal(metaSignupChoiceAdmission({ ...choice, mode: "STANDARD" }, undefined, "ADD_ACCESS").selectable, true);
  assert.equal(metaSignupChoiceAdmission(choice, undefined, "ADD_ACCESS").selectable, false);
});
const metadata = { app_id: appId, is_valid: true, expires_at: 0, user_id: "444444444", scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
  granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [account] }, { scope: "whatsapp_business_messaging", target_ids: [account] }] };

test("number facts require explicit standard/cloud/live mode and registration state", () => {
  assert.equal(metaSignupPhone(standard, phone).numberState, "REGISTRATION_REQUIRED");
  for (const field of ["is_on_biz_app", "platform_type", "host_platform", "account_mode"]) {
    const row = { ...standard }; delete row[field]; assert.equal(metaSignupPhone(row, phone).mode, "UNKNOWN", field);
  }
  assert.equal(metaSignupPhone({ ...standard, code_verification_status: "NOT_VERIFIED" }, phone).numberState, "UNKNOWN");
  assert.equal(metaSignupPhone({ ...standard, status: "CONNECTED" }, phone).numberState, "REGISTERED");
  assert.equal(metaSignupPhone({ ...standard, is_on_biz_app: true }, phone).mode, "COEXISTENCE");
  assert.equal(metaSignupPhone(standard, "999999999").mode, "UNKNOWN");
});

test("grant IDs are a bounded candidate intersection; absence never means universal permission", () => {
  assert.deepEqual(metaSignupGrantCandidates({ data: metadata }), { userId: "444444444", accountIds: [account] });
  assert.deepEqual(metaSignupGrantCandidates({ data: { ...metadata, granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [account] }, { scope: "whatsapp_business_messaging", target_ids: ["999999999"] }] } }).accountIds, []);
  assert.deepEqual(metaSignupGrantCandidates({ data: { ...metadata, granular_scopes: undefined } }).accountIds, []);
  assert.deepEqual(metaSignupGrantCandidates({ data: { ...metadata, granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["https://foreign"] }] } }).accountIds, []);
});

test("payment readiness does not become card verification or owner proof", () => {
  const entities = [{ entity_type: "PHONE_NUMBER", id: phone, can_send_message: "LIMITED" }, { entity_type: "WABA", id: account, can_send_message: "AVAILABLE" }, { entity_type: "APP", id: appId, can_send_message: "AVAILABLE" }];
  assert.equal(metaSignupHealth({ health_status: { can_send_message: "LIMITED", entities } }, { phoneId: phone, wabaId: account, appId }), "LIMITED");
  assert.equal(metaSignupHealth({ health_status: { can_send_message: "AVAILABLE", entities: entities.slice(1) } }, { phoneId: phone, wabaId: account, appId }), "UNKNOWN");
  assert.equal(metaSignupHealth({ health_status: { can_send_message: "AVAILABLE", entities } }, { phoneId: phone, wabaId: account, appId }), "UNKNOWN");
  assert.equal(metaSignupHealth({ health_status: { can_send_message: "LIMITED", entities: entities.map(({entity_type,id}) => ({entity_type,id})) } }, { phoneId: phone, wabaId: account, appId }), "UNKNOWN");
});

test("attempt secret ownership does not authorize another tenant, attempt, or connection", () => {
  const owner = { kind: "meta-signup", tenantId: "tenant-a", attemptId: "attempt-a" };
  assert.equal(isOwnedSecretReference("secret://tenant-a/meta-signup/attempt-a", owner), true);
  for (const ref of ["secret://tenant-b/meta-signup/attempt-a", "secret://tenant-a/meta-signup/attempt-b", "secret://tenant-a/connections/attempt-a/meta"]) assert.equal(isOwnedSecretReference(ref, owner), false);
});

async function withFetch(fetcher, action) { const previous = globalThis.fetch; globalThis.fetch = fetcher; try { return await action(); } finally { globalThis.fetch = previous; } }
function provider({ fallback = false, owner = business, owned = true, status = "PENDING", coexistence = false, variantUnsupported = false } = {}) {
  const paths = [];
  return { paths, fetcher: async (input, init) => {
    const url = new URL(input); paths.push(url.pathname);
    assert.equal(url.origin, "https://graph.facebook.com");
    if (url.pathname === "/v24.0/debug_token") return Response.json({ data: { ...metadata, ...(fallback ? { granular_scopes: [] } : {}) } });
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    if (url.pathname.endsWith("/assigned_whatsapp_business_accounts")) { assert.equal(url.pathname, "/v24.0/444444444/assigned_whatsapp_business_accounts"); return Response.json({ data: [{ id: account }] }); }
    if (url.pathname === `/v24.0/${account}`) return Response.json({ id: account, name: "Customer account", owner_business: owner ? { id: owner, name: "Customer business" } : undefined });
    if (url.pathname.endsWith("/owned_whatsapp_business_accounts")) return Response.json({ data: owned ? [{ id: account }] : [] });
    if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ ...standard, status, display_phone_number: "12025550136" }] });
    if (url.pathname === `/v24.0/${phone}`) return variantUnsupported ? Response.json({ error: { code: 100 } }, { status: 400 }) : Response.json({ id: phone, is_on_biz_app: coexistence, platform_type: "CLOUD_API" });
    assert.fail(`unexpected request ${url.pathname}`);
  } };
}

for (const mode of [true, false]) test(`Business app variant admits only registered coexistence; provider mode=${mode}`, async () => {
  const mock = provider({ coexistence: mode, status: "CONNECTED" });
  const result = await withFetch(mock.fetcher, () => new MetaSignupClient({ ...config, variant: "BUSINESS_APP" }, token).discover("synthetic-app-secret-value"));
  assert.equal(result.choices[0].selectable, mode);
  assert.equal(mock.paths.some(path => path.endsWith("/register")), false);
  assert.equal(result.choices[0].lastOnboardedTime, undefined, "unsupported optional timestamp never invents a clock");
});

for (const fallback of [false, true]) test(`discovery proves owner to owned-list to phone using one customer credential; fallback=${fallback}`, async () => {
  const mock = provider({ fallback });
  const result = await withFetch(mock.fetcher, () => new MetaSignupClient(config, token).discover("synthetic-app-secret-value"));
  assert.equal(result.choices.length, 1); assert.equal(result.choices[0].selectable, true);
  assert.equal(result.choices[0].businessId, business); assert.equal(result.choices[0].wabaId, account);
  assert.match(result.choices[0].choiceId, /^[a-f0-9-]{36}$/);
  assert.equal(mock.paths.some(path => path.endsWith("/client_whatsapp_business_accounts")), false);
});

for (const options of [{ owner: null }, { owned: false }]) test(`unproved ownership cannot yield a selectable number: ${JSON.stringify(options)}`, async () => {
  const mock = provider(options); await assert.rejects(() => withFetch(mock.fetcher, () => new MetaSignupClient(config, token).discover("synthetic-app-secret-value")));
});
for (const [options, reason] of [[{ status: "CONNECTED" }, "META_SIGNUP_EXISTING_NUMBER_REVIEW"], [{ coexistence: true }, "META_SIGNUP_COEXISTENCE_REQUIRED"], [{ variantUnsupported: true }, "META_SIGNUP_MODE_UNKNOWN"]]) {
  test(`existing/coexistence/missing capability remains an explicit hold: ${reason}`, async () => {
    const mock = provider(options); const result = await withFetch(mock.fetcher, () => new MetaSignupClient(config, token).discover("synthetic-app-secret-value"));
    assert.equal(result.choices[0].selectable, false); assert.equal(result.choices[0].reasonCode, reason);
  });
}

test("GET code exchange is a single mutation and transport errors cannot leak its URL or invite replay", async () => {
  let calls = 0;
  await withFetch(async input => { calls++; throw new Error(`transport ${input}`); }, async () => {
    await assert.rejects(() => new MetaSignupClient(config).exchange("one-use-code", "synthetic-app-secret-value"), error => {
      assert.equal(error.outcomeKnown, false); assert.doesNotMatch(String(error), /one-use-code|synthetic|access_token/); return true;
    });
  });
  assert.equal(calls, 1);
});

test("discovery never follows bearer-bearing provider pagination URLs", async () => {
  const mock = provider(); let pages = 0;
  const result = await withFetch(async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/owned_whatsapp_business_accounts")) {
      assert.equal(url.origin, "https://graph.facebook.com"); pages++;
      if (pages === 1) return Response.json({ data: [{ id: "999999999" }], paging: { next: "https://attacker.invalid", cursors: { after: "next_2=" } } });
      assert.equal(url.searchParams.get("after"), "next_2="); return Response.json({ data: [{ id: account }] });
    }
    return mock.fetcher(input, init);
  }, () => new MetaSignupClient(config, token).discover("synthetic-app-secret-value"));
  assert.equal(result.choices.length, 1); assert.equal(pages, 2);
});


test("registration PIN remains purpose-owned and never leaks through token-only resolution", async () => {
  const previousUrl=process.env.SECRET_SIDECAR_URL,previousToken=process.env.SECRET_SIDECAR_TOKEN;
  process.env.SECRET_SIDECAR_URL='https://sidecar.example.invalid';process.env.SECRET_SIDECAR_TOKEN='synthetic-sidecar';
  const service=new MetaCredentialService();const worker=new SidecarSecretResolver('https://sidecar.example.invalid','synthetic-sidecar');
  const owner={tenantId:'tenant-a',connectionId:'connection-a'},reference='secret://tenant-a/connections/connection-a/meta';
  try {
    await withFetch(async()=>Response.json({accessToken:token,registrationPin:'234567'}),async()=>{
      assert.equal(await service.resolveAccessToken(reference,owner),token);
      assert.deepEqual(await service.resolveSignupConnection(reference,owner),{accessToken:token,registrationPin:'234567'});
      assert.deepEqual(await worker.resolve(reference,{kind:'meta-connection',...owner}),{accessToken:token,registrationPin:'234567'});
      await assert.rejects(()=>service.resolveSignupToken('secret://tenant-a/meta-signup/attempt-a',{tenantId:'tenant-a',attemptId:'attempt-a'}));
      await assert.rejects(()=>worker.resolve('secret://tenant-a/meta-signup/attempt-a',{kind:'meta-signup',tenantId:'tenant-a',attemptId:'attempt-a'}));
    });
    await withFetch(async()=>Response.json({accessToken:token,registrationPin:'12345'}),async()=>{
      await assert.rejects(()=>service.resolveSignupConnection(reference,owner));
      await assert.rejects(()=>worker.resolve(reference,{kind:'meta-connection',...owner}));
    });
    await withFetch(async()=>new Response(null,{status:404}),async()=>{
      assert.equal(await service.inspectSignupConnection(reference,owner),undefined);
      await assert.rejects(()=>service.resolveSignupConnection(reference,owner));
    });
    for(const status of [401,403,429,500]) await withFetch(async()=>new Response(null,{status}),async()=>{
      await assert.rejects(()=>service.inspectSignupConnection(reference,owner));
    });
  } finally {service.onModuleDestroy();if(previousUrl===undefined)delete process.env.SECRET_SIDECAR_URL;else process.env.SECRET_SIDECAR_URL=previousUrl;if(previousToken===undefined)delete process.env.SECRET_SIDECAR_TOKEN;else process.env.SECRET_SIDECAR_TOKEN=previousToken;}
});
