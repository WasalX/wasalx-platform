// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const roles=['ai_agent','ctwa','customer_service','escalation','marketing','utility'];
const hex=/^[a-f0-9]{64}$/u;
// One fixed, secret-free prepared tuple. Array encoding is shared with the
// existing Python preparation path; no tenant-provided runtime mode or TTL.
export function routingFixtureHash(cfg){
 const r=cfg.routing;
 assert(r&&Object.keys(r).sort().join(',')==='bindingSha256,caSha256,fixture');
 assert(hex.test(r.caSha256)&&r.fixture&&Object.keys(r.fixture).sort().join(',')==='roles,targets');
 for(const key of ['roles','targets'])assert(Array.isArray(r.fixture[key])&&r.fixture[key].length<=roles.length
  &&new Set(r.fixture[key]).size===r.fixture[key].length&&r.fixture[key].every(v=>roles.includes(v)));
 assert(r.fixture.roles.length>0);
 return createHash('sha256').update(JSON.stringify([1,cfg.project,cfg.tenantId,cfg.appId,'v24.0',cfg.binding.phoneId,
  cfg.binding.wabaId,cfg.binding.customer,cfg.graphSourceSha256,cfg.graphImageDigest,r.caSha256,
  r.fixture.roles,r.fixture.targets])).digest('hex');
}
export function assertRoutingFixture(cfg,graph,consumers){
 if(cfg.routing===undefined){
  assert(graph.META_SIM_ROUTING_FIXTURE===undefined,'Unexpected routing fixture');
  assert(consumers.every(e=>!e.META_ROUTING_SIMULATION_BINDING_SHA256),'Unbound routing runtime marker');return null;
 }
 const hash=routingFixtureHash(cfg);assert.equal(cfg.routing.bindingSha256,hash);
 assert.deepEqual(JSON.parse(graph.META_SIM_ROUTING_FIXTURE),cfg.routing.fixture);
 assert.equal(graph.META_SIM_APP_ID,cfg.appId);assert.equal(graph.META_SIM_PHONE_ID,cfg.binding.phoneId);
 assert.equal(graph.META_SIM_WABA_ID,cfg.binding.wabaId);assert.equal(graph.META_SIM_VERSION,'v24.0');
 assert.deepEqual(JSON.parse(graph.META_SIM_RECIPIENTS),[cfg.binding.customer]);
 assert.equal(consumers.length,2);
 for(const env of consumers){
  assert.equal(env.META_ROUTING_SIMULATION_BINDING_SHA256,hash,'API/worker routing marker changed');
  assert.notEqual(env.NODE_ENV,'production');assert.equal(env.META_APP_ID,cfg.appId);assert.equal(env.META_GRAPH_VERSION,'v24.0');
  assert(!env.META_GRAPH_BASE_URL||env.META_GRAPH_BASE_URL==='https://graph.facebook.com');
  assert.equal(env.NODE_EXTRA_CA_CERTS,'/simulation-ca/ca.pem');
 }
 return{mode:'SIMULATED',graphOrigin:'https://graph.facebook.com',graphVersion:'v24.0',simulationBindingSha256:hash};
}

// Pure preparation seam for main's existing private DEV model producer. It does
// not write, deploy, alter origins/trust/networks, or admit a runtime by itself.
export function prepareRoutingModel(model,cfg,fixture,caSha256){
 assert.equal(model.name,cfg.project);assert(model.name==='wasalx-live'||/^wasalx-simulation-[A-Za-z0-9_-]+$/u.test(model.name));
 assert.equal(cfg.routing,undefined,'Never replace an existing routing fixture');
 const prepared=structuredClone(cfg),next=structuredClone(model);
 prepared.routing={fixture:structuredClone(fixture),caSha256,bindingSha256:''};prepared.routing.bindingSha256=routingFixtureHash(prepared);
 const graph=next.services[cfg.graphService];assert(graph&&cfg.graphService==='meta-graph'&&!graph.ports?.length);
 assert.equal(graph.environment.META_SIM_ROUTING_FIXTURE,undefined);
 graph.environment.META_SIM_ROUTING_FIXTURE=JSON.stringify(fixture);
 for(const name of ['control-api','connector-worker']){
  const env=next.services[name].environment;assert(!env.META_ROUTING_SIMULATION_BINDING_SHA256,'Existing marker requires explicit reconciliation');
  env.META_ROUTING_SIMULATION_BINDING_SHA256=prepared.routing.bindingSha256;
 }
 assertRoutingFixture(prepared,graph.environment,['control-api','connector-worker'].map(name=>next.services[name].environment));
 return{model:next,config:prepared};
}
