import {withFixtureTenant} from './meta-routing-fixture.mjs';
import {verifyMetaSavedAccessActivation} from "./meta-add-access-activation-postgres.mjs";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Client, Pool } from "pg";
import { DatabaseService } from "../services/control-api/dist/database.service.js";
import { MetaSignupService } from "../services/control-api/dist/meta-signup.service.js";
import { ConnectionsController } from "../services/control-api/dist/connections.controller.js";
import { MetaGroupsClientFactory } from "../services/control-api/dist/meta-groups.client.js";
import { ConnectionOperationProcessor } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js";
import { ConnectionOperationRepository } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";
import { verifyMetaCoexistence } from "./meta-coexistence-postgres.mjs";

async function assertSignupRuntimeSchemas(client) {
  const privileges = (await client.query(`SELECT
    pg_catalog.has_schema_privilege(current_user,'public','CREATE') public_create,
    pg_catalog.has_schema_privilege(current_user,'app','CREATE') app_create,
    pg_catalog.has_database_privilege(current_user,current_database(),'TEMP') temp_create`)).rows[0];
  assert.deepEqual(privileges, { public_create: false, app_create: false, temp_create: true });
}

async function assertSignupLookupCatalog(admin) {
  // Explicit source-defined owners/grants, not a snapshot taken after a privilege change.
  const functions = [
    ['app.meta_signup_operation_current(uuid,uuid,uuid,uuid,jsonb,text,text,text,text)', ['wasalx_connector_worker']],
    ['app.meta_signup_phone_available(text)', ['wasalx_app']],
    ['app.secret_cleanup_reference_is_owned(text,uuid,uuid,uuid,uuid,uuid,text)', ['wasalx_secret_cleanup_executor']],
    ['app.enforce_secret_cleanup_reference()', []],
    ['app.expire_meta_signup_attempts()', ['wasalx_secret_cleanup_executor']],
    ['app.claim_secret_cleanup_tasks(uuid,integer)', ['wasalx_secret_cleanup_client']],
    ['app.expire_secret_provisioning_stages()', ['wasalx_secret_cleanup_executor']],
    ['app.enqueue_routing_integration_secret_cleanup()', []],
    ['app.enforce_audit_event_actor_membership()', []],
    ['app.enforce_consent_actor_membership()', []],
    ['app.discover_meta_signup_privacy(uuid,uuid,bigint)', ['wasalx_connector_worker']],
    ['app.export_meta_signup_privacy(uuid,uuid,bigint)', ['wasalx_connector_worker']],
    ['app.redact_meta_signup_privacy(uuid,uuid,bigint)', ['wasalx_connector_worker']],
  ];
  for (const [signature, grantees] of functions) {
    const rows = (await admin.query(`SELECT p.prosecdef,p.proconfig,
      pg_catalog.pg_get_userbyid(p.proowner) owner,
      pg_catalog.pg_get_userbyid(n.nspowner) schema_owner,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        ORDER BY a.grantee)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner),'[]'::jsonb) grants
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='app' AND p.oid=pg_catalog.to_regprocedure($1)`, [signature])).rows;
    assert.equal(rows.length, 1, signature);
    const value = rows[0];
    assert.equal(value.prosecdef, true, signature);
    assert.equal(value.owner, signature.startsWith('app.claim_secret_cleanup_tasks(')
      ? 'wasalx_secret_cleanup_executor' : value.schema_owner, signature);
    assert.equal(value.proconfig.find(setting => setting.startsWith('search_path='))?.replaceAll(' ', ''),
      'search_path=pg_catalog,public,app,pg_temp', signature);
    assert.ok(value.proconfig.includes('row_security=off'), signature);
    assert.deepEqual(value.grants.map(grant => grant.role).sort(), [...grantees].sort(), signature);
    for (const grant of value.grants) {
      assert.equal(grant.privilege, 'EXECUTE', signature);
      assert.equal(grant.grantable, false, signature);
    }
  }
}

