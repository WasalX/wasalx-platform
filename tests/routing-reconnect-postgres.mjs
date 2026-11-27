import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {BotFlowsService} from '../services/control-api/dist/bot-flows.service.js';
import {SecretCleanupRepository} from '../services/control-api/dist/secret-cleanup.repository.js';
import {SecretCleanupProcessor} from '../services/control-api/dist/secret-cleanup.service.js';

export async function verifyRoutingReconnect(client) {
  const actor='10100000-0000-4000-8000-000000000001';
  const sha=()=>createHash('sha256').update(randomUUID()).digest('hex');
  const begin='SELECT * FROM app.begin_client_routing_credential($1,$2,$3,$4,$5,$6,$7,$8)';
  const complete='SELECT * FROM app.complete_client_routing_credential($1,$2)';
  for(const state of ['CONNECTING','REVOKED']) {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id','10000000-0000-4000-8000-000000000001',true)");
      const original=(await client.query(begin,[actor,'HTTP_JSON','Reconnect fixture','HMAC',null,null,sha(),sha()])).rows[0];
      if(state==='REVOKED')await client.query('SELECT app.abort_client_routing_credential($1,$2)',[original.integration_id,actor]);
      const revision=state==='REVOKED'?2:1;
      const key=sha(),payload=sha();
      const args=[actor,'HTTP_JSON','Reconnect fixture','HMAC',original.integration_id,revision,key,payload];
      for(const invalidRevision of [null,revision+1]) {
        await client.query('SAVEPOINT stale');
        await assert.rejects(()=>client.query(begin,args.map((value,index)=>index===5?invalidRevision:value)),error=>error.code==='40001');
        await client.query('ROLLBACK TO SAVEPOINT stale');
      }
      const replacement=(await client.query(begin,args)).rows[0];
      assert.equal(replacement.duplicate,false);
      assert.notEqual(replacement.secret_reference,original.secret_reference);
      const replay=(await client.query(begin,args)).rows[0];
      assert.equal(replay.integration_id,replacement.integration_id);assert.equal(replay.duplicate,true);
      await client.query('SAVEPOINT conflicting_payload');
      await assert.rejects(()=>client.query(begin,args.map((value,index)=>index===7?sha():value)),error=>error.code==='40001');
      await client.query('ROLLBACK TO SAVEPOINT conflicting_payload');
      const connected=(await client.query(complete,[replacement.integration_id,actor])).rows[0];
      assert.equal(connected.changed,true);
      const old=(await client.query('SELECT state,revision,secret_reference FROM client_routing_integrations WHERE id=$1',[original.integration_id])).rows[0];
      assert.equal(old.state,'REVOKED');assert.equal(Number(old.revision),revision+1);
      assert.equal(old.secret_reference,original.secret_reference);
      assert.equal((await client.query(complete,[replacement.integration_id,actor])).rows[0].changed,false);
    } finally {await client.query('ROLLBACK');}
  }
}

