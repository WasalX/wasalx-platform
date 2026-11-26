// Synthetic UI bridge only. No native, network verification, SMTP, IMAP or provider calls.
import assert from "node:assert/strict";
const clone = value => structuredClone(value);
export const memberId = "10000000-0000-4000-8000-000000000001";
export const observerId = "10000000-0000-4000-8000-000000000002";
export const syntheticCredentials = { inbound: "SYNTHETIC-INBOUND-ONLY", outbound: "SYNTHETIC-OUTBOUND-ONLY" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function adminFixture() {
  const teams = [
    { id: "2", name: "Synthetic customer support", note: "Support requests", active: true, version: "1" },
    { id: "3", name: "Synthetic accounts", note: "Billing requests", active: true, version: "1" },
    { id: "9", name: "Synthetic escalation", note: "Escalated requests", active: true, version: "1" },
  ];
  const members = [{ id: memberId, name: "Synthetic agent", email: "agent@example.invalid", version: "1", direct_access: [], effective_access: ["read"], editable: true },
    { id: observerId, name: "Synthetic inherited observer", email: "observer@example.invalid", version: "1", direct_access: [], effective_access: ["read"], editable: false }];
  const rosters = new Map(teams.map(team => [team.id, clone(members)]));
  const config = { email: "support@example.invalid", name: "Synthetic support mailbox", team_id: "99",
    inbound: { host: "imap.example.invalid", port: 993, user: "support@example.invalid", folder: "INBOX", security: "TLS" },
    outbound: { host: "smtp.example.invalid", port: 587, user: "support@example.invalid", security: "STARTTLS" } };
  const mailbox = (id, address) => ({ id, config: { ...clone(config), email: address }, version: "1", active: false, editable: true, team_name: "Synthetic historical support",
    inbound_credential_configured: true, outbound_credential_configured: true, verification: "NOT_VERIFIED", verification_operation_id: null, verification_version: null });
  const mailboxes = [mailbox("11", "support@example.invalid"), mailbox("12", "billing@example.invalid"), mailbox("13", "archive@example.invalid")];
  const receipts = new Map(), signatures = new Map();
  const control = { denied: false, setupReady: true, canCreate: true, loseCommit: null, reject: null, failRead: null, reauth: null, verification: "VERIFIED", gate: null };
  const writes = [], reads = [];
  const error = (status, code = "FORBIDDEN") => Object.assign(new Error("Synthetic fixture policy rejection"), { status, code });
  const teamDetail = (team, after) => ({ ...team, can_manage: true, can_grant: true,
    members: clone(after ? rosters.get(team.id).slice(1) : rosters.get(team.id).slice(0, 1)), members_next_cursor: after ? null : memberId });
  const currentSignature = team => signatures.get(team) ?? { team_id: team, version: "1", body: "Synthetic legacy signature", requires_plain_replacement: true };
  const version = row => { row.version = String(Number(row.version) + 1); };
  const hold = (operation, matches = () => true) => {
    const entered = deferred(), released = deferred();
    control.gate = { operation, matches, entered, released };
    return { entered: entered.promise, release: () => released.resolve() };
  };
  const execute = (operation, input) => {
    if (control.denied) throw error(403);
    if (control.failRead === operation) { control.failRead = null; throw error(503, "TEMPORARY_UNAVAILABLE"); }
    if (control.reauth === operation) { control.reauth = null; throw error(403, "REAUTHENTICATION_REQUIRED"); }
    if (control.reject === operation) { control.reject = null; throw error(409, "CONFLICT"); }
    if (operation === "TEAM_LIST") { reads.push(operation); return { items: clone(input.before ? teams.slice(2) : teams.slice(0, input.limit === 1 ? 1 : 2)), next_cursor: input.before || input.limit === 1 || teams.length <= 2 ? null : "3" }; }
    if (operation === "TEAM_SHOW") { reads.push(operation); const team = teams.find(row => row.id === input.team_id); if (!team) throw error(404); return teamDetail(team, input.members_after); }
    if (operation === "MAILBOX_LIST") { reads.push(operation); return { items: clone(input.before ? mailboxes.slice(2) : mailboxes.slice(0, 2)), next_cursor: input.before ? null : "12", can_create: control.canCreate, mail_ready: control.setupReady }; }
    if (operation === "MAILBOX_SHOW") { reads.push(operation); const row = mailboxes.find(item => item.id === input.mailbox_id); if (!row) throw error(404); return clone(row); }
    if (operation === "MAILBOX_SIGNATURE_SHOW") { reads.push(operation); return clone(currentSignature(String(input.team_id))); }
    if (operation === "MAILBOX_VERIFY_STATUS") {
      reads.push(operation); const row = mailboxes.find(item => item.id === input.mailbox_id);
      assert.equal(input.operation_id, row.verification_operation_id);
      row.verification = control.verification; row.verification_version = row.verification === "VERIFIED" ? row.version : null;
      return clone(row);
    }
    if (operation.endsWith("_RECEIPT")) {
      reads.push(operation); const found = receipts.get(input.operation_id); if (found) return clone(found);
      if (!input.cancel_if_missing) return { state: "UNKNOWN" };
      const result = { state: "CANCELLED" }; receipts.set(input.operation_id, result); return result;
    }
    const previous = receipts.get(input.operation_id); if (previous) return clone(previous);
    let result;
    if (operation === "TEAM_CREATE") {
      const row = { id: String(20 + teams.length), name: input.name, note: input.note, active: true, version: "1" }; teams.push(row); rosters.set(row.id, clone(members)); result = { state: "APPLIED", team_id: row.id };
    } else if (operation === "TEAM_SAVE") {
      const row = teams.find(team => team.id === input.team_id); assert.equal(input.expected_version, row.version);
      Object.assign(row, { name: input.name, note: input.note, active: input.active }); version(row); result = { state: "APPLIED", team_id: row.id };
    } else if (operation === "TEAM_GRANT_SAVE") {
      const member = rosters.get(String(input.team_id)).find(item => item.id === input.member_id); assert.ok(member.editable); assert.equal(input.expected_version, member.version);
      member.direct_access = clone(input.access); member.effective_access = [...new Set(["read", ...input.access])]; version(member); result = { state: "APPLIED", team_id: input.team_id };
    } else if (operation === "MAILBOX_CREATE" || operation === "MAILBOX_SAVE") {
      assert.ok(!("password" in input.config.inbound) && !("password" in input.config.outbound));
      let row = mailboxes.find(item => item.id === input.mailbox_id);
      if (operation === "MAILBOX_CREATE") {
        assert.equal(input.credentials.inbound, syntheticCredentials.inbound); assert.equal(input.credentials.outbound, syntheticCredentials.outbound);
        row = mailbox(String(30 + mailboxes.length), input.config.email); row.inbound_credential_configured = false; row.outbound_credential_configured = false; mailboxes.push(row);
      }
      else { assert.equal(input.expected_version, row.version); assert.equal(row.active, false); version(row); }
      row.config = clone(input.config); row.verification = "NOT_VERIFIED"; row.verification_version = null; row.verification_operation_id = null;
      row.inbound_credential_configured ||= Boolean(input.credentials.inbound); row.outbound_credential_configured ||= Boolean(input.credentials.outbound);
      result = { state: "APPLIED", mailbox_id: row.id };
    } else if (operation === "MAILBOX_SIGNATURE_SAVE") {
      const current = currentSignature(String(input.team_id)); assert.equal(input.expected_version, current.version);
      assert.ok(!current.requires_plain_replacement || input.replace_formatting === true);
      signatures.set(String(input.team_id), { team_id: String(input.team_id), version: String(Number(current.version) + 1), body: input.body, requires_plain_replacement: false });
      result = { state: "APPLIED" };
    } else {
      const row = mailboxes.find(item => item.id === input.mailbox_id); if (!row) throw error(404);
      assert.equal(input.expected_version, row.version);
      if (operation === "MAILBOX_VERIFY_START" || operation === "MAILBOX_VERIFY_RECHECK") { row.verification = "RUNNING"; row.verification_operation_id = input.operation_id; row.verification_version = null; }
      else if (operation === "MAILBOX_ACTIVATE") { assert.ok(control.setupReady && row.verification === "VERIFIED" && row.verification_version === row.version); row.active = true; }
      else if (operation === "MAILBOX_PAUSE") row.active = false;
      else throw new Error(`Unrecognized synthetic operation: ${operation}`);
      result = { state: "APPLIED", mailbox_id: row.id };
    }
    // Evidence records retain operation and identifiers only, never config, credentials or signature text.
    writes.push({ operation, operation_id: input.operation_id, ...(result.team_id ? { team_id: result.team_id } : {}), ...(result.mailbox_id ? { mailbox_id: result.mailbox_id } : {}) });
    receipts.set(input.operation_id, clone(result)); return result;
  };
  const install = async page => {
    await page.route("**/api/inbox", async route => {
      const { operation, input } = route.request().postDataJSON();
      try {
        const result = execute(operation, input);
        const gate = control.gate;
        if (gate?.operation === operation && gate.matches(input)) { control.gate = null; gate.entered.resolve(); await gate.released.promise; }
        if (control.loseCommit === operation) { control.loseCommit = null; return route.abort("failed"); }
        await route.fulfill({ status: 200, json: clone(result) });
      } catch (failure) {
        if (!failure.status) throw failure;
        await route.fulfill({ status: failure.status, json: { code: failure.code, error: "SYNTHETIC_INTERNAL_FAILURE_MUST_NOT_RENDER" } });
      }
    });
  };
  return { teams, members, mailboxes, receipts, signatures, control, writes, reads, install, hold, execute };
}
