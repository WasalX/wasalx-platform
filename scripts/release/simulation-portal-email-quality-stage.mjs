import assert from 'node:assert/strict';
import {definitions} from './simulation-portal-email-quality-definitions.mjs';
import {ensurePortalOperator,portalOperatorContexts,privateNativeRead} from './simulation-portal-operator.mjs';
import {ownedSmtpFiles} from './simulation-smtp-files.mjs';
import {inspectComposeService} from './simulation-stack-session.mjs';
import {runPortalEmailQuality} from './simulation-portal-email-quality.mjs';
export async function portalEmailQualityStage(session,{namespace,inputs,config}){
 const contexts=portalOperatorContexts('agent','en');assert.deepEqual(config.contextIds,contexts.map(context=>context.contextId));
 const email=inputs.email;assert.equal(email?.evidenceMode,'simulated');assert.equal(email.namespace,namespace);assert.equal(email.tenantId,session.tenantId);assert.equal(email.operatorSurface,'portal');
 const ticketId=email.initial?.ticketId,articleIds=[email.initial?.articleId,email.followup?.articleId,email.reply?.articleId];
 assert(Number.isSafeInteger(Number(ticketId))&&Number(ticketId)>0);assert(articleIds.every(id=>Number.isSafeInteger(Number(id))&&Number(id)>0));assert.equal(new Set(articleIds.map(String)).size,3);
 assert.equal(String(email.followup.ticketId),String(ticketId));assert.equal(String(email.reply.ticketId),String(ticketId));
 const operator=await ensurePortalOperator(session,{role:'agent',locale:'en'}),ticket=await privateNativeRead(session,'ticket',{ticketId});
 assert.equal(String(ticket.id),String(ticketId));assert.equal(String(operator.nativeUserId),String(email.nativeUserId));
 const sink=await inspectComposeService(session.run,session.model.name,'alpha-smtp');assert.equal(sink.Id,email.ownership.sinkId);assert.equal(sink.State.Health?.Status,'healthy');
 const smtp=await ownedSmtpFiles(session,sink),results=[];
 for(const context of contexts){const packet=await runPortalEmailQuality({operator,ticketId,ticketNumber:ticket.number,articleId:email.followup.articleId,expectedArticleIds:articleIds,namespace,checkpoint:session.checkpoint,providerRead:()=>smtp.read('journal.jsonl').then(bytes=>bytes.toString('utf8')),testDefinitions:definitions,context});results.push(...packet.results);}
 assert.equal(results.length,definitions.length*contexts.length);return{evidenceMode:'simulated',namespace,tenantId:session.tenantId,operatorSurface:'portal',results,noNewMail:true};
}
