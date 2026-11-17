import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DurableWorkScheduler } from "../services/connector-worker/dist/services/connector-worker/src/durable-scheduler.js";
import { DurableSchedulerRepository } from "../services/connector-worker/dist/services/connector-worker/src/durable-scheduler-repository.js";
import { verifyDrainJob } from "../services/connector-worker/dist/services/connector-worker/src/tenant-job.js";

const migrationUrl = new URL(
  "../services/control-api/migrations/0009_durable_worker_scheduler.sql",
  import.meta.url,
);
const privacyMigrationUrl = new URL(
  "../services/control-api/migrations/0017_privacy_retention_lifecycle.sql",
  import.meta.url,
);
const botActionsMigrationUrl = new URL("../services/control-api/migrations/0045_direct_bot_actions.sql", import.meta.url);
const botHandoffsMigrationUrl = new URL("../services/control-api/migrations/0050_direct_bot_handoff_jobs.sql", import.meta.url);
const botHandoffOrderMigrationUrl = new URL("../services/control-api/migrations/0061_bot_handoff_delivery_order.sql", import.meta.url);
const directDeliveryMigrationUrl = new URL("../services/control-api/migrations/0044_direct_bot_delivery.sql", import.meta.url);
const routingMigrationUrl = new URL("../services/control-api/migrations/0055_client_routing_scheduler.sql", import.meta.url);
const automaticGroupSyncMigrationUrl = new URL("../services/control-api/migrations/0075_waha_only_automatic_group_sync.sql", import.meta.url);
const groupWorkspaceMigrationUrl = new URL("../services/control-api/migrations/0088_group_workspace_scheduler.sql", import.meta.url);

