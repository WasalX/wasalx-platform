import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const portalTestId=id=>id+'::portal';
export const legacyTestId=id=>{assert(typeof id==='string'&&id.endsWith('::portal'),'Current portal test identity required');return id.slice(0,-8);};
export const desktop={width:1440,height:1000};
const hash=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');

export function selectPortalChecks(checks,ids,contexts){
 assert(Array.isArray(checks)&&checks.length,'Explicit current checks required');
 const allowed=new Set(ids),seen=new Set();
 for(const check of checks){assert(allowed.has(check?.testId),'Unknown current portal test');assert((contexts[check.testId]??[]).includes(check.contextId),'Unsupported actual portal context');const key=JSON.stringify([check.testId,check.contextId]);assert(!seen.has(key),'Duplicate current portal check');seen.add(key);}
 return new Set(checks.map(check=>legacyTestId(check.testId)));
}
export function portalRulesContextMap(ids){return Object.fromEntries(ids.map(id=>[id,['tenant_owner-en-desktop']]));}
export async function privateBackendPath(s,path,read){
 const fetch=read??(await import('./simulation-portal-operator.mjs')).privateNativeRead;
 let match;
 if(path==='/api/v1/ticket_states')return fetch(s,'states',{});
 if((match=/^\/api\/v1\/tickets\/([1-9][0-9]{0,15})$/u.exec(path)))return fetch(s,'ticket',{ticketId:match[1]});
 if((match=/^\/api\/v1\/ticket_articles\/by_ticket\/([1-9][0-9]{0,15})$/u.exec(path)))return fetch(s,'articles',{ticketId:match[1]});
 throw Error('Unsupported private readback path');
}
export async function preparePortalRuleOperator(s,group,role='tenant_owner'){
 const helper=await import('./simulation-portal-operator.mjs'),groups=await import('./simulation-portal-groups.mjs');
 assert.equal(group.evidenceMode,'simulated');assert.equal(group.tenantId,s.tenantId);
 const operator=await helper.ensurePortalOperator(s,{role,viewport:desktop,locale:'en'});
 await groups.ensurePortalTeamGrant(s,{operator,nativeGroupId:Number(group.zammadGroupId),access:['full']});
 await operator.page.setViewportSize(desktop);await operator.verify();
 return operator;
}
export async function observePortalRuleTicket(operator,{ticket,articleId,marker},helpers){
 const h=helpers??await import('./simulation-portal-operator.mjs');
 assert.match(String(ticket.number),/^[1-9][0-9]{0,15}$/u);
 await h.openPortalTicket(operator,{ticketNumber:String(ticket.number),articleId:String(articleId),marker});
 await operator.page.getByText(ticket.title,{exact:true}).first().waitFor({state:'visible'});
 await operator.page.locator('[data-article-id="'+articleId+'"]').getByText(marker,{exact:false}).waitFor({state:'visible'});
 const binding=await h.capturePortalOperatorEvidence(operator);
 return{surface:'portal',visible:true,ticketNumber:String(ticket.number),articleId:String(articleId),titleSha256:hash(ticket.title),markerSha256:hash(marker),...binding};
}
export async function bindPortalRuleRows(rows,operator,ids){
 const h=await import('./simulation-portal-operator.mjs'),allowed=new Set(ids),binding=await h.capturePortalOperatorEvidence(operator);
 return rows.map(row=>{const id=portalTestId(row.testId);assert(allowed.has(id));return h.bindPortalOperatorResult({...row,testId:id,contextId:'tenant_owner-en-desktop'},binding);});
}
export async function closePortalWorkflowTicket(operator,ticket,closed,{checkpoint,lifecycle,helpers,observeAction}){
 const h=helpers??await import('./simulation-portal-operator.mjs'),observe=observeAction??(await import('./simulation-portal-groups.mjs')).observePortalAction,page=operator.page;
 await h.openPortalTicket(operator,{ticketNumber:String(ticket.number)});
 await page.locator('#inbox-state').selectOption(String(closed.id));
 try{
  const observed=await observe({operator,operation:'UPDATE',checkpoint,action:()=>page.getByRole('button',{name:'Save changes',exact:true}).click(),
   beforeDispatch:intent=>{assert.equal(String(intent.ticket_id),String(ticket.id));assert.equal(String(intent.state_id),String(closed.id));assert.match(intent.operation_id,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);lifecycle.unsettled=true;lifecycle.intent=intent;}});
  if(observed.status!==200||observed.value?.state!=='APPLIED'||observed.value.operation_id!==lifecycle.intent.operation_id||String(observed.value.ticket_id)!==String(lifecycle.intent.ticket_id))throw Error('Portal close not acknowledged; retain original operation');
  lifecycle.unsettled=false;
  await page.getByText('Saved. Delivery continues in the background.',{exact:true}).waitFor({state:'visible'});
  const current=await h.privateNativeRead(operator.session,'ticket',{ticketId:String(ticket.id)});
  assert.equal(String(current.state_id),String(closed.id));await operator.verify();return current;
 }catch(error){if(lifecycle.unsettled){error.qualificationOutcomeUnknown=true;error.intent=lifecycle.intent;}throw error;}
}
export function portalCommandContextMap(ids){return Object.fromEntries(ids.map((id,index)=>[id,index===0?['agent-en-desktop','agent-en-tablet','agent-en-mobile']:['agent-en-desktop']]));}
export async function portalCommandPresentation(s,operator){
 const h=await import('./simulation-portal-operator.mjs'),lifecycle={unsettled:false};
 return Object.assign(lifecycle,{operator,contextId:'agent-en-desktop',nativeRead:path=>privateBackendPath(s,path),
  captureBinding:()=>h.capturePortalOperatorEvidence(operator),bindResult:h.bindPortalOperatorResult,currentId:portalTestId,
  close:(ticket,closed)=>closePortalWorkflowTicket(operator,ticket,closed,{checkpoint:s.checkpoint,lifecycle}),
  observeFeedback:async(ticket,article,text)=>observePortalRuleTicket(operator,{ticket,articleId:article.id,marker:text}),
  nativeActor:async()=>{const user=await h.privateNativeRead(s,'user',{userId:String(operator.nativeUserId)});assert.equal(String(user.id),String(operator.nativeUserId));assert.equal(user.active,true);await operator.verify();return user;}});
}

