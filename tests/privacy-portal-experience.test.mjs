import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";

const originalBackend = process.env.PORTAL_DATA_BACKEND;
const originalRole = process.env.PORTAL_FIXTURE_ROLE;
process.env.PORTAL_DATA_BACKEND = "fixture";
delete process.env.PORTAL_FIXTURE_ROLE;

const fixture = await import(`../lib/fixture-data.ts?privacy-portal=${Date.now()}`);
const portalSource = await readFile(new URL("../app/WasalXApp.tsx", import.meta.url), "utf8");
const privacySource = portalSource.slice(
  portalSource.indexOf("function PrivacySettings"),
  portalSource.indexOf("type TeamMember"),
);

test("privacy settings are role-aware, private-demo safe, and content-minimizing", () => {
  assert.match(portalSource, /tenant\.settings\.sections\.privacy/u);
  assert.match(portalSource, /role === "tenant_owner" \|\| role === "tenant_admin" \|\| role === "auditor"/);
  assert.match(privacySource, /tenant\.privacy\.demo\.noOperations/u);
  assert.match(privacySource, /tenant\.privacy\.demo\.noOperationsBody/u);
  assert.match(privacySource, /tenant\.privacy\.requestDialog\.irreversibleBody/u);
  assert.match(privacySource, /DELETE TENANT DATA/);
  assert.match(privacySource, /tenant\.privacy\.requestDialog\.exportLimitsBody/u);
  assert.equal(englishTenantMessages["tenant.settings.sections.privacy"], "Privacy & retention");
  assert.match(englishTenantMessages["tenant.privacy.demo.noOperationsBody"], /No live privacy records are loaded/u);
  assert.match(englishTenantMessages["tenant.privacy.requestDialog.irreversibleBody"], /recent sign-in within five minutes/iu);
  assert.match(englishTenantMessages["tenant.privacy.requestDialog.exportLimitsBody"], /signed link lasts no more than five minutes/iu);
  assert.doesNotMatch(privacySource, /message_body|object_key|secret_reference/);
});

test("fixture evidence redacts auditor scopes and exposes only bounded artifact metadata", async () => {
  const holds = await fixture.getPrivacyLegalHolds(false);
  const requests = await fixture.getPrivacyRequests(false);
  assert.ok(holds.length >= 2);
  assert.ok(requests.length >= 3);
  assert.equal(holds.every((hold) => hold.scope_value === null), true);
  assert.equal(holds.every((hold) => hold.reason === "Restricted"), true);
  assert.equal(requests.every((request) => request.scope_value === null), true);
  assert.equal(JSON.stringify({ holds, requests }).includes("object_key"), false);
  assert.equal(JSON.stringify({ holds, requests }).includes("message_body"), false);

  const completed = requests.find((request) => request.request_type === "EXPORT" && request.state === "SUCCEEDED");
  assert.ok(completed?.artifact_id);
  assert.ok(Number(completed.artifact_byte_size) > 0);
  assert.ok(new Date(String(completed.artifact_expires_at)).getTime() > Date.now());
  const signed = await fixture.downloadPrivacyExport(String(completed.id), "Maya Al-Salem");
  assert.equal(signed.expiresIn, 300);
  assert.equal(new URL(signed.url).protocol, "https:");
  assert.equal(JSON.stringify(signed).includes("object_key"), false);
});

test("fixture policy and requests provide optimistic, confirmed, replay-safe human-flow evidence", async () => {
  const policy = await fixture.getPrivacyRetentionPolicy();
  const updated = await fixture.updatePrivacyRetentionPolicy({
    state: "ACTIVE",
    resolvedCaseDays: 180,
    includeOpenCases: false,
    mediaDays: 45,
    unmatchedDiagnosticHours: 12,
    exportTtlHours: 24,
    expectedVersion: policy.version,
  }, "Maya Al-Salem");
  assert.equal(updated.resolved_case_days, 180);
  assert.equal(updated.version, Number(policy.version) + 1);
  await assert.rejects(
    () => fixture.updatePrivacyRetentionPolicy({
      state: "ACTIVE", resolvedCaseDays: 180, includeOpenCases: false,
      mediaDays: 45, unmatchedDiagnosticHours: 12, exportTtlHours: 24,
      expectedVersion: policy.version,
    }, "Maya Al-Salem"),
    (error) => error?.status === 409,
  );

  const idempotencyKey = "privacy-portal-export-fixture";
  const created = await fixture.createPrivacyRequest({ requestType: "EXPORT", scopeType: "REFERENCE", scopeValue: "ABC9999999" }, idempotencyKey, "Maya Al-Salem");
  const replay = await fixture.createPrivacyRequest({ requestType: "EXPORT", scopeType: "REFERENCE", scopeValue: "ABC9999999" }, idempotencyKey, "Maya Al-Salem");
  assert.equal(replay.id, created.id);
  assert.equal(replay.duplicate, true);
  await assert.rejects(
    () => fixture.createPrivacyRequest({ requestType: "DELETE", scopeType: "REFERENCE", scopeValue: "ABC9999999" }, "privacy-delete-no-confirmation", "Maya Al-Salem"),
    /Type "DELETE" to confirm deletion/,
  );
  const retryKey="privacy-retry-fixture";
  const retried=await fixture.retryPrivacyRequest("72000000-0000-4000-8000-000000000003",undefined,retryKey,"Maya Al-Salem");
  const retryReplay=await fixture.retryPrivacyRequest("72000000-0000-4000-8000-000000000003",undefined,retryKey,"Maya Al-Salem");
  assert.equal(retried.duplicate,false);
  assert.equal(retryReplay.duplicate,true);
});

