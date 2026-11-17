import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import { portalContentSecurityPolicy } from "../lib/portal-security.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";

test("Meta browser permissions apply only to the exact tenant portal entry", () => {
  const ordinary = portalContentSecurityPolicy("/");
  for (const path of ["/auth/login", "/platform", "/api/connections/meta/signup/attempts", "/application", "/app/foreign", "/invitations/accept"]) {
    assert.equal(portalContentSecurityPolicy(path), ordinary);
  }
  assert.doesNotMatch(ordinary, /facebook/u);
  const portal = portalContentSecurityPolicy("/app");
  assert.match(portal, /script-src 'self' 'unsafe-inline' https:\/\/connect\.facebook\.net;/u);
  assert.match(portal, /frame-src https:\/\/www\.facebook\.com https:\/\/staticxx\.facebook\.com;/u);
  assert.match(portal, /frame-ancestors 'none';/u);
  assert.match(portal, /object-src 'none';/u);
  assert.match(portal, /form-action 'self';/u);
  assert.doesNotMatch(portal, /\*|unsafe-eval/u);
});

// Actual route/body-reader with scoped auth/transport doubles. This is BFF input
// behavior proof; it neither authenticates a real session nor contacts Meta.
const renewalCalls=[];
const renewalTransportKey=Symbol.for('wasalx.test.signup-renewal-transport');
const renewalHooks=registerHooks({resolve(specifier,context,nextResolve){
  if(context.parentURL?.includes('/app/api/connections/meta/signup/')){
    if(specifier.endsWith('/request-auth'))return {url:'data:text/javascript,export async function authenticatePortalRequest(request,permission){if(permission!=="connection:write")throw Error("Wrong permission");}',shortCircuit:true};
    if(specifier.endsWith('/backend'))return {url:'data:text/javascript,export function isControlPlaneBackend(){return true;}',shortCircuit:true};
    if(specifier.endsWith('/control-plane-data'))return {url:'data:text/javascript,export async function metaSignupPortalRequest(...args){return globalThis[Symbol.for("wasalx.test.signup-renewal-transport")](...args);}',shortCircuit:true};
    if(specifier.endsWith('/bounded-json'))return nextResolve(new URL(`${specifier}.ts`,context.parentURL).href,context);
  }
  return nextResolve(specifier,context);
}});
const renewalRoute=await import('../app/api/connections/meta/signup/[...path]/route.ts').finally(()=>renewalHooks.deregister());