test("scheduler discovery is narrow, privileged, and covers every durable queue", async () => {
  const sql = `${await readFile(migrationUrl, "utf8")}\n${await readFile(privacyMigrationUrl, "utf8")}\n${await readFile(botActionsMigrationUrl,"utf8")}\n${await readFile(botHandoffsMigrationUrl,"utf8")}\n${await readFile(botHandoffOrderMigrationUrl,"utf8")}\n${await readFile(routingMigrationUrl,"utf8")}`;
  assert.match(sql, /wasalx_scheduler_reader NOLOGIN BYPASSRLS/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET row_security = off/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.list_due_worker_tenants\(integer\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.list_due_worker_tenants\(integer\) TO wasalx_app/);
  for (const table of [
    "event_inbox",
    "delivery_outbox",
    "zammad_status_outbox",
    "connection_operations",
  ]) {
    assert.match(sql, new RegExp(`public\\.${table}`));
  }
  assert.match(sql, /tenant\.state IN \('PROVISIONING','ACTIVE'\)/);
  assert.match(sql, /'privacy'::text/);
  assert.match(sql,/bot_action_jobs action/);
  assert.match(sql,/bot_handoff_jobs handoff/);
  assert.match(sql,/delivery\.state IN \('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE'\)/);
  assert.match(sql,/client_routing_sync_jobs routing/);
  assert.doesNotMatch(sql,/conversation\.state<>'RESOLVED'/);
  assert.doesNotMatch(await readFile(directDeliveryMigrationUrl,"utf8"),/bot\.state<>'RESOLVED'|conversation\.state<>'RESOLVED'/);
  assert.doesNotMatch(sql, /message_body|payload\s*(?:,|FROM)/i);
});

test("scheduler JIT repair changes only the function-local setting", async () => {
  const sql = await readFile(new URL("../services/control-api/migrations/0192_worker_scheduler_jit_scope.sql", import.meta.url), "utf8");
  assert.equal(sql.replace(/^--[^\n]*(?:\n|$)/gmu, "").trim(),
    "ALTER FUNCTION app.list_due_worker_tenants(integer) SET jit=off;");
});

test("scheduler discovers retryable and expired leased work without exposing suspended tenants", async () => {
  const privacySql = await readFile(privacyMigrationUrl, "utf8");
  const sql = `${await readFile(migrationUrl, "utf8")}\n${privacySql}`;
  assert.match(sql, /'FAILED_RETRYABLE'/);
  assert.match(sql, /'PROCESSING'[\s\S]*lease_expires_at < now\(\)/);
  assert.match(sql, /'SENDING'[\s\S]*lease_expires_at < now\(\)/);
  assert.match(sql, /'RUNNING'[\s\S]*lease_expires_at < now\(\)/);
  assert.doesNotMatch(sql, /tenant\.state IN \([^)]*SUSPENDED/);
  assert.match(privacySql, /delivery\.state='SENDING' AND delivery\.lease_expires_at<now\(\)/);
  assert.match(privacySql, /connection\.state='WORKING'/);
  assert.match(privacySql, /binding\.state='ACTIVE'/);
  assert.match(privacySql, /session\.ownership_state='ACTIVE'/);
  assert.match(privacySql, /zammad\.state='WORKING'/);
  assert.match(privacySql, /FROM public\.retention_policies AS policy/);
});

test("scheduler queues bounded automatic group refreshes and keeps manual sync as fallback", async () => {
  const sql = await readFile(automaticGroupSyncMigrationUrl, "utf8");
  assert.match(sql, /connection\.provider='WAHA'/);
  assert.match(sql, /connection\.state IN \('WORKING','DEGRADED'\)/);
  assert.match(sql, /session\.ownership_state='ACTIVE'/);
  assert.match(sql, /session\.state='WORKING'/);
  assert.match(sql, /recent\.completed_at>=now\(\)-interval '15 minutes'/);
  assert.match(sql, /pending\.state IN \('QUEUED','RUNNING','FAILED_RETRYABLE'\)/);
  assert.match(sql, /ON CONFLICT \(tenant_id,idempotency_key\) DO NOTHING/);
  assert.match(sql, /'SYSTEM','connector-scheduler'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.queue_due_group_syncs\(integer\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.queue_due_group_syncs\(integer\) TO wasalx_app/);
});

test("scheduler discovers ticketless captured-group deliveries", async () => {
  const sql = await readFile(groupWorkspaceMigrationUrl, "utf8");
  assert.match(sql, /GRANT SELECT \(group_workspace_group_id\) ON delivery_outbox TO wasalx_scheduler_reader/);
  assert.match(sql, /GRANT SELECT \(tenant_id,whatsapp_group_id,capture_enabled\)[\s\S]*ON group_workspace_settings TO wasalx_scheduler_reader/);
  assert.match(sql, /workspace\.whatsapp_group_id=delivery\.group_workspace_group_id/);
  assert.match(sql, /workspace\.capture_enabled/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.list_due_worker_tenants\(integer\) FROM PUBLIC/);
});

test("scheduler persists automatic group refreshes before discovering due work", async () => {
  const calls: string[] = [];
  const repository = new DurableSchedulerRepository({
    async query(sql: string) {
      calls.push(sql);
      if(sql.includes("scan_meta_direct_transition_work"))return{rows:[{page:{nextCursor:null,examined:0,ready:[]}}]};
      return sql.includes("list_due_worker_tenants")
        ? { rows: [{ tenant_id: "10000000-0000-4000-8000-000000000001", work_type: "connection" }] }
        : { rows: [{ queue_due_group_syncs: 1 }] };
    },
  } as never);
  assert.deepEqual(await repository.dueWork(25), [{
    tenantId: "10000000-0000-4000-8000-000000000001",
    workType: "connection",
  }]);
  assert.deepEqual(calls, [
    "SELECT app.queue_due_group_syncs($1)",
    "SELECT tenant_id,work_type FROM app.list_due_worker_tenants($1)",
    "SELECT app.scan_meta_direct_transition_work($1,$2) AS page",
  ]);
});

test("durable scheduler signs and deduplicates a wakeup for every queue type", async () => {
  const tenantId = "10000000-0000-4000-8000-000000000001";
  const secret = "scheduler-secret-at-least-thirty-two-bytes";
  const calls: Array<{ type: string; name: string; data: { tenantId: string; token: string }; options: { jobId: string } }> = [];
  const queue = (type: string) => ({
    async add(name: string, data: { tenantId: string; token: string }, options: { jobId: string }) {
      calls.push({ type, name, data, options });
    },
  });
  const scheduler = new DurableWorkScheduler(
    {
      async dueWork() {
        return (["delivery", "inbound", "connection", "privacy", "routing"] as const).map((workType) => ({ tenantId, workType }));
      },
    },
    { delivery: queue("delivery"), inbound: queue("inbound"), connection: queue("connection"), privacy: queue("privacy"), routing: queue("routing") },
    secret,
    { intervalMs: 60_000 },
  );
  assert.equal(scheduler.ready(), false);
  assert.deepEqual(await scheduler.tick(), { skipped: false, queued: 5 });
  assert.equal(scheduler.ready(), true);
  assert.deepEqual(calls.map((call) => call.options.jobId).sort(), [
    `durable-delivery-${tenantId}`,
    `durable-inbound-${tenantId}`,
    `durable-connection-${tenantId}`,
    `durable-privacy-${tenantId}`,
    `durable-routing-${tenantId}`,
  ].sort());
  for (const call of calls) {
    await verifyDrainJob(
      call.data,
      secret,
      call.type === "inbound" ? "inbox:drain" : `${call.type}:drain`,
    );
  }
});

test("a failed enqueue keeps the scheduler overlap guard until every write settles", async () => {
  let finishPending!: () => void;
  let pendingStarted!: () => void;
  const started = new Promise<void>((resolve) => { pendingStarted = resolve; });
  const pending = new Promise<void>((resolve) => { finishPending = resolve; });
  let scans = 0;
  const queue = { async add() {} };
  const scheduler = new DurableWorkScheduler(
    { async dueWork() {
      scans++;
      return [
        { tenantId: "10000000-0000-4000-8000-000000000001", workType: "delivery" as const },
        { tenantId: "10000000-0000-4000-8000-000000000002", workType: "inbound" as const },
      ];
    } },
    {
      delivery: { async add() { throw new Error("Redis write failed"); } },
      inbound: { async add() { pendingStarted(); await pending; } },
      connection: queue, privacy: queue, routing: queue,
    },
    "scheduler-secret-at-least-thirty-two-bytes",
  );
  const tick = scheduler.tick();
  try {
    await started;
    // Let the failed write propagate before starting another scheduled tick.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await scheduler.tick(), { skipped: true, queued: 0 });
    assert.equal(scans, 1);
    assert.equal(scheduler.ready(), false);
  } finally {
    finishPending();
    assert.deepEqual(await tick, { skipped: false, queued: 0, error: true });
  }
});


test("Meta metadata wake advances actual pages across a held prefix, wrap, dedupe and restart",async()=>{
  const tenantId="10000000-0000-4000-8000-000000000001";
  const ids=Array.from({length:96},(_,index)=>`20000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`);
  const examined:string[][]=[];
  const database={async query(sql:string,values?:unknown[]){
    if(sql.includes("queue_due_group_syncs")||sql.includes("list_due_worker_tenants"))return{rows:[]};
    assert.equal(sql,"SELECT app.scan_meta_direct_transition_work($1,$2) AS page");
    const after=values?.[1] as string|null;
    const start=after===null?0:ids.indexOf(after)+1;
    const page=ids.slice(start===ids.length?0:start,(start===ids.length?0:start)+Number(values?.[0]));
    examined.push(page);
    return{rows:[{page:{nextCursor:page.at(-1)??null,examined:page.length,
      ready:page.includes(ids[95])?[{tenantId,eventId:ids[95]}]:[]}}]};
  }};
  const repository=new DurableSchedulerRepository(database as never);
  assert.deepEqual(await repository.dueWork(),[]);
  assert.deepEqual(await repository.dueWork(),[]);
  const expected=[{tenantId,workType:"delivery",metaTransitionEventIds:[ids[95]]}];
  assert.deepEqual(await repository.dueWork(),expected);
  assert.equal(new Set(examined.flat()).size,96,"Fixed cadence never chooses the same held page indefinitely");
  // Existing queue dedupe may discard this wake; source was never removed.
  await repository.dueWork();await repository.dueWork();
  assert.deepEqual(await repository.dueWork(),expected,"A later wrap rediscovers the same pending source");
  const restarted=new DurableSchedulerRepository(database as never);
  await restarted.dueWork();await restarted.dueWork();
  assert.deepEqual(await restarted.dueWork(),expected,"Restart resets only inspection, not DB work or effects");
});

test("concurrent metadata discovery serializes the cursor and malformed pages never advance it",async()=>{
  const first="20000000-0000-4000-8000-000000000001",second="20000000-0000-4000-8000-000000000002";
  const cursors:Array<unknown>=[];let malformed=false;
  const repository=new DurableSchedulerRepository({async query(sql:string,values?:unknown[]){
    if(!sql.includes("scan_meta_direct_transition_work"))return{rows:[]};
    cursors.push(values?.[1]);
    if(malformed)return{rows:[{page:{nextCursor:"foreign",examined:1,ready:[]}}]};
    return{rows:[{page:{nextCursor:values?.[1]===null?first:second,examined:1,ready:[]}}]};
  }} as never);
  await Promise.all([repository.dueWork(),repository.dueWork()]);
  assert.deepEqual(cursors,[null,first]);
  malformed=true;await assert.rejects(repository.dueWork(),/Invalid Meta transition scan/);
  malformed=false;await repository.dueWork();assert.deepEqual(cursors.slice(-2),[second,second]);
});

test("existing delivery wake carries only bounded typed source hints after authenticated admission",async()=>{
  const tenantId="10000000-0000-4000-8000-000000000001",eventId="20000000-0000-4000-8000-000000000001";
  const secret="scheduler-secret-at-least-thirty-two-bytes";let captured:unknown;
  const queue={async add(_name:string,data:unknown){captured=data;}};
  const scheduler=new DurableWorkScheduler({async dueWork(){return[{tenantId,workType:"delivery",metaTransitionEventIds:[eventId]}];}},
    {delivery:queue,inbound:queue,connection:queue,privacy:queue,routing:queue},secret);
  assert.equal((await scheduler.tick()).queued,1);
  assert.deepEqual((await verifyDrainJob(captured,secret)).metaTransitionEventIds,[eventId]);
  await assert.rejects(verifyDrainJob({...captured as object,metaTransitionEventIds:["invalid"]},secret),/Malformed transition wake/);
  await assert.rejects(verifyDrainJob({...captured as object,metaTransitionEventIds:Array(33).fill(eventId)},secret),/Malformed transition wake/);
});
