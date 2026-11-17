import assert from 'node:assert/strict';
import test from 'node:test';
import {teamRoleObserverPlan,mergeTeamObserverRows,assertFreshTeamObserverChecks} from '../scripts/release/simulation-team-observation-selection.mjs';
import {runRolePermissionWave,rebindSimulationRole,simulationRoleReady} from '../scripts/release/simulation-team-role-wave.mjs';
import {downstreamStageChecks} from '../scripts/release/simulation-manifest.mjs';
const connection='connections/disconnect-reconnect-and-secret-retirement::ui-quality::console';
const navigation='tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::console';
const session='identity-access/sign-in-session-rotation::ui-quality::console';
const row=(testId,contextId)=>({testId,contextId});

test('supporting role producer inherits exact downstream checks through the existing DAG',()=>{
 const stage={id:'team-roles',produces:'teamAccess',supporting:true,checks:[]};
 const manifest={scenarios:[stage,{id:'navigation',requires:['teamAccess'],produces:'navigationQuality',checks:[row(navigation,'auditor-en-tablet')]},{id:'session',requires:['navigationQuality'],checks:[row(session,'auditor-en-tablet')]},{id:'connection',requires:['teamAccess'],checks:[row(connection,'auditor-en-desktop')]},{id:'unrelated',requires:['other'],checks:[row(connection,'supervisor-en-desktop')]}]};
 const checks=downstreamStageChecks(manifest,stage);assert.equal(checks.length,3);
 const plan=teamRoleObserverPlan(checks);assert.deepEqual(plan.roles,['auditor']);assert.equal(plan.contexts.size,2);assert(plan.wants('auditor','tablet','navigation'));assert(plan.wants('auditor','desktop','connection'));assert(!plan.wants('auditor','tablet','connection'));assert(!plan.wants('supervisor','desktop','connection'));assert(!plan.fullRoleProof);
});

test('shared navigation/session checks require one exact shell observer and owner-only work needs no role mutation',()=>{
 const plan=teamRoleObserverPlan([row(navigation,'auditor-en-tablet'),row(session,'auditor-en-tablet')]);assert.equal(plan.contexts.size,1);assert.deepEqual([...plan.contexts.get('auditor-en-tablet').families],['navigation']);
 const owner=teamRoleObserverPlan([row('group-rules/create-test-activate-rollback::rule-version-test-activation-and-rollback-render::02','tenant_owner-en-tablet')]);assert.deepEqual(owner.roles,[]);assert(owner.wants('tenant_owner','tablet','groupRulePermissions'));assert(!owner.wants('tenant_owner','desktop','groupRulePermissions'));
});

test('real selected role lifecycle retains its complete original three-role wave',()=>{
 const plan=teamRoleObserverPlan([row('team-access/roles-invitations-revocation-and-last-owner-protection::role-lifecycle-and-last-owner-protection-render::01','agent-en-desktop')]);assert(plan.fullRoleProof);assert.deepEqual(plan.roles,['tenant_admin','supervisor','auditor']);
 const zoom=teamRoleObserverPlan([row('tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::chrome-200-zoom','auditor-en-tablet')]);assert.equal(zoom.required.length,0);assert.equal(zoom.unsupported.length,1);assert.deepEqual(zoom.roles,[]);
});

test('fresh merge preserves unrelated proof references, timestamps and actual failed outcomes',()=>{
 const old=[{...row(connection,'auditor-en-desktop'),startedAt:'2026-10-01T11:00:00Z',proof:{old:true},result:'failed'},{...row(connection,'supervisor-en-desktop'),startedAt:'2026-10-01T11:00:01Z',proof:{old:true},result:'passed'}],fresh={...old[0],startedAt:'2026-10-01T16:00:00Z',proof:{actual:true},result:'failed'};
 const merged=mergeTeamObserverRows(old,[fresh]);assert.equal(merged[0],fresh);assert.equal(merged[1],old[1]);assert.equal(merged[0].result,'failed');assert.throws(()=>mergeTeamObserverRows(old,[fresh,fresh]),/Duplicate fresh/);assert.throws(()=>mergeTeamObserverRows(old,[row(connection,'agent-en-desktop')]),/outside retained/);
 const suffix={suffix:'console',contextId:'auditor-en-tablet',proof:{old:true}},replacement={...suffix,proof:{new:true}};assert.equal(mergeTeamObserverRows([suffix],[replacement],{suffix:true})[0],replacement);
});

test('a requested check cannot fall back to historical evidence when its fresh observer is absent',()=>{
 const plan=teamRoleObserverPlan([row(session,'auditor-en-tablet')]),fresh={results:[],connectionQualityContextResults:[],navigationQualityContextResults:[],navigationZoomContextResults:[],groupRulePermissionContextResults:[],sessionQualityContextObservations:[]};
 assert.throws(()=>assertFreshTeamObserverChecks(plan,fresh),/Missing fresh/);fresh.sessionQualityContextObservations.push({suffix:'console',contextId:'auditor-en-tablet',result:'failed'});assertFreshTeamObserverChecks(plan,fresh);
});

test('owner quality belongs its existing downstream producer, not the supporting role wave',()=>{
 const plan=teamRoleObserverPlan([row(connection,'tenant_owner-en-desktop'),row(navigation,'tenant_owner-en-tablet'),row(session,'tenant_owner-en-desktop')]);assert.deepEqual(plan.roles,[]);assert.equal(plan.contexts.size,0);assert.equal(plan.required.length,0);
});

