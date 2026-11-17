import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
function functions(file,names,scope={}){const source=readFileSync(new URL('../scripts/release/'+file,import.meta.url),'utf8').replace(/\r\n/gu,'\n').replace(/^import [^\n]*;\n/gmu,'').replace(/export (async )?(function|const)/gu,'$1$2');return new Function('assert','createHash',...Object.keys(scope),source+';return {'+names.join(',')+'};')(assert,createHash,...Object.values(scope));}
const {portalMailReadRequest,portalTicketRead}=functions('simulation-portal-email-quality.mjs',['portalMailReadRequest','portalTicketRead']);
const request=(operation,input={},method='POST',path='/api/inbox')=>({url:()=> 'https://portal.test'+path,method:()=>method,postDataJSON:()=>({operation,input})});
test('current quality observes only exact ticket read and blocks every mutation',()=>{
 for(const operation of['CHECK','LIST','SHOW','ARTICLES','ARTICLE_CONTENT','CREATE_OPTIONS','PREVIEW'])assert(portalMailReadRequest(request(operation),'https://portal.test'));
 for(const operation of['REPLY','UPDATE','CREATE_TICKET','REMOVE_UPLOAD','RECEIPT','MAILBOX_PAUSE','TEAM_GRANT_SAVE','UNKNOWN'])assert(!portalMailReadRequest(request(operation),'https://portal.test'));
 assert(portalTicketRead(request('SHOW',{ticket_id:'42'}),'https://portal.test',42));assert(!portalTicketRead(request('SHOW',{ticket_id:'43'}),'https://portal.test',42));assert(!portalTicketRead(request('REPLY',{ticket_id:'42'}),'https://portal.test',42));assert(!portalTicketRead(request('SHOW',{ticket_id:'42'},'POST','/graphql'),'https://portal.test',42));
});
const {assertPortalMailEffectDelta}=functions('simulation-portal-mail-effects.mjs',['assertPortalMailEffectDelta']);
function packet(){const customer={articleId:1,ticketId:42,messageId:'incoming',sender:'Customer',internal:false,type:'email',bodySha256:'incoming'},ticket={id:42,groupId:2,updatedAt:'before'},reply={articleId:2,ticketId:42,messageId:'<reply@alpha.invalid>',sender:'Agent',internal:false,type:'email',createdById:8,deliveryChannelId:7,deliveryStatus:'success',deliveryRetry:1,ccBlank:true,to:'customer@alpha.invalid'};
 const before={nativeQueueTotal:0,pendingEmailJobs:0,configSha256:'config',sourceHashes:{source:'hash'},tickets:[ticket],articles:[customer],notificationHistory:[],nativeUserIds:[8,9]},after={...before,tickets:[{...ticket,updatedAt:'after'}],articles:[customer,reply],notificationHistory:[]},rows=[{type:'accepted',messageId:'reply@alpha.invalid',from:'support-suite@alpha.invalid',recipients:['customer@alpha.invalid']}];
 return{before,after,baseline:[],rows,spec:{channelId:7,mailbox:'support-suite@alpha.invalid',allowedRecipients:['customer@alpha.invalid','failure-suite@alpha.invalid'],allowedSenders:['support-suite@alpha.invalid']},namespace:'suite',step:'reply',ticketId:42,articleId:2,operation:{actorId:8},nativeUserId:'8'};}
