import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the source callbacks with controlled request/storage boundaries; browser qualification is separate.
function source(name) {
  const text = readFileSync(new URL(`../app/${name}.tsx`, import.meta.url), "utf8");
  return ts.createSourceFile(`${name}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const sources = new Map(["SupportTeams", "MailboxSettings"].map(name => [name, source(name)]));
function declaration(name, variable) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === variable) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(sources.get(name));
  assert.ok(found, `${name}.${variable}`);
  return found;
}
function callback(name, variable, bindings) {
  const value = declaration(name, variable);
  const expression = ts.isCallExpression(value) && value.expression.getText() === "useCallback" ? value.arguments[0] : value;
  const text = ts.transpileModule(`const target = ${expression.getText()};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${text}; return target;`)(...Object.values(bindings));
}
function parser(name) {
  const parsed = sources.get(name);
  const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && /^(recoveryIntent|isIntent|parseTeamRecovery|parseMailboxRecovery)$/u.test(node.name?.text ?? "") || ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText() === "UUID"));
  const text = ts.transpileModule(declarations.map(node => node.getText().replace(/^export /u, "")).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${text}; return ${name === "SupportTeams" ? "parseTeamRecovery" : "parseMailboxRecovery"};`)();
}
const operationId = "10000000-0000-4000-8000-000000000001";
const memberId = "20000000-0000-4000-8000-000000000001";
const teamIntents = [
  { operation_id: operationId, kind: "TEAM_CREATE" },
  { operation_id: operationId, kind: "TEAM_SAVE", team_id: "2" },
  { operation_id: operationId, kind: "TEAM_GRANT_SAVE", team_id: "2", member_id: memberId },
];
const mailboxIntents = [
  { operation_id: operationId, kind: "MAILBOX_CREATE" },
  ...["SAVE", "VERIFY_START", "VERIFY_RECHECK", "ACTIVATE", "PAUSE"].map(kind => ({ operation_id: operationId, kind: `MAILBOX_${kind}`, mailbox_id: "4" })),
  { operation_id: operationId, kind: "MAILBOX_SIGNATURE_SAVE", team_id: "2" },
];

test("recovery accepts only bounded, exact operation identifiers", () => {
  for (const [name, intents] of [["SupportTeams", teamIntents], ["MailboxSettings", mailboxIntents]]) {
    const parse = parser(name);
    assert.equal(parse(null), null);
    for (const intent of intents) {
      assert.deepEqual(parse(JSON.stringify(intent)), intent);
      for (const invalid of [{ ...intent, credentials: "must-not-persist" }, { ...intent, operation_id: "bad" }, { ...intent, kind: "DELETE_EVERYTHING" }]) assert.throws(() => parse(JSON.stringify(invalid)));
    }
    for (const raw of ["", "null", "[]", "true", "{}", "{" , " ".repeat(1025)]) assert.throws(() => parse(raw));
    for (const invalid of [{ ...intents[1], [name === "SupportTeams" ? "team_id" : "mailbox_id"]: "0" }, { ...intents[1], [name === "SupportTeams" ? "team_id" : "mailbox_id"]: "90000000000000000" }]) assert.throws(() => parse(JSON.stringify(invalid)));
  }
});

function boundary(name) {
  const lifecycle = { current: { mounted: true, generation: 0 } };
  const live = callback(name, "live", { lifecycle });
  return { lifecycle, live };
}
test("responses and failures from an old lifetime cannot enter current UI state", async () => {
  for (const name of sources.keys()) {
    for (const end of ["revoke", "unmount"]) {
      const { lifecycle, live } = boundary(name);
      let resolve;
      const request = callback(name, "request", { execute: () => new Promise(done => { resolve = done; }), live, lifecycle });
      const result = request("LIST", {});
      if (end === "revoke") lifecycle.current.generation++; else lifecycle.current.mounted = false;
      resolve({ private: "old" });
      await assert.rejects(result, error => error.name === "AbortError");
    }
    const { lifecycle, live } = boundary(name);
    const value = { items: [] };
    const request = callback(name, "request", { execute: async () => value, live, lifecycle });
    assert.equal(await request("LIST", {}), value);
  }
});

