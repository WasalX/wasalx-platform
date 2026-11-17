import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyMetaManagedDomain} from './meta-managed-domain-postgres.mjs';
import {verifyMetaManagedFixtureProducers} from './meta-managed-fixture-producer-postgres.mjs';

/** Canonical SQL tests exercise actual runtime roles/functions with declared
 * synthetic registry inputs. These are NOT installed-image/runtime evidence.
 * Exact-stack qualification uses the separate source/image/transport producer;
 * no fixture value may be carried into its approval record or release claims. */
export function syntheticMetaManagedRuntimeEvidence(){
 const sha=value=>createHash('sha256').update(value).digest('hex');
 return{workerImageDigest:'sha256:'+sha('synthetic-managed-sql-image-not-installed'),
  sourceTree:createHash('sha1').update('synthetic-managed-sql-tree-not-installed').digest('hex'),
  releaseEvidenceSha256:sha('synthetic-managed-sql-release-not-installed'),
  sourceEvidenceSha256:sha('synthetic-managed-sql-source-not-installed'),
  transportBindingSha256:sha('synthetic-managed-sql-fetch-not-installed')};
}

/** An independent P08 domain gate uses real approved terms without a tariff.
 * NULL is the explicit absence accepted by the policy, not a fabricated draft.
 * The separate P10 producer gate calls its actual DRAFT function and keeps the
 * returned UUID in historical policy/terms acceptance. Caller owns the DB. */
export async function verifyMetaManagedSoftware(options){
 assert.ok(options.runtimeEvidence,'Explicit synthetic or separately qualified runtime input is required');
 const failures=[];
 for(const [name,verify] of [['domain',verifyMetaManagedDomain],['producers',verifyMetaManagedFixtureProducers]]){
  try{await verify(options,async()=>null);}catch(error){failures.push(error);console.error(`Meta managed ${name} failed`,error);}
 }
 if(failures.length)throw new AggregateError(failures,'Meta managed PostgreSQL failure union');
 const sourceBindings=[];
 for(const path of ['./meta-managed-funding-postgres.mjs','./meta-managed-domain-postgres.mjs','./meta-managed-fixture-producer-postgres.mjs',
  '../packages/core/dist/meta-account-policy.js','../services/connector-worker/dist/services/connector-worker/src/meta-managed-funding.js',
  '../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js']){
  sourceBindings.push({path,sha256:createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex')});
 }
 return{evidenceMode:'SIMULATED',providerTransport:'BOUNDED_SIMULATED_RESPONSES',
  runtimeInputClass:'SYNTHETIC_NOT_INSTALLED',sourceBindings,
  approval:'ACTUAL_RESTRICTED_FUNCTIONS',tariff:'NO_TARIFF_TERMS_ACCEPTANCE',
  financialUnknown:'ORIGINAL_HELD_NO_REPOST',privacy:'ACTUAL_ROLE_LEASE_HOLD_AND_REDACTION'};
}
