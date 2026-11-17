import test from 'node:test';
import assert from 'node:assert/strict';
import {observeNativeNicknameSurface} from '../scripts/release/simulation-native-nickname-surfaces.mjs';
function page({missingName=false}={}){
 const state={};
 const article={async waitFor(o){assert.deepEqual(o,{state:'visible',timeout:20000});},getByText(text,o){assert.deepEqual(o,{exact:false});assert(['Expected Name','exact-marker'].includes(text));let visibleOnly=false;return{filter(o){assert.deepEqual(o,{visible:true});visibleOnly=true;return this;},first(){return this;},async waitFor(o){assert.deepEqual(o,{state:'visible',timeout:20000});if(text==='Expected Name'){assert(visibleOnly,'Ignore hidden matches within the exact article');state.nameWaited=true;if(missingName)throw Error('Exact article name absent');}else state.markerWaited=true;}};}};
 return{state,async setViewportSize(v){state.viewport=v;},async goto(url){state.url=url;},viewportSize(){return state.viewport;},locator(selector){if(selector==='#dialog-beta-ui-disclaimer')return{async isVisible(){return false;}};assert.equal(selector,'#article-29');state.selector=selector;return article;},async addLocatorHandler(){},async removeLocatorHandler(){},getByText(){throw Error('Unrelated article/sidebar marker and name must never qualify this article');}};
}
for(const width of[390,1440])for(const missingName of[false,true])test(`exact article nickname at ${width}, missing=${missingName}`,async()=>{
 const p=page({missingName});const result=await observeNativeNicknameSurface({page:p,origin:'https://native.example',native:{ticketId:17,articleId:29},marker:'exact-marker',expected:'Expected Name',viewport:{width,height:844}});
 assert.equal(p.state.url,`https://native.example/${width===390?'mobile':'desktop'}/tickets/17#article-29`);assert.equal(p.state.selector,'#article-29');assert.equal(p.state.markerWaited,true);assert.equal(p.state.nameWaited,true);assert.equal(result.nameVisible,!missingName);
});
import {runInNewContext} from 'node:vm';
import {observeNicknameSurfaces} from '../scripts/release/simulation-native-nickname-surfaces.mjs';
for(const originBy of[22,0,undefined])test(`native identity follows exact article origin ${originBy}`,async()=>{
 const requests=[];let viewport={width:1440,height:1000};
 const chain={first(){return this;},filter(){return this;},getByText(){return this;},async waitFor(){},async isVisible(){return true;}};
 const p={url:()=> 'https://native.example/desktop/tickets/17',viewportSize:()=>viewport,async setViewportSize(v){viewport=v;},async goto(){},async reload(){},async addLocatorHandler(){},async removeLocatorHandler(){},locator(selector){return selector==='#dialog-beta-ui-disclaimer'?{async isVisible(){return false;}}:chain;},async evaluate(fn,arg){
  if(arg?.ticketId){return runInNewContext(`(${fn.toString()})(input)`,{input:arg,fetch:async path=>{requests.push(path);const data=path==='/api/v1/tickets/17'?{id:17,customer_id:11,group_id:2}:path==='/api/v1/ticket_articles/by_ticket/17'?[{id:29,body:'exact-marker',origin_by_id:originBy,preferences:{},from:'Expected Name'}]:path==='/api/v1/users/22'?{firstname:'Expected',lastname:'Name',login:'sender',mobile:'123'}:null;assert(data,'Unexpected identity lookup '+path);return{ok:true,json:async()=>data};}});}
  if(arg?.messageId)return{id:arg.messageId,participant_name:'Expected Name',sender_phone:'123'};
  return{id:4,roles:[2],locale:'en'};
 }};
 const observe=()=>observeNicknameSurfaces({page:p,groupId:'group',messageId:'message',expected:'Expected Name',marker:'exact-marker',link:{zammad_ticket_id:17,zammad_article_id:29},checkpoint:async()=>{},expectedActorId:4,tenantId:'tenant'});
 if(originBy===22){const result=await observe();assert.equal(result.native.customerId,11);assert.equal(result.native.senderId,22);assert.equal(result.nativeNameMatches,true);assert.equal(result.identityPass,true);}else await assert.rejects(observe,/Native article sender absent/);
 assert.equal(requests.includes('/api/v1/users/11'),false);assert.equal(requests.includes('/api/v1/users/22'),originBy===22);
});
