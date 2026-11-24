import assert from "node:assert/strict";
import { randomUUID,randomBytes,createHash } from "node:crypto";
import { Client,Pool } from "pg";
import { withPostgresClock } from "./support/postgres-clock.mjs";
import {metaDeletionPreservationSql,validateDeletionPreservation} from '../scripts/release/meta-deletion-dev-guest.mjs';

// Existing canonical PostgreSQL runner only; all IDs below are synthetic.
// No Facebook callback, human mapping, lawful retention or installed proof.
export async function verifyMetaDeletionPostgres(adminUrl,appUrl,workerConfig,platformUrl,cleanupUrl) {
  const admin=new Client({connectionString:adminUrl}),app=new Client({connectionString:appUrl});
  const operator=new Client({connectionString:platformUrl,options:"-c role=wasalx_platform_operations_client"}),worker=new Pool(workerConfig);
  const peer=new Client({connectionString:appUrl}),cleanup=new Client({connectionString:cleanupUrl});
  await Promise.all([admin.connect(),app.connect(),operator.connect(),peer.connect(),cleanup.connect()]);
  const maintain=()=>cleanup.query("SELECT * FROM app.claim_secret_cleanup_tasks($1,1)",[randomUUID()]);
  const appId=String(BigInt("900000000000000")+BigInt(Math.floor(Math.random()*100000000))),hash=randomBytes(32).toString("hex"),subject=randomBytes(32).toString("hex"),locator=randomBytes(32).toString("hex"),now=Math.floor(Date.now()/1000);
  const keyA=randomBytes(32).toString("hex"),keyB=randomBytes(32).toString("hex");
  const args=[appId,subject,hash,keyA,locator,now,0,300,1];
  const accept="SELECT app.accept_meta_deletion_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9) result";
  try {
    await verifyPreservationQuery(admin,adminUrl);
    const role=(await cleanup.query("SELECT current_user,session_user,rolsuper,rolbypassrls,pg_catalog.pg_has_role(current_user,'wasalx_secret_cleanup_client','MEMBER') member FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(role.session_user,new URL(cleanupUrl).username);assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);assert.equal(role.member,true);
    await assert.rejects(cleanup.query("SELECT app.minimize_meta_deletion_receipts()"),error=>error.code==="42501");
    for(const [signature,roles] of [
      ["app.minimize_meta_deletion_receipts()",[]],
      ["app.accept_meta_deletion_receipt(text,text,text,text,text,bigint,bigint,integer,integer)",["wasalx_app"]],
      ["app.meta_deletion_receipt_status(text)",["wasalx_app"]],
      ["app.operator_meta_deletion_receipts(text,text,uuid,text)",["wasalx_platform_operations_client"]],
      ["app.operator_review_meta_deletion_receipt(uuid,bigint,text,text,text,text,text,text,text)",["wasalx_platform_operations_client"]],
    ]) {
      const row=(await admin.query(`SELECT p.prosecdef,p.proconfig,pg_catalog.pg_get_userbyid(p.proowner) owner,pg_catalog.pg_get_userbyid(n.nspowner) schema_owner,
       COALESCE((SELECT array_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END ORDER BY a.grantee) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner),'{}')::text[] grants
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=pg_catalog.to_regprocedure($1)`,[signature])).rows[0];
      assert.equal(row.prosecdef,true,signature);assert.equal(row.owner,row.schema_owner,signature);
      assert.ok(row.proconfig.includes("search_path=pg_catalog, public, app, pg_temp"),signature);assert.deepEqual([...row.grants].sort(),[...roles].sort(),signature);
    }
    // First app invocation sees forged temp evidence; real public receipt wins.
    await app.query("CREATE TEMP TABLE meta_deletion_receipts(id uuid,app_id text,payload_sha256 text,locator text,state text,expires_at timestamptz)");
    const forged=randomBytes(32).toString("hex");
    await app.query("INSERT INTO pg_temp.meta_deletion_receipts VALUES($1::uuid,$2,$3,$4,'REFUSED',clock_timestamp()+interval '1 day')",[randomUUID(),appId,hash,forged]);
    const first=(await app.query(accept,args)).rows[0].result;assert.equal(first.locator,locator);assert.notEqual(first.locator,forged);
    const duplicate=(await app.query(accept,[...args.slice(0,3),keyB,randomBytes(32).toString("hex"),now-100000,0,300,1])).rows[0].result;
    assert.deepEqual(duplicate,first,"historical exact payload returns original receipt before local age policy");
    await assert.rejects(app.query(accept,[appId,subject,randomBytes(32).toString("hex"),keyA,randomBytes(32).toString("hex"),now-100000,0,300,30]),error=>error.code==="22023");
    await assert.rejects(app.query(accept,[appId,subject,randomBytes(32).toString("hex"),keyA,randomBytes(32).toString("hex"),now,now-1,300,30]),error=>error.code==="22023");
    assert.deepEqual((await app.query("SELECT app.meta_deletion_receipt_status($1) result",[locator])).rows[0].result.state,"SCOPE_REVIEW_REQUIRED");
    assert.deepEqual((await app.query("SELECT app.meta_deletion_receipt_status($1) result",[forged])).rows[0].result,{state:"UNAVAILABLE"});
    await assert.rejects(app.query("SELECT * FROM public.meta_deletion_receipts"),error=>error.code==="42501");
    await assert.rejects(worker.query(accept,args),error=>error.code==="42501");
    await assert.rejects(app.query("SELECT app.operator_meta_deletion_receipts('forged-operator','forged-request',NULL,NULL)"),error=>error.code==="42501");
    const stored=(await admin.query("SELECT * FROM public.meta_deletion_receipts WHERE app_id=$1",[appId])).rows;assert.equal(stored.length,1);
    assert.equal(stored[0].verification_key_fingerprint,keyA);assert.equal(stored[0].admission_policy,"META_DELETION_LOCAL_V1_MAX2592000_SKEW300");
    assert.equal(stored[0].source_contract_sha256,"454eeedfa72e8f229c02afb78f11ea6579cebc0360906af171b7f282e8c2f539");
    const raceHash=randomBytes(32).toString("hex"),race=[appId,subject,raceHash,keyA,randomBytes(32).toString("hex"),now,0,300,1];
    const competing=await Promise.all([app.query(accept,race),peer.query(accept,[...race.slice(0,4),randomBytes(32).toString("hex"),...race.slice(5)])]);
    assert.deepEqual(competing[0].rows[0].result,competing[1].rows[0].result);assert.deepEqual((await app.query(accept,race)).rows[0].result,competing[0].rows[0].result);
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.meta_deletion_receipts WHERE app_id=$1 AND payload_sha256=$2",[appId,raceHash])).rows[0].n,1);
    const id=stored[0].id;assert.equal(stored[0].subject_namespace,"FACEBOOK_ASID");assert.equal(stored[0].subject_digest,subject);
    // First operator invocation sees a fake temp receipt and audit sink.
    await operator.query("CREATE TEMP TABLE meta_deletion_receipts(id uuid,state text,version bigint,expires_at timestamptz)");
    await operator.query("CREATE TEMP TABLE meta_deletion_review_operations(receipt_id uuid,result jsonb)");
    await operator.query("CREATE TEMP TABLE platform_operations_audit_events(id uuid)");
    const list=(await operator.query("SELECT app.operator_meta_deletion_receipts($1,$2,NULL,NULL) result",["synthetic-reviewer",randomUUID()])).rows[0].result;
    assert.ok(list.items.some(item=>item.id===id));assert.doesNotMatch(JSON.stringify(list),new RegExp(`${subject}|${hash}|${locator}`));
    assert.equal((await operator.query("SELECT app.operator_meta_deletion_receipts($1,$2,NULL,$3) result",["synthetic-reviewer",randomUUID(),locator])).rows[0].result.items[0].id,id);
    await assert.rejects(operator.query(accept,args),error=>error.code==="42501");
    const review="SELECT app.operator_review_meta_deletion_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9) result";
    const reviewArgs=[id,1,"NEEDS_INFORMATION","SCOPE_EVIDENCE_REQUIRED","a".repeat(64),"review-test-key","synthetic-reviewer",randomUUID(),null];
    const result=(await operator.query(review,reviewArgs)).rows[0].result;assert.equal(result.version,2);assert.equal(result.state,"NEEDS_INFORMATION");
    assert.deepEqual((await operator.query(review,reviewArgs)).rows[0].result,result);
    await assert.rejects(operator.query(review,[id,1,"HELD","OUTCOME_UNRESOLVED","b".repeat(64),"review-test-key","synthetic-reviewer",randomUUID(),null]),error=>error.code==="23514");
    await assert.rejects(operator.query(review,[id,1,"HELD","OUTCOME_UNRESOLVED","b".repeat(64),"review-new-key","synthetic-reviewer",randomUUID(),null]),error=>error.code==="40001");
    await assert.rejects(operator.query(review,[id,2,"COMPLETED","NO_DATA","a".repeat(64),"review-new-key","synthetic-reviewer",randomUUID(),null]),error=>error.code==="22023");
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.platform_operations_audit_events WHERE target_id=$1 AND action='meta.deletion.review'",[id])).rows[0].n,1);
    assert.equal((await operator.query("SELECT count(*)::integer n FROM pg_temp.platform_operations_audit_events")).rows[0].n,0);
    const snapshot=(await admin.query("SELECT count(*)::integer n FROM public.privacy_jobs")).rows[0].n;
    await assert.rejects(operator.query(review,[id,2,"REFUSED","LAWFUL_RETENTION","c".repeat(64),"review-refusal-key","synthetic-reviewer",randomUUID(),null]),error=>error.code==="22023");
    await operator.query(review,[id,2,"REFUSED","LAWFUL_RETENTION","c".repeat(64),"review-refusal-key","synthetic-reviewer",randomUUID(),"https://policy.example.invalid/retention"]);
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.privacy_jobs")).rows[0].n,snapshot,"review cannot enqueue tenant deletion or fabricate its outcome");
    assert.equal((await app.query("SELECT app.meta_deletion_receipt_status($1) result",[locator])).rows[0].result.state,"REFUSED");
    const refusalArgs=[id,2,"REFUSED","LAWFUL_RETENTION","c".repeat(64),"review-refusal-key","synthetic-reviewer",randomUUID(),null];
    const recovered=(await operator.query(review,refusalArgs)).rows[0].result;
    assert.equal(recovered.refusalPolicyUrl,"https://policy.example.invalid/retention","replay uses original server policy after configuration removal");
    assert.equal((await app.query("SELECT app.meta_deletion_receipt_status($1) result",[locator])).rows[0].result.refusalPolicyUrl,recovered.refusalPolicyUrl);
    await admin.query("UPDATE public.meta_deletion_receipts SET received_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1::uuid",[id]);
    assert.deepEqual((await app.query("SELECT app.meta_deletion_receipt_status($1) result",[locator])).rows[0].result,{state:"UNAVAILABLE"});
    // Actual canonical non-super cleanup runtime reaches the existing wrapper.
    await maintain();
    const tombstone=(await admin.query("SELECT * FROM public.meta_deletion_receipts WHERE id=$1::uuid",[id])).rows[0];
    assert.equal(tombstone.subject_digest,null);assert.equal(tombstone.review_evidence_sha256,null);assert.ok(tombstone.minimized_at);assert.equal(tombstone.verification_key_fingerprint,keyA);
    const expanded=[appId,subject,hash,keyB,randomBytes(32).toString("hex"),now-172800,0,2592000,31];
    const cleanupRace=await Promise.all([peer.query(accept,expanded),maintain()]);assert.deepEqual(cleanupRace[0].rows[0].result,first);
    assert.deepEqual((await app.query(accept,expanded)).rows[0].result,first);
    assert.deepEqual((await operator.query(review,refusalArgs)).rows[0].result,recovered);
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.meta_deletion_receipts WHERE app_id=$1 AND payload_sha256=$2",[appId,hash])).rows[0].n,1);
    await assert.rejects(app.query(accept,[appId,subject,randomBytes(32).toString("hex"),keyA,randomBytes(32).toString("hex"),now,0,2592001,365]),error=>error.code==="22023");
    // Synthetic historic timestamps beyond every permitted admission policy.
    await admin.query("UPDATE public.meta_deletion_receipts SET issued_seconds=$2::bigint,replay_until=clock_timestamp()-interval '1 hour' WHERE id=$1::uuid",[id,now-40*86400]);await maintain();
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.meta_deletion_receipts WHERE id=$1::uuid",[id])).rows[0].n,0);
    await assert.rejects(app.query(accept,[appId,subject,hash,keyA,randomBytes(32).toString("hex"),now-40*86400,0,2592000,31]),error=>error.code==="22023");
    const batchApp=appId+"1",heldId=randomUUID(),pendingId=randomUUID();
    await admin.query(`INSERT INTO public.meta_deletion_receipts(app_id,subject_digest,payload_sha256,locator,state,review_reason,review_evidence_sha256,version,received_at,expires_at,reviewed_at,refusal_policy_url,verification_key_fingerprint,issued_seconds,replay_until)
      SELECT $1,repeat('a',64),encode(public.digest('batch-payload-'||n::text,'sha256'),'hex'),encode(public.digest('batch-locator-'||n::text,'sha256'),'hex'),
        'REFUSED','LAWFUL_RETENTION',repeat('b',64),2,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day','https://policy.example.invalid/retention',repeat('a',64),$2::bigint,clock_timestamp()-interval '1 hour' FROM generate_series(1,101) n`,[batchApp,now-40*86400]);
    await admin.query(`INSERT INTO public.meta_deletion_receipts(id,app_id,subject_digest,payload_sha256,locator,state,review_reason,review_evidence_sha256,received_at,expires_at,reviewed_at,verification_key_fingerprint,issued_seconds,replay_until)
      VALUES($1::uuid,$2,repeat('a',64),repeat('c',64),repeat('d',64),'HELD','OUTCOME_UNRESOLVED',repeat('e',64),clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day',repeat('a',64),$4::bigint,clock_timestamp()+interval '1 day'),
      ($3::uuid,$2,repeat('a',64),repeat('f',64),repeat('1',64),'SCOPE_REVIEW_REQUIRED',NULL,NULL,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',NULL,repeat('a',64),$4::bigint,clock_timestamp()+interval '1 day')`,[heldId,batchApp,pendingId,now-40*86400]);
    await maintain();
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.meta_deletion_receipts WHERE app_id=$1 AND state='REFUSED'",[batchApp])).rows[0].n,1,"one maintenance invocation purges at most 100 terminal receipts");
    assert.deepEqual((await admin.query("SELECT id FROM public.meta_deletion_receipts WHERE id=ANY($1::uuid[]) ORDER BY id",[[heldId,pendingId]])).rows.map(row=>row.id),[heldId,pendingId].sort(),"expired unresolved/held review evidence remains reviewable, never relabelled completed");
    assert.equal((await operator.query("SELECT app.operator_meta_deletion_receipts($1,$2,NULL,$3) result",["synthetic-reviewer",randomUUID(),"d".repeat(64)])).rows[0].result.items[0].state,"HELD");
    assert.equal((await app.query("SELECT app.meta_deletion_receipt_status($1) result",["d".repeat(64)])).rows[0].result.state,"UNAVAILABLE");
    await assert.rejects(app.query("SELECT app.expire_meta_signup_attempts()"),error=>error.code==="42501");
    // An admitted timestamp must become invalid while the request is blocked.
    await withPostgresClock(admin, "app.accept_meta_deletion_receipt(text,text,text,text,text,bigint,bigint,integer,integer)", async advance => {
      const waitingHash=randomBytes(32).toString("hex"),waitingApp=appId+"2";
      const peerPid=(await peer.query("SELECT pg_catalog.pg_backend_pid() pid")).rows[0].pid;
      const issued=Date.UTC(2030,0,1)/1000;
      await advance(new Date((issued+295)*1000));
      let waiting,committed=false;
      await admin.query("BEGIN");
      try{
        await admin.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('meta-deletion:'||$1||':'||$2,0))",[waitingApp,waitingHash]);
        waiting=peer.query(accept,[waitingApp,subject,waitingHash,keyA,randomBytes(32).toString("hex"),issued,0,300,1]).then(()=>null,error=>error);
        const deadline=performance.now()+1000;
        let blocked=false;
        do{
          blocked=(await admin.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) blocked",[peerPid])).rows[0].blocked;
        }while(!blocked&&performance.now()<deadline);
        assert.ok(blocked,"fixture prerequisite: peer must wait on the owned payload lock");
        await advance(new Date((issued+301)*1000));
        await admin.query("COMMIT");committed=true;
        assert.equal((await waiting)?.code,"22023");
      }finally{
        if(!committed)await admin.query("ROLLBACK");
        if(waiting)await waiting;
      }
      assert.equal((await admin.query("SELECT count(*)::integer n FROM public.meta_deletion_receipts WHERE app_id=$1",[waitingApp])).rows[0].n,0);
    });
    // Fixed SQL budget covers all public paths and fresh process/backend sessions.
    // Synthetic future minute avoids a wall-clock minute-boundary race and
    // also proves that backward clock movement cannot reset consumed quota.
    await admin.query("UPDATE public.meta_deletion_status_budget SET minute=floor(extract(epoch FROM clock_timestamp())/60)::bigint+1,used=119 WHERE singleton");
    const rate=await Promise.allSettled([app.query("SELECT app.meta_deletion_receipt_status($1)",[forged]),peer.query("SELECT app.meta_deletion_receipt_status($1)",[locator])]);
    assert.equal(rate.filter(value=>value.status==="fulfilled").length,1);assert.equal(rate.filter(value=>value.status==="rejected"&&value.reason.code==="54000").length,1);
    await admin.query("BEGIN");await admin.query("LOCK TABLE public.meta_deletion_receipts IN ACCESS EXCLUSIVE MODE");
    const restarted=new Client({connectionString:appUrl,statement_timeout:1000});await restarted.connect();
    try{await assert.rejects(restarted.query("SELECT app.meta_deletion_receipt_status($1)",[randomBytes(32).toString("hex")]),error=>error.code==="54000","limit denial occurs before any receipt read");}finally{await restarted.end();await admin.query("ROLLBACK");}
    assert.equal((await admin.query("SELECT count(*)::integer n FROM public.meta_deletion_status_budget")).rows[0].n,1);
    await admin.query("UPDATE public.meta_deletion_status_budget SET minute=floor(extract(epoch FROM clock_timestamp())/60)::bigint-1 WHERE singleton");assert.equal((await peer.query("SELECT app.meta_deletion_receipt_status($1) result",[forged])).rows[0].result.state,"UNAVAILABLE");
    return{receipt:"signed-input-only-app-namespace",duplicate:"original-locator",review:"scoped-role-cas-idempotency-no-tenant-job",retention:"bounded-existing-cleanup",liveProviderEvidence:false};
  } finally {await Promise.all([app.end(),operator.end(),worker.end(),peer.end(),cleanup.end(),admin.end()]);}
}

// Exact installed-driver query against the existing canonical schema. Setup is
// owner-only synthetic data; the census itself is a separate READ ONLY client,
// matching the DEV database reader. No cleanup wrapper/function is invoked.
async function verifyPreservationQuery(admin,adminUrl){
 const reader=new Client({connectionString:adminUrl}),ids=[],fixtureApp='998'+String(Date.now()),otherApp=fixtureApp+'1',payload=randomBytes(32).toString('hex');
 await reader.connect();
 try{
  assert.equal((await admin.query('SELECT count(*)::integer n FROM public.meta_deletion_receipts')).rows[0].n,0,'owned fresh canonical fixture prerequisite');
  const base=Number((await admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint ms')).rows[0].ms),end=base+10000;
  const seed=async({app=otherApp,hash=randomBytes(32).toString('hex'),state='SCOPE_REVIEW_REQUIRED',expiry=base+3600000,replay=base+86400000,minimized=false}={})=>{
   const id=randomUUID();ids.push(id);const reason=state==='REFUSED'?'LAWFUL_RETENTION':state==='HELD'?'OUTCOME_UNRESOLVED':null;
   await admin.query(`INSERT INTO public.meta_deletion_receipts(id,app_id,subject_digest,payload_sha256,locator,state,review_reason,review_evidence_sha256,received_at,expires_at,reviewed_at,minimized_at,refusal_policy_url,verification_key_fingerprint,issued_seconds,replay_until)
    VALUES($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,to_timestamp($9::double precision/1000),to_timestamp($10::double precision/1000),
     CASE WHEN $7::text IS NULL THEN NULL ELSE to_timestamp($9::double precision/1000) END,CASE WHEN $11::boolean THEN to_timestamp($9::double precision/1000) ELSE NULL END,
     CASE WHEN $6::text='REFUSED' THEN 'https://policy.example.invalid/retention' ELSE NULL END,$12::text,$13::bigint,to_timestamp($14::double precision/1000))`,
    [id,app,minimized?null:'a'.repeat(64),hash,randomBytes(32).toString('hex'),state,reason,reason&&!minimized?'b'.repeat(64):null,base-50*86400000,expiry,minimized,'c'.repeat(64),Math.floor(base/1000)-40*86400,replay]);
   return id;
  };
  const excluded=await seed({app:fixtureApp,hash:payload}),sameApp=await seed({app:fixtureApp}),differentApp=await seed();
  const census=async(expectedIds,eligible=false)=>{
   await reader.query('BEGIN READ ONLY');
   try{
    assert.equal((await reader.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
    const all=await reader.query('SELECT id,to_jsonb(r)::text value FROM public.meta_deletion_receipts r ORDER BY id');
    const actual=(await reader.query(metaDeletionPreservationSql,[fixtureApp,payload,end])).rows[0].json_build_object;
    const repeated=(await reader.query(metaDeletionPreservationSql,[fixtureApp,payload,end])).rows[0].json_build_object;assert.deepEqual(repeated,actual);
    const rows=(await reader.query('SELECT id,to_jsonb(r)::text value FROM public.meta_deletion_receipts r WHERE id=ANY($1::uuid[]) ORDER BY to_jsonb(r)::text',[expectedIds])).rows;
    assert.deepEqual(rows.map(r=>r.id).sort(),[...expectedIds].sort());
    assert.equal(actual.count,expectedIds.length);assert.equal(actual.sha256,createHash('sha256').update(rows.map(r=>r.value).join('\n')).digest('hex'));assert.equal(actual.maintenance_eligible,eligible);
    assert.deepEqual((await reader.query('SELECT id,to_jsonb(r)::text value FROM public.meta_deletion_receipts r ORDER BY id')).rows,all.rows,'census changes no receipt');
    return actual;
   }finally{await reader.query('ROLLBACK');}
  };
  let expected=[sameApp,differentApp];const initial=await census(expected);validateDeletionPreservation(initial);assert.equal(initial.count,2);
  // Exact fixture is excluded even if terminal and due; same-app/different
  // payload and another app remain in the independently asserted inventory.
  await admin.query("UPDATE public.meta_deletion_receipts SET state='REFUSED',review_reason='LAWFUL_RETENTION',review_evidence_sha256=repeat('d',64),reviewed_at=received_at,refusal_policy_url='https://policy.example.invalid/retention',expires_at=to_timestamp($2::double precision/1000),replay_until=to_timestamp($2::double precision/1000) WHERE id=$1::uuid",[excluded,base-1000]);
  assert.deepEqual(await census(expected),initial);
  const held=await seed({state:'HELD',expiry:base-1000}),minimized=await seed({state:'REFUSED',expiry:base-1000,minimized:true});expected.push(held,minimized);const safe=await census(expected);validateDeletionPreservation(safe);assert.notEqual(safe.sha256,initial.sha256);
  const crossing=await seed({state:'REFUSED',expiry:base+5000});expected.push(crossing);const blocked=await census(expected,true);assert.throws(()=>validateDeletionPreservation(blocked));
  await admin.query('UPDATE public.meta_deletion_receipts SET expires_at=to_timestamp($2::double precision/1000) WHERE id=$1::uuid',[crossing,end+1000]);const future=await census(expected);validateDeletionPreservation(future);assert.notEqual(future.sha256,blocked.sha256);
  await admin.query('UPDATE public.meta_deletion_receipts SET expires_at=to_timestamp($2::double precision/1000) WHERE id=$1::uuid',[crossing,base-1000]);await census(expected,true);
  await admin.query('UPDATE public.meta_deletion_receipts SET expires_at=to_timestamp($2::double precision/1000) WHERE id=$1::uuid',[crossing,end+1000]);
  await admin.query('UPDATE public.meta_deletion_receipts SET replay_until=to_timestamp($2::double precision/1000) WHERE id=$1::uuid',[minimized,base+5000]);await census(expected,true);
  await admin.query('UPDATE public.meta_deletion_receipts SET replay_until=to_timestamp($2::double precision/1000) WHERE id=$1::uuid',[minimized,base-1000]);await census(expected,true);
  await admin.query('UPDATE public.meta_deletion_receipts SET replay_until=to_timestamp($2::double precision/1000) WHERE id=$1::uuid',[minimized,base+86400000]);const beforeDelete=await census(expected);
  await admin.query('DELETE FROM public.meta_deletion_receipts WHERE id=$1::uuid',[crossing]);expected=expected.filter(id=>id!==crossing);const deleted=await census(expected);assert.equal(deleted.count,beforeDelete.count-1);assert.notEqual(deleted.sha256,beforeDelete.sha256);
  const overflowApp=fixtureApp+'2';
  const added=await admin.query(`INSERT INTO public.meta_deletion_receipts(app_id,subject_digest,payload_sha256,locator,verification_key_fingerprint,issued_seconds,expires_at,replay_until)
   SELECT $1::text,repeat('a',64),encode(public.digest('preservation-'||$1::text||n::text,'sha256'),'hex'),encode(public.digest('preservation-locator-'||$1::text||n::text,'sha256'),'hex'),repeat('c',64),$2::bigint,to_timestamp($3::double precision/1000),to_timestamp($4::double precision/1000) FROM generate_series(1,2001) n RETURNING id`,[overflowApp,Math.floor(base/1000)-40*86400,base+3600000,base+86400000]);ids.push(...added.rows.map(r=>r.id));
  await reader.query('BEGIN READ ONLY');try{
   const bounded=(await reader.query(metaDeletionPreservationSql,[fixtureApp,payload,end])).rows[0].json_build_object;assert.equal(bounded.count,2001);assert.throws(()=>validateDeletionPreservation(bounded));
  }finally{await reader.query('ROLLBACK');}
 }finally{await reader.end();await admin.query('DELETE FROM public.meta_deletion_receipts WHERE id=ANY($1::uuid[])',[ids]);}
}