function failureFixture(name) {
  const { lifecycle, live } = boundary(name), calls = [];
  const bindings = { lifecycle, live, t: value => value, inFlight: { current: true }, active: { current: true } };
  if (name === "MailboxSettings") bindings.empty = callback(name, "empty", {});
  const counter = { current: { invalidate() { calls.push(["invalidate"]); } } };
  for (const ref of ["fence", "listFence", "selectionFence"]) bindings[ref] = counter;
  for (const setter of new Set(declaration(name, "failure").getText().match(/\bset[A-Z]\w+/gu))) bindings[setter] = value => calls.push([setter, value]);
  return { ...bindings, calls, effects: calls, failure: callback(name, "failure", bindings) };
}
test("transient checks and privileged step-up preserve drafts; real denial clears private state and releases busy", () => {
  for (const name of sources.keys()) {
    for (const cause of [Object.assign(new Error(), { status: 503 }), Object.assign(new Error(), { status: 403, code: "REAUTHENTICATION_REQUIRED" })]) {
      const fixture = failureFixture(name);
      fixture.failure(cause);
      assert.equal(fixture.lifecycle.current.generation, 0);
      assert.ok(fixture.calls.every(([setter]) => ["setError", "setReauthenticate"].includes(setter)));
      if (cause.code) assert.ok(fixture.calls.some(([setter, value]) => setter === "setReauthenticate" && value));
    }
    const fixture = failureFixture(name);
    fixture.failure(Object.assign(new Error(), { status: 403, code: "FORBIDDEN" }));
    assert.equal(fixture.lifecycle.current.generation, 1);
    assert.ok(fixture.calls.some(([setter, value]) => setter === "setBusy" && value === false));
    assert.ok(fixture.calls.some(([setter]) => setter === (name === "SupportTeams" ? "setDraft" : "setPasswords")));
    fixture.calls.length = 0;
    fixture.lifecycle.current.mounted = false;
    fixture.failure(Object.assign(new Error(), { status: 401 }));
    assert.deepEqual(fixture.calls, []);
  }
});

test("hydration and corrupt receipts block both write entry points", async () => {
  for (const name of sources.keys()) {
    for (const state of [{ recoveryReady: false, recoveryCorrupt: false }, { recoveryReady: true, recoveryCorrupt: true }]) {
      const blocked = callback(name, name === "SupportTeams" ? "blocked" : "disabled", { busy: false, pending: null, denied: false, ...state });
      assert.equal(blocked, true);
      const fixture = failureFixture(name);
      const mutate = callback(name, "mutate", { ...fixture, inFlight: { current: false }, active: { current: false }, blocked, disabled: blocked });
      assert.equal(mutate.constructor.name, "AsyncFunction");
      // Any accidental storage or execute access rejects because those boundaries are deliberately absent.
      await mutate(name === "SupportTeams" ? "TEAM_CREATE" : "MAILBOX_CREATE", {});
    }
  }
});

function mutationFixture(name, request, load = async () => undefined) {
  const fixture = failureFixture(name), calls = [];
  fixture.inFlight.current = false; fixture.active.current = false;
  const bindings = { ...fixture, detail: null, selected: null, pending: null, blocked: false, disabled: false, request, load,
    storageKey: "synthetic-recovery", sessionStorage: { setItem: (...args) => calls.push(["persist", ...args]), removeItem: (...args) => calls.push(["remove", ...args]) },
    setPending: value => calls.push(["pending", value]), setBusy: value => calls.push(["busy", value]), setError: value => calls.push(["error", value]),
    setNotice: value => calls.push(["notice", value]), setMessage: value => calls.push(["notice", value]), setPasswords: value => calls.push(["passwords", value]),
  };
  if (name === "SupportTeams") bindings.finish = callback(name, "finish", bindings);
  return { ...fixture, calls, mutate: callback(name, "mutate", bindings) };
}
test("a confirmed save remains known when its follow-up read fails", async () => {
  for (const name of sources.keys()) {
    const fixture = mutationFixture(name, async () => ({ state: "APPLIED" }), async () => { throw Object.assign(new Error(), { status: 503 }); });
    await fixture.mutate(name === "SupportTeams" ? "TEAM_CREATE" : "MAILBOX_CREATE", {});
    const prefix = name === "SupportTeams" ? "teamsAdmin" : "mailboxes";
    assert.ok(fixture.calls.some(([kind, value]) => kind === "notice" && value === `${prefix}.saved`));
    assert.ok(fixture.calls.some(([kind]) => kind === "remove"));
    assert.ok(!fixture.calls.some(([kind, value]) => kind === "error" && value === `${prefix}.unknown`));
    assert.ok(fixture.calls.some(([kind, value]) => kind === "busy" && value === false));
  }
});
test("denial while a write is pending cannot restore old data or discard its recovery record", async () => {
  for (const name of sources.keys()) {
    let resolve;
    const fixture = mutationFixture(name, () => new Promise(done => { resolve = done; }));
    const pending = fixture.mutate(name === "SupportTeams" ? "TEAM_CREATE" : "MAILBOX_CREATE", {});
    fixture.failure(Object.assign(new Error(), { status: 403, code: "FORBIDDEN" }));
    resolve({ state: "APPLIED", team_id: "2", mailbox_id: "4" });
    await pending;
    assert.ok(fixture.calls.some(([kind]) => kind === "persist"));
    assert.ok(!fixture.calls.some(([kind]) => kind === "remove"));
    assert.ok(!fixture.calls.some(([kind, value]) => kind === "notice" && value?.endsWith(".saved")));
  }
});
test("privileged write rejection preserves in-memory credential draft and offers step-up", async () => {
  const fixture = mutationFixture("MailboxSettings", async () => { throw Object.assign(new Error(), { status: 403, code: "REAUTHENTICATION_REQUIRED" }); });
  await fixture.mutate("MAILBOX_CREATE", {});
  assert.ok(!fixture.calls.some(([kind]) => kind === "passwords"));
  assert.ok(fixture.calls.some(([kind, value]) => kind === "busy" && value === false));
  assert.equal(fixture.lifecycle.current.generation, 0);
  assert.ok(fixture.effects.some(([kind, value]) => kind === "setReauthenticate" && value));
});

