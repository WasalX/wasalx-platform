import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{verifyTenantEvidence,bindTenantEvidenceRows}from'./simulation-owner-evidence.mjs';
import{runRolePermissionWave,rebindSimulationRole}from'./simulation-team-role-wave.mjs';
export const workflowViewIds=['01','02','03'].map(s=>'workflow-studio/canvas-form-and-restricted-raw-inspection::canvas-form-and-authorized-raw-views-agree::'+s);
const failure=e=>({classification:'requires-review',errorClass:e.name,messageSha256:createHash('sha256').update(String(e.message)).digest('hex'),...(/^workflow-select-[a-z-]+$/u.test(e.qualificationOperation??'')?{operation:e.qualificationOperation}:{})});
export function admitWorkflowViews(session,{namespace,inputs}){
 const draft=inputs.workflowDraft;assert.equal(draft?.evidenceMode,'simulated');assert.equal(draft.namespace,namespace);assert.equal(draft.tenantId,session.tenantId);assert(draft.draftVersionId&&draft.sourceId);
 const actor=inputs.secondActor;assert.equal(actor?.namespace,namespace);assert.equal(actor.tenantId,session.tenantId);assert.equal(actor.role,'agent');assert.equal(actor.memberId,session.capabilities?.secondActor?.memberId);assert(session.capabilities.secondActor.page);
 assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);assert.equal(typeof session.verifyOwner,'function');return draft;
}
// Catalog cards load asynchronously; wait for the exact card inside the flows tabpanel before counting.
export async function selectWorkflowVersion(page,origin,{name,version}){
 let operation='workflow-select-viewport';
 try{
  await page.setViewportSize({width:1440,height:1000});operation='workflow-select-navigate';await page.goto(origin+'/app?view=automation');
  operation='workflow-select-card-visible';const panel=page.locator('#bot-panel-flows'),card=panel.getByRole('button').filter({has:page.locator('b',{hasText:name})}).filter({has:page.locator('small',{hasText:new RegExp('^Version\\s+'+version+'\\s')})});await card.waitFor({state:'visible'});
  operation='workflow-select-card-count';assert.equal(await card.count(),1);
  operation='workflow-select-card-click';await card.click();operation='workflow-select-detail-visible';await panel.locator('.bot-flow-detail').waitFor();
 }catch(error){error.qualificationOperation=operation;throw error;}
}
const ownerViewRoles=new Set(['tenant_owner','tenant_admin']),restrictedViewRoles=new Set(['agent','supervisor','auditor']),waveOrder=['tenant_admin','supervisor','auditor'];
// Observe only allocated desktop contexts; without stage checks the existing owner/agent pair is the allocation.
export function workflowViewPlan(ids,checks){
 const contextual=Array.isArray(checks)&&checks.length>0,plan={owner:[],agent:[],wave:new Map()};
 for(const testId of ids){const index=workflowViewIds.indexOf(testId);assert(index>=0);const contexts=contextual?checks.filter(check=>check.testId===testId).map(check=>check.contextId):[index===2?'agent-en-desktop':'tenant_owner-en-desktop'];
  for(const contextId of contexts){const match=/^(tenant_owner|tenant_admin|supervisor|auditor|agent)-en-desktop$/u.exec(contextId);if(!match)continue;const role=match[1];if(!(index===2?restrictedViewRoles:ownerViewRoles).has(role))continue;
   if(role==='tenant_owner')plan.owner.push(index);else if(role==='agent')plan.agent.push(index);else plan.wave.set(role,[...(plan.wave.get(role)??[]),index]);}}
 return{owner:plan.owner,agent:plan.agent,wave:waveOrder.filter(role=>plan.wave.has(role)).map(role=>({role,indexes:plan.wave.get(role)}))};
}
// One retained actor changes role sequentially through the published role wave and is restored to agent.
export async function runWorkflowRoleWave(session,{runId,roles,observeRole}){
 const capability=session.capabilities.secondActor,startedAt=new Date().toISOString();assert(capability?.memberId&&capability.userId&&capability.subject&&typeof capability.login==='function');
 const readMember=async id=>{const rows=await session.scoped('SELECT id,user_id,role,state,version,whatsapp_numbers FROM tenant_memberships WHERE id=$1',[id]);assert.equal(rows.length,1);return rows[0];};
 const assertActor=async(page,{role})=>{const owner=page===session.ownerPage,id=owner?session.ownerId:capability.userId,verifiedContext=await verifyTenantEvidence(session,page,id,role,session.tenantId,owner?session.ownerId:capability.subject);return{userMatched:true,workspaceMatched:true,userId:id,role,actorRef:verifiedContext.actorRef,tenantRef:verifiedContext.tenantRef,locale:verifiedContext.locale,verifiedContext,actorVerified:true};};
 const readAudit=async({memberId,mutations,ownerUserId})=>{const rows=await session.scoped("SELECT actor_id,new_value,request_id FROM audit_events WHERE target_type='tenant_membership' AND target_id=$1 AND action='team.membership_updated' AND created_at >= $2::timestamptz ORDER BY created_at,id",[memberId,startedAt]);assert.equal(rows.length,mutations.length);rows.forEach((row,index)=>{assert.equal(row.actor_id,ownerUserId);assert.equal(Number(row.new_value.version),mutations[index].version);assert.equal(row.new_value.role,mutations[index].role);assert(row.request_id);});return{matched:true,count:rows.length};};
 const wave=await runRolePermissionWave({ownerPage:session.ownerPage,memberPage:capability.page,origin:session.portalOrigin,runId,tenantId:session.tenantId,memberId:capability.memberId,checkpoint:session.checkpoint,roles,assertActor,assertIsolatedRuntime:async()=>assert(session.model.name.startsWith('wasalx-simulation-')),readMember,rebindRole:(page,role)=>rebindSimulationRole(session,capability,page,role),observeRole:async({role,page})=>role==='agent'?[]:observeRole({role,page}),additional:async()=>({workflowReadOnly:true}),readAudit});
 assert.equal(wave.restored,true,'Workflow role actor was not restored to agent');return wave;
}
// A role whose observer never ran is recorded as failed for each planned test, never omitted or passed.
export function workflowWaveRows(wave,plan,testIdFor){
 return plan.flatMap(({role,indexes})=>{const proof=wave.proofs.find(row=>row.role===role);assert(proof,'Role wave proof missing: '+role);if(Array.isArray(proof.observation))return proof.observation;
  return indexes.map(index=>({testId:testIdFor(index),result:'failed',contextId:role+'-en-desktop',startedAt:proof.startedAt,finishedAt:proof.finishedAt,actorRef:proof.actorRef,tenantRef:proof.tenantRef,proof:{classification:'requires-review',stage:proof.stage??'role-observer',...(proof.failure??{})}}));});
}
export async function guardedWorkflowRead(session,page,run){const mutations=[],guard=async route=>{const r=route.request(),u=new URL(r.url());if(u.origin===session.portalOrigin&&u.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push(u.pathname);return route.abort();}return route.fallback();};await page.route('**/api/**',guard);try{const value=await run();assert.deepEqual(mutations,[]);return value;}finally{await page.unroute('**/api/**',guard);}}
export async function workflowViewsStage(session,args){
 const draft=admitWorkflowViews(session,args),page=session.ownerPage,origin=session.portalOrigin,restricted=session.capabilities.secondActor.page,startedAt=new Date().toISOString();
 const selected=args.config?.selectedTestIds,ids=selected?workflowViewIds.filter(id=>selected.includes(id)):[...workflowViewIds];
 // Lifecycle collection reads the owner view as a prerequisite even when only lifecycle IDs are selected.
 if(selected?.some(id=>id.startsWith('workflow-studio/immutable-activation-rollback-and-execution-inspection::saved-flow-activation-is-immutable::'))&&!ids.includes(workflowViewIds[0]))ids.push(workflowViewIds[0]);
 if(!ids.length)return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,proofs:[]};
 const read=id=>page.evaluate(async id=>{const r=await fetch('/api/bot-flows/'+id,{cache:'no-store'});if(!r.ok)throw Error('Workflow unavailable');return r.json();},id);
 await session.verifyOwner(page,session.ownerId,'tenant_owner');await session.verifyOwner(restricted,args.inputs.secondActor.userId,'agent');
 const before=await read(draft.draftVersionId);assert.equal(before.state,'DRAFT');const definition=before.definition;assert(Array.isArray(definition.nodes));const proofs=[];
 const mutations=[];const guard=async route=>{const r=route.request(),u=new URL(r.url());if(u.origin===origin&&u.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push(u.pathname);return route.abort();}return route.fallback();};await page.route('**/api/**',guard);await restricted.route('**/api/**',guard);
 const select=p=>selectWorkflowVersion(p,origin,{name:before.definition.name,version:before.version});
 const plan=workflowViewPlan(ids,args.checks),capability=session.capabilities.secondActor;
 // The owner clone view gates lifecycle collection, so it is observed even when only lifecycle checks are allocated.
 if(ids.includes(workflowViewIds[0])&&!plan.owner.includes(0)&&!(Array.isArray(args.checks)&&args.checks.some(check=>check.testId===workflowViewIds[0])))plan.owner.push(0);
 const owner={page,role:'tenant_owner',id:session.ownerId,subject:session.ownerId},agent={page:restricted,role:'agent',id:args.inputs.secondActor.userId,subject:capability.subject};
 const observe=[
  async p=>{await select(p);await p.getByRole('button',{name:'Clone as draft',exact:true}).click();await p.getByRole('region',{name:'Interactive workflow graph',exact:true}).waitFor();assert.equal(await p.locator('.react-flow__node').count(),definition.nodes.length);for(const node of definition.nodes)if(node.type==='send_text'){assert.equal(await p.locator('#bot-node-'+node.id+'-text').inputValue(),node.text);assert.equal(await p.locator('#bot-node-'+node.id+'-next').inputValue(),node.next);assert(await p.locator('.workflow-graph-node').filter({hasText:node.text}).count());}return{draftVersionId:draft.draftVersionId,nodes:definition.nodes.map(n=>({id:n.id,type:n.type})),storedFormGraphAgree:true};},
  async p=>{await select(p);await p.getByText('Advanced details',{exact:true}).click();const raw=p.locator('pre[aria-label="Technical view of this version"]');await raw.waitFor();assert.deepEqual(JSON.parse(await raw.innerText()),definition);return{draftVersionId:draft.draftVersionId,rawEqualsStored:true};},
  async(p,role)=>{await select(p);const panel=p.locator('#bot-panel-flows .bot-flow-detail');assert.equal(await panel.locator(':scope > ol.bot-node-list > li').count(),definition.nodes.length);assert.equal(await panel.locator('.routing-raw,.bot-heading-actions,[role="region"][aria-label="Interactive workflow graph"]').count(),0);return{draftVersionId:draft.draftVersionId,memberId:args.inputs.secondActor.memberId,role,summaryCount:definition.nodes.length,noRawOrEdit:true};}];
 const row=async(index,actor,rowStartedAt)=>{let result='passed',proof;try{proof=await observe[index](actor.page,actor.role);}catch(e){result='failed';proof=failure(e);}const binding=await verifyTenantEvidence(session,actor.page,actor.id,actor.role,session.tenantId,actor.subject);return bindTenantEvidenceRows([{testId:workflowViewIds[index],result,contextId:actor.role+'-en-desktop',startedAt:rowStartedAt,finishedAt:new Date().toISOString(),proof}],binding)[0];};
 const collect=async(index,actor)=>{const bound=await row(index,actor,startedAt);proofs.push(bound);await session.checkpoint({phase:'workflow-view-proof',...bound});};
 try{
  for(const index of [1,0])if(plan.owner.includes(index))await collect(index,owner);
  if(plan.agent.includes(2))await collect(2,agent);
 }finally{await page.unroute('**/api/**',guard);await restricted.unroute('**/api/**',guard);await session.verifyOwner(page,session.ownerId,'tenant_owner');await session.verifyOwner(restricted,args.inputs.secondActor.userId,'agent');assert.deepEqual(mutations,[]);assert.deepEqual(await read(draft.draftVersionId),before);}
 if(plan.wave.length){
  const wave=await runWorkflowRoleWave(session,{runId:args.namespace+'-workflow-views',roles:plan.wave.map(entry=>entry.role),observeRole:async({role,page:memberPage})=>{await memberPage.setViewportSize({width:1440,height:1000});const actor={page:memberPage,role,id:capability.userId,subject:capability.subject},rows=[];for(const index of plan.wave.find(entry=>entry.role===role).indexes)rows.push(await guardedWorkflowRead(session,memberPage,()=>row(index,actor,new Date().toISOString())));return rows;}});
  for(const bound of workflowWaveRows(wave,plan.wave,index=>workflowViewIds[index])){proofs.push(bound);await session.checkpoint({phase:'workflow-view-proof',...bound});}
  assert.deepEqual(await read(draft.draftVersionId),before);
 }
 assert.deepEqual(proofs.map(x=>x.testId).sort(),[...plan.owner,...plan.agent,...plan.wave.flatMap(entry=>entry.indexes)].map(index=>workflowViewIds[index]).sort());return{evidenceMode:'simulated',namespace:args.namespace,tenantId:session.tenantId,proofs};
}
