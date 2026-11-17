import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {actionResponse} from './simulation-native-media-ui.mjs';
import {ensurePortalOperator,readPortalOperation,openPortalGroup,openPortalTicket,capturePortalOperatorEvidence,bindPortalOperatorResult,portalOperatorContexts} from './simulation-portal-operator.mjs';

export const portalSuccessorId=id=>`${id}::portal`;
export const portalGroupRow=(operator,id)=>operator.page.locator(`.wx-group [data-message-id="${id}"]`);
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const groupOperation=request=>{try{return request.method()==='POST'&&new URL(request.url()).pathname==='/api/inbox'?request.postDataJSON()?.operation:null;}catch{return null;}};
export const groupInput=request=>request.postDataJSON().input;
export const portalGroupUrl=(origin,groupId)=>`${origin}/app?view=inbox&workspace=groups&group=${encodeURIComponent(groupId)}`;
export async function portalGroupResult(operator,row){
 const binding=await capturePortalOperatorEvidence(operator),context=portalOperatorContexts(binding.role,binding.locale).find(item=>item.viewport.width===binding.viewport.width&&item.viewport.height===binding.viewport.height);assert(context);
 const finishedAt=row.finishedAt??new Date().toISOString();return bindPortalOperatorResult({...row,startedAt:row.startedAt??finishedAt,finishedAt,contextId:context.contextId,testId:portalSuccessorId(row.testId),supersedesTestId:row.testId,surface:'portal'},binding);
}

// Observe the UI's one original request. This helper cannot manufacture or replay a write.
export async function observePortalAction({operator,operation,action,checkpoint,beforeDispatch=()=>{}}){
 const {page}=operator,origin=new URL(page.url()).origin;let intent,routeError;
 const handler=async route=>{
  const request=route.request();if(new URL(request.url()).origin!==origin||groupOperation(request)!==operation)return route.fallback();
  try{assert(!intent,'Duplicate UI operation blocked');intent=groupInput(request);await checkpoint({phase:'intent',surface:'portal',operation,input:intent});await beforeDispatch(intent);await route.continue();}
  catch(error){routeError=error;await route.abort().catch(()=>{});}
 };
 await page.route('**/api/inbox',handler);
 try{
  const response=await actionResponse(page,response=>new URL(response.url()).origin===origin&&groupOperation(response.request())===operation,action);
  if(routeError)throw routeError;const raw=await response.text();
  await checkpoint({phase:'receipt',surface:'portal',operation,status:response.status(),sha256:sha(raw)});
  if(!response.ok())throw Object.assign(Error('Portal operation failed'),{status:response.status(),intent});
  assert(intent);return{value:JSON.parse(raw),intent,status:response.status()};
 }catch(error){throw Object.assign(routeError??error,{intent});}
 finally{await page.unroute('**/api/inbox',handler);}
}

export function portalGroupCatalogBoundary({origin,mode,onSeen,held}){
 assert(['empty','error','delay'].includes(mode));
 return async route=>{const request=route.request();if(new URL(request.url()).origin!==origin||groupOperation(request)!=='GROUP_LIST')return route.fallback();
  onSeen();if(mode==='delay'){await held;return route.continue();}
  return route.fulfill({status:mode==='error'?503:200,contentType:'application/json',body:JSON.stringify(mode==='error'?{error:'PRIVATE_TEST_SENTINEL'}:{items:[],next_cursor:null})});
 };
}

export async function openPortalGroupConfiguration(s,groupId){
 const owner=await ensurePortalOperator(s,{role:'tenant_owner'}),page=owner.page;
 const request=await import('./seed-simulation-group.mjs');
 const read=request.createSyntheticRequest({page,origin:s.portalOrigin,runId:s.runId??'portal-groups',checkpoint:s.checkpoint});
 const groups=await read('/api/groups');const group=groups.find(row=>String(row.id)===String(groupId));assert(group?.name);
 await page.goto(`${s.portalOrigin}/app?view=groups`);
 await page.getByRole('button',{name:`Configure ${group.name}`,exact:true}).click();
 await page.locator('#group-history-capture').waitFor();return{owner,page,read,group};
}

