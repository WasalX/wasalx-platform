import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {mailFixture} from '../scripts/release/simulation-mail-fixtures.mjs';import {bounceFixture} from '../scripts/release/simulation-bounce-fixture.mjs';import {makeRoutingDraft} from '../scripts/release/simulation-routing-five.mjs';import {persistFreshMailRecord} from '../scripts/release/simulation-mail-record.mjs';import {runFreshEmailVertical} from '../scripts/release/simulation-email-vertical.mjs';import {runFreshNativeMailFailureBounce} from '../scripts/release/simulation-email-failure.mjs';
import {makeEmailRoutingDefinition} from '../scripts/release/simulation-email-stages.mjs';
import {parseClientRouting,clientRoutingApplies,clientRoutingTargetBlockers,resolveClientRoute} from '../packages/core/dist/client-routing.js';

test('email setup satisfies the real support-entry activation and matching contract',()=>{
 const definition=parseClientRouting(makeEmailRoutingDefinition('suite-123',4));
 const catalog={groups:[{id:'4',active:true,serviceIdentityCanCreate:true}],owners:[]};
 assert.deepEqual(clientRoutingTargetBlockers(definition,catalog),[]);
 assert.equal(clientRoutingApplies(definition,'4'),true);
 assert.equal(clientRoutingApplies(definition,'9'),false);
 assert.equal(resolveClientRoute(definition,{email:'customer@alpha.invalid',entryGroupId:'4'}).matchedBy,'EMAIL');
});

test('DSN fixture preserves the original MIME without asserting auto-response classification',()=>{
 const original=mailFixture({runId:'bounce-contract',phase:'initial'}).bytes;
 const {bytes}=bounceFixture({runId:'bounce-contract',to:'support@alpha.invalid',recipient:'customer@alpha.invalid',original,date:'2026-09-12T00:00:00.000Z'});
 const mime=bytes.toString('utf8'),headers=mime.split('\r\n\r\n',1)[0];
 assert.match(headers,/Content-Type: multipart\/report; report-type=delivery-status/);
 assert.doesNotMatch(headers,/^(Auto-Submitted|Precedence|X-Auto-Response-Suppress):/im);
 assert(mime.includes('Action: failed\r\nStatus: 5.1.1'));
 assert(mime.includes('Content-Type: message/rfc822\r\n\r\n'+original.toString('utf8')));
});
test('current namespace produces stable MIME and thread IDs; bounce timestamp explicit',()=>{const a=mailFixture({runId:'suite-123',phase:'initial'}),b=mailFixture({runId:'suite-124',phase:'initial'});assert.notEqual(a.messageId,b.messageId);assert.equal(a.sha256,mailFixture({runId:'suite-123',phase:'initial'}).sha256);const input={runId:'suite-123',to:'support@alpha.invalid',recipient:'customer@alpha.invalid',original:a.bytes,date:'2026-09-12T00:00:00.000Z'};assert.deepEqual(bounceFixture(input),bounceFixture(input));assert.throws(()=>bounceFixture({...input,date:undefined}));});
test('routing uses producer group and connection without oldest-row fallback',()=>{const r=makeRoutingDraft('suite-123',{id:4},{id:8},'new-connection','120001@g.us',{id:9});const m=r.definition.clients[0].matchers.find(x=>x.kind==='WHATSAPP_GROUP');assert.equal(m.connectionId,'new-connection');assert.equal(m.value,'120001@g.us');assert.throws(()=>makeRoutingDraft('suite-123',{id:4},{id:8},'x',undefined,{id:9}));});
test('routing draft scopes client assignment to support entry and preserves a distinct department',()=>{const r=makeRoutingDraft('suite-123',{id:4},{id:8},'new-connection','120001@g.us',{id:9});assert.deepEqual(r.definition.supportGroupIds,['4']);assert.equal(r.fixture.supportGroupId,'4');assert.equal(r.fixture.departmentGroupId,'9');assert.throws(()=>makeRoutingDraft('suite-123',{id:4},{id:8},'x','120001@g.us',{id:4}));});
test('durable exclusive record prevents uncertain operation replay and retains original bytes',async()=>{const dir=await mkdtemp(join(tmpdir(),'wasalx-mail-'));try{const intent={state:'OUTCOME_UNKNOWN',bytesBase64:'YWJj'};await persistFreshMailRecord(dir,'initial-intent',intent);await assert.rejects(persistFreshMailRecord(dir,'initial-intent',{state:'retry'}),{code:'EEXIST'});assert.deepEqual(JSON.parse(await readFile(join(dir,'initial-intent.json'))),intent);}finally{await rm(dir,{recursive:true});}});
test('adapted leaves fail closed before callbacks without producers and contain no retained IDs',async()=>{await assert.rejects(runFreshEmailVertical({runId:'suite-123'}));await assert.rejects(runFreshNativeMailFailureBounce({runId:'suite-123'}));for(const file of ['../scripts/release/simulation-email-vertical.mjs','../scripts/release/simulation-email-failure.mjs','../scripts/release/simulation-email/native-failure-fixture.rb','../scripts/release/simulation-routing-five.mjs']){const s=await readFile(new URL(file,import.meta.url),'utf8');assert(!/scenario-emailvertical01|Ticket::Article.find\(25\)|tickets\/9|ticketId:9|channelId:3|ORDER BY created_at LIMIT 1/.test(s),file);}});
test('email wrappers expose behavioral rows while setup and teardown remain supporting',async()=>{const stages=await readFile(new URL('../scripts/release/simulation-email-stages.mjs',import.meta.url),'utf8'),vertical=await readFile(new URL('../scripts/release/simulation-email-vertical.mjs',import.meta.url),'utf8');assert(stages.includes('results:mergeNativeBusinessRows(result.results,nativeRows)'));assert(stages.includes('results:[...ownerRows,...nativeRows]'));assert(stages.includes('nativeSourceRows=result.rows.filter(row=>row.testId!==routingSupportScopeId)'));assert(vertical.includes('articleId:sent.articles[0].articleId'));assert(vertical.includes('reply-delivery-and-bounce-states-render-in-zammad::01'));});
