import test from 'node:test';
import assert from 'node:assert/strict';
import {runSessionRotationPacket,safeNavigationDiagnostics} from '../scripts/release/simulation-session-rotation-packet.mjs';
import {withAuthenticatedSimulationOwnerPage} from "../scripts/release/simulation-session-rotation.mjs";
import {authenticateSimulationFactor} from '../scripts/release/simulation-stack-session.mjs';
test('rotation packet binds Redis deletion and closes only its stale context',async()=>{
  const origin='http://127.0.0.1:3000',keycloakOrigin='http://127.0.0.1:8080';
  let cookie='old',url=origin+'/app',closed=0;const sessions=new Set(['old']),checkpoints=[];
  const page={setViewportSize:async()=>{},evaluate:async()=>[{id:'tenant',current:true,role:'tenant_owner'}],
    context:()=>({cookies:async()=>[{name:'wasalx_session',value:cookie,httpOnly:true,sameSite:'Lax'}]}),
    goto:async()=>{url=keycloakOrigin+'/login';},url:()=>url,reload:async()=>{}};
  const stale={addCookies:async()=>{},request:{get:async()=>({status:()=>sessions.has('old')?200:401})},close:async()=>{closed++;},
    newPage:async()=>({goto:async()=>{},url:()=>keycloakOrigin+'/login',getByRole:()=>({waitFor:async()=>{}}),viewportSize:()=>({width:1440,height:1000}),evaluate:async()=> 'en'})};
  const result=await runSessionRotationPacket({browser:{newContext:async()=>stale},page,origin,keycloakOrigin,runId:'selfcheck',
    actorId:'owner',tenantId:'tenant',role:'tenant_owner',assertIsolatedRuntime:async()=>{},assertActor:async()=>{},
    readMembership:async()=>({user_id:'owner',role:'tenant_owner',state:'ACTIVE'}),sessionExists:async id=>sessions.has(id),
    authenticatePending:async()=>{sessions.delete('old');sessions.add('new');cookie='new';url=origin+'/app';},checkpoint:async row=>checkpoints.push(row)});
  assert.equal(result.cookieRotated,true);assert.equal(result.oldSessionDeleted,true);assert.equal(result.staleAfterHttp,401);assert.deepEqual(result.staleAnonymousBinding,{role:'anonymous',locale:'en',actorRef:null,tenantRef:null,viewport:{width:1440,height:1000},authenticationDenied:true});
  assert.equal(closed,1);assert(sessions.has('new'));
  assert.deepEqual(checkpoints.slice(0,5).map(({phase,scenario,step})=>({phase,scenario,step})),[
    {phase:'diagnostic',scenario:'session-rotation',step:'started'},
    {phase:'diagnostic',scenario:'session-rotation',step:'runtime-verified'},
    {phase:'diagnostic',scenario:'session-rotation',step:'identity-verified'},
    {phase:'diagnostic',scenario:'session-rotation',step:'current-session-verified'},
    {phase:'diagnostic',scenario:'session-rotation',step:'stale-session-verified'},
  ]);
  assert(checkpoints.slice(0,5).every(row=>Object.keys(row).every(key=>['phase','scenario','step'].includes(key))));
});

test('rotation packet uses the dedicated platform cookie, probe and stale sign-in assertion',async()=>{
 const origin='http://127.0.0.1:3000',keycloakOrigin='http://127.0.0.1:8080';let cookie='old',url=origin+'/platform',staleAsserted=false;const sessions=new Set(['old']);
 const page={setViewportSize:async()=>{},context:()=>({cookies:async()=>[{name:'wasalx_platform_session',value:cookie,httpOnly:true,sameSite:'Lax'}]}),goto:async()=>{url=keycloakOrigin+'/realms/wasalx-platform/login?client_id=wasalx-platform-portal';},url:()=>url,reload:async()=>{}};
 const stale={addCookies:async()=>{},request:{get:async()=>({status:()=>sessions.has('old')?200:401})},close:async()=>{},newPage:async()=>({goto:async()=>{},url:()=>keycloakOrigin+'/realms/wasalx-platform/login?client_id=wasalx-platform-portal',viewportSize:()=>({width:1440,height:1000}),evaluate:async()=> 'en'})};
 const identity=async()=>({actorRef:'sha256:'+'a'.repeat(64),tenantRef:null,role:'platform_operator',realm:'wasalx-platform',audience:'wasalx-platform-api',matched:true});
 const result=await runSessionRotationPacket({browser:{newContext:async()=>stale},page,origin,keycloakOrigin,runId:'platform-check',role:'platform_operator',assertIsolatedRuntime:async()=>{},identity,cookieName:'wasalx_platform_session',authorizedPath:'/api/platform-console/waha-workers',reauthenticationPath:origin+'/platform/auth/login?return_to=/platform',terminalPath:'/platform',sessionExists:async id=>sessions.has(id),authenticatePending:async()=>{sessions.delete('old');sessions.add('new');cookie='new';url=origin+'/platform';},assertStaleUi:async()=>{staleAsserted=true;},checkpoint:async()=>{}});
 assert.equal(result.before.realm,'wasalx-platform');assert.equal(result.after.tenantRef,null);assert.equal(result.oldSessionDeleted,true);assert.equal(staleAsserted,true);
});

