import assert from "node:assert/strict";
import test from "node:test";
import { launchMetaSignup, loadMetaSignupSdk } from "../lib/meta-signup-sdk.ts";

const configuration = { appId: "123456", configId: "654321", graphVersion: "v24.0" };

test("Meta login opens synchronously with code-only options and admits one invocation callback", () => {
  let callback;
  let current = true;
  const received = [];
  launchMetaSignup({ login: (handler, options) => {
    callback = handler;
    assert.deepEqual(options, { config_id: "654321", response_type: "code", override_default_response_type: true, extras: { setup: {} } });
  } }, configuration, () => current, code => received.push(code));
  assert.equal(typeof callback, "function", "popup launch must not await a request");
  callback({ authResponse: { code: "short-lived-code", accessToken: "ignored" }, waba_id: "untrusted" });
  callback({ authResponse: { code: "another-code" } });
  current = false;
  assert.deepEqual(received, ["short-lived-code"]);
});

test("dismissed or replaced invocation cannot submit a late code", () => {
  let callback;
  let current = true;
  const received = [];
  launchMetaSignup({ login: handler => { callback = handler; } }, configuration, () => current, code => received.push(code));
  current = false;
  callback({ authResponse: { code: "late-code" } });
  assert.deepEqual(received, []);
});

test("cancelled, malformed and oversized SDK responses never submit credentials or reported assets", () => {
  for (const response of [null, {}, { status: "unknown" }, { authResponse: { accessToken: "not-a-code" } },
    { authResponse: { code: "x".repeat(4097) } }, { authResponse: { code: 42 } }]) {
    const received = [];
    launchMetaSignup({ login: handler => handler(response) }, configuration, () => true, code => received.push(code));
    assert.deepEqual(received, [null]);
  }
});

test("SDK uses one exact script and app/version initialization, with no analytics or automatic login status", async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const initialized = [];
  const scripts = [];
  const sdk = { init: value => initialized.push(value), login() {} };
  globalThis.window = { FB: sdk };
  globalThis.document = { createElement: () => ({ remove() {} }), head: { appendChild(script) { scripts.push(script); queueMicrotask(() => script.onload()); } } };
  try {
    const first = loadMetaSignupSdk(configuration);
    const second = loadMetaSignupSdk(configuration);
    assert.equal(first, second);
    assert.equal(await first, sdk);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].src, "https://connect.facebook.net/en_US/sdk.js");
    assert.equal(scripts[0].crossOrigin, "anonymous");
    assert.deepEqual(initialized, [{ appId: "123456", version: "v24.0", cookie: false, xfbml: false, autoLogAppEvents: false }]);
    await assert.rejects(loadMetaSignupSdk({ ...configuration, appId: "111111" }), /CONFIGURATION_CHANGED/u);
    await assert.rejects(loadMetaSignupSdk({ ...configuration, appId: "https://elsewhere.example" }), /CONFIGURATION/u);
  } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

