// Linux SSD launcher proposal. Run only against the named isolated Compose project.
// node THIS_FILE <checkout> <private-model-directory> <run-id>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {readFile,mkdir,appendFile,writeFile,stat,open,lstat,realpath} from 'node:fs/promises';
const execFile=promisify(execFileCallback);
export async function inspectComposeService(run,project,service){
assert.match(project,/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);assert.match(service,/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const ids=(await run('docker',['ps','-q','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+service])).trim().split(/\s+/).filter(Boolean);assert.equal(ids.length,1,'Expected one running '+service+' container');
const container=JSON.parse(await run('docker',['inspect',ids[0]]))[0];assert.equal(container.Config.Labels['com.docker.compose.project'],project);assert.equal(container.Config.Labels['com.docker.compose.service'],service);assert.equal(container.State.Status,'running');return container;
}
export async function containerFileSha256(run,containerId,path){assert.match(containerId,/^[a-f0-9]{64}$/);assert.match(path,/^\/run\/wasalx-simulation\/[A-Za-z0-9_.-]+$/);const value=(await run('docker',['exec',containerId,'node','-e',"const{createHash}=require('node:crypto'),{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))",path])).trim();assert.match(value,/^[a-f0-9]{64}$/);return value;}
export async function withRollbackFixture(connect,work){const db=connect();await db.connect();let result,failure;try{await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");result=await work(db);}catch(error){failure=error;}for(const operation of[()=>db.query('ROLLBACK'),()=>db.end()])try{await operation();}catch(error){failure=failure?new AggregateError([failure,error],'Rollback fixture cleanup failed'):error;}if(failure)throw failure;return result;}
export async function assertWahaProviderAbsent(run,containerId){
 assert.equal(typeof run,'function');assert.match(containerId,/^[a-f0-9]{64}$/);
 const script="fetch('http://127.0.0.1:3000/api/sessions',{headers:{'x-api-key':process.env.WAHA_API_KEY},redirect:'error',signal:AbortSignal.timeout(5000)}).then(async r=>{if(r.status!==200)throw Error('Provider session read failed');const value=await r.json();if(!Array.isArray(value))throw Error('Provider session read invalid');process.stdout.write(JSON.stringify({status:r.status,count:value.length}))})";
 const receipt=JSON.parse(await run('docker',['exec',containerId,'node','-e',script]));
 assert.deepEqual(receipt,{status:200,count:0},'Fresh group requires an absent provider session');return receipt;
}

export async function authenticateSimulationFactor(page,readOtp,{username,password,role='wasalx-owner',terminalPath='/app',portalOrigin,keycloakOrigin}){
  assert(['/app','/invitations/result'].includes(terminalPath));
  const visited=new Set();
  for(let i=0;i<3;i++){
    const url=new URL(page.url());assert.equal(url.origin,keycloakOrigin);
    const otp=page.locator('input[name=otp]'),passwordInput=page.locator('input[name=password][type=password]'),usernameInput=page.locator('input[name=username]');
    const otpVisible=await otp.isVisible(),passwordVisible=await passwordInput.isVisible();
    if(!otpVisible&&!passwordVisible)throw Error('Unsupported authentication screen');
    const stage=otpVisible?'otp':url.searchParams.get('prompt')==='login'&&url.searchParams.get('max_age')==='0'&&url.searchParams.has('acr_values')?'mfa-password':'password';
    assert(!visited.has(stage),'Repeated authentication stage');visited.add(stage);
    if(otpVisible)await otp.fill(await readOtp(role));
    else{if(await usernameInput.isVisible())await usernameInput.fill(username);await passwordInput.fill(password);}
    const before=page.url();await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.waitForFunction(({before,wasOtp,terminalPath})=>{const visible=selector=>[...document.querySelectorAll(selector)].some(element=>element.getClientRects().length>0);return location.pathname==='/auth/error'||location.pathname===terminalPath||(!wasOtp&&visible('input[name=otp]'))||(location.href!==before&&new URL(location.href).searchParams.get('prompt')==='login'&&visible('input[name=password][type=password]'))||visible('[role="alert"], #input-error');},{before,wasOtp:otpVisible,terminalPath},{timeout:15000});
    if(new URL(page.url()).origin===portalOrigin){assert.equal(new URL(page.url()).pathname,terminalPath);return;}
    if(await page.locator('[role="alert"], #input-error').first().isVisible())throw Error('Authentication credential rejected');
  }
  throw Error('Authentication stage limit');
}

export function assertRuntimeImageSources(containers,candidate,bindings){
 const services=['portal','control-api','connector-worker'];
 if(bindings!==undefined){assert(Array.isArray(bindings)&&bindings.length===services.length);assert.deepEqual(bindings.map(row=>row.service).sort(),[...services].sort());}
 for(const service of services){
  const container=containers[service];assert(container,'Missing runtime service: '+service);
  const binding=bindings?.find(row=>row.service===service);
  if(binding){assert.match(binding.containerId,/^[a-f0-9]{64}$/u);assert.match(binding.runningDigest,/^sha256:[a-f0-9]{64}$/u);assert.match(binding.sourceSha,/^[a-f0-9]{40}$/u);assert.match(binding.sourceTree,/^[a-f0-9]{40}$/u);assert.equal(binding.expectedDigest,binding.runningDigest);assert.equal(container.Id,binding.containerId);assert.equal(container.Image,binding.runningDigest);}
  assert.equal(container.Config.Labels['org.opencontainers.image.revision'],binding?.sourceSha??candidate.sha);
  assert.equal(container.Config.Labels['io.wasalx.source.tree'],binding?.sourceTree??candidate.tree);
 }
}

export function validateComposePrefix(args,{root,privateDir,profiles}){
 assert(Array.isArray(profiles)&&profiles.includes('full')&&new Set(profiles).size===profiles.length&&profiles.every(p=>/^[a-z][a-z0-9-]*$/.test(p)),'Explicit reviewed profiles required');
 assert(Array.isArray(args)&&args[0]==='compose','Compose prefix required');
 const values=new Map(),actualProfiles=[];for(let i=1;i<args.length;i+=2){const option=args[i],value=args[i+1];assert(['--project-directory','--env-file','-f','--profile'].includes(option)&&typeof value==='string','Unexpected Compose prefix token');if(option==='-f'){const owned=base=>{const path=relative(base,resolve(value));return path&&!path.startsWith('..')&&!isAbsolute(path);};assert(owned(root)||owned(privateDir),'Overlay outside owned paths');}else if(option==='--profile')actualProfiles.push(value);else{assert(!values.has(option),'Repeated Compose singleton');values.set(option,value);}}
 assert.equal(values.get('--project-directory'),root);assert.equal(values.get('--env-file'),join(privateDir,'private.env'));assert.deepEqual(actualProfiles,profiles,'Compose profiles differ from reviewed chain');assert(args.includes('-f'));return [...args];
}
export async function verifyHarnessHashes(privateDir,expected){
 assert(expected&&typeof expected==='object'&&!Array.isArray(expected)&&Object.keys(expected).length,'Expected frozen harness hashes required');
 const actual={};for(const[file,digest]of Object.entries(expected)){assert(/^[a-f0-9]{64}$/.test(digest),'Invalid expected harness hash');assert(!isAbsolute(file),'Absolute harness path denied');const path=resolve(privateDir,file),rel=relative(privateDir,path);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Harness path escapes private staging');const info=await lstat(path);assert(info.isFile()&&!info.isSymbolicLink(),'Harness must be regular staged file');actual[file]=createHash('sha256').update(await readFile(path)).digest('hex');assert.equal(actual[file],digest,'Frozen harness hash mismatch: '+file);}return actual;
}

export async function closeOwnedSession({contexts=[],browser,db,record,timeoutMs=5000}){
 const close=async(name,fn)=>{let timer;try{await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('deadline')),timeoutMs))]);return{name,status:'closed'};}catch{return{name,status:'cleanup-unconfirmed'};}finally{clearTimeout(timer);}};
 const results=await Promise.all(contexts.map((context,index)=>close('owned-context-'+index,()=>context.close())));if(browser)results.push(await close('owned-browser',()=>browser.close()));if(db)results.push(await close('owned-db',()=>db.end()));await record({phase:'cleanup',results});return results;
}

export function validateServiceNetwork({service,name,network,container,model,project}){
 assert.equal(network.Labels?.['com.docker.compose.project'],project,'Network project mismatch');
 const declared=Object.keys(model.services[service]?.networks??{}).some(key=>(model.networks[key]?.name??project+'_'+key)===name);assert(declared,'Undeclared service network');
 if(!network.Internal){
  assert(['portal','control-api','keycloak','zammad-nginx'].includes(service),'Provider or unreviewed service has external network');
  assert.equal(name,model.networks.edge?.name??project+'_edge','Unreviewed external edge');assert.equal(model.networks.edge?.internal??false,false,'Edge model drift');assert.equal(network.Driver,'bridge');
 }
 for(const bindings of Object.values(container.HostConfig.PortBindings??{}))for(const binding of bindings??[])assert.equal(binding.HostIp,'127.0.0.1','Public host binding denied');
}

export function nativeBootstrapContext(actor,tenantId,viewport){
 assert(Number.isSafeInteger(actor?.id)&&actor.id>0&&Array.isArray(actor.roles)&&actor.roles.includes(1),'Verified native bootstrap admin required');
 assert(Number.isSafeInteger(viewport?.width)&&viewport.width>0&&Number.isSafeInteger(viewport?.height)&&viewport.height>0);assert.equal(typeof tenantId,'string');
 const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
 return{role:'zammad_admin',actorRef:digest('zammad:'+actor.id),tenantRef:digest(tenantId),actualActor:actor,viewport};
}
export function validateSessionActor(actor){assert(actor&&actor.evidenceMode==='simulated');for(const key of ['tenantId','ownerId'])assert.match(actor[key],/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);assert.equal(actor.username,'example.owner','Existing supported private owner login only');return{tenantId:actor.tenantId,ownerId:actor.ownerId};}
