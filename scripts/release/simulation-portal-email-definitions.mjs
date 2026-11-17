import {definitions as historicalQuality} from './simulation-native-email-quality-definitions.mjs';
import {portalOperatorContexts} from './simulation-portal-operator.mjs';
const inbound='native-email-ingress/inbound-threading-attachments-and-client-routing::email-thread-attachments-and-route-render-in-zammad::';
const reply='native-email-ingress/agent-reply-delivery-and-bounce-handling::reply-delivery-and-bounce-states-render-in-zammad::';
const routing='client-routing/domains-addresses-identifiers-groups-and-manager-mapping::';
const oldBusiness=[inbound+'01',inbound+'02',inbound+'03',reply+'01'],oldFailure=[reply+'detail-1',reply+'detail-2'];
const oldRouting=['client-identifier-route-renders-authorized-destination','domain-route-renders-authorized-destination','exact-address-route-renders-authorized-destination','group-reference-route-renders-authorized-destination','manager-mapping-renders-authorized-owner'].map(name=>routing+name+'::01');
const oldSupport=routing+'support-scope-preserves-department-assignment::01';
export const portalEmailSuccessors=Object.freeze(Object.fromEntries([...oldBusiness,...oldFailure,...historicalQuality.map(row=>row.id),...oldRouting,oldSupport].map(id=>[id,id+'::portal'])));
export const portalEmailBusinessIds=oldBusiness.map(id=>portalEmailSuccessors[id]);
export const portalEmailFailureIds=oldFailure.map(id=>portalEmailSuccessors[id]);
export const portalRoutingFiveIds=oldRouting.map(id=>portalEmailSuccessors[id]);
export const portalRoutingSupportId=portalEmailSuccessors[oldSupport];
export const portalEmailAgentContextIds=portalOperatorContexts('agent','en').map(context=>context.contextId);
export const portalRoutingOwnerContextIds=[portalOperatorContexts('tenant_owner','en')[0].contextId];
export const portalEmailQualityDefinitions=historicalQuality.map(row=>({...row,id:portalEmailSuccessors[row.id],historicalTestId:row.id,
 requiredContextIds:[...portalEmailAgentContextIds],preconditions:['Current WasalX agent session and exact active managed native mapping.','Exact retained native email fixture; read-only UI observation with unchanged native/provider effects.']}));
export const portalEmailContextRequirements=Object.freeze(Object.fromEntries([
 ...[...portalEmailBusinessIds,...portalEmailFailureIds,...portalEmailQualityDefinitions.map(row=>row.id)].map(id=>[id,[...portalEmailAgentContextIds]]),
 ...portalRoutingFiveIds.map((id,index)=>[id,[...portalRoutingOwnerContextIds,...portalEmailAgentContextIds,...(index===2?['auditor-en-desktop','supervisor-en-desktop','tenant_admin-en-desktop']:[])]]),[portalRoutingSupportId,[...portalRoutingOwnerContextIds]]
]));
