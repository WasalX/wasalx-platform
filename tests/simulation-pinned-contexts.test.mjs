import test from 'node:test';import assert from 'node:assert/strict';import{pinnedContextPlan,assertPinnedNative}from '../scripts/release/simulation-pinned-contexts.mjs';
const order=[{id:1,at:'2026-09-12T10:00:00Z'},{id:2,at:'2026-09-12T10:01:00Z'}],p={delivery:{zammad_ticket_id:3,zammad_article_id:2},asset:{sha256:'abc',bytes:12,filename:'a.png'},native:{inboundArticleId:1,articleOrder:order}},a={ticketId:3,articleId:2,sha256:'abc',byteSize:12,filename:'a.png',order};
test('exact owner desktop and portal agent three contexts',()=>{assert.deepEqual(pinnedContextPlan().map(x=>[x.context.role,x.context.viewport,x.context.surface]),[['tenant_owner','desktop','portal'],['agent','desktop','portal'],['agent','tablet','portal'],['agent','mobile','portal']])});
test('native asset and both historical articles remain bound',()=>{assertPinnedNative(a,p);for(const field of ['ticketId','articleId','sha256','byteSize','filename'])assert.throws(()=>assertPinnedNative({...a,[field]:'wrong'},p));assert.throws(()=>assertPinnedNative({...a,order:[order[1]]},p));assert.throws(()=>assertPinnedNative({...a,order:[{...order[0],at:'2026-09-12T11:00:00Z'},order[1]]},p));});

import{waitForNativeImagePreview}from'../scripts/release/simulation-native-mail-browser.mjs';
test('native attachment waits for the accessible image and successful decoding',async()=>{
 const events=[],node={complete:false,naturalWidth:0,decode:async()=>{events.push('decode');node.complete=true;node.naturalWidth=20}};
 const article={getByRole:(role,options)=>{assert.equal(role,'img');assert.deepEqual(options,{name:'Image of a.png',exact:true});return{waitFor:async()=>events.push('visible'),evaluate:async fn=>fn(node)}}};
 await waitForNativeImagePreview(article,'a.png');assert.deepEqual(events,['visible','decode']);node.decode=async()=>{node.naturalWidth=0};await assert.rejects(waitForNativeImagePreview(article,'a.png'),/did not decode/);
});

import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {readPortalPinnedAttachment} from '../scripts/release/simulation-pinned-contexts.mjs';
function downloadFixture(bytes,{wrongFilename=false}={}){
 const events=[];let waiting=false;
 const button={click:async()=>{assert(waiting,'Subscribe to download before one click');events.push('download-click');}};
 const article={count:async()=>1,waitFor:async()=>{},getByRole:(role,options)=>{assert.equal(role,'button');assert.equal(options.name,'Download a.png');return button;}};
 const generic={waitFor:async()=>{},count:async()=>1,filter(){return this;}};
 const page={viewportSize:()=>({width:390,height:844}),goto:async url=>{assert.match(url,/view=inbox&ticket=123$/);events.push('portal-open');},reload:async()=>events.push('reload'),
  locator:selector=>selector.startsWith('[data-article-id=')?article:generic,getByRole:(role)=>{assert.equal(role,'heading');return generic;},
  evaluate:async(_fn,input)=>{assert.equal(input.path,'/api/inbox');assert.equal(input.body.operation,'LIST');return{items:[{id:'3',number:'123',title:'Pinned ticket'}]};},
  waitForEvent:async event=>{assert.equal(event,'download');waiting=true;return{failure:async()=>null,suggestedFilename:()=>wrongFilename?'wrong.png':'a.png',createReadStream:async()=>Readable.from([bytes])};}};
 return{events,operator:{page,session:{portalOrigin:'https://portal.test',runId:'fixture',checkpoint:async()=>{}},verify:async()=>{events.push('verify');return{viewport:{width:390,height:844}};}}};
}
test('portal media proof opens exact article and hashes one actual download stream',async()=>{
 const bytes=Buffer.from('synthetic pinned binary'),fixture=downloadFixture(bytes),expected={delivery:{zammad_article_id:'2'},ticketNumber:'123',asset:{filename:'a.png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
 assert.deepEqual(await readPortalPinnedAttachment(fixture.operator,expected),{filename:'a.png',byteSize:bytes.length,sha256:expected.asset.sha256});
 assert.equal(fixture.events.filter(value=>value==='download-click').length,1);assert(fixture.events.includes('reload'));assert.equal(fixture.events.at(-1),'verify');
});
test('wrong portal download bytes or filename cannot become pinned media proof',async()=>{
 const bytes=Buffer.from('wrong'),expected={delivery:{zammad_article_id:'2'},ticketNumber:'123',asset:{filename:'a.png',bytes:bytes.length,sha256:'a'.repeat(64)}};
 for(const fixture of [downloadFixture(bytes),downloadFixture(bytes,{wrongFilename:true})]){
  await assert.rejects(readPortalPinnedAttachment(fixture.operator,expected));assert.equal(fixture.events.filter(value=>value==='download-click').length,1);
 }
 const fixture=downloadFixture(bytes);await assert.rejects(readPortalPinnedAttachment(fixture.operator,{...expected,asset:{...expected.asset,bytes:1}}),/exceeded/);
});
