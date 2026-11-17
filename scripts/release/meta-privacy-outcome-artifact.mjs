// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Collect bytes only from the actual product link navigation/download.
import assert from 'node:assert/strict';
export async function collectPrivacyArtifact({page,link,url,admit}){
 assert(new URL(url).protocol==='https:'&&typeof admit==='function');
 const context=page.context(),popups=new Set();let timer,resolve,reject,finished=false;
 const result=new Promise((a,b)=>{resolve=a;reject=b;});result.catch(()=>{});
 const settle=value=>{if(!finished){finished=true;resolve(value);}};
 const onPopup=popup=>{popups.add(popup);popup.on('download',download);};
 const response=async r=>{if(r.url()!==url||r.request().method()!=='GET')return;try{assert(r.ok());const declared=Number(r.headers()['content-length']);assert(!Number.isFinite(declared)||declared<=52428800);const bytes=await r.body();assert(bytes.length>0&&bytes.length<=52428800);settle(bytes);}catch{/* A download response may intentionally have no accessible body. */}};
 const download=async d=>{try{assert.equal(d.url(),url);assert.equal(await d.failure(),null);const stream=await d.createReadStream();assert(stream);let size=0;const chunks=[];for await(const b of stream){size+=b.length;assert(size<=52428800);chunks.push(b);}assert(size>0);settle(Buffer.concat(chunks));}catch{if(!finished)reject(Error('P11 actual artifact download unavailable'));}};
 context.on('response',response);page.on('download',download);page.on('popup',onPopup);
 timer=setTimeout(()=>reject(Error('P11 actual artifact bytes deadline')),30000);
 try{await admit();await link.click();return await result;}finally{clearTimeout(timer);context.off('response',response);page.off('download',download);page.off('popup',onPopup);for(const popup of popups){popup.off('download',download);await popup.close().catch(()=>{});}}
}
