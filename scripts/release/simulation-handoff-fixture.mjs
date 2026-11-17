import assert from 'node:assert/strict';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {privateNativeRead} from './simulation-private-native-read.mjs';
import {readDirectProviderReceipts} from './simulation-direct-capabilities.mjs';
import {inspectComposeService} from './simulation-stack-session.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {createHash} from 'node:crypto';
import {simulationEventId} from './synthetic-first-group-driver.mjs';

const uuid=value=>assert.match(value,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);
export const handoffRetryTestId='direct-automation/human-handoff-pause-resume-and-bot-return::human-ownership-suppresses-bot-replies::failed-handoff-ui-retry-same-job';
export const handoffAssignmentSql=`SELECT assignment.id,assignment.state,assignment.revision,assignment.flow_version_id,version.definition
 FROM bot_assignments assignment JOIN bot_flow_versions version ON version.tenant_id=assignment.tenant_id AND version.id=assignment.flow_version_id
 WHERE assignment.tenant_id=$1 AND assignment.connection_id=$2 ORDER BY assignment.id`;
export const handoffFixtureSql=`SELECT job.id,job.tenant_id,job.conversation_id,job.source_event_id,job.state,job.attempts,
 job.fencing_token,job.lease_id,job.lease_expires_at,conversation.connection_id,conversation.state AS conversation_state,
 conversation.fencing_token AS conversation_fencing_token,conversation.zammad_ticket_id,conversation.assignment_id,conversation.flow_version_id,version.definition->>'name' AS flow_name
 FROM bot_handoff_jobs job JOIN bot_conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
 JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
 WHERE job.tenant_id=$1 AND conversation.connection_id=$2 AND conversation.external_chat_id=$3 ORDER BY job.created_at,job.id`;

export function assertHandoffFixtureSnapshot(value,{tenantId,connectionId,state,original}={}){
 const {job,native}=value;for(const key of ['id','tenant_id','conversation_id','source_event_id','connection_id'])uuid(job[key]);
 assert.equal(job.tenant_id,tenantId);assert.equal(job.connection_id,connectionId);assert.equal(job.state,state);
 assert.equal(job.lease_id,null);assert.equal(job.lease_expires_at,null);assert.match(String(job.zammad_ticket_id),/^[1-9][0-9]{0,15}$/u);
 assert(Number.isSafeInteger(Number(job.conversation_fencing_token))&&Number(job.conversation_fencing_token)>=0);
 assert.equal(native.ticketId,String(job.zammad_ticket_id));assert.match(native.ticketNumber,/^[1-9][0-9]{0,19}$/u);assert.equal(native.ticketCount,1);assert(Array.isArray(native.noteIds));assert.equal(new Set(native.noteIds).size,native.noteIds.length);
 if(state==='QUEUED'&&!original){assert.equal(Number(job.attempts),0);assert.equal(Number(job.fencing_token),0);assert.equal(job.conversation_state,'HANDOFF_PENDING');assert.equal(native.noteIds.length,0);}
 else if(state==='FAILED_RETRYABLE'){if(original)assert.equal(Number(job.conversation_fencing_token),Number(original.job.conversation_fencing_token));assert.equal(Number(job.attempts),1);assert.equal(Number(job.fencing_token),1);assert.equal(job.conversation_state,'HANDOFF_PENDING');assert.equal(native.noteIds.length,0);}
 else if(state==='QUEUED'){assert(original);assert.equal(Number(job.attempts),1);assert.equal(Number(job.fencing_token),1);assert.equal(job.conversation_state,'HANDOFF_PENDING');assert.equal(Number(job.conversation_fencing_token),Number(original.job.conversation_fencing_token)+1);assert.equal(native.noteIds.length,0);}
 else{assert.equal(state,'SUCCEEDED');assert(original);assert.equal(Number(job.attempts),2);assert.equal(Number(job.fencing_token),2);assert.equal(job.conversation_state,'HUMAN');assert.equal(Number(job.conversation_fencing_token),Number(original.job.conversation_fencing_token)+2);assert.equal(native.noteIds.length,1);assert.match(native.noteIds[0],/^[1-9][0-9]{0,15}$/u);}
 if(original)for(const key of ['id','tenant_id','connection_id','conversation_id','source_event_id','zammad_ticket_id','assignment_id','flow_version_id'])assert.equal(job[key],original.job[key],'Handoff original binding changed: '+key);
 return value;
}