test('stale platform navigation diagnostics retain only status origin and pathname',async()=>{
 const firstResponse={status:()=>307},finalResponse={status:()=>307};
 const first={url:()=> 'http://127.0.0.1:3000/platform?token=private',redirectedFrom:()=>null,response:async()=>firstResponse};
 const final={url:()=> 'http://127.0.0.1:3000/platform/auth/login?return_to=/platform&token=private',redirectedFrom:()=>first,response:async()=>finalResponse};
 const observation=await safeNavigationDiagnostics({request:()=>final,status:()=>307},{url:()=> 'http://127.0.0.1:8080/realms/wasalx-platform/protocol/openid-connect/auth?client_id=wasalx-platform-portal&token=private'});
 assert.deepEqual(observation,{redirects:[{status:307,origin:'http://127.0.0.1:3000',pathname:'/platform'},{status:307,origin:'http://127.0.0.1:3000',pathname:'/platform/auth/login'}],final:{status:307,origin:'http://127.0.0.1:8080',pathname:'/realms/wasalx-platform/protocol/openid-connect/auth'}});
 assert(!JSON.stringify(observation).includes('token'));
});


test('dedicated rotation uses its owned page and preserves canonical owner page',async()=>{
 const canonical={url:()=> 'http://127.0.0.1:3000/app'},keycloak='http://127.0.0.1:8080';let closed=0,used;
 const owned={current:keycloak+'/realms/wasalx/login?client_id=wasalx-portal',url(){return this.current;},goto:async()=>{}};
 const result=await withAuthenticatedSimulationOwnerPage({browser:{newContext:async()=>({newPage:async()=>owned,close:async()=>{closed++;}})},portalOrigin:'http://127.0.0.1:3000',keycloakOrigin:keycloak,tenantId:'tenant',authenticateOwnerPending:async page=>{assert.equal(page,owned);page.current='http://127.0.0.1:3000/app';},verifyOwner:async page=>assert.equal(page,owned)},async page=>{used=page;return 'complete';});
 assert.equal(result,'complete');assert.equal(used,owned);assert.equal(canonical.url(),'http://127.0.0.1:3000/app');assert.equal(closed,1);
});

test('dedicated rotation preserves primary failure when context close also rejects',async()=>{
 const keycloak='http://127.0.0.1:8080',primary=Error('fixed-safe-auth-failure'),cleanup=Error('private-close-failure'),owned={url:()=>keycloak+'/realms/wasalx/login?client_id=wasalx-portal',goto:async()=>{}};
 await assert.rejects(withAuthenticatedSimulationOwnerPage({browser:{newContext:async()=>({newPage:async()=>owned,close:async()=>{throw cleanup;}})},portalOrigin:'http://127.0.0.1:3000',keycloakOrigin:keycloak,tenantId:'tenant',authenticateOwnerPending:async()=>{throw primary;},verifyOwner:async()=>{}},async()=>{}),error=>error===primary);
});

function factorPage({stage='password',usernameVisible=false,rejected=false}={}){
 const keycloak='http://127.0.0.1:8080',portal='http://127.0.0.1:3000';let url=keycloak+'/realms/wasalx/protocol/openid-connect/auth?client_id=wasalx-portal&prompt=login&max_age=0&acr_values=privileged',filled=[];
 const visible=selector=>selector==='input[name=otp]'?stage==='otp':selector==='input[name=password][type=password]'?stage==='password':selector==='input[name=username]'?usernameVisible:selector==='[role="alert"], #input-error'?rejected:false;
 const page={url:()=>url,locator:selector=>({isVisible:async()=>visible(selector),fill:async()=>filled.push(selector),first(){return this;}}),getByRole:()=>({click:async()=>{if(!rejected)url=portal+'/app';}}),waitForFunction:async()=>{}};
 return{page,filled,keycloak,portal};
}

test('simulation authentication supports password-only and OTP-only privileged steps',async()=>{
 const password=factorPage();await authenticateSimulationFactor(password.page,async()=>{throw Error('OTP unexpected');},{username:'example.owner',password:'synthetic-test-only-password',portalOrigin:password.portal,keycloakOrigin:password.keycloak});assert.deepEqual(password.filled,['input[name=password][type=password]']);
 const otp=factorPage({stage:'otp'});let reads=0;await authenticateSimulationFactor(otp.page,async()=>{reads++;return '123456';},{username:'example.owner',password:'synthetic-test-only-password',portalOrigin:otp.portal,keycloakOrigin:otp.keycloak});assert.equal(reads,1);assert.deepEqual(otp.filled,['input[name=otp]']);
});

test('simulation authentication surfaces fixed rejection without transition timeout',async()=>{
 const rejected=factorPage({rejected:true});await assert.rejects(authenticateSimulationFactor(rejected.page,async()=>'',{username:'example.owner',password:'synthetic-test-only-password',portalOrigin:rejected.portal,keycloakOrigin:rejected.keycloak}),error=>error.message==='Authentication credential rejected');
});
