import test from 'node:test';import assert from 'node:assert/strict';
import {caseChecks,qualityChecks,navigationId,previewId,exactRows,admitCaseActor,assertPreviewReadOnly,assertReplyEffects,restorationPlan,allowCaseReadPost} from '../scripts/release/simulation-portal-case-contract.mjs';
import {assertIncludedReceipt} from '../scripts/release/simulation-sender-policy.mjs';
import {createHash} from 'node:crypto';
const rows=checks=>checks.map(c=>({...c,result:'passed'}));
test('read-only quality guards permit actual signed read POSTs while blocking effects and foreign origins',()=>{
 const request=(operation,{url='https://portal.test/api/inbox',method='POST',input={},extra={}}={})=>({url:()=>url,method:()=>method,postDataJSON:()=>({operation,input,...extra})});
 for(const operation of['CHECK','LIST','SHOW','ARTICLES','ARTICLE_CONTENT'])assert(allowCaseReadPost(request(operation),'https://portal.test'));
 for(const operation of['PREVIEW','REPLY','UPDATE','CREATE_TICKET','RECEIPT','GROUP_ACTION'])assert(!allowCaseReadPost(request(operation),'https://portal.test'));
 for(const options of[{url:'https://foreign.test/api/inbox'},{url:'https://portal.test/api/team'},{method:'PUT'},{input:[]},{input:null},{extra:{bypass:true}}])assert(!allowCaseReadPost(request('CHECK',options),'https://portal.test'));
 assert(!allowCaseReadPost({url(){throw Error('missing')}},'https://portal.test'));
});
function actorFixture(){return{s:{tenantId:'tenant',capabilities:{secondActor:{userId:'agent',subject:'oidc'}}},args:{namespace:'owned',inputs:{remainingQuality:{caseLifecycle:{group:{namespace:'owned',tenantId:'tenant'}}},secondActor:{userId:'agent',subject:'oidc',tenantId:'tenant'},nativeAccountAccess:{namespace:'owned',tenantId:'tenant',results:[{testId:'team-access/roles-invitations-revocation-and-last-owner-protection::native-account-linking-requires-owner-review-and-current-membership::01',result:'passed'}]},caseNavigation:{namespace:'owned',tenantId:'tenant',proofs:rows(caseChecks.filter(c=>c.testId===navigationId))}}}};}
test('bounded checks schedule exact actor widths and reject missing/duplicate/foreign proof',()=>{
 assert.equal(caseChecks.length,23);assert.equal(qualityChecks.length,17);
 assert.equal(caseChecks.filter(c=>c.testId===previewId).length,2);
 assert.equal(caseChecks.some(c=>c.contextId.includes('zammad_agent')),false);
 assert.equal(caseChecks.some(c=>c.contextId.startsWith('auditor-')||c.contextId==='tenant_owner-en-mobile'),false);
 assert.equal(exactRows(rows(caseChecks),caseChecks),'passed');
 for(const malformed of[rows(caseChecks).slice(1),[...rows(caseChecks),rows(caseChecks)[0]],rows(caseChecks).map((r,i)=>i? r:{...r,contextId:'agent-ar-mobile'})])assert.throws(()=>exactRows(malformed,caseChecks));
 const unknown=rows(caseChecks);unknown[0].result='unknown';assert.equal(exactRows(unknown,caseChecks),'unknown');unknown[1].result='failed';assert.equal(exactRows(unknown,caseChecks),'failed');
});
test('authority uses current actor source receipts and current exact navigation, never empty every()',()=>{
 const f=actorFixture();assert.equal(admitCaseActor(f.s,f.args).actor.userId,'agent');
 for(const mutate of[
  f=>f.args.namespace='old',f=>f.args.inputs.secondActor.tenantId='foreign',f=>f.s.capabilities.secondActor.subject='other-oidc',
  f=>f.args.inputs.nativeAccountAccess.results[0].result='blocked',f=>f.args.inputs.nativeAccountAccess.namespace='old',
  f=>f.args.inputs.caseNavigation.proofs=[],f=>f.args.inputs.caseNavigation.proofs[0].result='blocked',f=>f.args.inputs.caseNavigation.proofs[0].contextId='zammad_agent-en-desktop',
 ]){const x=actorFixture();mutate(x);assert.throws(()=>admitCaseActor(x.s,x.args));}
});
function effects(){const before={native:{articleIds:['old'],articles:[{id:'old'}]},outbox:[],executions:[],provider:{receipts:[]}};const delivery={id:'d',state:'SENT',attempts:1,zammad_article_id:'new',ticket_event_execution_id:'e',message_body:'Formatted draft',reply_to_message_id:'original'},execution={id:'e',state:'APPLIED',mode:'CUSTOM',flow_version_id:'flow'};const after={native:{articleIds:['old','new'],articles:[{id:'old'},{id:'new',internal:false,body:'draft'}]},outbox:[delivery],executions:[execution],provider:{receipts:[{id:'provider'}]}};return{before,after,delivery,execution,flowId:'flow',draft:'draft',expectedText:'Formatted draft',originalMessageId:'original'};}
test('preview rejects each newly admitted durable/external effect',()=>{const f=effects();assertPreviewReadOnly(f.before,structuredClone(f.before));for(const change of[x=>x.native.articles.push({id:'extra'}),x=>x.native.operationIds=['receipt'],x=>x.outbox.push({id:'outbox'}),x=>x.executions.push({id:'workflow'}),x=>x.provider.receipts.push({id:'send'})]){const x=structuredClone(f.before);change(x);assert.throws(()=>assertPreviewReadOnly(f.before,x));}});
test('reply proof requires exact native/outbox/workflow identity, state, quote and text',()=>{
 assert.equal(assertReplyEffects(effects()).id,'new');
 for(const mutate of[f=>f.after.outbox.push({...f.delivery,id:'duplicate'}),f=>f.after.native.articles.push({id:'second'}),f=>f.after.executions.push({...f.execution,id:'second'}),f=>f.delivery.state='QUEUED',f=>f.delivery.attempts=2,f=>f.delivery.ticket_event_execution_id='other',f=>f.delivery.zammad_article_id='foreign',f=>f.execution.mode='LEGACY',f=>f.execution.state='PENDING',f=>f.execution.flow_version_id='old',f=>f.delivery.reply_to_message_id='latest',f=>f.delivery.message_body='unformatted',f=>f.after.native.articles[1].internal=true]){const f=effects();mutate(f);assert.throws(()=>assertReplyEffects(f));}
});
test('restoration holds unknown effect and uses current CAS without overwriting concurrent changes',()=>{
 const base={current:{revision:'3',flow_version_id:'owned-flow'},installedRevision:3,flowId:'owned-flow',replyAttempted:false,settled:false};
 assert.deepEqual(restorationPlan(base),{mode:'INHERIT',flowVersionId:null,expectedRevision:3});
 for(const mode of['CUSTOM','OFF','INHERIT'])assert.equal(restorationPlan({...base,saved:{mode,flow_version_id:mode==='CUSTOM'?'old-flow':null}}).mode,mode);
 assert.equal(restorationPlan({...base,replyAttempted:true,settled:false,current:{revision:'999',flow_version_id:'other'}}),null);
 assert.equal(restorationPlan({...base,replyAttempted:true,settled:true}).expectedRevision,3);
 assert.throws(()=>restorationPlan({...base,current:{revision:4,flow_version_id:'owned-flow'}}));
 assert.throws(()=>restorationPlan({...base,current:{revision:3,flow_version_id:'other'}}));
});
test('provider proof rejects missing, duplicate, foreign and mismatched delivered text receipts',()=>{
 const delivery={external_message_id:'true_group_receipt',message_body:'Formatted draft'},receipt={id:'true_group_receipt',textSha256:createHash('sha256').update(delivery.message_body).digest('hex')};
 assert.equal(assertIncludedReceipt({receipts:[]},{receipts:[receipt]},delivery,'group').id,receipt.id);
 for(const receipts of[[],[receipt,{...receipt,id:'duplicate'}],[{...receipt,id:'foreign'}],[{...receipt,textSha256:'wrong'}]])assert.throws(()=>assertIncludedReceipt({receipts:[]},{receipts},delivery,'group'));
});
