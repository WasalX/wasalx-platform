import {testTls,adapterUrl,undiciUrl} from './helpers/meta-simulation-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,chmodSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createMetaSimulation} from '../scripts/contracts/meta-simulation-server.mjs';

test('actual Meta adapter multipart upload retains bytes and resolves media ID after restart',{skip:process.platform==='win32'},async()=>{
 const tls=await testTls();
 const {MetaGroupsAdapter}=await import(adapterUrl);
 const {Agent,setGlobalDispatcher,getGlobalDispatcher}=await import(undiciUrl);
 const old=getGlobalDispatcher(),oldEnv=process.env.NODE_ENV;process.env.NODE_ENV='production';
 const cert=tls.cert,dir=mkdtempSync(join(tmpdir(),'meta-media-'));chmodSync(dir,0o700);
 const options={token:'synthetic-private-token',phoneId:'10001',phone:'12025550103',version:'v24.0',recipients:['12025550106'],key:tls.key,cert,stateFile:join(dir,'state.json'),groupsFixture:'eligible-empty',wabaId:'20001'};
 let server=createMetaSimulation(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dispatcher=new Agent({connect:{ca:tls.ca,lookup:(host,opts,cb)=>{assert.equal(host,'graph.facebook.com');cb(null,opts.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);}}});setGlobalDispatcher(dispatcher);
 const adapter=()=>new MetaGroupsAdapter({accessToken:options.token,graphVersion:options.version,phoneNumberIdFor:()=>options.phoneId,wabaIdFor:()=>options.wabaId,baseUrl:'https://graph.facebook.com:'+server.address().port});
 try{
  const bytes=readFileSync(new URL('./fixtures/waha/synthetic-qr.png',import.meta.url)),sha=createHash('sha256').update(bytes).digest('hex');
  const input={connectionId:'synthetic-connection',groupId:options.recipients[0],recipientType:'DIRECT',text:'Pinned image V1',idempotencyKey:'synthetic-media-one',media:{filename:'pinned.png',mimeType:'image/png',bytes}};
  const prepared=await adapter().prepareMedia(input);assert.equal(prepared.providerMediaId,'SIMMEDIA1');assert.equal(server.receipts().length,0);
  assert.deepEqual(Buffer.from(server.mediaObjects()[0].base64,'base64'),bytes);assert.equal(server.mediaObjects()[0].sha256,sha);
  await new Promise(r=>server.close(r));server=createMetaSimulation(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const result=await adapter().send({...input,media:{...input.media,...prepared}});assert.equal(result.state,'SENT');
  const [receipt]=server.receipts();assert.equal(server.receipts().length,1);assert.equal(receipt.id,result.externalMessageId);assert.equal(receipt.to,input.groupId);assert.equal(receipt.type,'image');assert.equal(receipt.mediaSha256,sha);assert.equal(receipt.mediaBytes,bytes.length);assert.equal(receipt.body.image.caption,input.text);
  await assert.rejects(adapter().send({...input,media:{...input.media,providerMediaId:'SIMMEDIA999'}}));assert.equal(server.receipts().length,1);
  await assert.rejects(adapter().send({...input,groupId:'12025550162',media:{...input.media,...prepared}}));assert.equal(server.receipts().length,1);

  const upload=async(form,headers={})=>fetch('https://graph.facebook.com:'+server.address().port+'/v24.0/10001/media',{method:'POST',headers:{authorization:'Bearer '+options.token,...headers},body:form});
  const allocationBefore=server.mediaObjects().length,receiptCount=server.receipts().length;
  const validForm=()=>{const form=new FormData();form.set('messaging_product','whatsapp');form.append('file',new Blob([bytes],{type:'image/png'}),'pinned.png');return form;};
  const missing=validForm();missing.delete('file');const duplicate=validForm();duplicate.append('file',new Blob([bytes],{type:'image/png'}),'extra.png');const wrongProduct=validForm();wrongProduct.set('messaging_product','other');
  const unsupported=validForm();unsupported.set('file',new Blob([bytes],{type:'text/plain'}),'pinned.txt');const oversized=validForm();oversized.set('file',new Blob([Buffer.alloc(1024*1024+1)],{type:'image/png'}),'large.png');const mislabeled=validForm();mislabeled.set('file',new Blob([Buffer.from('%PDF-1.4\n')],{type:'image/png'}),'fake.png');
  for(const form of [missing,duplicate,wrongProduct,unsupported,oversized,mislabeled])assert.equal((await upload(form)).status,400);
  assert.equal((await upload('broken',{'content-type':'multipart/form-data; boundary=invalid'})).status,400);assert.equal(server.mediaObjects().length,allocationBefore);assert.equal(server.receipts().length,receiptCount);
  const pdf=Buffer.from('%PDF-1.4\nSynthetic fixture\n%%EOF'),pdfInput={...input,text:'Pinned PDF',media:{filename:'pinned.pdf',mimeType:'application/pdf',bytes:pdf}},pdfPrepared=await adapter().prepareMedia(pdfInput);
  await new Promise(r=>server.close(r));server=createMetaSimulation(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));await adapter().send({...pdfInput,media:{...pdfInput.media,...pdfPrepared}});const pdfReceipt=server.receipts().at(-1);assert.equal(pdfReceipt.type,'document');assert.equal(pdfReceipt.mediaSha256,createHash('sha256').update(pdf).digest('hex'));assert.equal(pdfReceipt.body.document.filename,'pinned.pdf');assert.equal(pdfReceipt.body.document.caption,'Pinned PDF');
  const uncertainText='Media uncertain',expected={...receipt.body,image:{...receipt.body.image,caption:uncertainText}},prior=server.receipts().length;server.armFault({mode:'disconnect-after-acceptance',to:input.groupId,bodySha256:createHash('sha256').update(JSON.stringify(expected)).digest('hex')});await assert.rejects(adapter().send({...input,text:uncertainText,media:{...input.media,...prepared}}),e=>e.outcomeKnown===false);assert.equal(server.receipts().length,prior+1);const accepted=server.receipts().at(-1);assert.equal(accepted.mediaSha256,sha);
  await new Promise(r=>server.close(r));server=createMetaSimulation(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));assert.equal(server.receipts().length,prior+1);assert.deepEqual(server.receipts().at(-1),accepted);assert.equal(server.faultState().armedFault,null);
  const rawMessage=body=>fetch('https://graph.facebook.com:'+server.address().port+'/v24.0/10001/messages',{method:'POST',headers:{authorization:'Bearer '+options.token,'content-type':'application/json'},body:JSON.stringify(body)});
  const malformedBefore=server.receipts().length;assert.equal((await rawMessage({...receipt.body,image:{...receipt.body.image,filename:'not-permitted.png'}})).status,400);assert.equal((await rawMessage({...pdfReceipt.body,document:{...pdfReceipt.body.document,filename:42}})).status,400);assert.equal(server.receipts().length,malformedBefore);
  const objectCount=server.mediaObjects().length;server.armUploadFault({id:'upload-unavailable',sha256:sha});await assert.rejects(adapter().prepareMedia(input),e=>e.outcomeKnown===true&&e.retryable===true);assert.equal(server.mediaObjects().length,objectCount);assert.equal(server.receipts().length,malformedBefore);assert.deepEqual(server.uploadFaultState(),{armedUploadFault:null,uploadFaultEvents:[{id:'upload-unavailable',sha256:sha,outcome:'FAILED_BEFORE_ALLOCATION',status:503}]});
  await new Promise(r=>server.close(r));server=createMetaSimulation(options);await new Promise(r=>server.listen(0,'127.0.0.1',r));assert.equal(server.uploadFaultState().armedUploadFault,null);assert.equal(server.uploadFaultState().uploadFaultEvents.length,1);assert.equal(server.receipts().length,malformedBefore);
  const snapshot=readFileSync(options.stateFile);mkdirSync(options.stateFile+'.tmp-'+process.pid);await assert.rejects(adapter().prepareMedia(input));await assert.rejects(adapter().prepareMedia(input));assert.deepEqual(readFileSync(options.stateFile),snapshot);rmSync(options.stateFile+'.tmp-'+process.pid,{recursive:true});
 }finally{setGlobalDispatcher(old);await dispatcher.close();if(server.listening)await new Promise(r=>server.close(r));if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;rmSync(dir,{recursive:true,force:true});}
});
