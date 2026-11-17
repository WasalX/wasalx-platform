import assert from 'node:assert/strict';
// One statement gives a consistent private configuration digest and complete audit suffix.
// Only digest/identities are returned; secret_reference/base_url never leave PostgreSQL.
export function createLifecycleWorkerAudit({run,dc}){
 return async(workerKey,afterVersion=0)=>{
  assert.match(workerKey,/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);assert(Number.isSafeInteger(afterVersion)&&afterVersion>=0);
  const sql=`SELECT json_build_object('configurationDigest',encode(sha256(convert_to(jsonb_build_array(w.id,w.worker_key,w.engine,w.base_url,w.secret_reference,w.capacity,w.heartbeat_ttl_seconds)::text,'UTF8')),'hex'),'version',w.version,'assignments',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,tenant_id,connection_id,waha_worker_id,assignment_fencing_token,ownership_state FROM provider_sessions WHERE waha_worker_id=w.id AND ownership_state='ACTIVE') x),'[]'),'modeEvents',COALESCE((SELECT json_agg(json_build_object('id',e.id,'workerKey',w.worker_key,'actorId',e.actor_id,'actorType',e.actor_type,'reason',e.reason,'version',(e.safe_metadata->>'version')::bigint,'lifecycleState',e.safe_metadata->>'lifecycle_state','rolloutMode',e.safe_metadata->>'rollout_mode','canarySessionLimit',e.safe_metadata->'canary_session_limit') ORDER BY (e.safe_metadata->>'version')::bigint,e.id) FROM waha_worker_events e WHERE e.waha_worker_id=w.id AND e.action='worker.mode_changed' AND (e.safe_metadata->>'version')::bigint>${afterVersion}),'[]')) FROM waha_workers w WHERE w.worker_key='${workerKey}'`;
  const row=JSON.parse(await run('docker',[...dc,'exec','-T','postgres','psql','-U','wasalx','-d','wasalx','-qAtc','BEGIN READ ONLY; '+sql+'; COMMIT;']));
  assert.match(row.configurationDigest,/^[a-f0-9]{64}$/);return row;
 };
}
export async function readSimulationOperatorSubject({run,model}){
 const id=await run('docker',['exec',model.name+'-keycloak-postgresql-1','psql','-U','keycloak','-d','keycloak','-Atc',"SELECT u.id FROM user_entity u JOIN realm r ON r.id=u.realm_id WHERE r.name='wasalx-platform' AND u.username='example.platform'"]);
 const subject=id.trim();assert.match(subject,/^[0-9a-f-]{36}$/);return subject;
}
