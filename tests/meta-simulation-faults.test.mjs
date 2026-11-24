import {testTls,adapterUrl,undiciUrl} from './helpers/meta-simulation-fixture.mjs';
const tls=await testTls();
import {createHash} from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createMetaSimulation} from '../scripts/contracts/meta-simulation-server.mjs';
test('production adapter uses trusted Graph TLS and durable acceptance only',{skip:process.platform==='win32'?'POSIX ownership and private persistence required':false},async()=>{const {MetaGroupsAdapter:MetaAdapter}=await import(adapterUrl);const {Agent,setGlobalDispatcher,getGlobalDispatcher}=await import(undiciUrl);const old=getGlobalDispatcher(),env=process.env.NODE_ENV;process.env.NODE_ENV='production';const cert=tls.cert,dir=mkdtempSync(join(tmpdir(),'meta-durable-'));chmodSync(dir,0o700);const options={token:'synthetic-private-token',phoneId:'10001',phone:'12025550103',version:'v24.0',recipients:['12025550106'],key:tls.key,cert,stateFile:join(dir,'state.json'),groupsFixture:'eligible-empty',wabaId:'20001'};let s=createMetaSimulation(options);await new Promise(r=>s.listen(0,'127.0.0.1',r));const agent=new Agent({connect:{ca:tls.ca,lookup:(host,opts,cb)=>{assert.equal(host,'graph.facebook.com');cb(null,opts.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);}}});setGlobalDispatcher(agent);try{const cfg={accessToken:options.token,graphVersion:'v24.0',phoneNumberIdFor:()=> '10001',wabaIdFor:()=> '20001',baseUrl:'https://graph.facebook.com:'+s.address().port};assert.throws(()=>new MetaAdapter({...cfg,baseUrl:'http://graph.facebook.com'}));assert.throws(()=>new MetaAdapter({...cfg,baseUrl:'https://other.invalid'}));const a=new MetaAdapter(cfg);const input={connectionId:'c',groupId:'12025550106',recipientType:'DIRECT',text:'synthetic',idempotencyKey:'one'};const outbound={messaging_product:'whatsapp',recipient_type:'individual',to:input.groupId,type:'text',text:{body:'synthetic'}};
const matchHash=createHash('sha256').update(JSON.stringify(outbound)).digest('hex');
s.armFault({mode:'window-closed',to:input.groupId,bodySha256:matchHash});
await a.send({...input,text:'different'});assert(s.faultState().armedFault,'Different body must not consume fault');
const raw=async body=>fetch(cfg.baseUrl+'/v24.0/10001/messages',{method:'POST',headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:JSON.stringify(body)});
const wrong=await raw({...outbound,to:'12025550162'});assert.equal(wrong.status,400);assert(s.faultState().armedFault,'Wrong recipient must not consume fault');
const beforeInvalid=s.receipts().length;const invalid=await raw({...outbound,type:'template',template:{name:'Invalid NAME',language:{code:'en'}}});assert.equal(invalid.status,400);assert.equal(s.receipts().length,beforeInvalid);assert(s.faultState().armedFault);
await assert.rejects(a.send(input));assert.equal(s.faultState().armedFault,null);
for(const [mode,known,code] of [['window-closed',true,'META_CUSTOMER_WINDOW_CLOSED'],['rate-limited',false,'META_RATE_LIMITED'],['disconnect-after-acceptance',false,null]]){const baseline=s.receipts().length;s.armFault({mode,to:input.groupId,bodySha256:createHash('sha256').update(JSON.stringify(outbound)).digest('hex')});await assert.rejects(a.send(input),e=>{assert.equal(e.outcomeKnown,known);if(code)assert.equal(e.code,code);return true;});assert.equal(s.receipts().length,baseline+(mode==='disconnect-after-acceptance'?1:0));assert.equal(s.faultState().armedFault,null);}
const result=await a.send({...input,template:{name:'synthetic_update',languageCode:'en',bodyParameters:['Synthetic']}});assert.equal(result.state,'SENT');assert.equal(s.receipts().at(-1).body.template.name,'synthetic_update');assert.deepEqual(s.receipts().at(-1).body.template.language,{code:'en'});assert.equal(s.receipts().at(-1).body.template.components[0].parameters[0].text,'Synthetic');
await new Promise(r=>s.close(r));s=createMetaSimulation(options);assert.equal(s.faultState().faultEvents.length,4);assert.equal(s.receipts().length,3);
}finally{setGlobalDispatcher(old);await agent.close();if(s.listening)await new Promise(r=>s.close(r));if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;rmSync(dir,{recursive:true,force:true});}});


