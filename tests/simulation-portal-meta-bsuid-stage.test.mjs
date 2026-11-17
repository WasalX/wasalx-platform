import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {open,readFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
const source=readFileSync(new URL('../scripts/release/simulation-portal-meta-bsuid-stage.mjs',import.meta.url),'utf8');
function load(scope={}){return new Function('assert','createHash','open','join',...Object.keys(scope),source.replace(/^import [^\r\n]*;\r?\n/gmu,'').replace(/export (async )?(function|const)/gu,'$1$2')+';return {portalBsuidState,assertPortalBsuidReply,assertPortalBsuidMedia,persistPortalBsuidReplyIntent,submitPortalBsuidReply,portalMetaBsuidStage};')(assert,createHash,open,join,...Object.values(scope));}
const helpers=load(),operation='00000000-0000-4000-8000-000000000001';
const packet=()=>({receipt:{state:'APPLIED',operationId:operation,ticketId:'42',articleId:'4'},article:{id:4,ticket_id:42,created_by_id:9,body:'Human reply',content_type:'text/plain',internal:false,sender:'Agent',type:'wasalx group message'},ticketId:'42',body:'Human reply',nativeUserId:'9'});
const input=()=>({operation_id:operation,ticket_id:'42',expected_updated_at:'2026-10-18T00:00:00Z',body:'Human reply',internal:false});
async function ownedTemp(run){const root=await realpath(tmpdir()),directory=await mkdtemp(join(root,'wasalx-bsuid-unit-'));assert.equal(dirname(directory),root);assert(basename(directory).startsWith('wasalx-bsuid-unit-'));try{return await run(directory);}finally{assert.equal(dirname(directory),root);await rm(directory,{recursive:true,force:true});}}
test('current native state corroboration requires one actual active matching state',()=>{
 assert.equal(helpers.portalBsuidState({state_id:2},[{id:2,name:'open',active:true}]),'open');
 for(const rows of[[],[{id:3,name:'open',active:true}],[{id:2,name:'open',active:false}],[{id:2,name:'open',active:true},{id:2,name:'open',active:true}]])assert.throws(()=>helpers.portalBsuidState({state_id:2},rows));
});
test('APPLIED portal receipt pins exact native ticket, article, actor and public message',()=>{
 helpers.assertPortalBsuidReply(packet());
 for(const mutate of[value=>value.receipt.state='UNKNOWN',value=>value.receipt.operationId='wrong',value=>value.receipt.ticketId='43',value=>value.receipt.articleId='5',value=>value.article.ticket_id=43,value=>value.article.created_by_id=8,value=>value.article.body='Different',value=>value.article.internal=true,value=>value.article.type='email',value=>value.article.sender='System']){const value=packet();mutate(value);assert.throws(()=>helpers.assertPortalBsuidReply(value));}
});
test('portal download receipts remain bound to native Store bytes and PNG evidence',()=>{
 const bytes=Buffer.from([137,80,78,71,13,10,26,10]),sha256=createHash('sha256').update(bytes).digest('hex'),make=()=>({attachment:{filename:'owned.png',preferences:{'Content-Type':'image/png; charset=binary'}},nativeFile:{filename:'owned.png',byteSize:bytes.length,sha256},download:{authenticated:true,status:200,filename:'owned.png',bytes:Buffer.from(bytes),sha256},asset:{bytes:bytes.length,sha256}});
 assert.equal(helpers.assertPortalBsuidMedia(make()).portalDownload,true);
 for(const mutate of[value=>value.attachment.preferences['Content-Type']='image/svg+xml',value=>value.nativeFile.byteSize++,value=>value.nativeFile.sha256='a'.repeat(64),value=>value.download.status=403,value=>value.download.bytes[0]=0,value=>value.download.filename='other.png']){const value=make();mutate(value);assert.throws(()=>helpers.assertPortalBsuidMedia(value));}
});
test('durable original intent exists before checkpoint, cannot overwrite and rejects extra write fields',async()=>ownedTemp(async directory=>{
 let observed=0;const session={privateDir:directory,tenantId:'tenant',checkpoint:async row=>{assert.equal(row.operationId,operation);const saved=JSON.parse(await readFile(join(directory,'meta-bsuid-owned-human-reply.intent.json'),'utf8'));assert.deepEqual(saved.input,input());observed++;}};
 const value={namespace:'owned',ticketId:'42',body:'Human reply',nativeUserId:'9',input:input()};await helpers.persistPortalBsuidReplyIntent(session,value);assert.equal(observed,1);await assert.rejects(()=>helpers.persistPortalBsuidReplyIntent(session,value),error=>error.code==='EEXIST');assert.equal(observed,1);
 await assert.rejects(()=>helpers.persistPortalBsuidReplyIntent(session,{...value,namespace:'different',input:{...input(),sender:'Agent'}}));await assert.rejects(()=>helpers.persistPortalBsuidReplyIntent(session,{...value,namespace:'../escape'}));
}));
test('one shared helper call persists the intent then binds the exact native readback',async()=>ownedTemp(async directory=>{
 let calls=0,reads=0;const checkpoints=[],session={privateDir:directory,tenantId:'tenant',checkpoint:async row=>checkpoints.push(row)},agent={nativeUserId:'9'};
 const send=async(actualAgent,options)=>{calls++;assert.equal(actualAgent,agent);assert.equal(options.ticketId,'42');assert.equal(options.expectedPreviewText,'Human reply');assert.equal(options.internal,false);await options.beforeDispatch(input());const saved=JSON.parse(await readFile(join(directory,'meta-bsuid-owned-human-reply.intent.json'),'utf8'));assert.equal(saved.operationId,operation);return packet().receipt;};
 const result=await load({submitPortalReply:send}).submitPortalBsuidReply(session,{agent,namespace:'owned',ticketId:'42',ticketNumber:'100042',body:'Human reply',nativeArticle:async id=>{reads++;assert.equal(id,'4');return packet().article;}});assert.equal(result.article.id,4);assert.equal(calls,1);assert.equal(reads,1);assert.equal(checkpoints[0].phase,'bsuid-human-reply-dispatch-admitted');
}));
test('unknown original reply is held with its UUID and never followed by readback, replay or another helper call',async()=>ownedTemp(async directory=>{
 let calls=0,reads=0;const checkpoints=[],session={privateDir:directory,tenantId:'tenant',checkpoint:async row=>checkpoints.push(row)};
 const send=async(_agent,options)=>{calls++;await options.beforeDispatch(input());return {state:'UNKNOWN',operationId:operation};};
 await assert.rejects(()=>load({submitPortalReply:send}).submitPortalBsuidReply(session,{agent:{nativeUserId:'9'},namespace:'owned',ticketId:'42',ticketNumber:'100042',body:'Human reply',nativeArticle:async()=>{reads++;throw Error('must not read another article');}}),/Unconfirmed original reply/);assert.equal(calls,1);assert.equal(reads,0);assert.equal(JSON.parse(await readFile(join(directory,'meta-bsuid-owned-human-reply.intent.json'),'utf8')).operationId,operation);assert.equal(checkpoints.at(-1).receipt.state,'UNKNOWN');
}));
test('missing shared before-dispatch admission and historical current-ID aliases fail closed',async()=>ownedTemp(async directory=>{
 let reads=0;await assert.rejects(()=>load({submitPortalReply:async()=>packet().receipt}).submitPortalBsuidReply({privateDir:directory,tenantId:'tenant',checkpoint:async()=>{}},{agent:{nativeUserId:'9'},namespace:'owned',ticketId:'42',ticketNumber:'100042',body:'Human reply',nativeArticle:async()=>{reads++;return packet().article;}}),/persist the intent before dispatch/);assert.equal(reads,0);
 const current=load({ensurePortalOperator:async()=>{throw Error('must not admit aliases');}});await assert.rejects(()=>current.portalMetaBsuidStage({operatorSurface:'native'},{config:{historicalTestId:'old',testId:'old::portal'}}));await assert.rejects(()=>current.portalMetaBsuidStage({operatorSurface:'portal'},{config:{historicalTestId:'old',testId:'old'}}));
}));