const queuePrelude=`import assert from 'node:assert/strict';import {Queue} from 'bullmq';
 const url=new URL(process.env.REDIS_URL);const queue=new Queue('wasalx-tenant-drain',{connection:{host:url.hostname,port:Number(url.port||6379),username:decodeURIComponent(url.username)||undefined,password:decodeURIComponent(url.password)||undefined}});`;
export function handoffQueueScript(action){
 assert(['pause','read','resume'].includes(action));
 return queuePrelude+`try{await queue.waitUntilReady();
 ${action==='pause'?"assert.equal(await queue.isPaused(),false,'Existing paused queue must be reconciled');await queue.pause();":''}
 const deadline=Date.now()+120000;while(await queue.getActiveCount()){assert(Date.now()<deadline,'Active workers must settle before fixture mutation');await new Promise(resolve=>setTimeout(resolve,100));}
 const active=0;${action==='resume'?"assert.equal(await queue.isPaused(),true,'Owned queue pause changed');await queue.resume();":''}
 console.log(JSON.stringify({paused:await queue.isPaused(),active}));}finally{await queue.close();}`;
}

// Settle only the fresh flow's text delivery; handoff claiming stays disabled in this phase.
export function handoffSetupScript({tenantId,connectionId,jobId,conversationId,sourceEventId,chatId,textSha256}){
 for(const value of [tenantId,connectionId,jobId,conversationId,sourceEventId])uuid(value);
 assert.match(chatId,/^[0-9]{6,20}@c\.us$/u);assert.match(textSha256,/^[a-f0-9]{64}$/u);
 return `import assert from 'node:assert/strict';import {Pool} from 'pg';
 import {DeliveryProcessor} from '/app/dist/services/connector-worker/src/processor.js';
 import {OutboxRepository} from '/app/dist/services/connector-worker/src/repository.js';
 import {SidecarSecretResolver} from '/app/dist/services/connector-worker/src/secrets.js';
 import {parseWahaWorkerConfigs} from '/app/dist/services/connector-worker/src/waha-worker-registry.js';
 import {setMetaTestPhoneTransaction} from '/app/dist/packages/core/src/meta-test-phone-policy.js';
 ${queuePrelude.replace("import assert from 'node:assert/strict';",'')}
 const expected=${JSON.stringify({tenantId,connectionId,jobId,conversationId,sourceEventId,chatId,textSha256})};
 const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c role=wasalx_connector_worker',max:1}),repository=new OutboxRepository(pool);
 const scoped=async(sql,args=[])=>{const client=await pool.connect();try{await client.query('BEGIN READ ONLY');await setMetaTestPhoneTransaction(client,expected.tenantId);const result=await client.query(sql,args);await client.query('ROLLBACK');return result.rows;}finally{client.release();}};
 try{await queue.waitUntilReady();assert.equal(await queue.isPaused(),true);assert.equal(await queue.getActiveCount(),0);
 const rows=await scoped("SELECT id,connection_id,bot_conversation_id,external_chat_id,idempotency_key,state,attempts,lease_id,lease_expires_at,encode(digest(message_body,'sha256'),'hex') AS text_sha256 FROM delivery_outbox WHERE tenant_id=$1 AND (bot_conversation_id=$2 OR state NOT IN ('SENT','DELIVERED','READ','CANCELLED','PRIVACY_CANCELLED','FAILED_TERMINAL') OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL OR (state='FAILED_TERMINAL' AND manual_retry_allowed)) ORDER BY id",[expected.tenantId,expected.conversationId]);
 assert.equal(rows.length,1,'Only the exact new setup delivery may be pending');const delivery=rows[0];assert.equal(delivery.connection_id,expected.connectionId);assert.equal(delivery.bot_conversation_id,expected.conversationId);assert.equal(delivery.external_chat_id,expected.chatId);assert.equal(delivery.idempotency_key,'bot:'+expected.conversationId+':'+expected.sourceEventId+':0');assert.equal(delivery.text_sha256,expected.textSha256);assert.equal(delivery.state,'QUEUED');assert.equal(Number(delivery.attempts),0);assert.equal(delivery.lease_id,null);assert.equal(delivery.lease_expires_at,null);
 const statuses=await scoped('SELECT delivery_id FROM zammad_status_outbox WHERE tenant_id=$1 AND (completed_at IS NULL OR lease_id IS NOT NULL OR lease_expires_at IS NOT NULL)',[expected.tenantId]);assert(statuses.every(row=>row.delivery_id===delivery.id),'Unrelated native status work requires reconciliation');
 let claims=0;const bounded=new Proxy(repository,{get(target,key){if(['claimBotActions','claimBotHandoffs','claimDirectCustomerCloses','claimConversationStates'].includes(key))return async()=>[];if(key==='claimDeliveries')return async(tenant,lease)=>{assert.equal(tenant,expected.tenantId);assert.equal(++claims,1);const jobs=await target.claimDeliveries(tenant,lease,1);assert.equal(jobs.length,1);assert.equal(jobs[0].id,delivery.id);assert.equal(jobs[0].botConversationId,expected.conversationId);return jobs;};if(key==='claimStatuses')return async(tenant,lease)=>{assert.equal(tenant,expected.tenantId);const jobs=await target.claimStatuses(tenant,lease);assert(jobs.every(job=>job.deliveryId===delivery.id));return jobs;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const resolver=new SidecarSecretResolver(process.env.SECRET_SIDECAR_URL,process.env.SECRET_SIDECAR_TOKEN,process.env.NODE_ENV==='production',parseWahaWorkerConfigs().map(worker=>worker.secretReference));
 await new DeliveryProcessor(bounded,resolver,{metaGraphVersion:process.env.META_GRAPH_VERSION||'v24.0'}).drainTenant(expected.tenantId);
 const [settled]=await scoped('SELECT id,state,attempts,external_message_id,lease_id,lease_expires_at FROM delivery_outbox WHERE tenant_id=$1 AND id=$2',[expected.tenantId,delivery.id]);assert.equal(settled.state,'SENT');assert.equal(Number(settled.attempts),1);assert(settled.external_message_id);assert.equal(settled.lease_id,null);assert.equal(settled.lease_expires_at,null);
 const status=await scoped('SELECT id,completed_at,lease_id,lease_expires_at,safe_error,delivery_state,attempts FROM zammad_status_outbox WHERE tenant_id=$1 AND delivery_id=$2',[expected.tenantId,delivery.id]);assert(status.length===1&&status.every(row=>row.completed_at&&row.lease_id===null&&row.lease_expires_at===null&&row.safe_error===null&&row.delivery_state==='SENT'&&Number(row.attempts)===1),'Setup native status must settle before the no-resend baseline');
 const [job]=await scoped('SELECT id,state,attempts,fencing_token,lease_id,lease_expires_at FROM bot_handoff_jobs WHERE tenant_id=$1 AND id=$2',[expected.tenantId,expected.jobId]);assert.equal(job.state,'QUEUED');assert.equal(Number(job.attempts),0);assert.equal(Number(job.fencing_token),0);assert.equal(job.lease_id,null);assert.equal(job.lease_expires_at,null);
 console.log(JSON.stringify({delivery:settled,textSha256:expected.textSha256,handoffUnclaimed:true}));
 }finally{await repository.close();await queue.close();}`;
}

