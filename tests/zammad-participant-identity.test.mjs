import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync(new URL('../packages/zammad/src/client.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true});
assert.equal(code.diagnostics.length,0);
const {ZammadClient}=await import(`data:text/javascript;base64,${Buffer.from(code.outputText).toString('base64')}`);
test('native client refreshes owned name, preserves unrelated native preferences and operator edit',async()=>{
 const old=globalThis.fetch;let puts=[];let user={id:5,login:'bound',firstname:'Alpha',lastname:'',preferences:{unrelated:{keep:true},wasalx_identity:{login:'bound',lastAppliedName:'Alpha'}}};
 globalThis.fetch=async(url,init)=>{if(String(url).includes('/search?'))return Response.json([user]);if(init?.method==='PUT'){const body=JSON.parse(init.body);puts.push(body);return Response.json({...user,...body})}return Response.json(user)};
 try{const client=new ZammadClient({baseUrl:'https://native.test',token:'synthetic'});await client.ensureCustomer({login:'bound',firstname:'Renamed'});assert.equal(puts[0].firstname,'Renamed');assert.deepEqual(puts[0].preferences.unrelated,{keep:true});user={...user,firstname:'Operator'};puts=[];await client.ensureCustomer({login:'bound',firstname:'Other'});assert.equal(puts.length,0)}finally{globalThis.fetch=old}
});
test('historical native human name without receipt stays operator protected',async()=>{
 const old=globalThis.fetch;let puts=0;const user={id:6,login:'bound',firstname:'Historical',lastname:''};globalThis.fetch=async(url,init)=>{if(init?.method==='PUT')puts++;return Response.json(String(url).includes('/search?')?[user]:user)};
 try{await new ZammadClient({baseUrl:'https://native.test',token:'synthetic'}).ensureCustomer({login:'bound',firstname:'New'});assert.equal(puts,0)}finally{globalThis.fetch=old}
});

const client=()=>new ZammadClient({baseUrl:"https://native.test",token:"fixture"});
test('creation writes ownership receipt in same request',async()=>{const old=fetch;let body;globalThis.fetch=async(u,i)=>String(u).includes('/search?')?Response.json([]):(body=JSON.parse(i.body),Response.json({id:4,...body}));try{await client().ensureCustomer({login:'fixture',firstname:'Named'});assert.deepEqual(body.preferences.wasalx_identity,{login:'fixture',lastAppliedName:'Named'})}finally{globalThis.fetch=old}});
for(const [name,desired,changes] of [['wHaTsApP PaRtIcIpAnT','Human',true],['Human','123456789@lid',false],['Human','12025550106',false]])test(`native quality ${name} -> ${desired}`,async()=>{const old=fetch;let puts=0;const user={id:4,login:'fixture',firstname:name,lastname:'',preferences:{wasalx_identity:{login:'fixture',lastAppliedName:name}}};globalThis.fetch=async(u,i)=>{if(i?.method==='PUT')puts++;return Response.json(String(u).includes('/search?')?[user]:user)};try{await client().ensureCustomer({login:'fixture',firstname:desired});assert.equal(puts,changes?1:0)}finally{globalThis.fetch=old}});
for(const drift of [{id:9},{login:'foreign'}])test('fresh native identity mismatch refuses update '+JSON.stringify(drift),async()=>{const old=fetch;const user={id:4,login:'fixture',firstname:'Old',lastname:''};globalThis.fetch=async u=>Response.json(String(u).includes('/search?')?[user]:{...user,...drift});try{await assert.rejects(()=>client().ensureCustomer({login:'fixture',firstname:'New'}),/identity readback mismatch/)}finally{globalThis.fetch=old}});
test('422 creation winner is looked up and freshly verified',async()=>{const old=fetch;let searches=0,gets=0;const user={id:4,login:'fixture',firstname:'Human',lastname:''};globalThis.fetch=async(u,i)=>{if(String(u).includes('/search?'))return Response.json(++searches===1?[]:[user]);if(i?.method==='POST')return Response.json({error:'duplicate'},{status:422});gets++;return Response.json(user)};try{assert.equal((await client().ensureCustomer({login:'fixture',firstname:'Human'})).id,4);assert.equal(searches,2);assert.equal(gets,1)}finally{globalThis.fetch=old}});

test('request guard stops customer creation when admission changes after lookup',async()=>{
 const old=globalThis.fetch, denied=new Error('identity admission changed');let checks=0;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init?.method??'GET'});return Response.json([])};
 try{
  const guarded=new ZammadClient({baseUrl:'https://native.test',token:'synthetic',beforeRequest:async()=>{if(++checks===2)throw denied}});
  await assert.rejects(()=>guarded.ensureCustomer({login:'bound',firstname:'Customer'}),error=>error===denied);
  assert.equal(checks,2);assert.equal(calls.length,1);assert.match(calls[0].url,/users\/search/);assert.equal(calls[0].method,'GET');
 }finally{globalThis.fetch=old}
});

test('request guard fences attachment reads and cleanup without converting denial to retryable network error',async()=>{
 const old=globalThis.fetch, denied=new Error('identity admission changed');let calls=0,checks=0;
 globalThis.fetch=async()=>{calls++;assert.fail('Denied native request reached transport')};
 try{
  const guarded=new ZammadClient({baseUrl:'https://native.test',token:'synthetic',beforeRequest:async()=>{checks++;throw denied}});
  const upload='72000000-0000-4000-8000-000000000001';
  for(const action of [()=>guarded.downloadAttachment(42,12,3,100),()=>guarded.downloadWorkspaceUpload(upload,3,100),()=>guarded.deleteWorkspaceUpload(upload,3)]){
   await assert.rejects(action,error=>error===denied);
  }
  assert.equal(checks,3);assert.equal(calls,0);
 }finally{globalThis.fetch=old}
});