test("unknown mailbox submission clears write-only fields while retaining its recovery fence", async () => {
  let submitted;
  const input = { credentials: { inbound: "SyntheticPrivateInput", outbound: "SyntheticPrivateInput" } };
  const fixture = mutationFixture("MailboxSettings", async (_kind, value) => { submitted = value; throw new Error("lost response"); });
  await fixture.mutate("MAILBOX_CREATE", input);
  assert.deepEqual(submitted.credentials, input.credentials);
  assert.ok(fixture.calls.some(([kind, value]) => kind === "passwords" && value.inbound === "" && value.outbound === ""));
  assert.ok(fixture.calls.some(([kind, value]) => kind === "error" && value === "mailboxes.unknown"));
  assert.ok(!fixture.calls.some(([kind]) => kind === "remove"));
  const persisted = fixture.calls.find(([kind]) => kind === "persist");
  assert.ok(persisted);
  assert.equal(JSON.stringify(persisted).includes("SyntheticPrivateInput"), false);
});

test("mailbox reconciliation keeps nonterminal receipts instead of treating them as cancellation", async () => {
  const fixture = failureFixture("MailboxSettings");
  fixture.active.current = false;
  const pending = mailboxIntents[1], calls = [];
  const bindings = { ...fixture, pending, recoveryReady: true, recoveryCorrupt: false, denied: false,
    request: async () => ({ state: "UNRECOGNIZED" }), setBusy: value => calls.push(["busy", value]), setError: value => calls.push(["error", value]), t: value => value };
  await callback("MailboxSettings", "reconcile", bindings)(false);
  assert.ok(calls.some(([kind, value]) => kind === "error" && value === "mailboxes.unknown"));
  assert.ok(calls.some(([kind, value]) => kind === "busy" && value === false));
});


test("support-team refresh recovers an initial list failure without disturbing drafts or receipts", async () => {
  const defaults = { error: "teamsAdmin.failed", selected: null, busy: false, pending: null, recoveryReady: true, recoveryCorrupt: false };
  async function run(overrides = {}, settle = () => undefined) {
    const { lifecycle, live } = boundary("SupportTeams"), calls = [];
    const bindings = { ...defaults, ...overrides, lifecycle, live,
      request: async (operation, input) => {
        calls.push(["request", operation, input]); await settle(lifecycle);
        return { items: [{ id: "2" }], next_cursor: null };
      },
      listFence: { current: { begin: () => 1, isCurrent: () => true } },
      setTeams: update => calls.push(["teams", update([])]),
      setCursor: value => calls.push(["cursor", value]),
      setDenied: value => calls.push(["denied", value]),
      setError: value => calls.push(["error", value]),
      failure: cause => calls.push(["failure", cause]),
    };
    bindings.load = callback("SupportTeams", "load", bindings);
    await callback("SupportTeams", "refresh", bindings)(new AbortController().signal);
    return calls;
  }
  assert.deepEqual(await run(), [
    ["request", "TEAM_LIST", { limit: 50 }], ["teams", [{ id: "2" }]],
    ["cursor", null], ["denied", false], ["error", null],
  ]);
  for (const state of [{ error: null }, { selected: "new" }, { selected: "2" }, { busy: true }, { pending: teamIntents[0] }, { recoveryReady: false }, { recoveryCorrupt: true }]) {
    assert.deepEqual(await run(state), [["request", "TEAM_LIST", { limit: 1 }]]);
  }
  const stale = await run({}, lifecycle => { lifecycle.current.generation++; });
  assert.deepEqual(stale, [["request", "TEAM_LIST", { limit: 50 }]]);
});
