import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {workspaceReadFixture,installWorkspaceReadFixture} from "./e2e/workspace-read.fixture.ts";
const request=(operation,input={})=>({operation,input});
test("co-mounted reads admit actual owner/admin team panels and owner identity status only",()=>{
 for(const role of ["tenant_owner","tenant_admin"]){assert.deepEqual(workspaceReadFixture(role,"POST",request("TEAM_LIST",{limit:50})),{items:[],next_cursor:null});}
 assert.deepEqual(workspaceReadFixture("tenant_owner","POST",request("TEAM_LIST",{limit:100})),{items:[],next_cursor:null});
 const status=workspaceReadFixture("tenant_owner","POST",request("IDENTITY_STATUS"));assert.equal(status.portal_ready,true);assert.equal(status.phase,"BOUND");assert.deepEqual(status.groups,[]);assert.equal(status.legacy_member,null);for(const key of ["can_initialize","can_prepare","can_bind","can_complete"])assert.equal(status[key],false);
});
test("hidden roles, writes, receipt cancellation, ticket reads and malformed envelopes never receive fixture success",()=>{
 for(const role of ["supervisor","agent","auditor","unknown"])for(const operation of ["TEAM_LIST","IDENTITY_STATUS"])assert.equal(workspaceReadFixture(role,"POST",request(operation)),null);
 assert.equal(workspaceReadFixture("tenant_admin","POST",request("IDENTITY_STATUS")),null);
 for(const role of ["tenant_owner","tenant_admin"])for(const operation of ["TEAM_CREATE","TEAM_SAVE","TEAM_GRANT_SAVE","TEAM_RECEIPT","IDENTITY_INITIALIZE","IDENTITY_PREPARE","IDENTITY_GRANT","IDENTITY_BIND","IDENTITY_COMPLETE","IDENTITY_RECEIPT","LIST","REPLY"])assert.equal(workspaceReadFixture(role,"POST",request(operation)),null);
 for(const input of [{},{limit:0},{limit:1},{limit:49},{limit:51},{limit:101},{limit:1.5},{limit:"50"},{limit:50,before:"12"},{before:"0"},{before:"bad"},{unexpected:true}])assert.equal(workspaceReadFixture("tenant_owner","POST",request("TEAM_LIST",input)),null);
 for(const input of [{teams_after:"1"},{teams_after:"0"},{teams_after:1},{unexpected:true}])assert.equal(workspaceReadFixture("tenant_owner","POST",request("IDENTITY_STATUS",input)),null);
 for(const body of [null,[],{},request("TEAM_LIST",[]),{...request("TEAM_LIST"),secret:"extra"}])assert.equal(workspaceReadFixture("tenant_owner","POST",body),null);
 for(const method of ["GET","PATCH","DELETE"])assert.equal(workspaceReadFixture("tenant_owner",method,request("TEAM_LIST")),null);
});
test("route fulfills only scoped reads and falls through writes/parse errors without shared mutable state",async()=>{
 let handler;const fulfilled=[],fallback=[];await installWorkspaceReadFixture({route:async(pattern,fn)=>{assert.equal(pattern,"**/api/inbox");handler=fn;}},"tenant_owner");
 const route=(body,method="POST")=>({request:()=>({method:()=>method,postDataJSON:()=>{if(body===undefined)throw Error("bad JSON");return body;}}),fulfill:async value=>fulfilled.push(value),fallback:async()=>fallback.push(true)});
 await handler(route(request("TEAM_LIST",{limit:50})));await handler(route(request("IDENTITY_STATUS")));assert.equal(fulfilled.length,2);assert(fulfilled.every(value=>value.status===200));
 fulfilled[0].json.items.push("mutated");assert.deepEqual(workspaceReadFixture("tenant_owner","POST",request("TEAM_LIST",{limit:50})).items,[]);
 await handler(route(request("TEAM_CREATE")));await handler(route(undefined));await handler(route(request("TEAM_LIST"),"GET"));assert.equal(fallback.length,3);assert.equal(fulfilled.length,2);
});
test("both suites retain console guards, unchanged observation assertions and the server private-demo boundary",async()=>{
 for(const name of ["application","arabic"]){const source=await readFile(new URL(`./e2e/${name}.spec.ts`,import.meta.url),"utf8");for(const value of ['await installWorkspaceReadFixture(page, role);','test.afterEach','toEqual([])','consumeExpectedObservationFailure'])assert(source.includes(value));}
 const journey=await readFile(new URL("./e2e/workspace-access.fixture.ts",import.meta.url),"utf8");for(const line of ['expect(writes).toEqual([])','await verify("DRIFT")','sourceMemberState = "SUSPENDED"'])assert(journey.includes(line));
 const route=await readFile(new URL("../app/api/inbox/route.ts",import.meta.url),"utf8");assert(route.includes('if (!isControlPlaneBackend()) throw sitesPrivateDemoError'));
});

test("navigation Inbox reads match exact current payloads and ticket roles without admitting auditor or broader reads",()=>{
 for(const role of ["tenant_owner","tenant_admin","supervisor","agent"]){assert.deepEqual(workspaceReadFixture(role,"POST",request("CHECK")),{allowed:true});assert.deepEqual(workspaceReadFixture(role,"POST",request("LIST",{limit:50,state:"open"})),{items:[],next_cursor:null});
 for(const input of [{limit:49,state:"open"},{limit:50,state:"closed"},{limit:50},{limit:50,state:"open",query:"text"},{limit:50,state:"open",before:"10"},{ticket_number:"123"}])assert.equal(workspaceReadFixture(role,"POST",request("LIST",input)),null);
 assert.equal(workspaceReadFixture(role,"POST",request("CHECK",{unexpected:true})),null);}
 for(const role of ["auditor","unknown"])for(const [operation,input] of [["CHECK",{}],["LIST",{limit:50,state:"open"}]])assert.equal(workspaceReadFixture(role,"POST",request(operation,input)),null);
});

test("Settings sibling reads are inert and limited to the current owner-only payloads",()=>{
 assert.deepEqual(workspaceReadFixture("tenant_owner","POST",request("MAILBOX_LIST")),{items:[],next_cursor:null,can_create:false,mail_ready:false});
 for(const role of ["tenant_admin","supervisor","agent","auditor","unknown"]){assert.equal(workspaceReadFixture(role,"POST",request("MAILBOX_LIST")),null);assert.equal(workspaceReadFixture(role,"POST",request("TEAM_LIST",{limit:100})),null);}
 for(const input of [{before:"1"},{limit:100},{unexpected:true}])assert.equal(workspaceReadFixture("tenant_owner","POST",request("MAILBOX_LIST",input)),null);
 for(const operation of ["MAILBOX_CREATE","MAILBOX_SAVE","MAILBOX_VERIFY_START","MAILBOX_VERIFY_STATUS","MAILBOX_ACTIVATE","MAILBOX_PAUSE","MAILBOX_RECEIPT","MAILBOX_SIGNATURE_SHOW","MAILBOX_SIGNATURE_SAVE"])assert.equal(workspaceReadFixture("tenant_owner","POST",request(operation)),null);
});
