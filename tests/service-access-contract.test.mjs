import assert from "node:assert/strict";
import test from "node:test";
import { parseIdentityRecovery, identityTerminal } from "../lib/service-access-contract.ts";
const id = "10000000-0000-4000-8000-000000000001";
test("service recovery contains receipt identifiers only and requires exact kind-specific keys", () => {
  for (const kind of ["IDENTITY_INITIALIZE", "IDENTITY_PREPARE", "IDENTITY_BIND", "IDENTITY_COMPLETE"]) assert.deepEqual(parseIdentityRecovery(JSON.stringify({ kind, request_id: id })), { kind, request_id: id });
  assert.deepEqual(parseIdentityRecovery(JSON.stringify({ kind: "IDENTITY_GRANT", request_id: id, team_id: "2" })), { kind: "IDENTITY_GRANT", request_id: id, team_id: "2" });
  assert.equal(parseIdentityRecovery(null), null);
});
test("malformed or extra service identifiers fail closed without coercion", () => {
  for (const row of [[], {}, { kind: "IDENTITY_GRANT", request_id: id }, { kind: "IDENTITY_GRANT", request_id: id, team_id: 2 }, { kind: "IDENTITY_GRANT", request_id: id, team_id: "02" }, { kind: "IDENTITY_PREPARE", request_id: id, operation_id: id }, { kind: "IDENTITY_BIND", request_id: id, token: "never-store" }, { kind: "UNKNOWN", request_id: id }, { kind: "IDENTITY_PREPARE", request_id: {} }]) assert.throws(() => parseIdentityRecovery(JSON.stringify(row)));
  assert.throws(() => parseIdentityRecovery("{")); assert.throws(() => parseIdentityRecovery(" ".repeat(1025)));
});
test("only explicitly terminal applied or not-applied receipt releases unknown intent", () => {
  assert.equal(identityTerminal({ state: "APPLIED", terminal: true }), true);
  assert.equal(identityTerminal({ state: "NOT_APPLIED", terminal: true }), true);
  for (const row of [{ state: "UNKNOWN", terminal: true }, { state: "APPLIED", terminal: false }, { state: "NOT_APPLIED", terminal: false }, { state: "ADMITTED", terminal: true }, { state: "APPLIED", terminal: "true" }]) assert.equal(identityTerminal(row), false);
});
