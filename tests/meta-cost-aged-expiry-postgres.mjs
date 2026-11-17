import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {createMetaStatementScenario} from './meta-cost-statements-postgres.mjs';
import {claimMetaCostPrivacyJob} from './meta-cost-scenarios-postgres.mjs';
import {MetaCostSourceService} from '../services/connector-worker/dist/services/connector-worker/src/meta-cost-source.js';
import {PrivacyProcessor} from '../services/connector-worker/dist/services/connector-worker/src/privacy-processor.js';
import {PrivacyController} from '../services/control-api/dist/privacy.controller.js';

// Initial synthetic age/object/publication state only. Reviewed allowlist
// 8f5f5e7e / approach e047c4fa. No existing source UPDATE, disabled trigger,
// runtime clock override, P08 authority seed, or invented live-provider fact.
const changed=['id','period_from','period_to','normalized_input','input_sha256','source_identity_sha256','object_key','created_at','expires_at',
 'write_admitted_at','write_settled_at','source_ready_at','source_delete_after','verification','subject_attestation','preview','publication','publication_sha256','published_at','record_delete_after'];
const unchanged=['tenant_id','account_id','policy_version_id','commercial_terms_version_id','basis_kind','purpose','evidence_mode','currency','minor_units','timezone',
 'lifecycle','version','created_by','original_sha256','original_byte_size','original_mime','source_state','write_attempt_id','write_disposition','scan_sha256','source_purged_at',
 'retention_snapshot','source_subject_coverage','predecessor_id'];
const columns=[...changed,...unchanged];
const without=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const date=value=>new Date(value).toISOString();
const code=(...values)=>error=>values.includes(error.code);