export async function setPortalHistoryGrant(s,{groupId,nativeUserId,enabled,grantId}){
 const {page,read}=await openPortalGroupConfiguration(s,groupId),path=`/api/group-workspace/groups/${groupId}/grants`;
 const initial=await read(`/api/group-workspace/groups/${groupId}`);
 const catalog=await read('/api/zammad/routing-catalogs'),member=catalog.owners.find(row=>String(row.id)===String(nativeUserId));assert(member?.name,'Projected operator must appear in the current member catalog');
 let response;
 if(enabled){
  assert(!initial.grants.some(row=>row.subject_type==='USER'&&String(row.subject_external_id)===String(nativeUserId)),'Preserve existing member history grant');
  await page.locator('#group-history-subject-type').selectOption('USER');
  await page.locator('#group-history-subject').fill(member.name);
  await page.locator(`#group-history-subject-options-${nativeUserId}`).click();
  response=await actionResponse(page,r=>new URL(r.url()).pathname===path&&r.request().method()==='POST',()=>page.locator('.group-history-access').getByRole('button',{name:'Add access',exact:true}).click());
 }else{
  const owned=initial.grants.find(row=>row.id===grantId);assert(owned&&owned.subject_type==='USER'&&String(owned.subject_external_id)===String(nativeUserId));
  response=await actionResponse(page,r=>new URL(r.url()).pathname===`${path}/${grantId}`&&r.request().method()==='DELETE',()=>page.locator('.group-history-grants').getByRole('button',{name:`Remove: ${member.name}`,exact:true}).click());
 }
 assert(response.ok());const value=await response.json();await s.checkpoint({phase:'portal-history-grant',groupId,nativeUserId,enabled,grantId:value.id??grantId,status:response.status()});return value;
}

export async function findPortalTeamMember(read,{teamId,memberId}){
 let after;const seen=new Set();
 for(let page=0;page<100;page++){
  const detail=await read('TEAM_SHOW',{team_id:String(teamId),...(after?{members_after:after}:{})});assert.equal(detail.id,String(teamId),'Team pagination changed its target');
  const member=detail.members.find(row=>row.id===memberId);if(member||!detail.members_next_cursor)return{detail,member};
  const cursor=detail.members_next_cursor;assert(!seen.has(cursor),'Repeated team-member cursor');seen.add(cursor);after=cursor;
 }
 throw Error('Team-member pagination exceeded its diagnostic bound');
}

export async function openPortalSupportTeam(owner,{nativeGroupId,detail,navigate=true}){
 assert.equal(owner.role,'tenant_owner');assert.match(String(nativeGroupId),/^[1-9][0-9]{0,15}$/u);await owner.verify();
 const s=owner.session,page=owner.page;if(!detail)detail=await readPortalOperation(owner,'TEAM_SHOW',{team_id:String(nativeGroupId)});assert.equal(detail.id,String(nativeGroupId));
 if(navigate)await page.goto(`${s.portalOrigin}/app?view=team`);
 const teams=page.locator('section[aria-labelledby="support-teams-heading"]');
 await teams.locator('nav li').first().waitFor();
 const choice=teams.getByRole('navigation',{name:'Support teams'}).getByRole('button').filter({hasText:detail.name});
 for(let pageIndex=0;await choice.count()===0;pageIndex++){
  assert(pageIndex<100,'Team catalog exceeded its diagnostic bound');const before=await teams.locator('nav li').count();
  const response=await actionResponse(page,r=>groupOperation(r.request())==='TEAM_LIST',()=>teams.getByRole('button',{name:'Load more teams',exact:true}).click());assert(response.ok());await response.finished();
  await page.waitForFunction(count=>document.querySelectorAll('section[aria-labelledby="support-teams-heading"] nav li').length>count,before);
 }
 assert.equal(await choice.count(),1);const opened=await actionResponse(page,r=>groupOperation(r.request())==='TEAM_SHOW'&&groupInput(r.request()).team_id===String(nativeGroupId),()=>choice.click());assert(opened.ok());const initialMembers=await opened.json();assert.equal(initialMembers.id,String(nativeGroupId));
 return{teams,detail:initialMembers};
}

