import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ensurePortalOperator,assertPortalProjection,withPortalOperatorEvidence} from './simulation-portal-operator.mjs';
import {privateNativeRead} from './simulation-private-native-read.mjs';
import {openPortalSupportTeam,readPortalServiceAccess,revealPortalServiceTeam} from './simulation-portal-groups.mjs';
import {nativeLinkTestId} from './simulation-native-account-linking.mjs';

export const serviceIdentityTestId='team-access/roles-invitations-revocation-and-last-owner-protection::tenant-automation-is-distinct-from-human-administration-and-has-no-interactive-access::01';
const sha=value=>createHash('sha256').update(String(value)).digest('hex'),ref=value=>'sha256:'+sha(value);
const requiredNativeFlags=['separateHumanAndMachine','noHumanAdministration','noInteractiveCredentials','noInteractiveSession','interactiveDenied','sessionAuthenticationDenied','passwordLoginDenied','eligibilityReadOnly','configuredTokenOwnership','independentTokenValues','purposeSeparated','fullFixtureGrant'];
export function assertServiceIdentityReadback(native,{tenantId,instanceId,owner,agent,humans,nativeGroupId,imageIdentity}){
 assert(native&&native.mode==='FRESH'&&native.phase==='BOUND','Current FRESH machine initialization is required');
 for(const key of requiredNativeFlags)assert.equal(native[key],true,'Missing runtime boundary: '+key);
 for(const key of ['receiptRef','machineRef','snapshotRef'])assert.match(native[key],/^sha256:[a-f0-9]{64}$/u);
 assert.equal(native.groupRef,ref(nativeGroupId));assert.notEqual(native.machineRef,ref(owner.nativeUserId));assert.notEqual(native.machineRef,ref(agent.nativeUserId));assert.notEqual(owner.nativeUserId,agent.nativeUserId);
 for(const [key,actor]of [['owner',owner],['agent',agent]]){
  const row=humans.find(item=>item.user_id===actor.userId),observed=native[key];assert(row&&observed);
  assert.equal(row.tenant_id,tenantId);assert.equal(row.current_instance_id,instanceId);
  assert.equal(observed.portalRef,ref(actor.userId));assert.equal(observed.nativeRef,ref(actor.nativeUserId));assert.equal(observed.subjectRef,ref(actor.subject));assert.equal(observed.emailRef,ref(row.email));
  assert.equal(observed.role,actor.role);assert.equal(observed.state,'ACTIVE');assert.equal(Number(observed.revision),Number(row.revision));assert.match(observed.fingerprint,/^[a-f0-9]{64}$/u);
 }
 for(const key of ['candidate_commit_sha','candidate_tree_sha'])assert.match(native.installed?.[key],/^[a-f0-9]{40}$/u);assert.match(native.installed.native_package_sha256,/^[a-f0-9]{64}$/u);
 for(const key of ['candidate_commit_sha','candidate_tree_sha','native_package_sha256'])assert.equal(native.installed[key],imageIdentity[key],'Installed native source differs from admitted image: '+key);
 return native;
}
async function readNativeImageIdentity(s){
 const admitted=s.containers?.['zammad-railsserver'];assert.match(admitted?.Image??'',/^sha256:[a-f0-9]{64}$/u);
 const images=JSON.parse(await s.run('docker',['image','inspect',admitted.Image]));assert.equal(images.length,1);const image=images[0];assert.equal(image.Id,admitted.Image,'Admitted native image changed');
 const labels=image.Config?.Labels??{},identity={imageId:admitted.Image,candidate_commit_sha:labels['org.opencontainers.image.revision'],candidate_tree_sha:labels['io.wasalx.source.tree'],native_package_sha256:labels['com.wasalx.zammad.package.sha256']};
 for(const key of ['candidate_commit_sha','candidate_tree_sha'])assert.match(identity[key],/^[a-f0-9]{40}$/u);assert.match(identity.native_package_sha256,/^[a-f0-9]{64}$/u);return identity;
}
async function readHumanAdministration(s,owner,agent){
 const rows=await s.scoped(`SELECT p.*,m.id AS member_id,m.version AS member_version,z.id AS current_instance_id,
  (t.state='ACTIVE' AND z.state='WORKING' AND p.zammad_instance_id=z.id AND u.oidc_subject=p.oidc_subject AND u.email=p.email
   AND m.role=p.role AND m.state=p.member_state AND ts.native_membership_sync_enabled) AS source_current
  FROM native_membership_projections p JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings ts ON ts.tenant_id=p.tenant_id
  JOIN users u ON u.id=p.user_id JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
  JOIN zammad_instances z ON z.tenant_id=p.tenant_id
  WHERE p.tenant_id=$1 AND p.user_id=ANY($2::uuid[]) ORDER BY p.user_id`,[s.tenantId,[owner.userId,agent.userId]]);
 assert.equal(rows.length,2);let instanceId;
 for(const actor of [owner,agent]){const bound=assertPortalProjection(rows.filter(row=>row.user_id===actor.userId),{tenantId:s.tenantId,userId:actor.userId,subject:actor.subject,role:actor.role});assert.equal(bound.nativeUserId,actor.nativeUserId);if(instanceId)assert.equal(bound.instanceId,instanceId);instanceId=bound.instanceId;}
 return{rows,instanceId};
}
async function observeServicePanel(owner,{nativeGroupId}){
 await openPortalSupportTeam(owner,{nativeGroupId});
 const current=await readPortalServiceAccess(owner,{nativeGroupId});assert.equal(current.status.mode,'FRESH');assert.equal(current.team.enabled,true);
 const panel=await revealPortalServiceTeam(owner,{team:current.team,statusVersion:current.status.status_version});
 await panel.getByRole('heading',{name:'WasalX automation access',exact:true}).waitFor({state:'visible'});
 await panel.getByText('Review the access used by WasalX automations. Staff access is managed separately above.',{exact:true}).waitFor({state:'visible'});
 await panel.getByRole('status').filter({hasText:'WasalX access is ready'}).waitFor({state:'visible'});
 await panel.getByText('Automation access enabled for this team',{exact:true}).waitFor({state:'visible'});
 await owner.page.reload({waitUntil:'domcontentloaded'});
 // Team selection is deliberately local UI state; restore only this exact owned team after reload.
 await openPortalSupportTeam(owner,{nativeGroupId,navigate:false});await revealPortalServiceTeam(owner,{team:current.team,statusVersion:current.status.status_version});await panel.getByRole('status').filter({hasText:'WasalX access is ready'}).waitFor({state:'visible'});await panel.getByText('Automation access enabled for this team',{exact:true}).waitFor({state:'visible'});
 const reloaded=await readPortalServiceAccess(owner,{nativeGroupId});assert.equal(reloaded.status.status_version,current.status.status_version);assert.deepEqual(reloaded.team,current.team);
 return{rendered:true,reloaded:true,statusVersion:current.status.status_version,teamVersion:current.team.version};
}
// This stage reads the existing owner-reviewed fixture; it never enrolls, enables, grants or logs in a native human.
export async function serviceIdentityStage(s,{namespace,inputs},helpers={}){
 for(const key of ['nativeAccountAccess','portalTeamAccess','teamAccess']){assert.equal(inputs[key]?.namespace,namespace,'Current '+key+' namespace required');assert.equal(inputs[key].tenantId,s.tenantId,'Current '+key+' tenant required');}
 assert(inputs.nativeAccountAccess.results?.some(row=>row.testId===nativeLinkTestId&&row.result==='passed'),'Owner-approved projection receipt required');
 assert(inputs.teamAccess.results?.length);const access=inputs.portalTeamAccess,machineGrant=access.machineGrant;assert.equal(access.surface,'portal');assert(machineGrant?.surface==='portal'&&machineGrant.enabled===true);assert.equal(machineGrant.teamId,access.nativeGroupId);
 assert(machineGrant.unchanged===true||machineGrant.kind==='IDENTITY_GRANT'&&machineGrant.state==='APPLIED'&&machineGrant.terminal===true&&typeof machineGrant.requestId==='string','Exact machine grant receipt or current unchanged readback required');
 const ensure=helpers.ensurePortalOperator??ensurePortalOperator,owner=await ensure(s,{role:'tenant_owner',locale:'en',viewport:{width:1440,height:1000}}),agent=await ensure(s,{role:'agent'});
 for(const actor of [owner,agent])assert(access.grants?.some(grant=>grant.surface==='portal'&&grant.teamId===access.nativeGroupId&&grant.memberId===actor.userId),'Exact current human team grant required');
 assert.equal(access.owner?.nativeUserId,owner.nativeUserId);assert.equal(access.agent?.nativeUserId,agent.nativeUserId);
 return withPortalOperatorEvidence(owner,async()=>{
  const startedAt=new Date().toISOString(),before=await readHumanAdministration(s,owner,agent),environment=s.model.services?.['zammad-runtime-bootstrap']?.environment;
  assert(environment?.WASALX_SERVICE_IDENTITY_MODE==='fresh','Fresh source-bound initializer required');assert.equal(environment.WASALX_TENANT_ID,s.tenantId);assert.equal(environment.WASALX_ZAMMAD_INSTANCE_ID,before.instanceId);
  const runtime=environment.ZAMMAD_SERVICE_TOKEN,privacy=environment.ZAMMAD_PRIVACY_TOKEN;assert(typeof runtime==='string'&&runtime.length>=16&&typeof privacy==='string'&&privacy.length>=16&&runtime!==privacy,'Independent configured service credentials required');
  const input={ownerId:owner.nativeUserId,agentId:agent.nativeUserId,groupId:access.nativeGroupId,runtimeSha256:sha(runtime),privacySha256:sha(privacy)},read=helpers.privateNativeRead??privateNativeRead;
  const imageIdentity=await readNativeImageIdentity(s),expected={tenantId:s.tenantId,instanceId:before.instanceId,owner,agent,humans:before.rows,nativeGroupId:access.nativeGroupId,imageIdentity};
  const nativeBefore=assertServiceIdentityReadback(await read(s,'service-identity',input),expected);
  const panel=await(helpers.observeServicePanel??observeServicePanel)(owner,{nativeGroupId:access.nativeGroupId});assert(panel.rendered===true&&panel.reloaded===true);
  const nativeAfter=assertServiceIdentityReadback(await read(s,'service-identity',input),expected);assert.deepEqual(nativeAfter,nativeBefore,'Read-only inspection changed native identity, credentials or sessions');
  assert.deepEqual(await readHumanAdministration(s,owner,agent),before,'Automation inspection changed human administration');await agent.verify();
  const finishedAt=new Date().toISOString();return{namespace,tenantId:s.tenantId,surface:'portal',results:[{testId:serviceIdentityTestId,contextId:'tenant_owner-en-desktop',result:'passed',startedAt,finishedAt,proof:{surface:'portal',servicePanel:panel,nativeImage:imageIdentity,nativeRuntime:nativeAfter,humanAdministrationUnchanged:true,negativeBoundary:'native-password-session-and-interactive-eligibility',noNativeBrowserLogin:true}}]};
 },{testIds:[serviceIdentityTestId]});
}
