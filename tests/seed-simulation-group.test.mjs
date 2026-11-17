import test from 'node:test';
import assert from 'node:assert/strict';
import {seedSyntheticGroup,createSyntheticRequest,findRuleSet} from '../scripts/release/seed-simulation-group.mjs';

test('rule-set lookup follows the existing catalog cursor',async()=>{const target={id:'target',snapshot_sha256:'hash'},pages=[[...Array.from({length:199},(_,i)=>({id:'first-'+i})),{id:'cursor'}],[target]];const paths=[];assert.equal(await findRuleSet(async path=>{paths.push(path);return pages.shift();},target.id),target);assert.deepEqual(paths,['/api/rule-sets?limit=200','/api/rule-sets?limit=200&before=cursor']);});
test('synthetic request records either mutation result identity',async()=>{const id='00000000-0000-4000-8000-000000000001',receipts=[],rows=[],request=createSyntheticRequest({page:{evaluate:async()=>({resultId:id})},origin:'http://127.0.0.1',runId:'receipt',checkpoint:async row=>rows.push(row),receipts});await request('/api/rule-sets/source/clone','POST',{},'clone');assert.equal(receipts[0].id,id);assert.equal(rows.at(-1).id,id);});

test('synthetic request failure diagnostics are bounded and never retry or replace the error',async()=>{
 for(const [message,code,httpStatus] of [
  ['Seed request POST /api/private: HTTP 403; reconcile intent before retry','api-http',403],
  ['Origin changed','page-origin-changed'],
  ['Authenticated server page unavailable','authenticated-page-unavailable'],
  ['Authenticated page CSRF unavailable or ambiguous','csrf-unavailable'],
  ['Unsupported server chunk','server-chunk-unsupported'],
  ['Execution context was destroyed','page-context-lost'],
  ['Failed to fetch','network-transport'],
  ['TimeoutError: timed out','timeout'],
  ['private credential value','unclassified-evaluate-error'],
 ]){
  const error=Error(message),rows=[];let calls=0;
  const request=createSyntheticRequest({page:{url:()=> 'http://127.0.0.1/app?private=value',evaluate:async()=>{calls++;throw error;}},origin:'http://127.0.0.1',runId:'diagnostic',checkpoint:async row=>rows.push(row)});
  await assert.rejects(request('/api/private','POST',{secret:'never-record'},'activate'),value=>value===error);
  assert.equal(calls,1);assert.deepEqual(rows.map(row=>row.phase),['intent','synthetic-request-failed']);
  assert.deepEqual(rows[1],{phase:'synthetic-request-failed',step:'activate',method:'POST',code,...(httpStatus?{httpStatus}:{}),pageOriginMatchesAtCatch:true});
 }
 const error=Error('Original transport failure');let calls=0;
 const request=createSyntheticRequest({page:{url:()=>{throw Error('closed');},evaluate:async()=>{calls++;throw error;}},origin:'http://127.0.0.1',runId:'diagnostic',checkpoint:async()=>{throw Error('disk full');}});
 await assert.rejects(request('/api/read'),value=>value===error);assert.equal(calls,1);
});

test('seed admits isolation and persists intent before an uncertain write, without retry',async()=>{
 const order=[];
 const options={origin:'http://127.0.0.1:32123',runId:'one',externalGroupId:'123@g.us',nativeGroupName:'Synthetic',evidenceMode:'simulated',
  page:{url:()=> 'http://127.0.0.1:32123/app',evaluate:async()=>{order.push('write');throw Error('observation lost');}},
  assertIsolatedRuntime:async()=>{order.push('admitted');},
  checkpoint:async r=>{order.push(r.phase);if(r.phase==='intent')assert.equal(r.key,'synthetic-one-connection');},
 };
 await assert.rejects(seedSyntheticGroup(options),/observation lost/);
 assert.deepEqual(order,['admitted','intent','write','synthetic-request-failed']);
 order.length=0;
 await assert.rejects(seedSyntheticGroup({...options,checkpoint:async()=>{order.push('intent-failed');throw Error('disk unavailable');}}),/disk unavailable/);
 assert.deepEqual(order,['admitted','intent-failed']);
 order.length=0;
 await assert.rejects(seedSyntheticGroup({...options,evidenceMode:'live'}),/Invalid simulated seed admission/);
 assert.deepEqual(order,[]);
});

