import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {verifyMetaManagedFixtureProducers} from './meta-managed-fixture-producer-postgres.mjs';

/** Synthetic rate evidence only. Runtime provenance is supplied separately by
 * the integrated gate; neither this callback nor a tariff establishes it. */
export async function createDraftTariff(fixture,mode){
 assert.ok(mode==='MANAGED'||mode==='CUSTOMER');
 const now=new Date(),from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),to=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
 const definition={tenantId:fixture.tenantId,accountId:fixture.accountId,
  purpose:'CUSTOMER_TARIFF',evidenceMode:'SIMULATED',
  sourceSha256:createHash('sha256').update('Synthetic P10 fixture tariff v1: USD 0.005 per supported utility message').digest('hex'),
  currency:'USD',minorUnits:2,timezone:'UTC',effectiveFrom:from.toISOString(),effectiveTo:to.toISOString(),
  rounding:'PERIOD',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',pricingModel:'PMP',
  policyFamily:'ORDINARY_BUSINESS_MESSAGING',commercialTermsVersionId:fixture.commercialTermsVersionId,
  rates:[{category:'utility',pricingType:'regular',billable:true,schedule:'ORDINARY',market:'SYNTHETIC',tier:'REFERENCE',unitPrice:'0.005'}]};
 const result=await fixture.tx(fixture.platform,fixture.tenantId,async client=>{
  const role=(await client.query('SELECT current_user,session_user')).rows[0];
  assert.equal(role.current_user,'wasalx_platform_operations_client');
  assert.equal(role.session_user,'wasalx_platform_operations_runtime');
  return(await client.query('SELECT app.operator_meta_cost($1,$2,$3,$4,$5,$6,$7) value',[
   'META_COST_DRAFT',fixture.tenantId,null,{definition,supersedesId:null},`producer-tariff-${randomUUID()}`,
   'synthetic-mfa-operator',`producer-${mode.toLowerCase()}`])).rows[0].value;
 });
 assert.equal(result.state,'DRAFT');assert.match(result.id,/^[0-9a-f-]{36}$/i);
 assert.match(result.definitionSha256,/^[0-9a-f]{64}$/);
 return result.id;
}

/** Caller owns the actual isolated database and supplies runtimeEvidence from
 * its bound signed-release/Compose/runtime producer. No default or fallback. */
export async function verifyMetaCostFixtureProducers(options){
 await verifyMetaManagedFixtureProducers(options,createDraftTariff);
}