async function agedSetup(admin,f,source,{ageDays,slot,predecessor}){
 const before=(await admin.query('SELECT to_jsonb(s) value FROM public.meta_cost_statement_versions s WHERE tenant_id=$1 AND id=$2',[f.tenantId,source.id])).rows[0].value;
 assert.equal(before.evidence_mode,'SIMULATED');assert.equal(before.basis_kind,'UPSTREAM_SOURCE');assert.equal(before.normalized_input.source.coverage,'ACCOUNT_PERIOD');assert.deepEqual(before.normalized_input.lines,[]);
 assert.equal(before.predecessor_id,predecessor?.templateId??null);
 assert.equal(before.normalized_input.source.sourceKind,'FULL_REPLACEMENT');assert.equal(before.normalized_input.source.priorStatementVersionId,null);
 assert.deepEqual(Object.keys(before).sort(),columns.toSorted());assert.equal(new Set(columns).size,44);
 const now=Number((await admin.query('SELECT extract(epoch FROM clock_timestamp())*1000 now')).rows[0].now),start=now-ageDays*86400_000;
 const row=structuredClone(before);row.id=randomUUID();row.period_from=date(Date.UTC(2000,slot,1));row.period_to=date(Date.UTC(2000,slot+1,1));
 if(predecessor)row.predecessor_id=predecessor.id;
 row.normalized_input={...row.normalized_input,periodFrom:row.period_from,periodTo:row.period_to,source:{...row.normalized_input.source,documentId:'synthetic-aged-'+row.id}};
 const hashes=(await admin.query(`SELECT encode(digest($1::jsonb::text,'sha256'),'hex') input,
  encode(digest(jsonb_build_array($1::jsonb#>>'{source,issuerKind}',$1::jsonb#>>'{source,issuerAuthorityVersionId}',$1::jsonb#>>'{source,documentId}',
   $1::jsonb#>>'{source,documentRevision}',$1::jsonb#>>'{source,sourceScopeLocator}',$2::uuid,$3::text,$1::jsonb->>'currency',
   ($1::jsonb->>'periodFrom')::timestamptz,($1::jsonb->>'periodTo')::timestamptz)::text,'sha256'),'hex') identity`,[row.normalized_input,row.account_id,row.evidence_mode])).rows[0];
 row.input_sha256=hashes.input;row.source_identity_sha256=hashes.identity;row.object_key=`tenants/${f.tenantId}/meta-cost-sources/${row.id}/${row.original_sha256}.bin`;
 row.created_at=date(start);row.expires_at=date(start+86400_000);
 for(const [field,offset] of [['write_admitted_at',1000],['write_settled_at',2000],['source_ready_at',2000],['published_at',4000]])if(before[field]!==null)row[field]=date(start+offset);
 if(before.source_delete_after!==null)row.source_delete_after=date(start+2000+Number(row.retention_snapshot.sourceDays)*86400_000);
 if(before.record_delete_after!==null)row.record_delete_after=date(start+4000+Number(row.retention_snapshot.recordDays)*86400_000);
 for(const field of ['verification','subject_attestation'])if(before[field]!==null){
  row[field]={...row[field],inputSha256:row.input_sha256,reviewedAt:date(start+3000)};
  if(field==='verification'){assert.equal(before[field].expectedCurrentHeadId,predecessor?.templateId??null);if(predecessor)row[field].expectedCurrentHeadId=predecessor.id;}
  const allowed=['inputSha256','reviewedAt',...(field==='verification'&&predecessor?['expectedCurrentHeadId']:[])];
  assert.deepEqual(without(row[field],allowed),without(before[field],allowed));
 }
 const verificationSha=row.verification===null?null:(await admin.query("SELECT encode(digest($1::jsonb::text,'sha256'),'hex') value",[row.verification])).rows[0].value;
 const emptySha=(await admin.query("SELECT encode(digest('[]','sha256'),'hex') value")).rows[0].value;
 for(const field of ['preview','publication'])if(before[field]!==null){
  for(const key of ['selectedRows','adjustments','upstreamPublications'])assert.deepEqual(before[field][key],[]);
  assert.equal(before[field].selectedCount,0);assert.equal(before[field].selectedSha256,emptySha);assert.equal(before[field].currentHeadId,predecessor?.templateId??null);
  row[field]={...row[field],id:row.id,periodFrom:row.period_from,periodTo:row.period_to,inputSha256:row.input_sha256,verificationSha256:verificationSha,
   ...(predecessor?{currentHeadId:predecessor.id}:{}),
   ...(field==='publication'?{publishedAt:row.published_at}:{})};
  const allowed=['id','periodFrom','periodTo','inputSha256','verificationSha256','publishedAt',...(predecessor?['currentHeadId']:[])];
  assert.deepEqual(without(row[field],allowed),without(before[field],allowed));
 }
 if(row.publication!==null)row.publication_sha256=(await admin.query("SELECT encode(digest($1::jsonb::text,'sha256'),'hex') value",[row.publication])).rows[0].value;
 for(const field of unchanged)if(!(predecessor&&field==='predecessor_id'))assert.deepEqual(row[field],before[field],field);
 await admin.query('BEGIN');try{
  await admin.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
  const quoted=columns.map(name=>'"'+name+'"').join(',');
  await admin.query(`INSERT INTO public.meta_cost_statement_versions(${quoted}) SELECT ${quoted} FROM pg_catalog.jsonb_populate_record(NULL::public.meta_cost_statement_versions,$1::jsonb)`,[row]);
  await admin.query('COMMIT');
 }catch(error){await admin.query('ROLLBACK');throw error;}
 if(row.source_state==='READY')f.objects.set(row.object_key,Uint8Array.from(source.bytes));
 assert.deepEqual((await admin.query('SELECT to_jsonb(s) value FROM public.meta_cost_statement_versions s WHERE id=$1',[source.id])).rows[0].value,before);
 return{id:row.id,key:row.object_key,templateId:source.id,template:before,initialState:row.source_state};
}

async function enabledSchema(admin){
 const result=(await admin.query(`SELECT
  (SELECT bool_and(convalidated) FROM pg_catalog.pg_constraint WHERE conrelid='public.meta_cost_statement_versions'::regclass) constraints,
  (SELECT bool_and(tgenabled='O') FROM pg_catalog.pg_trigger WHERE tgrelid='public.meta_cost_statement_versions'::regclass AND NOT tgisinternal) triggers,
  relrowsecurity rls,relforcerowsecurity forced FROM pg_catalog.pg_class WHERE oid='public.meta_cost_statement_versions'::regclass`)).rows[0];
 assert.deepEqual(result,{constraints:true,triggers:true,rls:true,forced:true});return result;
}

