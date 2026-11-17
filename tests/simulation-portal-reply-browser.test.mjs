import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
const source=readFileSync(new URL('../scripts/release/simulation-portal-reply-browser.mjs',import.meta.url),'utf8');
const load=(openPortalTicket=async()=>({renderedTicketId:'42'}),moduleSource=source)=>new Function('assert','createHash','openPortalTicket',moduleSource.replace(/^import [^\r\n]*;\r?\n/gmu,'').replace('export async function','async function')+';return submitPortalReply;')(assert,createHash,openPortalTicket);
function fixture({unknown=false,double=false,wrong=false,denyIdentityAfter=false,prefix='',wrongTicket=false,staleRevision=false,resultChange={}}={}){
 const page=new EventEmitter(),events=[],body='Synthetic private reply canary',operationId='10000000-0000-4000-8000-000000000001';let resolveResponse,verifications=0,clicks=0;
 const request={url:()=> 'https://portal.test/api/inbox',method:()=> 'POST',postDataJSON:()=>({operation:'REPLY',input:{operation_id:operationId,ticket_id:wrongTicket?'77':'42',expected_updated_at:staleRevision?'stale':'revision',body,internal:false}})};
 Object.assign(page,{route:async(_,handler)=>{page.handler=handler;},unroute:async()=>{page.handler=null;events.push(['unroute']);},locator:selector=>({selectOption:async value=>events.push(['select',selector,value]),fill:async value=>events.push(['fill',selector,value]),getByText:()=>({waitFor:async()=>events.push(['preview-visible'])})}),getByRole:(role,{name})=>({count:async()=>1,isEnabled:async()=>true,click:async()=>{events.push(['click',name]);if(name==='Preview reply'){const previewRequest={...request,postDataJSON:()=>({operation:'PREVIEW',input:{ticket_id:'42',body,internal:false,expected_updated_at:'revision'}})};resolveResponse({url:()=> 'https://portal.test/api/inbox',request:()=>previewRequest,ok:()=>true,json:async()=>({can_send:true,text:prefix+body,ticket_updated_at:'revision',draft_sha256:'a'.repeat(64)})});return;}clicks++;
 const dispatch=()=>page.handler({request:()=>request,fallback:async()=>{throw Error('Unexpected reply fallback');},abort:async()=>events.push(['abort']),continue:async()=>{events.push(['continue']);page.emit('response',{request:()=>request,ok:()=>!unknown,json:async()=>({state:'APPLIED',operation_id:wrong?'wrong':operationId,ticket_id:'42',article_id:'60',...resultChange})});}});await dispatch();if(double)await dispatch();}}),waitForResponse:predicate=>new Promise(resolve=>{resolveResponse=value=>{assert(predicate(value));resolve(value);};})});
 const operator={session:{portalOrigin:'https://portal.test'},page,verify:async()=>{verifications++;events.push(['verify']);if(denyIdentityAfter&&verifications===3)throw Error('identity changed');return{};}};
 const checkpoint=async value=>events.push(['checkpoint',value]);
 return{operator,body,operationId,events,checkpoint,clicks:()=>clicks};
}
test('actual composer helper previews and submits exactly once with identity and receipt binding',async()=>{
 const f=fixture(),submit=load(async()=>{f.events.push(['open']);return{renderedTicketId:'42'};});
 const result=await submit(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint});
 assert.deepEqual(result,{state:'APPLIED',operationId:f.operationId,ticketId:'42',articleId:'60'});assert.equal(f.clicks(),1);
 assert(f.events.findIndex(row=>row[0]==='checkpoint'&&row[1].phase==='intent')<f.events.findIndex(row=>row[0]==='click'&&row[1]==='Send reply'));
 assert.equal(f.events.filter(row=>row[0]==='verify').length,3);assert.equal(f.operator.page.listenerCount('request'),0);
 const records=f.events.filter(row=>row[0]==='checkpoint').map(row=>row[1]);assert(!JSON.stringify(records).includes(f.body));assert.equal(records.at(-1).operationId,f.operationId);
});
test('unknown response preserves operation identity without reclick or receipt lookup mutation',async()=>{
 for(const options of[{unknown:true},{wrong:true}]){const f=fixture(options),result=await load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint});assert.deepEqual(result,{state:'UNKNOWN',operationId:f.operationId});assert.equal(f.clicks(),1);assert.equal(f.operator.page.listenerCount('request'),0);}
});
test('duplicate request or changed actor invalidates proof and never resends',async()=>{
 for(const options of[{double:true},{denyIdentityAfter:true},{wrongTicket:true},{staleRevision:true}]){const f=fixture(options);await assert.rejects(load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint}));assert.equal(f.clicks(),1);assert.equal(f.operator.page.listenerCount('request'),0);}
});