test('readback BFF forwards only an exact local connection and transition pair',async t=>{
  globalThis[renewalTransportKey]=(...args)=>{renewalCalls.push(args);return {attempt:null};};
  t.after(()=>{Reflect.deleteProperty(globalThis,renewalTransportKey);});
  const connection='12000000-0000-4000-8000-000000000093',plan='33000000-0000-4000-8000-000000000093';
  const context={params:Promise.resolve({path:['attempts']})};
  const invoke=(query,body)=>renewalRoute[body===undefined?'GET':'POST'](new Request(`https://portal.example/api/connections/meta/signup/attempts${query}`,{
    method:body===undefined?'GET':'POST',headers:{origin:'https://portal.example','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),context);
  renewalCalls.length=0;
  assert.equal((await invoke(`?targetConnectionId=${connection}&targetTransitionId=${plan}`)).status,200);
  assert.equal(renewalCalls[0][0],`attempts?targetConnectionId=${connection}&targetTransitionId=${plan}`);
  const start={name:'Renew read access',payerMode:'CUSTOMER',idempotencyKey:'44000000-0000-4000-8000-000000000093',targetConnectionId:connection,targetTransitionId:plan};
  assert.equal((await invoke('',{...start,providerAccountId:'not-authority',accessToken:'never-forward',approval:true})).status,200);
  assert.deepEqual(renewalCalls[1],['attempts','POST',start,'https://portal.example']);
  for(const query of [`?targetTransitionId=${plan}`,`?targetConnectionId=${connection}&targetTransitionId=remote-account`,
    `?targetConnectionId=${connection}&targetTransitionId=${plan}&targetTransitionId=${plan}`,
    `?targetConnectionId=${connection}&targetTransitionId=${plan}&purpose=ADD_ACCESS`,
    `?targetConnectionId=${connection}&targetTransitionId=${plan}&approval=true`])
    assert.equal((await invoke(query)).status,400);
  for(const body of [{...start,targetConnectionId:undefined},{...start,targetTransitionId:null},
    {...start,targetTransitionId:'provider-account'},{...start,purpose:'ADD_ACCESS'},{...start,purpose:'TRANSITION_READBACK'}])
    assert.equal((await invoke('',body)).status,400);
  assert.equal(renewalCalls.length,2);
  const exactContext={params:Promise.resolve({path:['attempts',plan]})};
  assert.equal((await renewalRoute.GET(new Request(`https://portal.example/api/connections/meta/signup/attempts/${plan}?targetTransitionId=${plan}`),exactContext)).status,400);
  assert.equal(renewalCalls.length,2);
});

test("Meta signup explains every provider state and reason in both languages", async () => {
  const source = await readFile(new URL("../packages/core/src/meta-signup-contract.ts", import.meta.url), "utf8");
  for (const name of ["MetaSignupStatus", "MetaSignupReason"]) {
    const values = source.match(new RegExp(`export type ${name} =([\\s\\S]*?);`, "u"))[1].matchAll(/"([A-Z_]+)"/gu);
    for (const [, value] of values) {
      const key = `tenant.metaSignup.${name === "MetaSignupStatus" ? "status" : "reason"}.${value}`;
      assert.ok(englishTenantMessages[key], key);
      assert.ok(arabicTenantMessages[key], key);
      assert.notEqual(englishTenantMessages[key], arabicTenantMessages[key], key);
    }
  }
});

test("portal proxy retains the authenticated, no-store, exact-path secret boundary", async () => {
  const source = await readFile(new URL("../app/api/connections/meta/signup/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(source, /authenticatePortalRequest\(request, "connection:write"\)/u);
  assert.match(source, /no-store, private, max-age=0/u);
  assert.match(source, /request\.headers\.get\("origin"\)/u);
  assert.match(source, /uuid\.test\(path\[1\]/u);
  assert.match(source, /readBoundedJson\(new Response\(request\.body, \{ headers: request\.headers \}\), 8192\)/u);
  assert.doesNotMatch(source, /error\.message|console\./u);
  assert.match(source, /query\.getAll\("targetConnectionId"\)\.length > 1/u);
  assert.match(source, /!uuid\.test\(targetConnectionId\)/u);
  assert.match(source, /encodeURIComponent\(targetConnectionId\)/u);
});

test("Business app request, observation and hold states have distinct EN/AR explanations", async () => {
  const source = await readFile(new URL("../packages/core/src/meta-coexistence-contract.ts", import.meta.url), "utf8");
  const states = source.match(/export type MetaCoexistenceRequestState =([\s\S]*?);/u)[1].matchAll(/"([A-Z_]+)"/gu);
  for (const [, state] of states) for (const messages of [englishTenantMessages, arabicTenantMessages]) assert.ok(messages[`tenant.metaCoexistence.request.${state}`], state);
  for (const group of ["observation", "hold"]) {
    const states = group === "hold" ? ["STOPPED", "REVIEW_REQUIRED", "MEDIA_UNAVAILABLE"] : ["WAITING", "RECEIVING", "PROVIDER_FINISHED", "DECLINED", "PARTIAL"];
    for (const state of states) for (const messages of [englishTenantMessages, arabicTenantMessages]) assert.ok(messages[`tenant.metaCoexistence.${group}.${state}`], state);
  }
  assert.notEqual(englishTenantMessages["tenant.metaCoexistence.request.ACCEPTED"], englishTenantMessages["tenant.metaCoexistence.observation.PROVIDER_FINISHED"]);
});

test("import proxy keeps owner/admin, bounded pagination, no-store and stop-only consent boundaries", async () => {
  const source = await readFile(new URL("../app/api/connections/[id]/meta/coexistence/[[...path]]/route.ts", import.meta.url), "utf8");
  assert.match(source, /authenticatePortalRequest\(request, "connection:write"\)/u);
  assert.match(source, /no-store, private, max-age=0/u);
  assert.match(source, /readBoundedJson\(new Response\(request\.body, \{ headers: request\.headers \}\), 1024\)/u);
  assert.match(source, /query\.getAll\(key\)\.length !== 1/u);
  assert.match(source, /input\.history !== false \|\| input\.contacts !== false \|\| input\.echoes !== false/u);
  assert.match(source, /request\.headers\.get\("origin"\)/u);
  assert.match(source, /summaryRead && status === 404/u);
  assert.doesNotMatch(source, /failure\.message|console\./u);
});