export async function verifyNotionOAuthRecovery({app, admin, cleanupUrl}) {
  const tenantId = "10000000-0000-4000-8000-000000000001";
  const otherTenant = "20000000-0000-4000-8000-000000000002";
  const userId = "10100000-0000-4000-8000-000000000001";
  const principal = {
    tenantId, userId, role: "tenant_owner", authenticatedAt: Math.floor(Date.now() / 1000),
    authenticationMethods: ["mfa"],
  };
  const redirectUri = "https://app.example.invalid/oauth/notion/callback";
  const workspaceId = randomUUID();
  const callbackCode = "synthetic-oauth-code";
  const accessToken = "synthetic-oauth-access-token";
  const credentials = new Map();
  const deleted = [];
  let rejectAcknowledgement = false;
  let rejectAbort = false;
  let rejectDelete;
  let aborted = 0;
  const database = {
    withTenant: async (tenant, operation) => {
      await app.query("BEGIN");
      let activated = false;
      let result;
      try {
        await app.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
        result = await operation({
          query: async (sql, values) => {
            if (sql.includes("abort_client_routing_notion_oauth")) {
              aborted++;
              if (rejectAbort) throw new Error(callbackCode);
            }
            const response = await app.query(sql, values);
            if (/complete_(?:claimed_)?client_routing_notion_oauth/u.test(sql)) activated = response.rowCount === 1;
            return response;
          },
        });
        await app.query("COMMIT");
      } catch (error) {
        await app.query("ROLLBACK");
        throw error;
      }
      if (activated && rejectAcknowledgement) throw new Error(accessToken);
      return result;
    },
  };
  const secrets = {
    storeRoutingCredential: async (reference, value) => credentials.set(reference, value.accessToken),
    deleteSecret: async (reference) => {
      if (reference === rejectDelete) throw new Error(`${accessToken} ${reference}`);
      deleted.push(reference);
      credentials.delete(reference);
    },
  };
  const service = new BotFlowsService(database, null, null, {resolveHmac: async () => "fixture-client-secret"}, {
    notionOAuthEnabled: true, notionOAuthClientId: "fixture-client", notionOAuthRedirectUri: redirectUri,
  }, secrets);
  const previousFetch = globalThis.fetch;
  const cleanupDatabase = process.env.SECRET_CLEANUP_DATABASE_URL;
  process.env.SECRET_CLEANUP_DATABASE_URL = cleanupUrl.toString();
  const repository = new SecretCleanupRepository();
  const cleanup = new SecretCleanupProcessor(repository, secrets, 100);
  globalThis.fetch = async () => Response.json({
    access_token: accessToken, workspace_id: workspaceId, workspace_name: "Synthetic OAuth workspace",
  });
  const start = async (integrationId) => {
    const row = await service.startNotionRoutingOAuth(principal, "notion-start", {integrationId});
    const state = new URL(row.authorizationUrl).searchParams.get("state");
    return {
      id: row.integrationId, state, digest: createHash("sha256").update(state).digest("hex"),
      reference: `secret://tenants/${tenantId}/routing/integrations/${row.integrationId}`,
    };
  };
  const complete = (stage) => service.completeNotionRoutingOAuth(principal, "notion-callback", {
    state: stage.state, code: callbackCode,
  });
  const read = async (stage, tenant = tenantId, actor = userId) =>
    (await database.withTenant(tenant, (client) => client.query(
      "SELECT * FROM app.read_client_routing_notion_oauth($1,$2)", [stage.digest, actor],
    ))).rows[0];
  const outbox = async (stage) => {
    const result = await admin.query(`SELECT state,attempts,error_code,safe_error,secret_reference
      FROM public.secret_cleanup_outbox WHERE tenant_id=$1 AND routing_integration_id=$2`, [tenantId, stage.id]);
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].secret_reference, stage.reference);
    return result.rows[0];
  };
  try {
    const committed = await start();
    rejectAcknowledgement = true;
    assert.deepEqual(await complete(committed), {
      integrationId: committed.id, provider: "NOTION", displayName: "Synthetic OAuth workspace", revision: 2,
    });
    rejectAcknowledgement = false;
    assert.equal(aborted, 0);
    assert.deepEqual(deleted, []);
    assert.equal((await read(committed)).status, "COMMITTED");
    assert.equal(await read(committed, otherTenant), undefined);
    assert.equal(await read(committed, tenantId, randomUUID()), undefined);

    const deletionFailure = await start();
    assert.equal((await outbox(deletionFailure)).state, "QUEUED");
    await assert.rejects(() => complete(deletionFailure), /already connected/u);
    assert.equal((await read(deletionFailure)).status, "ABORTED");
    assert.equal(credentials.get(deletionFailure.reference), accessToken);
    rejectDelete = deletionFailure.reference;
    await cleanup.drain();
    const failed = await outbox(deletionFailure);
    assert.equal(failed.state, "FAILED_RETRYABLE");
    assert.equal(failed.error_code, "SECRET_CLEANUP_UNEXPECTED_FAILURE");
    assert.equal(failed.safe_error, "Secret cleanup failed temporarily.");
    rejectDelete = undefined;
    await admin.query("UPDATE public.secret_cleanup_outbox SET available_at=now() WHERE tenant_id=$1 AND routing_integration_id=$2",
      [tenantId, deletionFailure.id]);
    await cleanup.drain();
    assert.equal((await outbox(deletionFailure)).state, "SUCCEEDED");
    assert.equal(credentials.has(deletionFailure.reference), false);

    const abortFailure = await start();
    rejectAbort = true;
    await assert.rejects(() => complete(abortFailure), (error) => {
      assert.equal(error.getResponse().code, "NOTION_OAUTH_RECOVERY_PENDING");
      assert.equal(JSON.stringify(error.getResponse()).includes(callbackCode), false);
      return true;
    });
    assert.equal((await read(abortFailure)).status, "CLAIMED");
    assert.equal((await outbox(abortFailure)).state, "QUEUED");
    assert.equal(credentials.get(abortFailure.reference), accessToken);
    rejectAbort = false;
    await admin.query(`UPDATE public.client_routing_integrations SET updated_at=now()-interval '2 hours'
      WHERE tenant_id=$1 AND id=$2`, [tenantId, abortFailure.id]);
    await cleanup.drain();
    assert.equal((await read(abortFailure)).status, "ABORTED");
    assert.equal((await outbox(abortFailure)).state, "SUCCEEDED");
    assert.equal(credentials.has(abortFailure.reference), false);

    const beforeRepeat = deleted.slice();
    await cleanup.drain();
    assert.deepEqual(deleted, beforeRepeat);
    assert.equal((await read(committed)).status, "COMMITTED");
    assert.equal((await outbox(committed)).attempts, 0);
    assert.equal(credentials.get(committed.reference), accessToken);

    const replacement = await start(deletionFailure.id);
    assert.notEqual(replacement.id, deletionFailure.id);
    assert.notEqual(replacement.reference, deletionFailure.reference);
    const restarted = await start(replacement.id);
    assert.equal(restarted.id, replacement.id);
    assert.equal(await read(replacement), undefined);
    await assert.rejects(() => complete(replacement), /expired or was already used/u);
    const reconnect = await start(committed.id);
    assert.equal(reconnect.id, committed.id);
    assert.deepEqual(await service.abortNotionRoutingOAuth(principal, "notion-abort", {state: reconnect.state, reason: "DENIED"}), {
      aborted: true, integrationId: committed.id,
    });
    await cleanup.drain();
    assert.equal((await outbox(committed)).attempts, 0);
    assert.equal(credentials.get(committed.reference), accessToken);
    const connected = await database.withTenant(tenantId, (client) => client.query(
      "SELECT state FROM public.client_routing_integrations WHERE id=$1", [committed.id],
    ));
    assert.equal(connected.rows[0].state, "CONNECTED");
  } finally {
    globalThis.fetch = previousFetch;
    if (cleanupDatabase === undefined) delete process.env.SECRET_CLEANUP_DATABASE_URL;
    else process.env.SECRET_CLEANUP_DATABASE_URL = cleanupDatabase;
    await repository.onModuleDestroy();
  }
}