export async function portalSenderContexts(s,group){
 const h=await import('./simulation-portal-operator.mjs'),observers=await import('./simulation-portal-group-observers.mjs');
 const ownerOperator=await preparePortalRuleOperator(s,group),agentOperator=await preparePortalRuleOperator(s,group,'agent');
 return{ownerOperator,agentOperator,captureNativeEvidence:async()=>{const binding=await h.capturePortalOperatorEvidence(agentOperator);return{actorRef:binding.actorRef,tenantRef:binding.tenantRef,actualViewport:binding.viewport,verifiedContext:binding};},
  readNativeTicket:ticketId=>h.privateNativeRead(s,'ticket',{ticketId}),
  observeHistory:async({groupId,messageId})=>{await h.openPortalGroup(agentOperator,{groupId,messageId});await agentOperator.verify();return{id:messageId};},
  observeTicket:(ticket,{articleId,marker})=>observePortalRuleTicket(ownerOperator,{ticket,articleId,marker}),
  observeAttribution:async({fixture:f,record})=>{try{return await observers.observePortalNicknameSurfaces({operator:ownerOperator,groupId:f.groupId,messageId:record.message_id,expected:f.name,marker:f.reference,link:record,checkpoint:s.checkpoint});}finally{await ownerOperator.page.setViewportSize(desktop);}}};
}
export async function bindPortalSenderRows(raw,contexts,ids){
 const h=await import('./simulation-portal-operator.mjs'),owner=await h.capturePortalOperatorEvidence(contexts.ownerOperator),agent=await h.capturePortalOperatorEvidence(contexts.agentOperator);
 assert.equal(raw.length,ids.length+3,'Exact sender union with four history observations required');
 const history=ids.find(id=>id.endsWith('::exclude-retains-history::portal')),rows=[];
 for(const id of ids){const legacy=legacyTestId(id),found=raw.filter(row=>row.testId===legacy);
  if(id!==history){assert.equal(found.length,1);const row=found[0],at=row.at??row.finishedAt;rows.push(h.bindPortalOperatorResult({...row,testId:id,supersedesTestId:legacy,contextId:'tenant_owner-en-desktop',startedAt:row.startedAt??at,finishedAt:row.finishedAt??at},owner));continue;}
  assert.equal(found.length,4);const pairs=new Set(),participants=new Set(),policies=new Set();
  for(const row of found){assert.equal(row.proof.authorizedPortalRead,true);assert(row.proof.portalHistoryId&&row.proof.messageId);assert.equal(row.verifiedContext?.role,'agent');assert.equal(row.actorRef,agent.actorRef);assert.equal(row.tenantRef,agent.tenantRef);assert.deepEqual(row.actualViewport,desktop);participants.add(row.proof.participantSha256);policies.add(row.proof.policy);pairs.add(row.proof.policy+'|'+row.proof.participantSha256);}
  assert.equal(participants.size,2);assert([...participants].every(value=>/^[a-f0-9]{64}$/u.test(value)));assert.equal(pairs.size,4);assert.deepEqual([...policies].sort(),['exclude','rollback']);
  const times=found.map(row=>row.at).sort(),result=found.every(row=>row.result==='passed')?'passed':found.some(row=>row.result==='failed')?'failed':'blocked';
  rows.push(h.bindPortalOperatorResult({testId:id,supersedesTestId:legacy,contextId:'agent-en-desktop',result,startedAt:times[0],finishedAt:times.at(-1),proof:{surface:'portal',observationCount:4,twoDistinctTeamNumbers:true,authorizedPortalRead:true,policies:[...policies],observations:found.map(row=>({at:row.at,result:row.result,proof:row.proof,verifiedContext:row.verifiedContext}))}},agent));
 }
 return rows;
}