// Shared canonical PostgreSQL gate invokes this using actual app/worker roles.
export async function verifyMetaSignup(adminUrl, appUrl, workerConfig, cleanupUrl) {
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  const oldEnv = { ...process.env }, oldFetch = globalThis.fetch;
  const tenantId = randomUUID(), actor = randomUUID(), otherActor = randomUUID(), foreignTenant = randomUUID();
  const account = "987654329", business = "333333339", appId = "12025550130";
  let phone = String(1_000_000_000 + Math.floor(Math.random()*1_000_000_000)), businessApp = false;
  const syncRequests = []; let syncTenantId=tenantId;
  const token = "synthetic-pg-signup-token-never-live";
  Object.assign(process.env, { DATABASE_URL: appUrl, META_SIGNUP_ENABLED: "true", META_SIGNUP_CUSTOMER_CONFIG_ID: "12025550160",
    META_APP_ID: appId, META_GRAPH_VERSION: "v24.0", META_APP_SECRET_REFERENCE: "secret://platform/meta-webhook", PORTAL_PUBLIC_ORIGIN: "https://portal.example.invalid",
    META_COEXISTENCE_ENABLED: "true", META_SIGNUP_BUSINESS_APP_CONFIG_ID: "12025550174" });
  const db = new DatabaseService(), workerPool = new Pool(workerConfig), worker = new ConnectionOperationRepository(workerPool);
  const cleanup = new Client({ connectionString: cleanupUrl }); await cleanup.connect();
  const stored = new Map(); let writes = 0, exchanges = 0, writeUnknown = false, exchangeUnknown = false, stageUnknown = false, phoneRegistered = false, registerCalls = 0;
  const secrets = { ready: async () => true, storeMetaCredential: async (reference, value) => { writes++; stored.set(reference, value); if (writeUnknown || (stageUnknown && reference.includes("/connections/"))) throw new Error("simulated lost acknowledgement"); } };
  const credentials = { resolveAccessToken: async reference => stored.get(reference)?.accessToken, resolveSignupConnection: async reference => { const value=stored.get(reference); if(!value) throw new Error("not stored"); return value; }, resolveSignupToken: async (reference) => { const value = stored.get(reference); if (!value) throw new Error("missing staged token"); return value.accessToken; } };
  const webhookSecrets = { resolveHmac: async () => "synthetic-app-secret-value" };
  const service = new MetaSignupService(db, secrets, credentials, webhookSecrets);
  const controller = new ConnectionsController(db, secrets, { wakeConnection: async () => {} }, new MetaGroupsClientFactory(), webhookSecrets, credentials, service);
  const request = { id: "signup-pg", headers: { origin: process.env.PORTAL_PUBLIC_ORIGIN }, principal: { subject: `signup-${actor}`, userId: actor, tenantId,
    role: "tenant_owner", email: "synthetic@example.invalid", displayName: "Synthetic owner", authenticatedAt: Math.floor(Date.now() / 1000), authenticationMethods: ["mfa"] } };
  const ownerQuery = (sql, values = []) => db.withTenant(tenantId, client => client.query(sql, values));
  const start = () => service.start(request, { name: "Signup fixture", payerMode: "CUSTOMER", idempotencyKey: randomUUID() });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://graph.facebook.com");
    if (url.pathname.endsWith("/oauth/access_token")) { exchanges++; if (exchangeUnknown) throw new Error("simulated lost exchange"); return Response.json({ access_token: token }); }
    if (url.pathname.endsWith("/debug_token")) return Response.json({ data: { app_id: appId, is_valid: true, expires_at: 0, user_id: "444444449",
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [account] }] } });
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    if (url.pathname === `/v24.0/${account}`) return Response.json({ id: account, name: "Customer", owner_business: { id: business, name: "Customer portfolio" } });
    if (url.pathname.endsWith("/owned_whatsapp_business_accounts")) return Response.json({ data: [{ id: account }] });
    if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: phone, display_phone_number: "12025550161", status: phoneRegistered ? "CONNECTED" : "PENDING", account_mode: "LIVE", host_platform: "CLOUD_API", code_verification_status: "VERIFIED" }] });
    if (url.pathname.endsWith('/register')) {registerCalls++;assert.fail('Terminal registration must never be sent again');}
    if (url.pathname.endsWith('/smb_app_data')) {
      const kind = JSON.parse(init.body).sync_type; syncRequests.push(kind);
      const context = (await admin.query("SELECT * FROM meta_coexistence_contexts WHERE tenant_id=$1 AND phone_id=$2", [syncTenantId, phone])).rows[0];
      assert.equal(context[kind === 'history' ? 'history_request' : 'contacts_request'].state, 'CLAIMED', 'irrevocable DB claim precedes HTTP');
      assert.equal((await admin.query("SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2", [syncTenantId, context.connection_id])).rows[0].state, 'ACTIVE');
      return Response.json({ request_id: `synthetic-${kind}` });
    }
    if (url.pathname.endsWith('/subscribed_apps')) return init.method==='POST'?Response.json({success:true}):Response.json({data:[{whatsapp_business_api_data:{id:appId}}]});
    if (url.searchParams.get('fields')==='health_status') return Response.json({health_status:{can_send_message:'AVAILABLE',entities:[{entity_type:'PHONE_NUMBER',id:phone,can_send_message:'AVAILABLE'},{entity_type:'WABA',id:account,can_send_message:'AVAILABLE'},{entity_type:'APP',id:appId,can_send_message:'AVAILABLE'}]}});
    if (url.searchParams.get('fields')?.includes('display_phone_number') && !url.pathname.endsWith('/phone_numbers')) return Response.json({display_phone_number:'12025550161',verified_name:'Synthetic'});
    if (url.pathname === `/v24.0/${phone}`) return Response.json({ id: phone, is_on_biz_app: businessApp, platform_type: "CLOUD_API" });
    assert.fail(`unexpected provider route ${url.pathname}`);
  };
  try {
    await assertSignupLookupCatalog(admin);
    await admin.query("INSERT INTO tenants(id,name,slug,state) VALUES($1,'Signup fixture',$2,'ACTIVE'),($3,'Foreign signup fixture',$4,'ACTIVE')", [tenantId, `signup-${tenantId}`, foreignTenant, `signup-${foreignTenant}`]);
    for (const userId of [actor, otherActor]) {
      await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Signup fixture')", [userId, `signup-${userId}`, `${userId}@example.invalid`]);
      await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')", [tenantId, userId]);
    }
    const historicalConnection=randomUUID(),historicalPhone=String(BigInt(phone)+10n);
    await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Historical','META','CLOUD_API','PAUSED',$3)",[historicalConnection,foreignTenant,`secret://${foreignTenant}/connections/${historicalConnection}/meta`]);
    await withFixtureTenant(admin,foreignTenant,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','REVOKED')",[foreignTenant,historicalConnection,historicalPhone]));
    assert.equal((await ownerQuery("SELECT app.meta_signup_phone_available($1) AS available",[historicalPhone])).rows[0].available,false,"Foreign revoked history retains global phone reservation");
    // New backend and temp relations before first privileged invocation: no safe-plan cache can hide shadowing.
    const phoneShadow = new Client({connectionString:appUrl}); await phoneShadow.connect();
    try {
      await assertSignupRuntimeSchemas(phoneShadow);
      await phoneShadow.query('BEGIN'); await phoneShadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      await phoneShadow.query('CREATE TEMP TABLE webhook_routes(provider text,external_key text)');
      assert.equal((await phoneShadow.query('SELECT app.meta_signup_phone_available($1) available',[historicalPhone])).rows[0].available,false);
      assert.equal((await phoneShadow.query('SELECT app.meta_signup_phone_available($1) available',[phone])).rows[0].available,true);
      assert.equal((await phoneShadow.query('SELECT count(*)::integer n FROM pg_temp.webhook_routes')).rows[0].n,0);
    } finally {await phoneShadow.query('ROLLBACK');await phoneShadow.end();}

    assert.equal((await service.capabilities(request)).enabled, true);
    await assert.rejects(() => service.start({ ...request, headers: { origin: "https://foreign.invalid" } }, { name: "X", payerMode: "CUSTOMER", idempotencyKey: randomUUID() }), /origin/);
    await assert.rejects(() => service.start(request, { name: "X", payerMode: "MANAGED", idempotencyKey: randomUUID() }), /invalid/);
    const key = randomUUID();
    const concurrent = await Promise.all([service.start(request, { name: "Same attempt", payerMode: "CUSTOMER", idempotencyKey: key }), service.start(request, { name: "Same attempt", payerMode: "CUSTOMER", idempotencyKey: key })]);
    assert.equal(concurrent[0].attemptId, concurrent[1].attemptId); assert.equal(concurrent.filter(value => value.challenge).length, 1);
    const first = concurrent.find(value => value.challenge);
    assert.equal((await ownerQuery("SELECT count(*)::integer AS n FROM meta_signup_attempts WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key])).rows[0].n, 1);
    const cleanupOwnerA = randomUUID(), cleanupOwnerB = randomUUID();
    for (const id of [cleanupOwnerA, cleanupOwnerB]) {
      await admin.query(`INSERT INTO public.meta_signup_attempts
        (id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,expires_at)
        SELECT $1::uuid,tenant_id,requested_by,'Cleanup owner fixture',$1::uuid::text,challenge_sha256,config,
          'secret://'||tenant_id::text||'/meta-signup/'||$1::uuid::text,clock_timestamp()+interval '10 minutes'
        FROM public.meta_signup_attempts WHERE id=$2`, [id, first.attemptId]);
    }
    const cleanupInsert = new Client({ connectionString: appUrl }); await cleanupInsert.connect();
    const cleanupRowId = randomUUID();
    try {
      await cleanupInsert.query('BEGIN');
      await cleanupInsert.query("SELECT pg_catalog.set_config('app.tenant_id',$1,true)", [tenantId]);
      await cleanupInsert.query('CREATE TEMP TABLE meta_signup_attempts(id uuid,tenant_id uuid,secret_reference text)');
      const referenceA = `secret://${tenantId}/meta-signup/${cleanupOwnerA}`;
      const referenceB = `secret://${tenantId}/meta-signup/${cleanupOwnerB}`;
      // Both FK owners are real. The forged A/B pairing must fail in the ownership trigger, not at an FK.
      await cleanupInsert.query('INSERT INTO pg_temp.meta_signup_attempts VALUES($1,$3,$4),($2,$3,$4)',
        [cleanupOwnerA, cleanupOwnerB, tenantId, referenceB]);
      const insertCleanup = `INSERT INTO public.secret_cleanup_outbox
        (id,tenant_id,meta_signup_attempt_id,cleanup_kind,secret_reference)
        VALUES($1,$2,$3,'META_SIGNUP_CREDENTIAL',$4)`;
      await cleanupInsert.query('SAVEPOINT wrong_owner');
      await assert.rejects(() => cleanupInsert.query(insertCleanup, [cleanupRowId, tenantId, cleanupOwnerA, referenceB]),
        error => error.code === '23514' && error.message === 'signup cleanup owner mismatch');
      await cleanupInsert.query('ROLLBACK TO SAVEPOINT wrong_owner');
      assert.equal((await cleanupInsert.query(insertCleanup, [cleanupRowId, tenantId, cleanupOwnerA, referenceA])).rowCount, 1);
      assert.equal((await cleanupInsert.query('SELECT count(*)::integer n FROM pg_temp.meta_signup_attempts WHERE id=$1 AND secret_reference=$2',
        [cleanupOwnerA, referenceB])).rows[0].n, 1);
    } finally { await cleanupInsert.query('ROLLBACK'); await cleanupInsert.end(); }
    assert.equal((await admin.query('SELECT count(*)::integer n FROM public.secret_cleanup_outbox WHERE id=$1', [cleanupRowId])).rows[0].n, 0);

    // P04 writes USER audit/optional consent. connection_operations.requested_by_id is text and has no generic actor trigger.
    const actorShadow = new Client({ connectionString: appUrl }); await actorShadow.connect();
    try {
      await actorShadow.query('BEGIN');
      await actorShadow.query("SELECT pg_catalog.set_config('app.tenant_id',$1,true)", [tenantId]);
      await actorShadow.query('CREATE TEMP TABLE tenant_memberships(tenant_id uuid,user_id uuid,state text,role text)');
      await actorShadow.query("INSERT INTO pg_temp.tenant_memberships VALUES($1,$2,'ACTIVE','tenant_owner')", [tenantId, otherActor]);
      await admin.query("UPDATE public.tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2", [tenantId, otherActor]);
      const auditId = randomUUID(), consentId = randomUUID();
      const auditSql = `INSERT INTO public.audit_events(id,tenant_id,actor_type,actor_id,action,target_type,target_id,request_id)
        VALUES($1,$2,'USER',$3,'meta.signup.shadow_fixture','meta_signup_attempt',$4,'signup-shadow-actor')`;
      const consentSql = `INSERT INTO public.consent_records(id,tenant_id,actor_id,policy_type,policy_version)
        VALUES($1,$2,$3,'META_OFFICIAL_GROUPS','shadow-fixture')`;
      for (const [sql, args] of [[auditSql, [auditId, tenantId, otherActor, first.attemptId]], [consentSql, [consentId, tenantId, otherActor]]]) {
        await actorShadow.query('SAVEPOINT revoked_actor');
        await assert.rejects(() => actorShadow.query(sql, args), error => error.code === '23503' && /actor must be an active member/.test(error.message));
        await actorShadow.query('ROLLBACK TO SAVEPOINT revoked_actor');
      }
      // No temporary membership exists for the genuine actor: success must come from the real membership.
      await actorShadow.query(auditSql, [auditId, tenantId, actor, first.attemptId]);
      await actorShadow.query(consentSql, [consentId, tenantId, actor]);
      assert.equal((await actorShadow.query('SELECT actor_id FROM public.audit_events WHERE id=$1', [auditId])).rows[0].actor_id, actor);
      assert.equal((await actorShadow.query('SELECT actor_id FROM public.consent_records WHERE id=$1', [consentId])).rows[0].actor_id, actor);
      assert.equal((await actorShadow.query('SELECT count(*)::integer n FROM pg_temp.tenant_memberships')).rows[0].n, 1);
    } finally {
      await actorShadow.query('ROLLBACK'); await actorShadow.end();
      await admin.query("UPDATE public.tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2", [tenantId, otherActor]);
    }
    await assert.rejects(() => service.get({ ...request, principal: { ...request.principal, userId: otherActor } }, first.attemptId), /not found/);
    assert.equal((await db.rows(foreignTenant, "SELECT id FROM meta_signup_attempts WHERE id=$1", [first.attemptId])).length, 0);
    await assert.rejects(() => service.exchange(request, first.attemptId, { challenge: "x".repeat(43), code: "bad-challenge", expectedRevision: 1 }), /changed/);
    let state = await service.exchange(request, first.attemptId, { challenge: first.challenge, code: randomUUID(), expectedRevision: 1 });
    assert.equal(state.status, "SELECTION_REQUIRED"); assert.equal(state.choices.length, 1); assert.equal(state.choices[0].selectable, true);
    assert.equal(state.readiness.payment.paymentMethodVerified, false);
    assert.doesNotMatch(JSON.stringify(state), /credential_|secret:\/\/|businessId|wabaId|phoneId|challenge|accessToken/);
    await assert.rejects(() => service.exchange(request, first.attemptId, { challenge: first.challenge, code: randomUUID(), expectedRevision: 1 }), /changed/);
    assert.equal(exchanges, 1);
    await assert.rejects(() => ownerQuery("UPDATE meta_signup_attempts SET config=jsonb_set(config,'{appId}','\"999999999\"') WHERE tenant_id=$1 AND id=$2", [tenantId, first.attemptId]), /immutable/);
    await assert.rejects(() => ownerQuery("UPDATE secret_cleanup_outbox SET secret_reference=$1 WHERE meta_signup_attempt_id=$2", [`secret://${tenantId}/meta-signup/${randomUUID()}`, first.attemptId]), /permission denied|owner/);
    const choice = state.choices[0];
    for (const registrationPin of [123456, ["123456"], { value: "123456" }, null]) {
      await assert.rejects(() => service.prepareSelection(request, first.attemptId, { choiceId: choice.choiceId,
        expectedRevision: state.revision, selectionRevision: state.selectionRevision, registrationPin }), /invalid/);
    }
    stageUnknown = true;
    state = await controller.signupSelect(request, first.attemptId, { choiceId: choice.choiceId, expectedRevision: state.revision, selectionRevision: state.selectionRevision });
    assert.equal(state.status, "SELECTION_REQUIRED"); assert.ok(state.connectionId); assert.ok(state.operationId);
    const stagedRef=`secret://${tenantId}/connections/${state.connectionId}/meta`;
    const originalPin=stored.get(stagedRef).registrationPin;
    await assert.rejects(() => controller.create(request,`meta-signup-${first.attemptId}`,{name:"Same attempt",provider:"META",phoneNumberId:phone,wabaId:account,accessToken:token}), /authorization context|changed/);
    const selectionBody={choiceId:choice.choiceId,expectedRevision:state.revision,selectionRevision:state.selectionRevision};
    await assert.rejects(() => controller.signupSelect(request,first.attemptId,{...selectionBody,registrationPin:originalPin==='123456'?'654321':'123456'}), /changed/);
    const oldNow=Date.now; Date.now=()=>oldNow()+11*60*1000;
    try { stageUnknown=false; state=await controller.signupSelect(request,first.attemptId,selectionBody); }
    finally {Date.now=oldNow;}
    assert.equal(stored.get(stagedRef).registrationPin,originalPin);
    assert.equal(state.status,"PROVISIONING");
    const operation = (await admin.query("SELECT * FROM connection_operations WHERE id=$1", [state.operationId])).rows[0]; assert.equal(operation.state, "QUEUED");
    const connection = (await admin.query("SELECT secret_reference FROM connections WHERE id=$1", [state.connectionId])).rows[0];
    assert.match(stored.get(connection.secret_reference).registrationPin, /^\d{6}$/);
    const lease = randomUUID(); const jobs = await worker.claim(tenantId, lease, 1); assert.equal(jobs.length, 1);
    const session = await worker.acquireProviderSessionLease(jobs[0], lease, "signup-pg-worker");
    await admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2",[tenantId,actor]);
    await assert.rejects(()=>worker.assertMetaSignupCurrent(jobs[0],lease,session),/authorization changed/);
    const originalAttempt=(await admin.query('SELECT * FROM public.meta_signup_attempts WHERE id=$1',[first.attemptId])).rows[0];
    const originalSession=(await admin.query("SELECT * FROM public.provider_sessions WHERE connection_id=$1 AND ownership_state='ACTIVE'",[originalAttempt.connection_id])).rows[0];
    const membershipShadow=new Client(workerConfig);await membershipShadow.connect();
    try {
      await assertSignupRuntimeSchemas(membershipShadow);
      await membershipShadow.query('BEGIN');await membershipShadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
      await membershipShadow.query(`CREATE TEMP TABLE meta_signup_attempts(tenant_id uuid,id uuid,requested_by uuid,connection_id uuid,operation_id uuid,status text,config jsonb,credential_fingerprint text,selected_choice jsonb);
        CREATE TEMP TABLE tenant_memberships(tenant_id uuid,user_id uuid,state text,role text);
        CREATE TEMP TABLE tenants(id uuid,state text);
        CREATE TEMP TABLE provider_sessions(tenant_id uuid,connection_id uuid,ownership_state text,opaque_session_id text,provider_state_data jsonb);
        CREATE TEMP TABLE connections(tenant_id uuid,id uuid,secret_reference text)`);
      await membershipShadow.query('INSERT INTO pg_temp.meta_signup_attempts SELECT * FROM jsonb_populate_record(NULL::pg_temp.meta_signup_attempts,$1)',[originalAttempt]);
      await membershipShadow.query("INSERT INTO pg_temp.tenant_memberships VALUES($1,$2,'ACTIVE','tenant_owner')",[tenantId,actor]);
      await membershipShadow.query("INSERT INTO pg_temp.tenants VALUES($1,'ACTIVE')",[tenantId]);
      await membershipShadow.query('INSERT INTO pg_temp.provider_sessions SELECT * FROM jsonb_populate_record(NULL::pg_temp.provider_sessions,$1)',[originalSession]);
      await membershipShadow.query('INSERT INTO pg_temp.connections VALUES($1,$2,$3)',[tenantId,originalAttempt.connection_id,connection.secret_reference]);
      const args=[tenantId,first.attemptId,originalAttempt.connection_id,originalAttempt.operation_id,originalAttempt.config,phone,account,business,originalAttempt.credential_fingerprint];
      const current='SELECT app.meta_signup_operation_current($1,$2,$3,$4,$5,$6,$7,$8,$9) current';
      assert.equal((await membershipShadow.query(current,args)).rows[0].current,false,'A forged temp active membership cannot restore real suspended authorization');
      await admin.query("UPDATE public.tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2",[tenantId,actor]);
      assert.equal((await membershipShadow.query(current,args)).rows[0].current,true,'Exact real authorization remains usable despite conflicting temp relations');
    } finally {await membershipShadow.query('ROLLBACK');await membershipShadow.end();}

    await admin.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2",[tenantId,actor]);
    await worker.assertMetaSignupCurrent(jobs[0],lease,session);
    assert.equal(await worker.claimMetaSignupRegistration(jobs[0], lease, session, first.attemptId), true);
    assert.equal(await worker.claimMetaSignupRegistration(jobs[0], lease, session, first.attemptId), false);
    await assert.rejects(() => worker.claimMetaSignupRegistration({ ...jobs[0], fencingToken: jobs[0].fencingToken + 1 }, lease, session, first.attemptId), /lease/);
    await worker.fail(jobs[0],lease,session,{retryable:false,code:'META_SIGNUP_REGISTRATION_UNKNOWN',safeError:'Synthetic unknown registration',connectionState:'ACTION_REQUIRED'});
    assert.equal((await service.get(request,first.attemptId)).status,'OUTCOME_UNKNOWN');
    const processor=new ConnectionOperationProcessor(worker,{resolve:async reference=>stored.get(reference)},{wahaBaseUrl:'https://unused.example.invalid',publicWebhookBaseUrl:'https://portal.example.invalid',metaGraphVersion:'v24.0',metaAppId:appId,workerIdentity:'signup-recovery-fixture'});
    await controller.start(request,state.connectionId,randomUUID());
    const pendingRecovery=await processor.drainTenant(tenantId);
    assert.equal(pendingRecovery.failedTerminal,1);
    assert.equal(registerCalls,0);
    phoneRegistered=true;
    await controller.start(request,state.connectionId,randomUUID());
    const registeredRecovery=await processor.drainTenant(tenantId);
    assert.equal(registeredRecovery.succeeded,1);
    assert.equal(registerCalls,0);
    assert.equal((await service.get(request,first.attemptId)).status,'COMPLETED');
    assert.equal((await admin.query('SELECT state,error_code FROM connection_operations WHERE id=$1',[state.operationId])).rows[0].error_code,'META_SIGNUP_REGISTRATION_UNKNOWN');
    assert.equal((await service.discover(request, (await start()).attemptId, { expectedRevision: 1 }).catch(() => ({ status: "rejected" }))).status, "rejected");

    const unknown = await start(); writeUnknown = true;
    state = await service.exchange(request, unknown.attemptId, { challenge: unknown.challenge, code: randomUUID(), expectedRevision: 1 });
    assert.equal(state.status, "OUTCOME_UNKNOWN"); assert.equal(state.reasonCode, "META_SIGNUP_CREDENTIAL_UNAVAILABLE");
    const before = { writes, exchanges }; writeUnknown = false;
    state = await service.discover(request, unknown.attemptId, { expectedRevision: state.revision });
    assert.equal(state.status, "SELECTION_REQUIRED"); assert.equal(state.choices[0].selectable, false, "Existing connection blocks duplicate ownership");
    assert.deepEqual({ writes, exchanges }, before, "Recovery only resolves the exact staged credential");
    const lost = await start(); exchangeUnknown = true;
    state = await service.exchange(request, lost.attemptId, { challenge: lost.challenge, code: randomUUID(), expectedRevision: 1 });
    assert.equal(state.status, "OUTCOME_UNKNOWN");
    await assert.rejects(() => service.exchange(request, lost.attemptId, { challenge: lost.challenge, code: randomUUID(), expectedRevision: state.revision }), /changed/);
    const cancelled = await start(); state = await service.cancel(request, cancelled.attemptId, { expectedRevision: 1 }); assert.equal(state.status, "CANCELLED");
    const cleanupContext=(await cleanup.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value;
    const claimed = await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,100)", [randomUUID()]);
    assert.equal((await cleanup.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value??'',cleanupContext??'','Cross-tenant maintenance leaves the original unset context empty');
    const cancelledRef = `secret://${tenantId}/meta-signup/${cancelled.attemptId}`;
    assert.equal(claimed.rows.some(row => row.secret_reference === cancelledRef), true);
    assert.equal(claimed.rows.some(row => row.secret_reference === `secret://${tenantId}/meta-signup/${lost.attemptId}`), false);
    assert.equal(claimed.rows.some(row => row.secret_reference === `secret://${tenantId}/meta-signup/${first.attemptId}`), false);
    const retentionKnown=randomUUID(),retentionUnknown=randomUUID(),holdId=randomUUID();
    for(const [id,status] of [[retentionKnown,'EXPIRED'],[retentionUnknown,'OUTCOME_UNKNOWN']]) {
      await admin.query(`INSERT INTO meta_signup_attempts(id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,status,choices,created_at,expires_at)
        SELECT $1::uuid,tenant_id,requested_by,'Sensitive fixture label',$1::uuid::text,challenge_sha256,config,'secret://'||tenant_id::text||'/meta-signup/'||$1::uuid::text,$2,'[{"businessName":"Sensitive business"}]'::jsonb,clock_timestamp()-interval '90 days',clock_timestamp()-interval '89 days' FROM meta_signup_attempts WHERE id=$3`,[id,status,first.attemptId]);
      await ownerQuery("INSERT INTO secret_cleanup_outbox(tenant_id,meta_signup_attempt_id,cleanup_kind,secret_reference) VALUES($1,$2,'META_SIGNUP_CREDENTIAL',$3)",[tenantId,id,`secret://${tenantId}/meta-signup/${id}`]);
    }
    await admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2::uuid,'TENANT',$2::uuid::text,repeat('a',64),'Synthetic retention hold',$3)",[holdId,tenantId,actor]);
    const cleanupShadow=new Client({connectionString:cleanupUrl});await cleanupShadow.connect();
    try {
      await assertSignupRuntimeSchemas(cleanupShadow);
      await cleanupShadow.query('BEGIN');
      await cleanupShadow.query('CREATE TEMP TABLE privacy_legal_holds(tenant_id uuid,state text,released_at timestamptz)');
      const observed=await cleanupShadow.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()]);
      assert.equal(observed.rows.some(row=>row.secret_reference.endsWith(retentionKnown)),false,'Empty caller-owned hold table cannot authorize cleanup of a real legally held credential');
      assert.equal(observed.rows.some(row=>row.secret_reference.endsWith(retentionUnknown)),false);
      assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1',[retentionKnown])).rows[0].name,'Sensitive fixture label');
      assert.equal((await cleanupShadow.query('SELECT count(*)::integer n FROM pg_temp.privacy_legal_holds')).rows[0].n,0);
    } finally {await cleanupShadow.query('ROLLBACK');await cleanupShadow.end();}
    const held=await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()]);
    assert.equal(held.rows.some(row=>row.secret_reference.endsWith(retentionKnown)),false);
    assert.equal((await admin.query('SELECT name FROM meta_signup_attempts WHERE id=$1',[retentionKnown])).rows[0].name,'Sensitive fixture label');
    await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1",[holdId,actor]);
    const released=await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)',[randomUUID()]);
    assert.equal(released.rows.some(row=>row.secret_reference.endsWith(retentionKnown)),true);
    assert.equal(released.rows.some(row=>row.secret_reference.endsWith(retentionUnknown)),false);
    assert.equal((await admin.query('SELECT name FROM meta_signup_attempts WHERE id=$1',[retentionKnown])).rows[0].name,'[removed]');
    assert.equal((await admin.query('SELECT name FROM meta_signup_attempts WHERE id=$1',[retentionUnknown])).rows[0].name,'Sensitive fixture label');
    // Positive callback effects commit only in the canonical disposable database, so admin can independently read them.
    // These append-only audit rows are retained until that database's teardown; no permission widening or SET ROLE.
    const expiredConnection = randomUUID(), expiredOperation = randomUUID(), expiredIntegration = randomUUID(), expiredAttempt = randomUUID();
    const expiredCredential = `secret://${tenantId}/connections/${expiredConnection}/meta`;
    const expiredRoutingSecret = `secret://tenants/${tenantId}/routing/integrations/${expiredIntegration}`;
    await admin.query(`INSERT INTO public.connections(id,tenant_id,name,provider,engine,state,secret_reference)
      VALUES($1,$2,'Expired signup stage fixture','META','CLOUD_API','PROVISIONING',$3)`, [expiredConnection, tenantId, expiredCredential]);
    await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO public.connection_operations
      (id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id,updated_at)
      VALUES($1,$2,$3,'PROVISION',$1::uuid::text,$4::jsonb,'STAGED','USER',$5,'signup-shadow-expiry',clock_timestamp()-interval '2 hours')`,
      [expiredOperation, tenantId, expiredConnection, { credentialReference: expiredCredential }, actor]));
    await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO public.webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state)
      VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','PAUSED')`, [tenantId, expiredConnection, String(BigInt(phone) + 30n)]));
    await admin.query(`INSERT INTO public.secret_cleanup_outbox
      (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
      VALUES($1,$2,$3,'CONNECTION_CREDENTIAL',$4)`, [tenantId, expiredConnection, expiredOperation, expiredCredential]);
    await admin.query(`INSERT INTO public.client_routing_integrations
      (id,tenant_id,provider,display_name,secret_reference,state,created_by,updated_at)
      VALUES($1,$2,'NOTION','Expired routing fixture',$3,'CONNECTING',$4,clock_timestamp()-interval '2 hours')`,
      [expiredIntegration, tenantId, expiredRoutingSecret, actor]);
    // INSERT already enqueues a stage task. Remove only this synthetic task to isolate the UPDATE revoke callback.
    assert.equal((await admin.query('DELETE FROM public.secret_cleanup_outbox WHERE tenant_id=$1 AND routing_integration_id=$2',
      [tenantId, expiredIntegration])).rowCount, 1);
    await admin.query(`INSERT INTO public.meta_signup_attempts
      (id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,status,created_at,expires_at)
      SELECT $1::uuid,tenant_id,requested_by,'Expired shadow retention fixture',$1::uuid::text,challenge_sha256,config,
        'secret://'||tenant_id::text||'/meta-signup/'||$1::uuid::text,'EXPIRED',
        clock_timestamp()-interval '90 days',clock_timestamp()-interval '89 days'
      FROM public.meta_signup_attempts WHERE id=$2`, [expiredAttempt, first.attemptId]);
    await ownerQuery(`INSERT INTO public.secret_cleanup_outbox(tenant_id,meta_signup_attempt_id,cleanup_kind,secret_reference)
      VALUES($1,$2,'META_SIGNUP_CREDENTIAL',$3)`, [tenantId, expiredAttempt, `secret://${tenantId}/meta-signup/${expiredAttempt}`]);
    const expiryShadow = new Client({ connectionString: cleanupUrl }); await expiryShadow.connect();
    try {
      // First privileged call is after all shadows exist. Empty fake stages must not hide real eligible public stages.
      await expiryShadow.query(`CREATE TEMP TABLE connection_operations(
          id uuid,tenant_id uuid,connection_id uuid,operation_type text,requested_by_id text,request_id text,
          payload jsonb,state text,error_code text,safe_error text,completed_at timestamptz,updated_at timestamptz);
        CREATE TEMP TABLE connections(id uuid,tenant_id uuid,provider text,secret_reference text,state text,action_reason text,updated_at timestamptz);
        CREATE TEMP TABLE webhook_routes(tenant_id uuid,connection_id uuid,hmac_secret_reference text,state text,updated_at timestamptz);
        CREATE TEMP TABLE client_routing_integrations(id uuid,tenant_id uuid,secret_reference text,state text,revision bigint,updated_at timestamptz);
        CREATE TEMP TABLE audit_events(tenant_id uuid,actor_type text,actor_id text,action text,target_type text,target_id text,new_value jsonb,request_id text);
        CREATE TEMP TABLE secret_cleanup_outbox(tenant_id uuid,routing_integration_id uuid,cleanup_kind text,secret_reference text);
        CREATE TEMP TABLE meta_signup_attempts(id uuid,tenant_id uuid,secret_reference text,status text,reason_code text,revision integer,
          name text,choices jsonb,credential_metadata jsonb,connection_id uuid,operation_id uuid,expires_at timestamptz,created_at timestamptz,updated_at timestamptz);
        CREATE TEMP TABLE tenants(id uuid,state text,retention_days integer);
        CREATE TEMP TABLE retention_policies(tenant_id uuid,state text);
        CREATE TEMP TABLE privacy_legal_holds(tenant_id uuid,state text,released_at timestamptz)`);
      await expiryShadow.query("INSERT INTO pg_temp.tenants VALUES($1,'DELETING',1)", [tenantId]);
      await expiryShadow.query("INSERT INTO pg_temp.retention_policies VALUES($1,'ACTIVE')", [tenantId]);
      await expiryShadow.query(`INSERT INTO pg_temp.meta_signup_attempts
        (id,tenant_id,secret_reference,status,revision,name,choices,expires_at,created_at)
        VALUES($1,$2,$3,'EXPIRED',1,'Forged terminal shadow','[]'::jsonb,clock_timestamp()-interval '89 days',clock_timestamp()-interval '90 days')`,
        [retentionUnknown, tenantId, `secret://${tenantId}/meta-signup/${retentionUnknown}`]);
      const callerTenant=randomUUID();await expiryShadow.query("SELECT set_config('app.tenant_id',$1,false)",[callerTenant]);
      const expiryLease = randomUUID();
      const expiryClaims = await expiryShadow.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)', [expiryLease]);
      assert.equal((await expiryShadow.query("SELECT current_setting('app.tenant_id',true) value")).rows[0].value,callerTenant,'Actual expired public stages restore a different caller tenant');
      for (const reference of [expiredCredential, expiredRoutingSecret, `secret://${tenantId}/meta-signup/${expiredAttempt}`]) {
        assert.equal(expiryClaims.rows.some(row => row.secret_reference === reference), true);
      }
      assert.equal(expiryClaims.rows.some(row => row.secret_reference === `secret://${tenantId}/meta-signup/${retentionUnknown}`), false);
      assert.deepEqual((await admin.query('SELECT state,error_code FROM public.connection_operations WHERE id=$1', [expiredOperation])).rows[0],
        { state: 'FAILED_TERMINAL', error_code: 'CREDENTIAL_STAGE_EXPIRED' });
      assert.equal((await admin.query('SELECT state FROM public.connections WHERE id=$1', [expiredConnection])).rows[0].state, 'REVOKED');
      assert.equal((await admin.query('SELECT state FROM public.webhook_routes WHERE tenant_id=$1 AND connection_id=$2', [tenantId, expiredConnection])).rows[0].state, 'REVOKED');
      assert.deepEqual((await admin.query('SELECT state,revision::integer revision FROM public.client_routing_integrations WHERE id=$1', [expiredIntegration])).rows[0],
        { state: 'REVOKED', revision: 2 });
      const callbackTask = (await admin.query(`SELECT id,state,lease_id,secret_reference FROM public.secret_cleanup_outbox
        WHERE tenant_id=$1 AND routing_integration_id=$2 AND cleanup_kind='ROUTING_INTEGRATION_SECRET'`, [tenantId, expiredIntegration])).rows;
      assert.equal(callbackTask.length, 1);
      assert.equal(callbackTask[0].state, 'RUNNING'); assert.equal(callbackTask[0].lease_id, expiryLease);
      assert.equal(callbackTask[0].secret_reference, expiredRoutingSecret);
      assert.equal(expiryClaims.rows.some(row => row.task_id === callbackTask[0].id), true);
      const expiryAudits = (await admin.query(`SELECT action,target_id,new_value FROM public.audit_events
        WHERE tenant_id=$1 AND actor_type='SYSTEM' AND actor_id='secret-cleanup'
          AND ((action='connection.credential_stage_expired' AND target_id=$2)
            OR (action='client_routing.integration_expired' AND target_id=$3))`,
        [tenantId, expiredConnection, expiredIntegration])).rows;
      assert.equal(expiryAudits.length, 2);
      assert.equal(expiryAudits.find(row => row.target_id === expiredConnection).new_value.operation_id, expiredOperation);
      assert.equal(expiryAudits.find(row => row.target_id === expiredIntegration).new_value.reason, 'CREDENTIAL_STAGE_EXPIRED');
      assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1', [expiredAttempt])).rows[0].name, '[removed]');
      assert.deepEqual((await admin.query('SELECT status,name FROM public.meta_signup_attempts WHERE id=$1', [retentionUnknown])).rows[0],
        { status: 'OUTCOME_UNKNOWN', name: 'Sensitive fixture label' });
      for (const table of ['connection_operations','connections','webhook_routes','client_routing_integrations','audit_events','secret_cleanup_outbox','privacy_legal_holds']) {
        assert.equal((await expiryShadow.query(`SELECT count(*)::integer n FROM pg_temp.${table}`)).rows[0].n, 0);
      }
      assert.deepEqual((await expiryShadow.query('SELECT status,name FROM pg_temp.meta_signup_attempts')).rows,
        [{ status: 'EXPIRED', name: 'Forged terminal shadow' }]);
    } finally { await expiryShadow.end(); }
    const removed = await service.start({...request,principal:{...request.principal,userId:otherActor}},{name:"Removed membership",payerMode:"CUSTOMER",idempotencyKey:randomUUID()});
    await admin.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",[tenantId,otherActor]);
    assert.equal((await admin.query("SELECT requested_by FROM meta_signup_attempts WHERE id=$1",[removed.attemptId])).rows[0].requested_by,null);
    const raw = (await admin.query("SELECT * FROM meta_signup_attempts WHERE tenant_id=$1", [tenantId])).rows;
    assert.doesNotMatch(JSON.stringify(raw), new RegExp(first.challenge)); assert.doesNotMatch(JSON.stringify(raw), new RegExp(token));
    assert.equal(raw.find(row => row.id === unknown.attemptId).credential_fingerprint, createHash("sha256").update(token).digest("hex"));
    await verifyPausedReauthorization({ admin, db, cleanup, service, controller, processor, request, stored, secrets, credentials,
      originalAttemptId: first.attemptId, phone, account, business, appId, foreignConnectionId: historicalConnection });
    await verifyMetaAddAccess({ admin, db, cleanup, workerPool, appUrl, workerConfig, cleanupUrl, service, controller, request, stored, secrets, credentials,
      phone, account, business, appId, foreignTenant, historicalPhone });
    // ADD_ACCESS uses the +100 range above; the later coexistence fixture owns a separate range.
    businessApp = true; phone = String(BigInt(phone) + 1000n); exchangeUnknown = false;
    // Keep deliberate P04 unknown outcomes intact. The P06 tenant-delete
    // positive owns a clean tenant and uses the same real signup producers.
    const coexistenceTenant=randomUUID(),unrelatedConnection=randomUUID();
    await admin.query("INSERT INTO public.tenants(id,name,slug,state) VALUES($1,'Isolated coexistence fixture',$2,'ACTIVE')",[coexistenceTenant,'coexistence-'+coexistenceTenant]);
    await admin.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')",[coexistenceTenant,actor]);
    await admin.query("INSERT INTO public.connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Unrelated paused fixture','META','CLOUD_API','PAUSED',$3)",[unrelatedConnection,coexistenceTenant,`secret://${coexistenceTenant}/connections/${unrelatedConnection}/meta`]);
    const coexistenceRequest={...request,principal:{...request.principal,tenantId:coexistenceTenant}};
    syncTenantId=coexistenceTenant;
    const coexistence = await verifyMetaCoexistence({ admin, db, worker, processor, service, controller, request:coexistenceRequest, stored, secrets, credentials, tenantId:coexistenceTenant, actor, phone, account, appId, syncRequests, workerConfig,
      nextPhone: () => (phone = String(BigInt(phone) + 1n)),
      createSyncRecoveryFixture:async()=>{
        const recoveryTenant=randomUUID();
        await admin.query("INSERT INTO public.tenants(id,name,slug,state) VALUES($1,'Isolated sync recovery fixture',$2,'ACTIVE')",[recoveryTenant,'sync-recovery-'+recoveryTenant]);
        await admin.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')",[recoveryTenant,actor]);
        syncTenantId=recoveryTenant;
        return{tenantId:recoveryTenant,request:{...request,principal:{...request.principal,tenantId:recoveryTenant}}};
      } });
    assert.equal(registerCalls, 0);
    for(const id of [lost.attemptId,retentionUnknown])assert.equal((await admin.query("SELECT tenant_id,status FROM public.meta_signup_attempts WHERE id=$1",[id])).rows[0].status,'OUTCOME_UNKNOWN','Isolated coexistence deletion never resolves or removes original unknown signup evidence');
    await verifySignupMetadataPrivacy(admin,appUrl,workerConfig,actor);
    return { authorization: "actor_origin_rls_cas", exchange: "one_use_no_replay", selection: "verified_bound", registration: "worker_role_claim_fenced", cleanup: "owned_unknown_retained", coexistence, liveProviderEvidence: false };
  } finally {
    globalThis.fetch = oldFetch;
    await Promise.all([db.onModuleDestroy(), worker.close(), cleanup.end(), admin.end()]);
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv);
  }
}

