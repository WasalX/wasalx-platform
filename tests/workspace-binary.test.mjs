import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import test from "node:test";
import { PortalWorkspaceController } from "../services/control-api/dist/portal-workspace.controller.js";
import { readWorkspaceUpload, registerWorkspaceBinary, validateWorkspaceUpload, WORKSPACE_UPLOAD_TYPE } from "../services/control-api/dist/workspace-binary.js";
import { registerMetaDeletionForm } from "../services/control-api/dist/meta-deletion-form.js";
const require = createRequire(new URL("../services/control-api/package.json", import.meta.url));
const { FastifyAdapter } = require("@nestjs/platform-fastify");
const tenantId = "10000000-0000-4000-8000-000000000001", groupId = "20000000-0000-4000-8000-000000000002";
const principal = { tenantId, userId: "30000000-0000-4000-8000-000000000003", subject: "staff", role: "agent",
  authenticatedAt: Math.floor(Date.now()/1000), authenticationMethods: ["mfa"] };
const actor = { instance_id: "11000000-0000-4000-8000-000000000001", native_user_id: "12", revision: 4,
  base_url: "https://native.example.test", service_secret_reference: "synthetic" };
const bytes = Buffer.from("synthetic file");
const upload = { operation: "GROUP_UPLOAD", input: { group_id: groupId, upload_cache_id: tenantId },
  file: { filename: "fixture.txt", mime_type: "text/plain", byte_size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") } };
function controller(t, rows = [actor, actor]) {
  let calls = 0;
  const instance = new PortalWorkspaceController({ rows: async () => rows[calls++] ? [rows[calls-1]] : [] },
    { resolveCredentials: async () => ({ apiToken: "synthetic-token", jwtSecret: "synthetic-secret" }) });
  const old = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
  process.env.OIDC_ISSUER = "https://identity.example.test"; process.env.OIDC_AUDIENCE = "wasalx-api";
  t.after(() => { for (const [key,value] of [["OIDC_ISSUER",old.issuer],["OIDC_AUDIENCE",old.audience]])
    if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  return instance;
}
function request(value=upload) {
  return { principal, headers: { "content-type": WORKSPACE_UPLOAD_TYPE, "content-length": String(value.file.byte_size),
    "x-wasalx-upload-metadata": Buffer.from(JSON.stringify(value)).toString("base64url") } };
}
test("upload metadata denies actor injection, mixed destinations and unbounded file declarations", () => {
  assert.deepEqual(validateWorkspaceUpload(upload), upload);
  assert.equal(validateWorkspaceUpload({ ...upload, operation:"TICKET_UPLOAD", input:{ticket_id:"42",upload_cache_id:tenantId} }).input.ticket_id,"42");
  assert.equal(validateWorkspaceUpload({ ...upload, operation:"TICKET_UPLOAD", input:{create_group_id:"4",upload_cache_id:tenantId} }).input.create_group_id,"4");
  for (const value of [null, [], {...upload, actor:{native_user_id:"1"}}, {...upload,operation:"DELETE"},
    {...upload,input:{...upload.input,ticket_id:"42"}}, {...upload,input:{...upload.input,group_id:"foreign"}},
    {...upload,file:{...upload.file,byte_size:50_000_001}}, {...upload,file:{...upload.file,filename:"../secret"}},
    {...upload,file:{...upload.file,mime_type:"text/html\r\nx:true"}}, {...upload,file:{...upload.file,sha256:"a"}}])
    assert.throws(() => validateWorkspaceUpload(value));
});
test("bounded upload stream rejects oversized, incomplete and nonbinary bodies", async () => {
  assert.deepEqual(await readWorkspaceUpload(Readable.from([bytes]),bytes.length),bytes);
  await assert.rejects(() => readWorkspaceUpload(Readable.from([bytes]),bytes.length-1), /too large/);
  await assert.rejects(() => readWorkspaceUpload(Readable.from([bytes]),bytes.length+1), /incomplete/);
  await assert.rejects(() => readWorkspaceUpload(Readable.from(["not binary"]),10), /Invalid upload/);
});
test("raw upload parser leaves JSON intact and streams only the dedicated route", async () => {
  const adapter = new FastifyAdapter(); registerMetaDeletionForm(adapter); registerWorkspaceBinary(adapter);
  const fastify = adapter.getInstance();
  fastify.post("/json",async request => request.body);
  fastify.post("/v1/inbox/upload",async request => {
    assert.ok(request.body instanceof Readable);
    assert.equal(request.body.readableFlowing,null);
    const result=await readWorkspaceUpload(request.body,bytes.length);return {size:result.length};
  });
  try {
    const json=await fastify.inject({method:"POST",url:"/json",payload:{ok:true}});
    assert.deepEqual(json.json(),{ok:true});
    const binary=await fastify.inject({method:"POST",url:"/v1/inbox/upload",payload:bytes,headers:{"content-type":WORKSPACE_UPLOAD_TYPE}});
    assert.equal(binary.statusCode,200,binary.body);assert.deepEqual(binary.json(),{size:bytes.length});
    const other=await fastify.inject({method:"POST",url:"/json",payload:bytes,headers:{"content-type":WORKSPACE_UPLOAD_TYPE}});
    assert.equal(other.statusCode,415);
  } finally { await fastify.close(); }
});
test("staging signs exact bytes and current human identity with a distinct purpose and path",async t=>{
  const instance=controller(t);let calls=0;
  t.mock.method(globalThis,"fetch",async(url,options)=>{
    calls++;assert.equal(String(url),"https://native.example.test/api/v1/wasalx/portal-workspace/upload");
    assert.equal(options.redirect,"error");assert.deepEqual(Buffer.from(options.body),bytes);
    const envelope=Buffer.from(options.headers["x-wasalx-upload-envelope"],"base64url").toString("utf8");
    const value=JSON.parse(envelope);assert.deepEqual(value.file,upload.file);assert.equal(value.actor.user_id,principal.userId);
    assert.equal(value.actor.native_user_id,"12");assert.equal(value.purpose,"wasalx.portal-workspace-upload.v1");
    const signed=`${value.purpose}\nPOST\n/api/v1/wasalx/portal-workspace/upload\n${options.headers["x-wasalx-timestamp"]}\n${envelope}`;
    assert.equal(options.headers["x-wasalx-signature"],createHmac("sha256","synthetic-secret").update(signed).digest("hex"));
    return Response.json({items:[{id:"9",filename:"fixture.txt",mime_type:"text/plain",size:bytes.length}]});
  });
  assert.equal((await instance.upload(request(),Readable.from([bytes]))).items[0].id,"9");assert.equal(calls,1);
});
test("staging rejects a changed body before native dispatch and never retries unknown uploads",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("lost after staging");});
  await assert.rejects(()=>controller(t).upload(request(),Readable.from([Buffer.alloc(bytes.length)])),/content changed/);
  assert.equal(calls,0);
  await assert.rejects(()=>controller(t).upload(request(),Readable.from([bytes])),/Upload result/);assert.equal(calls,1);
});
test("staging missing mapping and postdispatch revocation cannot return file metadata",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({items:[{id:"private"}]});});
  await assert.rejects(()=>controller(t,[]).upload(request(),Readable.from([bytes])),/access/);assert.equal(calls,0);
  await assert.rejects(()=>controller(t,[actor,undefined]).upload(request(),Readable.from([bytes])),/access/);assert.equal(calls,1);
});
test("group media streams safe MIME only and rejects incomplete or oversized actual bytes",async t=>{
  for(const [type,expected] of [["image/png","image/png"],["image/svg+xml","application/octet-stream"],["text/html","application/octet-stream"]]){
    const mock=t.mock.method(globalThis,"fetch",async()=>new Response(bytes,{headers:{"content-type":type,"content-length":String(bytes.length)}}));
    const result=await controller(t).execute({principal},{operation:"GROUP_MEDIA",input:{group_id:groupId,message_id:tenantId}});
    assert.equal(result.getHeaders().type,expected);const chunks=[];for await(const chunk of result.getStream())chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks),bytes);mock.mock.restore();
  }
  for(const length of [bytes.length-1,bytes.length+1]){
    const mock=t.mock.method(globalThis,"fetch",async()=>new Response(bytes,{headers:{"content-type":"image/png","content-length":String(length)}}));
    const result=await controller(t).execute({principal},{operation:"GROUP_MEDIA",input:{group_id:groupId,message_id:tenantId}});
    await assert.rejects(()=>result.getStream().toArray(),/size changed|incomplete/);mock.mock.restore();
  }
});

