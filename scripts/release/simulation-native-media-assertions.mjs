import {actionResponse} from './simulation-native-media-ui.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function compareRetainedMedia({original,receipt,delivery}){
 assert.equal(delivery.state,'SENT');assert.equal(Number(delivery.attempts),1);assert.equal(delivery.external_message_id,receipt.id);assert.equal(receipt.mediaSha256,sha(original));assert.equal(receipt.mediaBytes,original.length);return{deliveryId:delivery.id,providerMessageId:receipt.id,sha256:receipt.mediaSha256,bytes:original.length,attempts:1};
}
export async function verifyPlayableRetained({page,bytes,mime,checkpoint}){
 assert(/^(audio|video)\//.test(mime));const result=await page.evaluate(async({base64,mime})=>{const b=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([b],{type:mime})),media=document.createElement(mime.startsWith('video/')?'video':'audio');media.muted=true;media.src=url;document.body.append(media);try{await Promise.race([new Promise((resolve,reject)=>{media.onloadedmetadata=resolve;media.onerror=()=>reject(Error('Retained media decode failed'));media.load();}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Decode deadline')),5000))]);await media.play();return{duration:media.duration,readyState:media.readyState,playing:!media.paused};}finally{media.pause();media.remove();URL.revokeObjectURL(url);}},{base64:bytes.toString('base64'),mime});assert(result.playing&&Number.isFinite(result.duration)&&result.duration>0);await checkpoint({phase:'proof',step:'retained-provider-byte-playability',mime,sha256:sha(bytes),bytes:bytes.length,...result,at:new Date().toISOString()});return result;
}
// Actual browser MediaRecorder/getUserMedia path: launch existing isolated Chromium with
// --use-fake-device-for-media-stream --use-fake-ui-for-media-stream. No API shim/file upload substitute.
export async function recordVoiceToStagedUpload({page,checkpoint}){
 page.setDefaultTimeout(5000);await checkpoint({phase:'intent',step:'record-voice-staged-upload',at:new Date().toISOString(),effects:'one native upload cache; zero provider sends'});
 await page.getByRole('button',{name:'Record voice',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor({state:'visible'});
 await new Promise(r=>setTimeout(r,1100));const response=await actionResponse(page,r=>r.request().method()==='POST'&&/^\/api\/v1\/upload_caches\/[^/]+$/.test(new URL(r.url()).pathname),()=>page.getByRole('button',{name:'Stop recording',exact:true}).click());assert(response.ok());const body=await Promise.race([response.json(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Upload receipt deadline')),5000))]);const item=body.data;assert(item&&Number(item.size)>0&&/^voice-.*\.webm$/.test(item.filename)&&item.contentType.split(';')[0]==='audio/webm');await page.getByText(item.filename,{exact:true}).waitFor({state:'visible'});const proof={id:item.id,filename:item.filename,bytes:Number(item.size),mime:item.contentType,viewport:page.viewportSize(),at:new Date().toISOString()};await checkpoint({phase:'proof',step:'actual-record-stop-staged-upload',proof});return proof;
}
