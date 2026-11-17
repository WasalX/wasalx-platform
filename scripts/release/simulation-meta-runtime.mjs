import{assertRoutingFixture}from'./meta-routing-fixture.mjs';
import {privateNativeRead} from './simulation-private-native-read.mjs';
import{createDirectDispatchFence}from'./direct-dispatch-fence.mjs';
import{waitOwnedRestoration,observeOwnedRestoration}from'./owned-work-restoration.mjs';
import{isDeepStrictEqual}from'node:util';
import assert from'node:assert/strict';import{createHash}from'node:crypto';import{readFile,lstat,open}from'node:fs/promises';import{join,resolve,relative,isAbsolute}from'node:path';import{request as httpRequest}from'node:http';import{createSyntheticRequest}from'./seed-simulation-group.mjs';
// Native/provider corroboration only; normal portal callbacks never open native UI.
export async function readMetaNativeArticle(session,{ticketId,articleId}){
 for(const value of [ticketId,articleId]){assert(typeof value==='string'||Number.isSafeInteger(value));assert.match(String(value),/^[1-9][0-9]{0,15}$/u);}
 assert(session.operatorSurface===undefined||session.operatorSurface==='portal','Unsupported Meta operator surface');
 const native=session.operatorSurface==='portal'?await privateNativeRead(session,'article',{articleId}):await session.nativePage.evaluate(async id=>{const response=await fetch('/api/v1/ticket_articles/'+encodeURIComponent(id),{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Native article unavailable');return response.json();},String(articleId));
 assert.equal(String(native.id),String(articleId),'Meta article identity differs');assert.equal(String(native.ticket_id),String(ticketId),'Meta article belongs to another ticket');return native;
}
export function privateConfigPath(root,path){assert(typeof path==='string'&&path&&!isAbsolute(path));const full=resolve(root,path),rel=relative(resolve(root),full);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return full;}
// Private finite fixture policy; these are simulated outcomes, never provider capability claims.
export const metaCoexistenceFixtureModes=Object.freeze({
 'coex-success':Object.freeze(['HOLD','HOLD']),
 'coex-contacts-unknown':Object.freeze(['DISCONNECT','ACCEPT']),
 'coex-history-declined':Object.freeze(['ACCEPT','ACCEPT']),
 'coex-expired':Object.freeze(['ACCEPT','ACCEPT']),
 'coex-renewal':Object.freeze(['DISCONNECT','ACCEPT']),
});
export function assertMetaSignupFixtureBinding(cfg,mode,graph,consumers,now=Date.now()){
 const businessApp=Object.hasOwn(metaCoexistenceFixtureModes,mode),signup=cfg.signup;
 if(signup===undefined){assert(!businessApp&&graph.META_SIM_SIGNUP_FIXTURE===undefined,'Unexpected signup fixture');return false;}
 const fields=['businessId','userId','configId','appId','phoneId','wabaId','displayPhoneNumber','origin','graphVersion'];
 if(businessApp)fields.push('mode','businessAppConfigId','coexistence',...(mode==='coex-renewal'?['reauthorizationToken']:[]));
 assert(signup&&Object.keys(signup).sort().join(',')===fields.sort().join(','),'Invalid private signup configuration');
 const ids=['businessId','userId','configId','appId','phoneId','wabaId',...(businessApp?['businessAppConfigId']:[])].map(key=>signup[key]);
 assert(ids.every(id=>typeof id==='string'&&/^[0-9]{5,32}$/u.test(id))&&new Set(ids).size===ids.length,'Invalid synthetic signup identity');
 assert(signup.appId===cfg.appId&&signup.phoneId===cfg.binding.phoneId&&signup.wabaId===cfg.binding.wabaId&&signup.graphVersion==='v24.0','Private signup identity changed');
 assert(typeof signup.displayPhoneNumber==='string'&&/^[1-9][0-9]{5,14}$/u.test(signup.displayPhoneNumber),'Invalid synthetic signup phone');
 assert(typeof cfg.token==='string'&&cfg.token.length>=16&&cfg.token.length<=4096&&!/\s/u.test(cfg.token)
  &&typeof cfg.appSecret==='string'&&cfg.appSecret.length>=16&&cfg.appSecret.length<=4096,'Invalid private signup credential');
 const fixture={businessId:signup.businessId,userId:signup.userId};
 if(businessApp){
  assert(signup.mode===mode,'Selected coexistence mode changed');
  const coex=signup.coexistence;
  assert(coex&&Object.keys(coex).sort().join(',')==='contacts,history,onboardedAt','Invalid coexistence fixture');
  assert(Number.isSafeInteger(coex.onboardedAt)&&coex.onboardedAt>0&&coex.onboardedAt<=Math.floor(now/1000),'Invalid onboarding time');
  const expired=now/1000-coex.onboardedAt>=86400;
  assert(expired===(mode==='coex-expired'),'Coexistence expiry scenario changed');
  assert(isDeepStrictEqual([coex.contacts,coex.history],metaCoexistenceFixtureModes[mode]),'Coexistence request behavior changed');
  fixture.coexistence=coex;
  if(mode==='coex-renewal'){
   const token=signup.reauthorizationToken;
   assert(typeof token==='string'&&token.length>=16&&token.length<=4096&&!/\s/u.test(token)&&token!==cfg.token,'Invalid renewal credential binding');
   fixture.reauthorizationToken=token;
  }
 }
 assert(graph.META_SIM_APP_ID===cfg.appId&&graph.META_SIM_APP_SECRET===cfg.appSecret&&graph.META_SIM_TOKEN===cfg.token
  &&graph.META_SIM_PHONE_ID===signup.phoneId&&graph.META_SIM_WABA_ID===signup.wabaId
  &&graph.META_SIM_PHONE===signup.displayPhoneNumber&&graph.META_SIM_VERSION==='v24.0','Graph signup configuration changed');
 let actual;try{actual=JSON.parse(graph.META_SIM_SIGNUP_FIXTURE);}catch{throw Error('Invalid Graph signup fixture');}
 assert(isDeepStrictEqual(actual,fixture),'Graph signup fixture changed');
 assert(Array.isArray(consumers)&&consumers.length===2,'Both signup consumers required');
 const expected={META_SIGNUP_ENABLED:'true',META_SIGNUP_CUSTOMER_CONFIG_ID:signup.configId,META_APP_ID:signup.appId,META_GRAPH_VERSION:'v24.0',PORTAL_PUBLIC_ORIGIN:signup.origin,
  ...(businessApp?{META_COEXISTENCE_ENABLED:'true',META_SIGNUP_BUSINESS_APP_CONFIG_ID:signup.businessAppConfigId,NODE_EXTRA_CA_CERTS:'/simulation-ca/ca.pem'}:{})};
 for(const env of consumers){
  assert(Object.entries(expected).every(([key,value])=>typeof value==='string'&&value.length>0&&env[key]===value),'Signup consumer configuration changed');
  assert(typeof env.META_APP_SECRET_REFERENCE==='string'&&/^secret:\/\/[A-Za-z0-9_/-]+$/u.test(env.META_APP_SECRET_REFERENCE)
   &&env.META_APP_SECRET_REFERENCE===consumers[0].META_APP_SECRET_REFERENCE,'Signup secret reference changed');
 }
 return businessApp;
}
export function controlApiCoreAddress(containers){
 const pgNetworks=Object.keys(containers.postgres.NetworkSettings.Networks);assert.equal(pgNetworks.length,1,'Postgres network must be unambiguous');
 const peer=containers['control-api'].NetworkSettings.Networks[pgNetworks[0]];assert(peer?.IPAddress,'Control API must share the admitted PostgreSQL network');
 return peer.IPAddress;
}
export async function createMetaCallbacks(session,config){let admissionPhase='configuration';try{const{ownerPage,portalOrigin,privateDir,output,runId,model,containers,scoped,checkpoint,run,tenantId}=session;assert(/^[a-f0-9]{64}$/.test(config.graphSourceSha256));assert(/^sha256:[a-f0-9]{64}$/.test(config.graphImageDigest));
 admissionPhase='private-config';
 const file=privateConfigPath(privateDir,config.privateConfigPath),st=await lstat(file);assert(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&st.uid===process.getuid());const cfg=JSON.parse(await readFile(file));assert.equal(cfg.project,model.name);assert.equal(cfg.evidenceMode,'simulated');assert.equal(cfg.binding.customer,config.customer,'Declared text customer differs from private binding');assert.equal(cfg.tenantId,tenantId);assert.equal(cfg.graphImageDigest,config.graphImageDigest);assert.equal(cfg.graphSourceSha256,config.graphSourceSha256);assert(cfg.graphService&&cfg.controlSocket&&cfg.appSecret&&cfg.token);assert(cfg.controlSocket.startsWith(privateDir+'/'));
 admissionPhase='graph-binding';const graph=model.services[cfg.graphService];assert(graph&&!graph.ports?.length&&graph.environment.META_SIM_GROUPS_FIXTURE==='eligible-empty');assert.equal(graph.environment.META_SIM_PHONE_ID,cfg.binding.phoneId);assert.equal(graph.environment.META_SIM_WABA_ID,cfg.binding.wabaId);assert(JSON.parse(graph.environment.META_SIM_RECIPIENTS).includes(cfg.binding.customer));assert.equal(graph.environment.META_SIM_TOKEN,cfg.token);
 const consumerNames=['control-api','connector-worker'];const businessApp=assertMetaSignupFixtureBinding(cfg,config.mode,graph.environment,consumerNames.map(name=>model.services[name].environment));
 const routingRuntime=assertRoutingFixture(cfg,graph.environment,consumerNames.map(name=>model.services[name].environment));
 for(const service of consumerNames)assert(model.services[service].environment.NODE_EXTRA_CA_CERTS);
 admissionPhase='runtime';const graphRows=JSON.parse(await run('docker',['ps','-q','--filter','label=com.docker.compose.project='+model.name,'--filter','label=com.docker.compose.service='+cfg.graphService]).then(async id=>await run('docker',['inspect',id.trim()])));assert.equal(graphRows.length,1);const g=graphRows[0];assert(g.State.Running&&g.Config.Labels['com.docker.compose.project']===model.name);assert.equal(g.Image,cfg.graphImageDigest);const env=Object.fromEntries(g.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));for(const key of['META_SIM_PHONE_ID','META_SIM_WABA_ID','META_SIM_TOKEN','META_SIM_RECIPIENTS','META_SIM_GROUPS_FIXTURE'])assert.equal(env[key],graph.environment[key],'Installed Graph env mismatch '+key);const control=env.META_SIM_CONTROL_SOCKET;assert(control);const mount=g.Mounts.filter(m=>control===m.Destination||control.startsWith(m.Destination+'/')).sort((a,b)=>b.Destination.length-a.Destination.length)[0];assert(mount,'Graph control socket mount missing');assert.equal(resolve(mount.Source,relative(mount.Destination,control)),resolve(cfg.controlSocket),'Private socket differs from installed Graph');
 if(businessApp)assert(g.State.Health?.Status==='healthy','Coexistence Graph is not healthy');
 assertMetaSignupFixtureBinding(cfg,config.mode,env,consumerNames.map(name=>Object.fromEntries(containers[name].Config.Env.map(value=>{const i=value.indexOf('=');return[value.slice(0,i),value.slice(i+1)];}))));
 // Fresh inspection, not the session's captured environment, is authoritative.
 const currentConsumers=[];
 for(const name of consumerNames){const [current]=JSON.parse(await run('docker',['inspect',containers[name].Id]));
  assert(current.Id===containers[name].Id&&current.Image===containers[name].Image&&current.State.Running&&current.State.Health?.Status==='healthy');
  assert.equal(current.Config.Labels['com.docker.compose.project'],model.name);assert.equal(current.Config.Labels['com.docker.compose.service'],name);
  currentConsumers.push(Object.fromEntries(current.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];})));
 }
 assert.deepEqual(assertRoutingFixture(cfg,env,currentConsumers),routingRuntime);
 if(routingRuntime)for(const name of consumerNames){
  const found=await run('docker',['exec',containers[name].Id,'node','-e',"process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.env.NODE_EXTRA_CA_CERTS)).digest('hex'))"]);
  assert.equal(found.trim(),cfg.routing.caSha256,'Installed routing CA changed');
 }
 admissionPhase='network';
 for(const name of Object.keys(g.NetworkSettings.Networks)){const [n]=JSON.parse(await run('docker',['network','inspect',name]));assert(n.Internal,'Graph network must be isolated');}
 const graphIPs=Object.values(g.NetworkSettings.Networks).map(n=>n.IPAddress);
 for(const service of ['control-api','connector-worker']){const addresses=JSON.parse(await run('docker',['exec',containers[service].Id,'node','-e',"require('node:dns').promises.lookup('graph.facebook.com',{all:true}).then(x=>process.stdout.write(JSON.stringify(x)))"]));assert(addresses.length>0&&addresses.every(x=>graphIPs.includes(x.address)));}
 admissionPhase='source';const sources=g.Mounts.filter(m=>m.Destination.endsWith('.mjs'));assert.equal(sources.length,1);assert(sources[0].Source.startsWith(privateDir+'/'));assert.equal(createHash('sha256').update(await readFile(sources[0].Source)).digest('hex'),config.graphSourceSha256,'Installed Graph media boundary differs from tested candidate');
 admissionPhase='checkpoint';
 await checkpoint({phase:'meta-boundary-admission',graphImage:g.Image,graphContainer:g.Id});
 // One dispatch per private fixture. Claim survives interruption and blocks new-run recreation.

 admissionPhase='callbacks';const request=createSyntheticRequest({page:ownerPage,origin:portalOrigin,runId,checkpoint});
 const poll=async(fn,ok,timeoutMs=120000)=>{assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=360000);const end=Date.now()+timeoutMs;while(Date.now()<end){const x=await fn();if(ok(x))return x;await new Promise(r=>setTimeout(r,500));}throw Error('Meta readback unsettled; retain operations');};
 const providerControl=(method,path,body)=>{assert((method==='GET'&&['/receipts','/fault','/upload-fault',...(cfg.routing?['/routing']:[])].includes(path))||(method==='POST'&&((path==='/routing/fault'&&cfg.routing&&body&&Object.keys(body).sort().join(',')==='action,id,mode,recipient'&&['take','pass','release'].includes(body.action)&&body.recipient===cfg.binding.customer&&typeof body.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(body.id)&&['reject','malformed-rejection','disconnect-after-acceptance'].includes(body.mode))||(path==='/fault'&&['window-closed','disconnect-after-acceptance'].includes(body?.mode))||(path==='/upload-fault'&&typeof body?.id==='string'&&/^[a-f0-9]{64}$/.test(body.sha256)))));return new Promise((resolve,reject)=>{const q=httpRequest({socketPath:cfg.controlSocket,path,method,timeout:10000,headers:{'content-type':'application/json'}},r=>{let size=0;const chunks=[];r.on('data',c=>{size+=c.length;if(size>16*1024*1024)q.destroy(Error('Receipt bound'));else chunks.push(c);});r.on('end',()=>{try{assert.equal(r.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks)));}catch(e){reject(e);}});});q.on('error',reject);q.on('timeout',()=>q.destroy(Error('Receipt timeout')));q.end(body?JSON.stringify(body):undefined);});};
 const providerRead=async()=>(await providerControl('GET','/receipts')).receipts;
 const apiAddress=controlApiCoreAddress(containers);
 const postRaw=async(path,bytes,headers)=>{assert.equal(path,'/webhooks/meta');const r=await fetch('http://'+apiAddress+':3001'+path,{method:'POST',body:bytes,headers,redirect:'error',signal:AbortSignal.timeout(20000)});const receipt=await r.json();return{status:r.status,receipt};};
 const readTerminal=async({connectionId,messageId,expectedText,customer})=>{
 const rows=await poll(()=>scoped(`SELECT i.id AS inbox_id,i.status,i.lease_id,l.zammad_ticket_id,l.zammad_article_id,d.state,d.external_message_id,d.message_body,d.external_chat_id FROM event_inbox i JOIN normalized_messages n ON n.tenant_id=i.tenant_id AND n.event_inbox_id=i.id JOIN message_links l ON l.tenant_id=n.tenant_id AND l.connection_id=n.connection_id AND l.external_message_id=n.external_message_id JOIN delivery_outbox d ON d.tenant_id=i.tenant_id AND d.connection_id=i.connection_id AND d.idempotency_key LIKE ('bot:%:'||i.id::text||':0') WHERE i.connection_id=$1 AND i.provider_event_id_sha256=app.webhook_event_id_sha256(i.tenant_id,$1,'META',$2)`,[connectionId,messageId]),r=>r.length===1&&r[0].status==='PROCESSED'&&!r[0].lease_id&&r[0].state==='SENT');const r=rows[0];assert.equal(r.message_body,expectedText);assert.equal(r.external_chat_id,customer);
 const native=await readMetaNativeArticle(session,{ticketId:r.zammad_ticket_id,articleId:r.zammad_article_id});assert.equal(String(native.id),String(r.zammad_article_id));assert.equal(String(native.ticket_id),String(r.zammad_ticket_id));assert.equal(String(native.body).replace(/<[^>]*>/g,'').trim(),expectedText,'Native inbound marker mismatch');return{inboxId:r.inbox_id,nativeArticleId:String(native.id),ticketId:String(native.ticket_id),state:r.state,externalMessageId:r.external_message_id};};
 let ownedConnectionId,originalUnknowns=[];const fence=createDirectDispatchFence({checkpoint,control:command=>postRaw('/webhooks/meta',Buffer.from(command.input.bytesBase64,'base64'),command.input.headers),observe:(registry,{readbackOnly=false}={})=>{assert(ownedConnectionId);return (readbackOnly?observeOwnedRestoration:waitOwnedRestoration)({scoped,tenantId,connectionId:ownedConnectionId,provider:'META',registry,originalUnknowns,checkpoint});}});
 const postInbound=async(path,bytes,headers)=>{assert.equal(path,'/webhooks/meta');const payload=JSON.parse(bytes);const changes=payload.entry?.flatMap(e=>e.changes??[])??[];const messages=changes.flatMap(c=>c.value?.messages??[]);assert.equal(messages.length,1);const eventId=messages[0].id;assert(typeof eventId==='string'&&eventId);return fence.control({action:'inbound',input:{eventId,bytesBase64:bytes.toString('base64'),headers}});};
 const drain=async({connectionId,assignmentId,retainedUnknown})=>{ownedConnectionId=connectionId;if(retainedUnknown){assert.equal(retainedUnknown.state,'OUTCOME_UNKNOWN');assert.equal(Number(retainedUnknown.attempts),1);assert.equal(retainedUnknown.external_message_id,null);assert.match(retainedUnknown.id,/^[a-f0-9-]{36}$/);assert.equal(originalUnknowns.length,0,'Only one newly owned unknown may be retained');originalUnknowns=[{id:retainedUnknown.id,state:'OUTCOME_UNKNOWN',attempts:1,external_message_id:null}];}const settlement=await fence.drain();await checkpoint({phase:'meta-pre-pause-settled',connectionId,settlement});const [a]=await scoped('SELECT revision,state FROM bot_assignments WHERE id=$1 AND connection_id=$2',[assignmentId,connectionId]);assert.equal(a.state,'ACTIVE');await request('/api/bot-flows/assignments/'+assignmentId+'/state','POST',{state:'PAUSED',expectedRevision:Number(a.revision)},'pause-meta-assignment-'+a.revision);const [after]=await scoped('SELECT state,revision FROM bot_assignments WHERE id=$1',[assignmentId]);assert.equal(after.state,'PAUSED');await checkpoint({phase:'assignment-disposition',assignmentId,...after});};
 const persistInbound=async({messageId,bytes})=>{assert(/^wamid\.synthetic\.[a-zA-Z0-9_-]+\.(initial|choice|location|selected|new)$/.test(messageId));const f=await open(join(output,'meta-inbound-'+createHash('sha256').update(messageId).digest('hex')+'.raw.json'),'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}};
 const binding={project:model.name,tenantId,phoneId:cfg.binding.phoneId,wabaId:cfg.binding.wabaId,graphContainerId:g.Id,graphImageDigest:g.Image,graphSourceSha256:config.graphSourceSha256,controlSocket:cfg.controlSocket};return{cfg,binding,routingRuntime,providerRead,providerControl,postRaw,postInbound,poll,readTerminal,drain,persistInbound};
 }catch{throw new Error('Meta simulator admission failed ('+admissionPhase+'); inspect the owned private prerequisite without replay');}
}
