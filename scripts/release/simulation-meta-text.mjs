import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {metaInput} from './simulation-meta-input.mjs';
// Composition entrypoint for the existing isolated launcher. Callbacks own private auth/DB/native IO.
export async function runMetaTextVertical({request,checkpoint,admit,binding,token,secret,runId,zammadGroupId,postRaw,readTerminal,providerRead,drain,persistInbound}){
 const startedAt=new Date().toISOString();assert.equal(typeof persistInbound,'function');assert(/^[a-zA-Z0-9_-]{1,60}$/.test(runId));await admit({evidenceMode:'simulated',requiredCapability:'eligible-empty',provider:'META'});
 const post=async(path,body,step)=>request(path,'POST',body,step);
 const connection=await post('/api/connections',{name:'Synthetic Meta '+runId,provider:'META',phoneNumberId:binding.phoneId,wabaId:binding.wabaId,accessToken:token},'meta-connection');
 assert(connection.id);await checkpoint({phase:'connection-created',connectionId:connection.id});
 const until=async(fn,predicate)=>{const end=Date.now()+120000;while(Date.now()<end){const r=await fn();if(predicate(r))return r;await new Promise(r=>setTimeout(r,500));}throw Error('Unsettled Meta prerequisite; reconcile retained operation, never recreate');};
 await until(()=>request('/api/connections/'+connection.id),r=>{if(r.latest_operation_state==='FAILED_TERMINAL')throw Error('Meta provisioning failed');return r.latest_operation_state==='SUCCEEDED'&&r.state==='WORKING';});
 const text='Synthetic Meta '+runId;
 const flow=await post('/api/bot-flows',{schemaVersion:1,name:text,start:'hello',maxSteps:5,nodes:[{id:'hello',type:'send_text',text,next:'handoff'},{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]},'meta-flow');
 await post(`/api/bot-flows/${flow.id}/activate`,{expectedRevision:Number(flow.revision),expectedActiveFlowVersionId:null},'meta-activate');
 const assignment=await post('/api/bot-flows/assignments',{connectionId:connection.id,familyId:flow.familyId,zammadGroupId:String(zammadGroupId),agentPrefix:'Agent',agentIdentityPlacement:'HEADER'},'meta-assign');
 const id='wamid.synthetic.'+runId+'.initial',bytes=Buffer.from(JSON.stringify(metaInput({...binding,id,timestamp:Math.floor(Date.now()/1000),kind:'text',text}))),signature='sha256='+createHmac('sha256',secret).update(bytes).digest('hex');
 const before=await providerRead();assert.equal(before.filter(r=>r.to===binding.customer).length,0,'Use a fresh approved synthetic customer');
 await persistInbound({messageId:id,bytes});
 await checkpoint({phase:'intent',step:'meta-inbound',messageId:id,bodySha256:createHash('sha256').update(bytes).digest('hex')});
 const accepted=await postRaw('/webhooks/meta',bytes,{'content-type':'application/json','x-hub-signature-256':signature});
 await checkpoint({phase:'ingress-receipt',receipt:accepted});assert.equal(accepted.status,200);assert.deepEqual(accepted.receipt,{accepted:true,count:1,duplicates:0,unrouted:0});
 // Reader must return exact app inbox/link/article/outbox and native readback, not mocked counts.
 const proof=await readTerminal({connectionId:connection.id,messageId:id,expectedText:text,customer:binding.customer});
 assert(proof.inboxId&&proof.nativeArticleId&&proof.ticketId);assert.equal(proof.state,'SENT');
 const receipts=(await providerRead()).filter(r=>r.to===binding.customer);assert.equal(receipts.length,1);assert.equal(receipts[0].id,proof.externalMessageId);assert.equal(receipts[0].body.text.body,text);
 await checkpoint({phase:'vertical-readback',proof,providerReceiptId:receipts[0].id});
 await checkpoint({phase:'intent',step:'meta-duplicate',messageId:id});const duplicate=await postRaw('/webhooks/meta',bytes,{'content-type':'application/json','x-hub-signature-256':signature});await checkpoint({phase:'duplicate-receipt',receipt:duplicate});assert.equal(duplicate.status,200);assert.deepEqual(duplicate.receipt,{accepted:true,count:0,duplicates:1,unrouted:0});
 assert.deepEqual(await readTerminal({connectionId:connection.id,messageId:id,expectedText:text,customer:binding.customer}),proof);assert.deepEqual((await providerRead()).filter(r=>r.to===binding.customer),receipts);
 await checkpoint({phase:'duplicate-readback',proof});await drain({connectionId:connection.id,assignmentId:assignment.assignmentId});
 return{evidenceMode:'simulated',startedAt,finishedAt:new Date().toISOString(),connectionId:connection.id,assignmentId:assignment.assignmentId,proof,limitations:['Provider acceptance only; no delivered/read status or real native-button proof','Caller records exact actor/tenant/viewport and owned assignment disposition']};
}
