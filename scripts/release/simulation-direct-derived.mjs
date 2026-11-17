import {verifyOwnerEvidence,bindOwnerEvidenceRows} from './simulation-owner-evidence.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const directDerivedIds=[
 'direct-automation/flow-lifecycle-and-exactly-once-processing::one-execution-result-remains-visible-after-reload::02',
 'workflow-studio/immutable-activation-rollback-and-execution-inspection::activated-flow-execution-is-inspectable::01',
 'direct-automation/flow-lifecycle-and-exactly-once-processing::one-execution-result-remains-visible-after-reload::01',
 'direct-automation/version-pinned-outbound-media-and-zammad-history::pinned-version-media-and-history-render::01',
 'workflow-studio/immutable-activation-rollback-and-execution-inspection::returning-conversation-uses-current-flow-version::01',
];
export function validateDerivedDirect(f,namespace){
 // An adopted retained fixture validates against its original source namespace.
 if(f.retainedProvenance?.sourceNamespace!==undefined){const p=f.retainedProvenance;assert.equal(f.namespace,namespace);assert.equal(p.adoptedNamespace,namespace);assert.equal(typeof p.sourceNamespace,'string');assert(p.sourceNamespace&&p.sourceNamespace!==namespace);assert.match(p.sourceHashes?.fixture,/^[a-f0-9]{64}$/);namespace=p.sourceNamespace;}
 assert.equal(f?.evidenceMode,'simulated');assert(f.finishedAt&&f.startedAt);assert.equal(f.drainReceipt?.settled,true);assert.equal(f.drainReceipt.unknown,0);assert.equal(f.drainReceipt.pending,0);
 assert(f.firstVersion&&f.secondVersion&&f.firstVersion!==f.secondVersion);
 const inbound=label=>{const rows=f.proofs.filter(p=>p.label===label);assert.equal(rows.length,1);assert.equal(rows[0].inbox.length,1);assert.equal(rows[0].inbox[0].status,'PROCESSED');return rows[0];};
 const initial=inbound('initial'),resumed=inbound('resumed'),returned=inbound('returning'),fresh=inbound('new-customer');
 assert.equal(initial.conversation.flow_version_id,f.firstVersion);assert.equal(resumed.conversation.flow_version_id,f.firstVersion);
 assert.equal(f.returning.flow_version_id,f.secondVersion);assert.equal(f.fresh.flow_version_id,f.secondVersion);
 assert.notEqual(f.returning.id,initial.conversation.id,'Resolved return creates a new conversation pinned to the current version');assert.notEqual(f.fresh.id,f.returning.id);assert.notEqual(f.fresh.id,initial.conversation.id);assert.equal(f.returning.zammad_ticket_id,initial.conversation.zammad_ticket_id);assert.notEqual(f.fresh.zammad_ticket_id,f.returning.zammad_ticket_id);
 for(const [label,input] of [['initial',initial],['resumed',resumed],['returning',returned],['new-customer',fresh]]){
  const outputs=f.outputProofs.filter(p=>p.label===label);assert.equal(outputs.length,1);const p=outputs[0];const version=['initial','resumed'].includes(label)?'V1':'V2';assert.equal(p.expectedHash,createHash('sha256').update('Synthetic '+namespace+' '+version).digest('hex'));assert.equal(p.outbox.length,1);assert.equal(p.added.length,1);assert.equal(p.outbox[0].state,'SENT');assert.equal(p.outbox[0].external_chat_id,input.input.chatId);assert.equal(p.added[0].id,p.outbox[0].external_message_id);assert.equal(p.added[0].textSha256,p.expectedHash);
 }
 assert.match(initial.receipt.bodySha256,/^[a-f0-9]{64}$/);assert.equal(f.duplicate.bodySha256,initial.receipt.bodySha256);
 return{initial,resumed,returned,fresh};
}
export function validateRetainedProvenance(f){assert(f.sourceRunId);assert(f.producerNamespace);assert.equal(f.retainedProvenance?.namespace,f.producerNamespace);assert.match(f.retainedProvenance.sourceHashes?.manifest,/^[a-f0-9]{64}$/);}
export async function directDerivedStage(session,{namespace,inputs}){
 const startedAt=new Date().toISOString();
 const f=inputs.directFlow;assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);assert.equal(inputs.group?.namespace,namespace);assert.equal(inputs.group?.tenantId,session.tenantId);assert.equal(f?.fixtures?.tenantId,session.tenantId);assert.equal(f.fixtures.connectionId,inputs.group.connectionId);
 await session.verifyOwner(session.ownerPage);
 if(f.sourceRunId!==undefined)validateRetainedProvenance(f);const checked=validateDerivedDirect(f,f.sourceRunId??namespace);
 const executions=await session.scoped("SELECT id,conversation_id,event_inbox_id,safe_metadata FROM bot_conversation_events WHERE tenant_id=$1 AND conversation_id=$2 AND event_inbox_id=$3 AND safe_metadata ? 'result' ORDER BY id",[session.tenantId,checked.initial.conversation.id,checked.initial.inbox[0].id]);
 assert.equal(executions.length,1);assert.equal(executions[0].safe_metadata.result,'HANDOFF');assert.deepEqual(executions[0].safe_metadata.effects,['send_text','handoff']);
 const rows=await session.scoped('SELECT id,flow_version_id,zammad_ticket_id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[]) ORDER BY id',[session.tenantId,f.fixtures.connectionId,[checked.initial.conversation.id,f.returning.id,f.fresh.id]]);
 const expected=new Map([[checked.initial.conversation.id,f.firstVersion],[f.returning.id,f.secondVersion],[f.fresh.id,f.secondVersion]]);assert.equal(rows.length,expected.size);for(const row of rows)assert.equal(row.flow_version_id,expected.get(row.id));
 const ui=await observeDirectDerivedUi(session,{initialId:checked.initial.conversation.id,returningId:f.returning.id,newId:f.fresh.id,executionId:executions[0].id});
 const binding=await verifyOwnerEvidence(session),proofs=bindOwnerEvidenceRows(directDerivedIds.map(testId=>({testId,result:'passed',at:new Date().toISOString(),startedAt,finishedAt:new Date().toISOString(),contextId:'tenant_owner-en-desktop',proof:{sourceStartedAt:f.startedAt,sourceFinishedAt:f.finishedAt,executions,ui,conversations:rows,firstVersion:f.firstVersion,secondVersion:f.secondVersion,outputProofs:f.outputProofs,noAdditionalInbound:true}})),binding);
 const restricted=inputs.securityBusiness?.restrictedExecutionObservations;if(restricted!==undefined)proofs.push(...restrictedExecutionResults(restricted));
 for(const proof of proofs)await session.checkpoint({phase:'direct-derived-proof',...proof});
 return{evidenceMode:'simulated',namespace,tenantId:session.tenantId,proofs,limitations:['No media hashes or attachment ordering claimed.']};
}