// Actual app/worker/cleanup roles exercise the same durable attempt and local
// connection operation. Graph and sidecar responses are explicitly simulated.
async function verifyMetaAddAccess({ admin, db, cleanup, workerPool, appUrl, workerConfig, cleanupUrl, service, controller, request, stored, secrets, credentials,
  phone, account, business, appId, foreignTenant, historicalPhone }) {
  const tenantId = request.principal.tenantId;
  const oldFetch = globalThis.fetch, oldStore = secrets.storeMetaCredential, oldInspect = credentials.inspectSignupConnection;
  const oldWake = controller.drains.wakeConnection;
  const ownerQuery = (sql, values = []) => db.withTenant(tenantId, client => client.query(sql, values));
  const workerQuery = async (sql, values = []) => {
    const client = await workerPool.connect();
    try { await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await client.query(sql, values); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  let nextPhone = BigInt(phone) + 100n, activePhone = String(nextPhone), activeAccount = account;
  let status = 'CONNECTED', variant = false, writeMode = 'OK', inspectUnavailable = false, version = 0, wakeCalls = 0;
  const tokens = new Set(), calls = [], connectionWrites = [];
  controller.drains.wakeConnection = async () => { wakeCalls++; };
  credentials.inspectSignupConnection = async reference => {
    if (inspectUnavailable) throw new Error('Synthetic unavailable sidecar read'); return stored.get(reference);
  };
  secrets.storeMetaCredential = async (reference, value) => {
    if (!reference.includes('/connections/')) { stored.set(reference, value); return; }
    connectionWrites.push(reference);
    if (writeMode !== 'LOST_ABSENT') stored.set(reference, value);
    if (writeMode !== 'OK') throw new Error('Synthetic uncertain sidecar response');
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, method: init.method ?? 'GET' });
    assert.equal(url.origin, 'https://graph.facebook.com'); assert.equal(init.method ?? 'GET', 'GET', 'ADD_ACCESS must never mutate Graph assets');
    if (url.pathname.endsWith('/oauth/access_token')) {
      const token = `synthetic-add-access-${++version}-never-live`; tokens.add(token); return Response.json({ access_token: token });
    }
    if (url.pathname.endsWith('/debug_token')) {
      assert.equal(tokens.has(url.searchParams.get('input_token')), true);
      return Response.json({ data: { app_id: appId, is_valid: true, expires_at: 0, user_id: '444444449',
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [activeAccount] }] } });
    }
    assert.equal(tokens.has(init.headers.authorization.slice(7)), true, 'Every discovery uses a verified exchanged credential');
    if (url.pathname === `/v24.0/${activeAccount}`) return Response.json({ id: activeAccount, name: 'Accessible account', owner_business: { id: business, name: 'Observed portfolio' } });
    if (url.pathname.endsWith('/owned_whatsapp_business_accounts')) return Response.json({ data: [{ id: activeAccount }] });
    if (url.pathname.endsWith('/phone_numbers')) return Response.json({ data: [{ id: activePhone, display_phone_number: '12025550161',
      status, account_mode: 'LIVE', host_platform: 'CLOUD_API', code_verification_status: 'VERIFIED' }] });
    if (url.pathname === `/v24.0/${activePhone}`) return Response.json({ id: activePhone, is_on_biz_app: variant, platform_type: 'CLOUD_API' });
    assert.fail(`Unexpected ADD_ACCESS Graph path ${url.pathname}`);
  };
  const startBody = (purpose = 'ADD_ACCESS') => ({ name: 'Existing accessible number', payerMode: 'CUSTOMER', purpose, idempotencyKey: randomUUID() });
  const authorize = async (body = startBody(), actorRequest = request) => {
    const started = await service.start(actorRequest, body);
    return service.exchange(actorRequest, started.attemptId, { challenge: started.challenge, code: randomUUID(), expectedRevision: started.revision });
  };
  const selectBody = state => ({ expectedRevision: state.revision, selectionRevision: state.selectionRevision, choiceId: state.choices.find(choice => choice.selectable)?.choiceId });
  const snapshot = async id => (await admin.query(`SELECT connection.state,connection.secret_reference,session.id AS session_id,session.state AS session_state,
    session.provider_state_data,route.state AS route_state,route.external_key FROM connections connection
    JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
    JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id WHERE connection.id=$1`, [id])).rows[0];
  const newPhone = () => { activePhone = String(++nextPhone); activeAccount = account; status = 'CONNECTED'; variant = false; };
  // Fresh runtime sessions create shadows before their first privileged helper
  // invocation. Schema-only metadata comes from the isolated migration owner;
  // no broader runtime grant or administrator impersonation is used.
  const quoted = name => `"${name.replaceAll('"', '""')}"`;
  const withShadows = async (config, role, tables, exercise) => {
    const client = new Client(config); await client.connect();
    try {
      const shadowTypes = new Map();
      if (role) {
        await client.query(`SET ROLE ${quoted(role)}`);
        assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, role);
      } else {
        // Cleanup runs as its real login through the granted client surface;
        // its privileged function owner is intentionally not an assumable role.
        const actual = (await client.query(`SELECT current_user=session_user AS runtime,
          pg_has_role(current_user,'wasalx_secret_cleanup_client','MEMBER') AS client,
          pg_has_role(current_user,'wasalx_secret_cleanup_executor','MEMBER') AS executor,
          pg_has_role(current_user,'wasalx_app','MEMBER') AS app`)).rows[0];
        assert.deepEqual(actual, { runtime: true, client: true, executor: false, app: false });
      }
      await client.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
      for (const table of tables) {
        const columns = (await admin.query(`SELECT attribute.attname AS name,pg_catalog.format_type(attribute.atttypid,attribute.atttypmod) AS type
          FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid=$1::regclass AND attribute.attnum>0 AND NOT attribute.attisdropped ORDER BY attribute.attnum`, [`public.${table}`])).rows;
        assert.ok(columns.length > 0);
        shadowTypes.set(table, new Map(columns.map(column => [column.name, column.type])));
        await client.query(`CREATE TEMP TABLE ${quoted(table)} (${columns.map(column => `${quoted(column.name)} ${column.type}`).join(',')})`);
      }
      const insert = async (table, row) => {
        const entries = Object.entries(row);
        await client.query(`INSERT INTO pg_temp.${quoted(table)} (${entries.map(([name]) => quoted(name)).join(',')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(',')})`,
          entries.map(([name, value]) => value !== null && ['json', 'jsonb'].includes(shadowTypes.get(table).get(name)) ? JSON.stringify(value) : value));
      };
      return await exercise(client, insert);
    } finally { await client.end(); }
  };
  const cleanupShadows = ['secret_cleanup_outbox', 'meta_signup_attempts', 'connections', 'connection_operations', 'provider_sessions', 'webhook_routes',
    'privacy_legal_holds', 'tenants', 'retention_policies', 'client_routing_integrations', 'client_routing_source_state', 'bot_action_definitions',
    'bot_action_revisions', 'bot_action_jobs', 'group_action_executions', 'client_routing_sync_jobs', 'bot_action_credential_stages',
    'automation_action_revision_pins', 'bot_flow_versions', 'rule_sets', 'bot_conversations', 'event_inbox'];
  const cleanupWithShadows = () => withShadows({ connectionString: cleanupUrl }, undefined, cleanupShadows,
    client => client.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)', [randomUUID()]));
  try {
    const privilegedClosure = ['app.meta_add_access_enrolled(uuid,uuid)', 'app.meta_add_access_activation_held(uuid,uuid)', 'app.meta_add_access_boundary()',
      'app.meta_signup_operation_current(uuid,uuid,uuid,uuid,jsonb,text,text,text,text)', 'app.expire_secret_provisioning_stages()', 'app.claim_secret_cleanup_tasks(uuid,integer)',
      'app.meta_signup_phone_available(text)', 'app.secret_cleanup_reference_is_owned(text,uuid,uuid,uuid,uuid,uuid,text)', 'app.enforce_secret_cleanup_reference()',
      'app.expire_meta_signup_attempts()', 'app.enforce_audit_event_actor_membership()', 'app.enqueue_routing_integration_secret_cleanup()'];
    for (const signature of privilegedClosure) {
      const info = (await admin.query('SELECT prosecdef,proconfig FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0];
      assert.equal(info.prosecdef, true, signature);
      assert.ok(info.proconfig.some(value => value.replaceAll(' ', '') === 'search_path=pg_catalog,public,app,pg_temp'), signature);
    }
    for (const role of ['wasalx_app', 'wasalx_connector_worker', 'wasalx_secret_cleanup_client', 'wasalx_secret_cleanup_executor']) {
      assert.equal((await admin.query("SELECT pg_catalog.has_function_privilege($1,'app.meta_add_access_enrolled(uuid,uuid)','EXECUTE') AS allowed", [role])).rows[0].allowed, false);
    }
    const regular = await authorize(startBody('NEW_NUMBER'));
    assert.equal(regular.choices[0].selectable, false, 'Registered access never falls through to new-number registration');
    let state = await authorize(); const body = selectBody(state);
    assert.equal(state.purpose, 'ADD_ACCESS'); assert.equal(state.choices[0].numberState, 'REGISTERED'); assert.ok(body.choiceId);
    assert.equal((await service.latest(request, undefined, 'ADD_ACCESS')).attempt.attemptId, state.attemptId);
    assert.equal((await service.latest(request)).attempt.attemptId, regular.attemptId);
    assert.equal((await db.rows(foreignTenant, 'SELECT id FROM meta_signup_attempts WHERE id=$1', [state.attemptId])).length, 0);
    for (const query of [{ purpose: ['ADD_ACCESS'] }, { purpose: 'ADD_ACCESS', targetConnectionId: randomUUID() }, { unrelated: true }]) {
      await assert.rejects(async () => controller.signupLatest(request, query), /invalid/i);
    }
    for (const registrationPin of [undefined, null, '', '123456', 123456, ['123456']]) {
      await assert.rejects(() => service.prepareSelection(request, state.attemptId, { ...body, registrationPin }), /invalid/i);
    }
    status = 'PENDING'; await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /changed/i); status = 'CONNECTED';
    variant = true; await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /changed/i); variant = false;
    const configId = process.env.META_SIGNUP_CUSTOMER_CONFIG_ID; process.env.META_SIGNUP_CUSTOMER_CONFIG_ID = '987654321';
    try { await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /changed/i); }
    finally { process.env.META_SIGNUP_CUSTOMER_CONFIG_ID = configId; }
    const competing = await authorize();
    state = await controller.signupSelect(request, state.attemptId, body);
    assert.equal(state.status, 'COMPLETED'); assert.equal(state.outcome, 'ACCESS_ADDED_PAUSED');
    assert.equal(state.readiness.authorization, 'VERIFIED'); assert.equal(state.readiness.number, 'REGISTERED');
    assert.equal(state.readiness.subscription, 'UNKNOWN'); assert.equal(state.readiness.messaging, 'UNKNOWN');
    assert.deepEqual(state.readiness.payment, { requestedPayer: 'CUSTOMER', status: 'UNKNOWN', paymentMethodVerified: false });
    const saved = await snapshot(state.connectionId), savedId = state.connectionId, savedPhone = activePhone;
    assert.equal(saved.state, 'PAUSED'); assert.equal(saved.session_state, 'PAUSED'); assert.equal(saved.route_state, 'PAUSED');
    assert.equal(saved.provider_state_data.metaSignup.purpose, 'ADD_ACCESS'); assert.equal(wakeCalls, 0);
    assert.deepEqual(Object.keys(stored.get(saved.secret_reference)), ['accessToken']);
    const operation = (await admin.query('SELECT * FROM connection_operations WHERE id=$1', [state.operationId])).rows[0];
    assert.equal(operation.state, 'SUCCEEDED'); assert.equal(operation.operation_type, 'PROVISION');
    assert.deepEqual(operation.result, { accessAdded: true, pausePreserved: true });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM connection_operations WHERE connection_id=$1 AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')", [savedId])).rows[0].n, 0);
    const beforeConflict = connectionWrites.length;
    await assert.rejects(() => controller.signupSelect(request, competing.attemptId, selectBody(competing)), /changed|already|conflict/i);
    assert.equal(connectionWrites.length, beforeConflict, 'Duplicate attempt cannot write another connection credential');
    await assert.rejects(() => ownerQuery("UPDATE meta_signup_attempts SET purpose='NEW_NUMBER' WHERE id=$1", [state.attemptId]), /immutable/i);
    await assert.rejects(() => ownerQuery('UPDATE meta_signup_attempts SET connection_credential_write_claimed_at=NULL WHERE id=$1', [state.attemptId]), /immutable/i);
    await assert.rejects(() => workerQuery('UPDATE meta_signup_attempts SET registration_claimed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [tenantId, state.attemptId]), /registration_purpose_check/);
    const raw = (await admin.query('SELECT * FROM meta_signup_attempts WHERE id=$1', [state.attemptId])).rows[0];
    const actualConnection = (await admin.query('SELECT * FROM public.connections WHERE id=$1', [savedId])).rows[0];
    const currentnessArgs = [tenantId, state.attemptId, savedId, state.operationId, raw.config, savedPhone, account, business, raw.credential_fingerprint];
    await withShadows({ connectionString: appUrl }, 'wasalx_app', ['meta_signup_attempts', 'provider_sessions', 'webhook_routes', 'connection_operations', 'connections', 'tenant_memberships'], async (client, insert) => {
      assert.equal((await client.query('SELECT app.meta_add_access_activation_held($1,$2) AS held', [tenantId, savedId])).rows[0].held, true);
      assert.equal((await client.query('SELECT app.meta_add_access_activation_held($1,$2) AS held', [foreignTenant, savedId])).rows[0].held, true);
      assert.equal((await client.query('SELECT app.meta_signup_phone_available($1) AS available', [historicalPhone])).rows[0].available, false);
      await assert.rejects(() => client.query('SELECT app.meta_add_access_enrolled($1,$2)', [tenantId, savedId]), error => error.code === '42501');
      await assert.rejects(() => client.query(`INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id)
        VALUES($1,$2,$3,'START',$1::uuid::text,'{}','QUEUED','USER',$4,'synthetic-shadow-activation')`, [randomUUID(), tenantId, savedId, request.principal.userId]), /separate activation/i);
      // A fake owner operation cannot authorize a different connection secret.
      const forgedReference = `${saved.secret_reference}/rotations/${'a'.repeat(64)}`;
      await insert('connections', actualConnection);
      await insert('connection_operations', { ...operation, payload: { ...operation.payload, credentialReference: forgedReference } });
      await assert.rejects(() => client.query(`INSERT INTO public.secret_cleanup_outbox(tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
        VALUES($1,$2,$3,'CONNECTION_CREDENTIAL',$4)`, [tenantId, savedId, state.operationId, forgedReference]), /reference does not match its owner/i);
      // Empty temporary membership cannot hide the real active audit actor.
      await client.query(`INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
        VALUES($1,'USER',$2,'meta_signup.shadow_boundary_checked','connection',$3,'{}','synthetic-shadow-audit')`, [tenantId, request.principal.userId, savedId]);
    });
    await withShadows(workerConfig, 'wasalx_connector_worker', ['meta_signup_attempts', 'provider_sessions', 'connections', 'tenant_memberships', 'tenants'], async (client, insert) => {
      await insert('meta_signup_attempts', { ...raw, purpose: 'NEW_NUMBER', status: 'PROVISIONING' });
      await insert('connections', actualConnection);
      await insert('provider_sessions', (await admin.query('SELECT * FROM public.provider_sessions WHERE id=$1', [saved.session_id])).rows[0]);
      await insert('tenant_memberships', (await admin.query('SELECT * FROM public.tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, request.principal.userId])).rows[0]);
      await insert('tenants', (await admin.query('SELECT * FROM public.tenants WHERE id=$1', [tenantId])).rows[0]);
      assert.equal((await client.query('SELECT app.meta_add_access_activation_held($1,$2) AS held', [tenantId, savedId])).rows[0].held, true);
      assert.equal((await client.query('SELECT app.meta_signup_operation_current($1,$2,$3,$4,$5,$6,$7,$8,$9) AS current', currentnessArgs)).rows[0].current, false, 'Temporary NEW_NUMBER cannot replace the real immutable ADD_ACCESS purpose');
      await assert.rejects(() => client.query('SELECT app.meta_add_access_enrolled($1,$2)', [tenantId, savedId]), error => error.code === '42501');
    });
    assert.equal((await workerQuery('SELECT app.meta_signup_operation_current($1,$2,$3,$4,$5,$6,$7,$8,$9) AS current',
      [tenantId, state.attemptId, savedId, state.operationId, raw.config, savedPhone, account, business, raw.credential_fingerprint])).rows[0].current, false);
    assert.equal((await workerQuery('SELECT app.meta_add_access_activation_held($1,$2) AS held', [tenantId, savedId])).rows[0].held, true);
    for (const action of ['start', 'restart', 'syncGroups']) {
      const count = calls.length; await assert.rejects(() => controller[action](request, savedId, randomUUID()), error => error.getResponse?.().code === 'META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED');
      assert.equal(calls.length, count, 'Activation denied before any provider or credential inspection');
    }
    for (const type of ['PROVISION', 'START', 'RESTART', 'SYNC_GROUPS']) {
      await assert.rejects(() => ownerQuery(`INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id)
        VALUES($1,$2,$3,$4,$1::uuid::text,'{}','QUEUED','USER',$5,'synthetic-forged-activation')`, [randomUUID(), tenantId, savedId, type, request.principal.userId]), /separate activation/i);
    }
    for (const sql of ["UPDATE connections SET state='WORKING' WHERE id=$1", "UPDATE provider_sessions SET state='WORKING' WHERE connection_id=$1",
      "UPDATE webhook_routes SET state='ACTIVE' WHERE connection_id=$1", "UPDATE provider_sessions SET provider_state_data=provider_state_data-'metaSignup' WHERE connection_id=$1"]) {
      await assert.rejects(() => ownerQuery(sql, [savedId]), /separate activation|immutable/i);
    }
    const manualToken = 'synthetic-add-access-manual-renewal-never-live'; tokens.add(manualToken);
    await controller.rotateMetaCredential(request, savedId, randomUUID(), { accessToken: manualToken });
    assert.deepEqual((await snapshot(savedId)).provider_state_data.metaSignup, saved.provider_state_data.metaSignup);
    const renewed = await authorize({ name: 'Renew saved access', payerMode: 'CUSTOMER', idempotencyKey: randomUUID(), targetConnectionId: savedId });
    assert.equal((await controller.signupSelect(request, renewed.attemptId, selectBody(renewed))).outcome, 'ACCESS_RENEWED_PAUSED');
    assert.equal((await snapshot(savedId)).state, 'PAUSED'); assert.equal(wakeCalls, 0);
    assert.equal((await ownerQuery('SELECT app.meta_add_access_activation_held($1,$2) AS held', [tenantId, savedId])).rows[0].held, true);
    const duplicate = await authorize(); assert.equal(duplicate.choices[0].selectable, false);
    assert.deepEqual(duplicate.choices[0].existingConnection, { connectionId: savedId, name: 'Existing accessible number' });
    activeAccount = String(BigInt(account) + 1n); const wrongAccount = await authorize();
    assert.equal(wrongAccount.choices[0].selectable, false); assert.equal(wrongAccount.choices[0].existingConnection, undefined);
    activeAccount = account; activePhone = historicalPhone; const foreign = await authorize();
    assert.equal(foreign.choices[0].selectable, false); assert.equal(foreign.choices[0].existingConnection, undefined);

    // A positive exact read after an accepted-but-lost write closes one atomic
    // local operation, without repeating the secret or any Graph mutation.
    newPhone(); state = await authorize(); writeMode = 'LOST_ACCEPTED';
    state = await controller.signupSelect(request, state.attemptId, selectBody(state)); writeMode = 'OK';
    assert.equal(state.status, 'SELECTION_REQUIRED'); assert.ok(state.connectionId); assert.equal(state.choices[0].existingConnection, undefined);
    const unknownRef = (await snapshot(state.connectionId)).secret_reference, writesBeforeResume = connectionWrites.length;
    assert.equal((await admin.query('SELECT state FROM connection_operations WHERE id=$1', [state.operationId])).rows[0].state, 'STAGED');
    assert.equal((await snapshot(state.connectionId)).state, 'PROVISIONING');
    const beforeStale = { calls: calls.length, writes: connectionWrites.length };
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE public.connections SET state='ACTION_REQUIRED' WHERE id=$1", [state.connectionId]));
    const changedView = await service.get(request, state.attemptId);
    assert.equal(changedView.status, 'ACTION_REQUIRED'); assert.equal(changedView.reasonCode, 'META_SIGNUP_ADD_ACCESS_STAGE_CHANGED');
    assert.equal(changedView.canCancel, false); assert.equal(changedView.choices.some(choice => choice.selectable), false);
    await assert.rejects(() => service.cancel(request, state.attemptId, { expectedRevision: state.revision }), /changed/i);
    assert.deepEqual({ calls: calls.length, writes: connectionWrites.length }, beforeStale, 'Stale status and denied cancellation have no credential/provider effects');
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE public.connections SET state='PROVISIONING' WHERE id=$1", [state.connectionId]));
    const oldNow = Date.now; Date.now = () => oldNow() + 11 * 60_000;
    try {
      const results = await Promise.allSettled([controller.signupSelect(request, state.attemptId, selectBody(state)), service.get(request, state.attemptId)]);
      for (const result of results) assert.equal(result.status, 'fulfilled', 'Bound-stage refresh and recovery share lock order');
      state = results[0].value;
    } finally { Date.now = oldNow; }
    assert.equal(state.outcome, 'ACCESS_ADDED_PAUSED'); assert.equal(connectionWrites.length, writesBeforeResume);
    assert.equal((await snapshot(state.connectionId)).secret_reference, unknownRef);

    // Absence or an unavailable read after a durable write claim cannot authorize
    // a rewrite or cancellation. Only matching positive reconciliation can proceed.
    newPhone(); state = await authorize(); writeMode = 'LOST_ABSENT';
    state = await controller.signupSelect(request, state.attemptId, selectBody(state)); writeMode = 'OK';
    const absentRef = (await snapshot(state.connectionId)).secret_reference, attemptedWrites = connectionWrites.length;
    assert.equal(stored.has(absentRef), false);
    state = await controller.signupSelect(request, state.attemptId, selectBody(state));
    assert.equal(state.status, 'SELECTION_REQUIRED'); assert.equal(connectionWrites.length, attemptedWrites);
    await assert.rejects(() => service.cancel(request, state.attemptId, { expectedRevision: state.revision }), /changed/i);
    inspectUnavailable = true;
    state = await controller.signupSelect(request, state.attemptId, selectBody(state));
    await assert.rejects(() => service.cancel(request, state.attemptId, { expectedRevision: state.revision }), /confirmed read/i); inspectUnavailable = false;
    stored.set(absentRef, { accessToken: 'synthetic-unrelated-credential' });
    await assert.rejects(() => controller.signupSelect(request, state.attemptId, selectBody(state)), /differs/i);
    await assert.rejects(() => service.cancel(request, state.attemptId, { expectedRevision: state.revision }), /changed/i);
    stored.set(absentRef, { ...stored.get(`secret://${tenantId}/meta-signup/${state.attemptId}`) });
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connection_operations SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1", [state.operationId]));
    await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)', [randomUUID()]);
    const retained = (await admin.query('SELECT state,error_code FROM connection_operations WHERE id=$1', [state.operationId])).rows[0];
    assert.equal(retained.state, 'STAGED'); assert.equal(retained.error_code, 'META_SIGNUP_STAGE_REVIEW_REQUIRED');
    const holdId = randomUUID();
    await admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2::uuid,'TENANT',$2::uuid::text,repeat('c',64),'Add access retention',$3)", [holdId, tenantId, request.principal.userId]);
    const retainedKnown = randomUUID(), retainedUnknown = randomUUID();
    for (const [id, retainedStatus] of [[retainedKnown, 'EXPIRED'], [retainedUnknown, 'OUTCOME_UNKNOWN']]) {
      await admin.query(`INSERT INTO public.meta_signup_attempts(id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,status,purpose,created_at,expires_at)
        SELECT $1::uuid,tenant_id,requested_by,'Shadow retention label',$1::uuid::text,challenge_sha256,config,
          'secret://'||tenant_id::text||'/meta-signup/'||$1::uuid::text,$2,'ADD_ACCESS',clock_timestamp()-interval '90 days',clock_timestamp()-interval '89 days'
        FROM public.meta_signup_attempts WHERE id=$3`, [id, retainedStatus, state.attemptId]);
      await ownerQuery("INSERT INTO public.secret_cleanup_outbox(tenant_id,meta_signup_attempt_id,cleanup_kind,secret_reference) VALUES($1,$2,'META_SIGNUP_CREDENTIAL',$3)", [tenantId, id, `secret://${tenantId}/meta-signup/${id}`]);
    }
    state = await service.cancel(request, state.attemptId, { expectedRevision: state.revision }); assert.equal(state.status, 'CANCELLED');
    const cancelled = await snapshot(state.connectionId);
    assert.equal(cancelled.state, 'REVOKED'); assert.equal(cancelled.session_state, 'REVOKED'); assert.equal(cancelled.route_state, 'REVOKED');
    assert.equal((await ownerQuery('SELECT app.meta_signup_phone_available($1) AS available', [activePhone])).rows[0].available, false);
    const held = await cleanupWithShadows();
    assert.equal(held.rows.some(item => item.secret_reference === absentRef), false);
    assert.equal(held.rows.some(item => item.secret_reference.endsWith(retainedKnown) || item.secret_reference.endsWith(retainedUnknown)), false);
    assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1', [retainedKnown])).rows[0].name, 'Shadow retention label');
    await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1", [holdId, request.principal.userId]);
    const released = await cleanupWithShadows();
    assert.equal(released.rows.some(item => item.secret_reference === absentRef), true);
    assert.equal(released.rows.some(item => item.secret_reference === unknownRef), false, 'A promoted current token is retained');
    assert.equal(released.rows.some(item => item.secret_reference.endsWith(retainedKnown)), true, 'Permanent owned terminal attempt remains cleanable despite empty shadows');
    assert.equal(released.rows.some(item => item.secret_reference.endsWith(retainedUnknown)), false, 'Unknown outcome remains retained despite empty shadows');
    assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1', [retainedKnown])).rows[0].name, '[removed]');
    assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1', [retainedUnknown])).rows[0].name, 'Shadow retention label');

    const otherActor = randomUUID();
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Add access fixture')", [otherActor, `add-access-${otherActor}`, `${otherActor}@example.invalid`]);
    await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_admin','ACTIVE')", [tenantId, otherActor]);
    const actorRequest = { ...request, principal: { ...request.principal, userId: otherActor, role: 'tenant_admin' } };
    newPhone(); state = await authorize(startBody(), actorRequest); writeMode = 'LOST_ACCEPTED';
    state = await controller.signupSelect(actorRequest, state.attemptId, selectBody(state)); writeMode = 'OK';
    const removedRef = (await snapshot(state.connectionId)).secret_reference;
    await admin.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, otherActor]);
    assert.equal((await admin.query('SELECT requested_by FROM meta_signup_attempts WHERE id=$1', [state.attemptId])).rows[0].requested_by, null);
    await assert.rejects(() => controller.signupSelect(actorRequest, state.attemptId, selectBody(state)), /active owner|administrator/i);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connection_operations SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1", [state.operationId]));
    const removedCleanup = await cleanup.query('SELECT * FROM app.claim_secret_cleanup_tasks($1,100)', [randomUUID()]);
    assert.equal(removedCleanup.rows.some(item => item.secret_reference === removedRef), false);
    assert.equal(connectionWrites.length, attemptedWrites + 1, 'Unknown writes were not repeated');
    assert.equal(wakeCalls, 0); assert.equal(calls.some(call => /register|subscribed_apps|messages|credit|handover/.test(call.path)), false);
    await verifyMetaSavedAccessActivation({admin,db,workerPool,controller,request,stored,connectionId:savedId,appId});
  } finally {
    globalThis.fetch = oldFetch; secrets.storeMetaCredential = oldStore; credentials.inspectSignupConnection = oldInspect; controller.drains.wakeConnection = oldWake;
  }
}