test('current native/provider delta binds actual actor, sole SMTP acceptance and unchanged preimage',()=>{
 const value=packet();assert.equal(assertPortalMailEffectDelta(value).deliveries.length,1);
 for(const mutate of[value=>value.rows.push({...value.rows[0],messageId:'unexplained'}),value=>value.after.articles[1].createdById=9,value=>value.after.nativeQueueTotal=1,value=>value.after.configSha256='changed',value=>value.after.articles[0]={...value.after.articles[0],bodySha256:'changed'}]){const value=packet();mutate(value);assert.throws(()=>assertPortalMailEffectDelta(value));}
});
test('current failure accounts for all four native rejections and one related safe note',()=>{
 const value=packet();value.step='failure';value.failedArticleId=2;value.after.articles[1]={...value.after.articles[1],to:'failure-suite@alpha.invalid',deliveryStatus:'fail',deliveryRetry:4};value.after.articles.push({articleId:3,ticketId:42,type:'note',sender:'System',internal:true,relatedArticleId:2});value.rows=Array.from({length:4},(_,index)=>[{type:'fault-consumed',kind:'reject',faultId:'suite-reject-'+index},{type:'rejected',messageId:'reply@alpha.invalid',from:'support-suite@alpha.invalid',recipients:['failure-suite@alpha.invalid']}]).flat();assert.equal(assertPortalMailEffectDelta(value).rejectedCount,4);assert.throws(()=>assertPortalMailEffectDelta({...value,rows:value.rows.slice(2)}));assert.throws(()=>assertPortalMailEffectDelta({...value,rows:[...value.rows,{type:'accepted',messageId:'reply@alpha.invalid',from:'support-suite@alpha.invalid',recipients:['failure-suite@alpha.invalid']}]}));
});
test('successor catalog keeps historical IDs and exact extra role obligations',()=>{
 const historicalQuality=Array.from({length:16},(_,index)=>({id:'quality-'+index,expectedResults:['unchanged']}));const portalOperatorContexts=role=>['desktop','tablet','mobile'].map(name=>({contextId:role+'-en-'+name}));const definitions=functions('simulation-portal-email-definitions.mjs',['portalEmailBusinessIds','portalEmailFailureIds','portalEmailQualityDefinitions','portalRoutingFiveIds','portalRoutingSupportId','portalEmailContextRequirements'],{historicalQuality,portalOperatorContexts});
 assert.equal(definitions.portalEmailBusinessIds.length,4);assert.equal(definitions.portalEmailFailureIds.length,2);assert.equal(definitions.portalEmailQualityDefinitions.length,16);assert.equal(definitions.portalRoutingFiveIds.length,5);
 const contexts=definitions.portalEmailContextRequirements;assert.equal(contexts[definitions.portalRoutingFiveIds[2]].length,7);assert.equal(contexts[definitions.portalRoutingSupportId].length,1);assert(Object.keys(contexts).every(id=>id.endsWith('::portal')));for(const id of[...definitions.portalEmailBusinessIds,...definitions.portalEmailFailureIds])assert.deepEqual(contexts[id],['agent-en-desktop','agent-en-tablet','agent-en-mobile']);
});

