import assert from 'node:assert/strict';
export function actorCreationDisposition(state,users,{newClaim}){
 assert(Array.isArray(users)&&users.length<=1);
 if(state.userId){assert.equal(users[0]?.id,state.userId);return'reuse'}
 if(users.length){assert.equal(users[0].email,state.email);assert.equal(users[0].username,state.username);return'reconcile'}
 assert(newClaim,'Uncertain prior creation has no actor readback; review before another creation');return'create';
}
export function invitationDisposition(state,rows){
 if(state.invitationId)return'reuse';
 if(state.phase==='invitation-intent'){assert.equal(rows.length,1,'Uncertain invitation requires exact readback; no resend');return'reconcile'}
 assert.equal(rows.length,0,'Existing invitation is not owned by this stage');return'create';
}
export function factorVerificationAccepted(v){return v?.authenticated===true&&v?.identityMatched===true&&(v.mfaUsed===true||(v.mfaRequired===false&&v.factorEnrolled===true))}
