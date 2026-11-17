import assert from 'node:assert/strict';import {join} from 'node:path';import{open}from'node:fs/promises';
import{runCaseLifecycle,testIds}from'./simulation-case-lifecycle.mjs';import{verifyOwnerEvidence,bindOwnerEvidenceRows}from'./simulation-owner-evidence.mjs';import{simulationEventId}from'./synthetic-first-group-driver.mjs';
import{parseRailsJson}from'./simulation-rails-json.mjs';
export {testIds};
export function caseGenerationText(namespace,reference){assert(/^[A-Za-z0-9_-]{1,40}$/.test(namespace));assert(/^\d{10}$/.test(reference));return 'Synthetic next case '+namespace.replace(/[0-9]/g,n=>String.fromCharCode(97+Number(n)))+' '+reference;}
export function caseParticipant(group,rows){assert.equal(rows.length,1);const m=rows[0];assert.equal(m.external_message_id,group.messageId);assert.equal(m.external_group_id,group.groupRef);assert.equal(m.from_me,false);assert(/^\d{6,20}@(c\.us|lid)$/.test(m.external_participant_id));return m.external_participant_id;}
// The anchor may already be a detached predecessor; follow its finite chain to the one current case.
export function currentCaseFixture(group,rows){
 assert(rows.length>0);const byId=new Map,reference=rows[0].normalized_reference;
 assert(/^\d{10}$/.test(reference));
 for(const row of rows){assert.equal(row.group_binding_id,group.bindingId);assert.equal(row.normalized_reference,reference);assert.equal(byId.has(row.id),false);assert(Number.isInteger(Number(row.generation)));byId.set(row.id,row);}
 const anchors=rows.filter(row=>String(row.zammad_ticket_id)===String(group.ticketId));assert.equal(anchors.length,1);
 const current=rows.filter(row=>row.state==='OPEN'&&row.replaced_by_correlation_id===null);assert.equal(current.length,1);
 const roots=rows.filter(row=>row.predecessor_correlation_id===null);assert.equal(roots.length,1);
 let row=roots[0];const visited=new Set;
 while(row.id!==current[0].id){assert.equal(visited.has(row.id),false);visited.add(row.id);assert.equal(row.state,'DETACHED');assert(row.replaced_by_correlation_id);const next=byId.get(row.replaced_by_correlation_id);assert(next);assert.equal(next.predecessor_correlation_id,row.id);assert.equal(Number(next.generation),Number(row.generation)+1);row=next;}
 assert.equal(row.replaced_by_correlation_id,null);visited.add(row.id);assert.equal(visited.size,rows.length);assert(visited.has(anchors[0].id));return row;
}
export async function caseLifecycleStage(s,{namespace,inputs}){
 const f=inputs.group,h=s.directCallbacks;assert.equal(f.evidenceMode,'simulated');assert.equal(f.namespace,namespace);assert.equal(f.tenantId,s.tenantId);assert.equal(inputs.directConnection.connectionId,f.connectionId);assert(!s.capabilities?.reviewFaultDispatchStarted,'Case generation must precede retained UNKNOWN');assert(s.actorBinding?.userMatched&&s.actorBinding?.workspaceMatched);
 const admit=async()=>{await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:f.connectionId});await h.drainEffects();};await admit();
 const rows=await s.scoped(`WITH anchor AS (
   SELECT normalized_reference FROM case_correlations
   WHERE tenant_id=$1 AND group_binding_id=$2 AND zammad_ticket_id=$3
  ) SELECT c.id,c.group_binding_id,c.normalized_reference,c.state,c.generation,
    c.predecessor_correlation_id,c.replaced_by_correlation_id,c.zammad_ticket_id
   FROM case_correlations c JOIN anchor a ON a.normalized_reference=c.normalized_reference
   WHERE c.tenant_id=$1 AND c.group_binding_id=$2 ORDER BY c.generation,c.id`,[s.tenantId,f.bindingId,String(f.ticketId)]);const current=currentCaseFixture(f,rows);
 const messages=await s.scoped('SELECT external_message_id,external_group_id,external_participant_id,from_me FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3',[s.tenantId,f.connectionId,f.messageId]);const participant=caseParticipant(f,messages);
 const input={eventId:simulationEventId(namespace+'-nextcase'),messageId:'false_'+f.groupRef+'_'+namespace+'-nextcase',chatId:f.groupRef,participant,text:caseGenerationText(namespace,current.normalized_reference)};
 const claim=await open(join(s.privateDir,'case-lifecycle-'+namespace+'.claim'),'wx',0o600);try{await claim.writeFile(JSON.stringify({namespace,caseId:current.id,eventId:input.eventId,messageId:input.messageId}));await claim.sync();}finally{await claim.close();}
 const nativeContainer=s.containers['zammad-railsserver'];assert(nativeContainer?.Id);
 const readNativeEffects=async({connectionId,chatId,reference,marker})=>{
  const arg=Buffer.from(JSON.stringify({connectionId,chatId,reference,marker})).toString('base64');
  const ruby=`require 'base64'; q=JSON.parse(Base64.strict_decode64('${arg}')); ids=Ticket.where(wasalx_connection_id:q.fetch('connectionId'),wasalx_group_id:q.fetch('chatId'),wasalx_reference:q.fetch('reference')).order(:id).pluck(:id); a=Ticket::Article.where(ticket_id:ids).where('body LIKE ?', '%'+q.fetch('marker')+'%').order(:id).pluck(:id,:ticket_id); puts JSON.generate({ticketIds:ids.map(&:to_s),markerArticles:a.map{|x|{id:x[0],ticket_id:x[1]}}})`;
  const value=parseRailsJson(await s.run('docker',['exec',nativeContainer.Id,'bundle','exec','rails','runner',ruby]));assert(Array.isArray(value.ticketIds)&&Array.isArray(value.markerArticles));return value;
 };
 // Detach requires privileged step-up through the supported enrolled factor.
 const privileged=await s.ensurePrivilegedOwner();assert(privileged.userMatched&&privileged.workspaceMatched);
 await s.ownerPage.setViewportSize({width:1440,height:1000});
 const proof=await runCaseLifecycle({page:s.ownerPage,db:s.db,origin:s.portalOrigin,tenantId:s.tenantId,connectionId:f.connectionId,bindingId:f.bindingId,reference:current.normalized_reference,runId:namespace,control:h.control,drainEffects:h.drainEffects,nextInput:input,candidate:s.candidate,evidencePath:join(s.output,'case-lifecycle.json'),checkpoint:s.checkpoint,assertAdmission:admit,readNativeEffects});
 const next=proof.after.find(r=>r.predecessor_correlation_id===current.id);assert(next);const group={...f,ticketId:String(next.zammad_ticket_id)};
 assert.equal(proof.status,'bounded-scenario-passed');const binding=await verifyOwnerEvidence(s);
 const proofs=bindOwnerEvidenceRows(testIds.map(testId=>({testId,result:'passed',contextId:'tenant_owner-en-desktop',startedAt:proof.startedAt,finishedAt:proof.finishedAt,evidencePath:'case-lifecycle.json',proof:{scenarioStatus:proof.status,sourceEvidencePath:'case-lifecycle.json'}})),binding);
 return{evidenceMode:'simulated',namespace,tenantId:s.tenantId,group,proofs,limitations:['Exact navigation remains incomplete until missing/cross-tenant negatives are proven']};
}
