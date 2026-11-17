import assert from 'node:assert/strict';
import test from 'node:test';
import {billingIntentKey,parseBillingIntent} from '../lib/meta-billing-policy-intent.ts';
import {isMetaPolicyAcceptanceResult} from '../packages/core/src/meta-billing-policy-contract.ts';
const id=(n:number)=>`78000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const offer={id:id(4),definitionSha256:'b'.repeat(64),documentSha256:'a'.repeat(64),documentText:'Exact retained terms',evidenceMode:'SIMULATED',currency:'KWD',minorUnits:3,timezone:'Asia/Kuwait',effectiveFrom:'2099-01-01T00:00:01.123Z',effectiveTo:'2099-02-01T00:00:02.456Z',rounding:'LINE',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',pricingModel:'PMP',policyFamily:'ORDINARY_BUSINESS_MESSAGING',rates:[{category:'utility',pricingType:'regular',billable:true,schedule:'ORDINARY',market:'KW',tier:'STANDARD',unitPrice:'0.005123'}]};
const body={mode:'CUSTOMER' as const,expectedRevision:1,tariffVersionId:offer.id,tariffDefinitionSha256:offer.definitionSha256,documentSha256:offer.documentSha256,acceptedTerms:true as const};
const intent={version:1,tenantId:id(1),actorId:id(2),connectionId:id(3),key:id(5),body,offer,choice:null};
test('one tab-local payment intent preserves exact disclosure and rejects different authenticated context or corrupt storage',()=>{
 assert.equal(parseBillingIntent(null,id(1),id(2),id(3)),null);
 assert.deepEqual(parseBillingIntent(JSON.stringify(intent),id(1),id(2),id(3)),intent);
 for(const scope of [[id(9),id(2),id(3)],[id(1),id(9),id(3)],[id(1),id(2),id(9)]]){
  assert.throws(()=>parseBillingIntent(JSON.stringify(intent),scope[0],scope[1],scope[2]));assert.notEqual(billingIntentKey(scope[0],scope[1],scope[2]),billingIntentKey(id(1),id(2),id(3)));
 }
 for(const value of [{...intent,key:'wrong'},{...intent,body:{...body,mode:['CUSTOMER']}},{...intent,offer:{...offer,definitionSha256:'c'.repeat(64)}},
  {...intent,offer:{...offer,documentText:null}},{...intent,offer:{...offer,rates:[]}},{...intent,choice:{}},{...intent,body:{...body,mode:'MANAGED',choiceId:id(6)}}])assert.throws(()=>parseBillingIntent(JSON.stringify(value),id(1),id(2),id(3)));
 assert.throws(()=>parseBillingIntent('{',id(1),id(2),id(3)));assert.throws(()=>parseBillingIntent(' '.repeat(262145),id(1),id(2),id(3)));
 const choice={choiceId:id(6),documentSha256:offer.documentSha256,documentText:offer.documentText,kind:'OWN_SOLUTION_PARTNER_LINE',evidenceMode:'SIMULATED',expiresAt:'2099-02-01T00:00:00Z'};
 const managed={...intent,body:{...body,mode:'MANAGED',choiceId:choice.choiceId},choice};assert.deepEqual(parseBillingIntent(JSON.stringify(managed),id(1),id(2),id(3)),managed);
});
test('only the matching acknowledged result settles a retained payment command',()=>{
 const good={requestedMode:'CUSTOMER',state:'HELD',sendReady:false,replay:true};assert.equal(isMetaPolicyAcceptanceResult(body,good),true);
 for(const value of [null,{},[],{...good,requestedMode:'MANAGED'},{...good,sendReady:true},{...good,replay:'true'},{...good,state:'READY'}])assert.equal(isMetaPolicyAcceptanceResult(body,value),false);
});
