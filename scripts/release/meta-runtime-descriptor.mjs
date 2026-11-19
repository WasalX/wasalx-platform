#!/usr/bin/env node
// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,chmod,lstat,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertMetaDirectTransportStartup} from '../../packages/core/dist/meta-account-policy.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
/** Default-off capability read from the exact running simulator configuration.
 * No CLI field, browser flag or runtime mode may manufacture this tuple. The
 * surrounding producer first verifies source/image/TLS/hosts and release bytes. */
export function legacyMigrationFixtureCapability(simulator,{tenantId,accountId,graphVersion}){
 const entries=(simulator.Config?.Env??[]).filter(value=>value.startsWith('META_SIM_LEGACY_MIGRATION_FIXTURE='));
 if(entries.length===0)return undefined;
 assert.equal(entries.length,1,'Ambiguous legacy simulator configuration');
 const bytes=entries[0].slice('META_SIM_LEGACY_MIGRATION_FIXTURE='.length);
 if(bytes==='')return undefined;
 assert(Buffer.byteLength(bytes)<=4096);
 const v=JSON.parse(bytes),keys=['schemaVersion','claim','sourceProviderAccountId','targetProviderAccountId','phoneId','appId','graphVersion'];
 assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),keys.sort());
 assert.equal(v.schemaVersion,1);assert.equal(v.claim,'SYNTHETIC_LEGACY_SAME_PHONE');
 assert(uuid.test(tenantId)&&uuid.test(accountId));assert.equal(v.graphVersion,graphVersion);
 for(const key of ['sourceProviderAccountId','targetProviderAccountId','phoneId','appId'])assert(typeof v[key]==='string'&&/^[1-9][0-9]{0,31}$/u.test(v[key]));
 assert.notEqual(v.sourceProviderAccountId,v.targetProviderAccountId);assert.equal(v.graphVersion,'v24.0');
 // Local account IDs exist only after real enrollment. The protected database
 // registrar derives the unique source binding from this exact provider tuple.
 return{...v,tenantId,targetAccountId:accountId,fixtureSha256:sha(bytes)};
}
/** Pure final construction from original release bytes and actual Docker/source/
 * transport observations. The public UI and operation payload cannot call it. */