export function assertHandoffSetupReceipts(before,after,setup,{chatId,textSha256}){
 assert.equal(before.evidenceClass,'simulated-provider');assert.equal(after.evidenceClass,'simulated-provider');
 assert.deepEqual(after.receipts.slice(0,before.receipts.length),before.receipts,'Prior provider receipts changed');
 assert.equal(after.receipts.length,before.receipts.length+1);assert.equal(after.receivedSends,before.receivedSends+1,'Setup must send exactly once');
 const added=after.receipts.at(-1);assert.equal(added.id,setup.delivery.external_message_id);assert(added.id.startsWith('true_'+chatId+'_'));assert.equal(added.textSha256,textSha256);
 assert.equal(setup.delivery.state,'SENT');assert.equal(Number(setup.delivery.attempts),1);assert.equal(setup.delivery.lease_id,null);assert.equal(setup.delivery.lease_expires_at,null);assert.equal(setup.textSha256,textSha256);assert.equal(setup.handoffUnclaimed,true);
}

export function assertHandoffAssignment(assignment,direct,{namespace,tenantId,connectionId,chatId}){
 const f=direct?.fixtures;assert.equal(f?.tenantId,tenantId);assert.equal(f.connectionId,connectionId);uuid(f.assignmentId);uuid(direct.secondVersion);
 assert.equal(direct.sourceRunId,undefined,'Handoff retry requires the current fresh flow, not a retained activation');
 assert.equal(direct.assignmentDisposition?.id,f.assignmentId);assert.equal(direct.assignmentDisposition.state,'PAUSED');
 assert(!f.chatIds.includes(chatId),'Handoff fixture cannot reuse a previous conversation');
 assert.equal(assignment.id,f.assignmentId);assert.equal(assignment.flow_version_id,direct.secondVersion);assert.equal(assignment.state,'PAUSED');
 assert.equal(Number(assignment.revision),Number(direct.assignmentDisposition.revision));
 const definition=assignment.definition;assert.equal(definition?.name,'Synthetic direct '+namespace);assert.equal(definition.keepOpenPolicy,undefined,'No customer-control provider effect is admitted by the no-resend property');
 assert.equal(definition.start,'hello');assert.deepEqual(definition.nodes,[{id:'hello',type:'send_text',text:'Synthetic '+namespace+' V2',next:'handoff'},{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]);
 return createHash('sha256').update(definition.nodes[0].text).digest('hex');
}

// Actual worker/repository code records the failure; the only fake is a transient dependency refusal.
export function handoffRefusalScript({tenantId,connectionId,jobId,conversationId}){
 for(const value of [tenantId,connectionId,jobId,conversationId])uuid(value);
 return `import assert from 'node:assert/strict';import {Pool} from 'pg';
 import {DeliveryProcessor} from '/app/dist/services/connector-worker/src/processor.js';
 import {OutboxRepository} from '/app/dist/services/connector-worker/src/repository.js';
 import {SecretResolutionError} from '/app/dist/services/connector-worker/src/secrets.js';
 import {setMetaTestPhoneTransaction} from '/app/dist/packages/core/src/meta-test-phone-policy.js';
 ${queuePrelude.replace("import assert from 'node:assert/strict';",'')}
 const expected=${JSON.stringify({tenantId,connectionId,jobId,conversationId})};
 const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c role=wasalx_connector_worker',max:1});const repository=new OutboxRepository(pool);let refusals=0,nativeRequests=0,claimed;const nativeFetch=globalThis.fetch;globalThis.fetch=async()=>{nativeRequests++;throw Error('Pre-effect refusal attempted a native/network request');};
 try{await queue.waitUntilReady();assert.equal(await queue.isPaused(),true);assert.equal(await queue.getActiveCount(),0);
 const client=await pool.connect();try{await client.query('BEGIN');await setMetaTestPhoneTransaction(client,expected.tenantId);
 const rows=(await client.query("SELECT job.id,job.state,job.attempts,job.conversation_id,conversation.connection_id FROM bot_handoff_jobs job JOIN bot_conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id WHERE job.tenant_id=$1 AND job.state IN ('QUEUED','FAILED_RETRYABLE','RUNNING') ORDER BY job.id",[expected.tenantId])).rows;
 assert.equal(rows.length,1,'Only the exact fresh handoff may be runnable');const row=rows[0];assert.equal(row.id,expected.jobId);assert.equal(row.state,'QUEUED');assert.equal(Number(row.attempts),0);assert.equal(row.conversation_id,expected.conversationId);assert.equal(row.connection_id,expected.connectionId);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const bounded={claimBotActions:async()=>[],claimDeliveries:async()=>[],claimStatuses:async()=>[],claimBotHandoffs:async(tenant,lease)=>{assert.equal(tenant,expected.tenantId);const jobs=await repository.claimBotHandoffs(tenant,lease,1);assert.equal(jobs.length,1);claimed=jobs[0];assert.equal(claimed.id,expected.jobId);assert.equal(claimed.conversationId,expected.conversationId);return jobs;},retryBotHandoff:(...args)=>repository.retryBotHandoff(...args),failBotHandoff:async()=>{throw Error('Fixture unexpectedly reached terminal/successor semantics');}};
 const processor=new DeliveryProcessor(bounded,{resolve:async(reference,owner)=>{assert.equal(reference,claimed.zammadSecretReference);assert.deepEqual(owner,{kind:'zammad',tenantId:expected.tenantId,purpose:'service'});assert.equal(++refusals,1);throw new SecretResolutionError('Synthetic handoff dependency unavailable',true);}},{metaGraphVersion:process.env.META_GRAPH_VERSION||'v24.0'});
 await processor.drainTenant(expected.tenantId);assert.equal(refusals,1);assert.equal(nativeRequests,0);console.log(JSON.stringify({jobId:claimed.id,conversationId:claimed.conversationId,refusals,nativeRequests,fault:'test-only-transient-dependency-refusal'}));
 }finally{globalThis.fetch=nativeFetch;await repository.close();await queue.close();}`;
}

export async function prepareHandoffRetryFixture(s,{namespace,inputs,config,testIds,createPending}){
 assert.equal(s.operatorSurface,'portal');assert.match(namespace,/^[A-Za-z0-9-]{1,40}$/u);assert.match(s.model?.name??'',/^wasalx-simulation-[A-Za-z0-9_-]+$/u);
 assert(s.actorBinding?.userMatched&&s.actorBinding?.workspaceMatched);assert.equal(typeof createPending,'function');assert(!s.capabilities?.handoffRetryFixture,'Reconcile the original handoff fixture before re-entry');
 const f=inputs?.directConnection,h=s.directCallbacks;assert.equal(f?.evidenceMode,'simulated');assert.equal(f.provider,'WAHA');assert.equal(f.namespace,namespace);assert.equal(f.tenantId,s.tenantId);uuid(s.tenantId);uuid(f.connectionId);
 assert.equal(config?.testId,handoffRetryTestId,'Exact governed handoff retry property required');assert.equal(config.sourceNamespace,namespace,'Handoff source namespace mismatch');assert.deepEqual(testIds,[config.testId],'Handoff property must be allocated by the selected governed catalog');
 const chatId=config?.chatId;assert.match(chatId,/^[0-9]{6,20}@c\.us$/u);assert(f.runtimeBinding&&h?.binding);
 for(const key of ['project','connectionId','providerSessionId','containerId','imageId','socketPath'])assert.equal(f.runtimeBinding[key],h.binding[key]);
 assert.equal(h.binding.project,s.model.name);assert.equal(h.binding.connectionId,f.connectionId);assert.equal(h.binding.socketPath,s.socketPath);
 const admission=()=>h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:f.connectionId,chatIds:[chatId]});
 const verifyActor=async()=>{const proof=await s.verifyOwner(s.ownerPage);assert(proof?.userMatched&&proof.workspaceMatched,'Current portal owner/tenant verification required');};
 await verifyActor();await admission();await h.drainEffects();
 const assignments=await s.scoped(handoffAssignmentSql,[s.tenantId,f.connectionId]);assert.equal(assignments.length,1,'One exact current assignment required');const assignment=assignments[0];
 const textSha256=assertHandoffAssignment(assignment,inputs.directFlow,{namespace,tenantId:s.tenantId,connectionId:f.connectionId,chatId});
 assert.equal((await s.scoped('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3',[s.tenantId,f.connectionId,chatId])).length,0,'Handoff retry requires a fresh admitted conversation');
 const providerBefore=await readDirectProviderReceipts(s);
 const worker=await inspectComposeService(s.run,s.model.name,'connector-worker');assert.equal(worker.Id,s.containers['connector-worker'].Id);assert.equal(worker.Image,s.containers['connector-worker'].Image);
 const command=async script=>{await admission();return JSON.parse(await s.run('docker',['exec','--workdir','/app',worker.Id,'node','--input-type=module','-e',script]));};
 const read=async()=>{await admission();const rows=await s.scoped(handoffFixtureSql,[s.tenantId,f.connectionId,chatId]);assert.equal(rows.length,1,'One exact run-owned conversation/job required');const job=rows[0];return{job,native:await privateNativeRead(s,'handoff-evidence',{ticketId:String(job.zammad_ticket_id),jobId:job.id,connectionId:f.connectionId})};};
 assert.equal((await s.scoped(handoffFixtureSql,[s.tenantId,f.connectionId,chatId])).length,0,'Existing handoff must be reconciled, never reseeded');
 const claim=await open(join(s.privateDir,'handoff-fixture-'+namespace+'.claim.json'),'wx',0o600);try{await claim.writeFile(JSON.stringify({evidenceMode:'simulated',namespace,project:s.model.name,tenantId:s.tenantId,connectionId:f.connectionId,chatId,candidate:s.candidate,assignment,textSha256,providerBefore,worker:{id:worker.Id,image:worker.Image},disposition:'reconcile-original-queue-pause-and-job-before-resume'}));await claim.sync();}finally{await claim.close();}
 await s.checkpoint({phase:'handoff-queue-pause-intent',namespace});await command(handoffQueueScript('pause'));
 const request=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace,checkpoint:s.checkpoint});
 const setAssignment=async(state,revision)=>{await verifyActor();await admission();const result=await request('/api/bot-flows/assignments/'+assignment.id+'/state','POST',{state,expectedRevision:revision},'handoff-assignment-'+state.toLowerCase());assert.equal(result.assignmentId,assignment.id);assert.equal(result.state,state);assert.equal(result.revision,revision+1);const [current]=await s.scoped(handoffAssignmentSql,[s.tenantId,f.connectionId]);assert.equal(current.id,assignment.id);assert.equal(current.state,state);assert.equal(current.flow_version_id,assignment.flow_version_id);assert.equal(Number(current.revision),revision+1);assert.deepEqual(current.definition,assignment.definition);};
 await setAssignment('ACTIVE',Number(assignment.revision));
 await createPending();await verifyActor();const queued=assertHandoffFixtureSnapshot(await read(),{tenantId:s.tenantId,connectionId:f.connectionId,state:'QUEUED'});
 assert.equal(queued.job.assignment_id,assignment.id);assert.equal(queued.job.flow_version_id,assignment.flow_version_id);
 const ingress=await s.scoped("SELECT id FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'WAHA',$4) AND status='PROCESSED' AND lease_id IS NULL AND lease_expires_at IS NULL AND processed_at IS NOT NULL",[s.tenantId,f.connectionId,queued.job.source_event_id,simulationEventId(namespace+'-handoff-pending')]);assert.deepEqual(ingress.map(row=>row.id),[queued.job.source_event_id],'Handoff must come from the one current pending inbound');
 await setAssignment('PAUSED',Number(assignment.revision)+1);
 await s.checkpoint({phase:'handoff-setup-delivery-intent',jobId:queued.job.id,sourceEventId:queued.job.source_event_id,textSha256});
 const setup=await command(handoffSetupScript({tenantId:s.tenantId,connectionId:f.connectionId,jobId:queued.job.id,conversationId:queued.job.conversation_id,sourceEventId:queued.job.source_event_id,chatId,textSha256}));
 const provider=await readDirectProviderReceipts(s);assertHandoffSetupReceipts(providerBefore,provider,setup,{chatId,textSha256});
 assertHandoffFixtureSnapshot(await read(),{tenantId:s.tenantId,connectionId:f.connectionId,state:'QUEUED'});
 await s.checkpoint({phase:'handoff-setup-delivery-settled',setup,provider});
 await s.checkpoint({phase:'handoff-pre-effect-refusal-intent',jobId:queued.job.id,conversationId:queued.job.conversation_id});
 const refusal=await command(handoffRefusalScript({tenantId:s.tenantId,connectionId:f.connectionId,jobId:queued.job.id,conversationId:queued.job.conversation_id}));assert.equal(refusal.jobId,queued.job.id);assert.equal(refusal.refusals,1);assert.equal(refusal.nativeRequests,0);
 const failed=assertHandoffFixtureSnapshot(await read(),{tenantId:s.tenantId,connectionId:f.connectionId,state:'FAILED_RETRYABLE',original:queued});assert.deepEqual(await readDirectProviderReceipts(s),provider,'Pre-effect handoff refusal changed provider receipts');
 let resumed=false;
 const fixture={evidenceMode:'simulated',namespace,tenantId:s.tenantId,connectionId:f.connectionId,conversationId:failed.job.conversation_id,jobId:failed.job.id,jobState:'FAILED_RETRYABLE',ticketId:failed.native.ticketId,ticketNumber:failed.native.ticketNumber,fencingToken:Number(failed.job.conversation_fencing_token),flowName:failed.job.flow_name,testId:config.testId,noReplay:true};assert.equal(typeof fixture.flowName,'string');assert(fixture.flowName.length);
 const capability={fixture,failed,read,readNotes:async ticketId=>{assert.equal(String(ticketId),failed.native.ticketId,'Only the original handoff ticket is authorized');await admission();return privateNativeRead(s,'articles',{ticketId:failed.native.ticketId});},resumeAfterRetry:async()=>{assert(!resumed,'Never resume/replay the original retry twice');assertHandoffFixtureSnapshot(await read(),{tenantId:s.tenantId,connectionId:f.connectionId,state:'QUEUED',original:failed});await s.checkpoint({phase:'handoff-ui-retry-queued',jobId:failed.job.id});resumed=true;await command(handoffQueueScript('resume'));},verifySettled:async()=>{assert(resumed,'A normal UI retry must precede settlement');const result=assertHandoffFixtureSnapshot(await read(),{tenantId:s.tenantId,connectionId:f.connectionId,state:'SUCCEEDED',original:failed});assert.deepEqual(await readDirectProviderReceipts(s),provider,'Handoff retry sent another provider message');return result;}};
 s.capabilities??={};s.capabilities.handoffRetryFixture=capability;await s.checkpoint({phase:'handoff-retry-fixture-ready',failed,refusal});return capability;
}
