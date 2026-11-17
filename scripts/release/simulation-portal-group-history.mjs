import assert from 'node:assert/strict';
import {createNativeBusinessEmitter} from './simulation-native-business-batch.mjs';
import {openPortalGroup,openPortalTicket,portalOperatorContexts,readPortalOperation,privateNativeRead} from './simulation-portal-operator.mjs';
import {portalGroupRow,portalGroupUrl,portalGroupResult,probePortalGroupMedia,groupOperation,groupInput,sha} from './simulation-portal-groups.mjs';
import {originalHistoryIds,originalPrivacyIds} from './simulation-portal-group-definitions.mjs';

export async function portalHistoryDenied(operator,{groupId,messageId}){
 try{await readPortalOperation(operator,'GROUP_CONTEXT',{group_id:groupId,message_id:messageId});assert.fail('Unauthorized history was returned');}
 catch(error){assert([403,404].includes(error.status),'History denial must be an actual authorization response');return{status:error.status};}
}

export async function collectPortalGroupHistory(s){
 const {operator,groupId,messageId,checkpoint}=s,page=operator.page,emit=createNativeBusinessEmitter(s),results=[];
 const unread=async()=>{const catalog=await readPortalOperation(operator,'GROUP_LIST',{scope:'ALL',selected:groupId}),group=catalog.items.find(row=>row.id===groupId);assert(group);return Number(group.unread_count);};
 const effects=async()=>({links:await s.scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[s.connectionId]),deliveries:await s.scoped('SELECT id,state,attempts FROM delivery_outbox WHERE connection_id=$1 ORDER BY id',[s.connectionId])}),beforeEffects=await effects();
 for(let index=0;index<50;index++)await emit('history-page-'+index,s.participant,'Synthetic history page item '+index);
 const ticket=await privateNativeRead(operator.session,'ticket',{ticketId:s.ticketId});
 for(const context of portalOperatorContexts('agent','en')){
  await page.setViewportSize(context.viewport);const startedAt=new Date().toISOString(),url=portalGroupUrl(s.portalOrigin,groupId);
  const check=async(testId,fn)=>{let result='passed',proof;try{proof=await fn();}catch(error){result='failed';proof={errorClass:error.name,errorSha256:sha(String(error.message))};}
   const row=await portalGroupResult(operator,{testId,result,startedAt,proof});results.push(row);await checkpoint({phase:'portal-history-result',...row});
  };
  await check(originalHistoryIds[0],async()=>{await openPortalGroup(operator,{groupId,messageId});await portalGroupRow(operator,messageId).waitFor();return{messageId,visible:true};});
  await check(originalHistoryIds[2],async()=>{
   await openPortalGroup(operator,{groupId});const older=page.getByRole('button',{name:'Load earlier messages',exact:true});await older.waitFor();const ids=()=>page.locator('.wx-group [data-message-id]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-message-id'))),before=await ids();assert.equal(new Set(before).size,before.length);
   await older.click();await page.waitForFunction(count=>document.querySelectorAll('.wx-group [data-message-id]').length>count,before.length);const after=await ids();assert.equal(new Set(after).size,after.length);assert(before.every(id=>after.includes(id)));assert(after.includes(messageId));return{before,after,noDuplicates:true};
  });
  await check(originalHistoryIds[1],async()=>{
   let until=Date.now()+20000;while(await unread()!==0){assert(Date.now()<until,'Actual read cursor did not clear');await new Promise(resolve=>setTimeout(resolve,100));}
   await openPortalTicket(operator,{ticketNumber:String(ticket.number),reload:true});const initial=await unread(),fresh=await emit('history-unread-'+context.viewport.width,s.participant,'Synthetic unread item '+context.viewport.width),count=await unread();assert.equal(count,initial+1);
   const readProof=await observePortalUnreadWithHeldRead({page,url,groupId,messageId:fresh.id,count,checkpoint});
   until=Date.now()+20000;while(await unread()!==0){assert(Date.now()<until,'Actual unread count did not clear');await new Promise(resolve=>setTimeout(resolve,100));}return{messageId:fresh.id,before:initial,increased:count,after:0,readProof};
  });
  await operator.verify();
 }
 assert.deepEqual(await effects(),beforeEffects,'Nonmatching history ingress must create no ticket or outbound effects');await checkpoint({phase:'portal-history-no-effects',unchanged:true});return results;
}

