import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NativeAccountObservation } from "../lib/control-plane-data.ts";
import { nativeAccountObservationState, teamNativeAccountObservation } from "../lib/native-account-observation.ts";
import { createLatestRequestFence } from "../lib/operator-ui.ts";
import { formatDateTime } from "../lib/i18n/format.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";

const verified: NativeAccountObservation = { state: "VERIFIED", checkedAt: "2026-10-16T10:00:00Z", revision: 7, nativeUserId: "21" };

test("a persisted projection or incomplete readback never becomes a verified native account", () => {
  assert.equal(nativeAccountObservationState(undefined), "UNVERIFIED");
  assert.equal(nativeAccountObservationState(verified), "VERIFIED");
  for (const change of [{ checkedAt: null }, { checkedAt: "invalid" }, { revision: 0 }, { revision: 1.5 }, { nativeUserId: null }, { nativeUserId: "0" }, { nativeUserId: "9999999999999999" }]) {
    assert.equal(nativeAccountObservationState({ ...verified, ...change }), "UNVERIFIED");
  }
});

test("current native drift stays distinct from unavailable, unverified and stale observations", () => {
  for (const state of ["DRIFT", "UNAVAILABLE", "UNVERIFIED"] as const) assert.equal(nativeAccountObservationState({ ...verified, state }), state);
  assert.equal(nativeAccountObservationState(verified, { revision: 7, nativeUserId: "21" }), "VERIFIED");
  for (const expected of [{ revision: 8, nativeUserId: "21" }, { revision: 7, nativeUserId: "22" }, { revision: 7, nativeUserId: null }]) {
    assert.equal(nativeAccountObservationState(verified, expected), "UNVERIFIED");
    assert.equal(nativeAccountObservationState({ ...verified, state: "DRIFT" }, expected), "UNVERIFIED");
  }
});

test("a newer Workspace lifecycle cannot verify the older Team member snapshot", () => {
  const oldTeam = { state: "ACTIVE", nativeObservation: verified };
  const currentWorkspace = { member_state: "SUSPENDED", nativeObservation: { ...verified, revision: 8 } };
  assert.equal(nativeAccountObservationState(teamNativeAccountObservation(currentWorkspace.nativeObservation, oldTeam.nativeObservation)), "UNVERIFIED");
  assert.equal(oldTeam.state, "ACTIVE");
  const refreshedTeam = { state: "SUSPENDED", nativeObservation: currentWorkspace.nativeObservation };
  assert.equal(nativeAccountObservationState(teamNativeAccountObservation(currentWorkspace.nativeObservation, refreshedTeam.nativeObservation)), "VERIFIED");
  assert.equal(nativeAccountObservationState(teamNativeAccountObservation(verified, undefined)), "UNVERIFIED");
  assert.equal(nativeAccountObservationState(teamNativeAccountObservation(verified, { ...verified, state: "DRIFT" })), "UNVERIFIED");
  assert.equal(nativeAccountObservationState(teamNativeAccountObservation({ ...verified, nativeUserId: "22" }, verified)), "UNVERIFIED");
  for (const state of ["DRIFT", "UNAVAILABLE"] as const) {
    assert.equal(nativeAccountObservationState(teamNativeAccountObservation({ ...verified, state }, oldTeam.nativeObservation)), state);
  }
});

test("both panels keep the latest shared observation across interleaved Team and Workspace reads", async () => {
  const source = await readFile(new URL("../app/WasalXApp.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("WasalXApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const team = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "TeamAccess") as ts.FunctionDeclaration;
  const declarations = team.body!.statements.filter(node => ts.isVariableStatement(node) && /^(?:const \[nativeAccountRead|const nativeObservationFence|const beginNativeObservationRead|const completeNativeObservationRead)/u.test(node.getText(ast)));
  assert.equal(declarations.length, 4);
  const compiled = ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let snapshot: { observations: Record<string, NativeAccountObservation | undefined>; unavailable: boolean };
  const hooks = new Function("useState", "useRef", "useCallback", "createLatestRequestFence", `${compiled};return {begin:beginNativeObservationRead,complete:completeNativeObservationRead};`)(
    (initial: typeof snapshot) => { snapshot = initial; return [initial, (next: typeof snapshot) => { snapshot = next; }]; },
    (current: unknown) => ({ current }), (callback: unknown) => callback, createLatestRequestFence,
  );
  const oldTeam = hooks.begin();
  const newWorkspace = hooks.begin();
  hooks.complete(newWorkspace, [{ user_id: "member", nativeObservation: { ...verified, state: "DRIFT" } }]);
  hooks.complete(oldTeam, [{ user_id: "member", nativeObservation: verified }]);
  assert.equal(snapshot!.observations.member?.state, "DRIFT");
  hooks.complete(hooks.begin(), null);
  assert.equal(snapshot!.unavailable, true);
  assert.deepEqual(snapshot!.observations, {});
  hooks.complete(oldTeam, [{ user_id: "member", nativeObservation: verified }]);
  assert.equal(snapshot!.unavailable, true);
  hooks.complete(hooks.begin(), [{ user_id: "member" }]);
  assert.equal(snapshot!.unavailable, false);
  assert.equal(nativeAccountObservationState(snapshot!.observations.member), "UNVERIFIED");
});

test("both localized UI surfaces describe generic drift without inventing inactivity or a reconciliation action", async () => {
  const source = await readFile(new URL("../app/NativeAccountStatus.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("NativeAccountStatus.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "NativeAccountStatus")!;
  const compiled = ts.transpileModule(declaration.getText(ast).replace(/^export /u, ""), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
  for (const [locale, dictionary] of [["en", englishTenantMessages], ["ar", arabicTenantMessages]] as const) {
    const Component = new Function("useI18n", "React", "nativeAccountObservationState", "formatDateTime", `${compiled};return NativeAccountStatus;`)(
      () => ({ locale, t: createTranslator(dictionary) }), React, nativeAccountObservationState, formatDateTime,
    );
    const markup = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(Component, props));
    assert.match(markup({ observation: verified }), /data-native-observation="VERIFIED"/u);
    for (const props of [{}, { observation: { ...verified, state: "DRIFT" } }, { observation: verified, unavailable: true }]) {
      const html = markup(props);
      assert.doesNotMatch(html, /data-native-observation="VERIFIED"/u);
      assert.doesNotMatch(html, /<button|<form/iu);
    }
    assert.notEqual(dictionary["tenant.workspaceAccess.state.READY"], dictionary["tenant.workspaceAccess.observation.VERIFIED"]);
    assert.doesNotMatch(dictionary["tenant.workspaceAccess.observation.DRIFT"], /account is inactive|الحساب غير نشط/iu);
  }
});
