import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs } from "../packages/core/src/delivery.ts";
import { verifyHmac } from "../packages/core/src/security.ts";
import { isOwnedSecretReference } from "../packages/core/src/secret-reference.ts";

test("delivery backoff grows exponentially and is capped",()=>{assert.equal(backoffMs(1,()=>.5),1000);assert.equal(backoffMs(4,()=>.5),8000);assert.equal(backoffMs(20,()=>.5),900000)});
test("HMAC verification accepts an exact raw-body signature",async()=>{const body='{"event":"message"}';const secret="test-secret";const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signed=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body));const provided=Array.from(new Uint8Array(signed)).map((b)=>b.toString(16).padStart(2,"0")).join("");assert.deepEqual(await verifyHmac({rawBody:body,secret,provided}),{valid:true})});
test("HMAC verification rejects stale requests",async()=>{assert.deepEqual(await verifyHmac({rawBody:"{}",secret:"s",provided:"",timestamp:"1",now:999_000}),{valid:false,reason:"stale"})});
test("secret references are bound to their exact owner namespace",()=>{
  const tenantId="10000000-0000-4000-8000-000000000001";const connectionId="20000000-0000-4000-8000-000000000002";
  const otherConnection="30000000-0000-4000-8000-000000000003";const rotation="a".repeat(64);
  const cases:[string,Parameters<typeof isOwnedSecretReference>[1],boolean][]=[
    [`secret://${tenantId}/connections/${connectionId}/meta`,{kind:"meta-connection",tenantId,connectionId},true],
    [`secret://${tenantId}/connections/${connectionId}/meta/rotations/${rotation}`,{kind:"meta-connection",tenantId,connectionId},true],
    [`secret://${tenantId}/connections/${connectionId}/meta/rotations/not-a-digest`,{kind:"meta-connection",tenantId,connectionId},false],
    [`secret://${tenantId}/connections/${otherConnection}/meta`,{kind:"meta-connection",tenantId,connectionId},false],
    [`secret://${tenantId}/connections/${connectionId}/webhook`,{kind:"waha-webhook",tenantId,connectionId},true],
    [`secret://tenants/${tenantId}/zammad/service`,{kind:"zammad",tenantId,purpose:"service"},true],
    [`secret://tenants/${tenantId}/routing/integrations/crm`,{kind:"routing",tenantId},true],
    [`secret://tenants/30000000-0000-4000-8000-000000000003/routing/integrations/crm`,{kind:"routing",tenantId},false],
    [`secret://tenants/${tenantId}/routing/x/../../../30000000-0000-4000-8000-000000000003/zammad/service`,{kind:"routing",tenantId},false],
    [`secret://tenants/${tenantId}/routing/a//b`,{kind:"routing",tenantId},false],
    [`secret://tenants/${tenantId}/routing/a/`,{kind:"routing",tenantId},false],
    [`secret://tenants/${tenantId}/bot-actions/orders.lookup`,{kind:"bot-action",tenantId,actionKey:"orders.lookup",actionKind:"HTTP_JSON"},true],
    [`secret://tenants/${tenantId}/bot-actions/orders.lookup/credentials/${rotation}`,{kind:"bot-action",tenantId,actionKey:"orders.lookup",actionKind:"HTTP_JSON"},true],
    [`secret://tenants/${tenantId}/bot-actions/other.lookup`,{kind:"bot-action",tenantId,actionKey:"orders.lookup",actionKind:"HTTP_JSON"},false],
    [`secret://tenants/${tenantId}/routing/integrations/40000000-0000-4000-8000-000000000004`,{kind:"bot-action",tenantId,actionKey:"notion.page",actionKind:"NOTION_CREATE_PAGE"},true],
    ["secret://platform/waha/admin",{kind:"exact",expectedReference:"secret://platform/waha/admin"},true],
    ["secret://platform/waha/other",{kind:"exact",expectedReference:"secret://platform/waha/admin"},false],
  ];
  for(const [reference,owner,expected] of cases)assert.equal(isOwnedSecretReference(reference,owner),expected);
});
