import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { metaCoexistenceUnits, coexistenceSubjectDigest } from "../packages/core/dist/meta-coexistence.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { InboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import { MetaCoexistenceController } from "../services/control-api/dist/meta-coexistence.controller.js";
import { PrivacyRepository } from "../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js";
import { verifyCoexistenceNativePrivacy } from "./meta-coexistence-native-privacy-postgres.mjs";

// Extends the existing signup canonical gate; no independent database/harness or live provider.
export async function verifyMetaCoexistence(fixture) {
  const failures = [], progress = { phase: "onboarding" };
  await collectCoexistenceScenario(failures, "lookup-catalog", () => assertCoexistenceLookupCatalog(fixture.admin));
  const result = await collectCoexistenceScenario(failures, "stateful-journey", () => verifyCoexistenceJourney(fixture, progress));
  if (!result.passed) {
    const phases = ["onboarding", "read-authority", "sync-admission", "inert-projection", "native-privacy", "retention-export-delete", "stop-capture", "tenant-delete", "sync-recovery", "unresolved-tenant-delete"];
    for (const name of phases.slice(phases.indexOf(progress.phase)+1)) console.log(JSON.stringify({ metaCoexistenceScenario: name, result: "SKIP_DEPENDENCY", dependency: progress.phase }));
  }
  if (failures.length) throw new AggregateError(failures, "Meta coexistence PostgreSQL failure union");
  return result.value;
}

async function collectCoexistenceScenario(failures, name, run) {
  try { const value = await run(); console.log(JSON.stringify({ metaCoexistenceScenario: name, result: "PASS" })); return { passed: true, value }; }
  catch (error) { failures.push(new Error(name, { cause: error })); console.error(`Meta coexistence ${name} failed`, error); return { passed: false }; }
}

