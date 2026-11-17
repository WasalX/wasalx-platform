import assert from "node:assert/strict";
import test from "node:test";
import { parseMetaTestPhonePolicy, setMetaTestPhoneTransaction } from "../packages/core/dist/meta-test-phone-policy.js";
import { parseMetaDirectRecipientSnapshot } from "../packages/core/dist/meta-direct-identity.js";

const uuid = n => `12000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const sender = {tenantId:uuid(1),connectionId:uuid(2),providerSessionId:uuid(3),appId:"123",wabaId:"456",phoneNumberId:"789"};
const environment = extra => ({NODE_ENV:"test",META_APP_ID:"123",WASALX_TEST_RECIPIENT_ALLOWLIST:JSON.stringify(["12025550106"]),
  WASALX_META_TEST_PHONE_SENDERS:JSON.stringify([sender]),...extra});

test("TEST PHONE policy is absent by default and cannot enable production or unspecified environments",()=>{
  assert.equal(parseMetaTestPhonePolicy({}),undefined);
  for(const NODE_ENV of ["production","",undefined]) assert.equal(parseMetaTestPhonePolicy(environment({NODE_ENV})),undefined);
  assert.equal(parseMetaTestPhonePolicy(environment({WASALX_META_TEST_PHONE_SENDERS:"[]"})),undefined);
});

test("TEST PHONE policy validates exact sender tuples and retains the existing recipient fence",()=>{
  const policy=parseMetaTestPhonePolicy(environment());
  assert.deepEqual(policy,{environment:"test",senders:[sender],recipients:["12025550106"]});
  assert.deepEqual(parseMetaTestPhonePolicy(environment({META_APP_ID:"999"})).senders,[]);
  for(const raw of ["not-json","{}",JSON.stringify([{...sender,connectionId:"invalid"}]),JSON.stringify([{...sender,extra:true}]),JSON.stringify([{...sender,appId:123}])])
    assert.throws(()=>parseMetaTestPhonePolicy(environment({WASALX_META_TEST_PHONE_SENDERS:raw})),/invalid/);
  for(const scope of [undefined,"","[]","*",'["123456@g.us"]'])
    assert.throws(()=>parseMetaTestPhonePolicy(environment({WASALX_TEST_RECIPIENT_ALLOWLIST:scope})),/test-recipient fence/);
  assert.throws(()=>parseMetaTestPhonePolicy(environment({WASALX_TEST_RECIPIENT_ALLOWLIST:"not-json"})),/JSON array/);
});

test("policy and tenant context share one transaction-local query; disabled and foreign tenants clear inherited defaults",async()=>{
  const queries=[],client={query:async(sql,args)=>{queries.push({sql,args});return {rows:[]}}};
  const policy=parseMetaTestPhonePolicy(environment());
  await setMetaTestPhoneTransaction(client,sender.tenantId,policy);
  assert.match(queries[0].sql,/set_config\('app\.tenant_id',\$1,true\),set_config\('app\.meta_test_phone_policy',\$2,true\)/);
  assert.equal(queries[0].args[0],sender.tenantId);assert.deepEqual(JSON.parse(queries[0].args[1]),policy);
  await setMetaTestPhoneTransaction(client,uuid(99),policy);
  await setMetaTestPhoneTransaction(client,sender.tenantId);
  assert.deepEqual(queries.slice(1).map(q=>q.args[1]),["",""]);
});

test("only an ALIAS_VERIFIED PHONE snapshot may carry the immutable TEST marker",()=>{
  const snapshot={schemaVersion:1,claim:"ALIAS_VERIFIED",recipient:{kind:"PHONE",value:"12025550106"},
    asset:{providerSessionId:sender.providerSessionId,phoneNumberId:sender.phoneNumberId,wabaId:sender.wabaId},
    participantId:uuid(4),aliasId:uuid(5),aliasRevision:1,testPhoneSender:true};
  assert.deepEqual(parseMetaDirectRecipientSnapshot(snapshot),snapshot);
  for(const changed of [{...snapshot,testPhoneSender:false},{...snapshot,recipient:{kind:"BSUID",value:"US.synthetic"}},
    {schemaVersion:1,claim:"LEGACY_PHONE_CONTEXT",recipient:snapshot.recipient,asset:snapshot.asset,testPhoneSender:true}])
    assert.throws(()=>parseMetaDirectRecipientSnapshot(changed));
});
