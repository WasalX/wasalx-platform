import assert from 'node:assert/strict';
import {privateErrorSummary} from './simulation-manifest.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
export function simulationRoleReady({portal,keycloak},environment){
 const current=environment?.location??location,dom=environment?.document??document;
 if(current.origin===portal&&current.pathname==='/app')return true;
 if(current.origin!==keycloak)return false;
 const visible=selector=>[...dom.querySelectorAll(selector)].some(element=>element.getClientRects().length>0);
 return visible('input[name=password][type=password]')||visible('input[name=otp]');
}
export async function rebindSimulationRole(session,capability,page,role){
 const{portalOrigin,keycloakOrigin,tenantId}=session;
 await page.goto(portalOrigin+'/auth/login?return_to=/app&tenant_id='+encodeURIComponent(tenantId),{waitUntil:'domcontentloaded'});
 await page.waitForFunction(simulationRoleReady,{portal:portalOrigin,keycloak:keycloakOrigin},{timeout:15000});
 if(new URL(page.url()).origin===keycloakOrigin)await capability.login(page,role);
 assert.equal(new URL(page.url()).origin,portalOrigin);assert.equal(new URL(page.url()).pathname,'/app');
}
// Same retained person, sequential supported role changes; original agent restored.
export async function runRolePermissionWave({ownerPage,memberPage,origin,runId,tenantId,memberId,
  checkpoint,assertActor,assertIsolatedRuntime,readMember,readAudit,rebindRole,additional,observeRole=async()=>null,roles=['tenant_admin','supervisor','auditor'],allowAgentOnly=false}) {
  assert(Array.isArray(roles)&&(roles.length||allowAgentOnly===true)&&new Set(roles).size===roles.length&&roles.every(role=>['tenant_admin','supervisor','auditor'].includes(role)),'Unsupported bounded role wave');
  await assertIsolatedRuntime({evidenceMode:'simulated',origin});
  assert.equal(typeof rebindRole,'function','Role context requires supported fresh OIDC session');
  assert.notEqual(ownerPage.context(),memberPage.context());
  const owner=await assertActor(ownerPage,{role:'tenant_owner',tenantId});
  const actor=await assertActor(memberPage,{role:'agent',tenantId});
  const original=await readMember(memberId);assert.equal(original.user_id,actor.userId);assert.notEqual(actor.userId,owner.userId);
  assert.equal(original.role,'agent');assert.equal(original.state,'ACTIVE');
  const request=createSyntheticRequest({page:ownerPage,origin,runId,checkpoint});
  const self=(await request('/api/team')).members.find(x=>x.is_current_user);assert.equal(self.user_id,owner.userId);
  let last=original;const proofs=[],mutations=[];
  const project=r=>({user_id:r.user_id,role:r.role,state:r.state,version:Number(r.version),whatsapp_numbers:r.whatsapp_numbers});
  await checkpoint({phase:'initial-configuration',step:'role-permission-wave',member:original});
  const change=async(role,step)=>{
    assert.deepEqual(project(await readMember(memberId)),project(last));
    await request('/api/team/members/'+memberId,'PATCH',{role,state:'ACTIVE',expectedVersion:Number(last.version)},step);
    const next=await readMember(memberId);assert.deepEqual(project(next),{...project(last),role,version:Number(last.version)+1});
    last=next;mutations.push({role,version:Number(next.version),step});
  };
  try {
    for(const role of roles){
      await change(role,'role-'+role);
      await rebindRole(memberPage,role);
      await memberPage.reload({waitUntil:'domcontentloaded'});
      // Failure in role shell is recorded, not mistaken for proof of permission.
      const proof={role,startedAt:new Date().toISOString(),version:Number(last.version),viewport:memberPage.viewportSize(),actorRef:actor.actorRef,tenantRef:actor.tenantRef};
      let stage="actor";
      try {
        const rebound=await assertActor(memberPage,{role,tenantId});assert.equal(rebound.role??role,role);assert.equal(rebound.actorRef,actor.actorRef);assert.equal(rebound.tenantRef,actor.tenantRef);proof.actorVerified=rebound.actorVerified===true;proof.locale=rebound.locale;
        stage="role-observer";proof.observation=await observeRole({role,self:last,owner:self,page:memberPage});
        const memberRequest=createSyntheticRequest({page:memberPage,origin,runId:runId+'-'+role,checkpoint});
        stage="team-read";const team=await memberRequest('/api/team');assert(Array.isArray(team.members));
        stage="team-navigation";assert.equal(await memberPage.locator('a[href="/app?view=team"]').count(),1);
        // Every non-owner role must be unable to alter owner access.
        stage="owner-write-denial";await assert.rejects(()=>memberRequest('/api/team/members/'+self.id,'PATCH',{
          role:'tenant_admin',state:'ACTIVE',expectedVersion:Number(self.version)},'deny-owner-change'),/HTTP 403;/);
        assert.deepEqual(project(await readMember(self.id)),project(self));
        stage="own-access-denial";proof.additional=await additional({role,self:last,owner:self});proof.passed=true;proof.teamRead=200;proof.ownerMutation=403;proof.ownerUnchanged=true;
      } catch(error) {proof.passed=false;proof.category='role-permission-or-shell-assertion';proof.stage=stage;proof.failure=privateErrorSummary(error,new Map());}
      proof.finishedAt=new Date().toISOString();proofs.push(proof);await checkpoint({phase:'proof',step:'role-permission',...proof});
    }
  } finally {
    // Fail closed on drift; no unconditional restoration over someone else's work.
    if(last.role!=='agent')await change('agent','restore-agent');
    await rebindRole(memberPage,'agent');await memberPage.reload({waitUntil:'domcontentloaded'});await assertActor(memberPage,{role:'agent',tenantId});
    await checkpoint({phase:'restored',step:'role-permission-wave',role:'agent',version:Number(last.version)});
  }
  const agentIdentity=await assertActor(memberPage,{role:'agent',tenantId});assert.equal(agentIdentity.actorRef,actor.actorRef);assert.equal(agentIdentity.tenantRef,actor.tenantRef);const agentStartedAt=new Date().toISOString(),agentObservation=await observeRole({role:'agent',self:last,owner:self,page:memberPage}),agentAdditional={...await additional({role:'agent',self:last,owner:self}),observation:agentObservation,startedAt:agentStartedAt,finishedAt:new Date().toISOString(),viewport:memberPage.viewportSize(),locale:agentIdentity.locale,actorRef:agentIdentity.actorRef,tenantRef:agentIdentity.tenantRef,actorVerified:agentIdentity.actorVerified===true};
  const audit=await readAudit({memberId,mutations,ownerUserId:owner.userId});
  assert.equal(audit.matched,true);
  return {evidenceMode:'simulated',proofs,agentAdditional,mutations,audit,restored:true,
    limitations:['Role-specific team read and owner-access denials only; no exhaustive permissions claim.','One retained actor changes role sequentially; no native Zammad role/grant binding inferred.']};
}
