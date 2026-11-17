import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
// Replace only external effect boundaries; execute the actual route body.
const source=await readFile(new URL('../app/api/groups/bulk-toggle/route.ts',import.meta.url),'utf8');
const fixtureImports=context=>root=>ts.visitNode(root,function visit(node){
  if(ts.isImportDeclaration(node))return undefined;
  return ts.visitEachChild(node,visit,context);
});
const emitted=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},transformers:{before:[fixtureImports]}}).outputText;
const boundary=`async function toggleGroup(id){if(id==='good')return {};const error=new Error("postgresql://fixture:placeholder@db.example.test:5432/example_db");error.code=id==='known'?'WAHA_WORKER_NOT_READY':'PRIVATE_INTERNAL_CODE';throw error;}
async function authenticatePortalRequest(){return {displayName:'Synthetic owner'};}
function authErrorResponse(){return Response.json({code:'SERVICE_UNAVAILABLE'},{status:503});}
`;
const {POST}=await import('data:text/javascript;base64,'+Buffer.from(boundary+emitted).toString('base64'));
const request=(body,key='synthetic-bulk')=>new Request('https://portal.invalid/api/groups/bulk-toggle',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});

test('bulk errors retain safe reasons without disclosing internal messages',async()=>{
  const response=await POST(request({ids:['good','known','unknown'],enabled:true,expectedRevisions:{good:1,known:1,unknown:1}}));
  assert.equal(response.status,207);const body=await response.json();
  assert.equal(body.succeeded,1);assert.equal(body.failed,2);
  assert.equal(body.results[1].code,'WAHA_WORKER_NOT_READY');assert.equal(body.results[2].code,'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(body),/postgres:|password|internal|PRIVATE_INTERNAL/);
});
test('bulk validation and stale revisions have stable codes',async()=>{
  for(const [body,key,status,code] of [
    [{ids:['good'],enabled:true,expectedRevisions:{good:1}},'',400,'VALIDATION_ERROR'],
    [{ids:[],enabled:true},'key',400,'VALIDATION_ERROR'],
    [{ids:['good'],enabled:'yes'},'key',400,'VALIDATION_ERROR'],
    [{ids:[''],enabled:true},'key',400,'VALIDATION_ERROR'],
    [{ids:['good'],enabled:true},'key',409,'CONFLICT'],
  ]){const response=await POST(request(body,key));assert.equal(response.status,status);assert.equal((await response.json()).code,code);}
});