export async function ensurePortalTeamGrant(s,{operator,nativeGroupId,access=['full']}){
 assert(operator?.userId&&operator.nativeUserId);assert.equal(operator.session.tenantId,s.tenantId);assert.match(String(nativeGroupId),/^[1-9][0-9]{0,15}$/u);assert.deepEqual(access,['full']);await operator.verify();
 const owner=await ensurePortalOperator(s,{role:'tenant_owner'}),page=owner.page;
 const read=(operation,input)=>readPortalOperation(owner,operation,input),{detail,member}=await findPortalTeamMember(read,{teamId:nativeGroupId,memberId:operator.userId});
 assert(member?.editable,'Exact accepted projected operator is required for team access');
 if(member.effective_access.includes('full'))return{surface:'portal',unchanged:true,teamId:String(nativeGroupId),memberId:operator.userId};
 assert(detail.can_grant);const{teams,detail:initialMembers}=await openPortalSupportTeam(owner,{nativeGroupId,detail});
 const form=teams.locator('form').filter({has:page.getByText(member.email,{exact:true})});
 if(initialMembers.members.some(row=>row.id===operator.userId))await form.waitFor();
 for(let pageIndex=0;await form.count()===0;pageIndex++){
  assert(pageIndex<100,'Team member view exceeded its diagnostic bound');
  const response=await actionResponse(page,r=>groupOperation(r.request())==='TEAM_SHOW',()=>teams.getByRole('button',{name:'Load more members',exact:true}).click());assert(response.ok());
  const next=await response.json();if(next.members.some(row=>row.id===operator.userId)){await form.waitFor();break;}
 }
 assert.equal(await form.count(),1);
 await form.getByRole('checkbox',{name:'Full access',exact:true}).check();
 const result=await observePortalAction({operator:owner,operation:'TEAM_GRANT_SAVE',action:()=>form.getByRole('button',{name:'Save access',exact:true}).click(),checkpoint:s.checkpoint});
 assert.equal(result.intent.team_id,String(nativeGroupId));assert.equal(result.intent.member_id,operator.userId);assert.deepEqual(result.intent.access,['full']);
 const receipt=await readPortalOperation(owner,'TEAM_RECEIPT',{operation_id:result.intent.operation_id,kind:'TEAM_GRANT_SAVE',team_id:String(nativeGroupId),member_id:operator.userId,cancel_if_missing:false});
 for(const value of[result.value,receipt]){assert.equal(value.state,'APPLIED');assert.equal(value.team_id,String(nativeGroupId));assert.equal(value.member_id,operator.userId);}
 const {member:granted}=await findPortalTeamMember(read,{teamId:nativeGroupId,memberId:operator.userId});
 assert(granted?.direct_access.includes('full'));await operator.verify();return{surface:'portal',teamId:String(nativeGroupId),memberId:operator.userId,operationId:result.intent.operation_id};
}

// Fixed owner reads for the separately reviewed machine grant. No enrollment or grant is implied.
export async function readPortalServiceAccess(owner,{nativeGroupId}){
 assert.equal(owner.role,'tenant_owner');assert.match(String(nativeGroupId),/^[1-9][0-9]{0,15}$/u);
 const request=createSyntheticRequest({page:owner.page,origin:owner.session.portalOrigin,runId:owner.session.runId,checkpoint:owner.session.checkpoint});
 let after,version;const seen=new Set();
 for(let page=0;page<100;page++){
  const status=await request('/api/inbox','POST',{operation:'IDENTITY_STATUS',input:after?{teams_after:after}:{}});
  assert(status.portal_ready===true&&status.access_required===false&&['BOUND','COMPLETE'].includes(status.phase),'Service access requires explicit owner setup first');
  assert.match(status.status_version,/^[a-f0-9]{64}$/u);assert(Array.isArray(status.groups));if(version)assert.equal(status.status_version,version,'Service access changed during pagination');version=status.status_version;
  const team=status.groups.find(row=>row.id===String(nativeGroupId));if(team){assert(team.active===true);assert.match(team.version,/^[a-f0-9]{64}$/u);return{status,team};}
  assert(status.groups_next_cursor&&!seen.has(status.groups_next_cursor),'Exact fixture service team unavailable');seen.add(status.groups_next_cursor);after=status.groups_next_cursor;
 }
 throw Error('Service team pagination exceeded its diagnostic bound');
}