function withMessageWindow(action) {
  const before = globalThis.window;
  const listeners = new Set();
  const host = { addEventListener(type, handler) { assert.equal(type, "message"); listeners.add(handler); },
    removeEventListener(type, handler) { assert.equal(type, "message"); listeners.delete(handler); } };
  host.window = host;
  globalThis.window = host;
  const popup = {}; popup.window = popup;
  try { action({ host, popup, listeners, emit: event => { for (const listener of [...listeners]) listener(event); } }); }
  finally { globalThis.window = before; }
}
const businessApp = { ...configuration, configId: "987654", variant: "BUSINESS_APP",
  extras: { featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3", setup: {} } };
const finish = { type: "WA_EMBEDDED_SIGNUP", version: 3, event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "123456" } };

test("Business app launches exact returned config and keeps advisory finish separate from code", () => withMessageWindow(({ popup, emit, listeners }) => {
  let callback;
  const events = [], codes = [];
  launchMetaSignup({ login(handler, options) { callback = handler; assert.deepEqual(options,
    { config_id: "987654", response_type: "code", override_default_response_type: true, extras: businessApp.extras }); } },
  businessApp, () => true, value => codes.push(value), value => events.push(value));
  emit({ origin: "https://www.facebook.com", source: popup, data: JSON.stringify(finish) });
  assert.deepEqual(events, [{ event: finish.event, sessionInfoVersion: "3", sourceOrigin: "https://www.facebook.com" }]);
  assert.deepEqual(codes, []); assert.equal(listeners.size, 0);
  callback({ authResponse: { code: "closure-code" } }); callback({ authResponse: { code: "duplicate-code" } });
  assert.deepEqual(codes, ["closure-code"]);
  assert.equal(JSON.stringify(events).includes("waba_id"), false);
}));

test("Business app ignores untrusted origin/source/version/schema/oversize diagnostics", () => withMessageWindow(({ host, popup, emit, listeners }) => {
  const events = [];
  const cleanup = launchMetaSignup({ login() {} }, businessApp, () => true, () => assert.fail("No callback expected"), value => events.push(value));
  const valid = { origin: "https://www.facebook.com", source: popup, data: finish };
  for (const override of [{ origin: "https://facebook.com.attacker.invalid" }, { source: null }, { source: host }, { source: {} },
    { data: "{" }, { data: "x".repeat(8193) }, { data: { ...finish, version: "3" } }, { data: { ...finish, version: undefined } },
    { data: { ...finish, event: "FINISH" } }, { data: { ...finish, data: { waba_id: "not-a-provider-id" } } },
    { data: { ...finish, data: [] } }, { data: { ...finish, data: { waba_id: "123456", current_step: {} } } }]) emit({ ...valid, ...override });
  assert.deepEqual(events, []); assert.equal(listeners.size, 1); cleanup(); assert.equal(listeners.size, 0);
}));

test("popup diagnostic collection ends on callback, explicit cleanup, stale invocation and launch throw", () => {
  for (const terminal of ["callback", "cleanup", "stale", "throw"]) withMessageWindow(({ popup, emit, listeners }) => {
    let callback, current = true; const events = [], codes = [];
    const invoke = () => launchMetaSignup({ login(handler) { callback = handler; if (terminal === "throw") throw new Error("popup unavailable"); } },
      businessApp, () => current, value => codes.push(value), value => events.push(value));
    if (terminal === "throw") { assert.throws(invoke, /popup unavailable/); assert.equal(listeners.size, 0); return; }
    const cleanup = invoke();
    if (terminal === "callback") callback({ authResponse: { code: "closure-code" } });
    else if (terminal === "cleanup") { current = false; cleanup(); }
    else current = false;
    emit({ origin: "https://www.facebook.com", source: popup, data: finish });
    callback({ authResponse: { code: "late-code" } });
    assert.deepEqual(events, []); assert.deepEqual(codes, terminal === "callback" ? ["closure-code"] : []);
    cleanup(); assert.equal(listeners.size, 0);
  });
});

test("Business app cancel/error diagnostics discard private payload and never cancel the code callback", () => {
  for (const event of ["CANCEL", "ERROR"]) withMessageWindow(({ popup, emit }) => {
    let callback; const events = [], codes = [];
    launchMetaSignup({ login(handler) { callback = handler; } }, businessApp, () => true, value => codes.push(value), value => events.push(value));
    emit({ origin: "https://web.facebook.com", source: popup, data: { type: "WA_EMBEDDED_SIGNUP", version: 3, event,
      data: { current_step: "permission", error_message: "PRIVATE_ERROR", session_id: "PRIVATE_SESSION", error_code: 42 } } });
    assert.deepEqual(events, [{ event, sessionInfoVersion: "3", sourceOrigin: "https://web.facebook.com" }]);
    assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
    callback({ authResponse: { code: "independent-closure" } }); assert.deepEqual(codes, ["independent-closure"]);
  });
});

test("a Business app setup cannot silently fall back to standard SDK extras", () => {
  for (const extras of [undefined, { setup: {} }, { ...businessApp.extras, sessionInfoVersion: "4" }, { ...businessApp.extras, setup: { phone: "untrusted" } }]) {
    assert.throws(() => launchMetaSignup({ login() { assert.fail("Invalid setup must not launch"); } }, { ...businessApp, extras }, () => true, () => {}), /META_SIGNUP_CONFIGURATION/);
  }
});

test("optional diagnostic callback failure never blocks the independent code callback", () => withMessageWindow(({ popup, emit, listeners }) => {
  let callback; const codes = [];
  launchMetaSignup({ login(handler) { callback = handler; } }, businessApp, () => true, value => codes.push(value),
    () => { throw new Error("Unavailable optional diagnostic"); });
  assert.doesNotThrow(() => emit({ origin: "https://www.facebook.com", source: popup, data: finish }));
  assert.equal(listeners.size, 0);
  callback({ authResponse: { code: "independent-code" } });
  assert.deepEqual(codes, ["independent-code"]);
}));