const {routingRoleReadRequest,bindRoutingRoleObservation}=functions('simulation-portal-routing-roles.mjs',['routingRoleReadRequest','bindRoutingRoleObservation']);
test('routing role guard admits only the exact saved draft read, independent of form field order',()=>{
 const expected={draftId:'draft',match:{email:'proof@alpha.invalid',entryGroupId:'2'}},make=(path,body,method='POST')=>({url:()=> 'https://portal.test'+path,method:()=>method,postDataJSON:()=>body});
 assert(routingRoleReadRequest(make('/api/client-routing/simulate',{versionId:'draft',match:{entryGroupId:'2',email:'proof@alpha.invalid'}}),'https://portal.test',expected));
 for(const value of[make('/api/client-routing/simulate',{versionId:'other',match:expected.match}),make('/api/client-routing/simulate',{versionId:'draft',match:{...expected.match,email:'other@alpha.invalid'}}),make('/api/client-routing/draft/activate',{}),make('/api/inbox',{operation:'REPLY'}),make('/api/team/members/member',{},'PATCH')])assert(!routingRoleReadRequest(value,'https://portal.test',expected));
});
test('routing role binding requires current membership, measured role and bounded draft observation without native claims',()=>{
 const binding={contractVersion:2,surface:'portal',scope:'routing-read-observation',role:'auditor',locale:'en',memberState:'ACTIVE',memberVersion:8,viewport:{width:1440,height:1000},actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),draftId:'draft',draftSha256:'c'.repeat(64),verificationWindow:{startedAt:'2026-10-18T00:00:00Z',finishedAt:'2026-10-18T00:00:03Z'}},row={testId:'routing::portal',contextId:'auditor-en-desktop',result:'passed',startedAt:'2026-10-18T00:00:01Z',finishedAt:'2026-10-18T00:00:02Z',proof:{draftId:'draft',draftSha256:'c'.repeat(64)}};
 assert.equal(bindRoutingRoleObservation(row,binding).proof.actorVerified,true);
 for(const change of[{scope:'inbox'},{role:'agent'},{memberState:'SUSPENDED'},{memberVersion:0},{viewport:{width:390,height:844}},{nativeUserId:'7'},{draftId:'other'},{verificationWindow:{...binding.verificationWindow,startedAt:'2026-10-18T00:00:02Z'}}])assert.throws(()=>bindRoutingRoleObservation(row,{...binding,...change}));
});
test('notification accounting retains distinct synchronous acceptances for repeated notifications to one user',()=>{
 const value=packet(),at='2026-10-18T00:00:01Z',user=9,email='agent@alpha.invalid';value.spec.allowedRecipients.push(email);const sha=createHash('sha256').update(email).digest('hex');
 for(let index=0;index<2;index++){value.after.notificationHistory.push({id:index+1,ticketId:42,userId:user,channels:['email'],createdById:index?1:8,recipientSha256:sha,createdAt:at});value.rows.push({type:'accepted',messageId:'notification.20261018000000.42.9.00000000-0000-4000-8000-00000000000'+index+'@alpha.invalid',from:value.spec.mailbox,recipients:[email],at});}
 assert.equal(assertPortalMailEffectDelta(value).notifications.length,2);assert.throws(()=>assertPortalMailEffectDelta({...value,rows:value.rows.slice(0,-1)}));value.after.notificationHistory[0].createdAt='2026-10-18T00:01:01Z';assert.throws(()=>assertPortalMailEffectDelta(value));
});

const {assertPortalReplyReadback,markPortalMailFailure}=functions('simulation-portal-email-vertical.mjs',['assertPortalReplyReadback','markPortalMailFailure']);
test('the one APPLIED reply receipt pins exact native article and ticket readback',()=>{
 const receipt={state:'APPLIED',articleId:'2',ticketId:'42'},article={articleId:2,ticketId:42};assertPortalReplyReadback(receipt,article,42);
 for(const [actualReceipt,actualArticle,target]of[[{...receipt,state:'UNKNOWN'},article,42],[receipt,{...article,articleId:3},42],[receipt,{...article,ticketId:43},42],[receipt,article,43]])assert.throws(()=>assertPortalReplyReadback(actualReceipt,actualArticle,target));
});
test('only explicit quiet action boundaries permit settled UI failure containment',()=>{
 const receipt={lastStep:'reply',nativeSha256:'a'.repeat(64)};const quiet=markPortalMailFailure(Error('identity changed'),'QUIET',receipt);assert.equal(quiet.portalMailSettled,true);assert.deepEqual(quiet.mailEffectReceipt,receipt);
 for(const state of['PENDING','UNADMITTED']){const error=Object.assign(Error('original operation unknown'),{portalMailSettled:true,mailEffectReceipt:receipt});markPortalMailFailure(error,state,receipt);assert.equal(error.portalMailSettled,undefined);assert.equal(error.mailEffectReceipt,undefined);}
 assert.equal(markPortalMailFailure(Error('no receipt'),'QUIET',undefined).portalMailSettled,undefined);
});
test('finite effects reject new unrelated empty tickets and changed or removed native notification history',()=>{
 const initial=packet(),history={id:11,ticketId:42,userId:9,channels:['online'],createdById:8};initial.before.notificationHistory=[history];initial.after.notificationHistory=[{...history}];assertPortalMailEffectDelta(initial);
 for(const mutate of[value=>value.after.tickets.push({id:99}),value=>value.after.tickets=[],value=>value.after.notificationHistory=[],value=>value.after.notificationHistory[0]={...value.after.notificationHistory[0],createdById:1}]){const value=structuredClone(initial);mutate(value);assert.throws(()=>assertPortalMailEffectDelta(value));}
});
