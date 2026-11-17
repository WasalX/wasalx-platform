import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';



const admission={evidenceMode:'simulated',freshRealm:true,otpPolicyAlgorithm:'HmacSHA256',otpPolicyDigits:6,otpPolicyPeriod:30,expectedUsername:'example.owner'};
function config(events,persist=async()=>events.push('persist')){const page={currentUrl:'http://127.0.0.1:4001/realms/wasalx/login-actions/required-action?client_id=wasalx-portal',url:()=>page.currentUrl,locator:()=>({isVisible:async()=>false,waitFor:async()=>{},innerText:async()=> 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',fill:async()=>events.push('fill'),click:async()=>events.push('submit')}),getByRole:()=>({waitFor:async()=>{},click:async()=>events.push('click')}),waitForFunction:async()=>{events.push('return-ready');page.currentUrl='http://127.0.0.1:4002/app'},waitForURL:async()=>events.push('return')};return {restoreFactor:async()=>null,page,role:'wasalx-owner',keycloakOrigin:'http://127.0.0.1:4001',portalOrigin:'http://127.0.0.1:4002',assertIsolatedRuntime:async()=>admission,persistFactor:persist,waitForFreshCode:async()=>events.push('fresh-code'),verifyFreshSession:async({readOtp})=>{assert.match(await readOtp('wasalx-owner'),/^\d{6}$/);events.push('verify');return {authenticated:true,identityMatched:true,mfaUsed:true};}};}

test('platform browser session binds only the exact stored platform subject without exposing it',async()=>{
 const {assertPlatformStoredSession}=await import('../scripts/release/simulation-platform-auth.mjs'),subject='11111111-1111-4111-8111-111111111111';
 const identity=assertPlatformStoredSession(JSON.stringify({subject,accessToken:'PRIVATE_TOKEN'}),subject);
 assert.deepEqual({...identity,actorRef:undefined},{actorRef:undefined,tenantRef:null,role:'platform_operator',realm:'wasalx-platform',audience:'wasalx-platform-api',matched:true});
 assert.match(identity.actorRef,/^sha256:[a-f0-9]{64}$/u);assert(!JSON.stringify(identity).includes(subject)&&!JSON.stringify(identity).includes('PRIVATE_TOKEN'));
 assert.throws(()=>assertPlatformStoredSession(JSON.stringify({subject:'22222222-2222-4222-8222-222222222222'}),subject),/subject mismatch/);
 assert.throws(()=>assertPlatformStoredSession('not-json',subject),/Stored platform session invalid/);
 assert.throws(()=>assertPlatformStoredSession(JSON.stringify({}),subject),/subject mismatch/);
});
