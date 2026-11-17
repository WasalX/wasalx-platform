import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,lstat,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseRailsJson} from './simulation-rails-json.mjs';
import {privateNativeRead,ensurePortalOperator} from './simulation-portal-operator.mjs';
import {admitSecondaryPortalOwner,assertNativeIsolationReadback} from './simulation-portal-isolation.mjs';
const originals='zammad-postgresql zammad-redis zammad-memcached zammad-elasticsearch zammad-init zammad-package zammad-runtime-bootstrap zammad-railsserver zammad-scheduler'.split(' ');
const alias=name=>name.replace('zammad-','zammad-isolation-');
const once=new Set(['zammad-init','zammad-package','zammad-runtime-bootstrap']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,id=/^[1-9][0-9]{0,15}$/u;
export function assertNativeIsolationModel(model,fixture){
 assert(model.name.startsWith('wasalx-simulation-'));assert.match(fixture.tenantId,uuid);assert.match(fixture.instanceId,uuid);
 assert.equal(fixture.tenantId,'00000000-0000-4000-8000-000000000011');assert.equal(fixture.status,'READY_NATIVE_ONLY');
 const primary=model.services['zammad-railsserver'].environment,secondary=model.services[alias('zammad-railsserver')].environment;
 assert.notEqual(primary.WASALX_TENANT_ID,secondary.WASALX_TENANT_ID);assert.notEqual(primary.WASALX_ZAMMAD_INSTANCE_ID,secondary.WASALX_ZAMMAD_INSTANCE_ID);
 assert.equal(secondary.WASALX_TENANT_ID,fixture.tenantId);assert.equal(secondary.WASALX_ZAMMAD_INSTANCE_ID,fixture.instanceId);
 for(const key of ['POSTGRESQL_HOST','POSTGRESQL_PASS','MEMCACHE_SERVERS','REDIS_URL','ELASTICSEARCH_HOST','ELASTICSEARCH_NAMESPACE','WASALX_SERVICE_JWT_SECRET'])assert(primary[key]&&secondary[key]&&primary[key]!==secondary[key],'Native isolation boundary overlaps: '+key);
 assert.match(fixture.subnet??'',/^(?:[0-9]{1,3}\.){3}0\/24$/u);assert.equal(model.networks[fixture.network].internal,true);assert.deepEqual(model.networks[fixture.network].ipam.config.map(row=>row.subnet),[fixture.subnet]);
 const primaryStorage=new Set(),secondaryStorage=new Set();
 for(const name of originals){
  const p=model.services[name],s=model.services[alias(name)];assert(p&&s);assert.equal(s.image,p.image);assert.match(s.image,/^sha256:[a-f0-9]{64}$/u);assert(!s.ports?.length&&!s.build&&!s.container_name&&!s.network_mode);assert.deepEqual(Object.keys(s.networks),[fixture.network]);assert(Number(s.mem_limit)>0&&Number(s.cpus)>0);
  for(const [service,output] of [[p,primaryStorage],[s,secondaryStorage]])for(const mount of service.volumes??[]){if(mount.type==='volume'){output.add(mount.source);assert(!model.volumes[mount.source].external&&!model.volumes[mount.source].driver_opts);}else assert(mount.type==='bind'&&mount.read_only,'Native fixture contains a writable host bind');}
 }
 assert(primaryStorage.size&&secondaryStorage.size&&[...secondaryStorage].every(value=>!primaryStorage.has(value)));
 const p=model.services['zammad-runtime-bootstrap'].environment,s=model.services[alias('zammad-runtime-bootstrap')].environment;
 for(const key of ['ZAMMAD_SERVICE_TOKEN','ZAMMAD_PRIVACY_TOKEN','WASALX_SERVICE_JWT_SECRET'])assert(p[key]&&s[key]&&p[key]!==s[key]);
 const store=JSON.parse(model.services['secret-sidecar'].environment.DEV_SECRET_STORE_JSON),refs=fixture.secretReferences;
 assert(store[refs.runtime]&&store[refs.privacy],'Secondary secret references unavailable');assert.equal(store[refs.runtime].instance_id,fixture.instanceId);assert(store[refs.runtime].token===s.ZAMMAD_SERVICE_TOKEN&&store[refs.runtime].jwt_secret===s.WASALX_SERVICE_JWT_SECRET&&store[refs.privacy].token===s.ZAMMAD_PRIVACY_TOKEN,'Secondary configured secret boundary changed');
 assert.equal(s.WASALX_SERVICE_IDENTITY_MODE,'fresh');
 return{database:true,search:true,storage:true,secrets:true};
}
export function assertInstalledIsolationSource(installed,source){
 for(const key of ['candidate_commit_sha','candidate_tree_sha','native_package_sha256'])assert.equal(installed?.[key],source[key],'Installed native source differs from the admitted image');
 assert(typeof installed.package_version==='string'&&installed.package_version.length>0&&Number.isInteger(installed.source_files_verified)&&installed.source_files_verified>0,'Installed native source verification is incomplete');
}
// Private inspect data stays in memory: every credential comparison yields only a boolean.
export function assertNativeIsolationContainers(model,prepared,rows,network){
 const found={},project=model.name,fixture=prepared.nativeIsolation;
 assert.equal(network.Name,model.networks[fixture.network].name);assert.equal(network.Internal,true);assert.equal(network.Labels?.['com.docker.compose.project'],project);assert.equal(network.Labels?.['com.docker.compose.network'],fixture.network);assert.deepEqual(network.IPAM?.Config?.map(row=>row.Subnet),[fixture.subnet]);
 for(const name of originals.flatMap(value=>[value,alias(value)])){
  const selected=rows.filter(row=>row.Config?.Labels?.['com.docker.compose.project']===project&&row.Config?.Labels?.['com.docker.compose.service']===name);assert.equal(selected.length,1,'Exactly one owned native service required: '+name);const row=selected[0],declared=model.services[name],original=name.replace('zammad-isolation-','zammad-');
  assert.equal(row.Image,prepared.images[name]);assert.equal(row.Image,declared.image);
  if(once.has(original)){assert.equal(row.State.Status,'exited');assert.equal(row.State.ExitCode,0);}else{assert.equal(row.State.Status,'running');if(declared.healthcheck)assert.equal(row.State.Health?.Status,'healthy');}
  const environment=Object.fromEntries((row.Config.Env??[]).map(value=>{const index=value.indexOf('=');return[value.slice(0,index),value.slice(index+1)];}));
   for(const key of ['POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRESQL_DB','POSTGRESQL_USER','POSTGRESQL_HOST','POSTGRESQL_PORT','POSTGRESQL_PASS','MEMCACHE_SERVERS','REDIS_URL','ELASTICSEARCH_HOST','ELASTICSEARCH_NAMESPACE','WASALX_TENANT_ID','WASALX_ZAMMAD_INSTANCE_ID','WASALX_SERVICE_JWT_SECRET','WASALX_SERVICE_IDENTITY_MODE','WASALX_ZAMMAD_BOOTSTRAP_OIDC_SUBJECT','WASALX_ZAMMAD_BOOTSTRAP_EMAIL','WASALX_ZAMMAD_BOOTSTRAP_NAME','ZAMMAD_SERVICE_TOKEN','ZAMMAD_PRIVACY_TOKEN']){
    if(Object.hasOwn(declared.environment??{},key))assert(environment[key]===String(declared.environment[key]),'Actual native environment differs from the prepared boundary: '+key);
   }
  if(name.startsWith('zammad-isolation-')){
   assert(!Object.keys(row.HostConfig?.PortBindings??{}).length,'Secondary native ports are forbidden');assert.deepEqual(Object.keys(row.NetworkSettings?.Networks??{}),[network.Name]);assert.equal(row.NetworkSettings.Networks[network.Name].NetworkID,network.Id);
   assert.equal(row.HostConfig.Memory,declared.mem_limit);assert.equal(row.HostConfig.NanoCpus,Number(declared.cpus)*1e9);
  }
  const expected=declared.volumes??[],actual=row.Mounts??[];assert.equal(actual.length,expected.length,'Unexpected native storage mount');
  for(const mount of expected){const matches=actual.filter(value=>value.Destination===mount.target);assert.equal(matches.length,1,'Exact native storage destination required');const value=matches[0];assert.equal(value.Type,mount.type);assert.equal(value.RW,!mount.read_only);if(mount.type==='volume')assert.equal(value.Name,model.volumes[mount.source].name??project+'_'+mount.source);else assert.equal(value.Source,mount.source);}
  found[name]=row;
 }
 // Actual volume names and host paths must also be disjoint, independently of model keys.
 const writable=name=>(found[name].Mounts??[]).filter(value=>value.RW).flatMap(value=>[value.Source,...(value.Type==='volume'?[value.Name]:[])]),primary=new Set(originals.flatMap(writable));assert(originals.flatMap(name=>writable(alias(name))).every(value=>!primary.has(value)),'Actual native storage overlaps');
 return found;
}
async function inspectNative(s,prepared){
 const ids=(await s.run('docker',['ps','-aq','--filter','label=com.docker.compose.project='+s.model.name])).trim().split(/\s+/u).filter(Boolean);assert(ids.length&&ids.every(value=>/^[a-f0-9]{64}$/u.test(value)));
 const rows=JSON.parse(await s.run('docker',['inspect',...ids]));const [network]=JSON.parse(await s.run('docker',['network','inspect',s.model.networks[prepared.nativeIsolation.network].name]));
 const found=assertNativeIsolationContainers(s.model,prepared,rows,network);Object.assign(s.containers,found);return found;
}
async function admittedSource(s,container){
 const [image]=JSON.parse(await s.run('docker',['image','inspect',container.Image]));assert.equal(image.Id,container.Image);const labels=image.Config?.Labels??{};
 const result={candidate_commit_sha:labels['org.opencontainers.image.revision'],candidate_tree_sha:labels['io.wasalx.source.tree'],native_package_sha256:labels['com.wasalx.zammad.package.sha256']};assert.equal(result.candidate_commit_sha,s.candidate.sha);assert.equal(result.candidate_tree_sha,s.candidate.tree);assert.match(result.native_package_sha256??'',/^[a-f0-9]{64}$/u);return result;
}
async function fixedFixture(s,view,input){
 const service=view.nativeReadService??'zammad-railsserver';assert(['zammad-railsserver','zammad-isolation-railsserver'].includes(service));const container=view.containers[service];assert(container);
 const source=await admittedSource(s,container),payload={project:s.model.name,namespace:input.namespace,tenantId:view.tenantId,instanceId:view.model.services[service].environment.WASALX_ZAMMAD_INSTANCE_ID,source,...input};
 const ruby=await readFile(join(s.driverRoot,'scripts/release/simulation-native-isolation-fixture.rb'),'utf8');const output=await s.run('docker',['exec','-e','WASALX_NATIVE_ISOLATION_INPUT='+Buffer.from(JSON.stringify(payload)).toString('base64url'),container.Id,'bundle','exec','rails','runner',ruby]);const result=parseRailsJson(output).nativeIsolation;assert(result);assert.equal(result.tenantId,view.tenantId);assert.equal(result.instanceId,payload.instanceId);assertInstalledIsolationSource(result.source,source);return result;
}
async function registry(s,tenantId){
 await s.db.query('BEGIN READ ONLY');try{await s.db.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);const rows=(await s.db.query('SELECT id,tenant_id,state,base_url,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference FROM zammad_instances WHERE tenant_id=$1',[tenantId])).rows;assert.equal(rows.length,1);return rows[0];}finally{await s.db.query('ROLLBACK');}
}
export function isolationEvidenceInput(own,foreign){return{ticketId:own.ticketId,ticketNumber:own.ticketNumber,articleId:own.articleId,attachmentId:own.attachment.id,marker:own.marker,foreignTicketId:foreign.ticketId,foreignTicketNumber:foreign.ticketNumber,foreignMarker:foreign.marker};}
