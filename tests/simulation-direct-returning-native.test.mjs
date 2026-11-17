import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateReturningNativeObservation,validateReturningPortalObservation} from '../scripts/release/simulation-direct-returning-native.mjs';


const marker='Synthetic returning marker',ticketId='42';
const native=()=>({startedAt:'2026-09-20T00:00:00.000Z',finishedAt:'2026-09-20T00:00:01.000Z',actor:{id:9,roles:[2],locale:'en-us'},actorVerified:true,actualViewport:{width:1440,height:1000},observedTicketId:ticketId,articleId:'73',markerSha256:createHash('sha256').update(marker).digest('hex'),rendered:{renderedTicketId:ticketId,articleId:'73',reload:true},noProviderReplay:true});




test('native returning proof rejects actor, viewport, ticket, marker, and replay drift',()=>{
 const invalid=[{actor:{id:9,roles:[1,2],locale:'en'}},{actualViewport:{width:820,height:1180}},{observedTicketId:'43'},{markerSha256:'0'.repeat(64)},{noProviderReplay:false}];
 for(const change of invalid)assert.throws(()=>validateReturningNativeObservation({...native(),...change},{ticketId,marker}));
});

const portal=()=>{const original=native();delete original.actor;return{...original,surface:'portal',ticketNumber:'1042',portalBinding:{contractVersion:2,surface:'portal',role:'agent',locale:'en',actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),viewport:original.actualViewport},rendered:{...original.rendered,surface:'portal',renderedTicketNumber:'1042'}};};
test('current returning observer requires portal rendering, exact article/number, measured actor and no replay',()=>{assert.equal(validateReturningPortalObservation(portal(),{ticketId,marker}).surface,'portal');for(const drift of [{surface:'native'},{portalBinding:{...portal().portalBinding,role:'tenant_owner'}},{portalBinding:{...portal().portalBinding,viewport:{width:390,height:844}}},{rendered:{...portal().rendered,renderedTicketNumber:'1043'}},{rendered:{...portal().rendered,articleId:'74'}},{noProviderReplay:false}])assert.throws(()=>validateReturningPortalObservation({...portal(),...drift},{ticketId,marker}));assert.throws(()=>validateReturningPortalObservation(native(),{ticketId,marker}));assert.throws(()=>validateReturningNativeObservation(portal(),{ticketId,marker}));});
