import assert from "node:assert/strict";
import test from "node:test";
import {parseMetaCostStatement,parseMetaCostFinanceRetention,metaCostSourceKey} from "../packages/core/src/meta-cost.ts";
const id="31000000-0000-4000-8000-000000000001",other="31000000-0000-4000-8000-000000000002",sha="a".repeat(64);
const original=()=>({schemaVersion:1,basisKind:"UPSTREAM_SOURCE",accountId:id,policyVersionId:other,commercialTermsVersionId:other,
 periodFrom:"2026-10-01T00:00:00.000Z",periodTo:"2026-11-01T00:00:00.000Z",timezone:"UTC",currency:"USD",minorUnits:2,
 source:{issuerKind:"META",issuerAuthorityVersionId:null,documentId:"synthetic-document",documentRevision:"1",sourceScopeLocator:"messaging subtotal",
  originalSha256:sha,originalByteSize:128,originalMime:"application/pdf",sourceIssuedAt:"2026-11-01T00:00:00.000Z",sourceKind:"FULL_REPLACEMENT",
  priorStatementVersionId:null,sourceAccountIdentifierKind:"MESSAGING_ACCOUNT_ID",sourceAccountIdentifier:"1234567890123",coverage:"ACCOUNT_PERIOD",
  sourceTotal:"12345678901234567890.120000",sourceQuantity:null,grossOriginalTotal:null,excludedOriginalAmount:null,supportedSubtotalLocator:null},lines:[]});

test("account-period source preserves exact decimal money without inventing message quantity or effect rows",()=>{
 const value=parseMetaCostStatement(original());assert.equal(value.basisKind,"UPSTREAM_SOURCE");if(value.basisKind!=="UPSTREAM_SOURCE")throw Error("fixture");
 assert.equal(value.source.sourceTotal,"12345678901234567890.12");assert.equal(value.source.sourceQuantity,null);assert.deepEqual(value.lines,[]);
 assert.equal(metaCostSourceKey(id,other,sha),`tenants/${id}/meta-cost-sources/${other}/${sha}.bin`);
 for(const source of [{sourceTotal:0.01},{sourceTotal:"1e2"},{sourceTotal:"-0.01"},{sourceTotal:"0.1234567890123"},{originalByteSize:10485761},
  {originalMime:"text/html"},{coverage:"MESSAGE_EFFECTS"},{sourceAccountIdentifierKind:"BUSINESS_ID"},{issuerKind:"APPROVED_PARTNER",issuerAuthorityVersionId:null},
  {grossOriginalTotal:"100",excludedOriginalAmount:null,supportedSubtotalLocator:null}])assert.throws(()=>parseMetaCostStatement({...original(),source:{...original().source,...source}}));
});
test("credit/debit and external statement references retain exact source lineage; no amount is inferred from a tariff digest",()=>{
 const adjusted=parseMetaCostStatement({...original(),source:{...original().source,sourceKind:"CREDIT_DEBIT_ADJUSTMENT",priorStatementVersionId:other,sourceTotal:"-1.25"}});
 assert.equal(adjusted.basisKind,"UPSTREAM_SOURCE");if(adjusted.basisKind!=="UPSTREAM_SOURCE")throw Error("fixture");assert.equal(adjusted.source.sourceTotal,"-1.25");
 assert.throws(()=>parseMetaCostStatement({...original(),source:{...original().source,sourceKind:"CREDIT_DEBIT_ADJUSTMENT",sourceTotal:"-1.25"}}));
 const{source:unusedSource,lines:unusedLines,...scope}=original();void unusedSource;void unusedLines;
 const derived={...scope,basisKind:"CUSTOMER_TARIFF_DERIVATION",tariffVersionId:other,upstreamStatementVersionIds:[id]};
 assert.equal(parseMetaCostStatement(derived).basisKind,"CUSTOMER_TARIFF_DERIVATION");
 for(const change of [{upstreamStatementVersionIds:[]},{upstreamStatementVersionIds:[id,id]},{tariffVersionId:null},{amount:"1"},{source:original().source}])assert.throws(()=>parseMetaCostStatement({...derived,...change}));
});
test("bounded source lines and finance retention reject silent expansion, floating money and default authority",()=>{
 const line={sourceLineId:"1",sourceLocator:"row 1",kind:"CHARGE",amount:"0.005",providerMessageId:"synthetic-effect",quantity:"1",priorSourceLineId:null};
 const source={...original(),source:{...original().source,coverage:"MESSAGE_EFFECTS",sourceTotal:"0.005",sourceQuantity:"1"},lines:[line]};
 assert.equal(parseMetaCostStatement(source).basisKind,"UPSTREAM_SOURCE");
 for(const lines of [[line,line],Array.from({length:1001},(_,index)=>({...line,sourceLineId:String(index)})),[{...line,amount:0.005}],[{...line,kind:"FX"}]])assert.throws(()=>parseMetaCostStatement({...source,lines}));
 const policy={expectedVersion:1,sourceDays:1,recordDays:30,basisSha256:sha,policyVersionId:id,commercialTermsVersionId:other};
 assert.deepEqual(parseMetaCostFinanceRetention(policy),policy);
 for(const change of [{sourceDays:0},{sourceDays:31},{recordDays:3651},{basisSha256:null},{evidenceMode:"LIVE"},{expectedVersion:0}])assert.throws(()=>parseMetaCostFinanceRetention({...policy,...change}));
});
