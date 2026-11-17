import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMetaDeletionDevFixture} from '../scripts/release/meta-deletion-dev-fixture.mjs';
import {validateMetaDeletionPages,runMetaDeletionDevJourney,createDeletionReviewRoute} from '../scripts/release/meta-deletion-journey.mjs';
import {composeDeletionDevJourney,createDeletionRelayFixture,verifyDeletionPlatformPage} from '../scripts/release/meta-deletion-dev-browser.mjs';
import {validateDeletionMigrationBinding,validateDeletionMigrationLedger,validateDeletionInstalledConfiguration,validateDeletionPreservation,postDeletionCallback} from "../scripts/release/meta-deletion-dev-guest.mjs";
import {verifyMetaDeletionRequest,parseMetaDeletionForm} from '../services/control-api/dist/meta-deletion-contract.js';

const secret='fake'.repeat(8),appId='991234567890',namespace='p11-contractfixture01',issuedAt=1800000000;
const digest=value=>createHash('sha256').update(value).digest('hex');
function adapters(){
 let row=null,posts=0,claimed=0;const checkpoints=[],baseline={privacyJobs:'unchanged',providerEffects:'unchanged',nativeEffects:'unchanged',connections:'unchanged',signup:'unchanged'};
 const input={namespace,appId,issuedAt,appSecret:secret,admit:async()=>{},claim:async claim=>{claimed++;assert.match(claim.fixtureSha256,/^[0-9a-f]{64}$/);return{claimed:true,runId:namespace,fixtureSha256:claim.fixtureSha256};},checkpoint:async value=>checkpoints.push(value),readEffects:async()=>baseline,readReceipt:async(_app,hash)=>row?.payload_sha256===hash?row:null,
  postRaw:async(path,bytes,headers)=>{posts++;assert.equal(path,'/webhooks/meta/data-deletion');
   if(headers['content-type']!=='application/x-www-form-urlencoded')return{status:400,body:{error:'invalid'}};
   let verified;try{verified=verifyMetaDeletionRequest(parseMetaDeletionForm(bytes.toString()),appId,secret,issuedAt);}catch{return{status:400,body:{error:'invalid'}};}
   if(verified.issuedAt<issuedAt-2592000)return{status:400,body:{error:'outside-local-window'}};
   row??={id:'10000000-0000-4000-8000-000000000001',app_id:appId,subject_namespace:verified.namespace,subject_digest:verified.subjectDigest,payload_sha256:verified.payloadSha256,verification_key_fingerprint:verified.verificationKeyFingerprint,source_contract_sha256:'454eeedfa72e8f229c02afb78f11ea6579cebc0360906af171b7f282e8c2f539',admission_policy:'META_DELETION_LOCAL_V1_MAX2592000_SKEW300',locator:'a'.repeat(64),state:'SCOPE_REVIEW_REQUIRED',version:1,operation_count:0,review_audit_count:0};
   return{status:200,body:{confirmation_code:row.locator,url:'https://portal.example.invalid/privacy/meta-deletion#'+row.locator}};}};
 return{input,checkpoints,get posts(){return posts;},get claimed(){return claimed;},get row(){return row;},set row(value){row=value;}};
}
test('signed DEV fixture uses production parser, finite dispatch and original observed receipt',async()=>{
 const a=adapters(),fixture=await createMetaDeletionDevFixture(a.input);assert.equal(a.claimed,1);
 await assert.rejects(fixture.dispatch('duplicate'));assert.equal(a.posts,0);
 const accepted=await fixture.dispatch('valid');assert.equal(accepted.status,200);const before=await fixture.observe();
 assert.notEqual(before.subject_digest,digest(namespace));assert.equal(before.verification_key_fingerprint,createHmac('sha256',secret).update('wasalx:meta-deletion:verification-key:v1').digest('hex'));
 const duplicate=await fixture.dispatch('duplicate');assert.deepEqual(duplicate,accepted);
 for(const kind of ['invalid-signature','wrong-mime','malformed','old-new'])assert.equal((await fixture.dispatch(kind)).status,400);
 assert.deepEqual(await fixture.observe(),before);await assert.rejects(fixture.dispatch('valid'));assert.equal(a.posts,6);
 assert(!JSON.stringify(a.checkpoints).includes(secret));assert(!JSON.stringify(a.checkpoints).includes(before.locator));
 assert(!JSON.stringify(a.checkpoints).includes(before.subject_digest));assert(!JSON.stringify(a.checkpoints).includes('signed_request'));
});
test('admission/consumed namespace and unknown dispatch never create an automatic replay',async()=>{
 const denied=adapters();denied.input.admit=async()=>{throw Error('not admitted');};await assert.rejects(createMetaDeletionDevFixture(denied.input));assert.equal(denied.posts,0);assert.equal(denied.claimed,0);
 const consumed=adapters();consumed.input.readReceipt=async()=>({id:'consumed',locator:'private-consumed-marker'});await assert.rejects(createMetaDeletionDevFixture(consumed.input));assert.equal(consumed.claimed,0);
 const unknown=adapters();let calls=0;unknown.input.postRaw=async()=>{calls++;throw Error('transport lost');};const fixture=await createMetaDeletionDevFixture(unknown.input);
 await assert.rejects(fixture.dispatch('valid'),/NO_REPLAY/);await assert.rejects(fixture.dispatch('valid'));await assert.rejects(fixture.dispatch('duplicate'));assert.equal(calls,1);assert.equal(await fixture.observe(),null);
});
test('separate platform/public contexts and exact admitted origin are required before effects',async()=>{
 const shared={},page=context=>({url:()=> 'http://127.0.0.1:3000/platform',context:()=>context});
 const inputs={platformPage:page(shared),publicPage:page(shared),origin:'http://127.0.0.1:3000',statusOrigin:'https://portal.example.invalid',refusalPolicyUrl:'https://policy.example.invalid/retention'};
 assert.throws(()=>validateMetaDeletionPages(inputs));
 assert.throws(()=>validateMetaDeletionPages({...inputs,publicPage:page({}),origin:'http://foreign.example.invalid'}));
 const publicContext={cookies:async()=>[{name:'__Host-wasalx_platform_session'}]};let dispatches=0;
 await assert.rejects(runMetaDeletionDevJourney({...inputs,publicPage:page(publicContext),fixture:{dispatch:async()=>{dispatches++;}},labels:{},admit:async()=>{},lease:async()=>{},verifyPlatform:async()=>true,capture:async()=>{},checkpoint:async()=>{}}));assert.equal(dispatches,0);
});
function assertPrivateError(error){const all=[error.message,error.stack,JSON.stringify(error),JSON.stringify(Object.getOwnPropertyDescriptors(error))].join('\n');assert(!all.includes('PRIVATE_MARKER'));assert(!('actual' in error));assert(!('expected' in error));assert(!('cause' in error));}
test('fixture failures sanitize consumed, key, subject, effects and adapter private values',async()=>{
 for(const defect of ['consumed','key','subject','effects','adapter']){
  const a=adapters();let fixture;
  if(defect==='consumed')a.input.readReceipt=async()=>({locator:'PRIVATE_MARKER_consumed'});
  try{fixture=await createMetaDeletionDevFixture(a.input);}catch(error){assertPrivateError(error);assert.equal(defect,'consumed');continue;}
  await fixture.dispatch('valid');
  if(defect==='key')a.row={...a.row,verification_key_fingerprint:'PRIVATE_MARKER_key'};
  if(defect==='subject')a.row={...a.row,subject_digest:'PRIVATE_MARKER_subject'};
  if(defect==='effects')a.input.readEffects=async()=>({changed:'PRIVATE_MARKER_effect'});
  if(defect==='adapter')a.input.readReceipt=async()=>{throw Error('PRIVATE_MARKER_adapter');};
  // Factory captures adapter functions at creation, so mutate the selected row
  // for effect/read failures through separate deliberately bound closures.
  if(['effects','adapter'].includes(defect)){
   const b=adapters();let changed=false;
   if(defect==='effects')b.input.readEffects=async()=>changed?{value:'PRIVATE_MARKER_effect'}:{};
   else b.input.readReceipt=async()=>{if(changed)throw Error('PRIVATE_MARKER_adapter');return null;};
   const f=await createMetaDeletionDevFixture(b.input);changed=true;await assert.rejects(f.observe(),error=>{assertPrivateError(error);return true;});
  }else await assert.rejects(fixture.observe(),error=>{assertPrivateError(error);return true;});
 }
});
test('negative-specific receipt and original full immutable/count deltas cannot false-pass 400',async()=>{
 const a=adapters(),map=new Map();a.input.readReceipt=async(_app,hash)=>map.get(hash)??null;
 const post=a.input.postRaw;a.input.postRaw=async(...args)=>{const value=await post(...args);if(a.row)map.set(a.row.payload_sha256,a.row);return value;};
 const f=await createMetaDeletionDevFixture(a.input);await f.dispatch('valid');const baseline=structuredClone(await f.observe());await f.verifyNegatives(baseline);
 map.set(digest(Buffer.from(JSON.stringify({algorithm:'HMAC-SHA256',issued_at:issuedAt-2592302,user_id:BigInt('0x'+digest('wasalx:p11:synthetic:'+namespace).slice(0,24)).toString(),expires:0})).toString('base64url')),{id:'PRIVATE_MARKER_rogue'});
 await assert.rejects(f.verifyNegatives(baseline));map.delete([...map.keys()].find(k=>k!==baseline.payload_sha256));
 for(const field of ['operation_count','review_audit_count','received_at','expires_at','admission_policy']){
  const changed={...baseline,[field]:field.includes('count')?1:'PRIVATE_MARKER_changed'};map.set(baseline.payload_sha256,changed);await assert.rejects(f.verifyNegatives(baseline));map.set(baseline.payload_sha256,baseline);
 }
});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function reviewRoute({url='http://127.0.0.1:3000/api/platform-console/meta-deletion/10000000-0000-4000-8000-000000000001/review',status=200,fetchReady,readReady,verify=async()=>{},loss=true}={}){
 const evidenceSha256='d'.repeat(64),body={expectedVersion:2,state:'HELD',reason:'OUTCOME_UNRESOLVED',evidenceSha256},key='20000000-0000-4000-8000-000000000002';let aborted=0,continued=0,fetches=0,fetchOptions;
 const input={origin:'http://127.0.0.1:3000',path:new URL(url).pathname,version:2,state:'HELD',evidenceSha256,loss,verify,observe:async()=>{if(readReady)await readReady.promise;return{version:3,state:'HELD'};},onIntent:()=>{}};
 const request={url:()=>input.origin+input.path,method:()=> 'POST',headers:()=>({'idempotency-key':key,'x-wasalx-platform-csrf':'PRIVATE_MARKER_csrf'}),postDataJSON:()=>body};
 const route={request:()=>request,fetch:async options=>{fetches++;fetchOptions=options;if(fetchReady)await fetchReady.promise;return{url:()=>url,status:()=>status,json:async()=>({id:'10000000-0000-4000-8000-000000000001',state:'HELD',version:3})};},abort:async()=>{aborted++;},continue:async()=>{continued++;}};
 return{input,route,get aborted(){return aborted;},get continued(){return continued;},get fetches(){return fetches;},get fetchOptions(){return fetchOptions;}};
}
test('response-loss proof waits for handler fetch/readback/abort before same-intent retry',async()=>{
 const fetchReady=deferred(),readReady=deferred(),f=reviewRoute({fetchReady,readReady}),owned=createDeletionReviewRoute(f.input);let complete=false;
 const pending=owned.handler(f.route);const observation=owned.waitFirst().then(()=>{complete=true;});
 await Promise.resolve();assert.equal(complete,false);assert.equal(owned.calls,1);fetchReady.resolve();await Promise.resolve();assert.equal(complete,false);
 readReady.resolve();await pending;await observation;assert.equal(f.aborted,1);assert.equal(complete,true);
 assert.equal(f.fetchOptions.maxRedirects,0);assert.equal(f.fetchOptions.maxRetries,0);assert(f.fetchOptions.timeout>0&&f.fetchOptions.timeout<=8000);await owned.handler(f.route);await owned.finish();assert.equal(f.fetches,1);assert.equal(f.continued,1);assert.equal(owned.calls,2);
});
test('handler failure and redirects abort owned request without private failure or replay',async()=>{
 for(const input of [{verify:async()=>{throw Error('PRIVATE_MARKER_guard');}},{url:'http://127.0.0.1:3000/elsewhere',status:302},{url:'https://foreign.example.invalid/',status:307}]){
  const f=reviewRoute(input),owned=createDeletionReviewRoute(f.input);await owned.handler(f.route);await assert.rejects(owned.waitFirst(),error=>{assertPrivateError(error);return true;});await owned.cleanup();assert.equal(f.continued,0);assert.equal(owned.calls,1);assert.equal(f.aborted,1);assert.equal(owned.committed,undefined);
 }
});
test('concrete platform verifier consumes exact origin-selected cookie and real protected request',async()=>{
 const m={origin:'http://127.0.0.1:3000',p11:{platform:{subjectSha256:'a'.repeat(64),emailSha256:'b'.repeat(64)}}};let calls=0;
 const page={url:()=>m.origin+'/platform',context:()=>({cookies:async()=>[{name:'wasalx_platform_session',value:'c'.repeat(43)}]}),evaluate:async()=>({status:200,url:m.origin+'/api/platform-console/operations/overview'})};
 const relay=async(action,input)=>{calls++;assert.equal(action,'platform-verify');assert.equal(input.sessionId,'c'.repeat(43));return{verified:true,...m.p11.platform};};
 assert.equal(await verifyDeletionPlatformPage(page,m,relay),true);assert.equal(calls,1);
 await assert.rejects(verifyDeletionPlatformPage({...page,evaluate:async()=>({status:401,url:m.origin+'/api/platform-console/operations/overview'})},m,relay));
 await assert.rejects(verifyDeletionPlatformPage({...page,context:()=>({cookies:async()=>[{name:'wasalx_session',value:'PRIVATE_MARKER'}]})},m,relay),error=>{assertPrivateError(error);return true;});
});
test('concrete relay fixture binds claim, dispatch, original and negative readbacks to one source',async()=>{
 const namespace='p11-relaycontract001',m={p11:{namespace}},fixtureSha256='a'.repeat(64),calls=[];let leases=0,changed=false;
 const row={id:'10000000-0000-4000-8000-000000000001',state:'REFUSED',version:4,operation_count:3,review_audit_count:3};
 const relay=async(action,input)=>{calls.push({action,input});if(action==='claim')return{claimed:true,runId:namespace,fixtureSha256};if(action==='dispatch')return{status:200,body:{}};if(action==='observe')return row;if(action==='negative-observe')return changed?{...row,operation_count:4}:row;throw Error('PRIVATE_MARKER_unknown');};
 const f=await createDeletionRelayFixture({m,relay,lease:async()=>{leases++;},admitted:{admitted:true,namespace,fixtureSha256}});
 await f.dispatch('valid');assert.deepEqual(await f.observe(),row);await f.verifyNegatives(row);await f.verifyNoEffects();assert.equal(leases,5);
 assert.deepEqual(calls.map(v=>v.action),['claim','dispatch','observe','negative-observe','negative-observe']);assert.deepEqual(calls[1].input,{kind:'valid'});
 changed=true;await assert.rejects(f.verifyNegatives(row));
 await assert.rejects(createDeletionRelayFixture({m,relay,lease:async()=>{},admitted:{admitted:true,namespace:'foreign',fixtureSha256}}));
});
test('foreign receipt or changed independent effects cannot be labeled installed observation',async()=>{
 const a=adapters(),fixture=await createMetaDeletionDevFixture(a.input);await fixture.dispatch('valid');a.row={...a.row,app_id:'another-app'};await assert.rejects(fixture.observe());
 const b=adapters();let changed=false;b.input.readEffects=async()=>({nativeEffects:changed?'changed':'unchanged'});const second=await createMetaDeletionDevFixture(b.input);changed=true;await assert.rejects(second.verifyNoEffects());
});

