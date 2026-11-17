// Checks the synthetic harness itself, not native/backend correctness.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, memberId, syntheticCredentials } from "./helpers/admin-bridge-fixture.mjs";
const operation = () => crypto.randomUUID();
test("fixture keeps grants tenant-team scoped and inherited access distinct", () => {
  const fixture = adminFixture();
  const before = fixture.execute("TEAM_SHOW", { team_id: "2" }).members[0];
  assert.deepEqual(before.direct_access, []); assert.deepEqual(before.effective_access, ["read"]);
  fixture.execute("TEAM_GRANT_SAVE", { operation_id: operation(), team_id: "2", member_id: memberId, expected_version: before.version, access: ["create"] });
  assert.deepEqual(fixture.execute("TEAM_SHOW", { team_id: "2" }).members[0].direct_access, ["create"]);
  assert.deepEqual(fixture.execute("TEAM_SHOW", { team_id: "3" }).members[0].direct_access, []);
});
test("fixture models applied response loss idempotently and absent cancellation without applying the delayed original", () => {
  const fixture = adminFixture(), id = operation(), input = { operation_id: id, name: "Synthetic team", note: "Private fixture draft" };
  const saved = fixture.execute("TEAM_CREATE", input);
  assert.deepEqual(fixture.execute("TEAM_CREATE", input), saved); assert.equal(fixture.writes.length, 1);
  const absent = operation(); assert.equal(fixture.execute("TEAM_RECEIPT", { operation_id: absent, cancel_if_missing: false }).state, "UNKNOWN");
  assert.equal(fixture.execute("TEAM_RECEIPT", { operation_id: absent, cancel_if_missing: true }).state, "CANCELLED");
  assert.equal(fixture.execute("TEAM_CREATE", { ...input, operation_id: absent }).state, "CANCELLED"); assert.equal(fixture.writes.length, 1);
});
test("fixture gates activation on setup plus exact verified version and invalidates verification after save", () => {
  const fixture = adminFixture(), row = fixture.mailboxes[0];
  assert.throws(() => fixture.execute("MAILBOX_ACTIVATE", { operation_id: operation(), mailbox_id: row.id, expected_version: row.version }));
  fixture.execute("MAILBOX_VERIFY_START", { operation_id: operation(), mailbox_id: row.id, expected_version: row.version });
  fixture.execute("MAILBOX_VERIFY_STATUS", { mailbox_id: row.id, operation_id: row.verification_operation_id });
  fixture.control.setupReady = false;
  assert.throws(() => fixture.execute("MAILBOX_ACTIVATE", { operation_id: operation(), mailbox_id: row.id, expected_version: row.version }));
  fixture.control.setupReady = true;
  fixture.execute("MAILBOX_ACTIVATE", { operation_id: operation(), mailbox_id: row.id, expected_version: row.version });
  fixture.execute("MAILBOX_PAUSE", { operation_id: operation(), mailbox_id: row.id, expected_version: row.version });
  fixture.execute("MAILBOX_SAVE", { operation_id: operation(), mailbox_id: row.id, expected_version: row.version, config: { ...row.config, name: "Edited" }, credentials: {} });
  assert.equal(row.verification, "NOT_VERIFIED"); assert.equal(row.verification_version, null);
});
test("fixture does not retain credential text in returned rows, receipts or evidence", () => {
  const fixture = adminFixture(), config = structuredClone(fixture.mailboxes[0].config);
  fixture.execute("MAILBOX_CREATE", { operation_id: operation(), config, credentials: syntheticCredentials });
  const visible = JSON.stringify({ rows: fixture.mailboxes, receipts: [...fixture.receipts], evidence: fixture.writes });
  for (const value of Object.values(syntheticCredentials)) assert.ok(!visible.includes(value));
});
