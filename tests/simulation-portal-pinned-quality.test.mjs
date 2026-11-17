import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
function functions(file,names,scope={}){const source=readFileSync(new URL('../scripts/release/'+file,import.meta.url),'utf8').replace(/\r\n/gu,'\n').replace(/^import [^\n]*;\n/gmu,'').replace(/^export \{[^\n]*\};\n/gmu,'').replace(/export (async )?(function|const)/gu,'$1$2');return new Function('assert',...Object.keys(scope),source+';return {'+names.join(',')+'};')(assert,...Object.values(scope));}
const contract=functions('simulation-portal-pinned-quality-definitions.mjs',['portalPinnedQualityIds','portalPinnedQualityChecks','portalPinnedQualityDefinitions']);
const {pinnedQualityFixtures}=functions('simulation-portal-pinned-quality.mjs',['pinnedQualityFixtures']);
const {ticketQualityKinds,portalMailReadRequest,portalTicketRead}=functions('simulation-portal-email-quality.mjs',['ticketQualityKinds','portalMailReadRequest','portalTicketRead']);
test('pinned successors preserve eight identities and twenty actual contexts without expanding recovery',()=>{
 assert.equal(contract.portalPinnedQualityIds.length,8);assert.equal(contract.portalPinnedQualityChecks.length,20);assert.equal(new Set(contract.portalPinnedQualityChecks.map(row=>row.testId+'|'+row.contextId)).size,20);
 for(const row of contract.portalPinnedQualityDefinitions){assert.equal(row.id,row.historicalTestId+'::portal');const kind=row.historicalTestId.split('::').at(-1);assert.deepEqual(row.requiredContextIds,['safe-error-recovery','degraded'].includes(kind)?['agent-en-mobile']:['agent-en-desktop','agent-en-mobile','agent-en-tablet']);}
 for(const context of ['desktop','tablet','mobile']){const definitions=contract.portalPinnedQualityDefinitions.filter(row=>row.requiredContextIds.includes('agent-en-'+context)),kinds=ticketQualityKinds(definitions);assert.equal(kinds.size,context==='mobile'?8:6);assert.equal(kinds.has('degraded'),context==='mobile');}
});
function fixture(){return{evidenceMode:'simulated',tenantId:'tenant',namespace:'run',proofs:[{testId:'retained::portal',verifiedContext:{surface:'portal'},proof:{evidenceMode:'simulated',paused:{state:'PAUSED'},proofs:[1,2].map(n=>({ticketNumber:String(100+n),asset:{sha256:String(n).repeat(64)},delivery:{zammad_ticket_id:String(n),flow_version_id:'version-'+n,state:'SENT',attempts:1,external_message_id:'message-'+n},native:{inboundArticleId:10+n}}))}}]};}
test('quality reuses settled current pinned fixtures and rejects foreign, active or collapsed source versions',()=>{
 assert.equal(pinnedQualityFixtures(fixture(),{tenantId:'tenant',namespace:'run'}).length,2);
 for(const mutate of [p=>p.namespace='other',p=>p.tenantId='other',p=>p.proofs[0].testId='historical',p=>p.proofs[0].verifiedContext.surface='native',p=>p.proofs[0].proof.paused.state='ACTIVE',p=>p.proofs[0].proof.proofs[1].delivery.flow_version_id='version-1',p=>p.proofs[0].proof.proofs[1].asset.sha256='1'.repeat(64),p=>p.proofs[0].proof.proofs[0].delivery.state='OUTCOME_UNKNOWN']){const value=fixture();mutate(value);assert.throws(()=>pinnedQualityFixtures(value,{tenantId:'tenant',namespace:'run'}));}
});
test('shared Inbox quality admission rejects missing/duplicate/unknown kinds and keeps exact read-only boundary',()=>{
 assert.throws(()=>ticketQualityKinds([]));assert.throws(()=>ticketQualityKinds([{id:'a',historicalTestId:'a::unknown'}]));assert.throws(()=>ticketQualityKinds([{id:'a',historicalTestId:'a::reload'},{id:'a',historicalTestId:'a::reload'}]));
 const paired=[{id:'a',historicalTestId:'a::reload'},{id:'b',historicalTestId:'b::reload'}];assert.throws(()=>ticketQualityKinds(paired));assert(ticketQualityKinds(paired,2).has('reload'));
 const request=operation=>({url:()=> 'https://portal.test/api/inbox',method:()=> 'POST',postDataJSON:()=>({operation,input:{ticket_id:'42'}})});
 for(const operation of ['REPLY','UPDATE','RECEIPT','GROUP_SEND','CREATE_TICKET'])assert.equal(portalMailReadRequest(request(operation),'https://portal.test'),false);
 assert(portalTicketRead(request('SHOW'),'https://portal.test','42'));assert(!portalTicketRead(request('SHOW'),'https://portal.test','43'));
});
import {createHash} from 'node:crypto';
function runnerFixture({failHook=false}={}){
 let readGuard;const calls=[],checkpoints=[],page={setViewportSize:async value=>calls.push(['viewport',value]),locator:()=>({waitFor:async()=>{}}),route:async(pattern,guard)=>{readGuard=guard;calls.push('route');},unroute:async()=>calls.push('unroute')},operator={role:'agent',page,session:{portalOrigin:'https://portal.test'},verify:async()=>calls.push('verify')};
 const {runPortalTicketQuality}=functions('simulation-portal-email-quality.mjs',['runPortalTicketQuality'],{createHash,openPortalTicket:async()=>calls.push('open'),privateNativeRead:async(s,kind)=>kind==='ticket'?{id:'42',number:'123'}:[{id:'11'},{id:'12'}],capturePortalOperatorEvidence:async()=>({viewport:{width:1440,height:1000}}),bindPortalOperatorResult:(row,binding)=>({...row,verifiedContext:binding}),qualityRequestObservers:()=>({reload:async()=>calls.push('reload'),flush:async()=>{},onRequest:()=>{},finished:()=>{},failed:()=>{}}),reachByTab:async()=>{throw Error('Unselected keyboard quality executed');}});
 page.on=()=>{};page.off=()=>{};
 const invoke=()=>runPortalTicketQuality({operator,ticketId:'42',ticketNumber:'123',articleId:'12',expectedArticleIds:['11','12'],namespace:'run',checkpoint:async row=>checkpoints.push(row),providerRead:async()=>({sent:2}),testDefinitions:[{id:'quality::reload::portal',historicalTestId:'quality::reload'}],context:{contextId:'agent-en-desktop',surface:'portal',viewport:{width:1440,height:1000}},verifyRetainedRender:async({phase})=>{calls.push(phase);await readGuard({request:()=>({url:()=> 'https://portal.test/api/inbox/attachment',method:()=> 'POST',postDataJSON:()=>({ticket_id:'42',article_id:'12',attachment_id:'7'})}),fallback:async()=>calls.push('binary-read-allowed'),abort:async()=>{throw Error('Read guard blocked actual binary endpoint');}});if(failHook&&phase==='reload')throw Error('Retained image differs');return{phase,actualDownload:true};}});
 return{invoke,calls,checkpoints};
}
test('shared runner executes only selected quality, verifies retained render before proof and cleans read guard',async()=>{
 const value=runnerFixture(),result=await value.invoke();assert.equal(result.results.length,1);assert.equal(result.results[0].result,'passed');assert.deepEqual(value.calls.filter(row=>typeof row==='string'&&['open','reload'].includes(row)),['open','open','reload','reload']);assert.equal(result.results[0].proof.retainedRender.phase,'reload');assert.equal(result.results[0].proof.retainedRender.actualDownload,true);assert(value.calls.includes('unroute'));assert.equal(value.calls.filter(row=>row==='binary-read-allowed').length,2);assert(value.checkpoints.some(row=>row.phase==='portal-ticket-quality-safety'&&row.providerUnchanged));
});
test('retained media hook failure remains a failed assertion and never creates substitute effects',async()=>{
 const value=runnerFixture({failHook:true}),result=await value.invoke();assert.equal(result.results[0].result,'failed');assert.equal(result.results[0].proof.errorClass,'Error');assert(value.calls.includes('unroute'));assert.equal(result.noNewProviderEffects,true);
});
test('existing complete email catalog still admits exactly two assertions for each original kind',()=>{
 const {definitions}=functions('simulation-native-email-quality-definitions.mjs',['definitions']);
 const {portalEmailQualityDefinitions}=functions('simulation-portal-email-definitions.mjs',['portalEmailQualityDefinitions'],{historicalQuality:definitions,portalOperatorContexts:role=>[{contextId:role+'-en-desktop'},{contextId:role+'-en-tablet'},{contextId:role+'-en-mobile'}]});
 assert.equal(portalEmailQualityDefinitions.length,16);assert.equal(ticketQualityKinds(portalEmailQualityDefinitions,2).size,8);
});

test('actual binary download endpoint is a closed read allowance and cannot admit upload or mutations',()=>{
 const request=(body,path='/api/inbox/attachment',method='POST',origin='https://portal.test')=>({url:()=>origin+path,method:()=>method,postDataJSON:()=>body}),body={ticket_id:'42',article_id:'12',attachment_id:'7'};
 assert.equal(portalMailReadRequest(request(body),'https://portal.test'),true);
 for(const input of [null,[],{...body,operation:'REPLY'},{...body,attachment_id:'0'},{...body,article_id:'-1'},{...body,ticket_id:{}},{ticket_id:'42',article_id:'12'},{...body,attachment_id:1.1}])assert(!portalMailReadRequest(request(input),'https://portal.test'));
 for(const path of ['/api/inbox/upload','/api/inbox/attachment?operation=UPDATE','/api/inbox/group-attachment','/api/inbox/attachments'])assert(!portalMailReadRequest(request(body,path),'https://portal.test'));
 assert(!portalMailReadRequest(request(body,'/api/inbox/attachment','PUT'),'https://portal.test'));
});
