import assert from'node:assert/strict';import{runNativeMediaWithinCapture,nativeMediaTestIds}from'./simulation-native-media-business.mjs';import{runNativeNicknamesWithinCapture,nativeNicknameTestIds}from'./simulation-native-nickname-business.mjs';import{runNativeLinkJumpWithinCapture,nativeLinkTestIds}from'./simulation-native-link-jump.mjs';import{runMappedPnLidWithinCapture,mappedPnLidTestId}from'./simulation-native-pn-lid.mjs';
export const nativeRemainingTestIds=[...nativeMediaTestIds,...nativeNicknameTestIds,...nativeLinkTestIds,mappedPnLidTestId];
export async function runNativeRemainingWithinCapture(s,{business,config}){
 assert(business.fixtures?.phoneFallback);const results=[];
 results.push(await runMappedPnLidWithinCapture(s,config.mapping));
 results.push(...await runNativeNicknamesWithinCapture(s,{participants:config.nicknameParticipants}));
 results.push(...await runNativeMediaWithinCapture(s,{files:config.mediaFiles,mentionParticipant:config.mapping.pn}));
 if(business.ticket?.created?.proof.ticketId)results.push(...await runNativeLinkJumpWithinCapture(s,{target:business.fixtures.phoneFallback,ticketId:business.ticket.created.proof.ticketId}));else for(const row of blockedNativeLinkResults(business.ticket)){results.push(row);await s.checkpoint({phase:'native-link-result',...row});}
 assert.equal(new Set(results.map(x=>x.testId)).size,nativeRemainingTestIds.length);return results;
}
export function blockedNativeLinkResults(ticket){assert(ticket?.result==='failed'&&ticket.settled&&ticket.notApplied);const at=new Date().toISOString();return nativeLinkTestIds.map(testId=>({testId,result:'blocked',startedAt:at,finishedAt:at,proof:{blocker:'NATIVE_TICKET_CREATE_NOT_APPLIED',sourceTestIds:['group-workspace/open-closed-tickets-link-create-and-exact-message-jump::ticket-link-create-and-message-jump-open-exact-records::01','group-workspace/open-closed-tickets-link-create-and-exact-message-jump::ticket-link-create-and-message-jump-open-exact-records::02'],httpStatus:ticket.httpStatus,noReplay:true}}));}