function loadTs(url, dependencies = {}) {
  const loadedModule={exports:{}};
  const compiled=ts.transpileModule(readFileSync(url,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","module","exports",compiled)(name=>{
    if(!Object.hasOwn(dependencies,name))throw Error(`Unexpected dependency ${name}`);return dependencies[name];
  },loadedModule,loadedModule.exports);
  return loadedModule.exports;
}
test("multipart staging accepts one bounded file, preserves auth admission and rejects extra fields/files",async()=>{
  const bounded=loadTs(new URL("../lib/bounded-json.ts",import.meta.url));
  const media=loadTs(new URL("../packages/core/src/media.ts",import.meta.url));
  const calls=[];let authenticated=false;
  const {inboxUpload}=loadTs(new URL("../lib/inbox-upload.ts",import.meta.url),{
    "./bounded-json":{readBoundedBody:async(...args)=>{assert.equal(authenticated,true);return bounded.readBoundedBody(...args);}},
    "./backend":{isControlPlaneBackend:()=>true,sitesPrivateDemoError:()=>Error("demo")},
    "./control-plane-data":{portalInboxUploadRequest:async(...args)=>{calls.push(args);return{items:[{id:"9"}]};}},
    "./request-auth":{authenticatePortalBinaryUploadRequest:async(_request,permission,types)=>{assert.equal(permission,"ticket:write");assert.deepEqual(types,["multipart/form-data"]);authenticated=true;return principal;},
      authErrorResponse:error=>Response.json({error:error.message},{status:error.status??503})},
    "../packages/core/src/media":media,
  });
  const build=(extra=false,second=false)=>{const form=new FormData();form.set("group_id",groupId);form.set("upload_cache_id",tenantId);form.append("files",new File([bytes],"fixture.txt",{type:"text/plain"}));if(extra)form.set("actor","1");if(second)form.append("files",new File([bytes],"second.txt"));return new Request("http://localhost/api/inbox/group-upload",{method:"POST",body:form});};
  const result=await inboxUpload(build(),true);assert.equal(result.status,200);assert.equal(calls.length,1);
  assert.deepEqual(calls[0][1],{operation:"GROUP_UPLOAD",input:{group_id:groupId,upload_cache_id:tenantId}});
  assert.equal(await calls[0][2].text(),bytes.toString());assert.deepEqual(calls[0][3],{filename:"fixture.txt",mime_type:"text/plain"});
  assert.equal((await inboxUpload(build(true),true)).status,400);assert.equal((await inboxUpload(build(false,true),true)).status,400);assert.equal(calls.length,1);
});

test("portal staging expiry preserves native cleanup and legacy caches",()=>{
  const result=spawnSync("ruby",["tests/portal-upload-expiry-test.rb"],{encoding:"utf8",timeout:15_000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
});