// Actual filesystem closure check only; no guest action, auth or transport.
test('standard-library entry validates complete frozen closure before importing an adapter',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'wasalx-p11-closure-'));
 try{
  const names=['meta-deletion-dev-fixture.mjs','meta-deletion-journey.mjs','meta-deletion-dev-guest.mjs','meta-deletion-dev-browser.mjs','meta-deletion-dev-entry.mjs'];
  const entry=await readFile(new URL('../scripts/release/meta-deletion-dev-entry.mjs',import.meta.url));
  const raws=new Map(names.map(name=>[name,name==='meta-deletion-dev-entry.mjs'?entry:Buffer.from('export const inert=true;\n')]));
  for(const [name,bytes]of raws)await writeFile(join(folder,name),bytes);
  const files=names.map(path=>({path,sha256:digest(raws.get(path))}));
  const m={guestDriverSha256:digest(entry),p11:{driverFiles:files,guestModuleSha256:digest(raws.get('meta-deletion-dev-guest.mjs'))}};
  const manifest=join(folder,'manifest.json');const persist=async()=>{const raw=JSON.stringify(m);await writeFile(manifest,raw);return digest(raw);};
  const {verifyDeletionDriverClosure,runBrowser}=await import(pathToFileURL(join(folder,'meta-deletion-dev-entry.mjs')));
  assert.deepEqual(await verifyDeletionDriverClosure(manifest,await persist()),m);
  m.p11.driverFiles=files.filter(f=>f.path!=='meta-deletion-dev-fixture.mjs');
  await assert.rejects(verifyDeletionDriverClosure(manifest,await persist()));
  m.p11.driverFiles=files;
  await writeFile(join(folder,'meta-deletion-dev-browser.mjs'),"throw Error('PRIVATE_MARKER_unimported');\n");
  const unbound="import './PRIVATE_MARKER_unbound.mjs';\n";await writeFile(join(folder,'meta-deletion-dev-browser.mjs'),unbound);
  files.find(f=>f.path==='meta-deletion-dev-browser.mjs').sha256=digest(unbound);
  await assert.rejects(verifyDeletionDriverClosure(manifest,await persist()),error=>{assertPrivateError(error);return true;});
  m.p11.driverFiles=files.filter(f=>f.path!=='meta-deletion-dev-guest.mjs');
  await assert.rejects(verifyDeletionDriverClosure(manifest,await persist()));
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('installed composition checks current platform and public cookies before durable claim',async()=>{
 const origin='http://127.0.0.1:3000',namespace='p11-composition001',m={origin,p11:{namespace,platform:{subjectSha256:'a'.repeat(64),emailSha256:'b'.repeat(64)}}};
 const calls=[];const relay=async(action)=>{calls.push(action);if(action==='admit')return{admitted:true,namespace,fixtureSha256:'c'.repeat(64),nonfixtureReceipts:{count:0,sha256:'f'.repeat(64)}};if(action==='platform-verify')return{verified:true,...m.p11.platform};throw Error('PRIVATE_MARKER_unexpected_claim');};
 const platformPage={url:()=>origin+'/platform',context:()=>({cookies:async()=>[{name:'wasalx_platform_session',value:'d'.repeat(43)}]}),evaluate:async()=>({status:200,url:origin+'/api/platform-console/operations/overview'})};
 const publicPage={context:()=>({cookies:async()=>[{name:'wasalx_session',value:'PRIVATE_MARKER_tenant'}]})};
 await assert.rejects(composeDeletionDevJourney({m,platformPage,publicPage,relay,lease:async()=>{}}),error=>{assertPrivateError(error);return true;});
 assert.deepEqual(calls,['admit','platform-verify']);
});


test('terminal cleanup fences a deferred route prerequisite before any independent fetch or continue',async()=>{
 const ready=deferred(),f=reviewRoute({verify:()=>ready.promise}),owned=createDeletionReviewRoute(f.input);
 const pending=owned.handler(f.route);const observed=owned.waitFirst();const cleanup=owned.cleanup();ready.resolve();
 await pending;await cleanup;await assert.rejects(observed);assert.equal(f.fetches,0);assert.equal(f.continued,0);assert(f.aborted>=1);
});
test('timeout fences delayed prerequisite even when it resolves after owned cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const ready=deferred(),f=reviewRoute({verify:()=>ready.promise}),owned=createDeletionReviewRoute(f.input);
  const pending=owned.handler(f.route),observed=owned.waitFirst();t.mock.timers.tick(8000);await assert.rejects(observed);
  ready.resolve();await pending;await owned.cleanup();assert.equal(f.fetches,0);assert.equal(f.continued,0);
 }finally{t.mock.timers.reset();}
});
test('lease expiry during a lightweight awaited prerequisite prevents review dispatch',async()=>{
 const ready=deferred();let active=true;
 const f=reviewRoute({verify:async()=>{await ready.promise;if(!active)throw Error('PRIVATE_MARKER_expired');}}),owned=createDeletionReviewRoute(f.input);
 const pending=owned.handler(f.route);active=false;ready.resolve();await pending;await assert.rejects(owned.waitFirst());await owned.cleanup();assert.equal(f.fetches,0);assert.equal(f.continued,0);
});
test('complete installed configuration and root-reviewed composed migration are required before claim',()=>{
 const p={statusOrigin:'https://portal.example.invalid',refusalPolicyUrl:'https://policy.example.invalid/refusal',helpUrl:'https://policy.example.invalid/help',maxAgeSeconds:300,retentionDays:1};
 const e={META_DELETION_STATUS_ORIGIN:p.statusOrigin,META_DELETION_REFUSAL_POLICY_URL:p.refusalPolicyUrl,META_DELETION_HELP_URL:p.helpUrl,META_DELETION_MAX_REQUEST_AGE_SECONDS:'300',META_DELETION_RECEIPT_RETENTION_DAYS:'1'};
 validateDeletionInstalledConfiguration(e,p);
 for(const value of [undefined,'http://PRIVATE_MARKER.invalid/',"https://fixture:placeholder@api.example.test/path"])assert.throws(()=>validateDeletionInstalledConfiguration({...e,META_DELETION_HELP_URL:value},p),error=>{assertPrivateError(error);return true;});
 const migration={path:'services/control-api/migrations/0199_meta_deletion.sql',sha256:'a'.repeat(64),rootReviewSha256:'b'.repeat(64),historicalProposalSha256:'91f24a615f3e9e970593a7b2346d766c1b3f0e9a027c87da24f45a0c107be5ec'};
 const files=[{path:migration.path,sha256:migration.sha256}],ledger=[{name:'0199_meta_deletion.sql',checksum_sha256:migration.sha256}];
 validateDeletionMigrationBinding(migration,files);validateDeletionMigrationLedger(migration,ledger);
 assert.throws(()=>validateDeletionMigrationBinding({...migration,path:migration.path.replace('0199','0198')},files));
 assert.throws(()=>validateDeletionMigrationBinding(migration,[{...files[0],sha256:'c'.repeat(64)}]));
 assert.throws(()=>validateDeletionMigrationLedger(migration,[{...ledger[0],checksum_sha256:'c'.repeat(64)}]));
});
function callbackRequestFixture(){const q=new EventEmitter(),r=new EventEmitter();let calls=0,ends=0,closed=0;
 q.end=()=>{ends++;};q.destroy=()=>{closed++;};r.destroy=()=>{closed++;};r.statusCode=200;
 return{q,r,get calls(){return calls;},get ends(){return ends;},get closed(){return closed;},request:(_options,callback)=>{calls++;queueMicrotask(()=>callback(r));return q;}};
}
test('callback total deadline stops a trickling body with exactly one UNKNOWN send and no retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const f=callbackRequestFixture(),pending=postDeletionCallback('127.0.0.1',{mime:'application/x-www-form-urlencoded',body:Buffer.from('PRIVATE_MARKER')},new Date(Date.now()+20000).toISOString(),f.request);
  await Promise.resolve();for(let i=0;i<7;i++){f.r.emit('data',Buffer.from(' '));t.mock.timers.tick(1000);}t.mock.timers.tick(1000);
  await assert.rejects(pending,error=>{assertPrivateError(error);assert.match(error.message,/UNKNOWN_NO_REPLAY/);return true;});assert.equal(f.calls,1);assert.equal(f.ends,1);assert(f.closed>=1);
 }finally{t.mock.timers.reset();}
});
test('normal callback completion clears deadline; expired action lease dispatches nothing',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const f=callbackRequestFixture(),wire={mime:'application/x-www-form-urlencoded',body:Buffer.from('x')},pending=postDeletionCallback('127.0.0.1',wire,new Date(Date.now()+20000).toISOString(),f.request);
  await Promise.resolve();f.r.emit('data',Buffer.from('{}'));f.r.emit('end');assert.deepEqual(await pending,{status:200,body:{}});t.mock.timers.tick(20000);assert.equal(f.closed,0);
  const denied=callbackRequestFixture();await assert.rejects(postDeletionCallback('127.0.0.1',wire,new Date(Date.now()-1).toISOString(),denied.request));assert.equal(denied.calls,0);
 }finally{t.mock.timers.reset();}
});
test('eligible cross-app receipt or upcoming maintenance crossing holds; global baseline detects all changes',()=>{
 const safe={count:2,sha256:'a'.repeat(64),maintenance_eligible:false};assert.deepEqual(validateDeletionPreservation(safe),{count:2,sha256:safe.sha256});
 for(const row of [{...safe,maintenance_eligible:true},{...safe,count:2001},{...safe,sha256:'PRIVATE_MARKER'}])assert.throws(()=>validateDeletionPreservation(row),error=>{assertPrivateError(error);return true;});
 const original=validateDeletionPreservation(safe);
 for(const row of [{...safe,count:3},{...safe,count:1},{...safe,sha256:'b'.repeat(64)}])assert.notDeepEqual(validateDeletionPreservation(row),original);
});