// Restricted-role execution rows exist only when the role wave actually observed them (S18B input).
export function restrictedExecutionResults(observations){
 assert(Array.isArray(observations));const expected=['agent','auditor','supervisor','tenant_admin'];
 assert.deepEqual(observations.map(row=>row.role).sort(),expected);
 return observations.map(row=>{
  assert(row.actorVerified&&row.actorRef&&row.tenantId&&row.executionId&&row.conversationId);assert.equal(row.noProviderReplay,true);assert.equal(row.eventIds.filter(id=>id===row.executionId).length,1);assert.deepEqual(row.actualViewport,{width:1440,height:1000});assert(row.startedAt&&row.finishedAt);
  return{testId:directDerivedIds[1],contextId:row.role+'-en-desktop',actualViewport:row.actualViewport,actorRef:row.actorRef,tenantRef:row.tenantRef,verifiedContext:row.verifiedContext,result:'passed',startedAt:row.startedAt,finishedAt:row.finishedAt,proof:{actorVerified:true,actorRef:row.actorRef,tenantId:row.tenantId,noProviderReplay:true,conversationId:row.conversationId,executionId:row.executionId,eventIds:row.eventIds,version:row.version,ticketNumber:row.ticketNumber}};
 });
}

export async function observeRetainedExecution({page,origin,conversationId,executionId,verifyActor}){
 const startedAt=new Date().toISOString(),mutations=[];await page.setViewportSize({width:1440,height:1000});const actor=await verifyActor();assert(actor.userMatched&&actor.workspaceMatched);
 const guard=async route=>{const r=route.request(),u=new URL(r.url());if(u.origin===origin&&u.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push({method:r.method(),path:u.pathname});return route.abort();}return route.fallback();};
 await page.route('**/api/**',guard);
 try{
  await page.goto(origin+'/app?view=automation');await page.getByRole('tab',{name:'Conversations',exact:true}).click();await page.locator('.bot-conversations').waitFor();
  const catalog=await page.evaluate(async()=>{const r=await fetch('/api/bot-flows/conversations?limit=50',{cache:'no-store'});if(!r.ok)throw Error('Conversation catalog unavailable');return r.json();});
  const target=catalog.items.find(row=>row.id===conversationId);assert(target,'Retained execution conversation missing from bounded catalog');
  const row=page.locator('.bot-conversation-list article').filter({hasText:String(target.flow_name)}).filter({hasText:new RegExp('#'+target.zammad_ticket_number+'(?:\\D|$)')}).filter({has:page.locator('header small').filter({hasText:new RegExp('v'+target.version+'$')})});assert.equal(await row.count(),1);assert(await row.isVisible());
  const path='/api/bot-flows/conversations/'+conversationId+'/events',pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='GET');await row.getByRole('button',{name:'View execution history',exact:true}).click();const response=await pending;assert.equal(response.status(),200);const events=await response.json();assert.equal(events.items.filter(event=>event.id===executionId).length,1);
  const dialog=page.getByRole('dialog');await dialog.locator('.bot-node-list li').first().waitFor();assert.equal(await dialog.locator('.bot-node-list li').count(),events.items.length);const finalActor=await verifyActor();await dialog.getByRole('button',{name:'Close execution history',exact:true}).click();
  return{startedAt,finishedAt:new Date().toISOString(),actualViewport:page.viewportSize(),actorRef:finalActor.actorRef,tenantRef:finalActor.tenantRef,verifiedContext:finalActor.verifiedContext,actorVerified:true,noProviderReplay:true,conversationId,executionId,eventIds:events.items.map(event=>event.id),version:target.version,ticketNumber:target.zammad_ticket_number};
 }finally{await page.unroute('**/api/**',guard);assert.deepEqual(mutations,[]);}
}