// Bring the exact selected team into ServiceAccess's own paginated state.
export async function revealPortalServiceTeam(owner,{team,statusVersion}){
 const page=owner.page,panel=page.locator('section[aria-labelledby="service-access-title"]');await panel.waitFor({state:'visible'});
 await panel.getByRole('status').filter({hasText:'WasalX access is ready'}).waitFor({state:'visible'});
 const label=panel.getByText(team.name,{exact:true}),seen=new Set();
 for(let index=0;await label.count()===0;index++){
  assert(index<100,'Rendered service team pagination exceeded its bound');const more=panel.getByRole('button',{name:'Load more team access',exact:true});assert.equal(await more.count(),1,'Exact selected service team is not rendered');
  const response=await actionResponse(page,r=>groupOperation(r.request())==='IDENTITY_STATUS'&&typeof groupInput(r.request()).teams_after==='string',()=>more.click());assert(response.ok());
  const input=groupInput(response.request());assert(!seen.has(input.teams_after),'Rendered service cursor repeated');seen.add(input.teams_after);const next=await response.json();assert.equal(next.status_version,statusVersion,'Rendered service access changed during pagination');const loaded=next.groups.find(row=>row.id===team.id);if(loaded){assert.equal(loaded.version,team.version,'Rendered service team changed');await label.waitFor({state:'visible'});}
 }
 assert.equal(await label.count(),1);return panel;
}

export async function ensurePortalMachineGrant(s,{owner,nativeGroupId}){
 assert.equal(owner.session,s);await owner.verify();await s.ensurePrivilegedOwner();
 const before=await readPortalServiceAccess(owner,{nativeGroupId});await openPortalSupportTeam(owner,{nativeGroupId});
 const panel=await revealPortalServiceTeam(owner,{team:before.team,statusVersion:before.status.status_version});
 if(before.team.enabled===true){await panel.getByText('Automation access enabled for this team',{exact:true}).waitFor({state:'visible'});return{surface:'portal',teamId:String(nativeGroupId),enabled:true,unchanged:true,statusVersion:before.status.status_version};}
 assert.equal(before.team.enabled,false);
 await panel.getByRole('button',{name:'Review automation access',exact:true}).click();
 const dialog=owner.page.getByRole('dialog');await dialog.waitFor({state:'visible'});
 await dialog.getByRole('checkbox',{name:'Allow full team access for WasalX automations',exact:true}).check();
 await dialog.getByRole('checkbox',{name:'I reviewed this change and approve it as the workspace owner.',exact:true}).check();
 const result=await observePortalAction({operator:owner,operation:'IDENTITY_GRANT',checkpoint:s.checkpoint,
  action:()=>dialog.getByRole('button',{name:'Apply reviewed change',exact:true}).click(),beforeDispatch:async input=>{
   assert.deepEqual(Object.keys(input).sort(),['enabled','expected_version','request_id','team_id']);assert.equal(input.team_id,String(nativeGroupId));assert.equal(input.enabled,true);assert.equal(input.expected_version,before.team.version);assert.match(input.request_id,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);
  }});
 const request=createSyntheticRequest({page:owner.page,origin:s.portalOrigin,runId:s.runId,checkpoint:s.checkpoint});
 const receipt=await request('/api/inbox','POST',{operation:'IDENTITY_RECEIPT',input:{request_id:result.intent.request_id,kind:'IDENTITY_GRANT',team_id:String(nativeGroupId),action:'LOOKUP'}});
 for(const value of[result.value,receipt])assert(value.state==='APPLIED'&&value.terminal===true,'Machine grant outcome requires original receipt reconciliation; never resubmit');
 const after=await readPortalServiceAccess(owner,{nativeGroupId});assert.equal(after.team.enabled,true);assert.notEqual(after.team.version,before.team.version);
 const refreshed=await actionResponse(owner.page,r=>groupOperation(r.request())==='IDENTITY_STATUS'&&!groupInput(r.request()).teams_after,()=>panel.getByRole('button',{name:'Reload',exact:true}).click());assert(refreshed.ok());assert.equal((await refreshed.json()).status_version,after.status.status_version);
 await revealPortalServiceTeam(owner,{team:after.team,statusVersion:after.status.status_version});
 await panel.getByText('Automation access enabled for this team',{exact:true}).waitFor({state:'visible'});await owner.verify();
 return{surface:'portal',teamId:String(nativeGroupId),enabled:true,requestId:result.intent.request_id,kind:'IDENTITY_GRANT',state:'APPLIED',terminal:true,statusVersion:after.status.status_version};
}