test("BFF fixture paths preserve permission checks while the control API enforces recent authentication", async () => {
  const paths = [
    "app/api/privacy/policy/route.ts",
    "app/api/privacy/holds/route.ts",
    "app/api/privacy/holds/[id]/release/route.ts",
    "app/api/privacy/requests/route.ts",
    "app/api/privacy/requests/[id]/route.ts",
    "app/api/privacy/requests/[id]/retry/route.ts",
    "app/api/privacy/requests/[id]/download/route.ts",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /authenticatePortalRequest/);
    assert.match(source, /isFixtureBackend/);
    assert.match(source, /isControlPlaneBackend/);
  }
  const requestRoute = await readFile(new URL("../app/api/privacy/requests/route.ts", import.meta.url), "utf8");
  const retryRoute = await readFile(new URL("../app/api/privacy/requests/[id]/retry/route.ts", import.meta.url), "utf8");
  const controller = await readFile(new URL("../services/control-api/src/privacy.controller.ts", import.meta.url), "utf8");
  const privilegedAuth = await readFile(new URL("../services/control-api/src/privileged-auth.ts", import.meta.url), "utf8");
  assert.match(requestRoute, /requirePermission\(principal, "privacy:delete"\)/);
  assert.match(retryRoute, /requirePermission\(principal, existing\.request_type === "DELETE" \? "privacy:delete" : "privacy:export"\)/);
  assert.match(retryRoute, /request\.headers\.get\("idempotency-key"\)/u);
  assert.match(controller, /withOperationReceipt\(client,request\.principal,"PRIVACY_REQUEST_RETRY"/u);
  assert.match(controller, /Type "\$\{expected\}" to confirm deletion/u);
  assert.match(privacySource, /"idempotency-key":intent\.operationId/u);
  assert.match(privacySource, /value="WHATSAPP_GROUP"/u);
  assert.match(controller, /requirePrivilegedAuthentication/);
  assert.match(privilegedAuth, /privileged_reauth_minutes/);
  assert.match(privilegedAuth, /now - authenticatedAt! <= maximumMinutes \* 60/);
  assert.match(privilegedAuth, /hasAuthoritativeMfa\(principal\)/);
  assert.match(controller, /url_ttl_seconds: 300/);
});

test.after(() => {
  if (originalBackend === undefined) delete process.env.PORTAL_DATA_BACKEND;
  else process.env.PORTAL_DATA_BACKEND = originalBackend;
  if (originalRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE;
  else process.env.PORTAL_FIXTURE_ROLE = originalRole;
});

test("fixture privacy selection matches exact references and preserves native-scope confirmation/PII guards", async () => {
  await assert.rejects(() => fixture.resolvePrivacyTarget({scopeType:"ZAMMAD_USER",scopeValue:"customer@example.test"},"auditor"), error=>error.status===403);
  const chosen=await fixture.resolvePrivacyTarget({scopeType:"ZAMMAD_TICKET",scopeValue:"2026101810381"});
  assert.equal(chosen.display,"#2026101810381");assert.equal("scope_value" in chosen,false);
  await assert.rejects(()=>fixture.resolvePrivacyTarget({scopeType:"ZAMMAD_TICKET",scopeValue:"10381"}),error=>error.status===403);
  await assert.rejects(()=>fixture.createPrivacyRequest({requestType:"EXPORT",scopeType:"zammad_ticket",scopeValue:"10381"},"fixture-target-no-proof","Synthetic owner"),error=>error.status===400);
  const customer=await fixture.resolvePrivacyTarget({scopeType:"ZAMMAD_USER",scopeValue:"customer@example.test"});
  const input={requestType:"EXPORT",scopeType:"ZAMMAD_USER",scopeValue:"customer@example.test",selection_sha256:customer.selection_sha256};
  await assert.rejects(()=>fixture.createPrivacyRequest({...input,selection_sha256:"b".repeat(64)},"fixture-target-stale","Synthetic owner"),error=>error.status===409);
  const created=await fixture.createPrivacyRequest(input,"fixture-target-confirmed","Synthetic owner");
  assert.equal((await fixture.getPrivacyRequest(created.id)).scope_value,null);
  assert.equal((await fixture.createPrivacyRequest(input,"fixture-target-confirmed","Synthetic owner")).duplicate,true);
  const hold=await fixture.createPrivacyLegalHold({...input,reason:"Preserve selected synthetic customer"},"Synthetic owner", "privacy-hold-fixture-1");
  assert.equal(hold.scope_value,null);
  assert.equal((await fixture.getPrivacyLegalHolds(false)).every(row=>row.scope_value===null),true);
});

test("fixture privacy receipt unknown/cancel/admitted recovery is ID-only and never a false absence proof",async()=>{
 const operationId="fixture-privacy-cancellation";
 assert.deepEqual(await fixture.privacyOperationReceipt({operationId,kind:"EXPORT",action:"LOOKUP"}),{state:"UNKNOWN"});
 assert.equal((await fixture.privacyOperationReceipt({operationId,kind:"EXPORT",action:"CANCEL_IF_UNADMITTED"})).state,"NOT_APPLIED");
 const selected=await fixture.resolvePrivacyTarget({scopeType:"ZAMMAD_TICKET",scopeValue:"2026101810381"});
 assert.equal((await fixture.createPrivacyRequest({requestType:"EXPORT",scopeType:"ZAMMAD_TICKET",scopeValue:"2026101810381",selection_sha256:selected.selection_sha256},operationId,"Synthetic owner")).state,"NOT_APPLIED");
 await assert.rejects(()=>fixture.privacyOperationReceipt({operationId,kind:"EXPORT",action:"LOOKUP"},"auditor"),error=>error.status===403);
});