export async function verifyMetaCostAgedExpiry(options){
 const proofs=[];
 for(const scenario of ['DUE_AND_FUTURE','UNKNOWN','HOLD']){
  const f=await createMetaStatementScenario(options),admin=new Client({connectionString:options.adminUrl});
  try{
   await admin.connect();await enabledSchema(admin);
   const staged=await f.reserve(),published=await f.reserve();await f.finish(published);
   const copies=[];
   if(scenario==='DUE_AND_FUTURE'){
    copies.push(await agedSetup(admin,f,staged,{ageDays:3,slot:1}));
    copies.push(await agedSetup(admin,f,published,{ageDays:1.1,slot:2}));
    copies.push(await agedSetup(admin,f,published,{ageDays:3,slot:3}));
    copies.push(await agedSetup(admin,f,published,{ageDays:0.1,slot:4}));
   }else if(scenario==='UNKNOWN'){
    const unknown=await f.reserve(),uncertain=new MetaCostSourceService(f.sourceRepository,f.scanner,{...f.storage,put:async()=>{throw Error('Synthetic uncertain setup PUT');}});
    await assert.rejects(()=>uncertain.upload(f.tenantId,unknown.id,unknown.bytes,'application/json'),error=>error.code==='SOURCE_WRITE_OUTCOME_UNKNOWN');
    copies.push(await agedSetup(admin,f,unknown,{ageDays:3,slot:5}));
   }else{
    copies.push(await agedSetup(admin,f,published,{ageDays:3,slot:6}));
    const controller=new PrivacyController(f.database,{wakePrivacy:async()=>{}},{},{privacyTarget:async()=>assert.fail('No native target in this fixture')});
    await controller.createHold({id:'aged-hold',principal:{tenantId:f.tenantId,userId:f.actorId,subject:`managed-${f.actorId}`,email:`managed-${f.actorId}@example.invalid`,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}},
     {scopeType:'TENANT',scopeValue:f.tenantId,reason:'Synthetic aged-retention hold'}, "privacy-hold-fixture-1");
   }
   // Ordinary message retention can be disabled; finance expiry still enters
   // the existing maintenance job, without its own scheduler or clock override.
   await f.tx(f.app,f.tenantId,c=>c.query("UPDATE retention_policies SET state='PAUSED' WHERE tenant_id=$1",[f.tenantId]));
   const id=await f.privacy.ensureMaintenanceJob(f.tenantId);assert(id);const job=await claimMetaCostPrivacyJob(f,id);
   const processor=new PrivacyProcessor(f.privacy,{resolve:async()=>assert.fail('No Zammad target in this fixture')},f.storage);
   if(scenario==='UNKNOWN'){
    await assert.rejects(()=>processor.process(job,job.lease),error=>error.code==='FINANCE_SOURCE_REVIEW_REQUIRED');
    assert.equal(f.deletes.length,0);assert.equal(await f.privacy.hasPendingFinanceReview(job),true);
    await assert.rejects(()=>f.privacy.complete(job,job.lease,{}),code('55000'));
    await admin.query('BEGIN');try{
     await admin.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenantId]);
     await assert.rejects(()=>admin.query('DELETE FROM public.tenants WHERE id=$1',[f.tenantId]),code('23503','23514','42501'));
    }finally{await admin.query('ROLLBACK');}
   }else{
    const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert.equal(await f.privacy.complete(job,job.lease,summary),true);
    if(scenario==='HOLD'){assert.equal(f.deletes.length,0);assert.equal(summary.metaCostSourcesPurged,0);}
    else{
     assert.equal(summary.metaCostSourcesPurged,3);assert.equal(summary.metaCostRecordsPurged,2);
     assert.deepEqual(new Set(f.deletes),new Set(copies.slice(0,3).map(row=>row.key)));
     const remaining=(await admin.query('SELECT id,source_state FROM public.meta_cost_statement_versions WHERE id=ANY($1::uuid[]) ORDER BY id',[copies.map(row=>row.id)])).rows;
     assert.equal(remaining.length,2);assert.equal(remaining.find(row=>row.id===copies[1].id).source_state,'PURGED');assert.equal(remaining.find(row=>row.id===copies[3].id).source_state,'READY');
    }
   }
   for(const copied of copies)assert.deepEqual((await admin.query('SELECT to_jsonb(s) value FROM public.meta_cost_statement_versions s WHERE id=$1',[copied.templateId])).rows[0].value,copied.template);
   await enabledSchema(admin);proofs.push({scenario,setup:'SYNTHETIC_INITIAL_AGE_AND_OBJECT_STATE',runtime:'ACTUAL_RESTRICTED_PRIVACY_ROLES',copiedRecords:copies.length,provider:'NO_PROVIDER_EFFECT'});
  }finally{await admin.end().catch(()=>undefined);await f.close();}
 }
 proofs.push(...await verifyAgedPublicationLineage(options));return proofs;
}

