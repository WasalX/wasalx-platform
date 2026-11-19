import assert from 'node:assert/strict';
const originals='zammad-postgresql zammad-redis zammad-memcached zammad-elasticsearch zammad-init zammad-package zammad-runtime-bootstrap zammad-railsserver zammad-scheduler'.split(' ');
const alias=name=>name.replace('zammad-','zammad-isolation-');
const once=new Set(['zammad-init','zammad-package','zammad-runtime-bootstrap']);

const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
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
export function isolationEvidenceInput(own,foreign){return{ticketId:own.ticketId,ticketNumber:own.ticketNumber,articleId:own.articleId,attachmentId:own.attachment.id,marker:own.marker,foreignTicketId:foreign.ticketId,foreignTicketNumber:foreign.ticketNumber,foreignMarker:foreign.marker};}
