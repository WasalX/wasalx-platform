import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';

async function loadRetainedFixture(session,config) {
  assert.notEqual(config.sourceNamespace,session.runId,'Retained fixture must come from a prior run');
  assert.match(config.sha256??'',/^[a-f0-9]{64}$/u);
  assert.match(config.sourceStage??'',/^[A-Za-z0-9-]{1,80}$/u);
  assert.equal(config.path,`scenario-${config.sourceNamespace}/fixture-${config.sourceStage}.json`,'Retained fixture path must identify its producer');
  const root=resolve(session.privateDir),path=resolve(root,config.path),rel=relative(root,path);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Retained fixture escaped private root');
  assert.equal(await realpath(path),path,'Retained fixture must not traverse a symlink');
  const bytes=await readFile(path);assert.equal(createHash('sha256').update(bytes).digest('hex'),config.sha256);
  const source=JSON.parse(bytes);assert.equal(source.namespace,config.sourceNamespace);assert.equal(source.evidenceMode,'simulated');assert.equal(source.scenario,config.sourceStage);
  assert.equal(source.fixture,config.expectedFixture);assert(source.result&&Object.getPrototypeOf(source.result)===Object.prototype);
  const prior=source.result.retainedProvenance;let retainedProvenance;
  if(prior){
    assert.equal(source.result.namespace,config.sourceNamespace);
    assert.match(prior.sourceNamespace??'',/^[A-Za-z0-9-]{1,40}$/u);assert.equal(prior.adoptedNamespace,config.sourceNamespace);assert.notEqual(prior.sourceNamespace,prior.adoptedNamespace);
    const sourceHashes=prior.sourceHashes;assert(sourceHashes&&Object.values(sourceHashes).length&&Object.values(sourceHashes).every(value=>/^[a-f0-9]{64}$/u.test(value)));
    const parents=prior.parentFixtures??[];assert(Array.isArray(parents));for(const parent of parents){assert.deepEqual(Object.keys(parent).sort(),['namespace','sha256']);assert.match(parent.namespace,/^[A-Za-z0-9-]{1,40}$/u);assert.match(parent.sha256,/^[a-f0-9]{64}$/u)}
    const namespaces=[prior.sourceNamespace,...parents.map(parent=>parent.namespace),config.sourceNamespace,session.runId];assert.equal(new Set(namespaces).size,namespaces.length,'Retained fixture provenance contains a namespace cycle');
    retainedProvenance={...prior,adoptedNamespace:session.runId,parentFixtures:[...parents,{namespace:config.sourceNamespace,sha256:config.sha256}]};
  }else retainedProvenance={sourceNamespace:config.sourceNamespace,adoptedNamespace:session.runId,sourceHashes:{fixture:config.sha256}};
  return {source,retainedProvenance};
}

export async function retainedFixtureStage(session,{config}) {
  const {source,retainedProvenance}=await loadRetainedFixture(session,config);
  await session.checkpoint({phase:'retained-fixture-admitted',sourceNamespace:config.sourceNamespace,fixture:config.expectedFixture,sourceSha256:config.sha256,noReplay:true});
  return {...source.result,namespace:session.runId,retainedProvenance};
}

export async function readRetainedRoutingPrecondition(session,config,{includeRetiredChannel=false}={}) {
  assert.equal(config.sourceStage,'email-setup');
  assert.equal(config.expectedFixture,'emailSetup');
  const {source}=await loadRetainedFixture(session,config),result=source.result;
  assert.equal(result.tenantId,session.tenantId);
  if(includeRetiredChannel){assert.match(result.channel?.ownerNamespace??'',/^[A-Za-z0-9-]{1,60}$/u);assert([config.sourceNamespace,result.retainedProvenance?.sourceNamespace].includes(result.channel.ownerNamespace),'Retained route must retain its owned mail channel proof');assert(Number.isSafeInteger(result.channel?.channelId)&&Number.isSafeInteger(result.channel?.emailAddressId));}
  assert.equal(typeof result.routing?.routingVersionId,'string');
  assert(result.routing.routingVersionId);
  await session.checkpoint({phase:'retained-routing-precondition-admitted',sourceNamespace:config.sourceNamespace,fixture:config.expectedFixture,sourceSha256:config.sha256,noReplay:true,supportingOnly:true});
  return {evidenceMode:'simulated',namespace:session.runId,tenantId:session.tenantId,routingVersionId:result.routing.routingVersionId,...(includeRetiredChannel?{retiredChannel:result.channel}:{}),readOnly:true};
}
