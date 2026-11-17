import {withFixtureTenant} from './meta-routing-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {routingFixtureHash,assertRoutingFixture,prepareRoutingModel} from '../scripts/release/meta-routing-fixture.mjs';
function fixture(){
 const cfg={project:'wasalx-simulation-routing',tenantId:'00000000-0000-4000-8000-000000000001',appId:'100003',graphSourceSha256:'b'.repeat(64),graphImageDigest:'sha256:'+'c'.repeat(64),
  binding:{phoneId:'100001',wabaId:'100002',customer:'12025550106'},routing:{fixture:{roles:['escalation'],targets:['ai_agent']},caSha256:'a'.repeat(64),bindingSha256:''}};
 cfg.routing.bindingSha256=routingFixtureHash(cfg);
 const graph={META_SIM_ROUTING_FIXTURE:JSON.stringify(cfg.routing.fixture),META_SIM_APP_ID:cfg.appId,META_SIM_PHONE_ID:cfg.binding.phoneId,META_SIM_WABA_ID:cfg.binding.wabaId,
  META_SIM_VERSION:'v24.0',META_SIM_RECIPIENTS:JSON.stringify([cfg.binding.customer])};
 const consumer={NODE_ENV:'development',META_ROUTING_SIMULATION_BINDING_SHA256:cfg.routing.bindingSha256,META_APP_ID:cfg.appId,META_GRAPH_VERSION:'v24.0',NODE_EXTRA_CA_CERTS:'/simulation-ca/ca.pem'};
 return{cfg,graph,consumers:[{...consumer},{...consumer}]};
}
test('prepared routing marker binds canonical private Graph and both installed consumers',()=>{
 const x=fixture();assert.deepEqual(assertRoutingFixture(x.cfg,x.graph,x.consumers),{mode:'SIMULATED',graphOrigin:'https://graph.facebook.com',graphVersion:'v24.0',simulationBindingSha256:x.cfg.routing.bindingSha256});
 for(const mutate of [x=>delete x.consumers[0].META_ROUTING_SIMULATION_BINDING_SHA256,x=>x.consumers[1].META_ROUTING_SIMULATION_BINDING_SHA256='f'.repeat(64),
  x=>x.consumers[1].NODE_ENV='production',x=>x.consumers[0].META_GRAPH_VERSION='v25.0',x=>x.consumers[0].META_APP_ID='90000',
  x=>x.cfg.tenantId='00000000-0000-4000-8000-000000000009',x=>x.cfg.graphSourceSha256='f'.repeat(64),x=>x.cfg.routing.caSha256='f'.repeat(64),
  x=>x.cfg.binding.wabaId='90001',x=>x.graph.META_SIM_ROUTING_FIXTURE=JSON.stringify({roles:['marketing'],targets:[]}),x=>x.graph.META_SIM_RECIPIENTS='["12025550111"]']){
  const value=fixture();mutate(value);assert.throws(()=>assertRoutingFixture(value.cfg,value.graph,value.consumers));
 }
 const absent=fixture();delete absent.cfg.routing;assert.throws(()=>assertRoutingFixture(absent.cfg,absent.graph,absent.consumers));
 delete absent.graph.META_SIM_ROUTING_FIXTURE;for(const c of absent.consumers)delete c.META_ROUTING_SIMULATION_BINDING_SHA256;
 assert.equal(assertRoutingFixture(absent.cfg,absent.graph,absent.consumers),null);
});
test('existing preparation installs one marker on both consumers without changing inputs or trust/origins',()=>{
 const x=fixture(),r=x.cfg.routing;delete x.cfg.routing;x.cfg.graphService='meta-graph';delete x.graph.META_SIM_ROUTING_FIXTURE;
 for(const env of x.consumers)delete env.META_ROUTING_SIMULATION_BINDING_SHA256;
 const model={name:x.cfg.project,services:{'meta-graph':{environment:x.graph},'control-api':{environment:x.consumers[0]},'connector-worker':{environment:x.consumers[1]}}};
 const original=structuredClone({model,cfg:x.cfg});
 const prepared=prepareRoutingModel(model,x.cfg,r.fixture,r.caSha256);
 assert.deepEqual({model,cfg:x.cfg},original);assert.deepEqual(prepared.config.routing,r);
 assert.equal(assertRoutingFixture(prepared.config,prepared.model.services['meta-graph'].environment,
  ['control-api','connector-worker'].map(name=>prepared.model.services[name].environment)).simulationBindingSha256,r.bindingSha256);
 assert.throws(()=>prepareRoutingModel(prepared.model,prepared.config,r.fixture,r.caSha256));
 for(const change of [v=>v.services['meta-graph'].ports=['443:443'],v=>v.services['control-api'].environment.NODE_ENV='production',
  v=>v.services['connector-worker'].environment.META_ROUTING_SIMULATION_BINDING_SHA256='f'.repeat(64)]){
  const bad=structuredClone(model);change(bad);assert.throws(()=>prepareRoutingModel(bad,x.cfg,r.fixture,r.caSha256));
 }
});

const fixtureTenant='00000000-0000-4000-8000-000000000001';
test('positive fixture tenant transaction commits with an explicit local scope',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push([sql,args]);}};
 assert.equal(await withFixtureTenant(client,fixtureTenant,async()=>{await client.query('fixture write');return 7;}),7);
 assert.deepEqual(calls,[['BEGIN',undefined],["SELECT set_config('app.tenant_id',$1,true)",[fixtureTenant]],['fixture write',undefined],['COMMIT',undefined]]);
});
test('fixture work and commit failures rollback and preserve the original error',async()=>{
 for(const phase of ['work','COMMIT',"SELECT set_config('app.tenant_id',$1,true)"]){
  const original=new Error(phase),calls=[],client={query:async sql=>{calls.push(sql);if(sql===phase)throw original;}};
  await assert.rejects(()=>withFixtureTenant(client,fixtureTenant,async()=>{calls.push('work');if(phase==='work')throw original;}),error=>error===original);
  assert.equal(calls.at(-1),'ROLLBACK');assert.equal(calls.filter(sql=>sql==='COMMIT').length,phase==='COMMIT'?1:0);
 }
});
test('uncertain fixture rollback retains both errors and cannot return success',async()=>{
 const original=new Error('work'),cleanup=new Error('rollback'),client={query:async sql=>{if(sql==='ROLLBACK')throw cleanup;}};
 await assert.rejects(()=>withFixtureTenant(client,fixtureTenant,async()=>{throw original;}),error=>error instanceof AggregateError&&error.errors[0]===original&&error.errors[1]===cleanup);
});
test('fixture BEGIN failure never reaches scope or work',async()=>{
 const original=new Error('begin'),calls=[],client={query:async sql=>{calls.push(sql);throw original;}};let writes=0;
 await assert.rejects(()=>withFixtureTenant(client,fixtureTenant,async()=>{writes++;}),error=>error===original);
 assert.deepEqual(calls,['BEGIN']);assert.equal(writes,0);
});
