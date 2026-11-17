import {definitions} from './simulation-native-group-definitions.mjs';
import {portalOperatorContexts} from './simulation-portal-operator.mjs';
const successor=id=>`${id}::portal`;
export const groupMutationPrefix='group-workspace/live-inbound-outbound-edits-revokes-reactions-and-attribution::';
export const groupTicketPrefix='group-workspace/open-closed-tickets-link-create-and-exact-message-jump::ticket-link-create-and-message-jump-open-exact-records::';
export const groupMediaPrefix='group-workspace/quote-ticketless-send-media-voice-video-files-and-mentions::';
export const mediaLabels={audio:'audio-send',document:'document-send',image:'image-send',mention:'mention-send',quote:'quoted-reply',text:'ticketless-text',video:'video-send',voice:'voice-send'};
export const originalBusinessIds=[...[1,2,3,4,5].map(n=>groupMutationPrefix+'message-mutations-and-attribution-render-safely::0'+n),groupMutationPrefix+'participant-nickname-consistency::fallback',groupTicketPrefix+'01',groupTicketPrefix+'02'];
export const originalMediaIds=[...Object.values(mediaLabels).map(x=>groupMediaPrefix+x+'-renders-durable-delivery-state::01'),groupMediaPrefix+'voice-send-renders-durable-delivery-state::detail-1'];
export const originalNicknameIds=['native-history-name','refresh','name-quality','same-name'].map(x=>groupMutationPrefix+'participant-nickname-consistency::'+x);
export const originalLinkIds=[groupTicketPrefix+'03',groupTicketPrefix+'04'];
export const originalPnLidId=groupMutationPrefix+'participant-nickname-consistency::pn-lid';
export const originalCrossConnectionId=groupMutationPrefix+'participant-nickname-consistency::reload-other-connection';
export const originalGrantIds=[1,2,3,4].map(n=>'team-access/team-group-grants-independent-from-ticket-ownership::group-history-and-ticket-access-remain-independent::0'+n);
export const originalGrantQualityIds=['loading','safe-error-recovery','reload','keyboard-focus','console','network','empty','degraded'].flatMap(x=>['team-access/team-group-grants-independent-from-ticket-ownership','privacy-retention/media-and-history-authorization-boundaries'].map(p=>p+'::ui-quality::'+x));
export const originalHistoryIds=[1,2,3].map(n=>'group-workspace/accessible-group-views-history-unread-and-pagination::authorized-group-history-unread-and-pages-render::0'+n);
export const originalPrivacyIds=[1,2].map(n=>'privacy-retention/media-and-history-authorization-boundaries::unauthorized-media-and-history-remain-unavailable::detail-'+n);
const agentContexts=portalOperatorContexts('agent','en').map(row=>row.contextId),agentDesktop=agentContexts.slice(0,1);
export const portalGroupDefinitions=definitions.map(row=>({...row,id:successor(row.id),supersedesTestId:row.id,surface:'portal',requiredContextIds:[...agentContexts],preconditions:['Current authenticated WasalX agent with a READY native identity projection and explicit team-access barrier.','Current simulated group fixture, retained capture epoch and provider receipt oracle.','Actual WasalX Groups controls rendered in the declared viewport; backend readback corroborates their outcome.']}));
export const completePortalBusinessTestIds=[...originalBusinessIds,...originalMediaIds,...originalNicknameIds,...originalLinkIds,originalPnLidId].map(successor);
export const portalGrantTestIds=originalGrantIds.map(successor),portalGrantQualityIds=originalGrantQualityIds.map(successor),portalHistoryIds=originalHistoryIds.map(successor),portalPrivacyIds=originalPrivacyIds.map(successor);
export const portalCrossConnectionNicknameId=successor(originalCrossConnectionId);
export const portalGroupSuccessors=Object.fromEntries([...new Set([...definitions.map(row=>row.id),...originalBusinessIds,...originalMediaIds,...originalNicknameIds,...originalLinkIds,originalPnLidId,originalCrossConnectionId,...originalGrantIds,...originalGrantQualityIds,...originalHistoryIds,...originalPrivacyIds])].map(id=>[id,successor(id)]));
export const portalGroupContextRequirements=Object.fromEntries([
 ...definitions.map(row=>[successor(row.id),[...agentContexts]]),
 ...[...originalBusinessIds,...originalMediaIds,...originalNicknameIds,...originalLinkIds,originalPnLidId,...originalGrantIds,...originalGrantQualityIds.filter(id=>!id.startsWith('team-access/'))].map(id=>[successor(id),[...agentDesktop]]),
 ...[...originalHistoryIds,...originalPrivacyIds,...originalGrantQualityIds.filter(id=>id.startsWith('team-access/')),originalCrossConnectionId].map(id=>[successor(id),[...agentContexts]]),
]);