// Separate extension to the null-predecessor allowlist: an actual two-version
// domain-produced chain supplies both templates. Only the child's predecessor
// UUID and its three matching historical head references additionally change.
// Each synthetic row is inserted once, with the normal constraints active.
async function verifyAgedPublicationLineage(options){
 const proofs=[];
 for(const allDue of [false,true]){
  const f=await createMetaStatementScenario(options),admin=new Client({connectionString:options.adminUrl});
  try{
   await admin.connect();await enabledSchema(admin);
   const retention=async recordDays=>{
    const policy=(await f.tx(f.app,f.tenantId,c=>c.query('SELECT version FROM retention_policies WHERE tenant_id=$1',[f.tenantId]))).rows[0];
    await f.action('META_FINANCE_RETENTION',null,{expectedVersion:Number(policy.version),sourceDays:1,recordDays,
     basisSha256:'a'.repeat(64),policyVersionId:f.accepted.policyVersionId,commercialTermsVersionId:f.commercialTermsVersionId});
   };
   await retention(10);const original=await f.reserve();await f.finish(original);
   await retention(2);const successor=await f.reserve();await f.finish(successor);
   const ancestor=await agedSetup(admin,f,original,{ageDays:allDue?20:4,slot:8});
   const newest=await agedSetup(admin,f,successor,{ageDays:3,slot:8,predecessor:ancestor});
   const before=(await f.read(newest.id)).publicationSha256;assert.equal((await f.read(ancestor.id)).currentHeadId,newest.id);
   await f.tx(f.app,f.tenantId,c=>c.query("UPDATE retention_policies SET state='PAUSED' WHERE tenant_id=$1",[f.tenantId]));
   const job=await claimMetaCostPrivacyJob(f,await f.privacy.ensureMaintenanceJob(f.tenantId));
   const processor=new PrivacyProcessor(f.privacy,{resolve:async()=>assert.fail('No Zammad target in lineage fixture')},f.storage);
   if(allDue){
    const summary=await processor.process(job,job.lease);assert.notEqual(summary,'deferred');assert.equal(summary.metaCostRecordsPurged,2);
    assert.equal(await f.privacy.complete(job,job.lease,summary),true);
    assert.equal((await admin.query('SELECT count(*)::integer count FROM public.meta_cost_statement_versions WHERE id=ANY($1::uuid[])',[[ancestor.id,newest.id]])).rows[0].count,0);
   }else{
    await assert.rejects(()=>processor.process(job,job.lease),error=>error.code==='FINANCE_RETENTION_REVIEW_REQUIRED'&&error.retryable===false);
    const observed=await f.read(newest.id);assert.equal(observed.publicationSha256,before);assert.equal(observed.currentHeadId,newest.id);
    assert.equal((await f.read(ancestor.id)).currentHeadId,newest.id);
    assert.equal((await admin.query('SELECT count(*)::integer count FROM public.meta_cost_statement_versions WHERE id=ANY($1::uuid[])',[[ancestor.id,newest.id]])).rows[0].count,2);
    await assert.rejects(()=>f.privacy.complete(job,job.lease,{}),code('55000'));
   }
   for(const row of [ancestor,newest])assert.deepEqual((await admin.query('SELECT to_jsonb(s) value FROM public.meta_cost_statement_versions s WHERE id=$1',[row.templateId])).rows[0].value,row.template);
   await enabledSchema(admin);proofs.push({scenario:allDue?'DUE_CHAIN_ATOMIC_PURGE':'RETAINED_ANCESTOR_NO_HEAD_RESURRECTION',
    setup:'SYNTHETIC_INITIAL_AGE_AND_OBJECT_STATE',runtime:'ACTUAL_RESTRICTED_PRIVACY_ROLES',copiedRecords:2,provider:'NO_PROVIDER_EFFECT'});
  }finally{await admin.end().catch(()=>undefined);await f.close();}
 }
 return proofs;
}