test('Meta simulation fixtures preserve joint then phone-less text/media/native-choice/status identities',async()=>{
 const {metaInput}=await import('../scripts/release/simulation-meta-input.mjs');
 const {metaStatusEnvelope}=await import('../scripts/release/simulation-meta-status.mjs');
 const common={wabaId:'20001',phoneId:'10001',customer:'12025550106',id:'wamid.synthetic.bsuid.initial',timestamp:1800000000};
 const joint=metaInput({...common,kind:'text',text:'مرحبا',sender:{phone:common.customer,bsuid:'SA.Synthetic01',jointContact:true}}).entry[0].changes[0].value;
 assert.equal(joint.messages[0].from,common.customer);assert.equal(joint.messages[0].from_user_id,'SA.Synthetic01');
 assert.deepEqual(joint.contacts,[{user_id:'SA.Synthetic01',wa_id:common.customer}]);
 for(const input of [{kind:'text',text:'متابعة'},{kind:'image',media:{id:'SIMMEDIA1',sha256:'a'.repeat(64),mime_type:'image/png'}},{kind:'interactive',promptId:'wamid.SIM000000000001',choiceId:'sales',choiceTitle:'المبيعات'}]){
  const value=metaInput({...common,...input,sender:{bsuid:'SA.Synthetic01'}}).entry[0].changes[0].value;
  assert(!Object.hasOwn(value.messages[0],'from'));assert.equal(value.messages[0].from_user_id,'SA.Synthetic01');
  assert.deepEqual(value.contacts,[{user_id:'SA.Synthetic01'}]);
 }
 const status=metaStatusEnvelope({...common,id:'wamid.SIM000000000001',recipient:common.customer,status:'read',metaDirectRecipient:{kind:'BSUID',value:'SA.Synthetic01'}}).entry[0].changes[0].value.statuses[0];
 assert.equal(status.recipient_user_id,'SA.Synthetic01');assert(!Object.hasOwn(status,'recipient_id'));
 assert.throws(()=>metaInput({...common,kind:'text',text:'x',sender:{bsuid:'SA.Synthetic01',jointContact:true}}));
 assert.throws(()=>metaInput({...common,kind:'text',text:'x',sender:{bsuid:'parent:SA.Synthetic01'}}));
 assert.throws(()=>metaStatusEnvelope({...common,id:'wamid.x',recipient:common.customer,status:'read',metaDirectRecipient:{kind:'PHONE',value:common.customer}}));
});

