import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const navigationWidthId='tenant-navigation/responsive-collapse-pin-and-workspace-switch::navigation-collapses-and-expands-at-each-viewport::03';
const digest=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
export const navigationWidthRoles=['tenant_owner','tenant_admin','supervisor','agent','auditor'];
export const navigationLinks=role=>['Overview',...(role==='agent'?[]:['Cases']),'Connections'];
export function checkNavigationGeometry(g,width){assert.equal(g.width,width);assert(g.scroll<=g.width+1,'Horizontal document overflow');return g;}
export async function observeNavigationWidth({page,origin,role,verifyActor,checkpoint,tabletOnly=false,selectedViews}){
 if(selectedViews!==undefined)assert(Array.isArray(selectedViews)&&selectedViews.length&&new Set(selectedViews).size===selectedViews.length&&selectedViews.every(view=>['desktop','tablet'].includes(view)),'Unsupported selected width views');
 assert(navigationWidthRoles.includes(role));const old=page.viewportSize(),oldUrl=page.url(),results=[];let writes=0;
 const block=route=>{const r=route.request();if(new URL(r.url()).origin===origin&&!['GET','HEAD','OPTIONS'].includes(r.method())){writes++;return route.abort();}return route.fallback();};
 const admitted=await verifyActor();await page.route('**/api/**',block);
 try{for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'tablet',width:820,height:1180}].filter(v=>(!tabletOnly||v.name==='tablet')&&(selectedViews===undefined||selectedViews.includes(v.name)))){
 const startedAt=new Date().toISOString();let proof,result='passed';
 try{await page.setViewportSize({width:viewport.width,height:viewport.height});await page.goto(origin+'/app?view=overview');await page.locator('.app-shell:not([inert])').waitFor();const identity=await verifyActor();assert.equal(identity.role??role,role);assert.equal(identity.actorRef,admitted.actorRef);assert.equal(identity.tenantRef,admitted.tenantRef);
 const geometry=checkNavigationGeometry(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})),viewport.width);
 const visibleLinks=navigationLinks(role);for(const name of visibleLinks)await page.getByRole('link',{name,exact:true}).waitFor({state:'visible'});
 const cases=page.getByRole('link',{name:'Cases',exact:true});assert.equal(await cases.count(),role==='agent'?0:1,'Cases navigation must match case:read permission');
 const overview=page.getByRole('link',{name:'Overview',exact:true});await overview.focus();assert(await overview.evaluate(e=>document.activeElement===e));await overview.press('Enter');await page.getByRole('heading',{level:1,name:'Operational overview',exact:true}).waitFor();
 const locale=await page.evaluate(()=>document.documentElement.lang);assert(/^en(?:[-_]|$)/iu.test(locale));
 proof={...geometry,actualViewport:page.viewportSize(),role,locale,actorRef:identity.actorRef,tenantRef:identity.tenantRef,actorVerified:identity.actorVerified===true,visibleLinks,overviewKeyboardOperable:true};
 }catch(e){result='failed';proof={errorClass:e.name,message:e.message.slice(0,180)};}
 const row={testId:navigationWidthId,contextId:role+'-en-'+viewport.name,result,startedAt,finishedAt:new Date().toISOString(),...(result==='passed'?{actorRef:proof.actorRef,tenantRef:proof.tenantRef,actualViewport:proof.actualViewport,verifiedContext:{role,locale:'en',actorRef:proof.actorRef,tenantRef:proof.tenantRef,viewport:proof.actualViewport}}:{}),proof};results.push(row);await checkpoint({phase:'navigation-width-context',...row});
 }}finally{await page.unroute('**/api/**',block);await page.setViewportSize(old);await page.goto(oldUrl);await verifyActor();assert.equal(writes,0,'Read-only navigation attempted API mutation');}
 return results;
}
export async function agentNavigationWidthStage(s,{namespace,inputs}){assert.equal(inputs.secondActor.namespace,namespace);assert.equal(inputs.teamAccess.namespace,namespace);const actor=s.capabilities.secondActor;assert.equal(actor.memberId,inputs.secondActor.memberId);const verifyActor=async()=>{const binding=await s.verifyOwner(actor.page,actor.userId,'agent',s.tenantId);assert(binding.userMatched&&binding.workspaceMatched);return{...binding,role:'agent',actorRef:digest(actor.subject??actor.userId),tenantRef:digest(s.tenantId),actorVerified:true}};const results=await observeNavigationWidth({page:actor.page,origin:s.portalOrigin,role:'agent',verifyActor,checkpoint:s.checkpoint});assert.equal(results.length,2);assert(results.every(x=>x.result==='passed'),'Agent navigation width failed');return{evidenceMode:'simulated',namespace,results,readOnly:true};}