export async function observeDirectDerivedUi(session,{initialId,returningId,newId,executionId}){
 const page=session.ownerPage,origin=session.portalOrigin,ui=[],mutations=[];
 const guard=async route=>{const r=route.request(),u=new URL(r.url());if(u.origin===origin&&u.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push(u.pathname);return route.abort();}return route.fallback();};
 await page.route('**/api/**',guard);
 try{
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app?view=automation');await page.getByRole('tab',{name:'Conversations',exact:true}).click();await page.locator('.bot-conversations').waitFor();
  const catalog=await page.evaluate(async()=>{const r=await fetch('/api/bot-flows/conversations?limit=50',{cache:'no-store'});if(!r.ok)throw Error('Conversation catalog unavailable');return r.json();});
  for(const id of [initialId,returningId,newId]){
   const target=catalog.items.find(r=>r.id===id);assert(target,'Current produced conversation must be in bounded UI catalog');
   const row=page.locator('.bot-conversation-list article').filter({hasText:String(target.flow_name)}).filter({hasText:new RegExp('#'+target.zammad_ticket_number+'(?:\\D|$)')}).filter({has:page.locator('header small').filter({hasText:new RegExp('v'+target.version+'$')})});
   assert.equal(await row.count(),1);assert(await row.isVisible());
   const path='/api/bot-flows/conversations/'+id+'/events';const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='GET');await row.getByRole('button',{name:'View execution history',exact:true}).click();const response=await pending;assert.equal(response.status(),200);const events=await response.json();assert(events.items.length>0);if(id===initialId)assert.equal(events.items.filter(e=>e.id===executionId).length,1);
   const dialog=page.getByRole('dialog');await dialog.locator('.bot-node-list li').first().waitFor();assert.equal(await dialog.locator('.bot-node-list li').count(),events.items.length);
   ui.push({conversationId:id,version:target.version,ticketNumber:target.zammad_ticket_number,eventIds:events.items.map(e=>e.id),visible:true});await dialog.getByRole('button',{name:'Close execution history',exact:true}).click();
   if(id===initialId){
    await page.reload();await page.getByRole('tab',{name:'Conversations',exact:true}).click();await row.waitFor({state:'visible'});
    const reloadedResponse=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='GET');await row.getByRole('button',{name:'View execution history',exact:true}).click();const response=await reloadedResponse;assert.equal(response.status(),200);const reloaded=await response.json();assertReloadedExecution(events,reloaded,executionId);await dialog.locator('.bot-node-list li').first().waitFor();assert.equal(await dialog.locator('.bot-node-list li').count(),events.items.length);ui.at(-1).reloadVerified=true;await dialog.getByRole('button',{name:'Close execution history',exact:true}).click();
   }

  }
 }finally{await page.unroute('**/api/**',guard);assert.deepEqual(mutations,[]);}
 return ui;
}

export function assertReloadedExecution(before,after,id){assert.deepEqual(after.items,before.items);assert.equal(after.items.filter(e=>e.id===id).length,1);}