async function verifyPausedReauthorization({ admin, db, cleanup, service, controller, processor, request, stored, secrets, credentials,
  originalAttemptId, phone, account, business, appId, foreignConnectionId }) {
  const tenantId = request.principal.tenantId;
  const connectionId = (await admin.query("SELECT connection_id FROM meta_signup_attempts WHERE id=$1", [originalAttemptId])).rows[0].connection_id;
  const snapshot = async () => (await admin.query(`SELECT connection.secret_reference,connection.state,session.id AS session_id,
    session.opaque_session_id,session.provider_state_data,route.id AS route_id,route.state AS route_state
    FROM connections connection JOIN provider_sessions session ON session.connection_id=connection.id
    JOIN webhook_routes route ON route.connection_id=connection.id WHERE connection.id=$1`, [connectionId])).rows[0];
  const startBody = (idempotencyKey = randomUUID()) => ({ name: "Paused account", payerMode: "CUSTOMER", idempotencyKey, targetConnectionId: connectionId });
  await assert.rejects(() => service.start(request, startBody()), /paused connection/i);
  await controller.pause(request, connectionId, randomUUID());
  assert.equal((await processor.drainTenant(tenantId)).succeeded, 1);
  const initial = await snapshot(); assert.equal(initial.state, "PAUSED"); assert.equal(initial.route_state, "PAUSED");
  const targetName = "Existing connection ".repeat(7).trim();
  await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET name=$2 WHERE id=$1", [connectionId, targetName]));
  const oldFetch = globalThis.fetch, oldStore = secrets.storeMetaCredential;
  let tokenVersion = 0, token = "", status = "CONNECTED", variant = false, failWrite = false, inspectUnavailable = false, beforeRead;
  const acceptedTokens = new Set([stored.get(initial.secret_reference).accessToken]);
  const calls = [], writes = [];
  credentials.inspectSignupConnection = async reference => { if (inspectUnavailable) throw new Error("synthetic unavailable read"); return stored.get(reference); };
  secrets.storeMetaCredential = async (reference, value) => {
    writes.push(reference); stored.set(reference, value);
    if (failWrite && reference.includes("/meta/rotations/")) throw new Error("synthetic accepted but lost response");
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, method: init.method ?? "GET" });
    assert.equal(url.origin, "https://graph.facebook.com");
    if (beforeRead) { const hook = beforeRead; beforeRead = undefined; await hook(); }
    if (url.pathname.endsWith("/oauth/access_token")) {
      token = `synthetic-reconnect-token-version-${++tokenVersion}-never-live`; acceptedTokens.add(token);
      return Response.json({ access_token: token });
    }
    if (url.pathname.endsWith("/debug_token")) {
      assert.equal(acceptedTokens.has(url.searchParams.get("input_token")), true);
      return Response.json({ data: { app_id: appId, is_valid: true, expires_at: 0, user_id: "444444449",
        scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [account] }] } });
    }
    assert.equal(acceptedTokens.has(init.headers.authorization.slice(7)), true);
    assert.equal(init.method, "GET", "Paused reauthorization must never mutate the provider");
    if (url.pathname === `/v24.0/${account}`) return Response.json({ id: account, name: "Accessible account", owner_business: { id: business, name: "Observed portfolio" } });
    if (url.pathname.endsWith("/owned_whatsapp_business_accounts")) return Response.json({ data: [{ id: account }] });
    if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: phone, display_phone_number: "12025550161", status, account_mode: "LIVE", host_platform: "CLOUD_API", code_verification_status: "VERIFIED" },
      { id: String(BigInt(phone) + 1n), display_phone_number: "12025550161", status, account_mode: "LIVE", host_platform: "CLOUD_API", code_verification_status: "VERIFIED" }] });
    if (url.pathname === `/v24.0/${phone}` || url.pathname === `/v24.0/${String(BigInt(phone)+1n)}`) return Response.json({ id: url.pathname.split("/").at(-1), is_on_biz_app: variant, platform_type: "CLOUD_API" });
    assert.fail(`unexpected reconnect provider path ${url.pathname}`);
  };
  const authorize = async (body = startBody(), code = randomUUID(), owner = request) => {
    const started = await service.start(owner, body);
    const view = await service.exchange(owner, started.attemptId, { challenge: started.challenge, code, expectedRevision: started.revision });
    assert.equal(view.purpose, "RECONNECT"); assert.equal(view.target.connectionId, connectionId);
    assert.equal(view.choices.filter(choice => choice.selectable).length, 1, "Exact target among prior grants, never first arbitrary ID");
    assert.equal(view.choices.find(choice => choice.selectable).numberState, "REGISTERED");
    return view;
  };
  const selectBody = view => ({ expectedRevision: view.revision, selectionRevision: view.selectionRevision, choiceId: view.choices.find(choice => choice.selectable).choiceId });
  const ownerQuery = (sql, values) => db.withTenant(tenantId, client => client.query(sql, values));
  try {
    const replayBody = startBody(); const awaiting = await service.start(request, replayBody);
    assert.equal(awaiting.target.name, targetName, "The target shows the existing label, independent of the short authorization label");
    assert.equal((await admin.query("SELECT name FROM connections WHERE id=$1", [connectionId])).rows[0].name, targetName);
    assert.equal((await service.start(request, replayBody)).attemptId, awaiting.attemptId);
    await assert.rejects(() => service.start(request, { ...replayBody, targetConnectionId: undefined }), /invalid/);
    const { targetConnectionId: omitted, ...newNumberReplay } = replayBody; assert.equal(omitted, connectionId);
    await assert.rejects(() => service.start(request, newNumberReplay), /changed/);
    await assert.rejects(() => service.start(request, { ...replayBody, targetConnectionId: foreignConnectionId }), /changed/);
    await assert.rejects(() => service.start(request, { ...startBody(), targetConnectionId: foreignConnectionId }), /not found/);
    await assert.rejects(() => ownerQuery("UPDATE meta_signup_attempts SET purpose='NEW_NUMBER',target_connection_id=NULL,target_binding=NULL WHERE id=$1", [awaiting.attemptId]), /immutable/);
    await assert.rejects(() => ownerQuery("UPDATE meta_signup_attempts SET target_binding=jsonb_set(target_binding,'{phoneNumberId}','\"999999999\"') WHERE id=$1", [awaiting.attemptId]), /immutable/);
    for (const missing of ["state", "contextSha256", "providerSessionId", "phoneNumberId", "wabaId", "secretReference"]) {
      await assert.rejects(() => ownerQuery(`INSERT INTO meta_signup_attempts(id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,expires_at,purpose,target_connection_id,target_binding)
        SELECT $1::uuid,tenant_id,requested_by,name,$1::uuid::text,challenge_sha256,config,'secret://'||tenant_id::text||'/meta-signup/'||$1::uuid::text,expires_at,purpose,target_connection_id,target_binding-$3::text
        FROM meta_signup_attempts WHERE id=$2`, [randomUUID(), awaiting.attemptId, missing]), /meta_signup_reconnect_target_check/);
    }
    await assert.rejects(() => ownerQuery(`INSERT INTO meta_signup_attempts(id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,expires_at,purpose,target_connection_id,target_binding)
      SELECT $1::uuid,tenant_id,requested_by,name,$1::uuid::text,challenge_sha256,config,'secret://'||tenant_id::text||'/meta-signup/'||$1::uuid::text,expires_at,purpose,$3,target_binding
      FROM meta_signup_attempts WHERE id=$2`, [randomUUID(), awaiting.attemptId, foreignConnectionId]), /meta_signup_reconnect_target_fk/);
    const originalNow = Date.now; Date.now = () => originalNow() + 11*60*1000;
    try { await assert.rejects(() => service.exchange(request, awaiting.attemptId, { challenge: awaiting.challenge, code: randomUUID(), expectedRevision: 1 }), /changed/); }
    finally { Date.now = originalNow; }
    assert.equal((await service.cancel(request, awaiting.attemptId, { expectedRevision: 1 })).status, "CANCELLED");

    for (const type of ["START", "RESTART", "PAUSE", "DISCONNECT", "ROTATE_META_CREDENTIAL"]) {
      const pendingId = randomUUID();
      await withFixtureTenant(admin,tenantId,()=>admin.query(`INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id)
        VALUES($1,$2,$3,$4,$1::uuid::text,'{}',$5,'USER',$6,'synthetic-pending')`, [pendingId, tenantId, connectionId, type, type === "ROTATE_META_CREDENTIAL" ? "STAGED" : "QUEUED", request.principal.userId]));
      await assert.rejects(() => service.start(request, startBody()), /paused connection/i);
      await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connection_operations SET state='CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [pendingId]));
    }

    const consumedCode = randomUUID();
    let state = await authorize(startBody(), consumedCode); const body = selectBody(state);
    const otherPurpose = await service.start(request, { name: "New setup", payerMode: "CUSTOMER", idempotencyKey: randomUUID() });
    const exchangesBeforeReuse = calls.filter(call => call.path.endsWith("/oauth/access_token")).length;
    await assert.rejects(() => service.exchange(request, otherPurpose.attemptId, { challenge: otherPurpose.challenge, code: consumedCode, expectedRevision: otherPurpose.revision }), /changed/);
    assert.equal(calls.filter(call => call.path.endsWith("/oauth/access_token")).length, exchangesBeforeReuse, "A consumed code cannot cross purposes");
    assert.equal((await service.latest(request, connectionId)).attempt.attemptId, state.attemptId);
    assert.equal((await service.latest(request)).attempt.attemptId, otherPurpose.attemptId);
    await service.cancel(request, otherPurpose.attemptId, { expectedRevision: otherPurpose.revision });
    for (const registrationPin of [undefined, null, "", "123456", 123456, ["123456"]]) await assert.rejects(() => service.prepareSelection(request, state.attemptId, { ...body, registrationPin }), /invalid/);
    status = "PENDING"; await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /changed/); status = "CONNECTED";
    variant = true; await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /changed/); variant = false;
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='REVOKED' WHERE connection_id=$1", [connectionId]));
    await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /paused connection/i);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE webhook_routes SET state='PAUSED' WHERE connection_id=$1", [connectionId]));
    const sourceContext = (await snapshot()).provider_state_data;
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=provider_state_data||'{\"syntheticChangedProof\":true}'::jsonb WHERE connection_id=$1", [connectionId]));
    await assert.rejects(() => controller.signupSelect(request, state.attemptId, body), /paused connection/i);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE provider_sessions SET provider_state_data=$2 WHERE connection_id=$1", [connectionId, sourceContext]));
    const concurrentAttempt = await authorize();
    failWrite = true;
    state = await controller.signupSelect(request, state.attemptId, body);
    assert.equal(state.status, "SELECTION_REQUIRED"); assert.equal(state.canCancel, true);
    const operation = (await admin.query("SELECT * FROM connection_operations WHERE id=$1", [state.operationId])).rows[0];
    const stageReference = operation.payload.newSecretReference;
    assert.deepEqual(Object.keys(stored.get(stageReference)), ["accessToken"], "Reconnect stage contains no registration PIN");
    await assert.rejects(() => controller.rotateMetaCredential(request, connectionId, operation.idempotency_key, { accessToken: stored.get(stageReference).accessToken }), /authorization context/);
    await assert.rejects(() => controller.signupSelect(request, concurrentAttempt.attemptId, selectBody(concurrentAttempt)), /paused connection/i);
    const queued = await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,100)", [randomUUID()]);
    assert.equal(queued.rows.some(item => item.secret_reference === stageReference || item.secret_reference === initial.secret_reference), false);
    assert.equal((await snapshot()).secret_reference, initial.secret_reference, "Lost sidecar response rolls back promotion");
    failWrite = false; const writeCount = writes.length;
    const concurrentRecovery = await Promise.allSettled([
      controller.signupSelect(request, state.attemptId, selectBody(state)),
      service.get(request, state.attemptId), service.get(request, state.attemptId),
    ]);
    for (const result of concurrentRecovery) assert.equal(result.status, "fulfilled", "Refresh and promotion use a consistent target lock order");
    state = concurrentRecovery[0].value;
    assert.equal(writes.length, writeCount, "Exact accepted stage readback avoids another secret write");
    assert.equal(state.status, "COMPLETED"); assert.equal(state.outcome, "ACCESS_RENEWED_PAUSED");
    assert.equal(state.readiness.subscription, "UNKNOWN"); assert.equal(state.readiness.messaging, "UNKNOWN"); assert.equal(state.readiness.payment.status, "UNKNOWN");
    const after = await snapshot(); assert.equal(after.state, "PAUSED"); assert.equal(after.route_state, "PAUSED"); assert.equal(after.route_id, initial.route_id);
    assert.equal(after.session_id, initial.session_id); assert.equal(after.opaque_session_id, initial.opaque_session_id);
    assert.deepEqual(after.provider_state_data.metaSignup, initial.provider_state_data.metaSignup);
    assert.equal(after.provider_state_data.wabaId, initial.provider_state_data.wabaId);
    assert.equal(after.secret_reference, stageReference);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM connection_operations WHERE connection_id=$1 AND payload->>'sourceOperationId'=$2", [connectionId, state.operationId])).rows[0].n, 0);
    const completedAttempt = state.attemptId;
    await assert.rejects(() => controller.rotateMetaCredential(request, connectionId, operation.idempotency_key, { accessToken: stored.get(stageReference).accessToken }), /authorization context/);
    const manualToken = "synthetic-manual-later-rotation-never-live"; acceptedTokens.add(manualToken);
    await controller.rotateMetaCredential(request, connectionId, randomUUID(), { accessToken: manualToken });
    assert.equal((await service.get(request, completedAttempt)).outcome, "ACCESS_RENEWED_PAUSED", "Historical completed attempt survives a legitimate later rotation");
    assert.equal((await snapshot()).state, "PAUSED");
    await assert.rejects(() => controller.signupSelect(request, concurrentAttempt.attemptId, selectBody(concurrentAttempt)), /paused connection/i);
    await service.cancel(request, concurrentAttempt.attemptId, { expectedRevision: concurrentAttempt.revision });

    state = await authorize(); failWrite = true;
    state = await controller.signupSelect(request, state.attemptId, selectBody(state)); failWrite = false;
    const abandoned = (await admin.query("SELECT * FROM connection_operations WHERE id=$1", [state.operationId])).rows[0];
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='ACTION_REQUIRED' WHERE id=$1", [connectionId]));
    const staleStage = await service.get(request, state.attemptId);
    assert.equal(staleStage.reasonCode, "META_SIGNUP_RECONNECT_TARGET_CHANGED"); assert.equal(staleStage.canCancel, true);
    await assert.rejects(() => controller.signupSelect(request, state.attemptId, selectBody(state)), /paused connection/i);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connections SET state='PAUSED' WHERE id=$1", [connectionId]));
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connection_operations SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1", [state.operationId]));
    await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,100)", [randomUUID()]);
    const retained = (await admin.query("SELECT state,error_code FROM connection_operations WHERE id=$1", [state.operationId])).rows[0];
    assert.equal(retained.state, "STAGED"); assert.equal(retained.error_code, "META_SIGNUP_STAGE_REVIEW_REQUIRED");
    inspectUnavailable = true; await assert.rejects(() => service.cancel(request, state.attemptId, { expectedRevision: state.revision }), /confirmed read/); inspectUnavailable = false;
    const holdId = randomUUID();
    await admin.query("INSERT INTO privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by) VALUES($1,$2::uuid,'TENANT',$2::uuid::text,repeat('b',64),'Reauthorization retention',$3)", [holdId,tenantId,request.principal.userId]);
    state = await service.cancel(request, state.attemptId, { expectedRevision: state.revision }); assert.equal(state.status, "CANCELLED");
    const held = await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,100)", [randomUUID()]);
    assert.equal(held.rows.some(item => item.secret_reference === abandoned.payload.newSecretReference), false);
    await admin.query("UPDATE privacy_legal_holds SET state='RELEASED',released_at=clock_timestamp(),released_by=$2 WHERE id=$1", [holdId,request.principal.userId]);
    const released = await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,100)", [randomUUID()]);
    assert.equal(released.rows.some(item => item.secret_reference === abandoned.payload.newSecretReference), true);
    const currentReference = (await snapshot()).secret_reference;
    assert.equal(released.rows.some(item => item.secret_reference === currentReference), false, "Current promoted credentials cannot be cleaned up");

    const removedActor = randomUUID();
    await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Reauthorization fixture')",
      [removedActor, `reauthorization-${removedActor}`, `${removedActor}@example.invalid`]);
    // Keep an active owner while testing revocation, then restore the original
    // owner before removing this supporting membership. Never disable its trigger.
    await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role,state) VALUES($1,$2,'tenant_owner','ACTIVE')", [tenantId, removedActor]);
    const removedRequest = { ...request, principal: { ...request.principal, userId: removedActor, role: "tenant_owner" } };
    state = await authorize();
    beforeRead = () => admin.query("UPDATE tenant_memberships SET state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2", [tenantId,request.principal.userId]);
    await assert.rejects(() => controller.signupSelect(request, state.attemptId, selectBody(state)), /active owner|administrator/);
    await admin.query("UPDATE tenant_memberships SET state='ACTIVE' WHERE tenant_id=$1 AND user_id=$2", [tenantId,request.principal.userId]);
    await service.cancel(request, state.attemptId, { expectedRevision: state.revision });
    const removedBeforeStage = await service.start(removedRequest, startBody());
    state = await authorize(startBody(), randomUUID(), removedRequest);
    await assert.rejects(() => service.get(request, state.attemptId), /not found/);
    failWrite = true; state = await controller.signupSelect(removedRequest, state.attemptId, selectBody(state)); failWrite = false;
    const removedStage = (await admin.query("SELECT payload FROM connection_operations WHERE id=$1", [state.operationId])).rows[0];
    await admin.query("DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2", [tenantId, removedActor]);
    assert.equal((await admin.query("SELECT requested_by FROM meta_signup_attempts WHERE id=$1", [removedBeforeStage.attemptId])).rows[0].requested_by, null);
    assert.equal((await admin.query("SELECT requested_by FROM meta_signup_attempts WHERE id=$1", [state.attemptId])).rows[0].requested_by, null);
    await assert.rejects(() => service.cancel(removedRequest, state.attemptId, { expectedRevision: state.revision }), /active owner|administrator/);
    await withFixtureTenant(admin,tenantId,()=>admin.query("UPDATE connection_operations SET updated_at=clock_timestamp()-interval '2 hours' WHERE id=$1", [state.operationId]));
    const actorRemovedCleanup = await cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,100)", [randomUUID()]);
    assert.equal(actorRemovedCleanup.rows.some(item => [removedStage.payload.newSecretReference, `secret://${tenantId}/meta-signup/${state.attemptId}`].includes(item.secret_reference)), false);
    assert.equal((await admin.query("SELECT state,error_code FROM connection_operations WHERE id=$1", [state.operationId])).rows[0].error_code, "META_SIGNUP_STAGE_REVIEW_REQUIRED");
    assert.equal(calls.filter(call => call.method !== "GET").length, 0);
    assert.equal(calls.some(call => /register|subscribed_apps|messages|credit|handover/.test(call.path)), false);
  } finally {
    globalThis.fetch = oldFetch; secrets.storeMetaCredential = oldStore;
  }
}