export function simulationRuntimeRegistration({releaseBytes,stackBytes,worker,image,simulator,simulatorSourceSha256,expectedSimulatorSourceSha256,transport,hosts,tenantId,accountId,graphVersion,expiresAt,now=new Date()}){
 const release=JSON.parse(releaseBytes),stack=JSON.parse(stackBytes);
 assert.equal(release.schemaVersion,3);assert.equal(stack.kind,'exact-stack');assert.equal(stack.clean,true);
 assert.equal(stack.candidateSha,release.release.sourceRevision);assert.equal(stack.candidateTree,release.release.sourceTree);
 const original=release.images.filter(v=>v.id==='connector-worker');assert.equal(original.length,1);
 const runtime=stack.services.filter(v=>v.service==='connector-worker');assert.equal(runtime.length,1);
 assert.equal((worker.Mounts??[]).filter(v=>v.Destination==='/run/wasalx'&&v.Source==='/var/lib/wasalx/qualification/meta-runtime'&&v.RW===false).length,1,'Exact protected directory must be mounted read-only');
 // Inspect the original worker startup, not just the separate docker-exec
 // probe. Only the incumbent direct bootstrap command is admitted here.
 assert(['node','/usr/bin/node','/usr/local/bin/node'].includes(worker.Path));
 assert.deepEqual(worker.Args,['dist/services/connector-worker/src/bootstrap.js']);
 const workerEnv=Object.fromEntries((worker.Config?.Env??[]).map(value=>{const at=value.indexOf('=');assert(at>0);return[value.slice(0,at),value.slice(at+1)];}));
 assertMetaDirectTransportStartup(workerEnv,worker.Args);
 assert.equal(transport.projection.directStartupVerified,true);
 assert.equal(transport.projection.proxySha256,sha(JSON.stringify([null,null,null,null,null,null,null,null,null])));
 assert.equal(worker.Image,image.Id);assert.equal(worker.Image,runtime[0].imageId);assert.equal(worker.State?.Running,true);
 assert.equal(image.Config?.Labels?.['io.wasalx.source.tree'],stack.candidateTree);
 assert.equal(image.Config?.Labels?.['org.opencontainers.image.revision'],stack.candidateSha);
 assert((image.RepoDigests??[]).some(v=>v.endsWith('@'+original[0].digest)),'Actual image is not the signed release image');
 assert.equal(simulator.State?.Running,true);
 const simImage=(stack.images??[]).filter(v=>v.imageId===simulator.Image);assert.equal(simImage.length,1);assert(simImage[0].repoDigests?.length,'Simulator image must belong to the exact existing stack evidence');
 assert(!(simulator.Config?.Env??[]).some(v=>v.startsWith('NODE_OPTIONS=')&&v!=='NODE_OPTIONS='),'Custom simulator loaders are not admitted');
 const command=[...(simulator.Config?.Entrypoint??[]),...(simulator.Config?.Cmd??[])];
 assert(command.includes('scripts/contracts/meta-simulation-server.mjs'),'Only the incumbent simulator is admissible');
 assert.match(expectedSimulatorSourceSha256,/^[a-f0-9]{64}$/u);assert.equal(simulatorSourceSha256,expectedSimulatorSourceSha256);
 const addresses=Object.values(simulator.NetworkSettings?.Networks??{}).map(v=>v.IPAddress).filter(Boolean);
 assert.equal(transport.projection.endpoint,'https://graph.facebook.com');
 const graphHostname=new URL(transport.projection.endpoint).hostname;
 const graph=hosts.split(/\r?\n/u).map(v=>v.replace(/#.*/u,'').trim().split(/\s+/u)).filter(v=>v.slice(1).some(hostname=>hostname===graphHostname));
 assert.equal(graph.length,1);assert(addresses.includes(graph[0][0]),'Graph must route to the verified simulator');
 assert.equal(transport.projection.graphVersion,graphVersion);assert.equal(transport.projection.hostsSha256,sha(hosts));
 assert.match(transport.transportBindingSha256,/^[a-f0-9]{64}$/u);
 assert(transport.projection.extraCaSha256,'Actual simulation TLS trust must be bound');
 assert(uuid.test(tenantId)&&uuid.test(accountId));
 assert.equal(new Date(expiresAt).toISOString(),expiresAt);assert(new Date(expiresAt)>now&&new Date(expiresAt)<=new Date(+now+24*3600_000));
 return{schemaVersion:1,mode:'SIMULATED',tenantId,accountId,workerImageDigest:original[0].digest,
  sourceTree:stack.candidateTree,graphVersion,releaseEvidenceSha256:sha(releaseBytes),
  sourceEvidenceSha256:sha(JSON.stringify({stackSha256:sha(stackBytes),simulatorSourceSha256})),
  transportBindingSha256:transport.transportBindingSha256,expiresAt,
  ...(legacyMigrationFixtureCapability(simulator,{tenantId,accountId,graphVersion})
    ?{legacyMigration:legacyMigrationFixtureCapability(simulator,{tenantId,accountId,graphVersion})}:{})};
}
/** Invoked by the existing trusted qualification owner, not by the worker/API
 * tenant. It performs no send, enrollment, credit or paid provider operation. */
export async function produceSimulationDescriptor(input,{cwd=process.cwd(),run=execFileSync,fetchImpl=fetch}={}){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0,'Protected host mount requires its existing deployment owner');
 const docker=(...args)=>run('docker',args,{cwd,encoding:'utf8',maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
 const inspect=id=>{assert.match(id,/^[a-f0-9]{12,64}$/u);const rows=JSON.parse(docker('inspect',id));assert.equal(rows.length,1);return rows[0];};
 const releasePath=resolve(cwd,input.manifest),stackPath=resolve(cwd,input.stackEvidence);
 // Reuse the existing artifact validator rather than admitting invented labels.
 run(process.execPath,[resolve(cwd,'scripts/release/artifact-contract.mjs'),'verify','--manifest',releasePath],{cwd,stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024});
 const worker=inspect(input.workerContainerId),simulator=inspect(input.simulatorContainerId);
 const [image]=JSON.parse(docker('image','inspect',worker.Image));
 const transport=JSON.parse(docker('exec',input.workerContainerId,'node','--input-type=module','-e',
  "import {currentMetaTransportBinding} from '/app/dist/services/connector-worker/src/meta-transport-binding.js';console.log(JSON.stringify(await currentMetaTransportBinding(process.env.META_GRAPH_VERSION)))"));
 const hosts=docker('exec',input.workerContainerId,'node','-e',"process.stdout.write(require('node:fs').readFileSync('/etc/hosts'))");
 const actualSource=docker('exec',input.simulatorContainerId,'node','-e',"process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('scripts/contracts/meta-simulation-server.mjs')).digest('hex'))").trim();
 const releaseBytes=await readFile(releasePath),release=JSON.parse(releaseBytes);assert.match(release.release.sourceRevision,/^[a-f0-9]{40}$/u);
 const originalSource=run('git',['show',release.release.sourceRevision+':scripts/contracts/meta-simulation-server.mjs'],{cwd,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 const candidate=simulationRuntimeRegistration({releaseBytes,stackBytes:await readFile(stackPath),worker,image,simulator,
  transport,hosts,simulatorSourceSha256:actualSource,expectedSimulatorSourceSha256:sha(originalSource),
  tenantId:input.tenantId,accountId:input.accountId,graphVersion:input.graphVersion,expiresAt:input.expiresAt});
 const origin=new URL(input.platformOrigin);assert.equal(origin.protocol,'https:');assert(!origin.username&&!origin.password&&!origin.search&&!origin.hash);
 const token=process.env.WASALX_PLATFORM_OPERATOR_TOKEN;assert(token,'The existing MFA platform operator session is required');
 const response=await fetchImpl(new URL('/platform/v1/operations/meta/runtime-evidence',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
  headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(candidate)});
 assert.equal(response.status,201,'Runtime approval registration failed');
 const raw=await response.text();assert(Buffer.byteLength(raw)<=8192);const result=JSON.parse(raw);assert(uuid.test(result.receiptId));
 const descriptor={schemaVersion:1,receiptId:result.receiptId,workerImageDigest:candidate.workerImageDigest,sourceTree:candidate.sourceTree,
  graphVersion:candidate.graphVersion,releaseEvidenceSha256:candidate.releaseEvidenceSha256,transportBindingSha256:candidate.transportBindingSha256};
 const bytes=result.descriptorText;assert.equal(typeof bytes,'string');assert(Buffer.byteLength(bytes)<=8192);assert.deepEqual(JSON.parse(bytes),descriptor);assert.equal(result.descriptorSha256,sha(bytes));
 // Existing deploy/qualification mount uses this fixed directory read-only.
 // Exclusive creation preserves ambiguous prior registrations rather than replacing.
 const directory='/var/lib/wasalx/qualification/meta-runtime';await mkdir(directory,{recursive:true,mode:0o755});
 const info=await lstat(directory);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0);
 const output=resolve(directory,'meta-request-provenance.json');await writeFile(output,bytes,{flag:'wx',mode:0o444});await chmod(output,0o444);
 return{receiptId:result.receiptId,descriptorSha256:sha(bytes),output,mode:'SIMULATED'};
}
export async function prepareMetaRuntimeMount(){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const directory='/var/lib/wasalx/qualification/meta-runtime';
 await mkdir(directory,{recursive:true,mode:0o755});const info=await lstat(directory);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0);return directory;
}
export function runtimeWithdrawalTarget(input,descriptor){
 assert.deepEqual(Object.keys(input).sort(),['platformOrigin','receiptId']);assert(uuid.test(input.receiptId));
 assert.equal(descriptor.receiptId,input.receiptId,'Only the exact retained descriptor may be withdrawn');
 const origin=new URL(input.platformOrigin);assert.equal(origin.protocol,'https:');
 assert(!origin.username&&!origin.password&&!origin.search&&!origin.hash);
 return new URL(`/platform/v1/operations/meta/runtime-evidence/${encodeURIComponent(input.receiptId)}/withdraw`,origin);
}
export async function withdrawSimulationDescriptor(input,{fetchImpl=fetch}={}){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
 const directory='/var/lib/wasalx/qualification/meta-runtime',output=resolve(directory,'meta-request-provenance.json');
 const parent=await lstat(directory);assert(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&(parent.mode&0o022)===0);
 const before=await lstat(output);assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===0&&(before.mode&0o222)===0&&before.size<=8192);
 const bytes=await readFile(output),descriptor=JSON.parse(bytes),target=runtimeWithdrawalTarget(input,descriptor);
 const token=process.env.WASALX_PLATFORM_OPERATOR_TOKEN;assert(token,'The existing MFA platform operator session is required');
 const response=await fetchImpl(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{authorization:'Bearer '+token}});
 assert.equal(response.status,201,'Runtime withdrawal failed; preserve the retained descriptor');
 const raw=await response.text();assert(Buffer.byteLength(raw)<=8192);const result=JSON.parse(raw);
 assert.equal(result.receiptId,input.receiptId);assert.equal(result.withdrawn,true);
 const after=await lstat(output);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.equal(sha(await readFile(output)),sha(bytes));
 await unlink(output);return{receiptId:input.receiptId,withdrawn:true,removedDescriptorSha256:sha(bytes)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{
 const file=process.argv[2];assert(file);
 if(file==='--prepare-mount'){assert.equal(process.argv.length,3);console.log(JSON.stringify({directory:await prepareMetaRuntimeMount()}));}
 else if(file==='--withdraw'){assert.equal(process.argv.length,4);console.log(JSON.stringify(await withdrawSimulationDescriptor(JSON.parse(await readFile(process.argv[3],'utf8')))));}
 else{assert.equal(process.argv.length,3);console.log(JSON.stringify(await produceSimulationDescriptor(JSON.parse(await readFile(file,'utf8')))));}
}catch{process.stderr.write('Meta runtime evidence was not produced; preserve any prior receipt for reconciliation\n');process.exitCode=1;}
