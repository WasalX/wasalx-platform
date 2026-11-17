import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';

const prefix='group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::';
export const completedQ05zIds=['lid-equivalence','tenant-boundary'].map(value=>prefix+value);
const remaining=['mapping-conflict','reprocess'].map(value=>prefix+value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const one=(rows,label)=>{assert.equal(rows.length,1,label);return rows[0]};

export function validateRetainedQ05zSources(source,{namespace,candidate,project,manifestSha256,priorQ05u}){
 assert.equal(source.setup.namespace,namespace);assert.deepEqual(source.setup.retainedQ05u,priorQ05u);assert.equal(source.manifest.namespace,namespace);assert.equal(source.manifest.evidenceMode,'simulated');assert.equal(source.admission.evidenceMode,'simulated');assert.deepEqual(source.admission.candidate,candidate);assert.equal(source.admission.project,project);
 assert.equal(source.contextBinding.evidenceMode,'simulated');assert.deepEqual(source.contextBinding.candidate,candidate);assert.equal(source.contextBinding.project,project);assert.equal(source.contextBinding.locale,'en');assert.equal(source.contextBinding.owner.role,'tenant_owner');assert.equal(source.contextBinding.native.role,'zammad_agent');
 const stage=one(source.manifest.scenarios.filter(value=>value.id==='sender-policy'),'q05z sender stage');assert.deepEqual([...stage.testIds].sort(),[...completedQ05zIds,...remaining].sort());assert.equal(stage.export,'senderPolicyRemainingStage');
 assert.equal(source.terminal.status,'terminal');assert.equal(source.terminal.exitCode,1);assert.equal(source.terminal.namespace,namespace);assert.equal(source.terminal.applicationSha,candidate.sha);assert.equal(source.terminal.applicationTree,candidate.tree);assert.equal(source.terminal.manifestSha256,manifestSha256);assert.match(source.failure.error,/Exact conflicting provider roster must have been synced; no SQL fixture substitute/);
 const cleanup=source.intents.at(-1),closures=['owned-context-0','owned-context-1','owned-context-2','owned-context-3','owned-context-4','owned-browser','owned-db'];assert.equal(cleanup.phase,'cleanup');assert.deepEqual(cleanup.results.map(value=>value.name).sort(),closures.sort());assert(cleanup.results.every(value=>value.status==='closed'));assert(!source.intents.some(value=>value.phase==='fixture-produced'&&value.scenario==='sender-policy'));
 const passes=source.intents.filter(value=>value.result==='passed'&&completedQ05zIds.includes(value.testId));assert.deepEqual(passes.map(value=>value.testId).sort(),[...completedQ05zIds].sort());assert(passes.every(value=>value.startedAt&&value.finishedAt));assert(!source.intents.some(value=>value.testId&&remaining.includes(value.testId)));
 return source;
}

export async function loadRetainedQ05z(session,config,priorQ05u){
 if(session.capabilities.retainedQ05z)return session.capabilities.retainedQ05z;const source={};
 for(const[key,ref]of Object.entries(config.sources)){assert.match(ref.sha256,/^[a-f0-9]{64}$/);assert(!isAbsolute(ref.path));const path=resolve(session.privateDir,ref.path),rel=relative(session.privateDir,path);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(await realpath(path),path);const stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink());const bytes=await readFile(path);assert.equal(hash(bytes),ref.sha256,'Retained q05z source drift: '+ref.path);source[key]=ref.path.endsWith('.jsonl')?bytes.toString().trim().split('\n').map(JSON.parse):JSON.parse(bytes);}
 return session.capabilities.retainedQ05z=validateRetainedQ05zSources(source,{namespace:config.namespace,candidate:session.candidate,project:session.model.name,manifestSha256:config.sources.manifest.sha256,priorQ05u});
}

export function validateQ05zState({source,baseMember,currentMember,audits,baseBinding,currentBinding,history,botOperations,ruleOperations,eventRows,deliveryRows,actionRows,ownerId}){
 assert.deepEqual({...currentMember,version:undefined},{...baseMember,version:undefined});assert.equal(Number(currentMember.version),Number(baseMember.version)+2);assert.deepEqual(audits.map(value=>Number(value.previous_value.version)),[Number(baseMember.version),Number(baseMember.version)+1]);assert.deepEqual(audits.map(value=>Number(value.new_value.version)),[Number(baseMember.version)+1,Number(baseMember.version)+2]);assert.deepEqual(audits.map(value=>Number(value.previous_value.whatsapp_numbers_registered)),[0,2]);assert.deepEqual(audits.map(value=>Number(value.new_value.whatsapp_numbers_registered)),[2,0]);assert(audits.every(value=>value.actor_id===ownerId&&value.action==='team.membership_updated'&&value.target_type==='tenant_membership'&&value.request_id&&value.new_value.whatsapp_numbers_changed===true));assert.equal(new Set(audits.map(value=>value.request_id)).size,2);
 assert.equal(Number(baseBinding.binding_revision),11);assert.equal(Number(currentBinding.binding_revision),12);assert.equal(currentBinding.rule_set_id,baseBinding.rule_set_id);assert.deepEqual(history.map(value=>Number(value.revision)),[11,12]);assert(history.every(value=>value.hash_valid&&value.group_binding_id===baseBinding.bindingId));assert.equal(history[1].changed_by,ownerId);assert.equal(history[1].snapshot.ruleSetId,baseBinding.rule_set_id);assert.deepEqual(history[0].snapshot,history[1].snapshot);
 const operation=one(botOperations,'q05z binding restoration');assert.equal(operation.idempotency_key,'synthetic-'+source.manifest.namespace+'-sender-remaining-restore-binding');assert.equal(operation.action,'GROUP_BINDING_SAVE');assert.equal(operation.requested_by,ownerId);assert.equal(operation.request_id,history[1].request_id);assert.equal(Number(operation.result.revision),12);assert.equal(operation.result.id,baseBinding.bindingId);assert.equal(operation.result.state,'ACTIVE');
 assert.deepEqual(ruleOperations,[]);assert.deepEqual(eventRows,[]);assert.deepEqual(deliveryRows,[]);assert.deepEqual(actionRows,[]);
 return{memberVersion:Number(currentMember.version),bindingRevision:12,preservedPasses:completedQ05zIds.map(testId=>{const row=one(source.intents.filter(value=>value.testId===testId&&value.result==='passed'),testId);return{testId,startedAt:row.startedAt,finishedAt:row.finishedAt};})};
}
