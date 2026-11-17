import {parseMetaPolicySelection,parseMetaTariffQuery} from '../packages/core/dist/meta-billing-policy-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {metaPolicyBody} from '../services/control-api/dist/meta-account-policy.js';
import {metaAccountCurrencyObservation,metaAccountFundingProof,parseMetaMessageProviderContext,parseMetaMessageAdmissionV2} from '../packages/core/dist/meta-account-policy.js';
import {MetaGroupsAdapter} from '../services/connector-worker/dist/packages/connectors/src/meta.js';
test('managed selection accepts only an opaque available choice and explicit terms intent',()=>{
 const value={mode:'MANAGED',expectedRevision:2,choiceId:randomUUID(),documentSha256:'a'.repeat(64),acceptedTerms:true};
 assert.deepEqual(metaPolicyBody(value),value);
 assert.deepEqual(metaPolicyBody({mode:'CUSTOMER',expectedRevision:0}),{mode:'CUSTOMER',expectedRevision:0});
 for(const body of [{...value,acceptedTerms:false},{...value,choiceId:'credit-line'},{...value,documentSha256:'opaque'},
  {...value,actualPayer:'APPROVED_SOLUTION_PARTNER'},{...value,creditLineId:'123'},{...value,evidenceMode:'LIVE'},{...value,sendReady:true}])
  assert.throws(()=>metaPolicyBody(body),error=>error.getStatus()===400);
});

test('optional account currency has an exact node/version and independent bounded evidence',()=>{
 const now=new Date('2026-10-08T01:00:00Z'),account='123456789';
 const observed=metaAccountCurrencyObservation(account,{id:account,currency:'KWD'},'v24.0',now);
 assert.equal(observed.state,'OBSERVED');assert.equal(observed.currency,'KWD');assert.equal(observed.identifierKind,'WABA_ID');
 assert.equal(observed.expiresAt,'2026-10-08T01:15:00.000Z');
 for(const [value,version,state] of [[{id:account},'v24.0','UNAVAILABLE'],[{id:'987654321',currency:'USD'},'v24.0','UNAVAILABLE'],
  [{currency:'USD'},'v24.0','UNAVAILABLE'],[{id:account,currency:'ZZZ'},'v24.0','UNAVAILABLE'],[{id:account,currency:{}},'v24.0','UNAVAILABLE'],
  [{id:account,currency:null},'v24.0','NONE'],[{id:account,currency:'USD'},'v25.0','UNAVAILABLE']]){
  const result=metaAccountCurrencyObservation(account,value,version,now);assert.equal(result.state,state);assert.equal(result.currency,null);
 }
 const funding=metaAccountFundingProof(account,{id:account},{id:account,primary_funding_id:'funding'},now,{value:{id:'987654321',currency:'USD'},graphVersion:'v24.0'}).funding;
 assert.equal(funding.status,'PRESENT');assert.equal(funding.currency.state,'UNAVAILABLE');assert.equal(funding.actualPayer,'UNVERIFIED');
 const context={schemaVersion:1,mapping:'PHASE1_WABA_ALIAS_VERIFIED_BINDING',phoneNumberId:'123456',bindingId:randomUUID(),bindingRevision:1,proofSha256:'a'.repeat(64),
  envelopeAccount:{identifierKind:'WABA_ID',id:account},messagingAccount:{identifierKind:'MESSAGING_ACCOUNT_ID',id:account},currencyEvidence:{operationId:randomUUID(),observation:observed}};
 assert.deepEqual(parseMetaMessageProviderContext(context),context);
 for(const invalid of [{...context,mapping:'ARBITRARY_NUMERIC_EQUALITY'},{...context,envelopeAccount:{identifierKind:'WAAC_ID',id:account}},
  {...context,currencyEvidence:{operationId:randomUUID(),observation:{...observed,accountId:'987654321'}}},
  {...context,currencyEvidence:{operationId:randomUUID(),observation:{...observed,graphVersion:'v25.0'}}}])assert.throws(()=>parseMetaMessageProviderContext(invalid));
});