test('agent-only refresh is explicit and still verifies actor, restoration and zero-mutation audit',async()=>{
 await assert.rejects(()=>runRolePermissionWave({roles:[]}),/Unsupported bounded role wave/);
 const owner={id:'owner-member',user_id:'owner',role:'tenant_owner',state:'ACTIVE',version:1,whatsapp_numbers:[]},member={id:'member',user_id:'actor',role:'agent',state:'ACTIVE',version:1,whatsapp_numbers:[]},calls=[];
 const ownerPage={context:()=>owner,evaluate:async(fn,args)=>{assert.equal(args.path,'/api/team');return{members:[{...owner,is_current_user:true}]}}},memberPage={context:()=>member,reload:async()=>calls.push('reload'),viewportSize:()=>({width:1440,height:1000})};
 const result=await runRolePermissionWave({ownerPage,memberPage,origin:'http://portal',runId:'unit-only',tenantId:'tenant',memberId:'member',roles:[],allowAgentOnly:true,checkpoint:async()=>{},assertIsolatedRuntime:async()=>{},assertActor:async(page,{role})=>{calls.push(role);return{userId:page===ownerPage?'owner':'actor',role,actorRef:page===ownerPage?'owner-ref':'actor-ref',tenantRef:'tenant-ref',actorVerified:true,locale:'en'}},readMember:async()=>member,rebindRole:async(page,role)=>calls.push('rebind-'+role),observeRole:async({role})=>{calls.push('observe-'+role);return{requested:true}},additional:async({role})=>({role,unchanged:true}),readAudit:async({mutations})=>{assert.deepEqual(mutations,[]);return{matched:true,count:0}}});
 assert.deepEqual(result.proofs,[]);assert.deepEqual(result.mutations,[]);assert(result.restored&&result.audit.matched);assert(calls.includes('rebind-agent')&&calls.includes('observe-agent'));assert(!calls.includes('tenant_admin'));
});

test('shared role rebind waits for visible supported form and restores exact portal route',async()=>{
 const portal='http://portal.invalid',keycloak='http://identity.invalid',password='input[name=password][type=password]',otp='input[name=otp]',username='input[name=username]';
 const field=shown=>({getClientRects:()=>shown?[{}]:[]}),env=(origin,pathname,fields)=>({location:{origin,pathname},document:{querySelectorAll:selector=>fields[selector]??[]}}),args={portal,keycloak};
 assert(simulationRoleReady(args,env(keycloak,'/realms/wasalx/auth',{[password]:[field(true)]})));
 assert(simulationRoleReady(args,env(keycloak,'/realms/wasalx/auth',{[username]:[field(false)],[password]:[field(true)]})));
 assert(simulationRoleReady(args,env(keycloak,'/realms/wasalx/auth',{[otp]:[field(true)]})));
 assert.equal(simulationRoleReady(args,env(keycloak,'/realms/wasalx/auth',{[username]:[field(false)]})),false);
 assert.equal(simulationRoleReady(args,env(keycloak,'/realms/wasalx/auth',{})),false);
 assert.equal(simulationRoleReady(args,env('http://other.invalid','/app',{[password]:[field(true)]})),false);
 assert(simulationRoleReady(args,env(portal,'/app',{})));assert.equal(simulationRoleReady(args,env(portal,'/auth/error',{})),false);
 let current=keycloak+'/realms/wasalx/auth',logins=0;const page={url:()=>current,async goto(url,options){assert.equal(url,portal+'/auth/login?return_to=/app&tenant_id=tenant');assert.equal(options.waitUntil,'domcontentloaded');},async waitForFunction(fn,value,options){assert.equal(options.timeout,15000);assert(fn(value,env(keycloak,'/realms/wasalx/auth',{[password]:[field(true)]})));}};
 await rebindSimulationRole({portalOrigin:portal,keycloakOrigin:keycloak,tenantId:'tenant'},{async login(target,role){assert.equal(target,page);assert.equal(role,'agent');logins++;current=portal+'/app';}},page,'agent');assert.equal(logins,1);
 current=portal+'/app';page.waitForFunction=async(fn,value,options)=>{assert.equal(options.timeout,15000);assert(fn(value,env(portal,'/app',{})));};
 await rebindSimulationRole({portalOrigin:portal,keycloakOrigin:keycloak,tenantId:'tenant'},{async login(){assert.fail('No login on exact portal terminal');}},page,'agent');
});

test('selected mobile role contexts are observed only for families with a real mobile observer',()=>{const nav=navigation,width='tenant-navigation/responsive-collapse-pin-and-workspace-switch::navigation-collapses-and-expands-at-each-viewport::03',plan=teamRoleObserverPlan([row(nav,'supervisor-en-mobile'),row(width,'supervisor-en-mobile'),row(nav,'agent-en-tablet')]);assert.deepEqual(plan.roles,['supervisor']);assert(plan.wants('supervisor','mobile','navigation'));assert(!plan.wants('supervisor','mobile','width'));assert(!plan.wants('supervisor','desktop','navigation'));assert.deepEqual(plan.unsupported.map(check=>check.testId),[width]);assert.deepEqual(plan.views('supervisor'),['mobile']);assert.deepEqual(plan.views('agent'),['tablet']);assert(!plan.fullRoleProof);});
test('no selected role context means no restricted role is changed',()=>{const plan=teamRoleObserverPlan([row(navigation,'tenant_owner-en-mobile'),row('other::id','auditor-en-desktop')]);assert.deepEqual(plan.roles,[]);assert.equal(plan.required.length,0);});