test('seed reads fresh Vinext server chunks after hydration clears bootstrap',async()=>{
 const prefix='((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}).rsc.push(';
 const original={fetch:globalThis.fetch,DOMParser:globalThis.DOMParser,location:globalThis.location};
 let writes=0;
 try{
  globalThis.location={origin:'http://127.0.0.1:32123'};
  globalThis.DOMParser=class{parseFromString(){return {scripts:[{textContent:prefix+JSON.stringify('1:{"csrfToken":"synthetic-csrf"}')+')'}]};}};
  globalThis.fetch=async(path,options)=>{
   if(path==='/app')return {ok:true,url:'http://127.0.0.1:32123/app',text:async()=>'<html></html>'};
   writes++;assert.equal(options.headers['x-wasalx-csrf'],'synthetic-csrf');assert.equal(options.headers['content-type'],'application/json');throw Error('stop after verified request');
  };
  await assert.rejects(seedSyntheticGroup({page:{url:()=>location.origin+'/app',evaluate:(fn,args)=>fn(args)},origin:location.origin,runId:'parser',externalGroupId:'123@g.us',nativeGroupName:'Synthetic',evidenceMode:'simulated',assertIsolatedRuntime:async()=>{},checkpoint:async()=>{}}),/stop after verified request/);
  assert.equal(writes,1);
  const request=createSyntheticRequest({page:{evaluate:(fn,args)=>fn(args)},origin:location.origin,runId:'delete',checkpoint:async()=>{}});
  await assert.rejects(request('/api/group-workspace/groups/group/grants/grant','DELETE',undefined,'revoke'),/stop after verified request/);
  assert.equal(writes,2);
 }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('terminal setup recovery uses the existing connection and records start intent',async()=>{
 const calls=[],receipts=[],id='00000000-0000-4000-8000-000000000003';
 const options={origin:'http://127.0.0.1:32123',runId:'resume',externalGroupId:'123@g.us',nativeGroupName:'Synthetic',evidenceMode:'simulated',resumeConnection:{id,name:'Synthetic original'},assertIsolatedRuntime:async()=>{},checkpoint:async r=>receipts.push(r),page:{url:()=> 'http://127.0.0.1:32123/app',evaluate:async(fn,args)=>{calls.push(args);if(args.method==='GET')return {name:'Synthetic original',provider:'WAHA',latest_operation_state:'FAILED_TERMINAL'};throw Error('stop after start');}}};
 await assert.rejects(seedSyntheticGroup(options),/stop after start/);
 assert.deepEqual(calls.map(c=>[c.path,c.method]),[[`/api/connections/${id}`,'GET'],[`/api/connections/${id}/start`,'POST']]);
 assert.deepEqual(receipts.map(r=>r.phase),['resume','intent','synthetic-request-failed']);
});

test('resumes accepted rule and binding with bigint revision without creating duplicates',async()=>{
 const id='00000000-0000-4000-8000-000000000003',ruleId='00000000-0000-4000-8000-000000000004',calls=[];
 const detail={name:'Synthetic original',provider:'WAHA',state:'WORKING',provider_state:'WORKING',latest_operation_state:'SUCCEEDED',latest_operation_id:'sync'};
 const options={origin:'http://127.0.0.1:32123',runId:'resume',externalGroupId:'123@g.us',nativeGroupName:'Synthetic',evidenceMode:'simulated',resumeConnection:{id,name:detail.name},resumeRule:{id:ruleId,name:'Rule'},assertIsolatedRuntime:async()=>{},checkpoint:async()=>{},page:{url:()=> 'http://127.0.0.1:32123/app',evaluate:async(fn,a)=>{
  calls.push(a);
  if(a.path===`/api/connections/${id}`)return detail;
  if(a.path.endsWith('/groups/sync'))return {operation:{id:'sync'}};
  if(a.path.startsWith('/api/groups?'))return [{id:'group',connection_id:id,external_group_id:'123@g.us'}];
  if(a.path==='/api/rule-sets?limit=200')return [{id:ruleId,name:'Rule',state:'DRAFT',revision:'1'}];
  if(a.path.endsWith('/activate')){assert.equal(a.body.expectedRevision,1);return {};}
  if(a.path==='/api/zammad/routing-catalogs')return {groups:[{id:'native',name:'Synthetic',active:true,serviceIdentityCanCreate:true}]};
  if(a.path.endsWith('/binding'))return {binding_id:'binding',rule_set_id:ruleId,binding_state:'ACTIVE',binding_revision:'1'};
  throw Error('Unexpected request');
 }}};
 const result=await seedSyntheticGroup(options);assert.equal(result.ruleSetId,ruleId);assert.equal(result.bindingId,'binding');
 assert(!calls.some(a=>a.path==='/api/rules'||a.path==='/api/connections'||a.method==='PUT'));
});

test('injected request requires actual actor admission before any seed request',async()=>{
 let calls=0;
 const options={origin:'http://127.0.0.1:18530',runId:'injected',externalGroupId:'123@g.us',nativeGroupName:'Operations',evidenceMode:'simulated',checkpoint:async()=>{},assertIsolatedRuntime:async()=>{},request:async()=>{calls++;throw Error('request reached');}};
 await assert.rejects(seedSyntheticGroup(options),/Injected requests require actual actor admission/);assert.equal(calls,0);
 await assert.rejects(seedSyntheticGroup({...options,assertRequestActor:async()=>{throw Error('actor unavailable');}}),/actor unavailable/);assert.equal(calls,0);
 await assert.rejects(seedSyntheticGroup({...options,assertRequestActor:async args=>{assert.equal(args.origin,options.origin);assert.equal(args.evidenceMode,'simulated');}}),/request reached/);assert.equal(calls,1);
});