test('denied currency and unsupported Graph version preserve the existing funding decision',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 for(const version of ['v24.0','v25.0']){
  const fields=[];globalThis.fetch=async raw=>{const url=new URL(String(raw)),field=url.searchParams.get('fields');fields.push(field);
   if(field==='id,currency')return Response.json({error:{code:200,message:'Synthetic denied optional field'}},{status:403});
   return Response.json(field==='primary_funding_id'?{id:'123456',primary_funding_id:'funding'}:{id:'123456'});
  };
  const result=await new MetaGroupsAdapter({accessToken:'synthetic-currency-observation-token',graphVersion:version,phoneNumberIdFor:()=> '654321'}).billingAccountProof('123456');
  assert.equal(result.funding.status,'PRESENT');assert.equal(result.funding.currency.state,'UNAVAILABLE');assert.equal(result.funding.currency.currency,null);
  assert.equal(fields.filter(field=>field==='id,currency').length,version==='v24.0'?1:0);
 }
});

test('actual request phone is retained independently of legacy authority and old evidence remains readable',()=>{
 for(const snapshot of [null,{schemaVersion:1,claim:'LEGACY_UNATTRIBUTED'}]){
  const value={schemaVersion:2,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:randomUUID(),attemptNumber:1,deliveryId:randomUUID(),admittedAt:new Date().toISOString(),requestSha256:'a'.repeat(64),
   snapshot,birthDigest:snapshot?{format:'pg-jsonb-text-v1',sha256:'b'.repeat(64)}:null,
   execution:{mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null},funding:{responseSha256:null,observedAt:null,expiresAt:null},providerContext:null,requestPhoneNumberId:'840000000061'};
  assert.deepEqual(parseMetaMessageAdmissionV2(value),value);assert.equal(value.execution.mode,'UNKNOWN');assert.equal(value.providerContext,null);
  const prior={...value};delete prior.requestPhoneNumberId;delete prior.providerContext;assert.deepEqual(parseMetaMessageAdmissionV2(prior),prior);
  for(const invalid of [null,'',{},'840000000061/messages'])assert.throws(()=>parseMetaMessageAdmissionV2({...value,requestPhoneNumberId:invalid}));
 }
});

test('public tariff acceptance has four closed shapes and no client authority fields',()=>{
 const terms={documentSha256:'a'.repeat(64),acceptedTerms:true},tariff={tariffVersionId:randomUUID(),tariffDefinitionSha256:'b'.repeat(64)};
 const customer={mode:'CUSTOMER',expectedRevision:3},managed={mode:'MANAGED',expectedRevision:3,choiceId:randomUUID(),...terms};
 for(const body of [customer,managed,{...customer,...terms,...tariff},{...managed,...tariff}])assert.deepEqual(metaPolicyBody(body),parseMetaPolicySelection(body));
 for(const body of [{...customer,...terms},{...managed,tariffVersionId:tariff.tariffVersionId},{...customer,...terms,...tariff,acceptedTerms:false},
  {...customer,...terms,...tariff,expectedRevision:0},...['accountId','commercialTermsVersionId','evidenceMode','actualPayer','creditLineId','sendReady'].map(key=>({...managed,...tariff,[key]:'forged'}))])assert.throws(()=>metaPolicyBody(body));
 assert.deepEqual(parseMetaTariffQuery({tariffMode:'MANAGED',choiceId:managed.choiceId,tariffAfter:tariff.tariffVersionId}),{tariffMode:'MANAGED',choiceId:managed.choiceId,tariffAfter:tariff.tariffVersionId});
 for(const query of [{tariffMode:'CUSTOMER',choiceId:managed.choiceId},{tariffMode:'MANAGED'},{tariffAfter:tariff.tariffVersionId},{tariffMode:['CUSTOMER']},{tariffMode:'CUSTOMER',tenantId:randomUUID()}])assert.throws(()=>parseMetaTariffQuery(query));
});

test('mode values are original exact literals, never coercible input',()=>{
 for(const mode of [['CUSTOMER'],['MANAGED'],{},null,1,true,{toString:()=> 'CUSTOMER'}]){
  assert.throws(()=>parseMetaPolicySelection({mode,expectedRevision:1}));
  assert.throws(()=>metaPolicyBody({mode,expectedRevision:1}),error=>error.getStatus()===400);
  assert.throws(()=>parseMetaTariffQuery({tariffMode:mode}));
 }
});