test('production adapter simulator accepts exclusive BSUID recipient and authenticates persisted media lookup/download',{skip:process.platform==='win32'?'POSIX ownership and private persistence required':false},async()=>{
 const {MetaGroupsAdapter:MetaAdapter}=await import(adapterUrl);
 const {Agent,setGlobalDispatcher,getGlobalDispatcher}=await import(undiciUrl);
 const previous=getGlobalDispatcher(),env=process.env.NODE_ENV;process.env.NODE_ENV='production';
 const dir=mkdtempSync(join(tmpdir(),'meta-bsuid-'));chmodSync(dir,0o700);
 const options={token:'synthetic-private-token',phoneId:'10001',phone:'12025550103',version:'v24.0',recipients:['12025550106','SA.Synthetic01'],key:tls.key,cert:tls.cert,stateFile:join(dir,'state.json'),groupsFixture:'eligible-empty',wabaId:'20001'};
 let server=createMetaSimulation(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const agent=new Agent({connect:{ca:tls.ca,lookup:(host,opts,cb)=>{assert.equal(host,'graph.facebook.com');cb(null,opts.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);}}});setGlobalDispatcher(agent);
 try{
  const origin='https://graph.facebook.com:'+server.address().port,headers={authorization:'Bearer '+options.token};
  const adapter=new MetaAdapter({accessToken:options.token,graphVersion:'v24.0',phoneNumberIdFor:()=>options.phoneId,wabaIdFor:()=>options.wabaId,baseUrl:origin});
  const result=await adapter.send({connectionId:'c',groupId:'12025550106',recipientType:'DIRECT',metaDirectRecipient:{kind:'BSUID',value:'SA.Synthetic01'},text:'رد عربي',idempotencyKey:'bsuid-one'});
  const receipt=server.receipts()[0];assert.equal(result.externalMessageId,receipt.id);assert.equal(receipt.recipient,'SA.Synthetic01');assert.equal(receipt.body.recipient,'SA.Synthetic01');assert(!Object.hasOwn(receipt,'to'));assert(!Object.hasOwn(receipt.body,'to'));
  const raw=body=>fetch(origin+'/v24.0/10001/messages',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const [replySignal]=adapter.agentReplySignals({connectionId:'c',groupId:'12025550106',
   inboundMessageId:'wamid.synthetic-inbound',metaDirectRecipient:{kind:'BSUID',value:'SA.Synthetic01'}});
  assert.equal(await replySignal.send(new AbortController().signal),'sent');
  assert.equal((await raw({status:'read',messaging_product:'whatsapp',typing_indicator:{type:'text'}})).status,400);
  const noRecipient={...receipt.body};delete noRecipient.recipient;
  for(const body of [{...receipt.body,to:'12025550106'},{...receipt.body,recipient:'SA.NotAdmitted'},{...receipt.body,recipient:null},noRecipient])assert.equal((await raw(body)).status,400);
  assert.equal(server.receipts().length,1,'Invalid recipient forms must never create acceptance');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');
  const form=new FormData();form.set('messaging_product','whatsapp');form.set('file',new Blob([png],{type:'image/png'}),'owned.png');
  const upload=await fetch(origin+'/v24.0/10001/media',{method:'POST',headers,body:form});assert.equal(upload.status,200);const {id}=await upload.json();
  const lookup=await fetch(origin+'/v24.0/'+id+'?phone_number_id=10001',{headers});assert.equal(lookup.status,200);const metadata=await lookup.json();
  assert.equal(metadata.sha256,createHash('sha256').update(png).digest('hex'));assert.equal(metadata.file_size,png.length);assert.equal(metadata.mime_type,'image/png');
  const url=new URL(metadata.url);assert.equal(url.origin,'https://graph.facebook.com');
  const downloaded=await fetch(origin+url.pathname,{headers});assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),png);
  assert.equal((await fetch(origin+'/v24.0/'+id+'?phone_number_id=99999',{headers})).status,400);
  assert.equal((await fetch(origin+'/v24.0/'+id+'?phone_number_id=10001')).status,401);
  assert.equal((await fetch(origin+url.pathname)).status,401);
  const accepted=server.receipts();await new Promise(r=>server.close(r));server=createMetaSimulation(options);
  assert.deepEqual(server.receipts(),accepted);assert.equal(server.mediaObjects()[0].sha256,metadata.sha256);assert.equal(server.receipts().length,1);
 }finally{setGlobalDispatcher(previous);await agent.close();if(server.listening)await new Promise(r=>server.close(r));if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;rmSync(dir,{recursive:true,force:true});}
});
