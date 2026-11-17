import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {metaTransitionObservation} from '../packages/core/dist/meta-account-transition-observation.js';
import {metaTransitionContext} from '../packages/core/dist/meta-account-transition-context.js';
import {parseMetaTemplateInventoryItem} from '../packages/core/dist/meta-template-inventory.js';

/** Called inside the existing actual app/worker P08 fixture, after its first verified enrollment. */
export async function verifyMetaTransitionPreview({admin,app,worker,tx,tenant,other,user,connection,account,phone,appId,request,controller,operations,state}){
  const original=await state(),page=await controller.metaTransitionPage(request,connection);
  assert.ok(page.prepare);assert.equal(page.currentPlan,null);
  const body={requestedMode:'CUSTOMER',targetCurrency:'SAR',expectedAccountRevision:page.prepare.accountRevision,expectedBindingRevision:page.prepare.bindingRevision};
  await assert.rejects(()=>controller.createMetaTransitionPreview({...request,principal:{...request.principal,authenticatedAt:0,authenticationMethods:['pwd']}},connection,'preview-no-mfa',body),
    error=>error.getResponse?.()?.code==='REAUTHENTICATION_REQUIRED');
  const accepted=await Promise.all([controller.createMetaTransitionPreview(request,connection,'preview-one',body),controller.createMetaTransitionPreview(request,connection,'preview-one',body)]);
  assert.equal(accepted[0].id,accepted[1].id);assert.equal(accepted.filter(row=>row.duplicate).length,1);
  await assert.rejects(()=>controller.createMetaTransitionPreview(request,connection,'preview-one',{...body,targetCurrency:'EUR'}),/another preview/);
  const id=accepted[0].id;
  await assert.rejects(()=>controller.metaTransitionView({...request,principal:{...request.principal,tenantId:other}},connection,id),/not found/);
  await assert.rejects(()=>tx(app,tenant,client=>client.query("UPDATE meta_account_transitions SET target_currency='EUR',revision=revision+1 WHERE id=$1",[id])),{code:'23514'});
  await assert.rejects(()=>tx(app,tenant,client=>client.query('UPDATE meta_account_transitions SET requested_by=NULL WHERE id=$1',[id])),{code:'23514'});
  const lease=randomUUID(),jobs=await operations.claim(tenant,lease,1);assert.equal(jobs.length,1);assert.equal(jobs[0].operationType,'PREVIEW_META_ACCOUNT_TRANSITION');
  const job=jobs[0],frame=await operations.guardMetaTransitionPreview(job,lease,appId);assert.ok(frame.context);
  assert.equal(frame.context.actorId,user);assert.equal(frame.context.providerAccountId,account);assert.deepEqual(frame.context.phoneIds,[phone]);
  const supportingOwner=randomUUID();
  await admin.query("INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'Preview support owner')",[supportingOwner,`preview-${supportingOwner}`,`preview-${supportingOwner}@example.invalid`]);
  await admin.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_owner')",[tenant,supportingOwner]);
  await admin.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2",[tenant,user]);
  assert.equal((await operations.guardMetaTransitionPreview(job,lease,appId)).context,null,'Current initiating membership remains required at every read boundary');
  await admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[tenant,user]);
  // Keep this real active owner while later stale-principal cancellation checks remove the original member.
  await assert.rejects(()=>tx(app,tenant,client=>client.query("UPDATE connection_operations SET result='{}'::jsonb WHERE id=$1",[job.id])),{code:'42501'});
  for(const pool of [app,worker])await tx(pool,tenant,async client=>{
    for(const relation of ['tenants','tenant_memberships','connections','provider_sessions','meta_messaging_accounts','meta_connection_account_bindings','privacy_jobs','webhook_routes','bot_assignments','bot_conversations','bot_flow_versions','meta_billing_policy_versions','event_inbox'])
      await client.query(`CREATE TEMP TABLE ${relation}(poison boolean) ON COMMIT DROP`);
    const raw=(await client.query('SELECT app.meta_account_transition_context($1,$2,$3) AS value',[connection,user,appId])).rows[0].value;
    assert.equal(raw.connectionId,connection,'Privileged lookup never resolves a temporary relation');
  });
  // Run the actual context parser against a genuine tenant credential/context
  // frame, with a bounded synthetic published definition as its private input.
  // This proves extraction, not provider Flow approval or copy compatibility.
  const raw=(await tx(worker,tenant,c=>c.query('SELECT app.meta_account_transition_context($1,$2,$3) AS value',[connection,user,appId]))).rows[0].value;
  const contextExpected={tenantId:tenant,connectionId:connection,actorId:user,appId};
  const parseContext=value=>metaTransitionContext(value,contextExpected);
  for(const stored of [undefined,null,'bad','f'.repeat(64)]){
   const changed={...raw,bindingProofSha256:stored,...(stored==null?{sessionProofSha256:stored}:{})};
   assert.throws(()=>parseContext(changed),/META_TRANSITION_CONTEXT_UNAVAILABLE/,'Stored SQL proof identity cannot be absent or changed');
   const scope=raw.scope.map((r,i)=>i===0?{...r,proofSha256:stored,...(stored==null?{sessionProofSha256:stored}:{})}:r);
   if(stored===undefined){delete scope[0].proofSha256;delete scope[0].sessionProofSha256;}
   assert.equal(parseContext({...raw,scope}).scope[0].proofCurrent,false,'Scope needs a finite stored SQL proof identity');
  }
  assert.throws(()=>parseContext({...raw,canonicalProofSha256:'f'.repeat(64)}),/META_TRANSITION_CONTEXT_UNAVAILABLE/);
  assert.equal(parseContext({...raw,scope:raw.scope.map((r,i)=>i===0?{...r,canonicalProofSha256:'f'.repeat(64)}:r)}).scope[0].proofCurrent,false);
  const flowId=randomUUID(),definition={schemaVersion:1,name:'Synthetic dependency flow',start:'template',maxSteps:10,nodes:[
   {id:'template',type:'send_template',templateName:'order_update',languageCode:'en_US',bodyParameters:['Order'],transcriptText:'Synthetic update',next:'form'},
   {id:'form',type:'whatsapp_flow',flowId:'12345',prompt:'Confirm',buttonLabel:'Open',data:{},next:'done'},{id:'done',type:'end'}]};
  const parsed=metaTransitionContext({...raw,flows:[{id:flowId,snapshotSha256:'a'.repeat(64),definition}]},{tenantId:tenant,connectionId:connection,actorId:user,appId});
  assert.deepEqual(parsed.templateDependencies,[{flowVersionId:flowId,name:'order_update',language:'en_US',parameterCount:1}]);
  assert.deepEqual(parsed.metaFlowDependencies,[{flowVersionId:flowId,providerFlowId:'12345'}]);
  const template=parseMetaTemplateInventoryItem({id:'123',name:'order_update',language:'en_US',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'Private synthetic Order {{1}}'}]});
  const inventory={sourceAccountId:account,currency:'USD',phoneIds:[phone],phonesComplete:true,templatesComplete:true,templates:[template]};
  assert.equal(metaTransitionObservation(frame.request,parsed,inventory).impact.affectedFlowVersionCount,1,'A version with both node types is counted only once');
  const secondFlow=randomUUID(),parsedTwo=metaTransitionContext({...raw,flows:[{id:flowId,snapshotSha256:'a'.repeat(64),definition},{id:secondFlow,snapshotSha256:'b'.repeat(64),definition}]},{tenantId:tenant,connectionId:connection,actorId:user,appId});
  assert.equal(metaTransitionObservation(frame.request,parsedTwo,inventory).impact.affectedFlowVersionCount,2);
  const observed=metaTransitionObservation(frame.request,frame.context,inventory);
  await operations.completeMetaTransitionPreview(job,lease,appId,observed);
  assert.deepEqual(await state(),original,'Read completion cannot alter session, lifecycle or credentials');
  let view=await controller.metaTransitionView(request,connection,id);assert.equal(view.state,'BLOCKED');assert.equal(view.canExecute,false);assert.equal(view.current.currency,'USD');
  assert.ok(!JSON.stringify(view).includes('secret://'));assert.ok(!JSON.stringify(view).includes(account));
  assert.equal(view.impact.sourceTemplateCount,1);assert.equal(view.impact.templateCompatibility,'NOT_ASSESSED');
  assert.equal(JSON.stringify(view).includes('Private synthetic'),false);
  for(const [label,templates,complete,expectedCount,drift]of [['empty',[],true,0,false],['incomplete',[template],false,null,false],['changed',[template],true,null,true]]){
   const current=await controller.metaTransitionView(request,connection,id);
   await controller.refreshMetaTransition(request,connection,id,'template-count-'+label,{expectedRevision:current.revision});
   const refreshLease=randomUUID(),claimed=await operations.claim(tenant,refreshLease,1);assert.equal(claimed.length,1);
   const next=await operations.guardMetaTransitionPreview(claimed[0],refreshLease,appId);assert.ok(next.context);
   const nextObservation=metaTransitionObservation(next.request,next.context,{...inventory,templates,templatesComplete:complete});
   if(drift)await admin.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2",[tenant,user]);
   try{await operations.completeMetaTransitionPreview(claimed[0],refreshLease,appId,nextObservation);}
   finally{if(drift)await admin.query("UPDATE tenant_memberships SET role='tenant_owner' WHERE tenant_id=$1 AND user_id=$2",[tenant,user]);}
   const countView=await controller.metaTransitionView(request,connection,id);
   assert.equal(countView.impact.sourceTemplateCount,expectedCount,label);assert.equal(countView.canExecute,false);
   assert.equal(countView.impact.templateCompatibility,'NOT_ASSESSED');assert.equal(JSON.stringify(countView).includes('Private synthetic'),false);
   if(drift)assert.ok(countView.reasons.includes('CURRENT_BINDING_CHANGED'),'Final completion rechecks actual membership before publishing a count');
  }
  view=await controller.metaTransitionView(request,connection,id);
  const completed=(await admin.query('SELECT result FROM connection_operations WHERE id=$1',[job.id])).rows[0].result;
  await assert.rejects(()=>tx(worker,tenant,client=>client.query("UPDATE connection_operations SET result='{}'::jsonb WHERE id=$1",[job.id])),{code:'42501'});
  await controller.cancelMetaTransition(request,connection,id,{expectedRevision:view.revision});
  assert.equal((await controller.metaTransitionView(request,connection,id)).state,'CANCELLED');
  assert.deepEqual((await admin.query('SELECT result FROM connection_operations WHERE id=$1',[job.id])).rows[0].result,completed,'Closing a preview retains original observation');
  const fresh=await controller.metaTransitionPage(request,connection);
  const second=await controller.createMetaTransitionPreview(request,connection,'preview-managed',{...body,requestedMode:'WASALX_MANAGED',...{
    expectedAccountRevision:fresh.prepare.accountRevision,expectedBindingRevision:fresh.prepare.bindingRevision}});
  view=await controller.metaTransitionView(request,connection,second.id);
  const cancelBody={expectedRevision:view.revision};
  const staleRequest={...request,principal:{...request.principal,userId:supportingOwner,role:'tenant_owner'}};
  const saved=async()=>(await admin.query(`SELECT p.revision,p.state,o.state AS operation_state FROM meta_account_transitions p
    JOIN connection_operations o ON o.id=p.current_observation_operation_id WHERE p.id=$1`,[second.id])).rows[0];
  const beforeCancel=await saved();
  const denied=async()=>{await assert.rejects(()=>controller.cancelMetaTransition(staleRequest,connection,second.id,cancelBody),error=>error.getStatus?.()===403);
    assert.deepEqual(await saved(),beforeCancel,'Stale principals change neither plan nor queued operation');};
  assert.equal((await admin.query("UPDATE tenant_memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2 RETURNING role",[tenant,supportingOwner])).rows[0].role,'auditor');
  await denied();
  assert.equal((await admin.query("UPDATE tenant_memberships SET role='tenant_owner',state='SUSPENDED' WHERE tenant_id=$1 AND user_id=$2 RETURNING state",[tenant,supportingOwner])).rows[0].state,'SUSPENDED');
  await denied();
  assert.equal((await admin.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 RETURNING user_id',[tenant,supportingOwner])).rowCount,1);
  await denied();
  assert.equal((await admin.query('SELECT requested_by FROM meta_account_transitions WHERE id=$1',[second.id])).rows[0].requested_by,user,
    'The original initiator stays present for the later actual tenant-deletion oracle');
  await assert.rejects(()=>controller.cancelMetaTransition({...request,principal:{...request.principal,authenticatedAt:0,authenticationMethods:['pwd']}},connection,second.id,cancelBody),
    error=>error.getResponse?.()?.code==='REAUTHENTICATION_REQUIRED');
  const session=(await admin.query("SELECT id,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'",[tenant,connection])).rows[0];
  assert.ok(session.provider_state_data.metaAccountProof);
  await withFixtureTenant(admin,tenant,()=>admin.query("UPDATE provider_sessions SET provider_state_data=provider_state_data-'metaAccountProof' WHERE id=$1",[session.id]));
  try{
    await controller.cancelMetaTransition(request,connection,second.id,cancelBody);
    assert.equal((await controller.cancelMetaTransition(request,connection,second.id,cancelBody)).duplicate,true,'Same local cancellation remains idempotent');
    await assert.rejects(()=>controller.cancelMetaTransition(request,connection,second.id,{expectedRevision:cancelBody.expectedRevision+2}),error=>error.getStatus?.()===409);
  }finally{await withFixtureTenant(admin,tenant,()=>admin.query('UPDATE provider_sessions SET provider_state_data=$1 WHERE id=$2',[session.provider_state_data,session.id]));}
  const actorCopies=(await admin.query("SELECT id,payload,requested_by_id FROM connection_operations WHERE tenant_id=$1 AND operation_type='PREVIEW_META_ACCOUNT_TRANSITION'",[tenant])).rows;
  assert.ok(actorCopies.every(row=>!Object.hasOwn(row.payload.metaAccountTransition,'actorId')&&row.requested_by_id===user));
  assert.equal((await operations.claim(tenant,randomUUID(),1)).length,0,'Cancelled queued reads cannot be claimed');
  assert.deepEqual(await state(),original);
  return{sameKeyRace:true,actualRoles:true,tempShadowRoles:2,immutableObservations:true,cancelledClaim:false,lifecycleUnchanged:true,providerEffects:0,observationOperationIds:actorCopies.map(row=>row.id).sort()};
}
