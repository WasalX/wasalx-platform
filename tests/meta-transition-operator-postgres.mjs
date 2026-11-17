import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createMetaTransitionExecutionFixture} from './meta-account-transition-execution-fixture-postgres.mjs';
import {createMetaTransitionObserverHarness} from './meta-account-transition-observer-fixture-postgres.mjs';
const sql='SELECT app.operator_meta_transition_command($1,$2,$3,$4,$5,$6,$7,$8) AS value';
const operator='synthetic-mfa-operator';
const view=(f,id,key=null)=>f.sqlValue(f.platform,'SELECT app.operator_meta_transition_review($1,$2,$3,$4) AS value',[f.tenantId,id,operator,key]);
const body=(v,extra={})=>({expectedRevision:v.revision,expectedReviewSha256:v.reviewSha256,evidenceSha256:'b'.repeat(64),confirmed:true,...extra});
const parameters=(f,id,action,key,request,resolve)=>[f.tenantId,id,action,key,request,operator,'operator-review-fixture',resolve];
const command=(f,id,action,key,request,resolve=false)=>f.sqlValue(f.platform,sql,parameters(f,id,action,key,request,resolve));

async function race(f,id,key,request,resolveFirst){
 const first=await f.platform.connect(),second=await f.platform.connect();let pending;
 try{
  await first.query('BEGIN');await second.query('BEGIN');
  const firstPid=(await first.query('SELECT pg_backend_pid() pid')).rows[0].pid,secondPid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const a=(await first.query(sql,parameters(f,id,'PREREQUISITES',key,request,resolveFirst))).rows[0].value;
  pending=second.query(sql,parameters(f,id,'PREREQUISITES',key,request,!resolveFirst));pending.catch(()=>{});
  let blocked=false;
  for(let count=0;count<200;count++){
   if((await f.admin.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) blocked',[secondPid,firstPid])).rows[0].blocked){blocked=true;break;}
   await delay(10);
  }
  assert.equal(blocked,true,'Second original-key request must reach the real transaction lock');
  await first.query('COMMIT');const b=(await pending).rows[0].value;await second.query('COMMIT');return[a,b];
 }finally{await first.query('ROLLBACK');if(pending)await pending.catch(()=>{});await second.query('ROLLBACK');first.release();second.release();}
}

/** Exercises the installed SQL roles and original-key ledger; provider calls are
 * still the existing fixture's synthetic boundary, never installed/live proof. */
export async function verifyMetaTransitionOperatorReviews(options){
 const results=[];
 for(const requestedMode of ['CUSTOMER','WASALX_MANAGED']){
  const f=await createMetaTransitionExecutionFixture(options,{requestedMode});
  try{
   const id=await f.createPreview(),initial=await view(f,id);
   assert.equal(initial.tenantId,f.tenantId);assert.equal(initial.actions.PREREQUISITES,true);assert.equal(initial.pendingCommand,null);
   assert.ok(!JSON.stringify(initial).includes('secret://'));assert.ok(!JSON.stringify(initial).includes('credentialFingerprint'));
   const list=await f.sqlValue(f.platform,'SELECT app.operator_meta_transition_list($1) AS value',[f.tenantId]);assert.equal(list.plans.some(p=>p.id===id),true);
   await assert.rejects(()=>f.sqlValue(f.platform,'SELECT app.operator_meta_transition_review($1,$2,$3,NULL) AS value',[f.foreignTenantId,id,operator]),e=>e.code==='P0002');
   for(const role of [f.app,f.worker])await assert.rejects(()=>f.sqlValue(role,'SELECT app.operator_meta_transition_review($1,$2,$3,NULL) AS value',[f.tenantId,id,operator]),e=>e.code==='42501');
   const fields={sourcePayment:requestedMode==='CUSTOMER'?'CARD':'LINE',...(f.sourceArrangement?{managed:{arrangementVersionId:f.sourceArrangement.id.toUpperCase(),
    targetReceivingBusinessId:f.sourceArrangement.receiving_business_id,targetTermsDocumentText:'Explicit synthetic target terms',targetTermsVersion:'target-v1'}}:{})};
   const originalBody=body(initial,fields),firstKey=randomUUID(),priorPlan=await f.plan(id);
   if(fields.managed)await assert.rejects(()=>command(f,id,'PREREQUISITES',randomUUID(),{...originalBody,managed:{...fields.managed,arrangementVersionId:fields.managed.arrangementVersionId.slice(0,-1)+'!'}}),e=>e.code==='55000');
   const [closed,late]=await race(f,id,firstKey,originalBody,true);assert.equal(closed.state,'NO_EFFECT');assert.equal(late.state,'NO_EFFECT');
   assert.equal(late.commandReceiptId,closed.commandReceiptId);assert.equal(late.duplicate,true);assert.deepEqual(await f.plan(id),priorPlan);
   const noApproval=await f.admin.query("SELECT id FROM platform_operations_audit_events WHERE target_id=$1 AND action='meta.transition.prerequisites.simulated.approved'",[id]);assert.equal(noApproval.rowCount,0);
   await assert.rejects(()=>command(f,id,'PREREQUISITES',firstKey,{...originalBody,evidenceSha256:'c'.repeat(64)}),e=>e.code==='55000');
   const secondKey=randomUUID(),[applied,resolved]=await race(f,id,secondKey,originalBody,false);
   assert.deepEqual(applied.request,originalBody);assert.deepEqual(resolved.request,originalBody,'UUID parsing must not normalize the immutable original request');
   assert.equal(applied.state,'APPLIED');assert.equal(resolved.commandReceiptId,applied.commandReceiptId);assert.equal(resolved.approvalReceiptId,applied.approvalReceiptId);
   assert.equal((await view(f,id,secondKey)).pendingCommand.requestKey,secondKey);
   const otherOperator=await f.sqlValue(f.platform,'SELECT app.operator_meta_transition_review($1,$2,$3,$4) AS value',[f.tenantId,id,'another-operator',secondKey]);assert.equal(otherOperator.pendingCommand,null);
   assert.equal(f.traffic.length,0,'Local review and resolution never issue provider requests');
   await assert.rejects(()=>command(f,id,'PREREQUISITES',randomUUID(),originalBody),e=>e.code==='55000','Old review digest cannot approve changed evidence');
   await f.run(id,'INITIATE');await f.run(id,'OBSERVE');
   let current=await view(f,id);assert.equal(current.actions.TARGET,true);
   await command(f,id,'TARGET',randomUUID(),body(current,{templateEvidenceSha256:'d'.repeat(64),flowEvidenceSha256:'e'.repeat(64)}));
   const h=createMetaTransitionObserverHarness(f,id);await h.renew();await f.run(id,'OBSERVE');current=await view(f,id);
   assert.equal(current.proof.renewedObserver,'CURRENT');assert.equal(current.actions.COMPLETION,true);
   await command(f,id,'COMPLETION',randomUUID(),body(current));
   assert.equal(f.traffic.filter(item=>item.method==='POST').length,1,'Completion review itself does not resume provider migration');
   await f.run(id,'COMPLETE');current=await view(f,id);assert.equal(current.actions.COMPLETION,false);
   results.push({requestedMode,originalKeyOrders:2,localApprovalNoProviderEffect:true});
  }finally{await f.close();}
 }
 return{mode:'SIMULATED',results,liveEvidence:false};
}
