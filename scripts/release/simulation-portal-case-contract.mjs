import assert from 'node:assert/strict';
const journey='cases-deliveries/exact-case-lookup-and-direct-agent-navigation::';
export const navigationId=journey+'exact-case-opens-the-authorized-agent-destination::02';
export const previewId=journey+'native-agent-reply-workflow-preview-and-delivery-match::02';
export const qualityIds=['reload','console','network','loading','safe-error-recovery','keyboard-focus','empty','degraded'].map(s=>journey+'ui-quality::'+s+'::02');
export const qualityChecks=[...qualityIds.map(testId=>({testId,contextId:'tenant_owner-en-desktop'})),...['desktop','tablet','mobile'].flatMap(v=>qualityIds.slice(0,3).map(testId=>({testId,contextId:'agent-en-'+v})))];
export const caseChecks=[...['tenant_owner-en-desktop','agent-en-desktop','agent-en-tablet','agent-en-mobile'].map(contextId=>({testId:navigationId,contextId})),...qualityChecks,...['desktop','mobile'].map(v=>({testId:previewId,contextId:'agent-en-'+v}))];
const key=row=>row.testId+'|'+row.contextId;
export function allowCaseReadPost(request,origin){
 try{const url=new URL(request.url()),body=request.postDataJSON();return request.method()==='POST'&&url.origin===origin&&url.pathname==='/api/inbox'&&Object.keys(body).sort().join(',')==='input,operation'&&body.input!==null&&typeof body.input==='object'&&!Array.isArray(body.input)&&['CHECK','LIST','SHOW','ARTICLES','ARTICLE_CONTENT'].includes(body.operation);}catch{return false;}
}
export function exactRows(rows,checks){
 assert.equal(new Set(checks.map(key)).size,checks.length,'Duplicate declared check');
 assert.equal(new Set(rows.map(key)).size,rows.length,'Duplicate proof');
 assert.deepEqual(rows.map(key).sort(),checks.map(key).sort(),'Missing/foreign proof context');
 assert(rows.every(r=>['passed','failed','blocked','unknown'].includes(r.result)),'Invalid proof result');
 return rows.some(r=>r.result==='failed')?'failed':rows.some(r=>r.result==='unknown')?'unknown':rows.some(r=>r.result==='blocked')?'blocked':'passed';
}
export function admitCaseActor(s,{namespace,inputs}){
 const g=inputs.remainingQuality.caseLifecycle.group,actor=s.capabilities.secondActor;
 assert.equal(g.namespace,namespace);assert.equal(g.tenantId,s.tenantId);
 assert.equal(actor.userId,inputs.secondActor.userId);assert.equal(actor.subject,inputs.secondActor.subject);assert.equal(inputs.secondActor.tenantId,s.tenantId);
 assert.equal(inputs.nativeAccountAccess.namespace,namespace);assert.equal(inputs.nativeAccountAccess.tenantId,s.tenantId);
 assert(inputs.nativeAccountAccess.results.some(r=>r.testId==='team-access/roles-invitations-revocation-and-last-owner-protection::native-account-linking-requires-owner-review-and-current-membership::01'&&r.result==='passed'),'Current native admission receipt required');
 assert.equal(inputs.caseNavigation.namespace,namespace);assert.equal(inputs.caseNavigation.tenantId,s.tenantId);
 assert.equal(exactRows(inputs.caseNavigation.proofs,caseChecks.filter(c=>c.testId===navigationId)),'passed','Current navigation grants required');
 return{group:g,actor};
}
export function assertPreviewReadOnly(before,after){assert.deepEqual(after,before,'PREVIEW admitted native/provider effects');}
export function assertReplyEffects({before,after,delivery,execution,flowId,draft,expectedText,originalMessageId}){
 const deliveries=after.outbox.filter(d=>!before.outbox.some(b=>b.id===d.id));assert.equal(deliveries.length,1,'Duplicate/missing delivery');assert.equal(deliveries[0].id,delivery.id);
 const articles=after.native.articles.filter(a=>!before.native.articleIds.includes(a.id));assert.equal(articles.length,1,'Duplicate/missing native article');
 const executions=after.executions.filter(e=>!before.executions.some(b=>b.id===e.id));assert.equal(executions.length,1,'Duplicate/missing workflow execution');assert.equal(executions[0].id,execution.id);
 assert.equal(delivery.state,'SENT');assert.equal(Number(delivery.attempts),1);assert.equal(execution.id,delivery.ticket_event_execution_id);assert.equal(execution.state,'APPLIED');assert.equal(execution.mode,'CUSTOM');assert.equal(execution.flow_version_id,flowId);
 assert.equal(articles[0].id,String(delivery.zammad_article_id));assert.equal(articles[0].internal,false);assert.equal(articles[0].body,draft);assert.equal(delivery.message_body,expectedText);assert.equal(delivery.reply_to_message_id,originalMessageId);
 return articles[0];
}
export function restorationPlan({saved,current,installedRevision,flowId,replyAttempted,settled}){
 if(replyAttempted&&!settled)return null;
 assert.equal(Number(current.revision),installedRevision,'Concurrent binding revision');assert.equal(current.flow_version_id,flowId,'Concurrent binding target');
 const mode=saved?.mode??'INHERIT';assert(['CUSTOM','OFF','INHERIT'].includes(mode));
 return{mode,flowVersionId:saved?.flow_version_id??null,expectedRevision:installedRevision};
}