async function verifyCoexistenceJourney(fixture, progress) {
  const { admin, db, worker, processor, service, controller, request, stored, tenantId, phone, account, appId, syncRequests, workerConfig } = fixture;
  // P04 removes its other owner before this fixture; actor-revocation cases need a remaining owner.
  const supportingOwner = randomUUID();
  await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Supporting coexistence owner')", [supportingOwner, `coexistence-${supportingOwner}`, `${supportingOwner}@example.invalid`]);
  assert.equal((await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')", [tenantId, supportingOwner])).rowCount, 1);
  const consent = { version: "2026-10-07", contacts: true, history: true, echoes: true };
  await assert.rejects(() => service.start(request, { name: "Invalid mixed purpose", payerMode: "CUSTOMER", idempotencyKey: randomUUID(),
    targetConnectionId: randomUUID(), variant: "BUSINESS_APP", coexistenceConsent: consent }), error => error.getStatus?.() === 400);
  const started = await service.start(request, { name: "Business app fixture", payerMode: "CUSTOMER", idempotencyKey: randomUUID(), variant: "BUSINESS_APP", coexistenceConsent: consent });
  assert.equal(started.sdk.extras.featureType, "whatsapp_business_app_onboarding"); assert.equal(started.sdk.extras.sessionInfoVersion, "3");
  await service.sessionLog(request, started.attemptId, { challenge: started.challenge, event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", sessionInfoVersion: "3", sourceOrigin: "https://www.facebook.com", traceSha256: "b".repeat(64) });
  assert.equal((await service.get(request, started.attemptId)).status, "AWAITING_AUTHORIZATION", "advisory finish cannot complete signup");
  const selected = await service.exchange(request, started.attemptId, { challenge: started.challenge, code: randomUUID(), expectedRevision: started.revision });
  assert.equal(selected.choices[0].selectable, true); assert.equal(selected.choices[0].mode, "COEXISTENCE");
  const selection = { expectedRevision: selected.revision, selectionRevision: selected.selectionRevision, choiceId: selected.choices[0].choiceId };
  for (const registrationPin of ["123456", undefined, null]) {
    await assert.rejects(() => controller.signupSelect(request, started.attemptId, { ...selection, registrationPin }), error => error.getStatus?.() === 400);
  }
  const provisioning = await controller.signupSelect(request, started.attemptId, selection);
  const connectionId = provisioning.connectionId;
  assert.deepEqual(Object.keys(stored.get(`secret://${tenantId}/connections/${connectionId}/meta`)), ["accessToken"]);
  assert.equal((await processor.drainTenant(tenantId)).succeeded, 1);
  assert.equal((await service.get(request, started.attemptId)).status, "COMPLETED", "Normal signup read settles successful provisioning before privacy");
  assert.equal(syncRequests.length, 0, "PROVISION only commits ready routing and queues import");
  let context = (await admin.query("SELECT * FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, connectionId])).rows[0];
  assert.ok(context); assert.equal(context.last_onboarded_time, null);
  context = await verifyCoexistenceQueueLookup(fixture, context);
  await verifyCoexistenceAppLookup(fixture, context);
  const otherConnection = (await admin.query(`SELECT connection.id FROM connections connection WHERE connection.tenant_id=$1 AND connection.id<>$2
    AND NOT EXISTS(SELECT 1 FROM meta_coexistence_contexts context WHERE context.tenant_id=connection.tenant_id AND context.connection_id=connection.id) LIMIT 1`, [tenantId, connectionId])).rows[0];
  assert.ok(otherConnection);
  await assert.rejects(() => admin.query(`INSERT INTO meta_coexistence_contexts(tenant_id,connection_id,provider_session_id,signup_attempt_id,app_id,phone_id,waba_id,
    business_phone,graph_version,credential_fingerprint,consent_history,consent_contacts,consent_echoes,consent_version,consent_actor,first_launch_at,contacts_request,history_request)
    SELECT tenant_id,$2,provider_session_id,signup_attempt_id,app_id,$3,waba_id,business_phone,graph_version,credential_fingerprint,
      consent_history,consent_contacts,consent_echoes,consent_version,consent_actor,first_launch_at,contacts_request,history_request
    FROM meta_coexistence_contexts WHERE id=$1`, [context.id, otherConnection.id, String(BigInt(phone)+10000n)]),
  error => error.code === "23503", "same-tenant session from another connection cannot establish a context");
  const route = { tenant_id: tenantId, connection_id: connectionId, provider: "META", hmac_secret_reference: process.env.META_APP_SECRET_REFERENCE };
  const contactPhone = "15555550998", otherPhone = "15555550997", businessPhone = "12025550161", now = Math.floor(Date.now()/1000);
  const metadata = { phone_number_id: phone, display_phone_number: businessPhone };
  const admission = async (field, data) => {
    const value = { messaging_product: "whatsapp", metadata, ...data };
    const units = metaCoexistenceUnits(account, field, value);
    const ids = [];
    for (const unit of units) ids.push(await db.acceptMetaCoexistenceEvent(route, { unit, appId, sourceSha256: unit.sourceSha256 }));
    return ids;
  };
  const message = (id, subject = contactPhone, type = "text") => ({ id, from: subject, timestamp: String(now-60), type, ...(type === "text" ? { text: { body: "Inert fixture" } } : {}) });
  const history = (chunk, items, progress = 50) => ({ history: [{ metadata: { phase: 0, chunk_order: chunk, progress }, threads: [
    ...new Set(items.map(item => item.from)),
  ].map(subject => ({ id: subject, messages: items.filter(item => item.from === subject) })) }] });
  const pool = new Pool(workerConfig), inbound = new InboundRepository(pool), readApi = new MetaCoexistenceController(db);
  const drain = new InboundProcessor(inbound, { resolve: async () => assert.fail("inert projection must not resolve any provider/native secret") }, undefined, 8, undefined, appId);
  try {
    progress.phase = "read-authority";
    assert.deepEqual(await db.rows(tenantId, `SELECT has_any_column_privilege(current_user,'public.tenants','UPDATE') AS tenant_update,
      has_function_privilege(current_user,'app.lock_current_active_tenant_for_event_admission()','EXECUTE') AS tenant_lock`), [{ tenant_update: false, tenant_lock: true }]);
    const denied = async deniedRequest => {
      for (const operation of [
        () => readApi.summary(deniedRequest, connectionId),
        () => readApi.contacts(deniedRequest, connectionId),
        () => readApi.messages(deniedRequest, connectionId, "a".repeat(64)),
        () => readApi.stop(deniedRequest, connectionId, { expectedRevision: 1, history: false, contacts: false, echoes: false }),
      ]) await assert.rejects(operation, error => error.getStatus?.() === 403);
    };
    await denied({ ...request, principal: { ...request.principal, userId: randomUUID() } });
    assert.equal((await admin.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2", [tenantId, supportingOwner])).rowCount, 1);
    try { await denied({ ...request, principal: { ...request.principal, userId: supportingOwner } }); }
    finally { await admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2", [tenantId, supportingOwner]); }
    assert.equal((await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1", [tenantId])).rowCount, 1);
    try { await denied(request); }
    finally { await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1", [tenantId]); }
    assert.equal((await readApi.summary(request, connectionId)).consent.echoes, true, "denied stop calls preserve consent");
    progress.phase = "sync-admission";
    // Before claim there is no history correlation grant.
    await assert.rejects(() => admission("history", history(1, [message("wamid.before-claim")])));
    const leaseId = randomUUID(), [job] = await worker.claim(tenantId, leaseId, 1);
    assert.equal(job.operationType, "SYNC_META_APP");
    const session = await worker.acquireProviderSessionLease(job, leaseId, "coexistence-claim-fixture");
    assert.equal(await worker.coexistenceRequest(job, leaseId, session, "contacts", "CLAIMED"), true);
    assert.equal(await worker.coexistenceRequest(job, leaseId, session, "contacts", "CLAIMED"), false);
    await verifyCoexistenceWorkerLookup(fixture, context, job, leaseId, session);
    const [contactEvent] = await admission("smb_app_state_sync", { state_sync: [{ type: "contact", contact: { phone_number: contactPhone, full_name: "Fixture contact" }, action: "add", metadata: { timestamp: String(now) } }] });
    await verifyCoexistenceClaimLookup(fixture, contactEvent.id);
    await drain.drainTenant(tenantId);
    assert.equal((await readApi.summary(request, connectionId)).contactsRequest, "CLAIMED", "callback before response does not imply HTTP acceptance");
    await worker.coexistenceRequest(job, leaseId, session, "contacts", "ACCEPTED", "original-contact-request");
    assert.equal(await worker.coexistenceRequest(job, leaseId, session, "history", "CLAIMED"), true);
    const chunk = history(2, [message("wamid.history"), message("wamid.other", otherPhone)], 100);
    await admission("history", chunk); await drain.drainTenant(tenantId);
    assert.equal((await admission("history", chunk))[0].duplicate, true);
    const rebatch = { history: [...chunk.history, ...history(8, [message("wamid.rebatch-companion", otherPhone)]).history] };
    assert.equal((await admission("history", rebatch))[0].duplicate, true);
    const changedChunk = structuredClone(chunk); changedChunk.history[0].threads[0].messages[0].text.body = "Conflicting same chunk";
    await assert.rejects(() => admission("history", changedChunk), /conflicts/);
    await drain.drainTenant(tenantId);
    await worker.coexistenceRequest(job, leaseId, session, "history", "ACCEPTED", "original-history-request");
    await worker.finishCoexistence(job, leaseId, session);
    assert.equal((await readApi.summary(request, connectionId)).processedChunks, 2);
    assert.equal((await readApi.summary(request, connectionId)).historyObservation, "PROVIDER_FINISHED");
    assert.equal((await admin.query("SELECT state FROM connections WHERE id=$1", [connectionId])).rows[0].state, "WORKING");
    progress.phase = "inert-projection";
    // Early media stays a pending local projection, then joins its placeholder without a download.
    await admission("history", { messages: [{ ...message("wamid.media"), type: "image", image: { id: "99999999" } }] });
    await drain.drainTenant(tenantId);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_messages WHERE context_id=$1 AND external_message_id='wamid.media'", [context.id])).rows[0].n, 0);
    await admission("history", history(1, [message("wamid.media", contactPhone, "media_placeholder")])); await drain.drainTenant(tenantId);
    await admin.query("UPDATE event_inbox SET available_at=clock_timestamp() WHERE tenant_id=$1 AND event_type='meta.coexistence.history_media' AND status='FAILED_RETRYABLE'", [tenantId]);
    await drain.drainTenant(tenantId);
    assert.equal((await admin.query("SELECT media_id FROM meta_coexistence_messages WHERE context_id=$1 AND external_message_id='wamid.media'", [context.id])).rows[0].media_id, "99999999");
    const threads = await readApi.contacts(request, connectionId); const thread = threads.items.find(item => item.phone === contactPhone);
    assert.ok(thread); assert.equal((await readApi.messages(request, connectionId, thread.threadId)).items.length, 2);
    await assert.rejects(() => readApi.summary({ ...request, principal: { ...request.principal, userId: randomUUID() } }, connectionId));
    assert.equal((await db.rows(randomUUID(), "SELECT id FROM meta_coexistence_contexts WHERE id=$1", [context.id])).length, 0);
    const contact = (action, time, name) => ({ state_sync: [{ type: "contact", contact: { phone_number: contactPhone, ...(name ? { full_name: name } : {}) }, action, metadata: { timestamp: String(time) } }] });
    await admission("smb_app_state_sync", contact("remove", now+1)); await drain.drainTenant(tenantId);
    await admission("smb_app_state_sync", contact("add", now-1, "Old add")); await drain.drainTenant(tenantId);
    assert.equal((await readApi.contacts(request, connectionId)).items.find(item => item.phone === contactPhone).removed, true);
    await admission("smb_app_state_sync", contact("add", now+1, "Conflicting tie")); await drain.drainTenant(tenantId);
    assert.equal((await readApi.contacts(request, connectionId)).items.find(item => item.phone === contactPhone).removed, true);
    assert.equal((await readApi.summary(request, connectionId)).holdReason, "REVIEW_REQUIRED");
    await admission("history", history(10, [message("wamid.batch-conflict"), { ...message("wamid.batch-conflict"), text: { body: "Conflicting same batch" } }]));
    await drain.drainTenant(tenantId);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_messages WHERE context_id=$1 AND external_message_id='wamid.batch-conflict'", [context.id])).rows[0].n, 0);
    assert.equal((await admin.query("SELECT count(*)::int n FROM event_inbox WHERE connection_id=$1 AND event_type LIKE 'meta.coexistence.%' AND meta_direct_asset IS NOT NULL", [connectionId])).rows[0].n, 0);
    for (const table of ["normalized_messages", "message_links", "bot_conversations", "delivery_outbox", "participant_identities", "meta_direct_identity_aliases"]) {
      assert.equal((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND connection_id=$2`, [tenantId, connectionId])).rows[0].n, 0, table);
    }
    progress.phase = "native-privacy";
    await verifyCoexistenceNativePrivacy({ ...fixture, context, pool, inbound, drain, readApi });
    progress.phase = "retention-export-delete";
    // Actual privacy repository respects legal holds and expires direct imports/contact PII by source time.
    const retainedPhone = "15555550995", hold = randomUUID(), retentionId = randomUUID(), retentionLease = randomUUID();
    const policy = (await admin.query("SELECT resolved_case_days FROM retention_policies WHERE tenant_id=$1", [tenantId])).rows[0];
    await admin.query("UPDATE retention_policies SET resolved_case_days=1 WHERE tenant_id=$1", [tenantId]);
    await admin.query(`INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
      VALUES($1,$2,'PARTICIPANT',$3,repeat('d',64),'Synthetic import retention hold',$4)`, [hold, tenantId, retainedPhone, request.principal.userId]);
    const old = { ...message("wamid.retained", retainedPhone), timestamp: String(now-172800) };
    await admission("history", history(20, [old]));
    const oldContact = { state_sync: [{ type: "contact", contact: { phone_number: retainedPhone, full_name: "Retained name" }, action: "add", metadata: { timestamp: String(now-172800) } }] };
    await admission("smb_app_state_sync", oldContact); await drain.drainTenant(tenantId);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_messages WHERE context_id=$1 AND external_message_id='wamid.retained'", [context.id])).rows[0].n, 1);
    await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1", [hold, request.principal.userId]);
    await admission("history", history(21, [{ ...old, id: "wamid.pending-expiry" }]));
    const privacyRepository = new PrivacyRepository(pool);
    const retention = { id: retentionId, tenantId, jobType: "RETENTION_SWEEP", scopeType: "TENANT", scopeValue: tenantId, createdAt: new Date().toISOString(),
      stage: "DISCOVER", state: "RUNNING", fencingToken: 1, disposition: "RETENTION_DELETE", unmatchedDiagnosticHours: 24, exportTtlHours: 24, attempts: 1, maxAttempts: 25 };
    await insertPrivacyJob(admin, retention, retentionLease);
    await privacyRepository.discover(retention, retentionLease); await privacyRepository.finalize(retention, retentionLease);
    await drain.drainTenant(tenantId);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_messages WHERE context_id=$1 AND subject_phone=$2", [context.id, retainedPhone])).rows[0].n, 0);
    const retainedContact = (await admin.query("SELECT subject_phone,display_name,redacted_at FROM meta_coexistence_contacts WHERE context_id=$1 AND redacted_at IS NOT NULL", [context.id])).rows[0];
    assert.ok(retainedContact); assert.equal(retainedContact.subject_phone, null); assert.equal(retainedContact.display_name, null);
    const secondSweep = { ...retention, id: randomUUID(), createdAt: new Date().toISOString() }, secondLease = randomUUID();
    await insertPrivacyJob(admin, secondSweep, secondLease);
    await privacyRepository.discover(secondSweep, secondLease); await privacyRepository.finalize(secondSweep, secondLease);
    assert.equal((await admin.query("SELECT state FROM privacy_jobs WHERE id=$1", [secondSweep.id])).rows[0].state, "SUCCEEDED", "second sweep preserves redacted ordering tombstone without a NULL hold call");
    assert.equal((await admission("smb_app_state_sync", oldContact))[0].duplicate, true);
    const expiredExport = { ...retention, id: randomUUID(), jobType: "EXPORT", scopeType: "PARTICIPANT", scopeValue: retainedPhone, disposition: "EXPORT_ONLY" }, expiredExportLease = randomUUID();
    await insertPrivacyJob(admin, expiredExport, expiredExportLease);
    await privacyRepository.discover(expiredExport, expiredExportLease);expiredExport.stage='EXPORT';
    assert.deepEqual((await privacyRepository.exportData(expiredExport, expiredExportLease)).metaCoexistence, { messages: [], contacts: [] }, "retained contact tombstones and expired imports disclose no erased PII");
    await admin.query("DELETE FROM privacy_jobs WHERE id=$1", [expiredExport.id]);
    await admin.query("UPDATE retention_policies SET resolved_case_days=$2 WHERE tenant_id=$1", [tenantId, policy.resolved_case_days]);
    const exportPhone = "15555550994", exportLease = randomUUID();
    await admission("smb_app_state_sync", { state_sync: [{ type: "contact", contact: { phone_number: exportPhone, full_name: "Projected export contact" }, action: "add", metadata: { timestamp: String(now) } }] });
    await drain.drainTenant(tenantId);
    await admission("smb_app_state_sync", { state_sync: [{ type: "contact", contact: { phone_number: exportPhone, full_name: "Pending export update" }, action: "add", metadata: { timestamp: String(now+1) } }] });
    const exported = { ...retention, id: randomUUID(), jobType: "EXPORT", scopeType: "PARTICIPANT", scopeValue: exportPhone, disposition: "EXPORT_ONLY", createdAt: new Date().toISOString() };
    await insertPrivacyJob(admin, exported, exportLease); await privacyRepository.discover(exported, exportLease);
    const snapshot = await privacyRepository.exportData(exported, exportLease);
    assert.equal(snapshot.metaCoexistence.messages.length, 0); assert.equal(snapshot.metaCoexistence.contacts[0].display_name, "Projected export contact");
    await drain.drainTenant(tenantId);
    assert.equal((await privacyRepository.exportData(exported, exportLease)).metaCoexistence.contacts[0].display_name, "Pending export update", "export retains incumbent projected snapshot semantics");
    await admin.query("DELETE FROM privacy_jobs WHERE id=$1", [exported.id]);
    // Delete while another typed chunk is still queued; preserve the unrelated participant.
    const [pending] = await admission("history", history(3, [message("wamid.pending"), message("wamid.pending-other", otherPhone)]));
    const inboxLease = randomUUID(), [leasedEvent] = await inbound.claim(tenantId, inboxLease);
    assert.equal(leasedEvent.id, pending.id); assert.ok(leasedEvent.payload.messages.some(item => item.subject === contactPhone));
    const privacyId = randomUUID(), privacyLease = randomUUID();
    const privacy = { id: privacyId, tenantId, jobType: "DELETE", scopeType: "PARTICIPANT", scopeValue: contactPhone, createdAt: new Date().toISOString(),
      stage: "DISCOVER", state: "RUNNING", fencingToken: 1, disposition: "RETENTION_DELETE", unmatchedDiagnosticHours: 24, exportTtlHours: 24, attempts: 1, maxAttempts: 25 };
    await insertPrivacyJob(admin, privacy, privacyLease);
    await privacyRepository.discover(privacy, privacyLease);
    await privacyRepository.finalize(privacy, privacyLease);
    assert.equal((await admin.query("SELECT state FROM privacy_jobs WHERE id=$1", [privacyId])).rows[0].state, "SUCCEEDED");
    const reduced = (await admin.query("SELECT payload FROM event_inbox WHERE id=$1", [pending.id])).rows[0].payload;
    assert.deepEqual(reduced.messages.map(item => item.subject), [otherPhone]);
    await inbound.projectCoexistence(leasedEvent, inboxLease, appId);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_messages WHERE context_id=$1 AND external_message_id='wamid.pending'", [context.id])).rows[0].n, 0, "worker's old leased payload cannot restore privacy-reduced data");
    await admission("history", history(4, [message("wamid.late-unseen")])); await drain.drainTenant(tenantId);
    await admission("smb_app_state_sync", { state_sync: [{ type: "contact", contact: { phone_number: contactPhone, full_name: "Must stay deleted" }, action: "add", metadata: { timestamp: String(now+1) } }] });
    await drain.drainTenant(tenantId);
    assert.equal((await readApi.contacts(request, connectionId)).items.some(item => item.phone === contactPhone), false);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_messages WHERE context_id=$1 AND subject_phone=$2", [context.id, contactPhone])).rows[0].n, 0);
    const deletedExport = { ...privacy, id: randomUUID(), jobType: "EXPORT", disposition: "EXPORT_ONLY" }, deletedExportLease = randomUUID();
    await insertPrivacyJob(admin, deletedExport, deletedExportLease);
    await privacyRepository.discover(deletedExport, deletedExportLease);deletedExport.stage='EXPORT';
    assert.deepEqual((await privacyRepository.exportData(deletedExport, deletedExportLease)).metaCoexistence, { messages: [], contacts: [] }, "completed participant deletion remains absent from exports after late callbacks");
    await admin.query("DELETE FROM privacy_jobs WHERE id=$1", [deletedExport.id]);
    await assert.rejects(() => admin.query("UPDATE meta_coexistence_contexts SET provider_session_id=$2 WHERE id=$1", [context.id, randomUUID()]), /cannot be reset/);
    await assert.rejects(() => db.withTenant(tenantId, client => client.query("DELETE FROM privacy_job_targets WHERE job_id=$1 AND target_type='META_COEXISTENCE_SUBJECT_CUTOFF'", [privacyId])), /cutoff/);
    const summary = await readApi.summary(request, connectionId);
    progress.phase = "stop-capture";
    await readApi.stop(request, connectionId, { expectedRevision: summary.revision, history: false, contacts: false, echoes: false });
    await assert.rejects(() => admission("smb_message_echoes", { message_echoes: [{ ...message("wamid.stopped"), from: businessPhone, to: otherPhone }] }));
    assert.equal(syncRequests.length, 0, "manual claim fixtures make no HTTP dispatch");
    // Complete the original settled tenant erasure before creating recovery
    // negatives. Their retained unknown/stale evidence must never be erased.
    progress.phase = "tenant-delete";
    const tenantDelete = { ...retention, id: randomUUID(), jobType: "DELETE", createdAt: new Date().toISOString() }, tenantLease = randomUUID();
    await insertPrivacyJob(admin, tenantDelete, tenantLease);
    await privacyRepository.discover(tenantDelete, tenantLease); await privacyRepository.finalize(tenantDelete, tenantLease);
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_contacts WHERE tenant_id=$1", [tenantId])).rows[0].n, 0, "tenant deletion after contact expiry completes");
    assert.equal((await admin.query("SELECT count(*)::int n FROM meta_coexistence_contexts WHERE tenant_id=$1 AND (business_phone IS NOT NULL OR consent_actor IS NOT NULL OR consent_echoes)", [tenantId])).rows[0].n, 0);
    assert.equal((await admin.query("SELECT state FROM public.privacy_jobs WHERE id=$1",[tenantDelete.id])).rows[0].state,'SUCCEEDED');
    progress.phase = "sync-recovery";
    const recoveryFixture={...fixture,...await fixture.createSyncRecoveryFixture(),privacyRepository,drain};
    assert.notEqual(recoveryFixture.tenantId,tenantId);
    await verifySyncRecovery(recoveryFixture);
    progress.phase = "unresolved-tenant-delete";
    const retainedEvidence=async()=>{
      const snapshots={};
      for(const table of ['meta_signup_attempts','connection_operations','provider_sessions'])
        snapshots[table]=(await admin.query(`SELECT * FROM public.${table} WHERE tenant_id=$1 ORDER BY id`,[recoveryFixture.tenantId])).rows;
      return snapshots;
    };
    const unresolvedBefore=await retainedEvidence();
    assert(unresolvedBefore.meta_signup_attempts.some(row=>row.status==='SELECTION_REQUIRED'),'Recovery retains its rejected stale authorization');
    const unresolvedDelete={...tenantDelete,id:randomUUID(),tenantId:recoveryFixture.tenantId,scopeValue:recoveryFixture.tenantId,createdAt:new Date().toISOString()},unresolvedLease=randomUUID();
    await insertPrivacyJob(admin,unresolvedDelete,unresolvedLease);
    await assert.rejects(()=>privacyRepository.discover(unresolvedDelete,unresolvedLease),error=>error.code==='META_SIGNUP_OUTCOME_UNRESOLVED');
    assert.deepEqual(await retainedEvidence(),unresolvedBefore,'Held deletion preserves original attempts, secret-write evidence and operations');
    assert.deepEqual((await admin.query("SELECT stage,state FROM public.privacy_jobs WHERE id=$1",[unresolvedDelete.id])).rows[0],{stage:'DISCOVER',state:'RUNNING'});
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.privacy_job_targets WHERE job_id=$1",[unresolvedDelete.id])).rows[0].n,0);
    return { variant: true, zeroRegister: true, claims: true, callbackBeforeResponse: true, inertProjection: true, pendingPrivacy: true, lateCutoff: true, mediaJoin: true, oneShotRecovery: true, lookupClosure: true, settledTenantErasure: true, unresolvedSignupDeletionHeld: true, liveProviderEvidence: false };
  } finally { await inbound.close(); }
}

async function assertCoexistenceLookupCatalog(admin) {
  const functions = [
    ["app.meta_coexistence_context_immutable()", false, []],
    ["app.queue_meta_coexistence(uuid)", true, ["wasalx_connector_worker"]],
    ["app.rebind_meta_coexistence_credential(uuid,uuid)", true, ["wasalx_app"]],
    ["app.meta_coexistence_privacy_snapshot()", false, ["wasalx_app"]],
    ["app.meta_coexistence_subject_blocked(uuid,text,text,timestamptz)", true, ["wasalx_app", "wasalx_connector_worker"]],
    ["app.meta_coexistence_inbox_binding()", false, []],
    ["app.meta_coexistence_request(uuid,uuid,bigint,text,bigint,text,text,text,jsonb)", true, ["wasalx_connector_worker"]],
    ["app.meta_coexistence_operation_abandoned()", true, []],
    ["app.pin_event_client_routing_version()", false, ["PUBLIC"]],
    ["app.block_async_claim_during_privacy()", false, []],
  ];
  const failures = [];
  for (const [signature, definer, grantees] of functions) await collectCoexistenceScenario(failures, `catalog:${signature}`, async () => {
    const value = (await admin.query(`SELECT p.prosecdef,p.proconfig,p.proowner=n.nspowner AS schema_owner,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable))
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner),'[]'::jsonb) grants
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid=pg_catalog.to_regprocedure($1)`, [signature])).rows[0];
    assert.ok(value, signature); assert.equal(value.prosecdef, definer, signature); assert.equal(value.schema_owner, true, signature);
    assert.deepEqual(value.proconfig.map(item => item.replaceAll(" ", "")).sort(),
      ["search_path=pg_catalog,public,app,pg_temp", ...(definer ? ["row_security=off"] : [])].sort(), signature);
    assert.deepEqual(value.grants.map(item => item.role).sort(), [...grantees].sort(), signature);
    for (const grant of value.grants) { assert.equal(grant.privilege, "EXECUTE"); assert.equal(grant.grantable, false); }
  });
  if (failures.length) throw new AggregateError(failures, "Coexistence lookup catalog failures");
}

// Each group owns a new physical runtime login; shadows exist before its first reader call.
async function withCoexistenceLookupClient(fixture, role, run, commit = false) {
  const client = new Client(role === "app" ? { connectionString: process.env.DATABASE_URL } : fixture.workerConfig);
  await client.connect();
  let finished = false;
  try {
    await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenantId]);
    const authority = (await client.query(`SELECT current_user,session_user,
      active_role.rolsuper AS superuser,active_role.rolbypassrls AS bypass_rls,
      login_role.rolsuper AS session_superuser,login_role.rolbypassrls AS session_bypass_rls,
      pg_catalog.pg_has_role(current_user,$1,'MEMBER') AS runtime,
      pg_catalog.pg_has_role(session_user,$1,'MEMBER') AS session_runtime,
      pg_catalog.pg_has_role(current_user,'wasalx_app','MEMBER') AS app_member,
      pg_catalog.pg_has_role(session_user,'wasalx_app','MEMBER') AS session_app_member,
      pg_catalog.pg_has_role(current_user,(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='app'),'MEMBER') AS owner,
      pg_catalog.pg_has_role(session_user,(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='app'),'MEMBER') AS session_owner,
      pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS public_create,
      pg_catalog.has_schema_privilege(current_user,'app','CREATE') AS app_create,
      pg_catalog.has_database_privilege(current_user,current_database(),'TEMP') AS temp_create
      FROM pg_catalog.pg_roles active_role JOIN pg_catalog.pg_roles login_role ON login_role.rolname=session_user
      WHERE active_role.rolname=current_user`,
    [role === "app" ? "wasalx_app" : "wasalx_connector_worker"])).rows[0];
    assert.deepEqual(authority, {
      current_user: role === "app" ? "wasalx_runtime" : "wasalx_connector_worker",
      session_user: role === "app" ? "wasalx_runtime" : "wasalx_connector_worker_runtime",
      superuser: false, bypass_rls: false, session_superuser: false, session_bypass_rls: false,
      runtime: true, session_runtime: true, app_member: role === "app", session_app_member: role === "app",
      owner: false, session_owner: false, public_create: false, app_create: false, temp_create: true,
    });
    for (const schema of ["public", "app"]) {
      await client.query("SAVEPOINT denied_schema");
      await assert.rejects(() => client.query(`CREATE TABLE ${schema}.coexistence_forbidden_${randomUUID().replaceAll("-", "")}(id integer)`), error => error.code === "42501");
      await client.query("ROLLBACK TO SAVEPOINT denied_schema");
    }
    const result = await run(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK"); finished = true;
    return result;
  } finally { try { if (!finished) await client.query("ROLLBACK"); } finally { await client.end(); } }
}

async function verifyCoexistenceQueueLookup(fixture, context) {
  const { admin, tenantId } = fixture;
  const attempt = (await admin.query("SELECT * FROM public.meta_signup_attempts WHERE id=$1", [context.signup_attempt_id])).rows[0];
  await withCoexistenceLookupClient(fixture, "worker", async client => {
    await client.query(`CREATE TEMP TABLE meta_signup_attempts(id uuid,tenant_id uuid,operation_id uuid,connection_id uuid,config jsonb,
      selected_choice jsonb,credential_fingerprint text,coexistence_consent jsonb,requested_by uuid,created_at timestamptz);
      CREATE TEMP TABLE connection_operations AS SELECT * FROM public.connection_operations WITH NO DATA;
      CREATE TEMP TABLE connections AS SELECT * FROM public.connections WITH NO DATA;
      CREATE TEMP TABLE provider_sessions AS SELECT * FROM public.provider_sessions WITH NO DATA;
      CREATE TEMP TABLE webhook_routes AS SELECT * FROM public.webhook_routes WITH NO DATA;
      CREATE TEMP TABLE meta_coexistence_contexts AS SELECT * FROM public.meta_coexistence_contexts WITH NO DATA`);
    const forgedOperation = randomUUID();
    await client.query("INSERT INTO pg_temp.meta_signup_attempts SELECT * FROM jsonb_populate_record(NULL::pg_temp.meta_signup_attempts,$1)", [{ ...attempt, operation_id: forgedOperation }]);
    await client.query("INSERT INTO pg_temp.connection_operations SELECT * FROM public.connection_operations WHERE id=$1", [attempt.operation_id]);
    await client.query("UPDATE pg_temp.connection_operations SET id=$1,state='SUCCEEDED',result='{\"metaSignupReady\":true}'", [forgedOperation]);
    await client.query("INSERT INTO pg_temp.connections SELECT * FROM public.connections WHERE id=$1", [context.connection_id]);
    await client.query("INSERT INTO pg_temp.provider_sessions SELECT * FROM public.provider_sessions WHERE id=$1", [context.provider_session_id]);
    await client.query("INSERT INTO pg_temp.webhook_routes SELECT * FROM public.webhook_routes WHERE connection_id=$1", [context.connection_id]);
    await client.query("SELECT app.queue_meta_coexistence($1)", [forgedOperation]);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_temp.meta_coexistence_contexts")).rows[0].n, 0, "forged successful signup cannot queue an import");
    assert.equal((await admin.query("SELECT count(*)::int n FROM public.meta_coexistence_contexts WHERE connection_id=$1", [context.connection_id])).rows[0].n, 1);
    // Lock and freshly verify the owned fixture before removing any pristine queue state.
    await admin.query("BEGIN");
    try {
      const fresh = (await admin.query(`SELECT id,tenant_id,connection_id,provider_session_id,signup_attempt_id,contacts_request,history_request,
        history_observation,provider_progress,processed_chunks,last_activity_at,hold_reason,revision
        FROM public.meta_coexistence_contexts WHERE tenant_id=$1 AND id=$2 AND connection_id=$3 FOR UPDATE`,
      [tenantId, context.id, context.connection_id])).rows;
      assert.deepEqual(fresh, [{ id: context.id, tenant_id: tenantId, connection_id: context.connection_id,
        provider_session_id: context.provider_session_id, signup_attempt_id: context.signup_attempt_id,
        contacts_request: { state: "QUEUED" }, history_request: { state: "QUEUED" }, history_observation: "WAITING",
        provider_progress: null, processed_chunks: 0, last_activity_at: null, hold_reason: null, revision: 1 }]);
      const operations = (await admin.query(`SELECT id,idempotency_key,payload,state,attempts,fencing_token::integer,
        lease_id,lease_expires_at,started_at,completed_at,result,error_code,safe_error FROM public.connection_operations
        WHERE tenant_id=$1 AND connection_id=$2 AND operation_type='SYNC_META_APP' FOR UPDATE`, [tenantId, context.connection_id])).rows;
      assert.equal(operations.length, 1);
      const { id, idempotency_key: key, payload, ...execution } = operations[0];
      assert.equal(key, `meta-coexistence:${context.id}`); assert.equal(payload.contextId, context.id);
      assert.deepEqual(execution, { state: "QUEUED", attempts: 0, fencing_token: 0, lease_id: null, lease_expires_at: null,
        started_at: null, completed_at: null, result: null, error_code: null, safe_error: null });
      assert.equal(fixture.syncRequests.length, 0);
      assert.equal((await admin.query("SELECT count(*)::int n FROM public.event_inbox WHERE tenant_id=$1 AND connection_id=$2", [tenantId, context.connection_id])).rows[0].n, 0);
      assert.equal((await admin.query("DELETE FROM public.connection_operations WHERE tenant_id=$1 AND id=$2 RETURNING id", [tenantId, id])).rowCount, 1);
      assert.equal((await admin.query("DELETE FROM public.meta_coexistence_contexts WHERE tenant_id=$1 AND id=$2", [tenantId, context.id])).rowCount, 1);
      await admin.query("COMMIT");
    } catch (error) { await admin.query("ROLLBACK"); throw error; }
    for (const table of ["meta_signup_attempts", "connection_operations", "connections", "provider_sessions", "webhook_routes"]) await client.query(`DELETE FROM pg_temp.${table}`);
    await client.query("SELECT app.queue_meta_coexistence($1)", [attempt.operation_id]);
    const replacement = (await client.query("SELECT * FROM public.meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, context.connection_id])).rows[0];
    assert.ok(replacement); assert.notEqual(replacement.id, context.id);
    assert.equal(replacement.provider_session_id, context.provider_session_id);
    const queued = (await client.query("SELECT * FROM public.connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND operation_type='SYNC_META_APP'", [tenantId, context.connection_id])).rows;
    assert.equal(queued.length, 1); assert.equal(queued[0].payload.contextId, replacement.id); assert.equal(queued[0].state, "QUEUED"); assert.equal(queued[0].attempts, 0);
    await client.query("SELECT app.queue_meta_coexistence($1)", [attempt.operation_id]);
    assert.deepEqual((await client.query("SELECT * FROM public.meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, context.connection_id])).rows, [replacement], "repeat queue keeps the same context");
    assert.deepEqual((await client.query("SELECT * FROM public.connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND operation_type='SYNC_META_APP'", [tenantId, context.connection_id])).rows, queued, "repeat queue keeps the same single operation");
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_temp.meta_coexistence_contexts")).rows[0].n, 0);
  }, true);
  return (await admin.query("SELECT * FROM public.meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, context.connection_id])).rows[0];
}

async function verifyCoexistenceAppLookup(fixture, context) {
  const { admin, tenantId, request } = fixture;
  const draft = randomUUID(), createdRouting = [draft];
  let active = (await admin.query("SELECT id FROM public.client_routing_versions WHERE tenant_id=$1 AND state='ACTIVE'", [tenantId])).rows[0]?.id;
  if (!active) { active = randomUUID(); createdRouting.push(active); }
  for (const id of createdRouting) {
    const state = id === draft ? "DRAFT" : "ACTIVE";
    await admin.query(`INSERT INTO public.client_routing_versions(id,tenant_id,version,state,definition,snapshot_sha256,created_by,activated_by,activated_at)
      VALUES($1,$2,(SELECT COALESCE(max(version),0)+1 FROM public.client_routing_versions WHERE tenant_id=$2),$3,
        '{"schemaVersion":1,"sources":[],"clients":[]}',repeat('a',64),$4,CASE WHEN $3='ACTIVE' THEN $4::uuid END,CASE WHEN $3='ACTIVE' THEN clock_timestamp() END)`,
    [id, tenantId, state, request.principal.userId]);
  }
  try { await withCoexistenceLookupClient(fixture, "app", async client => {
    await client.query(`CREATE TEMP TABLE meta_coexistence_contexts AS SELECT * FROM public.meta_coexistence_contexts;
      CREATE TEMP TABLE privacy_jobs AS SELECT * FROM public.privacy_jobs WITH NO DATA;
      CREATE TEMP TABLE privacy_job_targets AS SELECT * FROM public.privacy_job_targets WITH NO DATA;
      CREATE TEMP TABLE client_routing_versions AS SELECT * FROM public.client_routing_versions WITH NO DATA`);
    const fakeContext = randomUUID();
    await client.query("UPDATE pg_temp.meta_coexistence_contexts SET id=$1 WHERE id=$2", [fakeContext, context.id]);
    // Both routing IDs really exist; an unpinned reader would accept the fake ACTIVE draft, not merely fail an FK.
    await client.query("INSERT INTO pg_temp.client_routing_versions SELECT * FROM public.client_routing_versions WHERE id=$1", [draft]);
    await client.query("UPDATE pg_temp.client_routing_versions SET state='ACTIVE'");
    const payload = { phoneId: context.phone_id, wabaId: context.waba_id, businessPhone: context.business_phone, sourceSha256: "a".repeat(64), kind: "ECHO", messages: [], contacts: [] };
    const insert = id => client.query(`INSERT INTO public.event_inbox(tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,meta_coexistence_admission)
      VALUES($1,$2,'META',$3,'meta.coexistence.echo',$4,$5,'ACCEPTED',$6) RETURNING id,governing_client_routing_version_id`,
    [tenantId, context.connection_id, randomUUID(), payload, payload.sourceSha256, { contextId: id, providerSessionId: context.provider_session_id, appId: context.app_id }]);
    await client.query("SAVEPOINT forged_context");
    await assert.rejects(() => insert(fakeContext), error => error.code === "23514" && error.message.includes("invalid coexistence inbox binding"));
    await client.query("ROLLBACK TO SAVEPOINT forged_context");
    const event = (await insert(context.id)).rows[0];
    assert.equal(event.governing_client_routing_version_id, active, "real ACTIVE routing version wins over forged draft");
    await client.query("UPDATE pg_temp.meta_coexistence_contexts SET id=$1 WHERE id=$2", [context.id, fakeContext]);
    await client.query(`INSERT INTO pg_temp.privacy_jobs(id,tenant_id,job_type,scope_type,state,stage,lease_expires_at)
      VALUES($1,$2,'DELETE','TENANT','RUNNING','LOCAL',clock_timestamp()+interval '5 minutes')`, [randomUUID(), tenantId]);
    const reduce = () => client.query(`UPDATE public.meta_coexistence_contexts SET business_phone=NULL,last_onboarded_time=NULL,consent_actor=NULL,
      consent_history=false,consent_contacts=false,consent_echoes=false WHERE id=$1 RETURNING business_phone`, [context.id]);
    await client.query("SAVEPOINT forged_privacy");
    await assert.rejects(reduce, error => error.code === "23514" && error.message.includes("privacy reduction"));
    await client.query("ROLLBACK TO SAVEPOINT forged_privacy");
    await client.query("DELETE FROM pg_temp.privacy_jobs");
    await client.query("SAVEPOINT real_privacy");
    const job = { id: randomUUID(), tenantId, jobType: "DELETE", scopeType: "TENANT", scopeValue: tenantId, disposition: "RETENTION_DELETE", createdAt: new Date().toISOString(), attempts: 1 };
    await insertPrivacyJob(client, job, randomUUID()); await client.query("UPDATE public.privacy_jobs SET stage='LOCAL' WHERE id=$1", [job.id]);
    assert.equal((await client.query("SELECT app.meta_coexistence_subject_blocked($1,'12025550162','HISTORY',clock_timestamp()) blocked", [context.id])).rows[0].blocked, true, "empty temp privacy tables cannot reopen a real hold");
    assert.deepEqual((await reduce()).rows, [{ business_phone: null }], "real scoped privacy job authorizes metadata reduction");
    await client.query("ROLLBACK TO SAVEPOINT real_privacy");
    assert.equal((await client.query("SELECT app.meta_coexistence_subject_blocked($1,'12025550162','HISTORY',clock_timestamp()) blocked", [context.id])).rows[0].blocked, false);
  }); } finally { await admin.query("DELETE FROM public.client_routing_versions WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenantId, createdRouting]); }
}

async function verifyCoexistenceWorkerLookup(fixture, context, job, lease, session) {
  const config = (await fixture.admin.query("SELECT config FROM public.meta_signup_attempts WHERE id=$1", [context.signup_attempt_id])).rows[0].config;
  await withCoexistenceLookupClient(fixture, "worker", async client => {
    await client.query(`CREATE TEMP TABLE meta_coexistence_contexts AS SELECT * FROM public.meta_coexistence_contexts;
      CREATE TEMP TABLE connection_operations AS SELECT * FROM public.connection_operations;
      CREATE TEMP TABLE provider_sessions AS SELECT * FROM public.provider_sessions;
      CREATE TEMP TABLE privacy_jobs AS SELECT * FROM public.privacy_jobs WITH NO DATA`);
    const dispatch = (outcome = "DISPATCH") => client.query("SELECT app.meta_coexistence_request($1,$2,$3,$4,$5,'contacts',$6,$7,$8) applied",
      [job.id, lease, job.fencingToken, session.workerIdentity, session.fencingToken, outcome, outcome === "ACCEPTED" ? "lookup-public-request" : null, config]);
    for (const boundary of ["operation", "session", "consent"]) {
      await client.query("SAVEPOINT stale_authority");
      if (boundary === "operation") await client.query("UPDATE public.connection_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      if (boundary === "session") await client.query("UPDATE public.provider_sessions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [session.id]);
      if (boundary === "consent") await client.query("UPDATE public.meta_coexistence_contexts SET consent_contacts=false WHERE id=$1", [context.id]);
      assert.equal((await dispatch()).rows[0].applied, false, `${boundary}: forged current rows cannot authorize dispatch`);
      await client.query("ROLLBACK TO SAVEPOINT stale_authority");
    }
    for (const table of ["meta_coexistence_contexts", "connection_operations", "provider_sessions"]) await client.query(`DELETE FROM pg_temp.${table}`);
    assert.equal((await dispatch()).rows[0].applied, true, "real consumed claim remains dispatchable through empty shadows");
    await client.query("SAVEPOINT real_response");
    assert.equal((await dispatch("ACCEPTED")).rows[0].applied, true);
    assert.equal((await client.query("SELECT contacts_request->>'state' state FROM public.meta_coexistence_contexts WHERE id=$1", [context.id])).rows[0].state, "ACCEPTED", "dynamic update reaches the public context");
    await client.query("ROLLBACK TO SAVEPOINT real_response");
    await client.query("UPDATE public.connection_operations SET fencing_token=fencing_token+1 WHERE id=$1", [job.id]);
    const abandoned = (await client.query("SELECT contacts_request->>'state' contacts,history_request->>'state' history FROM public.meta_coexistence_contexts WHERE id=$1", [context.id])).rows[0];
    assert.deepEqual(abandoned, { contacts: "UNKNOWN", history: "HELD_CONTACTS_UNKNOWN" }, "empty shadow cannot hide abandonment of the real claim");
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_temp.meta_coexistence_contexts")).rows[0].n, 0);
  });
}

async function verifyCoexistenceClaimLookup(fixture, eventId) {
  await withCoexistenceLookupClient(fixture, "worker", async client => {
    await client.query("CREATE TEMP TABLE privacy_jobs AS SELECT * FROM public.privacy_jobs WITH NO DATA");
    await client.query("SAVEPOINT real_hold");
    const job = { id: randomUUID(), tenantId: fixture.tenantId, jobType: "DELETE", scopeType: "TENANT", scopeValue: fixture.tenantId,
      disposition: "RETENTION_DELETE", createdAt: new Date().toISOString(), attempts: 1 };
    await insertPrivacyJob(client, job, randomUUID()); await client.query("UPDATE public.privacy_jobs SET stage='LOCAL' WHERE id=$1", [job.id]);
    assert.equal((await client.query("SELECT id FROM app.claim_inbound_events($1,100)", [randomUUID()])).rows.some(row => row.id === eventId), false, "empty shadow cannot hide the actual privacy claim fence");
    assert.equal((await client.query("SELECT status FROM public.event_inbox WHERE id=$1", [eventId])).rows[0].status, "ACCEPTED");
    await client.query("ROLLBACK TO SAVEPOINT real_hold");
    assert.equal((await client.query("SELECT id FROM app.claim_inbound_events($1,100)", [randomUUID()])).rows.some(row => row.id === eventId), true);
    assert.equal((await client.query("SELECT status FROM public.event_inbox WHERE id=$1", [eventId])).rows[0].status, "PROCESSING");
  });
}

async function insertPrivacyJob(admin, job, lease) {
  const snapshot = job.jobType === "RETENTION_SWEEP" ? job.unmatchedDiagnosticHours : null;
  const row = (await admin.query(`INSERT INTO public.privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,stage,lease_id,lease_expires_at,fencing_token,unmatched_diagnostic_hours_snapshot,created_at,attempts)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$1::text,'RUNNING','DISCOVER',$7,clock_timestamp()+interval '5 minutes',1,$8::integer,$9::timestamptz,1)
    RETURNING unmatched_diagnostic_hours_snapshot,created_at,attempts`,
  [job.id, job.tenantId, job.jobType, job.scopeType, job.scopeValue, job.disposition, lease, snapshot, job.createdAt])).rows[0];
  assert.deepEqual({ snapshot: row.unmatched_diagnostic_hours_snapshot, createdAt: row.created_at.toISOString(), attempts: row.attempts },
    { snapshot, createdAt: job.createdAt, attempts: job.attempts }, "persisted privacy setup must match the immutable worker snapshot");
}

async function verifySyncRecovery(fixture) {
  const { admin, db, worker, processor, service, controller, request, tenantId, nextPhone, syncRequests, appId, account, drain } = fixture;
  const setup = async (contacts = true) => {
    const phone = nextPhone();
    const start = await service.start(request, { name: "Sync recovery fixture", payerMode: "CUSTOMER", idempotencyKey: randomUUID(), variant: "BUSINESS_APP",
      coexistenceConsent: { version: "2026-10-07", contacts, history: true, echoes: true } });
    const choices = await service.exchange(request, start.attemptId, { challenge: start.challenge, code: randomUUID(), expectedRevision: start.revision });
    const selected = await controller.signupSelect(request, start.attemptId, { expectedRevision: choices.revision, selectionRevision: choices.selectionRevision, choiceId: choices.choices[0].choiceId });
    assert.equal((await processor.drainTenant(tenantId)).succeeded, 1);
    const context = (await admin.query("SELECT * FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, selected.connectionId])).rows[0];
    return { phone, context };
  };
  const failures = [], fetchBefore = globalThis.fetch, requestBefore = worker.coexistenceRequest;
  const independent = async (name, run) => {
    const state = (await admin.query(`SELECT tenant.state AS tenant_state,membership.state AS member_state,membership.role,
      (SELECT count(*)::int FROM connection_operations WHERE tenant_id=$1 AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) AS operations,
      (SELECT count(*)::int FROM event_inbox WHERE tenant_id=$1 AND status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')) AS events,
      (SELECT count(*)::int FROM privacy_jobs WHERE tenant_id=$1 AND state NOT IN ('SUCCEEDED','CANCELLED')) AS privacy,
      (SELECT count(*)::int FROM provider_sessions WHERE tenant_id=$1 AND worker_id IS NOT NULL AND lease_expires_at>=clock_timestamp()) AS leases
      FROM tenants tenant JOIN tenant_memberships membership ON membership.tenant_id=tenant.id AND membership.user_id=$2 WHERE tenant.id=$1`,
    [tenantId, request.principal.userId])).rows[0];
    if (!state || state.tenant_state !== "ACTIVE" || state.member_state !== "ACTIVE" || !["tenant_owner", "tenant_admin"].includes(state.role) || state.operations || state.events || state.privacy || state.leases || globalThis.fetch !== fetchBefore || worker.coexistenceRequest !== requestBefore) {
      failures.push(new Error(`${name}: shared fixture is not settled; no claims, resets or cleanup attempted`));
      console.log(JSON.stringify({ metaCoexistenceScenario: name, result: "SKIP_DEPENDENCY", dependency: "unsettled shared fixture", state }));
      return { passed: false };
    }
    return collectCoexistenceScenario(failures, name, run);
  };
  const beforeAccepted = [...syncRequests];
  await independent("sync-accepted", async () => {
  const accepted = await setup();
  assert.equal((await processor.drainTenant(tenantId)).succeeded, 1);
  assert.deepEqual(syncRequests, [...beforeAccepted, "smb_app_state_sync", "history"]);
  assert.equal((await processor.drainTenant(tenantId)).claimed, 0);
  const receipt = (await admin.query("SELECT contacts_request,history_request FROM meta_coexistence_contexts WHERE id=$1", [accepted.context.id])).rows[0];
  assert.equal(receipt.contacts_request.state, "ACCEPTED"); assert.equal(receipt.history_request.state, "ACCEPTED");

  });

  let uncertain;
  const beforeUnknown = [...syncRequests];
  const unknownResult = await independent("sync-unknown-contact-projection", async () => {
  uncertain = await setup();
  const lease = randomUUID(), [job] = await worker.claim(tenantId, lease, 1);
  const session = await worker.acquireProviderSessionLease(job, lease, "unknown-sync-fixture");
  await worker.coexistenceRequest(job, lease, session, "contacts", "CLAIMED");
  await admin.query("UPDATE connection_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [session.id]));
  const resumedLease = randomUUID(), [resumed] = await worker.claim(tenantId, resumedLease, 1);
  assert.ok(resumed); assert.equal(resumed.id, job.id);
  const resumedSession = await worker.acquireProviderSessionLease(resumed, resumedLease, "unknown-sync-recovery");
  assert.equal(await worker.coexistenceRequest(resumed, resumedLease, resumedSession, "contacts", "CLAIMED"), false);
  assert.equal(await worker.coexistenceRequest(resumed, resumedLease, resumedSession, "history", "CLAIMED"), false);
  assert.equal(await worker.coexistenceRequest(resumed, resumedLease, resumedSession, "contacts", "ACCEPTED", "late-result"), false);
  const value = { messaging_product: "whatsapp", metadata: { phone_number_id: uncertain.phone, display_phone_number: "12025550161" },
    state_sync: [{ type: "contact", contact: { phone_number: "15555550996" }, action: "add", metadata: { timestamp: String(Math.floor(Date.now()/1000)) } }] };
  const [unit] = metaCoexistenceUnits(account, "smb_app_state_sync", value);
  const acceptedCallback = await db.acceptMetaCoexistenceEvent({ tenant_id: tenantId, connection_id: uncertain.context.connection_id, provider: "META", hmac_secret_reference: process.env.META_APP_SECRET_REFERENCE },
    { unit, appId, sourceSha256: unit.sourceSha256 });
  await worker.finishCoexistence(resumed, resumedLease, resumedSession);
  const unknown = (await admin.query("SELECT contacts_request,history_request FROM meta_coexistence_contexts WHERE id=$1", [uncertain.context.id])).rows[0];
  assert.equal(unknown.contacts_request.state, "UNKNOWN"); assert.equal(unknown.history_request.state, "HELD_CONTACTS_UNKNOWN");
  assert.deepEqual(syncRequests, beforeUnknown, "lease recovery and callbacks never replay an uncertain request");

  // PAUSE waits for older inbox work and immediately closes route admission. Project
  // this already-authorized callback first, using the existing inert worker path.
  assert.deepEqual((await admin.query(`SELECT status,safe_error,meta_coexistence_admission->>'contextId' AS context_id
    FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3`,
  [tenantId, uncertain.context.connection_id, acceptedCallback.id])).rows,
  [{ status: "ACCEPTED", safe_error: null, context_id: uncertain.context.id }]);
  assert.deepEqual(await drain.drainTenant(tenantId), { events: 1, acknowledgements: 0 });
  assert.deepEqual((await admin.query("SELECT status,safe_error,payload,lease_id,lease_expires_at FROM event_inbox WHERE tenant_id=$1 AND id=$2",
    [tenantId, acceptedCallback.id])).rows,
  [{ status: "PROCESSED", safe_error: null, payload: {}, lease_id: null, lease_expires_at: null }]);
  assert.deepEqual((await admin.query(`SELECT subject_phone,source_event_id,action,redacted_at FROM meta_coexistence_contacts
    WHERE tenant_id=$1 AND context_id=$2`, [tenantId, uncertain.context.id])).rows,
  [{ subject_phone: "15555550996", source_event_id: acceptedCallback.id, action: "add", redacted_at: null }]);
  assert.deepEqual((await admin.query("SELECT contacts_request,history_request FROM meta_coexistence_contexts WHERE id=$1", [uncertain.context.id])).rows[0], unknown,
    "observed contact projection cannot turn an uncertain request into acceptance");
  assert.deepEqual(syncRequests, beforeUnknown, "inert projection makes no provider request");
  for (const table of ["normalized_messages", "message_links", "bot_conversations", "delivery_outbox", "participant_identities", "meta_direct_identity_aliases"]) {
    assert.equal((await admin.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND connection_id=$2`, [tenantId, uncertain.context.connection_id])).rows[0].n, 0, table);
  }
  });
  if (unknownResult.passed) await independent("same-context-renewal", () => verifyCoexistenceRenewal(fixture, uncertain.context));
  else console.log(JSON.stringify({ metaCoexistenceScenario: "same-context-renewal", result: "SKIP_DEPENDENCY", dependency: "sync-unknown-contact-projection" }));

  const beforeHistory = [...syncRequests];
  await independent("history-only", async () => {


  const historyOnly = await setup(false);
  assert.equal((await processor.drainTenant(tenantId)).succeeded, 1);
  assert.deepEqual(syncRequests, [...beforeHistory, "history"]);
  assert.equal((await admin.query("SELECT contacts_request->>'state' AS state FROM meta_coexistence_contexts WHERE id=$1", [historyOnly.context.id])).rows[0].state, "NOT_REQUESTED");
  });
  for (const boundary of ["consent", "actor", "tenant-delete", "hold", "configuration"]) await independent(`dispatch-guard:${boundary}`, async () => {

    const guarded = await setup(), before = syncRequests.length, privacyId = randomUUID();
    const original = worker.coexistenceRequest, originalConfig = process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID;
    const remainingOwner = boundary === "actor" ? randomUUID() : null;
    if (remainingOwner) {
      await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Synthetic remaining owner')", [remainingOwner, `coexistence-owner-${remainingOwner}`, `coexistence-owner-${remainingOwner}@example.invalid`]);
      assert.equal((await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')", [tenantId, remainingOwner])).rowCount, 1);
    }
    let boundaryChanged = false;
    worker.coexistenceRequest = async function (...args) {
      const result = await original.apply(this, args);
      if (result && args[3] === "contacts" && args[4] === "CLAIMED") {
        if (boundary === "consent") assert.equal((await admin.query("UPDATE meta_coexistence_contexts SET consent_echoes=false,consent_history=false,consent_contacts=false,hold_reason='STOPPED' WHERE id=$1", [guarded.context.id])).rowCount, 1);
        if (boundary === "actor") {
          assert.equal((await admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2", [tenantId, request.principal.userId])).rowCount, 1);
          assert.equal((await admin.query("SELECT state FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenantId, request.principal.userId])).rows[0].state, "SUSPENDED");
        }
        if (boundary === "hold") assert.equal((await admin.query("UPDATE meta_coexistence_contexts SET hold_reason='REVIEW_REQUIRED' WHERE id=$1", [guarded.context.id])).rowCount, 1);
        if (boundary === "configuration") process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID = "999999999999999";
        if (boundary === "tenant-delete") assert.equal((await admin.query(`INSERT INTO privacy_jobs(id,tenant_id,job_type,scope_type,scope_value,disposition,idempotency_key)
          VALUES($1::uuid,$2::uuid,'DELETE','TENANT',$2::text,'RETENTION_DELETE',$1::text)`, [privacyId, tenantId])).rowCount, 1);
        boundaryChanged = true;
      }
      return result;
    };
    try {
      await processor.drainTenant(tenantId);
      assert.equal(boundaryChanged, true, `${boundary} fixture must change authority after the consumed claim`);
      assert.equal(syncRequests.length, before, `${boundary} after claim must prevent actual HTTP`);
      const state = (await admin.query("SELECT contacts_request,history_request FROM meta_coexistence_contexts WHERE id=$1", [guarded.context.id])).rows[0];
      assert.equal(state.contacts_request.state, "UNKNOWN"); assert.equal(state.history_request.state, "HELD_CONTACTS_UNKNOWN");
    } finally {
      worker.coexistenceRequest = original;
      process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID = originalConfig;
      if (boundary === "actor") {
        assert.equal((await admin.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2", [tenantId, request.principal.userId])).rowCount, 1);
        assert.equal((await admin.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenantId, remainingOwner])).rowCount, 1);
        assert.equal((await admin.query("DELETE FROM users WHERE id=$1", [remainingOwner])).rowCount, 1);
      }
      if (boundary === "tenant-delete") await admin.query("DELETE FROM privacy_jobs WHERE id=$1", [privacyId]);
    }
  });
  if (failures.length) throw new AggregateError(failures, "Coexistence independent sync/renewal failures");
}

async function verifyCoexistenceRenewal(fixture, originalContext) {
  const { admin, db, processor, service, controller, request, stored, secrets, credentials, tenantId, syncRequests, privacyRepository } = fixture;
  const connectionId = originalContext.connection_id;
  const capture = async () => (await admin.query("SELECT * FROM meta_coexistence_contexts WHERE id=$1", [originalContext.id])).rows[0];
  const stable = row => { const retained = { ...row }; delete retained.credential_fingerprint; delete retained.revision; delete retained.updated_at; return retained; };
  const select = view => ({ expectedRevision: view.revision, selectionRevision: view.selectionRevision, choiceId: view.choices.find(choice => choice.selectable)?.choiceId });
  const pause = await controller.pause(request, connectionId, randomUUID());
  assert.deepEqual(await processor.drainTenant(tenantId), { claimed: 1, succeeded: 1, failedRetryable: 0, failedTerminal: 0, leaseLost: 0 });
  assert.deepEqual((await admin.query(`SELECT state,error_code,safe_error,result,lease_id,lease_expires_at FROM connection_operations
    WHERE tenant_id=$1 AND connection_id=$2 AND id=$3`, [tenantId, connectionId, pause.operation.id])).rows,
  [{ state: "SUCCEEDED", error_code: null, safe_error: null, result: { paused: true }, lease_id: null, lease_expires_at: null }]);
  assert.deepEqual((await admin.query(`SELECT c.state AS connection_state,s.state AS session_state,s.ownership_state,
    s.worker_id,s.lease_expires_at,r.state AS route_state FROM connections c
    JOIN provider_sessions s ON s.tenant_id=c.tenant_id AND s.connection_id=c.id AND s.id=$3
    JOIN webhook_routes r ON r.tenant_id=c.tenant_id AND r.connection_id=c.id AND r.provider='META'
    WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, connectionId, originalContext.provider_session_id])).rows,
  [{ connection_state: "PAUSED", session_state: "PAUSED", ownership_state: "ACTIVE", worker_id: null, lease_expires_at: null, route_state: "PAUSED" }]);
  const before = await capture(), syncBefore = [...syncRequests];
  assert.equal(before.contacts_request.state, "UNKNOWN"); assert.equal(before.history_request.state, "HELD_CONTACTS_UNKNOWN");
  const oldFetch = globalThis.fetch, oldStore = secrets.storeMetaCredential, oldInspect = credentials.inspectSignupConnection, oldComplete = service.completeRotation;
  let version = 0, rotationWrites = 0, loseWrite = true, absent = false, nextToken;
  const originalToken = stored.get((await admin.query("SELECT secret_reference FROM connections WHERE id=$1", [connectionId])).rows[0].secret_reference).accessToken;
  const issued = new Set([originalToken]);
  credentials.inspectSignupConnection = async reference => absent ? undefined : stored.get(reference);
  secrets.storeMetaCredential = async (reference, value) => {
    stored.set(reference, value);
    if (reference.includes("/meta/rotations/")) { rotationWrites++; if (loseWrite) throw Error("synthetic accepted write with lost response"); }
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/access_token")) { nextToken = `synthetic-coexistence-renewal-${++version}`; issued.add(nextToken); return Response.json({ access_token: nextToken }); }
    assert.equal(init.method ?? "GET", "GET", "Auth-only renewal cannot register, subscribe, sync or send");
    if (!url.pathname.endsWith("/debug_token")) assert.ok(issued.has(init.headers.authorization.slice(7)));
    return oldFetch(input, { ...init, headers: { ...init.headers, authorization: `Bearer ${originalToken}` } });
  };
  service.completeRotation = async function (client, selection) {
    await client.query("CREATE TEMP TABLE meta_coexistence_contexts AS SELECT * FROM public.meta_coexistence_contexts WITH NO DATA");
    try { return await oldComplete.call(this, client, selection); }
    finally { await client.query("DROP TABLE pg_temp.meta_coexistence_contexts"); }
  };
  const authorize = async () => {
    const start = await service.start(request, { name: "Renew retained app access", payerMode: "CUSTOMER", idempotencyKey: randomUUID(), targetConnectionId: connectionId });
    assert.equal(start.sdk.variant ?? "STANDARD", "STANDARD"); assert.equal(start.sdk.extras, undefined);
    const view = await service.exchange(request, start.attemptId, { challenge: start.challenge, code: randomUUID(), expectedRevision: start.revision });
    assert.equal(view.target.mode, "COEXISTENCE"); assert.equal(view.coexistenceConsent, undefined);
    assert.equal(view.choices.filter(choice => choice.selectable).length, 1); return view;
  };
  try {
    for (const role of ["app", "worker"]) await withCoexistenceLookupClient(fixture, role, async client => {
      await client.query("SAVEPOINT direct_repin");
      await assert.rejects(() => client.query("UPDATE public.meta_coexistence_contexts SET credential_fingerprint=repeat('e',64) WHERE id=$1", [before.id]), error => error.code === "42501");
      await client.query("ROLLBACK TO SAVEPOINT direct_repin");
      await client.query("CREATE TEMP TABLE meta_signup_attempts AS SELECT * FROM public.meta_signup_attempts WITH NO DATA");
      await client.query("SAVEPOINT forged_renewal");
      await assert.rejects(() => client.query("SELECT app.rebind_meta_coexistence_credential($1,$2)", [randomUUID(), randomUUID()]), error => error.code === (role === "worker" ? "42501" : "23514"));
      await client.query("ROLLBACK TO SAVEPOINT forged_renewal");
      if (role === "app") {
        const snapshot = (await client.query(`SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(id,job_type,state,stage,created_at,updated_at)
          ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex') AS value FROM public.privacy_jobs WHERE tenant_id=$1 AND job_type IN ('DELETE','RETENTION_SWEEP')`, [tenantId])).rows[0].value;
        await client.query("CREATE TEMP TABLE privacy_jobs AS SELECT * FROM public.privacy_jobs WITH NO DATA");
        assert.equal((await client.query("SELECT app.meta_coexistence_privacy_snapshot() AS value")).rows[0].value, snapshot);
      }
    });
    await assert.rejects(() => controller.rotateMetaCredential(request, connectionId, randomUUID(), { accessToken: originalToken }), /Renew access/);
    let view = await authorize();
    view = await controller.signupSelect(request, view.attemptId, select(view));
    assert.equal(view.status, "SELECTION_REQUIRED"); assert.equal(rotationWrites, 1); assert.deepEqual(await capture(), before);
    const operation = (await admin.query("SELECT * FROM connection_operations WHERE id=$1", [view.operationId])).rows[0];
    assert.ok((await admin.query("SELECT connection_credential_write_claimed_at FROM meta_signup_attempts WHERE id=$1", [view.attemptId])).rows[0].connection_credential_write_claimed_at);
    const captureBinding = async () => (await admin.query(`SELECT to_jsonb(c) AS connection,to_jsonb(s) AS session FROM public.connections c
      JOIN public.provider_sessions s ON s.tenant_id=c.tenant_id AND s.connection_id=c.id AND s.id=$2 WHERE c.id=$1`, [connectionId, before.provider_session_id])).rows[0];
    const inactiveBinding = await captureBinding(), inactiveSecrets = structuredClone([...stored]);
    assert.equal((await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1 AND state='ACTIVE'", [tenantId])).rowCount, 1);
    try {
      assert.equal((await admin.query("SELECT state FROM tenants WHERE id=$1", [tenantId])).rows[0].state, "SUSPENDED");
      await withCoexistenceLookupClient(fixture, "app", async client => {
        await assert.rejects(() => client.query("SELECT app.rebind_meta_coexistence_credential($1,$2)", [view.attemptId, view.operationId]),
          error => error.code === "42501" && error.message === "coexistence renewal tenant is inactive");
      });
      assert.deepEqual(await capture(), before); assert.deepEqual(await captureBinding(), inactiveBinding);
      assert.deepEqual((await admin.query("SELECT * FROM connection_operations WHERE id=$1", [view.operationId])).rows[0], operation);
      assert.deepEqual([...stored], inactiveSecrets); assert.equal(rotationWrites, 1);
    } finally {
      assert.equal((await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1 AND state='SUSPENDED'", [tenantId])).rowCount, 1);
    }
    absent = true; loseWrite = false;
    const reread = await controller.signupSelect(request, view.attemptId, select(view));
    assert.equal(reread.status, "SELECTION_REQUIRED"); assert.equal(rotationWrites, 1);
    await assert.rejects(() => service.cancel(request, view.attemptId, { expectedRevision: reread.revision }), /unknown|confirmed/);
    absent = false; view = await controller.signupSelect(request, reread.attemptId, select(reread));
    assert.equal(view.outcome, "ACCESS_RENEWED_PAUSED"); assert.equal(rotationWrites, 1);
    const after = await capture(); assert.deepEqual(stable(after), stable(before)); assert.equal(after.revision, before.revision+1);
    assert.notEqual(after.credential_fingerprint, before.credential_fingerprint);
    const binding = (await admin.query(`SELECT c.secret_reference,c.state,s.id,s.provider_state_data FROM connections c
      JOIN provider_sessions s ON s.tenant_id=c.tenant_id AND s.connection_id=c.id AND s.ownership_state='ACTIVE' WHERE c.id=$1`, [connectionId])).rows[0];
    assert.equal(binding.state, "PAUSED"); assert.equal(binding.id, before.provider_session_id); assert.equal(binding.secret_reference, operation.payload.newSecretReference);
    assert.equal(binding.provider_state_data.metaAccountProof.credentialFingerprint, after.credential_fingerprint);
    assert.equal(binding.provider_state_data.metaSignup.attemptId, before.signup_attempt_id);
    const historical = view.attemptId;
    let second = await authorize(); second = await controller.signupSelect(request, second.attemptId, select(second));
    assert.equal(second.outcome, "ACCESS_RENEWED_PAUSED"); const newer = await capture();
    assert.equal((await service.get(request, historical)).outcome, "ACCESS_RENEWED_PAUSED"); assert.deepEqual(await capture(), newer);
    // A completed deletion changes privacy authority even when it leaves the context row unchanged.
    let privacyRace = await authorize(); loseWrite = true;
    privacyRace = await controller.signupSelect(request, privacyRace.attemptId, select(privacyRace));
    const claimedWrites = rotationWrites, privacyLease = randomUUID(); loseWrite = false;
    const privacy = { id: randomUUID(), tenantId, jobType: "DELETE", scopeType: "PARTICIPANT", scopeValue: "15555550996", createdAt: new Date().toISOString(),
      stage: "DISCOVER", state: "RUNNING", fencingToken: 1, disposition: "RETENTION_DELETE", unmatchedDiagnosticHours: 24, exportTtlHours: 24, attempts: 1, maxAttempts: 25 };
    await insertPrivacyJob(admin, privacy, privacyLease); await privacyRepository.discover(privacy, privacyLease); await privacyRepository.finalize(privacy, privacyLease);
    assert.equal((await admin.query("SELECT state FROM privacy_jobs WHERE id=$1", [privacy.id])).rows[0].state, "SUCCEEDED");
    assert.equal((await admin.query("SELECT count(*)::int n FROM privacy_job_targets WHERE job_id=$1 AND target_type='META_COEXISTENCE_SUBJECT_CUTOFF' AND target_id=$2",
      [privacy.id, coexistenceSubjectDigest(tenantId, newer.app_id, newer.phone_id, "15555550996")])).rows[0].n, 1);
    assert.deepEqual(await capture(), newer, "participant deletion must exercise the privacy fence independently of context CAS");
    await assert.rejects(() => controller.signupSelect(request, privacyRace.attemptId, select(privacyRace)), /paused connection|changed/i);
    assert.equal(rotationWrites, claimedWrites); assert.deepEqual(await capture(), newer);
    assert.equal((await admin.query("SELECT state FROM connection_operations WHERE id=$1", [privacyRace.operationId])).rows[0].state, "STAGED");
    assert.equal((await service.cancel(request, privacyRace.attemptId, { expectedRevision: privacyRace.revision })).status, "CANCELLED", "only a matching staged-secret read permits cancellation");
    const stale = await authorize();
    const reader = new MetaCoexistenceController(db);
    await reader.stop(request, connectionId, { expectedRevision: newer.revision, contacts: false, history: false, echoes: false });
    const stopped = await capture(), writesBeforeStale = rotationWrites;
    await assert.rejects(() => controller.signupSelect(request, stale.attemptId, select(stale)), /paused connection|changed/i);
    assert.equal(rotationWrites, writesBeforeStale); assert.deepEqual(await capture(), stopped);
    assert.deepEqual(stopped.contacts_request, before.contacts_request); assert.deepEqual(stopped.history_request, before.history_request);
    assert.deepEqual(syncRequests, syncBefore, "Renewal/replay never creates another SMB request");
    assert.equal((await admin.query("SELECT count(*)::int n FROM connection_operations WHERE connection_id=$1 AND operation_type='SYNC_META_APP'", [connectionId])).rows[0].n, 1);
  } finally { globalThis.fetch = oldFetch; secrets.storeMetaCredential = oldStore; credentials.inspectSignupConnection = oldInspect; service.completeRotation = oldComplete; }
}
