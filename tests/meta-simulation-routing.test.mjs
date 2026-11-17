import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMetaSimulation} from '../scripts/contracts/meta-simulation-server.mjs';
const posix={skip:process.platform==='win32'?'POSIX private persistence and trusted TLS required':false};
const helpers=process.platform==='win32'?null:await import('./helpers/meta-simulation-fixture.mjs');
const tls=helpers?await helpers.testTls():{};
async function fixture(t,routingFixture={roles:['customer_service','escalation'],targets:['ai_agent']},registeredAccess=false){
 const dir=mkdtempSync(join(tmpdir(),'meta-routing-'));chmodSync(dir,0o700);
 const options={token:'synthetic-routing-private-token',phoneId:'10001',phone:'12025550103',wabaId:'20001',version:'v24.0',recipients:['12025550106','SA.Synthetic01'],
  ...tls,stateFile:join(dir,'state.json'),routingFixture,...(registeredAccess?{appId:'30001',appSecret:'synthetic-routing-app-secret',
   signupFixture:{businessId:'40001',userId:'50001',reauthorizationToken:'synthetic-routing-reauthorization-token'}}:{})};
 const {Agent,getGlobalDispatcher,setGlobalDispatcher}=await import(helpers.undiciUrl),previous=getGlobalDispatcher();
 const agent=new Agent({connect:{ca:tls.ca,lookup:(host,opts,callback)=>{assert.equal(host,'graph.facebook.com');callback(null,opts.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);}}});
 setGlobalDispatcher(agent);let server=createMetaSimulation(options);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='https://graph.facebook.com:'+server.address().port;
 const {HttpMetaGroupsClient}=await import('../services/control-api/dist/meta-groups.client.js');
 const client=new HttpMetaGroupsClient(new URL(origin),'v24.0',options.token,options.phoneId);
 t.after(async()=>{setGlobalDispatcher(previous);await agent.close();if(server.listening)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
 const raw=(body,{path='/v24.0/10001/thread_control',method='POST',token=options.token}={})=>fetch(origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
 return{options,client,raw,state:()=>server.routingState(),arm:spec=>server.armRoutingFault(spec),restart:async()=>{await new Promise(resolve=>server.close(resolve));server=createMetaSimulation(options);return server.routingState();}};
}
test('actual thread-control client reaches strict TLS route; takes, passes, releases and preserves receipts',posix,async t=>{
 const f=await fixture(t),peer={kind:'PHONE',value:'12025550106'},post=(action,target)=>f.client.threadControl(action,target,peer,randomUUID());
 await post('release');assert.equal(f.state().owners[peer.value],'IDLE');
 await assert.rejects(post('pass','ai_agent'),error=>error.outcomeKnown===true);
 await post('take');await post('pass','ai_agent');assert.equal(f.state().owners[peer.value],'STANDBY');
 await post('take');assert.equal(f.state().owners[peer.value],'OWN');
 const bsuid=await f.client.threadControl('release',undefined,{kind:'BSUID',value:'SA.Synthetic01'},randomUUID());assert.match(bsuid.requestId,/^SIMTHREAD-/u);
 const before=f.state();assert.equal(before.receipts.length,5);assert.equal(before.attempts.length,6);
 assert.deepEqual(await f.restart(),before,'restart preserves original outcomes instead of resetting authority');
 assert.throws(()=>createMetaSimulation({...f.options,routingFixture:{roles:['customer_service'],targets:[]}}),'changed fixture cannot consume retained routing state');
 const bytes=readFileSync(f.options.stateFile),state=JSON.parse(bytes);state.threadControl.receipts[0].bodySha256='0'.repeat(64);writeFileSync(f.options.stateFile,JSON.stringify(state));
 assert.throws(()=>createMetaSimulation(f.options),'tampered receipt cannot become valid evidence');writeFileSync(f.options.stateFile,bytes);
});
test('unsupported identity, action, shape, token and asset never mutate thread state',posix,async t=>{
 const f=await fixture(t),body={messaging_product:'whatsapp',action:'release',to:'12025550106',metadata:randomUUID()},before=f.state();
 for(const bad of [{...body,recipient:'SA.Synthetic01'},{...body,to:undefined},{...body,to:'12025550111'},{...body,action:'resume'},
  {...body,control_pass:{target_role:'ai_agent'}},{...body,extra:true},{...body,metadata:'x'.repeat(2001)}])assert.equal((await f.raw(bad)).status,400);
 assert.equal((await f.raw(body,{token:'synthetic-wrong-token'})).status,401);
 assert.equal((await f.raw(body,{path:'/v24.0/99999/thread_control'})).status,404);
 assert.equal((await f.raw(undefined,{method:'GET'})).status,404,'no invented public ownership/readback API');
 assert.deepEqual(f.state(),before);
 assert.equal((await f.raw({...body,metadata:'x'.repeat(2000)})).status,200,'documented metadata bound is supported');
});
test('configured role restrictions and finite faults distinguish known reject from irreversible unknown',posix,async t=>{
 const f=await fixture(t),peer={kind:'PHONE',value:'12025550106'},post=()=>f.client.threadControl('release',undefined,peer,randomUUID());
 const before=f.state();f.arm({id:'known',recipient:peer.value,action:'release',mode:'reject'});
 await assert.rejects(post(),error=>error.outcomeKnown===true);assert.equal(f.state().receipts.length,before.receipts.length);assert.equal(f.state().owners[peer.value],'OWN');
 f.arm({id:'malformed',recipient:peer.value,action:'release',mode:'malformed-rejection'});
 await assert.rejects(post(),error=>error.outcomeKnown===false);assert.equal(f.state().receipts.length,0);
 f.arm({id:'lost',recipient:peer.value,action:'release',mode:'disconnect-after-acceptance'});
 await assert.rejects(post(),error=>error.outcomeKnown===false);
 const unknown=f.state();assert.equal(unknown.receipts.length,1);assert.equal(unknown.owners[peer.value],'IDLE');assert.equal(unknown.attempts.length,3);
 assert.equal(unknown.faultEvents.at(-1).spec.id,'lost');assert.equal(unknown.armedFault,null);
 assert.throws(()=>f.arm({id:'lost',recipient:peer.value,action:'release',mode:'disconnect-after-acceptance'}));
 assert.deepEqual(f.state(),unknown,'private read does not execute or settle the application operation');
 assert.deepEqual(await f.restart(),unknown);
});
test('non-escalation cannot take but may make supported untargeted pass',posix,async t=>{
 const f=await fixture(t,{roles:['customer_service'],targets:['ai_agent']}),peer={kind:'PHONE',value:'12025550106'};
 await assert.rejects(f.client.threadControl('take',undefined,peer,randomUUID()),error=>error.outcomeKnown===true);
 assert.equal(f.state().receipts.length,0);
 await f.client.threadControl('pass',undefined,peer,randomUUID());assert.equal(f.state().owners[peer.value],'STANDBY');
});
test('provider metadata is not an idempotency key',posix,async t=>{
 const f=await fixture(t),peer={kind:'PHONE',value:'12025550106'},metadata=randomUUID();
 const first=await f.client.threadControl('take',undefined,peer,metadata),second=await f.client.threadControl('take',undefined,peer,metadata);
 assert.notDeepEqual(first,second);assert.equal(f.state().attempts.length,2);assert.equal(f.state().receipts.length,2);
 assert(f.state().receipts.every(r=>r.body.metadata===metadata));
});
test('explicit routing fixture composes registered access without enabling registration or Messages',posix,async t=>{
 const f=await fixture(t,{roles:['escalation'],targets:['ai_agent']},true),token=f.options.signupFixture.reauthorizationToken;
 assert.equal((await f.raw({messaging_product:'whatsapp',action:'take',to:'12025550106',metadata:randomUUID()},{token})).status,200);
 assert.equal(f.state().receipts.length,1);
 assert.equal((await f.raw({messaging_product:'whatsapp',pin:'123456'},{token,path:'/v24.0/10001/register'})).status,400);
 assert.equal((await f.raw({messaging_product:'whatsapp',recipient_type:'individual',to:'12025550106',type:'text',text:{body:'Not authorized'}},
  {token,path:'/v24.0/10001/messages'})).status,400);
 assert.equal(f.state().receipts.length,1);
});