// Existing canonical signup gate, actual worker/app logins. No provider calls.
async function verifySignupMetadataPrivacy(admin,appUrl,workerConfig,actor) {
  const {PrivacyRepository}=await import("../services/connector-worker/dist/services/connector-worker/src/privacy-repository.js");
  const {PrivacyProcessor}=await import("../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js");
  const tenant=randomUUID(),foreign=randomUUID(),clean=randomUUID(),known=randomUUID(),unknown=randomUUID(),foreignAttempt=randomUUID(),cleanAttempt=randomUUID();
  const pool=new Pool(workerConfig),repository=new PrivacyRepository(pool),app=new Client({connectionString:appUrl});await app.connect();
  const sourceAsset={businessId:"7777777",wabaId:"8888888",phoneId:"9999999",mode:"STANDARD",numberState:"REGISTERED",proofSha256:"c".repeat(64)};
  const seedAttempt=async(id,scope,status)=>admin.query(`INSERT INTO public.meta_signup_attempts
    (id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,status,choices,selected_choice,credential_metadata,credential_fingerprint,credential_stored_at,created_at,expires_at)
    VALUES($1::uuid,$2::uuid,NULL,'Private signup label',$1::uuid::text,repeat('a',64),'{"payerMode":"CUSTOMER"}',$3,$4,
      '[{"businessName":"Private discovered name"}]',$5,'{"user_id":"MUST_NOT_EXPORT","access_token":"MUST_NOT_EXPORT"}',repeat('b',64),
      CASE WHEN $4='OUTCOME_UNKNOWN' THEN NULL ELSE clock_timestamp() END,clock_timestamp()-interval '40 days',clock_timestamp()-interval '39 days')`,
    [id,scope,`secret://${scope}/meta-signup/${id}`,status,sourceAsset]);
  const makeJob=async(scope,type,scopeType="TENANT",scopeValue=scope,claim=true)=>{
    const id=randomUUID(),lease=randomUUID(),requestId=type==='RETENTION_SWEEP'?null:randomUUID();
    if(requestId)await admin.query(`INSERT INTO public.privacy_requests
      (id,tenant_id,request_type,scope_type,scope_value,scope_sha256,disposition,idempotency_key,request_sha256,requested_by)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,repeat('d',64),$6,$1::uuid::text,repeat('e',64),$7::uuid)`,
      [requestId,scope,type,scopeType,scopeValue,type==='EXPORT'?'EXPORT_ONLY':'DELETE_TICKETS',actor]);
    // Direct SQL oracles use explicit admin-seeded valid leased contexts, not a claim mock.
    // The uploaded-byte case passes false and alone uses the real processor claim.
    await admin.query(`INSERT INTO public.privacy_jobs(id,tenant_id,request_id,job_type,scope_type,scope_value,disposition,idempotency_key,state,attempts,fencing_token,lease_id,lease_expires_at,unmatched_diagnostic_hours_snapshot)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$1::uuid::text,CASE WHEN $8::boolean THEN 'RUNNING' ELSE 'QUEUED' END,
        CASE WHEN $8::boolean THEN 1 ELSE 0 END,CASE WHEN $8::boolean THEN 1 ELSE 0 END,
        CASE WHEN $8::boolean THEN $9::uuid ELSE NULL END,CASE WHEN $8::boolean THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,
         CASE WHEN $4='RETENTION_SWEEP' THEN (SELECT unmatched_diagnostic_hours FROM public.retention_policies WHERE tenant_id=$2::uuid) ELSE NULL END)`,
      [id,scope,requestId,type,scopeType,scopeValue,type==='EXPORT'?'EXPORT_ONLY':type==='DELETE'?'DELETE_TICKETS':'RETENTION_DELETE',claim,lease]);
    if(!claim)return{id};
    return readFixtureJob(id,lease);
  };
  const readFixtureJob=async(id,lease)=>{
    const row=(await admin.query(`SELECT j.*,z.base_url,z.privacy_secret_reference,p.unmatched_diagnostic_hours,p.export_ttl_hours,
      to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_text
      FROM public.privacy_jobs j JOIN public.zammad_instances z ON z.tenant_id=j.tenant_id
      JOIN public.retention_policies p ON p.tenant_id=j.tenant_id WHERE j.id=$1::uuid`,[id])).rows[0];
    assert.equal(row.lease_id,lease);assert.equal(row.state,'RUNNING');
    assert.equal(row.unmatched_diagnostic_hours_snapshot,row.job_type==='RETENTION_SWEEP'?row.unmatched_diagnostic_hours:null);
    const job={id:row.id,tenantId:row.tenant_id,requestId:row.request_id,jobType:row.job_type,scopeType:row.scope_type,scopeValue:row.scope_value,
      disposition:row.disposition,state:row.state,stage:row.stage,attempts:row.attempts,maxAttempts:row.max_attempts,fencingToken:Number(row.fencing_token),createdAt:row.created_text,
      zammadBaseUrl:row.base_url,zammadPrivacySecretReference:row.privacy_secret_reference,unmatchedDiagnosticHours:row.unmatched_diagnostic_hours_snapshot??row.unmatched_diagnostic_hours,exportTtlHours:row.export_ttl_hours};
    return{job,lease};
  };
  const workerTx=async(scope,work)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[scope]);return await work(c)}finally{await c.query('ROLLBACK');c.release()}};
  try{
    for(const scope of [tenant,foreign,clean]){
      await admin.query("INSERT INTO public.tenants(id,name,slug,state,retention_days) VALUES($1,'Signup privacy',$2,'ACTIVE',30)",[scope,`signup-privacy-${scope}`]);
      await admin.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role,state) VALUES($1::uuid,$2::uuid,'tenant_owner','ACTIVE')",[scope,actor]);
      await admin.query("INSERT INTO public.zammad_instances(tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference) VALUES($1::uuid,'https://zammad.example.invalid','6.5.0','WORKING','fixture://db',$1::uuid::text,$1::uuid::text,$2,$3)",
        [scope,`secret://tenants/${scope}/zammad/service`,`secret://tenants/${scope}/zammad/privacy`]);
    }
    const { job: interrupted, lease: interruptedLease } = await makeJob(tenant, 'DELETE');
    const recoveryState = async () => (await admin.query(
      'SELECT state,stage,lease_id,fencing_token,attempts FROM privacy_jobs WHERE id=$1', [interrupted.id],
    )).rows[0];
    const original = await recoveryState();
    const writeFailure = new Error('Synthetic failure after executing the fenced update');
    const rejectingWrites = new PrivacyRepository({ connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (sql.includes('app.fail_privacy_job')) {
            assert.equal(result.rows[0].failed, true);
            throw writeFailure;
          }
          return result;
        },
        release: () => client.release(),
      };
    } });
    const failure = { retryable: false, code: 'SYNTHETIC_FAILURE', safeError: 'Synthetic failure' };
    await assert.rejects(rejectingWrites.fail(interrupted, interruptedLease, failure), (error) => error === writeFailure);
    assert.deepEqual(await recoveryState(), original);
    await admin.query("UPDATE privacy_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [interrupted.id]);
    const newLease = randomUUID();
    const [recovered] = await repository.claim(tenant, newLease, 1);
    assert.equal(recovered?.id, interrupted.id);
    assert.equal(recovered.fencingToken, interrupted.fencingToken + 1);
    assert.equal((await recoveryState()).lease_id, newLease);
    assert.equal(await repository.fail(interrupted, interruptedLease, failure), false);
    await admin.query('DELETE FROM privacy_jobs WHERE id=$1', [interrupted.id]);
    await admin.query('DELETE FROM privacy_requests WHERE id=$1', [interrupted.requestId]);

    await seedAttempt(known,tenant,'EXPIRED');await seedAttempt(unknown,tenant,'OUTCOME_UNKNOWN');
    await seedAttempt(foreignAttempt,foreign,'EXPIRED');await seedAttempt(cleanAttempt,clean,'EXPIRED');
    await workerTx(tenant,c=>assertSignupPrivacyLogin(c,'wasalx_connector_worker'));
    const immutable=(await admin.query('SELECT selected_choice,credential_fingerprint,status,id,tenant_id FROM public.meta_signup_attempts WHERE id=$1',[known])).rows[0];
    const upload=await makeJob(tenant,'EXPORT','TENANT',tenant,false);let bytes,completed;
    const realOnce={expireHolds:repository.expireHolds.bind(repository),ensureMaintenanceJob:async()=>null,
      claim:async(t,l,n)=>{const rows=await repository.claim(t,l,n);assert.deepEqual(rows.map(j=>j.id),[upload.id]);return rows},discover:repository.discover.bind(repository),exportData:repository.exportData.bind(repository),renew:repository.renew.bind(repository),
      reserveArtifactUpload:repository.reserveArtifactUpload.bind(repository),persistArtifact:repository.persistArtifact.bind(repository),finalize:repository.finalize.bind(repository),
      complete:async(j,l,s)=>{completed=s;return repository.complete(j,l,s)},fail:async()=>assert.fail('real export must succeed')};
    const processor=new PrivacyProcessor(realOnce,{resolve:async()=>({token:'synthetic-privacy-token'})},{put:async(_key,value)=>{bytes=value},delete:async()=>assert.fail('export is read only')});
    assert.equal((await processor.drainTenant(tenant)).succeeded,1);
    const exported=await makeJob(tenant,'EXPORT');await repository.discover(exported.job,exported.lease);
    const data=await repository.exportData(exported.job,exported.lease);
    assert.deepEqual(data.metaSignupAttempts.map(row=>row.id).sort(),[known,unknown].sort());
    assert.equal(data.metaSignupAttempts.find(row=>row.id===known).selectedAsset.proofSha256,sourceAsset.proofSha256);
    const safe=JSON.stringify(data.metaSignupAttempts);
    for(const forbidden of ['secret://','credential_fingerprint','credential_metadata','challenge_sha256','registration_pin','MUST_NOT_EXPORT','Private discovered name',foreignAttempt])assert.equal(safe.includes(forbidden),false);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).local.metaSignupAttempts,data.metaSignupAttempts);
    assert.equal(completed.metaSignupAttempts,2);assert.equal(JSON.stringify(completed).includes(known),false);
    assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1',[known])).rows[0].name,'Private signup label','EXPORT cannot redact metadata');
    const subject=await makeJob(tenant,'EXPORT','PARTICIPANT','9999999');await repository.discover(subject.job,subject.lease);
    assert.deepEqual((await repository.exportData(subject.job,subject.lease)).metaSignupAttempts,[],'business phone text is not subject ownership');
    const deleting=await makeJob(tenant,'DELETE');await assert.rejects(()=>repository.discover(deleting.job,deleting.lease),e=>e.code==='META_SIGNUP_OUTCOME_UNRESOLVED');
    assert.equal((await admin.query('SELECT count(*)::int n FROM public.privacy_job_targets WHERE job_id=$1',[deleting.job.id])).rows[0].n,0);
    assert.equal((await admin.query('SELECT status,name FROM public.meta_signup_attempts WHERE id=$1',[unknown])).rows[0].status,'OUTCOME_UNKNOWN');
    const queuedHeld=await makeJob(clean,'DELETE','TENANT',clean,false);
    await admin.query("INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256) VALUES($1::uuid,$2::uuid,'META_SIGNUP_METADATA',$3,encode(public.digest($3,'sha256'),'hex'))",[clean,queuedHeld.id,cleanAttempt]);
    const hold=randomUUID();await admin.query(`INSERT INTO public.privacy_legal_holds(id,tenant_id,scope_type,scope_value,scope_sha256,reason,created_by)
      VALUES($1::uuid,$2::uuid,'TENANT',$2::uuid::text,repeat('f',64),'Synthetic legal hold',$3::uuid)`,[hold,clean,actor]);
    const heldLease=randomUUID();
    // Explicit synthetic admission after the hold, no provider/external attempt or claim rewrite.
    assert.equal((await admin.query("UPDATE public.privacy_jobs SET state='RUNNING',stage='EXTERNAL',attempts=1,fencing_token=1,lease_id=$2::uuid,lease_expires_at=clock_timestamp()+interval '15 minutes' WHERE id=$1::uuid AND state='QUEUED' AND stage='DISCOVER' AND lease_id IS NULL",[queuedHeld.id,heldLease])).rowCount,1);
    const held=await readFixtureJob(queuedHeld.id,heldLease);
    await assert.rejects(()=>repository.finalize(held.job,held.lease),e=>e.name==='PrivacyLegalHoldError');
    assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1',[cleanAttempt])).rows[0].name,'Private signup label');
    const heldDiscover=await makeJob(clean,'DELETE'),heldSweep=await makeJob(clean,'RETENTION_SWEEP');
    await workerTx(clean,async c=>{
      await signupPrivacyRejects(c,()=>signupPrivacyHelper(c,'discover',heldDiscover),e=>e.message==='signup privacy legal hold');
      assert.equal((await signupPrivacyHelper(c,'discover',heldSweep)).rows[0].value,0);
      await signupPrivacyLocalStage(c,held);
      await signupPrivacyRejects(c,()=>signupPrivacyHelper(c,'redact',held),e=>e.message==='signup privacy legal hold');
      assert.equal((await c.query("SELECT state FROM public.privacy_job_targets WHERE job_id=$1 AND target_type='META_SIGNUP_METADATA'",[held.job.id])).rows[0].state,'PENDING');
    });
    await admin.query("UPDATE public.privacy_legal_holds SET state='RELEASED',released_by=$2,released_at=clock_timestamp() WHERE id=$1",[hold,actor]);
    // Otherwise-valid phases: each wrong lease/fence/tenant probe has a real positive.
    const discoverProbe=await makeJob(clean,'EXPORT');
    await workerTx(clean,c=>assertSignupPrivacyAuthority(c,discoverProbe,'discover',foreign,async()=>{
      assert.equal((await signupPrivacyHelper(c,'discover',discoverProbe)).rows[0].value,1);
    }));
    await workerTx(tenant,c=>assertSignupPrivacyAuthority(c,exported,'export',foreign,async()=>{
      assert.deepEqual((await signupPrivacyHelper(c,'export',exported)).rows[0].value,data.metaSignupAttempts);
    }));
    await workerTx(clean,async c=>{
      await signupPrivacyLocalStage(c,held);
      await assertSignupPrivacyAuthority(c,held,'redact',foreign,async()=>{
        assert.equal((await signupPrivacyHelper(c,'redact',held)).rows[0].value,1);
        assert.equal((await c.query("SELECT state FROM public.privacy_job_targets WHERE job_id=$1 AND target_type='META_SIGNUP_METADATA'",[held.job.id])).rows[0].state,'COMPLETE');
      });
    });
    // Insert separate otherwise-valid LOCAL jobs for missing/foreign target tests.
    for(const invalidId of [randomUUID(),foreignAttempt]){
      const invalid=await makeJob(clean,'DELETE');
      await workerTx(clean,async c=>{
        await c.query("INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256) VALUES($1::uuid,$2::uuid,'META_SIGNUP_METADATA',$3,encode(public.digest($3,'sha256'),'hex'))",[clean,invalid.job.id,invalidId]);
        await signupPrivacyLocalStage(c,invalid);
        await signupPrivacyRejects(c,()=>signupPrivacyHelper(c,'redact',invalid),e=>e.code==='P0001'&&e.message==='signup privacy outcome unresolved');
        assert.equal((await c.query('SELECT state FROM public.privacy_job_targets WHERE job_id=$1',[invalid.job.id])).rows[0].state,'PENDING');
      });
    }
    const shadowRetention=await makeJob(tenant,'RETENTION_SWEEP');
    await verifySignupPrivacyShadows({admin,workerConfig,app,tenant,clean,foreignAttempt,cleanAttempt,exported,deleting,discoverProbe,held,shadowRetention,data});
    const result=await repository.finalize(held.job,held.lease);assert.equal(result.metaSignupAttempts,1);
    assert.equal((await admin.query('SELECT name FROM public.meta_signup_attempts WHERE id=$1',[foreignAttempt])).rows[0].name,'Private signup label');
    const retained=await makeJob(tenant,'RETENTION_SWEEP');await repository.discover(retained.job,retained.lease);
    assert.equal((await admin.query("SELECT count(*)::int n FROM public.privacy_job_targets WHERE job_id=$1 AND target_type='META_SIGNUP_METADATA'",[retained.job.id])).rows[0].n,1);
    assert.equal((await repository.finalize(retained.job,retained.lease)).metaSignupAttempts,1);
    assert.deepEqual((await admin.query('SELECT selected_choice,credential_fingerprint,status,id,tenant_id FROM public.meta_signup_attempts WHERE id=$1',[known])).rows[0],immutable);
    assert.deepEqual((await admin.query('SELECT name,choices,credential_metadata FROM public.meta_signup_attempts WHERE id=$1',[known])).rows[0],{name:'[removed]',choices:[],credential_metadata:null});
    await verifySignupPrivacyPredicates({admin,makeJob,workerTx,sourceAsset,actor});
    assert.deepEqual((await admin.query('SELECT status,name FROM public.meta_signup_attempts WHERE id=$1',[unknown])).rows[0],{status:'OUTCOME_UNKNOWN',name:'Private signup label'});
  }finally{await app.end();await pool.end()}
}
async function signupPrivacyRejects(client,work,predicate) {
  await client.query('SAVEPOINT signup_negative');
  try{await assert.rejects(work,predicate)}finally{await client.query('ROLLBACK TO SAVEPOINT signup_negative');await client.query('RELEASE SAVEPOINT signup_negative')}
}
function signupPrivacyHelper(client,phase,value,lease=value.lease,fence=value.job.fencingToken) {
  assert.ok(['discover','export','redact'].includes(phase));
  return client.query(`SELECT app.${phase}_meta_signup_privacy($1::uuid,$2::uuid,$3::bigint) AS value`,[value.job.id,lease,fence]);
}
async function signupPrivacyLocalStage(client,value) {
  assert.equal((await client.query("UPDATE public.privacy_jobs SET stage='LOCAL' WHERE id=$1 AND tenant_id=$2 AND state='RUNNING' AND lease_id=$3 AND fencing_token=$4 AND lease_expires_at>=clock_timestamp()",[value.job.id,value.job.tenantId,value.lease,value.job.fencingToken])).rowCount,1);
}
async function assertSignupPrivacyAuthority(client,value,phase,foreign,positive) {
  await positive();
  await signupPrivacyRejects(client,()=>signupPrivacyHelper(client,phase,value,randomUUID()),e=>e.code==='40001'&&e.message==='signup privacy lease lost');
  await signupPrivacyRejects(client,()=>signupPrivacyHelper(client,phase,value,value.lease,value.job.fencingToken+1),e=>e.code==='40001'&&e.message==='signup privacy lease lost');
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[foreign]);
  await signupPrivacyRejects(client,()=>signupPrivacyHelper(client,phase,value),e=>e.code==='40001'&&e.message==='signup privacy lease lost');
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[value.job.tenantId]);
}
async function assertSignupPrivacyLogin(client,role) {
  const pair=role==='wasalx_connector_worker'
    ? {current_role:'wasalx_connector_worker',login:'wasalx_connector_worker_runtime'}
    : {current_role:'wasalx_runtime',login:'wasalx_runtime'};
  const value=(await client.query(`SELECT current_user AS current_role,session_user AS login,
    pg_catalog.pg_has_role(current_user,$1,'MEMBER') current_member,
    pg_catalog.pg_has_role(session_user,$1,'MEMBER') login_member,
    pg_catalog.pg_has_role(current_user,'wasalx_app','MEMBER') current_app,
    pg_catalog.pg_has_role(session_user,'wasalx_app','MEMBER') login_app`,[role])).rows[0];
  assert.deepEqual({current_role:value.current_role,login:value.login},pair,'canonical supplied login/startup-role contract');
  assert.equal(value.current_member,true);assert.equal(value.login_member,true);
  assert.equal(value.current_app,role==='wasalx_app');assert.equal(value.login_app,role==='wasalx_app');
  const attributes=(await client.query(`SELECT rolname,rolsuper,rolbypassrls FROM pg_catalog.pg_roles
    WHERE rolname IN(current_user,session_user) ORDER BY rolname`)).rows;
  assert.deepEqual(attributes.map(row=>row.rolname),[...new Set([pair.current_role,pair.login])].sort());
  for(const row of attributes){assert.equal(row.rolsuper,false,row.rolname);assert.equal(row.rolbypassrls,false,row.rolname)}
  await assertSignupRuntimeSchemas(client);
}