export async function findPortalSupportTeam(read,{name}){
 assert(typeof name==='string'&&name.length>0&&name.length<=160);let before;const matches=[],seen=new Set();
 for(let page=0;page<100;page++){
  const result=await read('TEAM_LIST',{limit:100,...(before?{before}:{})});assert(Array.isArray(result.items));matches.push(...result.items.filter(row=>row.name===name&&row.active===true));
  if(!result.next_cursor){assert.equal(matches.length,1,'Exact declared fixture team must be uniquely active');assert.match(matches[0].id,/^[1-9][0-9]{0,15}$/u);return matches[0];}
  assert(!seen.has(result.next_cursor),'Fixture team cursor repeated');seen.add(result.next_cursor);before=result.next_cursor;
 }
 throw Error('Fixture team catalog exceeded its bound');
}

export function assertPortalFixtureMachineTarget(s,{namespace,access,nativeGroupId}){
 assert.match(String(nativeGroupId),/^[1-9][0-9]{0,15}$/u);assert.equal(access?.surface,'portal');assert.equal(access.namespace,namespace);assert.equal(access.tenantId,s.tenantId);assert.equal(String(access.nativeGroupId),String(nativeGroupId),'Declared native destination differs from the owner-granted fixture team');
 const grant=access.machineGrant;assert(grant?.surface==='portal'&&grant.enabled===true&&grant.teamId===String(nativeGroupId),'Explicit fixture machine grant required');
 assert(grant.unchanged===true||grant.kind==='IDENTITY_GRANT'&&grant.state==='APPLIED'&&grant.terminal===true&&typeof grant.requestId==='string','Original machine grant receipt or unchanged readback required');return access;
}

export async function portalTeamGrantStage(s,{namespace,inputs}){
 const group=inputs.groupPreparation;assert(group?.preparationOnly===true);assert.equal(group.namespace,namespace);assert.equal(group.tenantId,s.tenantId);assert.equal(group.nativeGroupName,'Operations');
 assert.equal(inputs.secondActor.userId,s.capabilities.secondActor.userId);assert.equal(inputs.secondActor.tenantId,s.tenantId);
 assert(inputs.nativeAccountAccess&&inputs.teamAccess,'Current linking/READY and Team role receipts must precede grants');
 const owner=await ensurePortalOperator(s,{role:'tenant_owner'}),agent=await ensurePortalOperator(s,{role:'agent'});
 const ownerBinding=await owner.verify(),agentBinding=await agent.verify();assert.notEqual(owner.userId,agent.userId);
 const target=await findPortalSupportTeam((operation,input)=>readPortalOperation(owner,operation,input),{name:group.nativeGroupName});
 const grants=[];for(const operator of [owner,agent])grants.push(await ensurePortalTeamGrant(s,{operator,nativeGroupId:target.id}));
 const machineGrant=await ensurePortalMachineGrant(s,{owner,nativeGroupId:target.id});
 return{evidenceMode:'simulated',surface:'portal',namespace,tenantId:s.tenantId,nativeGroupId:String(target.id),grants,machineGrant,owner:ownerBinding,agent:agentBinding};
}

