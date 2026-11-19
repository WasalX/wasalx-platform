import test from 'node:test';
import assert from 'node:assert/strict';


test('platform browser session binds only the exact stored platform subject without exposing it',async()=>{
 const {assertPlatformStoredSession}=await import('../scripts/release/simulation-platform-auth.mjs'),subject='11111111-1111-4111-8111-111111111111';
 const identity=assertPlatformStoredSession(JSON.stringify({subject,accessToken:'PRIVATE_TOKEN'}),subject);
 assert.deepEqual({...identity,actorRef:undefined},{actorRef:undefined,tenantRef:null,role:'platform_operator',realm:'wasalx-platform',audience:'wasalx-platform-api',matched:true});
 assert.match(identity.actorRef,/^sha256:[a-f0-9]{64}$/u);assert(!JSON.stringify(identity).includes(subject)&&!JSON.stringify(identity).includes('PRIVATE_TOKEN'));
 assert.throws(()=>assertPlatformStoredSession(JSON.stringify({subject:'22222222-2222-4222-8222-222222222222'}),subject),/subject mismatch/);
 assert.throws(()=>assertPlatformStoredSession('not-json',subject),/Stored platform session invalid/);
 assert.throws(()=>assertPlatformStoredSession(JSON.stringify({}),subject),/subject mismatch/);
});