test('cleanup bounds stalled abort and owned unroute while late verification cannot dispatch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const ready=deferred(),never=deferred(),f=reviewRoute({verify:()=>ready.promise}),owned=createDeletionReviewRoute(f.input);
  f.route.abort=()=>never.promise;const pending=owned.handler(f.route),observed=owned.waitFirst();observed.catch(()=>{});
  let returned=false,unroutes=0;const cleanup=owned.cleanup(()=>{unroutes++;return never.promise;}).then(()=>{returned=true;});
  await Promise.resolve();await Promise.resolve();assert.equal(returned,false);t.mock.timers.tick(500);await cleanup;
  assert.equal(returned,true);assert.equal(unroutes,1);ready.resolve();await pending;await assert.rejects(observed);
  assert.equal(f.fetches,0);assert.equal(f.continued,0);
 }finally{t.mock.timers.reset();}
});
test('stalled continuation acknowledgement bounds finish and permanently stops later attempts',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const never=deferred(),started=deferred(),f=reviewRoute({loss:false}),owned=createDeletionReviewRoute(f.input);
  f.route.continue=()=>{started.resolve();return never.promise;};const pending=owned.handler(f.route);
  await started.promise;const finished=owned.finish();finished.catch(()=>{});t.mock.timers.tick(8000);
  await assert.rejects(finished);await pending;await assert.rejects(owned.waitFirst());await owned.cleanup();
  await owned.handler(f.route);assert.equal(owned.calls,1);assert.equal(f.fetches,0);
 }finally{t.mock.timers.reset();}
});
test('stalled known-commit abort acknowledgement never grants response-loss retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 try{const never=deferred(),started=deferred(),f=reviewRoute(),owned=createDeletionReviewRoute(f.input);
  f.route.abort=()=>{started.resolve();return never.promise;};const pending=owned.handler(f.route);
  await started.promise;const observed=owned.waitFirst();observed.catch(()=>{});t.mock.timers.tick(8000);
  await pending;await assert.rejects(observed);await assert.rejects(owned.finish());await owned.cleanup();
  await owned.handler(f.route);assert.equal(owned.calls,1);assert.equal(f.fetches,1);assert.equal(f.continued,0);
 }finally{t.mock.timers.reset();}
});

test('queued cancellation between outer guard and deferred continuation dispatches nothing',async()=>{
 let owned,cleanup;
 const f=reviewRoute({loss:false,verify:async()=>{
  // Outer microtask runs before the resumed await; its child cancels after
  // that resume schedules bounded work, but before the work can dispatch.
  queueMicrotask(()=>queueMicrotask(()=>{cleanup=owned.cleanup();}));
 }});
 owned=createDeletionReviewRoute(f.input);await owned.handler(f.route);await cleanup;
 await assert.rejects(owned.waitFirst());assert.equal(owned.calls,1);assert.equal(f.fetches,0);assert.equal(f.continued,0);
});
