import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {legacyMigrationFixtureCapability} from '../scripts/release/meta-runtime-descriptor.mjs';

const scope={tenantId:'11111111-1111-4111-8111-111111111111',accountId:'22222222-2222-4222-8222-222222222222',graphVersion:'v24.0'};
const tuple={schemaVersion:1,claim:'SYNTHETIC_LEGACY_SAME_PHONE',
 sourceProviderAccountId:'10001',targetProviderAccountId:'10002',phoneId:'20001',appId:'30001',graphVersion:'v24.0'};
const simulator=value=>({Config:{Env:[`META_SIM_LEGACY_MIGRATION_FIXTURE=${JSON.stringify(value)}`]}});
test('legacy capability is absent by default and cannot be enabled by mode or unrelated environment flags',()=>{
 assert.equal(legacyMigrationFixtureCapability({Config:{Env:[]}},scope),undefined);
 assert.equal(legacyMigrationFixtureCapability({Config:{Env:['META_SIM_LEGACY_MIGRATION_FIXTURE=','MODE=SIMULATED','ALLOW_LEGACY=true']}},scope),undefined);
});
test('the exact source/destination/phone tuple comes from original running simulator bytes',()=>{
 const actual=legacyMigrationFixtureCapability(simulator(tuple),scope);
 assert.deepEqual(actual,{...tuple,tenantId:scope.tenantId,targetAccountId:scope.accountId,fixtureSha256:createHash('sha256').update(JSON.stringify(tuple)).digest('hex')});
 for(const changed of [{tenantId:'bad'},{accountId:'bad'},{graphVersion:'v25.0'}])
  assert.throws(()=>legacyMigrationFixtureCapability(simulator(tuple),{...scope,...changed}));
});
test('ambiguous, extra, non-synthetic, changed model and malformed asset configurations fail closed',()=>{
 for(const delta of [{claim:'LIVE_LEGACY_ELIGIBLE'},{phoneId:20001},{appId:''},{sourceAccountId:scope.accountId},
   {sourceProviderAccountId:tuple.targetProviderAccountId},{graphVersion:'v25.0'},{enabled:true}])
  assert.throws(()=>legacyMigrationFixtureCapability(simulator({...tuple,...delta}),scope));
 const duplicate=simulator(tuple);duplicate.Config.Env.push(duplicate.Config.Env[0]);
 assert.throws(()=>legacyMigrationFixtureCapability(duplicate,scope));
 assert.throws(()=>legacyMigrationFixtureCapability({Config:{Env:['META_SIM_LEGACY_MIGRATION_FIXTURE=broken']}},scope));
});
