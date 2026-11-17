import assert from 'node:assert/strict';
const inboxTerminal=new Set(['PROCESSED','IGNORED','QUARANTINED','UNMATCHED','DUPLICATE','FAILED_TERMINAL']);
export const deliveryTerminalStates=Object.freeze(['SENT','DELIVERED','READ','CANCELLED','FAILED_TERMINAL','PRIVACY_CANCELLED']);
export const operationTerminalStates=Object.freeze(['SUCCEEDED','FAILED_TERMINAL','CANCELLED']);
const deliveryTerminal=new Set(deliveryTerminalStates);
// Snapshot comes from existing tenant-scoped SQL/provider observers, never UI.
// ids includes every dispatch/reprocess intent registered BEFORE submission.
export function assertOwnedWorkSettled(snapshot) {
 assert.equal(snapshot.complete,true,'Restoration observer is incomplete');
 assert.equal(snapshot.dispatchClosed,true,'Dispatch must close before restoration');
 assert.equal(snapshot.ambiguousOperations,0,'Ambiguous submission requires reconciliation');
 assert.deepEqual([...new Set(snapshot.expectedInboxIds)].sort(),snapshot.inbox.map(x=>x.id).sort(),'Owned inbox absent or duplicated');
 for(const row of snapshot.inbox){
  assert(inboxTerminal.has(row.status),'Owned inbox remains eligible for processing');
  assert(row.processedAt,'Owned inbox has no completion receipt');
  assert.equal(row.leaseId,null,'Owned inbox lease remains');
  assert.equal(row.leaseExpiresAt,null,'Owned inbox lease expiry remains');
 }
 for(const row of snapshot.deliveries){
  assert(deliveryTerminal.has(row.state),'Owned delivery is pending or uncertain');
  assert.equal(row.leaseId,null);assert.equal(row.leaseExpiresAt,null);
 }
 assert.equal(snapshot.pendingOwnedDescendants,0,'Owned native/action/status work remains');
 assert.deepEqual(snapshot.retainedUnknowns,snapshot.originalUnknowns,'Historical unknown receipts changed');
}
// One SQL statement: no LIMIT; future-due retries remain blockers.
export const restorationSql=`WITH owned AS (
 SELECT e.* FROM event_inbox e
 WHERE e.tenant_id=$1 AND e.connection_id=$2
 AND (e.id=ANY($4::uuid[]) OR e.provider_event_id_sha256 IN (
   SELECT app.webhook_event_id_sha256($1,$2,$5,x) FROM unnest($3::text[]) x))
), deliveries AS (SELECT * FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2), direct_jobs AS (
 SELECT j.state,j.lease_id,j.lease_expires_at,j.completed_at FROM bot_handoff_jobs j JOIN bot_conversations c ON c.tenant_id=j.tenant_id AND c.id=j.conversation_id WHERE c.tenant_id=$1 AND c.connection_id=$2
 UNION ALL SELECT j.state,j.lease_id,j.lease_expires_at,j.completed_at FROM bot_action_jobs j JOIN bot_conversations c ON c.tenant_id=j.tenant_id AND c.id=j.conversation_id WHERE c.tenant_id=$1 AND c.connection_id=$2
)

SELECT
 (SELECT count(*) FROM direct_jobs WHERE state NOT IN ('SUCCEEDED','FAILED_TERMINAL') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL OR completed_at IS NULL)::int AS pending_direct,
 (SELECT count(*) FROM direct_jobs WHERE state='OUTCOME_UNKNOWN')::int AS unknown_direct,
 (SELECT count(*) FROM group_action_executions g JOIN owned o ON o.id=g.event_inbox_id AND o.tenant_id=g.tenant_id WHERE g.state='OUTCOME_UNKNOWN')::int AS unknown_actions,
 COALESCE((SELECT json_agg(json_build_object('id',id,'status',status,'processedAt',processed_at,'leaseId',lease_id,'leaseExpiresAt',lease_expires_at) ORDER BY id) FROM owned),'[]') AS inbox,
 COALESCE((SELECT json_agg(json_build_object('id',id,'state',state,'leaseId',lease_id,'leaseExpiresAt',lease_expires_at) ORDER BY id) FROM deliveries WHERE state<>'OUTCOME_UNKNOWN'),'[]') AS deliveries,
 COALESCE((SELECT json_agg(json_build_object('id',id,'state',state,'attempts',attempts,'external_message_id',external_message_id) ORDER BY id) FROM deliveries WHERE state='OUTCOME_UNKNOWN'),'[]') AS unknowns,
 (SELECT count(*) FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND (status IN ('ACCEPTED','FAILED_RETRYABLE','PROCESSING') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL))::int AS pending_inbox,
 (SELECT count(*) FROM group_action_executions g JOIN owned o ON o.id=g.event_inbox_id AND o.tenant_id=g.tenant_id WHERE g.state NOT IN ('SUCCEEDED','FAILED_TERMINAL') OR g.completed_at IS NULL)::int AS pending_actions,
 (SELECT count(*) FROM zammad_status_outbox s JOIN deliveries d ON d.id=s.delivery_id AND d.tenant_id=s.tenant_id WHERE s.completed_at IS NULL OR s.lease_id IS NOT NULL OR s.lease_expires_at IS NOT NULL)::int AS pending_status,
 (SELECT count(*) FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND (state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL))::int AS pending_operations`;
