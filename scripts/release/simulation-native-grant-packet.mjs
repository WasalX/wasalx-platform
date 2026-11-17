import assert from'node:assert/strict';import{createHash}from'node:crypto';import{createSyntheticRequest}from'./seed-simulation-group.mjs';
export async function runNativeGrantPacket({ownerPage,nativePage,origin,runId,fixture,checkpoint,admitFixture,readGrants,assertNativeHistoryUi,assertNativeTicketUi,expectedActorId,collectGrantedQuality,collectGrantedHistory,collectDeniedPrivacy}){
  await admitFixture(fixture); // Actual instance/tenant, capture consent epoch, retained media hash and Operations ticket.
  const user=await nativePage.evaluate(async()=>{const r=await fetch('/api/v1/users/me');if(!r.ok)throw Error('Native actor unavailable');const u=await r.json();return{id:u.id,roleIds:u.role_ids};});
  assert.equal(user.id,expectedActorId);assert(user.roleIds.includes(2)&&!user.roleIds.includes(1));
  const original=await readGrants(fixture.groupId);
  assert.equal(original.length,0,'Native grant fixture must start without grants; preserve existing grants');
  const req=createSyntheticRequest({page:ownerPage,origin,runId,checkpoint});
  const base='/api/v1/wasalx/group_workspace/groups/'+fixture.groupId+'/messages/'+fixture.messageId;
  const read=path=>nativePage.evaluate(async path=>{const r=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(15000)});const bytes=new Uint8Array(await r.arrayBuffer());const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');return{status:r.status,sha256:hash};},path);
  const denied=async()=>{const r=await read(base+'/context');assert([403,404].includes(r.status));return r;};
  const ticket=async()=>{const r=await read('/api/v1/tickets/'+fixture.ticketId);assert.equal(r.status,200);try{await assertNativeTicketUi(nativePage,fixture.ticketId);return{status:200,uiMatched:true};}catch(e){return{status:200,uiMatched:false,error:{errorClass:e.name,reason:'Native ticket UI assertion failed'}};}};
  const proofs=[];let quality,historyResults=[],privacyResults=[],authorizedHistoryBlocker;const failed=e=>({errorClass:e.name,errorSha256:createHash('sha256').update(String(e.message)).digest('hex')});await checkpoint({phase:'initial-configuration',step:'native-grants',groupId:fixture.groupId,grants:original});
  proofs.push({step:'without-grant',history:await denied(),ticket:await ticket()});
  await checkpoint({phase:'proof',step:'without-grant',...proofs.at(-1),viewport:nativePage.viewportSize(),nativeActorId:expectedActorId});
  let grant,cleanupError;try{
    grant=await req('/api/group-workspace/groups/'+fixture.groupId+'/grants','POST',{subjectType:'USER',subjectExternalId:expectedActorId},'native-user-grant');assert(grant.id);const rows=await readGrants(fixture.groupId);assert.equal(rows.length,original.length+1);assert(rows.some(g=>g.id===grant.id&&g.subject_type==='USER'&&Number(g.subject_external_id)===expectedActorId));
    await nativePage.reload({waitUntil:'domcontentloaded'});let history,historyPassed=true,media,mediaPassed=true,uiMatched=true,error;try{history=await read(base+'/context');assert.equal(history.status,200);}catch(e){historyPassed=false;history={...history,...failed(e)};authorizedHistoryBlocker=failed(e);}await checkpoint({phase:'proof',step:'authorized-history',...history,result:historyPassed?'passed':'failed'});
    try{media=await read(base+'/media');assert.equal(media.status,200);assert.equal(media.sha256,fixture.mediaSha256);}catch(e){mediaPassed=false;media={...media,...failed(e)};}await checkpoint({phase:'proof',step:'authorized-media',...media,result:mediaPassed?'passed':'failed'});
    try{await assertNativeHistoryUi(nativePage,fixture);}catch(e){uiMatched=false;error={...failed(e),reason:'Native granted-history UI assertion failed'};}const current=await nativePage.evaluate(async()=>{const r=await fetch('/api/v1/users/me');if(!r.ok)throw Error('Native actor unavailable');const u=await r.json();return{id:u.id,roleIds:u.role_ids};});assert.deepEqual(current,user);
    proofs.push({step:'exact-grant',history,historyPassed,media,mediaPassed,uiMatched,error});await checkpoint({phase:'proof',...proofs.at(-1),viewport:nativePage.viewportSize(),nativeActorId:expectedActorId});
    if(historyPassed&&collectGrantedHistory)historyResults=await collectGrantedHistory(fixture);if(historyPassed&&collectGrantedQuality)quality=await collectGrantedQuality(fixture);
  }finally{if(grant?.id){try{await req('/api/group-workspace/groups/'+fixture.groupId+'/grants/'+grant.id,'DELETE',undefined,'native-user-revoke');assert.deepEqual(await readGrants(fixture.groupId),original);}catch(error){await checkpoint({phase:'cleanup-failure',step:'native-user-revoke',grantId:grant.id});cleanupError=error;}}}
  if(cleanupError)throw cleanupError;
  await nativePage.reload({waitUntil:'domcontentloaded'});const history=await denied(),media=await read(base+'/media');assert([403,404].includes(media.status));assert.notEqual(media.sha256,fixture.mediaSha256);
  proofs.push({step:'revoked',history,media,ticket:await ticket()});await checkpoint({phase:'proof',step:'native-grant-boundaries',proofs,restored:true});
  if(collectDeniedPrivacy)privacyResults=await collectDeniedPrivacy(fixture);
  return{evidenceMode:'simulated',quality,historyResults,privacyResults,proofs,authorizedHistoryBlocker,restored:true,nativeActorId:expectedActorId,viewport:nativePage.viewportSize()};
}
