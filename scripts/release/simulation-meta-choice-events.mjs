import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
// Fixture shape follows tests/meta-webhook-http.test.mjs and MetaAdapter normalizer.
// Transport callback must be admitted isolated control API; never defaults to network.
import {metaInput} from './simulation-meta-input.mjs';
export {metaInput} from './simulation-meta-input.mjs';
export async function runMetaChoiceLocation({binding,secret,postRaw,checkpoint,assertIsolatedRuntime,readPrompt,readProcessed,readLocation,expectedChoiceNodeId,runId,persistInbound,now=()=>Date.now()}){
 await assertIsolatedRuntime({evidenceMode:'simulated',provider:'META',requireIsolatedGraph:true});assert(typeof secret==='string'&&secret.length>=16);const proofs=[];
 const emit=async(label,extra)=>{
  const id='wamid.synthetic.'+runId+'.'+label;const payload=metaInput({...binding,id,timestamp:Math.floor(now()/1000),...extra});const bytes=Buffer.from(JSON.stringify(payload));const signature='sha256='+createHmac('sha256',secret).update(bytes).digest('hex');const hash=createHash('sha256').update(bytes).digest('hex');
  await persistInbound({messageId:id,bytes});await checkpoint({phase:'intent',step:label,messageId:id,bodySha256:hash});const response=await postRaw('/webhooks/meta',bytes,{'content-type':'application/json','x-hub-signature-256':signature});assert.equal(response.status,200);assert.equal(response.receipt?.count,1);await checkpoint({phase:'accepted',step:label,messageId:id,bodySha256:hash,receipt:response.receipt});
  const processed=await readProcessed(id);assert.equal(processed.terminal,true);assert.equal(processed.messageCount,1);await checkpoint({phase:'processed',step:label,proof:processed});proofs.push({label,messageId:id,bodySha256:hash,processed});return{bytes,signature,id,processed};
 };
 const initial=await emit('initial',{kind:'text',text:'Synthetic '+runId});const prompt=await readPrompt(initial.id);assert(prompt.externalMessageId&&prompt.state==='SENT'&&prompt.choiceId&&prompt.title);
 const choice=await emit('choice',{kind:'interactive',promptId:prompt.externalMessageId,choiceId:prompt.choiceId,choiceTitle:prompt.title});assert.equal(choice.processed.currentNodeId,expectedChoiceNodeId);
 const point={latitude:24.7136,longitude:46.6753,name:'Synthetic public landmark'};const located=await emit('location',{kind:'location',location:point});const location=await readLocation(located.id);assert.deepEqual(location.coordinates,{latitude:point.latitude,longitude:point.longitude});assert.equal(location.nativeArticleCount,1);await checkpoint({phase:'location-readback',proof:location});
 await checkpoint({phase:'intent',step:'duplicate-location',messageId:located.id});const duplicate=await postRaw('/webhooks/meta',located.bytes,{'content-type':'application/json','x-hub-signature-256':located.signature});assert.equal(duplicate.status,200);assert.equal(duplicate.receipt?.duplicates,1);assert.deepEqual(await readProcessed(located.id),located.processed);assert.deepEqual(await readLocation(located.id),location);await checkpoint({phase:'duplicate-readback',receipt:duplicate.receipt,proof:location});
 return{evidenceMode:'simulated',proofs,location,duplicate:duplicate.receipt,limitations:['Requires independently qualified isolated Meta transport and seeded choice-to-location flow','No real native-button tap, real provider or full role/viewport acceptance']};
}
