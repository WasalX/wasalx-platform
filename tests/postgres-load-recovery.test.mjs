import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Client, Pool } from "pg";
import { DatabaseService } from "../services/control-api/dist/database.service.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";

const EVENTS_PER_TENANT=24;
const ACCEPT_P95_LIMIT_MS=10_000;
const QUEUE_P95_LIMIT_MS=15_000;

test("webhook inbox stays bounded, isolated, replay safe, and recoverable across restarts",{timeout:30_000},async t=>{
  const adminUrl=required("DATABASE_ADMIN_URL");
  const appUrl=required("DATABASE_APP_URL");
  const suffix=randomUUID();
  const tenants=[randomUUID(),randomUUID()];
  const connections=[randomUUID(),randomUUID()];
  const providerSessions=[`load-session-a-${suffix}`,`load-session-b-${suffix}`];
  const routeKeys=tenants.map((tenantId)=>createHash("sha256").update(`load-route-${tenantId}`).digest("hex"));
  const admin=new Client({connectionString:adminUrl});
  const suspender=new Client({connectionString:adminUrl});
  const apis=new Set();
  const workers=new Set();
  const previousDatabaseUrl=process.env.DATABASE_URL;
  const previousPoolSize=process.env.DATABASE_POOL_SIZE;
  process.env.DATABASE_URL=appUrl;
  process.env.DATABASE_POOL_SIZE="16";
  await admin.connect();
  await suspender.connect();
  try{
    await admin.query(`INSERT INTO tenants (id,name,slug,state) VALUES ($1,'Load gate A',$3,'ACTIVE'),($2,'Load gate B',$4,'ACTIVE')`,[tenants[0],tenants[1],`load-a-${suffix}`,`load-b-${suffix}`]);
    await admin.query(`INSERT INTO connections (id,tenant_id,name,provider,engine,state,secret_reference) VALUES ($1,$3,'Load gate A','WAHA','GOWS','WORKING','secret://load/a'),($2,$4,'Load gate B','WAHA','GOWS','WORKING','secret://load/b')`,[connections[0],connections[1],tenants[0],tenants[1]]);
    for(let index=0;index<tenants.length;index++)await withFixtureTenant(admin,tenants[index],async()=>{
      await admin.query("INSERT INTO provider_sessions(tenant_id,connection_id,opaque_session_id,state,session_storage_reference) VALUES($1,$2,$3,'WORKING',$4)",[tenants[index],connections[index],providerSessions[index],`storage://load/${connections[index]}`]);
      await admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,route_token_sha256,hmac_secret_reference,state) VALUES($1,$2,'WAHA',$3,$4,'ACTIVE')",[tenants[index],connections[index],routeKeys[index],`secret://${tenants[index]}/connections/${connections[index]}/webhook`]);
    });

    const routes=tenants.map((tenant_id,index)=>({tenant_id,connection_id:connections[index],provider:"WAHA",hmac_secret_reference:`secret://${tenant_id}/connections/${connections[index]}/webhook`}));
    const inputs=routes.flatMap((route,tenantIndex)=>Array.from({length:EVENTS_PER_TENANT},(_,eventIndex)=>{
      const providerEventId=`load-${suffix}-${eventIndex}`;
      const payload={tenant:tenantIndex,event:eventIndex};
      return{route,input:{providerEventId,eventType:"message",payload,payloadSha256:createHash("sha256").update(JSON.stringify(payload)).digest("hex"),routeKey:routeKeys[tenantIndex],providerSessionKey:providerSessions[tenantIndex],providerEngine:"GOWS"}};
    }));

    const api=new DatabaseService();apis.add(api);
    const acceptanceLatencies=[];
    const accepted=await Promise.all(inputs.flatMap(({route,input})=>[0,1].map(async()=>{
      const started=performance.now();
      const result=await api.acceptWebhookEvent(route,input);
      acceptanceLatencies.push(performance.now()-started);
      return{tenantId:route.tenant_id,providerEventId:input.providerEventId,...result};
    })));
    for(const tenantId of tenants){
      const outcomes=accepted.filter(result=>result.tenantId===tenantId);
      assert.equal(outcomes.filter(result=>!result.duplicate).length,EVENTS_PER_TENANT);
      assert.equal(outcomes.filter(result=>result.duplicate).length,EVENTS_PER_TENANT);
      assert.equal(new Set(outcomes.map(result=>result.id)).size,EVENTS_PER_TENANT);
    }
    const acceptanceP95=p95(acceptanceLatencies);
    t.diagnostic(`webhook acceptance p95=${Math.round(acceptanceP95)}ms; limit=${ACCEPT_P95_LIMIT_MS}ms`);
    assert.ok(acceptanceP95<ACCEPT_P95_LIMIT_MS,`webhook acceptance p95 ${Math.round(acceptanceP95)}ms exceeded ${ACCEPT_P95_LIMIT_MS}ms`);

    await api.onModuleDestroy();apis.delete(api);
    const restartedApi=new DatabaseService();apis.add(restartedApi);
    const replayed=await Promise.all(inputs.map(({route,input})=>restartedApi.acceptWebhookEvent(route,input)));
    assert.ok(replayed.every(result=>result.duplicate));
    assert.deepEqual(new Set(replayed.map(result=>result.id)),new Set(accepted.map(result=>result.id)));

    const persisted=await admin.query(`SELECT tenant_id,count(*)::int AS rows,count(DISTINCT provider_event_id)::int AS unique_events FROM event_inbox WHERE tenant_id=ANY($1::uuid[]) GROUP BY tenant_id ORDER BY tenant_id`,[tenants]);
    assert.equal(persisted.rowCount,2);
    assert.ok(persisted.rows.every(row=>row.rows===EVENTS_PER_TENANT&&row.unique_events===EVENTS_PER_TENANT));

    const firstWorkers=Array.from({length:4},()=>{const worker=new InboundRepository(new Pool({connectionString:appUrl,max:2}));workers.add(worker);return worker});
    const firstClaims=await Promise.all([
      firstWorkers[0].claim(tenants[0],randomUUID(),12),firstWorkers[1].claim(tenants[0],randomUUID(),EVENTS_PER_TENANT),
      firstWorkers[2].claim(tenants[1],randomUUID(),12),firstWorkers[3].claim(tenants[1],randomUUID(),EVENTS_PER_TENANT),
    ]);
    const tailClaims=await Promise.all(tenants.map((tenantId,index)=>firstWorkers[index*2].claim(tenantId,randomUUID(),EVENTS_PER_TENANT)));
    const claimedByTenant=tenants.map((_,index)=>[...firstClaims[index*2],...firstClaims[index*2+1],...tailClaims[index]]);
    for(const [index,claims] of claimedByTenant.entries()){
      assert.equal(claims.length,EVENTS_PER_TENANT);
      assert.equal(new Set(claims.map(event=>event.id)).size,EVENTS_PER_TENANT);
      assert.ok(claims.every(event=>event.tenantId===tenants[index]));
    }
    assert.equal(new Set(claimedByTenant.flat().map(event=>event.id)).size,EVENTS_PER_TENANT*2);
    const queueLatencies=claimedByTenant.flat().map(event=>Math.max(0,Date.now()-new Date(event.receivedAt).getTime()));
    assert.ok(p95(queueLatencies)<QUEUE_P95_LIMIT_MS,`inbox queue-to-claim p95 exceeded ${QUEUE_P95_LIMIT_MS}ms`);

    await Promise.all(firstWorkers.map(worker=>worker.close()));firstWorkers.forEach(worker=>workers.delete(worker));
    await admin.query("UPDATE event_inbox SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=ANY($1::uuid[])",[tenants]);
    const restartedWorkers=tenants.map(()=>{const worker=new InboundRepository(new Pool({connectionString:appUrl,max:2}));workers.add(worker);return worker});
    const recovered=await Promise.all(restartedWorkers.map((worker,index)=>worker.claim(tenants[index],randomUUID(),EVENTS_PER_TENANT)));
    for(const [index,events] of recovered.entries()){
      assert.equal(events.length,EVENTS_PER_TENANT);
      assert.deepEqual(new Set(events.map(event=>event.id)),new Set(claimedByTenant[index].map(event=>event.id)));
      assert.ok(events.every(event=>event.tenantId===tenants[index]&&event.attempts===2));
    }

    const suspendedEvent=admissionInput(routes[1],routeKeys[1],providerSessions[1],`load-suspended-${suffix}`);
    await admin.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenants[1]]);
    await assert.rejects(()=>restartedApi.acceptWebhookEvent(routes[1],suspendedEvent),error=>error?.getStatus?.()===404);
    const existingSuspended=inputs.find(({route})=>route.tenant_id===tenants[1]);
    await assert.rejects(()=>restartedApi.acceptWebhookEvent(existingSuspended.route,existingSuspended.input),error=>error?.getStatus?.()===404);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM event_inbox WHERE tenant_id=$1 AND provider_event_id=$2",[tenants[1],suspendedEvent.providerEventId])).rows[0].count,0);
    await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenants[1]]);

    const racedEvent=admissionInput(routes[0],routeKeys[0],providerSessions[0],`load-suspension-race-${suffix}`);
    await suspender.query("BEGIN");
    await suspender.query("UPDATE tenants SET state='SUSPENDED' WHERE id=$1",[tenants[0]]);
    const racedAdmission=restartedApi.acceptWebhookEvent(routes[0],racedEvent).then(
      value=>({status:"fulfilled",value}),error=>({status:"rejected",error}),
    );
    await waitForTenantFence(admin);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM event_inbox WHERE tenant_id=$1 AND provider_event_id=$2",[tenants[0],racedEvent.providerEventId])).rows[0].count,0);
    await suspender.query("COMMIT");
    const racedOutcome=await racedAdmission;
    assert.equal(racedOutcome.status,"rejected");
    assert.equal(racedOutcome.error?.getStatus?.(),404);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM event_inbox WHERE tenant_id=$1 AND provider_event_id=$2",[tenants[0],racedEvent.providerEventId])).rows[0].count,0);
    await admin.query("UPDATE tenants SET state='ACTIVE' WHERE id=$1",[tenants[0]]);

    const heldEvent=inputs[0];
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('webhook-admission:' || app.webhook_event_id_sha256($1,$2,$3,$4),0))",[
      heldEvent.route.tenant_id,heldEvent.route.connection_id,heldEvent.route.provider,heldEvent.input.providerEventId,
    ]);
    const changedPayload={changed:true};
    const sameIdentity=Promise.allSettled([
      restartedApi.acceptWebhookEvent(heldEvent.route,heldEvent.input),
      restartedApi.acceptWebhookEvent(heldEvent.route,{...heldEvent.input,payload:changedPayload,payloadSha256:createHash("sha256").update(JSON.stringify(changedPayload)).digest("hex")}),
    ]);
    await waitForEventFence(admin);
    let independentDeadline;
    try {
      const independent=await Promise.race([
        restartedApi.acceptWebhookEvent(inputs[1].route,inputs[1].input),
        new Promise((_,reject)=>{independentDeadline=setTimeout(()=>reject(new Error("An unrelated event waited for the held event identity")),2_000)}),
      ]);
      assert.equal(independent.duplicate,true);
    } finally { clearTimeout(independentDeadline) }
    await admin.query("COMMIT");
    const sameIdentityResults=await sameIdentity;
    assert.equal(sameIdentityResults[0].status,"fulfilled");
    assert.equal(sameIdentityResults[0].value.duplicate,true);
    assert.equal(sameIdentityResults[1].status,"rejected");
    assert.equal(sameIdentityResults[1].reason.getStatus(),409);

    t.diagnostic(JSON.stringify({concurrent_requests:EVENTS_PER_TENANT*4,accepted_events:EVENTS_PER_TENANT*2,duplicate_rows:0,acceptance_p95_ms:Math.round(p95(acceptanceLatencies)),queue_to_claim_p95_ms:Math.round(p95(queueLatencies)),tenant_isolation:"passed",tenant_lifecycle_fence:"passed",api_restart_replay:"passed",worker_restart_recovery:"passed"}));
  }finally{
    await admin.query("ROLLBACK").catch(()=>undefined);
    await suspender.query("ROLLBACK").catch(()=>undefined);
    await Promise.allSettled([...workers].map(worker=>worker.close()));
    await Promise.allSettled([...apis].map(api=>api.onModuleDestroy()));
    await admin.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[tenants]).catch(()=>undefined);
    await suspender.end();
    await admin.end();
    if(previousDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousDatabaseUrl;
    if(previousPoolSize===undefined)delete process.env.DATABASE_POOL_SIZE;else process.env.DATABASE_POOL_SIZE=previousPoolSize;
  }
});

function p95(values){return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]}
function admissionInput(route,routeKey,providerSessionKey,providerEventId){const payload={event:providerEventId};return{providerEventId,eventType:"message",payload,payloadSha256:createHash("sha256").update(JSON.stringify(payload)).digest("hex"),routeKey,providerSessionKey,providerEngine:"GOWS"}}
async function waitForTenantFence(admin){
  for(let attempt=0;attempt<100;attempt+=1){
    const result=await admin.query(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
       WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
         AND query LIKE '%lock_current_active_tenant_for_event_admission%'
    ) AS blocked`);
    if(result.rows[0].blocked)return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail("Webhook admission did not wait for the tenant lifecycle fence");
}
async function waitForEventFence(admin){
  for(let attempt=0;attempt<100;attempt+=1){
    const result=await admin.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='wasalx-control-api'
        AND wait_event_type='Lock' AND wait_event='advisory'`);
    if(result.rows[0].waiting===2)return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail("Same event identity with different payloads did not share the admission lock");
}
function required(name){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value}
