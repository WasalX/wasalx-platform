import assert from 'node:assert/strict';
import {join} from 'node:path';
import {waitOwnedRestoration,observeOwnedRestoration} from './owned-work-restoration.mjs';
import {callSimulationControl} from '../contracts/waha-simulation-control.mjs';
import {createDirectDispatchFence} from './direct-dispatch-fence.mjs';
import {privateNativeRead,ensurePortalOperator,openPortalTicket,capturePortalOperatorEvidence} from './simulation-portal-operator.mjs';
import {createHash} from 'node:crypto';
export function admittedDirectChatIds(environment){
 const entry=environment.find(value=>value.startsWith('WAHA_SIM_DIRECT_CHAT_IDS='));assert(entry,'Running simulator direct-chat allowlist missing');
 const ids=JSON.parse(entry.slice(entry.indexOf('=')+1));assert(Array.isArray(ids)&&ids.length===new Set(ids).size);for(const id of ids)assert(/^\d{6,20}@c\.us$/.test(id));return ids.sort();
}
export async function readDirectProviderReceipts(session){const expected=session.containers['waha-gows'];assert(expected?.Id&&expected.Image);return JSON.parse(await session.run('docker',['exec',expected.Id,'node','-e',"setTimeout(()=>process.exit(124),25_000).unref();fetch('http://127.0.0.1:3000/__simulation/receipts',{signal:AbortSignal.timeout(20_000),headers:{'x-api-key':process.env.WAHA_API_KEY}}).then(r=>{if(!r.ok)throw Error('Receipt read failed');return r.json()}).then(x=>process.stdout.write(JSON.stringify(x)))"]));}
// Output proposal: invoked after a current connection producer, never by retained-row discovery.
export async function attachDirectCapabilities(session,fixture,{originalUnknowns}){
 assert.equal(fixture?.evidenceMode,'simulated');assert.equal(fixture.provider,'WAHA');assert.equal(fixture.tenantId,session.tenantId);
 assert(fixture.connectionId&&fixture.zammadGroupId);assert(Array.isArray(originalUnknowns));
 if(originalUnknowns.length){
  const cap=session.capabilities?.reviewFixture,retained=cap?.fixture;assert(retained?.noReplay===true&&retained.requireNoFurtherAttempts===true,'Fresh direct producer cannot inherit uncertain deliveries');
  assert.equal(originalUnknowns.length,1);assert.equal(retained.namespace,fixture.namespace);assert(retained.sourceNamespace&&retained.sourceNamespace!==fixture.namespace);assert.equal(retained.tenantId,session.tenantId);assert.equal(retained.connectionId,fixture.connectionId);assert.deepEqual(originalUnknowns,[retained.retainedUnknown]);
  assert.equal(retained.retainedUnknown.state,'OUTCOME_UNKNOWN');assert.equal(Number(retained.retainedUnknown.attempts),1);assert.equal(retained.retainedUnknown.external_message_id,null);await cap.verifyReadOnly();
 }
 const expected=session.containers['waha-gows'];assert(expected?.Id&&expected.Image);
 const admission=async()=>{
  const [actual]=JSON.parse(await session.run('docker',['inspect',expected.Id]));
  assert.equal(actual.Id,expected.Id);assert.equal(actual.Image,expected.Image);assert.equal(actual.Config.Labels['com.docker.compose.project'],session.model.name);assert.equal(actual.State.Status,'running');
  const networks=Object.keys(actual.NetworkSettings.Networks);assert.equal(networks.length,1);
  const [network]=JSON.parse(await session.run('docker',['network','inspect',networks[0]]));assert.equal(network.Internal,true);assert.deepEqual(actual.HostConfig.PortBindings??{},{});
  const mount=actual.Mounts.find(m=>m.Destination==='/run/wasalx-simulation');assert(mount);assert.equal(join(mount.Source,'control.sock'),session.socketPath);
  const rows=await session.scoped("SELECT s.id,s.opaque_session_id,w.base_url FROM provider_sessions s JOIN connections c ON c.tenant_id=s.tenant_id AND c.id=s.connection_id JOIN LATERAL app.current_waha_session_runtime(s.id) w ON true WHERE s.tenant_id=$1 AND s.connection_id=$2 AND s.ownership_state='ACTIVE' AND s.state='WORKING' AND c.provider='WAHA' AND c.state='WORKING'",[session.tenantId,fixture.connectionId]);
  assert.equal(rows.length,1);const row=rows[0];
  const addresses=JSON.parse(await session.run('docker',['exec',session.containers['connector-worker'].Id,'node','-e',"setTimeout(()=>process.exit(124),25_000).unref();require('node:dns').promises.lookup(process.argv[1],{all:true}).then(x=>process.stdout.write(JSON.stringify(x)))",new URL(row.base_url).hostname]));
  const ip=actual.NetworkSettings.Networks[networks[0]].IPAddress;assert(addresses.length&&addresses.every(x=>x.address===ip));
  return{project:session.model.name,connectionId:fixture.connectionId,providerSessionId:row.id,containerId:actual.Id,imageId:actual.Image,socketPath:session.socketPath,directChatIds:admittedDirectChatIds(actual.Config.Env)};
 };
 const binding=await admission();
 const assertIsolatedRuntime=async args=>{assert.equal(args.evidenceMode,'simulated');assert.equal(args.tenantId,session.tenantId);assert.equal(args.connectionId,fixture.connectionId);assert.deepEqual(await admission(),binding);for(const id of args.chatIds??[])assert(binding.directChatIds.includes(id),`Direct chat ${id} is not admitted by the running simulator`);};
 const fence=createDirectDispatchFence({checkpoint:session.checkpoint,control:command=>callSimulationControl(session.socketPath,command),observe:async (registry,{readbackOnly=false}={})=>{
  const snapshot=await (readbackOnly?observeOwnedRestoration:waitOwnedRestoration)({scoped:session.scoped,tenantId:session.tenantId,connectionId:fixture.connectionId,registry,originalUnknowns});
  return{settled:true,unknown:0,pending:0,snapshot};
 }});
 const drainEffects=()=>fence.drain();
 const providerRead=async()=>{await drainEffects();return readDirectProviderReceipts(session);};
 const nativeRead=async(ticketId,marker)=>({markerArticleIds:(await privateNativeRead(session,'articles',{ticketId})).filter(article=>String(article.body).includes(marker)).map(article=>article.id)});
 const observeReturningTicket=async({ticketId,marker})=>{
  const startedAt=new Date().toISOString(),before=await providerRead(),operator=await ensurePortalOperator(session,{role:'agent',viewport:{width:1440,height:1000}});
  const [ticket,articles]=await Promise.all([privateNativeRead(session,'ticket',{ticketId}),privateNativeRead(session,'articles',{ticketId})]);
  assert.equal(String(ticket.id),String(ticketId));const matches=articles.filter(article=>String(article.body).includes(marker));assert.equal(matches.length,1,'Returning article marker must be unique');
  const rendered=await openPortalTicket(operator,{ticketNumber:String(ticket.number),articleId:String(matches[0].id),marker,reload:true}),portalBinding=await capturePortalOperatorEvidence(operator);
  assert.deepEqual(await providerRead(),before,'Returning ticket observation must not replay provider effects');
  return{surface:'portal',actorVerified:true,actualViewport:portalBinding.viewport,observedTicketId:String(ticket.id),ticketNumber:String(ticket.number),articleId:String(matches[0].id),markerSha256:createHash('sha256').update(marker).digest('hex'),rendered,portalBinding,noProviderReplay:true,startedAt,finishedAt:new Date().toISOString()};
 };
 const providerMessage=async(id)=>{assert(typeof id==='string'&&id.length>0&&id.length<=512);await admission();return JSON.parse(await session.run('docker',['exec',expected.Id,'node','-e',"setTimeout(()=>process.exit(124),25_000).unref();const u='http://127.0.0.1:3000/api/'+encodeURIComponent(process.env.WAHA_SIM_SESSION)+'/chats/'+encodeURIComponent(process.env.WAHA_SIM_GROUP_ID)+'/messages/'+encodeURIComponent(process.argv[1]);fetch(u,{signal:AbortSignal.timeout(20_000),headers:{'x-api-key':process.env.WAHA_API_KEY}}).then(r=>{if(!r.ok)throw Error('Provider message read failed');return r.json()}).then(x=>process.stdout.write(JSON.stringify(x)))",id]));};
 session.directCallbacks={binding,assertIsolatedRuntime,drainEffects,providerRead,providerMessage,nativeRead,observeReturningTicket,control:fence.control};
 return{evidenceMode:'simulated',provider:'WAHA',namespace:fixture.namespace,tenantId:session.tenantId,connectionId:fixture.connectionId,zammadGroupId:fixture.zammadGroupId,priorAssignmentDisposition:fixture.priorAssignmentDisposition??[],runtimeBinding:binding};
}

// Thin existing-manifest adapter, not a runner or another authentication path.
export async function directCapabilitiesStage(session,{namespace,inputs,config}){const group=inputs?.group;assert.equal(group?.evidenceMode,'simulated');assert.equal(group.namespace,namespace);assert.equal(group.tenantId,session.tenantId);
 // A completed review adoption keeps its one retained UNKNOWN as the only admitted original unknown.
 if(config?.completedReview){const f=inputs.reviewFixture,cap=session.capabilities?.reviewFixture;assert(f&&f===cap?.fixture,'Exact current completed review capability required');assert.equal(f.namespace,namespace);assert.equal(f.tenantId,session.tenantId);assert.equal(f.connectionId,group.connectionId);assert.equal(f.noReplay,true);assert(f.sourceNamespace&&f.sourceNamespace!==namespace);assert.equal(f.disposition,'retain-readonly-unknown');await cap.verifyReadOnly();return attachDirectCapabilities(session,{...group,provider:'WAHA'},{originalUnknowns:[f.retainedUnknown]});}
 return attachDirectCapabilities(session,{...group,provider:'WAHA'},{originalUnknowns:[]});}