async function verifySignupPrivacyShadows({admin,workerConfig,app,tenant,clean,foreignAttempt,cleanAttempt,exported,deleting,discoverProbe,held,shadowRetention,data}) {
  const immutable=(await admin.query('SELECT selected_choice,credential_fingerprint FROM public.meta_signup_attempts WHERE id=$1',[cleanAttempt])).rows[0];
  const shadow=new Client(workerConfig);await shadow.connect();try{
    await shadow.query('BEGIN');await shadow.query("SELECT set_config('app.tenant_id',$1,true)",[clean]);
    await assertSignupPrivacyLogin(shadow,'wasalx_connector_worker');
    // Exact real column types, no data/privilege copy; shadows exist before first helper call.
    for(const table of ['meta_signup_attempts','privacy_jobs','privacy_job_targets','tenants','retention_policies','privacy_legal_holds','connection_operations']){
      const cols=(await admin.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) type FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=pg_catalog.to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[`public.${table}`])).rows;
      assert.ok(cols.length);const quote=value=>'"'+value.replaceAll('"','""')+'"';
      await shadow.query(`CREATE TEMP TABLE ${quote(table)}(${cols.map(row=>`${quote(row.attname)} ${row.type}`).join(',')})`);
    }
    await shadow.query("INSERT INTO pg_temp.meta_signup_attempts(id,tenant_id,name,status,selected_choice) VALUES($1::uuid,$2::uuid,'DECOY_SECRET','EXPIRED',$3)",[foreignAttempt,clean,{access_token:'DECOY_SECRET'}]);
    await signupPrivacyLocalStage(shadow,held);
    assert.equal((await signupPrivacyHelper(shadow,'redact',held)).rows[0].value,1);
    assert.equal((await shadow.query('SELECT name FROM pg_temp.meta_signup_attempts WHERE id=$1',[foreignAttempt])).rows[0].name,'DECOY_SECRET');
    assert.deepEqual((await shadow.query('SELECT selected_choice,credential_fingerprint FROM public.meta_signup_attempts WHERE id=$1',[cleanAttempt])).rows[0],immutable);
    // Safe export is the worker's authorized readback of the real redaction in this transaction.
    const cleanExport=await signupPrivacyHelper(shadow,'discover',discoverProbe);assert.equal(cleanExport.rows[0].value,1);
    await shadow.query("UPDATE public.privacy_jobs SET stage='EXPORT' WHERE id=$1",[discoverProbe.job.id]);
    const rows=(await signupPrivacyHelper(shadow,'export',discoverProbe)).rows[0].value;
    assert.equal(rows.length,1);assert.equal(rows[0].id,cleanAttempt);assert.equal(rows[0].name,'[removed]');
    assert.equal(JSON.stringify(rows).includes('DECOY_SECRET'),false);
    await shadow.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
    await signupPrivacyRejects(shadow,()=>signupPrivacyHelper(shadow,'discover',deleting),e=>e.code==='P0001'&&e.message==='signup privacy outcome unresolved');
    assert.deepEqual((await signupPrivacyHelper(shadow,'export',exported)).rows[0].value,data.metaSignupAttempts);
    assert.equal((await signupPrivacyHelper(shadow,'discover',shadowRetention)).rows[0].value,1,'empty/fake temp metadata cannot hide eligible or manufacture UNKNOWN retention');
    await signupPrivacyRejects(shadow,()=>shadow.query("UPDATE public.meta_signup_attempts SET name='[removed]' WHERE id=$1",[cleanAttempt]),e=>e.code==='42501');
  }finally{await shadow.query('ROLLBACK');await shadow.end()}
  await assertSignupPrivacyLogin(app,'wasalx_app');
  await app.query('BEGIN');await app.query("SELECT set_config('app.tenant_id',$1,true)",[clean]);
  try{for(const [phase,value] of [['discover',deleting],['export',exported],['redact',held]])
    await signupPrivacyRejects(app,()=>signupPrivacyHelper(app,phase,value),e=>e.code==='42501');
  }finally{await app.query('ROLLBACK')}
}