export async function collectPortalRevokedPrivacy({operator,fixture,checkpoint}){
 const results=[],page=operator.page;
 for(const context of portalOperatorContexts('agent','en')){
  const startedAt=new Date().toISOString();await page.setViewportSize(context.viewport);await page.goto(portalGroupUrl(operator.session.portalOrigin,fixture.groupId));
  const history=await portalHistoryDenied(operator,fixture),media=await probePortalGroupMedia(operator,fixture);assert([403,404].includes(media.status));assert.notEqual(media.sha256,fixture.mediaSha256);
  let result='passed',error;try{assert.equal(await portalGroupRow(operator,fixture.messageId).count(),0);}catch(failure){result='failed';error={errorClass:failure.name,reason:'Revoked message remained visible'};}
  for(const testId of originalPrivacyIds){const row=await portalGroupResult(operator,{testId,result,startedAt,proof:{history,media,error,revokedContentAbsent:result==='passed'}});results.push(row);await checkpoint({phase:'portal-privacy-result',...row});}
 }return results;
}

export async function observePortalUnreadWithHeldRead({page,url,groupId,messageId,count,checkpoint,settlementTimeoutMs=20000}){
 assert(Number.isSafeInteger(settlementTimeoutMs)&&settlementTimeoutMs>0&&settlementTimeoutMs<=20000);
 const requests=[],pending=[];let release,primary,seen;const gate=new Promise(resolve=>{release=resolve;}),firstHeld=new Promise(resolve=>{seen=resolve;});
 const responseResult=page.waitForResponse(response=>requests.includes(response.request()),{timeout:20000}).then(response=>({response}),error=>({error}));
 const handler=route=>{const work=(async()=>{const request=route.request();if(groupOperation(request)!=='GROUP_READ'||groupInput(request).group_id!==groupId)return route.fallback();assert.deepEqual(groupInput(request),{group_id:groupId,message_id:messageId});requests.push(request);seen();await gate;await route.continue();})();pending.push(work.then(()=>({ok:true}),async error=>{await route.abort().catch(()=>{});return{error};}));};
 await page.route('**/api/inbox',handler);let response;
 try{await page.goto(url);await page.locator('.wx-group-choice[aria-current="true"]').getByText(`${count} unread`,{exact:true}).waitFor({timeout:10000});let timer;
  try{await Promise.race([firstHeld,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual portal GROUP_READ missing')),10000);})]);}finally{clearTimeout(timer);}assert(requests.length>=1);await checkpoint({phase:'portal-unread-visible-before-real-read',count,requestBodies:requests.map(groupInput),viewport:page.viewportSize()});
 }catch(error){primary=error;}
 finally{
  release();let timer;const settlement=(async()=>{try{await page.unroute('**/api/inbox',handler);}catch(error){primary??=error;}const completions=await Promise.all(pending);const failed=completions.find(row=>row.error);if(failed)primary??=failed.error;
   const result=await responseResult;if(result.error)primary??=result.error;else{response=result.response;if(!response.ok())primary??=Error('Original read POST failed');try{const failure=await response.finished();if(failure)primary??=failure;}catch(error){primary??=error;}}
  })();try{await Promise.race([settlement,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Original read settlement deadline exceeded')),settlementTimeoutMs);})]);}catch(error){primary??=error;}finally{clearTimeout(timer);}
 }
 if(primary)throw primary;assert(response);return{badgeVisible:true,heldReadCount:requests.length,messageId,responseStatus:response.status(),responseCompleted:true};
}