test('prepared WhatsApp identity prefix is verified as the exact visible preview text',async()=>{
 const f=fixture({prefix:'Agent Name\n'}),result=await load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint});
 assert.equal(result.state,'APPLIED');assert.equal(f.clicks(),1);assert(f.events.some(row=>row[0]==='preview-visible'));
});

test('post-dispatch identity failure still checkpoints every observed operation UUID',async()=>{
 const f=fixture({denyIdentityAfter:true});await assert.rejects(load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint}));
 const submitted=f.events.find(row=>row[0]==='checkpoint'&&row[1].phase==='submitted')?.[1];assert.equal(submitted?.operationId,f.operationId);assert.deepEqual(submitted.operationIds,[f.operationId]);assert.equal(submitted.requestCount,1);
});

test('unit loader accepts both repository LF and Windows CRLF import headers',async()=>{
 const lf=source.replace(/\r\n/gu,'\n');
 for(const moduleSource of[lf,lf.replace(/\n/gu,'\r\n')]){const f=fixture();const submit=load(async()=>({renderedTicketId:'42'}),moduleSource);assert.equal((await submit(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint})).state,'APPLIED');assert.equal(f.clicks(),1);}
});

test('reply awaits exact durable original intent before allowing the UI request to continue',{timeout:1000},async t=>{
 const f=fixture({prefix:'Agent Name\n'}),submit=load();let release,entered;const held=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
 t.after(()=>release());const pending=submit(f.operator,{ticketId:'42',ticketNumber:'1042',body:f.body,expectedPreviewText:'Agent Name\n'+f.body,checkpoint:f.checkpoint,beforeDispatch:async input=>{assert.equal(input.operation_id,f.operationId);assert.equal(input.ticket_id,'42');assert.equal(input.body,f.body);assert.equal(input.expected_updated_at,'revision');entered();await held;f.events.push(['durable']);}});
 await waiting;assert.equal(f.events.filter(row=>row[0]==='continue').length,0);release();const result=await pending;assert.equal(result.state,'APPLIED');assert.equal(f.events.filter(row=>row[0]==='continue').length,1);assert(f.events.findIndex(row=>row[0]==='durable')<f.events.findIndex(row=>row[0]==='continue'));assert.equal(f.operator.page.handler,null);
});

test('failed durable original-intent claim aborts before dispatch and preserves UUID without resending',async()=>{
 const f=fixture();await assert.rejects(load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint,beforeDispatch:async()=>{throw Error('Owned claim exists');}}),error=>error.operationId===f.operationId&&error.message==='Owned claim exists');
 assert.equal(f.clicks(),1);assert.equal(f.events.filter(row=>row[0]==='continue').length,0);assert.equal(f.events.filter(row=>row[0]==='abort').length,1);assert.equal(f.operator.page.handler,null);assert.equal(f.events.find(row=>row[0]==='checkpoint'&&row[1].phase==='submitted')[1].operationId,f.operationId);
});

test('owned reply ticket and exact prepared wire mismatch prevent the submit click',async()=>{
 for(const options of[{ticketId:'77'},{expectedPreviewText:'Unrelated prefix\n'}]){const f=fixture({prefix:'Agent Name\n'});await assert.rejects(load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint,...options}));assert.equal(f.clicks(),0);assert.equal(f.events.filter(row=>row[0]==='continue').length,0);}
});

test('foreign ticket or missing article acknowledgement stays UNKNOWN after the one original UI reply',async()=>{
 for(const resultChange of[{ticket_id:'77'},{article_id:null},{state:'UNKNOWN'}]){const f=fixture({resultChange}),result=await load()(f.operator,{ticketNumber:'1042',body:f.body,checkpoint:f.checkpoint});assert.deepEqual(result,{state:'UNKNOWN',operationId:f.operationId});assert.equal(f.clicks(),1);assert.equal(f.events.filter(row=>row[0]==='continue').length,1);assert.equal(f.operator.page.handler,null);}
});
