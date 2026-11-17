import assert from 'node:assert/strict';
import {assertMetaFixtureProvenance,assertMetaRuntimeBinding} from './simulation-meta-producer.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {runMetaChoiceLocation} from './simulation-meta-choice-events.mjs';
import {metaReaders} from './simulation-meta-choice-readers.mjs';
import {readMetaNativeArticle} from './simulation-meta-runtime.mjs';
export function assertChoiceAdmission(session, fixture, namespace, customer) {
 assert(/^[a-zA-Z0-9_-]{1,32}$/.test(namespace));
 assert.equal(fixture.evidenceMode,'simulated');
 assertMetaRuntimeBinding(fixture,session.metaCallbacks,session);
 const h=session.metaCallbacks;
 assert(/^\d{7,15}$/.test(customer));
 assert.notEqual(customer,h.cfg.binding.customer,'Choice scenario requires a separate current-run customer');
 const recipients=JSON.parse(session.model.services[h.cfg.graphService].environment.META_SIM_RECIPIENTS);
 assert(recipients.includes(customer),'Choice customer is outside admitted simulator recipients');
 assertMetaFixtureProvenance(fixture,namespace);
 assert.equal(fixture.producer.finalAssignmentState,'PAUSED');
 return h;
}
// Supporting producer, called within a tested stage. Never a standalone empty-test manifest stage.
export async function produceMetaChoices(session,{namespace,inputs,config}) {
 const f=inputs.metaDeliveries, h=assertChoiceAdmission(session,f,namespace,config.customer);
 const {tenantId,scoped,checkpoint}=session, connectionId=f.connectionId;
 const assignments=await scoped('SELECT id,state FROM bot_assignments WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]);
 assert.equal(assignments.length,1);assert.equal(assignments[0].id,f.producer.assignmentId);assert.equal(assignments[0].state,'PAUSED');
 assert.equal((await scoped('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3',[tenantId,connectionId,config.customer])).length,0,'Existing conversation must be reconciled, never replayed');
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:namespace+'-choices',checkpoint});
 const definition={schemaVersion:1,name:'Synthetic Meta choices '+namespace,start:'choice',maxSteps:6,nodes:[{id:'choice',type:'choice',prompt:'Choose landmark',options:[{id:'landmark',label:'Landmark',next:'location'}]},{id:'location',type:'request_location',prompt:'Send synthetic location',next:'handoff'},{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]};
 const flow=await request('/api/bot-flows','POST',definition,'choice-flow');
 await request('/api/bot-flows/'+flow.id+'/activate','POST',{expectedRevision:Number(flow.revision),expectedActiveFlowVersionId:null},'choice-activate');
 const assigned=await request('/api/bot-flows/assignments','POST',{connectionId,familyId:flow.familyId,zammadGroupId:String(h.cfg.zammadGroupId),agentPrefix:'Agent',agentIdentityPlacement:'HEADER'},'choice-assign');
 assert.equal(assigned.assignmentId,assignments[0].id);
 const readers=metaReaders({scoped,tenantId,connectionId,nativeArticleRead:async(ticketId,articleId)=>{
  const native=await readMetaNativeArticle(session,{ticketId,articleId});
  assert.equal(String(native.ticket_id),String(ticketId));return native;
 }});
 const result=await runMetaChoiceLocation({binding:{...h.cfg.binding,customer:config.customer},secret:h.cfg.appSecret,postRaw:h.postInbound,checkpoint,assertIsolatedRuntime:async()=>assertMetaRuntimeBinding(f,h,session),...readers,expectedChoiceNodeId:'location',runId:namespace+'-choices',persistInbound:h.persistInbound});
 await h.drain({connectionId,assignmentId:assigned.assignmentId});
 const conversations=await scoped('SELECT id,current_node_id,state,flow_version_id,zammad_ticket_id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3',[tenantId,connectionId,config.customer]);
 assert.equal(conversations.length,1);assert.equal(conversations[0].current_node_id,'handoff');assert.equal(conversations[0].flow_version_id,flow.id);
 const fixture={evidenceMode:'simulated',namespace,tenantId,connectionId,runtimeBinding:h.binding,flowId:flow.id,conversation:conversations[0],result,proofs:[],supportingEvidence:true};
 await checkpoint({phase:'meta-choice-location-supporting-fixture',fixture});return fixture;
}