export async function readOwnedRestoration({scoped,tenantId,connectionId,registry,originalUnknowns,provider='WAHA'}) {
 assert(['WAHA','META'].includes(provider));
 // Registry is the existing durable intent registry, closed before this call.
 // Every attempted ingress must be registered before network submission; an
 // unresolved submission is represented by its stable provider event ID.
 const entries=registry.entries();assert.equal(registry.closed,true);
 assert(entries.every(x=>x.kind==='inbound'||x.kind==='reprocess'),'Unsupported owned operation must have its own observer before restoration');
 const events=entries.filter(x=>x.kind==='inbound').map(x=>x.eventId);
 const ids=entries.filter(x=>x.kind==='reprocess').map(x=>x.inboxId);
 assert(events.every(x=>typeof x==='string'&&x.length>0));assert(ids.every(x=>typeof x==='string'&&x.length>0));
 assert.equal(new Set(events).size,events.length);assert.equal(new Set(ids).size,ids.length);
 const rows=await scoped(restorationSql,[tenantId,connectionId,events,ids,provider]);assert.equal(rows.length,1);const row=rows[0];
 assert.equal(row.inbox.length,events.length+ids.length,'Missing or overlapping owned ingress: hold configuration');
 const snapshot={complete:true,dispatchClosed:true,ambiguousOperations:0,expectedInboxIds:row.inbox.map(x=>x.id),inbox:row.inbox,deliveries:row.deliveries,pendingOwnedDescendants:row.pending_inbox+row.pending_actions+row.pending_status+row.pending_operations+row.pending_direct,retainedUnknowns:row.unknowns,originalUnknowns};
 assert.equal(row.unknown_direct,0,'Unknown direct action requires reconciliation');
 assert.equal(row.unknown_actions,0,'Unknown group action requires reconciliation');
 assert.deepEqual(snapshot.retainedUnknowns,originalUnknowns,'Historical unknown receipts changed');
 return snapshot;
}
export async function restoreObservedConfiguration({checkpoint,restore,primaryFailure,...observation}) {
 let snapshot;
 try {snapshot=await observeOwnedRestoration(observation);}
 catch(error){await checkpoint({phase:'configuration-held',reason:'owned-work-unsettled'});throw new AggregateError([...(primaryFailure?[primaryFailure]:[]),error],'Owned work must settle before configuration restoration');}
 await checkpoint({phase:'configuration-restoration-admitted',inboxIds:snapshot.expectedInboxIds});return restore();
}

export async function observeOwnedRestoration(options){const snapshot=await readOwnedRestoration(options);assertOwnedWorkSettled(snapshot);return snapshot;}
export async function waitOwnedRestoration(options,{timeoutMs=120000,intervalMs=500,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 assert(timeoutMs>0&&timeoutMs<=120000&&intervalMs>0);
 const deadline=now()+timeoutMs;
 for(;;){
  const snapshot=await readOwnedRestoration(options); // Registry, provider, unknown and SQL failures are immediate.
  const pending=snapshot.pendingOwnedDescendants>0||snapshot.inbox.some(r=>['ACCEPTED','PROCESSING','FAILED_RETRYABLE'].includes(r.status))||snapshot.deliveries.some(r=>['QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE'].includes(r.state));
  if(!pending){assertOwnedWorkSettled(snapshot);return snapshot;}
  assert(now()<deadline,'Owned work settlement deadline; reconcile before retry');
  await sleep(intervalMs);
 }
}
