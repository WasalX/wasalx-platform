import assert from "node:assert/strict";
import test from "node:test";
import { createOidcTransaction } from "../lib/oidc.ts";
import { oidcTransactionCookieEvictions,oidcTransactionCookieName } from "../lib/oidc-transaction-cookies.ts";
import {
  PortalSessionError,
  assertPortalShellSession,
  parseCookies,
  safeReturnPath,
  sealPortalValue,
  sessionCookieName,
  unsealPortalValue,
  validateSession,
  type PortalSession,
} from "../lib/portal-session.ts";

const originalSecret=process.env.PORTAL_SESSION_SECRET;
const originalCookieSecure=process.env.PORTAL_COOKIE_SECURE;
process.env.PORTAL_SESSION_SECRET="test-portal-session-secret-with-more-than-32-characters";
process.env.PORTAL_COOKIE_SECURE="false";

test.after(()=>{
  restore("PORTAL_SESSION_SECRET",originalSecret);
  restore("PORTAL_COOKIE_SECURE",originalCookieSecure);
});

test("portal sessions are authenticated, encrypted, and reject tampering",async()=>{
  const now=Math.floor(Date.now()/1000);const session:PortalSession={version:1,oidcBinding:{issuer:"https://identity.test",clientId:"wasalx-portal",sid:"session-test"},accessToken:"access-token",expiresAt:now+300,subject:"subject-1",userId:"user-1",email:"owner@example.com",displayName:"Owner",tenantId:"10000000-0000-4000-8000-000000000001",tenantName:"Tenant A",tenantSlug:"tenant-a",role:"tenant_owner",csrfToken:"csrf-token",createdAt:now,sessionTimeoutSeconds:3600,absoluteExpiresAt:now+3600};
  const sealed=await sealPortalValue(session);
  assert.equal(sealed.includes("access-token"),false);
  assert.deepEqual(validateSession(await unsealPortalValue<PortalSession>(sealed)),session);
  const [iv,ciphertext]=sealed.split(".") as [string,string];const index=Math.floor(ciphertext.length/2);const replacement=ciphertext[index]==="A"?"B":"A";
  await assert.rejects(()=>unsealPortalValue(`${iv}.${ciphertext.slice(0,index)}${replacement}${ciphertext.slice(index+1)}`),PortalSessionError);
});

test("session validation rejects expired access tokens",()=>{
  const now=Math.floor(Date.now()/1000);
  assert.throws(()=>validateSession({version:1,oidcBinding:{issuer:"https://identity.test",clientId:"wasalx-portal",sid:"session-test"},accessToken:"token",expiresAt:now-1,subject:"subject",userId:"user",email:"user@example.com",displayName:"User",tenantId:"tenant",tenantName:"Tenant",tenantSlug:"tenant",role:"agent",csrfToken:"csrf",createdAt:now,sessionTimeoutSeconds:3600,absoluteExpiresAt:now+3600}),
    (error:unknown)=>error instanceof PortalSessionError&&error.message==="The portal session has expired");
});

test("OIDC transactions use PKCE and constrain post-login redirects",async()=>{
  const {transaction,challenge}=await createOidcTransaction({returnTo:"/groups?state=active",tenantId:"10000000-0000-4000-8000-000000000001"});
  assert.equal(transaction.returnTo,"/groups?state=active");
  assert.equal(transaction.requestedTenantId,"10000000-0000-4000-8000-000000000001");
  assert.match(challenge,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(safeReturnPath("//attacker.example/path"),"/app");
  assert.equal(safeReturnPath("https://attacker.example/path"),"/app");
  assert.equal(safeReturnPath("/auth/callback"),"/app");
  assert.equal(safeReturnPath(`/${"x".repeat(511)}`),`/${"x".repeat(511)}`);
  assert.equal(safeReturnPath(`/${"x".repeat(512)}`),"/app");
});

test("parallel OIDC transactions use scoped cookies and evict only invalid or oldest entries",async()=>{
  const now=Date.now();
  const states=["A","B","C","D","E"].map(character=>character.repeat(43));
  const cookies=new Map(states.map((state,index)=>[
    oidcTransactionCookieName("wasalx_oidc",state,false),
    JSON.stringify({state,createdAt:now-index}),
  ]));
  cookies.set("wasalx_oidc_bad","not-json");
  const evicted=await oidcTransactionCookieEvictions(cookies,"wasalx_oidc",false,async value=>JSON.parse(value));
  assert.deepEqual(new Set(evicted),new Set([
    "wasalx_oidc_bad",
    oidcTransactionCookieName("wasalx_oidc",states[3]!,false),
    oidcTransactionCookieName("wasalx_oidc",states[4]!,false),
  ]));
});

test("cookie parsing preserves opaque values and local cookie naming",()=>{
  assert.equal(sessionCookieName(),"wasalx_session");
  assert.deepEqual([...parseCookies("one=a=b; two=value").entries()],[['one','a=b'],['two','value']]);
});

test("shell identity bindings fail closed on stale tenant or role",()=>{
  const now=Math.floor(Date.now()/1000);const session:PortalSession={version:1,oidcBinding:{issuer:"https://identity.test",clientId:"wasalx-portal",sid:"session-test"},accessToken:"token",expiresAt:now+300,subject:"subject",userId:"user",email:"user@example.com",displayName:"User",tenantId:"tenant-a",tenantName:"Tenant",tenantSlug:"tenant",role:"agent",csrfToken:"csrf",createdAt:now,sessionTimeoutSeconds:3600,absoluteExpiresAt:now+3600};
  assert.equal(assertPortalShellSession(new Request("https://portal.test/api/dashboard"),session),session);
  assert.equal(assertPortalShellSession(new Request("https://portal.test/api/dashboard",{headers:{"x-wasalx-shell-tenant-id":"tenant-a","x-wasalx-shell-role":"agent"}}),session),session);
  assert.throws(()=>assertPortalShellSession(new Request("https://portal.test/api/dashboard",{headers:{"x-wasalx-shell-tenant-id":"tenant-b"}}),session),PortalSessionError);
  assert.throws(()=>assertPortalShellSession(new Request("https://portal.test/api/dashboard",{headers:{"x-wasalx-shell-role":"auditor"}}),session),PortalSessionError);
});

function restore(name:string,value:string|undefined){if(value===undefined)delete process.env[name];else process.env[name]=value}
