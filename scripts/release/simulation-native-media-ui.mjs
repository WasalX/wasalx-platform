import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {recordVoiceToStagedUpload} from './simulation-native-media-assertions.mjs';
import {admitNativeMailUi} from './simulation-native-mail-browser.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
// Observe first, always detach the listener/timer when the triggering action fails.
export async function actionResponse(page,predicate,action,timeout=20000){
 let listener,timer;const response=new Promise((resolve,reject)=>{listener=r=>{try{if(predicate(r))resolve(r);}catch(error){reject(error);}};page.on('response',listener);timer=setTimeout(()=>reject(new Error('Response deadline')),timeout);});
 const observed=response.then(value=>({value}),error=>({error}));
 try{await action();const result=await observed;if(result.error)throw result.error;return result.value;}finally{clearTimeout(timer);page.off('response',listener);}
}
export function uploadBytes(request){
 const boundary=/boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()['content-type']??'');assert(boundary);const raw=request.postDataBuffer();assert(raw&&raw.length<8*1024*1024);const delimiter=Buffer.from('--'+(boundary[1]??boundary[2]));let offset=0,found;
 while((offset=raw.indexOf(delimiter,offset))>=0){offset+=delimiter.length;if(raw.subarray(offset,offset+2).equals(Buffer.from('--')))break;assert(raw.subarray(offset,offset+2).equals(Buffer.from('\r\n')));const head=offset+2,body=raw.indexOf('\r\n\r\n',head);assert(body>=head);const next=raw.indexOf(Buffer.concat([Buffer.from('\r\n'),delimiter]),body+4);assert(next>=body+4);const headers=raw.subarray(head,body).toString('utf8');if(/content-disposition:\s*form-data;[^\r\n]*\bname="File"(?:;|\r|$)/i.test(headers)){assert.equal(found,undefined,'One File part required');found=raw.subarray(body+4,next);}offset=next+2;
 }assert(found?.length,'Nonempty File part required');return found;
}
export async function mediaUiDiagnostics(page){return page.evaluate(()=>{const buttons=[...document.querySelectorAll('button')],find=name=>buttons.filter(b=>b.textContent.trim()===name).map(b=>({disabled:b.disabled,visible:!!(b.getClientRects().length),width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}));return{fileInputs:document.querySelectorAll('input[type=file]').length,send:find('Send'),attach:find('Attach files'),record:find('Record voice'),stop:find('Stop recording'),composerDisabled:document.querySelector('#wasalx-group-message')?.disabled??null,alertPresent:!!document.querySelector('#wasalx-group-message-error'),mentionOptions:document.querySelectorAll('[role=listbox] [role=option]').length};});}
// Observe the actual File built by MediaRecorder upload, never CDP multipart serialization.
export async function observeUploadFile(page,fieldName='File'){
 assert(['File','files'].includes(fieldName));await page.evaluate(fieldName=>{if(globalThis.__wasalxMediaFileObserver)throw Error('File observer already owned');const original=FormData.prototype.append,state={original,pending:[],wrapper:null};state.wrapper=function(name,value,...rest){if(name===fieldName&&value instanceof Blob){if(value.size<1||value.size>8*1024*1024)throw Error('Synthetic upload bound exceeded');state.pending.push(value.arrayBuffer().then(bytes=>({bytes:Array.from(new Uint8Array(bytes)),mime:value.type,size:value.size})));}return original.call(this,name,value,...rest);};globalThis.__wasalxMediaFileObserver=state;FormData.prototype.append=state.wrapper;},fieldName);
 return{async read(){const files=await page.evaluate(async()=>Promise.all(globalThis.__wasalxMediaFileObserver.pending));assert.equal(files.length,1,'One actual uploaded File expected');assert.equal(files[0].size,files[0].bytes.length);return Buffer.from(files[0].bytes);},async close(){await page.evaluate(()=>{const state=globalThis.__wasalxMediaFileObserver;if(!state)return;if(FormData.prototype.append!==state.wrapper)throw Error('Upload observer ownership changed');FormData.prototype.append=state.original;delete globalThis.__wasalxMediaFileObserver;});}};
}
export async function stageMedia({page,fixture,checkpoint}){
 const observer=fixture.kind==='voice'?await observeUploadFile(page):null;let bytes=fixture.kind==='voice'?null:await readFile(fixture.path);
 try{await checkpoint({phase:'intent',step:'media-upload',kind:fixture.kind,source:observer?'actual-browser-File':'frozen-fixture',bytes:bytes?.length,sha256:bytes?hash(bytes):undefined,at:new Date().toISOString()});
 if(observer){await recordVoiceToStagedUpload({page,checkpoint});bytes=await observer.read();}
 else{const response=await actionResponse(page,r=>r.request().method()==='POST'&&/^\/api\/v1\/upload_caches\/[^/]+$/.test(new URL(r.url()).pathname),()=>page.locator('input[type="file"]').setInputFiles(fixture.path));assert(response.ok());const item=(await response.json()).data;assert(item&&Number(item.size)===bytes.length);await page.getByText(item.filename,{exact:true}).waitFor({state:'visible',timeout:10000});await checkpoint({phase:'accepted',step:'media-upload',kind:fixture.kind,id:item.id,bytes:Number(item.size),at:new Date().toISOString()});}
 assert(bytes?.length);await checkpoint({phase:'proof',step:'media-original-bytes',kind:fixture.kind,bytes:bytes.length,sha256:hash(bytes),source:observer?'actual-browser-File':'frozen-fixture',at:new Date().toISOString()});return bytes;
 }finally{await observer?.close();}
}
export async function sendGroupUi({page,groupId,step,checkpoint,beforeDispatch}){
 const path=`/api/v1/wasalx/group_workspace/groups/${groupId}/send`;let intent,observerError;
 const handler=async route=>{try{if(route.request().method()!=='POST')return route.continue();assert(!intent,'Unexpected duplicate UI request');intent=route.request().postDataJSON();assert(typeof intent.request_token==='string'&&intent.request_token);await checkpoint({phase:'intent',step,path,body:intent,at:new Date().toISOString()});beforeDispatch();await route.continue();}catch(error){observerError=error;await route.abort('failed').catch(()=>{});}};await page.route('**'+path,handler);
 try{const response=await actionResponse(page,r=>new URL(r.url()).pathname===path&&r.request().method()==='POST',()=>page.getByRole('button',{name:'Send',exact:true}).click());assert(response.ok());const value=await response.json();assert.match(value.id,/^[a-f0-9-]{36}$/);await checkpoint({phase:'accepted',step,response:value,at:new Date().toISOString()});return{queued:value,intent};}catch(error){throw observerError??error;}finally{await page.unroute('**'+path,handler);}
}
export async function observeSentMedia({page,groupId,delivery,expectedHash,mime,checkpoint}){
 const origin=new URL(page.url()).origin,contexts=[];
 for(const viewport of [{width:1440,height:1000},{width:820,height:1180}]){await page.setViewportSize(viewport);await page.goto(`${origin}/desktop/wasalx/groups?group=${groupId}`);await admitNativeMailUi(page);const row=page.locator(`[data-message-id="${delivery.id}"]`);await row.waitFor({state:'visible',timeout:20000});const readback=await page.evaluate(async({groupId,id})=>{const r=await fetch(`/api/v1/wasalx/group_workspace/groups/${groupId}/messages/${id}/media`);if(!r.ok)throw Error('Authenticated media read failed');const bytes=await r.arrayBuffer();return{bytes:bytes.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')};},{groupId,id:delivery.id});assert.equal(readback.sha256,expectedHash);
 let playable=null;if(/^(audio|video)\//.test(mime)){playable=await row.locator(mime.startsWith('video/')?'video':'audio').evaluate(async media=>{media.muted=true;await Promise.race([new Promise((resolve,reject)=>{media.onloadedmetadata=resolve;media.onerror=()=>reject(Error('Media decode failed'));media.load();}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Media decode timeout')),5000))]);await media.play();await new Promise(r=>setTimeout(r,200));const result={duration:media.duration,currentTime:media.currentTime,played:media.currentTime>0};media.pause();return result;});assert(playable.played&&Number.isFinite(playable.duration));}
 if(mime.startsWith('image/'))assert(await row.locator('img').evaluate(async img=>{await img.decode();return img.complete&&img.naturalWidth>0}));
 contexts.push({viewport:page.viewportSize(),readback,playable,at:new Date().toISOString()});await checkpoint({phase:'proof',step:'group-media-ui',deliveryId:delivery.id,mime,context:contexts.at(-1)});
 }return contexts;
}
