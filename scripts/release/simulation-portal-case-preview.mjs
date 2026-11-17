// OUTPUT ONLY. Proposed scripts/release/simulation-portal-case-preview.mjs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {parseRailsJson} from './simulation-rails-json.mjs';
import {assertIncludedReceipt} from './simulation-sender-policy.mjs';
import {previewId,admitCaseActor,assertPreviewReadOnly,assertReplyEffects,restorationPlan,exactRows} from './simulation-portal-case-contract.mjs';
import {ensurePortalOperator,capturePortalOperatorEvidence,bindPortalOperatorResult} from './simulation-portal-operator.mjs';
export const portalCasePreviewId=previewId;
const sha=x=>createHash('sha256').update(String(x)).digest('hex');
const flowDefinition=namespace=>({schemaVersion:1,kind:'TICKET_EVENT',name:'Owned portal preview '+namespace,event:'before_agent_reply',start:'format',maxSteps:2,nodes:[{id:'format',type:'format_reply',text:'Portal preview {{reply.text}}',quote:'ORIGINAL',next:'done'},{id:'done',type:'end'}]});
export async function portalCasePreviewStage(s,{namespace,inputs}){
 const startedAt=new Date().toISOString(),proofs=[],h=s.directCallbacks;
 const {group:g,actor:agent}=admitCaseActor(s,{namespace,inputs});
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:g.connectionId});await h.drainEffects();
 await s.verifyOwner(s.ownerPage,s.ownerId,'tenant_owner',s.tenantId);await s.ensurePrivilegedOwner();await s.verifyOwner(agent.page,agent.userId,'agent',s.tenantId);
 const operator=await ensurePortalOperator(s,{role:'agent'});await ensurePortalOperator(s,{role:'tenant_owner'});
 const claim=await open(join(s.privateDir,'portal-case-preview-'+namespace+'.claim'),'wx',0o600);
 try{await claim.writeFile(JSON.stringify({namespace,ticketId:g.ticketId,startedAt}));await claim.sync();}finally{await claim.close();}
 const ownerRequest=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace,checkpoint:s.checkpoint});
 const request=createSyntheticRequest({page:agent.page,origin:s.portalOrigin,runId:namespace,checkpoint:s.checkpoint});
 const inbox=(operation,input)=>request('/api/inbox','POST',{operation,input});
 const correlations=await s.scoped('SELECT id,zammad_ticket_number,original_external_message_id FROM case_correlations WHERE tenant_id=$1 AND group_binding_id=$2 AND zammad_ticket_id=$3',[s.tenantId,g.bindingId,String(g.ticketId)]);
 assert.equal(correlations.length,1);const correlation=correlations[0];assert(correlation.original_external_message_id);
 const assignment=async()=>(await ownerRequest('/api/bot-flows/ticket-events')).bindings.find(b=>b.event==='before_agent_reply'&&b.whatsapp_group_id===g.groupId);
 const saved=await assignment();let installedRevision,flowId,replyAttempted=false,settled=false,counter=0;
 const set=async(mode,flowVersionId,expectedRevision)=>ownerRequest('/api/bot-flows/ticket-events','POST',{event:'before_agent_reply',groupId:g.groupId,mode,flowVersionId:flowVersionId??null,expectedRevision},'portal-preview-binding-'+(++counter));
 const snapshot=async()=>{
  const arg=Buffer.from(JSON.stringify({ticketId:String(g.ticketId)})).toString('base64');
  const ruby=`require 'base64';q=JSON.parse(Base64.strict_decode64('${arg}'));t=Ticket.find(q.fetch('ticketId'));puts JSON.generate({articleIds:t.articles.reorder(:id).pluck(:id).map(&:to_s),articles:t.articles.reorder(:id).map{|a|{id:a.id.to_s,body:a.body,internal:a.internal}},operationIds:WasalxTicketOperation.where(ticket_id:t.id).order(:id).pluck(:id).map(&:to_s)})`;
  return{native:parseRailsJson(await s.run('docker',['exec',s.containers['zammad-railsserver'].Id,'bundle','exec','rails','runner',ruby])),
   outbox:await s.scoped('SELECT id,state,zammad_article_id,message_body,reply_to_message_id,ticket_event_execution_id,external_message_id,attempts FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND zammad_ticket_id=$3 ORDER BY id',[s.tenantId,g.connectionId,String(g.ticketId)]),
   executions:await s.scoped("SELECT id,state,mode,flow_version_id FROM ticket_event_executions WHERE tenant_id=$1 AND correlation_id=$2 AND event='before_agent_reply' ORDER BY id",[s.tenantId,correlation.id]),provider:await h.providerRead()};
 };
 const record=async(viewport,result,proof)=>{const binding=await capturePortalOperatorEvidence(operator);const row=bindPortalOperatorResult({testId:portalCasePreviewId,contextId:'agent-en-'+viewport,result,startedAt,finishedAt:new Date().toISOString(),context:{role:'agent',locale:'en',viewport,surface:'portal'},proof},binding,{testIds:[portalCasePreviewId]});proofs.push(row);await s.checkpoint({phase:'portal-case-preview',...row});};
 try{
  const created=await ownerRequest('/api/bot-flows','POST',flowDefinition(namespace),'portal-preview-create');flowId=created.id;assert(flowId);
  await ownerRequest('/api/bot-flows/'+flowId+'/activate','POST',{expectedRevision:Number(created.revision),expectedActiveFlowVersionId:null},'portal-preview-activate');
  const bound=await set('CUSTOM',flowId,Number(saved?.revision??0));installedRevision=Number(bound.revision);
  const draft='Owned preview '+namespace,expectedText='Portal preview '+draft;
  for(const[viewport,width,height]of[['desktop',1440,1000],['mobile',390,844]]){
   await agent.page.setViewportSize({width,height});await agent.page.goto(s.portalOrigin+'/app?view=inbox&ticket='+encodeURIComponent(correlation.zammad_ticket_number));
   const detail=await inbox('SHOW',{ticket_id:String(g.ticketId)});assert(detail.can_reply);await agent.page.getByRole('heading',{name:detail.title,exact:true}).waitFor();
   assert(/^en(?:[-_]|$)/iu.test(await agent.page.evaluate(()=>document.documentElement.lang)));
   await agent.page.getByLabel('Message type',{exact:true}).selectOption('reply');
   await agent.page.getByLabel('Reply to customer',{exact:true}).fill(draft);
   const before=await snapshot();let previewRequests=0,replyRequests=0;
   const observe=q=>{if(new URL(q.url()).origin!==s.portalOrigin||new URL(q.url()).pathname!=='/api/inbox'||q.method()!=='POST')return;const body=q.postDataJSON();if(body.operation==='PREVIEW')previewRequests++;if(body.operation==='REPLY')replyRequests++;};
   agent.page.on('request',observe);
   try{
    const responsePromise=agent.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/inbox'&&r.request().method()==='POST'&&r.request().postDataJSON().operation==='PREVIEW');
    await agent.page.getByRole('button',{name:'Preview reply',exact:true}).click();const response=await responsePromise;assert.equal(response.status(),200);const preview=await response.json();
    assert.equal(preview.text,expectedText);assert.equal(preview.channel,'whatsapp');assert(preview.can_send&&preview.quoted&&!preview.handover_required);assert.equal(preview.ticket_updated_at,detail.updated_at);assert.match(preview.draft_sha256,/^[a-f0-9]{64}$/u);
    await agent.page.locator('.wx-ticket-preview').getByText(expectedText,{exact:true}).waitFor();assert.equal(previewRequests,1);assert.equal(replyRequests,0);assertPreviewReadOnly(before,await snapshot());
    if(viewport==='mobile'){
     // Current UI cancels preview by clearing its draft; no imaginary Cancel button.
     await agent.page.getByLabel('Reply to customer',{exact:true}).fill('');assert.equal(await agent.page.locator('.wx-ticket-preview').count(),0);assert(await agent.page.getByRole('button',{name:'Send reply',exact:true}).isDisabled());
     assert.equal(replyRequests,0);assertPreviewReadOnly(before,await snapshot());await record(viewport,'passed',{actualNativePreview:true,cancelled:true,noSecondEffect:true,customFlowId:flowId});continue;
    }
    replyAttempted=true;await s.checkpoint({phase:'intent',step:'portal-preview-send-once',ticketRef:'sha256:'+sha(g.ticketId),draftSha256:sha(draft)});
    await agent.page.getByRole('button',{name:'Send reply',exact:true}).click();
    // Never replay after timeout/ambiguous response: reconcile exact effect delta.
    const deadline=Date.now()+120000;let after,delivery,execution;
    do{await h.drainEffects();after=await snapshot();const delta=after.outbox.filter(d=>!before.outbox.some(b=>b.id===d.id));assert(delta.length<=1,'Duplicate delivery');delivery=delta[0];execution=delivery&&after.executions.find(e=>e.id===delivery.ticket_event_execution_id);if(delivery?.state==='SENT'&&execution?.state==='APPLIED')break;await new Promise(resolve=>setTimeout(resolve,300));}while(Date.now()<deadline);
    assert.equal(replyRequests,1);assert(delivery&&execution);assertReplyEffects({before,after,delivery,execution,flowId,draft,expectedText,originalMessageId:correlation.original_external_message_id});
    const receipt=assertIncludedReceipt(before.provider,after.provider,delivery,g.groupRef);settled=true;
    await record(viewport,'passed',{actualNativePreview:true,oneArticle:true,oneOutbox:true,workflowApplied:true,oneProviderReceipt:true,originalQuoteMatched:true,deliveryId:delivery.id,executionId:execution.id,providerReceiptId:receipt.id});
   }finally{agent.page.off('request',observe);}
  }
 }catch(error){
  const context=proofs.some(p=>p.contextId==='agent-en-desktop')?'mobile':'desktop';await record(context,replyAttempted&&!settled?'unknown':'failed',{classification:replyAttempted&&!settled?'unknown-outcome-no-replay':'requires-review',errorClass:error.name,messageSha256:sha(error.message)});
  for(const viewport of['desktop','mobile'])if(!proofs.some(p=>p.contextId==='agent-en-'+viewport))await record(viewport,'blocked',{classification:'dependency-blocked',noReplay:true});
 }finally{
  if(installedRevision&&(!replyAttempted||settled)){
   const plan=restorationPlan({saved,current:await assignment(),installedRevision,flowId,replyAttempted,settled});
   await set(plan.mode,plan.flowVersionId,plan.expectedRevision);
  }else if(replyAttempted&&!settled)await s.checkpoint({phase:'portal-preview-binding-held',reason:'Reply outcome unresolved; reconcile exact effects before CAS restoration',namespace});
 }
 exactRows(proofs,['desktop','mobile'].map(v=>({testId:portalCasePreviewId,contextId:'agent-en-'+v})));
 return{evidenceMode:'simulated',namespace,tenantId:s.tenantId,proofs};
}
