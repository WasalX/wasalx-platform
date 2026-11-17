import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export function validateReturningNativeObservation(value,{ticketId,marker}){
 assert(value&&value.actorVerified===true);assert(Number.isSafeInteger(value.actor?.id)&&value.actor.id>0);assert(Array.isArray(value.actor.roles)&&value.actor.roles.includes(2)&&!value.actor.roles.includes(1));
 assert.deepEqual(value.actualViewport,{width:1440,height:1000});assert.equal(value.observedTicketId,String(ticketId));assert.match(value.articleId,/^\d+$/u);assert.equal(value.markerSha256,createHash('sha256').update(marker).digest('hex'));
 assert.equal(value.rendered?.renderedTicketId,String(ticketId));assert.equal(value.rendered.articleId,value.articleId);assert.equal(value.rendered.reload,true);assert.equal(value.noProviderReplay,true);
 assert(Date.parse(value.startedAt)<=Date.parse(value.finishedAt));return value;
}

// Current WasalX observations have a portal actor; historical native proof stays unchanged.
export function validateReturningPortalObservation(value,{ticketId,marker}){
 assert(value?.surface==='portal'&&value.actorVerified===true&&value.portalBinding?.contractVersion===2);
 assert.equal(value.portalBinding.surface,'portal');assert.equal(value.portalBinding.role,'agent');assert.equal(value.portalBinding.locale,'en');
 assert.match(value.portalBinding.actorRef,/^sha256:[a-f0-9]{64}$/u);assert.match(value.portalBinding.tenantRef,/^sha256:[a-f0-9]{64}$/u);
 assert.deepEqual(value.actualViewport,{width:1440,height:1000});assert.deepEqual(value.portalBinding.viewport,value.actualViewport);
 assert.equal(value.observedTicketId,String(ticketId));assert.match(value.ticketNumber,/^[1-9][0-9]{0,15}$/u);assert.match(value.articleId,/^[1-9][0-9]{0,15}$/u);
 assert.equal(value.markerSha256,createHash('sha256').update(marker).digest('hex'));assert.equal(value.rendered?.surface,'portal');
 assert.equal(value.rendered.renderedTicketId,String(ticketId));assert.equal(value.rendered.renderedTicketNumber,value.ticketNumber);assert.equal(value.rendered.articleId,value.articleId);
 assert.equal(value.rendered.reload,true);assert.equal(value.noProviderReplay,true);assert(Date.parse(value.startedAt)<=Date.parse(value.finishedAt));return value;
}