export async function updatePortalTicketState(operator,{ticketId,ticketNumber,stateId,checkpoint,beforeDispatch=()=>{}}){
 for(const value of[ticketId,ticketNumber,stateId])assert.match(String(value),/^[1-9][0-9]{0,15}$/u);
 const opened=await openPortalTicket(operator,{ticketNumber,reload:true});assert.equal(opened.renderedTicketId,String(ticketId),'Opened ticket differs from the owned update target');
 const checkIntent=input=>{assert.equal(input.ticket_id,String(ticketId),'Update intent targets another ticket');assert.equal(String(input.state_id),String(stateId));assert.match(input.operation_id??'',/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);};
 await operator.page.locator('#inbox-state').selectOption(String(stateId));
 const result=await observePortalAction({operator,operation:'UPDATE',action:()=>operator.page.locator('form').filter({has:operator.page.locator('#inbox-state')}).getByRole('button',{name:'Save changes',exact:true}).click(),checkpoint,beforeDispatch:async input=>{checkIntent(input);await beforeDispatch(input);}});
 try{checkIntent(result.intent);assert.equal(result.value?.state,'APPLIED','Update receipt is not applied');assert.equal(result.value.operation_id,result.intent.operation_id,'Update receipt operation differs');assert.equal(result.value.ticket_id,result.intent.ticket_id,'Update receipt ticket differs');await operator.page.getByRole('status').filter({hasText:'Saved. Delivery continues in the background.'}).waitFor({state:'visible'});return result;}
 catch(error){throw Object.assign(error,{intent:result.intent,status:result.status});}
}

export async function loadPortalGroupMedia(operator,{groupId,messageId}){
 await openPortalGroup(operator,{groupId,messageId});const row=portalGroupRow(operator,messageId);
 const response=await actionResponse(operator.page,r=>new URL(r.url()).pathname==='/api/inbox/group-media'&&r.request().method()==='POST',()=>row.getByRole('button',{name:/^Load /}).click());
 assert(response.ok());const bytes=await response.body();assert(bytes.length>0);return{bytes:bytes.length,sha256:sha(bytes),mime:response.headers()['content-type']};
}

// Closed read-only binary boundary. CSRF and server props never leave browser memory.
export async function probePortalGroupMedia(operator,{groupId,messageId}){
 await operator.verify();return operator.page.evaluate(async({origin,groupId,messageId})=>{
  if(location.origin!==origin)throw Error('Portal origin changed');
  const response=await fetch('/app',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok||new URL(response.url).pathname!=='/app')throw Error('Authenticated portal page unavailable');
  const doc=new DOMParser().parseFromString(await response.text(),'text/html'),prefix='((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}).rsc.push(';
  const chunks=[...doc.scripts].map(script=>script.textContent).filter(text=>text.startsWith(prefix)).map(text=>JSON.parse(text.slice(prefix.length,-1)));
  const parts=chunks.map(chunk=>typeof chunk==='string'?new TextEncoder().encode(chunk):Array.isArray(chunk)&&chunk[0]===3?Uint8Array.from(atob(chunk[1]),char=>char.charCodeAt(0)):(()=>{throw Error('Unsupported server chunk');})());
  const bytes=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  const values=[...new TextDecoder('utf-8',{fatal:true}).decode(bytes).matchAll(/"csrfToken":"([^"\\]+)"/g)].map(match=>match[1]),unique=[...new Set(values)];if(unique.length!==1)throw Error('Authenticated portal CSRF unavailable');
  const media=await fetch('/api/inbox/group-media',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-wasalx-csrf':unique[0]},body:JSON.stringify({group_id:groupId,message_id:messageId}),signal:AbortSignal.timeout(15000)});
  const body=await media.arrayBuffer();if(body.byteLength>16*1024*1024)throw Error('Synthetic media response exceeds fixture bound');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),value=>value.toString(16).padStart(2,'0')).join('');return{status:media.status,bytes:body.byteLength,sha256};
 },{origin:operator.session.portalOrigin,groupId,messageId});
}