// Bounded new helper predicates; each statement uses real canonical roles and schema.
async function verifySignupPrivacyPredicates({admin,makeJob,workerTx,sourceAsset,actor}) {
  const scope=randomUUID(),many=randomUUID();
  for(const tenant of [scope,many]){
    await admin.query("INSERT INTO public.tenants(id,name,slug,state,retention_days) VALUES($1::uuid,'Signup predicates',$2,'ACTIVE',30)",[tenant,`signup-predicate-${tenant}`]);
    await admin.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role,state) VALUES($1::uuid,$2::uuid,'tenant_owner','ACTIVE')",[tenant,actor]);
    await admin.query("INSERT INTO public.zammad_instances(tenant_id,base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference) VALUES($1::uuid,'https://zammad.example.invalid','6.5.0','WORKING','fixture://db',$1::uuid::text,$1::uuid::text,$2,$3)",[tenant,`secret://tenants/${tenant}/zammad/service`,`secret://tenants/${tenant}/zammad/privacy`]);
  }
  const eligible=randomUUID(),active=randomUUID(),recent=randomUUID(),unstored=randomUUID(),pending=randomUUID(),terminal=randomUUID(),operationUnknown=randomUUID();
  const seed=async(id,status,{age=40,expires=-39,stored=true,connection=null,operation=null}={})=>admin.query(`INSERT INTO public.meta_signup_attempts
    (id,tenant_id,name,idempotency_key,challenge_sha256,config,secret_reference,status,selected_choice,credential_fingerprint,credential_stored_at,created_at,expires_at,connection_id,operation_id)
    VALUES($1::uuid,$2::uuid,'Predicate metadata',$1::uuid::text,repeat('a',64),'{"payerMode":"CUSTOMER"}',$3,$4,$5,repeat('b',64),
      CASE WHEN $6::boolean THEN clock_timestamp() ELSE NULL END,clock_timestamp()-make_interval(days=>$7::integer),
      clock_timestamp()+make_interval(days=>$8::integer),$9::uuid,$10::uuid)`,[id,scope,`secret://${scope}/meta-signup/${id}`,status,sourceAsset,stored,age,expires,connection,operation]);
  await seed(eligible,'EXPIRED');await seed(active,'EXCHANGING');await seed(recent,'EXPIRED',{age:1,expires:1});await seed(unstored,'EXPIRED',{stored:false});
  for(const [id,state] of [[pending,'QUEUED'],[terminal,'SUCCEEDED'],[operationUnknown,'FAILED_TERMINAL']]){
    const connection=randomUUID(),operation=randomUUID();
    await admin.query("INSERT INTO public.connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1::uuid,$2::uuid,'Signup predicate','META','CLOUD_API','PAUSED',$3)",[connection,scope,`secret://${scope}/connections/${connection}/meta`]);
    await withFixtureTenant(admin,scope,()=>admin.query(`INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id,completed_at,error_code,safe_error)
      VALUES($1::uuid,$2::uuid,$3::uuid,'PROVISION',$1::uuid::text,'{}',$4,'USER',$5,'signup-privacy-predicate',CASE WHEN $4 IN('SUCCEEDED','FAILED_TERMINAL') THEN clock_timestamp() ELSE NULL END,CASE WHEN $4='FAILED_TERMINAL' THEN 'META_SIGNUP_REGISTRATION_UNKNOWN' ELSE NULL END,CASE WHEN $4='FAILED_TERMINAL' THEN 'Synthetic lost acknowledgement' ELSE NULL END)`,[operation,scope,connection,state,actor]));
    await seed(id,state==='FAILED_TERMINAL'?'OUTCOME_UNKNOWN':'EXPIRED',{connection,operation});
  }
  const sweep=await makeJob(scope,'RETENTION_SWEEP');
  await workerTx(scope,async client=>{
    assert.equal((await signupPrivacyHelper(client,'discover',sweep)).rows[0].value,2);
    assert.deepEqual((await client.query('SELECT target_id FROM public.privacy_job_targets WHERE job_id=$1 ORDER BY target_id',[sweep.job.id])).rows.map(row=>row.target_id),[eligible,terminal].sort());
  });
  await admin.query("UPDATE public.retention_policies SET state='PAUSED' WHERE tenant_id=$1",[scope]);
  await workerTx(scope,async client=>assert.equal((await signupPrivacyHelper(client,'discover',sweep)).rows[0].value,0));
  await admin.query("UPDATE public.retention_policies SET state='ACTIVE' WHERE tenant_id=$1",[scope]);
  const deletion=await makeJob(scope,'DELETE');
  await workerTx(scope,async client=>{
    await signupPrivacyRejects(client,()=>signupPrivacyHelper(client,'discover',deletion),e=>e.message==='signup privacy outcome unresolved');
    assert.equal((await client.query('SELECT count(*)::int n FROM public.privacy_job_targets WHERE job_id=$1',[deletion.job.id])).rows[0].n,0);
  });
  // Independently prove each LOCAL unresolved predicate against a valid leased stage.
  for(const id of [pending,unstored,active,operationUnknown])await workerTx(scope,async client=>{
    await client.query("INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256) VALUES($1::uuid,$2::uuid,'META_SIGNUP_METADATA',$3,encode(public.digest($3,'sha256'),'hex'))",[scope,deletion.job.id,id]);
    await signupPrivacyLocalStage(client,deletion);
    await signupPrivacyRejects(client,()=>signupPrivacyHelper(client,'redact',deletion),e=>e.message==='signup privacy outcome unresolved');
    assert.equal((await client.query('SELECT state FROM public.privacy_job_targets WHERE job_id=$1',[deletion.job.id])).rows[0].state,'PENDING');
  });
  // One bounded synthetic set exercises the actual 5001 sentinel and ordered 100 cap.
  await admin.query(`INSERT INTO public.meta_signup_attempts(id,tenant_id,name,idempotency_key,challenge_sha256,config,secret_reference,status,created_at,expires_at)
    SELECT id,$1::uuid,'Bounded metadata',id::text,repeat('a',64),'{"payerMode":"CUSTOMER"}',
      'secret://'||$1::uuid::text||'/meta-signup/'||id::text,'EXPIRED',clock_timestamp()-interval '40 days'-make_interval(secs=>ordinal),clock_timestamp()-interval '39 days'
    FROM (SELECT pg_catalog.gen_random_uuid() id,ordinal FROM pg_catalog.generate_series(1,5001) ordinal) candidate`,[many]);
  const overflow=await makeJob(many,'EXPORT');
  await workerTx(many,client=>signupPrivacyRejects(client,()=>signupPrivacyHelper(client,'discover',overflow),e=>e.code==='54000'&&e.message==='signup privacy scope too large'));
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.privacy_job_targets WHERE job_id=$1',[overflow.job.id])).rows[0].n,0);
  const bounded=await makeJob(many,'RETENTION_SWEEP');
  const expected=(await admin.query('SELECT id::text FROM public.meta_signup_attempts WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 100',[many])).rows.map(row=>row.id).sort();
  await workerTx(many,async client=>{
    assert.equal((await signupPrivacyHelper(client,'discover',bounded)).rows[0].value,100);
    assert.deepEqual((await client.query('SELECT target_id FROM public.privacy_job_targets WHERE job_id=$1 ORDER BY target_id',[bounded.job.id])).rows.map(row=>row.target_id),expected);
  });
  await admin.query(`INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256)
    SELECT $1::uuid,$2::uuid,'META_SIGNUP_METADATA',id::text,encode(public.digest(id::text,'sha256'),'hex') FROM public.meta_signup_attempts WHERE tenant_id=$1::uuid`,[many,overflow.job.id]);
  await admin.query("UPDATE public.privacy_jobs SET stage='EXPORT' WHERE id=$1",[overflow.job.id]);
  await workerTx(many,client=>signupPrivacyRejects(client,()=>signupPrivacyHelper(client,'export',overflow),e=>e.code==='54000'&&e.message==='signup privacy scope too large'));
}
