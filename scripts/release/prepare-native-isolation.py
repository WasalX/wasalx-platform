"""Bounded second native instance inside one owned fresh simulation project."""
import copy,hashlib,ipaddress,json,os,pathlib,re,secrets,subprocess
TENANT='00000000-0000-4000-8000-000000000011'
PRIMARY='00000000-0000-4000-8000-000000000001'
INSTANCE='00000000-0000-4000-8000-000000000003'
SERVICES='zammad-postgresql zammad-redis zammad-memcached zammad-elasticsearch zammad-init zammad-package zammad-runtime-bootstrap zammad-railsserver zammad-scheduler'.split()
NAMES={name:name.replace('zammad-','zammad-isolation-',1) for name in SERVICES}
ONCE={NAMES[name] for name in ['zammad-init','zammad-package','zammad-runtime-bootstrap']}
NETWORK='tenant-zammad-isolation'
GIB=1024**3
MIB=1024**2
MEMORY={'zammad-postgresql':GIB,'zammad-redis':256*MIB,'zammad-memcached':384*MIB,'zammad-elasticsearch':1536*MIB,'zammad-init':3*GIB,'zammad-package':3*GIB,'zammad-runtime-bootstrap':3*GIB,'zammad-railsserver':2*GIB,'zammad-scheduler':1536*MIB}
def digest(data):return hashlib.sha256(data).hexdigest()
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def write_private(path,value):
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stream:stream.write(encoded(value));stream.flush();os.fsync(stream.fileno())
def source_admitted(root,files):
 for relative in ['scripts/release/prepare-native-isolation.py','scripts/release/simulation-native-isolation-fixture.rb','scripts/release/simulation-native-isolation.mjs']:
  path=root/relative
  assert path.is_file() and not path.is_symlink() and any(pathlib.Path(row['path']).resolve()==path.resolve() and row['sha256']==digest(path.read_bytes()) for row in files),'Unfrozen native isolation source'
def config(plan):
 value=plan.get('nativeIsolation')
 if value is None:return None
 assert plan.get('stateMode')=='fresh' and plan.get('operatorSurface')=='portal','Fresh current portal plan required'
 assert isinstance(value,dict) and set(value)=={'tenantId','instanceId','subnet'},'Explicit bounded native isolation configuration required'
 assert value['tenantId']==TENANT and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',value['instanceId']) and value['instanceId']!=INSTANCE
 network=ipaddress.ip_network(value['subnet'],strict=True);assert network.version==4 and network.is_private and network.prefixlen==24
 assert re.fullmatch(r'[A-Za-z0-9-]{1,40}',plan['namespace']) and plan['project'].startswith('wasalx-simulation-')
 return value

def prepare(root,plan,target,model):
 value=config(plan)
 if value is None:return None
 source_admitted(root,plan['files']);assert model['name']==plan['project']
 assert not set(NAMES.values())&set(model['services']) and NETWORK not in model.get('networks',{}),'Isolation model already exists'
 assert all(name in model['services'] and name in plan['images'] for name in SERVICES),'Complete existing native model/images required'
 primary=model['services']['zammad-railsserver']['environment'];assert primary['WASALX_TENANT_ID']==PRIMARY and primary['WASALX_ZAMMAD_INSTANCE_ID']==INSTANCE
 assert model['services']['zammad-postgresql']['environment']['POSTGRES_DB']=='zammad_production'
 path=target/'native-isolation-private.json'
 scope={'project':plan['project'],'namespace':plan['namespace'],'tenantId':TENANT,'instanceId':value['instanceId']}
 if path.exists():
  assert path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0
  private=json.loads(path.read_text());assert private['scope']==scope and set(private)=={'scope','databasePassword','runtimeToken','privacyToken','jwtSecret','bootstrapPassword','agentPassword'}
 else:
  private={'scope':scope,**{key:'Aa9!'+secrets.token_hex(32) for key in ['databasePassword','runtimeToken','privacyToken','jwtSecret','bootstrapPassword','agentPassword']}}
  write_private(path,private)
 values=[private[key] for key in private if key!='scope'];assert len(set(values))==len(values) and all(isinstance(x,str) and len(x)>=64 for x in values)
 originals=[primary.get('POSTGRESQL_PASS'),primary.get('WASALX_SERVICE_JWT_SECRET')]
 originals+=list(model['services']['zammad-runtime-bootstrap']['environment'].get(key) for key in ['ZAMMAD_SERVICE_TOKEN','ZAMMAD_PRIVACY_TOKEN','WASALX_ZAMMAD_BOOTSTRAP_PASSWORD','WASALX_ZAMMAD_AGENT_PASSWORD'])
 assert not set(values)&set(originals),'Native instance secrets must differ'
 volumes={}
 for name in ['zammad-backup','zammad-storage','zammad-postgresql-data','zammad-redis-data','zammad-elasticsearch-data']:
  assert name in model['volumes'] and not model['volumes'][name].get('external') and not model['volumes'][name].get('driver_opts')
  alias=name.replace('zammad-','zammad-isolation-',1);assert alias not in model['volumes'];volumes[name]=alias
  definition=copy.deepcopy(model['volumes'][name]);definition['name']=plan['project']+'_'+alias;model['volumes'][alias]=definition
 model['networks'][NETWORK]={'name':plan['project']+'_'+NETWORK,'internal':True,'ipam':{'config':[{'subnet':value['subnet']}]}}
 for original,alias in NAMES.items():
  service=copy.deepcopy(model['services'][original]);assert not service.get('ports') and not service.get('container_name') and not service.get('network_mode')
  service.pop('build',None);service['image']=plan['images'][original];service['networks']={NETWORK:None};service['mem_limit']=MEMORY[original];service['cpus']=2 if original in ['zammad-init','zammad-package','zammad-runtime-bootstrap','zammad-railsserver'] else 1
  assert all(dep in NAMES for dep in service.get('depends_on',{})),'Unexpected native dependency'
  service['depends_on']={NAMES[dep]:condition for dep,condition in service.get('depends_on',{}).items()}
  for mount in service.get('volumes',[]):
   if mount.get('type')=='volume':assert mount['source'] in volumes;mount['source']=volumes[mount['source']]
   else:assert mount.get('type')=='bind' and mount.get('read_only'),'Native clone cannot inherit writable binds'
  environment=service.setdefault('environment',{})
  if original=='zammad-postgresql':environment['POSTGRES_PASSWORD']=private['databasePassword']
  if original not in ['zammad-postgresql','zammad-redis','zammad-memcached','zammad-elasticsearch']:
   environment.update(POSTGRESQL_HOST=NAMES['zammad-postgresql'],POSTGRESQL_PASS=private['databasePassword'],MEMCACHE_SERVERS=NAMES['zammad-memcached']+':11211',REDIS_URL='redis://'+NAMES['zammad-redis']+':6379',ELASTICSEARCH_HOST=NAMES['zammad-elasticsearch'],ELASTICSEARCH_NAMESPACE='wasalx-isolation-'+plan['namespace'].lower(),WASALX_TENANT_ID=TENANT,WASALX_ZAMMAD_INSTANCE_ID=value['instanceId'],WASALX_SERVICE_JWT_SECRET=private['jwtSecret'],ZAMMAD_FQDN=NAMES['zammad-railsserver']+':3000',WASALX_MAIL_ALLOWED_HOSTS='')
   if original in ['zammad-package','zammad-runtime-bootstrap']:environment['WASALX_SERVICE_IDENTITY_MODE']='fresh'
   else:environment.pop('WASALX_SERVICE_IDENTITY_MODE',None)
  if original=='zammad-runtime-bootstrap':environment.update(ZAMMAD_SERVICE_TOKEN=private['runtimeToken'],ZAMMAD_PRIVACY_TOKEN=private['privacyToken'],WASALX_ZAMMAD_BOOTSTRAP_PASSWORD=private['bootstrapPassword'],WASALX_ZAMMAD_AGENT_PASSWORD=private['agentPassword'])
  model['services'][alias]=service;plan['images'][alias]=plan['images'][original]
 for service in ['control-api','connector-worker']:model['services'][service]['networks'][NETWORK]=None
 references={'runtime':'secret://tenants/'+TENANT+'/zammad/service','privacy':'secret://tenants/'+TENANT+'/zammad/privacy'}
 env=model['services']['secret-sidecar']['environment'];store=json.loads(env['DEV_SECRET_STORE_JSON']);assert not set(references.values())&set(store)
 store[references['runtime']]={'token':private['runtimeToken'],'jwt_secret':private['jwtSecret'],'instance_id':value['instanceId']};store[references['privacy']]={'token':private['privacyToken']};env['DEV_SECRET_STORE_JSON']=json.dumps(store,separators=(',',':'))
 return {'namespace':plan['namespace'],'tenantId':TENANT,'instanceId':value['instanceId'],'services':list(NAMES.values()),'network':NETWORK,'subnet':value['subnet'],'baseUrl':'http://'+NAMES['zammad-railsserver']+':3000','databaseReference':'docker://'+NAMES['zammad-postgresql']+'/zammad_production','searchNamespace':'wasalx-isolation-'+plan['namespace'].lower(),'storagePrefix':'tenant/'+TENANT,'secretReferences':references,'private':{'path':str(path),'sha256':digest(path.read_bytes()),'mode':path.lstat().st_mode,'uid':path.lstat().st_uid},'status':'PREPARED_NATIVE_ONLY'}

def startup_order(order,model):
 if NAMES['zammad-railsserver'] not in model['services']:return list(order)
 assert set(NAMES.values())<=set(model['services'])
 result=list(order);index=result.index('control-api');result[index:index]=list(NAMES.values());return result

def capacity_floor(model):
 # Preserve original primary+8GiB runner admission, add the capped secondary peak.
 if NAMES['zammad-railsserver'] not in model['services']:return 18*GIB,20*GIB
 resident=sum(MEMORY[name] for name in ['zammad-postgresql','zammad-redis','zammad-memcached','zammad-elasticsearch','zammad-railsserver','zammad-scheduler'])
 initializing=sum(MEMORY[name] for name in ['zammad-postgresql','zammad-redis','zammad-memcached','zammad-elasticsearch'])+max(MEMORY[name] for name in ['zammad-init','zammad-package','zammad-runtime-bootstrap'])
 return 18*GIB+max(resident,initializing),28*GIB

def private_run(command,**kwargs):
 result=subprocess.run(command,capture_output=True,text=True,timeout=90,**kwargs)
 assert result.returncode==0,'Native isolation prerequisite failed; retain private intent and inspect, never replay'
 return result.stdout

def registration_sql(value,owner):
 payload=encoded({'fixture':value,'owner':owner}).hex()
 return """\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE zammad_instances,tenant_memberships,users IN EXCLUSIVE MODE;
DO $isolation$
DECLARE p jsonb=convert_from(decode('%s','hex'),'UTF8')::jsonb; f jsonb=p->'fixture';
BEGIN
 IF f->>'tenantId'<>'00000000-0000-4000-8000-000000000011' OR NOT EXISTS(SELECT 1 FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=(f->>'tenantId')::uuid AND m.user_id='00000000-0000-4000-8000-000000000002' AND m.role='tenant_owner' AND m.state='ACTIVE' AND u.oidc_subject=p->'owner'->>'subject' AND u.email=p->'owner'->>'email') THEN RAISE EXCEPTION 'Exact shared owner unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM zammad_instances WHERE tenant_id=(f->>'tenantId')::uuid OR id=(f->>'instanceId')::uuid) THEN RAISE EXCEPTION 'Secondary instance already consumed'; END IF;
 INSERT INTO zammad_instances(id,tenant_id,base_url,agent_base_url,version,state,database_reference,search_namespace,storage_prefix,service_secret_reference,privacy_secret_reference)
 SELECT (f->>'instanceId')::uuid,(f->>'tenantId')::uuid,f->>'baseUrl',f->>'baseUrl',version,'PROVISIONING',f->>'databaseReference',f->>'searchNamespace',f->>'storagePrefix',f->'secretReferences'->>'runtime',f->'secretReferences'->>'privacy'
 FROM zammad_instances WHERE id='00000000-0000-4000-8000-000000000003' AND tenant_id='00000000-0000-4000-8000-000000000001' AND state='PROVISIONING';
 IF NOT FOUND THEN RAISE EXCEPTION 'Fresh primary registry unavailable'; END IF;
END $isolation$;
COMMIT;
"""%payload

def register(root,plan,target,model,receipt,inspect):
 value=receipt.get('nativeIsolation')
 if value is None:return
 source_admitted(root,receipt['sourceFiles']);assert value['status']=='PREPARED_NATIVE_ONLY' and value['tenantId']==TENANT and value['instanceId']==config(plan)['instanceId']
 owner=json.loads((target/'fresh-owner-claims.json').read_text());assert receipt['freshOwner']['sha256']==digest((target/'fresh-owner-claims.json').read_bytes()) and owner['state']=='CONTROL_BOUND_BEFORE_NATIVE_INIT'
 claim={'project':receipt['project'],'namespace':value['namespace'],'modelSha256':receipt['modelSha256'],'fixture':value,'freshOwnerSha256':receipt['freshOwner']['sha256']}
 write_private(target/'native-isolation-register-intent.json',claim)
 pg=inspect('postgres');env=model['services']['postgres']['environment']
 private_run(['docker','exec','-i',pg['Id'],'psql','-X','-q','-U',env['POSTGRES_USER'],'-d',env.get('POSTGRES_DB','wasalx')],input=registration_sql(value,owner['claims']))

HEALTH=r"""require 'json';require 'base64';require 'digest'
p=JSON.parse(Base64.urlsafe_decode64(ENV.fetch('WASALX_ISOLATION_EXPECTED')))
raise 'Foreign native instance' unless ENV.fetch('WASALX_TENANT_ID')==p.fetch('tenantId') && ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID')==p.fetch('instanceId')
source=Wasalx::InstalledPackage.verify!;source=JSON.parse(JSON.generate(source))
raise 'Native source identity changed' unless source.fetch('candidate_commit_sha')==p.fetch('commit') && source.fetch('candidate_tree_sha')==p.fetch('tree') && source.fetch('native_package_sha256')==p.fetch('package')
r=Wasalx::ServiceIdentity.receipt
raise 'Fresh native identity unavailable' unless r && r['schema_version']==2 && r['origin']=='FRESH' && r['phase']=='BOUND' && r['tenant_id']==p.fetch('tenantId') && r['instance_id']==p.fetch('instanceId')
owner=Wasalx::ServiceIdentity.native_owner!(r);machine=User.find(r.fetch('automation_native_user_id'))
raise 'Fresh machine default grant' unless machine.id!=owner.id && machine.group_ids_access_map.empty?
%w[runtime privacy].each do |purpose|
 token=Token.find(r.fetch(purpose+'_token_id'));raise 'Configured native token changed' unless token.user_id==machine.id && Digest::SHA256.hexdigest(token.token)==p.fetch(purpose+'Sha256')
end
puts JSON.generate({'nativeIsolationHealth'=>{'tenantId'=>p.fetch('tenantId'),'instanceId'=>p.fetch('instanceId'),'source'=>source,'freshMachine'=>true,'noDefaultGrants'=>true}})
"""
def health(model,receipt,name,inspect):
 row=inspect(name);assert row['State']['Status']=='running' and (not row['State'].get('Health') or row['State']['Health']['Status']=='healthy')
 image=json.loads(private_run(['docker','image','inspect',row['Image']]))[0];assert image['Id']==row['Image']==receipt['images'][name]
 labels=image.get('Config',{}).get('Labels',{});bootstrap='zammad-runtime-bootstrap' if name=='zammad-railsserver' else NAMES['zammad-runtime-bootstrap']
 env=model['services'][name]['environment'];secrets=model['services'][bootstrap]['environment']
 expected={'tenantId':env['WASALX_TENANT_ID'],'instanceId':env['WASALX_ZAMMAD_INSTANCE_ID'],'commit':labels.get('org.opencontainers.image.revision'),'tree':labels.get('io.wasalx.source.tree'),'package':labels.get('com.wasalx.zammad.package.sha256'),'runtimeSha256':digest(secrets['ZAMMAD_SERVICE_TOKEN'].encode()),'privacySha256':digest(secrets['ZAMMAD_PRIVACY_TOKEN'].encode())}
 assert re.fullmatch(r'[a-f0-9]{40}',expected['commit'] or '') and re.fullmatch(r'[a-f0-9]{40}',expected['tree'] or '') and re.fullmatch(r'[a-f0-9]{64}',expected['package'] or '')
 import base64
 output=private_run(['docker','exec','-e','WASALX_ISOLATION_EXPECTED='+base64.urlsafe_b64encode(encoded(expected)).decode(),row['Id'],'bundle','exec','rails','runner',HEALTH])
 parsed=[json.loads(line) for line in output.splitlines() if line.startswith('{"nativeIsolationHealth":')];assert len(parsed)==1
 return {'containerId':row['Id'],'imageId':row['Image'],**parsed[0]['nativeIsolationHealth']}

def finish(root,plan,target,model,receipt,dc,inspect,parent):
 value=receipt.get('nativeIsolation')
 if value is None:return receipt,parent
 assert (target/'native-isolation-register-intent.json').is_file() and value['status']=='PREPARED_NATIVE_ONLY'
 primary=health(model,receipt,'zammad-railsserver',inspect);secondary=health(model,receipt,NAMES['zammad-railsserver'],inspect)
 assert primary['imageId']==secondary['imageId'] and primary['source']==secondary['source'],'Both native instances require the same admitted source'
 payload=encoded(value).hex();sql="""\\set ON_ERROR_STOP on
BEGIN;
DO $isolation$
DECLARE f jsonb=convert_from(decode('%s','hex'),'UTF8')::jsonb;
BEGIN
 UPDATE zammad_instances SET state='WORKING',last_healthy_at=now() WHERE id=(f->>'instanceId')::uuid AND tenant_id=(f->>'tenantId')::uuid AND base_url=f->>'baseUrl' AND database_reference=f->>'databaseReference' AND search_namespace=f->>'searchNamespace' AND storage_prefix=f->>'storagePrefix' AND service_secret_reference=f->'secretReferences'->>'runtime' AND privacy_secret_reference=f->'secretReferences'->>'privacy' AND state='PROVISIONING';
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact initialized secondary registry unavailable'; END IF;
END $isolation$;
COMMIT;
"""%payload
 write_private(target/'native-isolation-activate-intent.json',{'project':receipt['project'],'modelSha256':receipt['modelSha256'],'secondary':secondary})
 pg=inspect('postgres');env=model['services']['postgres']['environment'];private_run(['docker','exec','-i',pg['Id'],'psql','-X','-q','-U',env['POSTGRES_USER'],'-d',env.get('POSTGRES_DB','wasalx')],input=sql)
 proof={'project':receipt['project'],'namespace':value['namespace'],'modelSha256':receipt['modelSha256'],'primary':primary,'secondary':secondary,'status':'READY_NATIVE_ONLY','humanProjection':'REQUIRES_EXPLICIT_PORTAL_OWNER_ADMISSION'}
 path=target/'native-isolation-ready.json';write_private(path,proof)
 updated=copy.deepcopy(receipt);updated['nativeIsolation']={**value,'status':'READY_NATIVE_ONLY','proof':{'path':str(path),'sha256':digest(path.read_bytes())}}
 updated['nativeIsolationParent']={'path':str(parent),'sha256':digest(parent.read_bytes())}
 selected=target/'preparation-with-native-isolation.json';write_private(selected,updated);return updated,selected

def load_preparation(target,parent,parent_path,model_path):
 path=target/'preparation-with-native-isolation.json'
 if not path.exists():
  assert not parent.get('nativeIsolation'),'Incomplete native isolation preparation; never fall back or retry'
  return parent,model_path
 for asset in [path,target/'native-isolation-ready.json']:
  assert asset.is_file() and not asset.is_symlink() and asset.stat().st_mode&0o077==0,'Unsafe native isolation receipt'
 value=json.loads(path.read_text());bound=value['nativeIsolationParent'];assert bound=={'path':str(parent_path),'sha256':digest(parent_path.read_bytes())},'Native isolation parent changed'
 assert value['generatedImmutableFiles']==parent['generatedImmutableFiles'],'Immutable preparation assets changed'
 assert value['project']==parent['project'] and value['modelSha256']==parent['modelSha256'] and value['selectedModel']==parent['selectedModel'] and value['planSha256']==parent['planSha256']
 fixture=value['nativeIsolation'];assert fixture['status']=='READY_NATIVE_ONLY' and fixture['proof']=={'path':str(target/'native-isolation-ready.json'),'sha256':digest((target/'native-isolation-ready.json').read_bytes())}
 proof=json.loads((target/'native-isolation-ready.json').read_text());assert proof['project']==value['project'] and proof['namespace']==fixture['namespace'] and proof['modelSha256']==value['modelSha256'] and proof['status']=='READY_NATIVE_ONLY'
 assert value['images']==parent['images'] and fixture['private']==parent['nativeIsolation']['private']
 private=pathlib.Path(fixture['private']['path']);assert private==target/'native-isolation-private.json' and not private.is_symlink() and private.lstat().st_mode==fixture['private']['mode'] and private.lstat().st_uid==fixture['private']['uid'] and digest(private.read_bytes())==fixture['private']['sha256'],'Native private preparation changed'
 return value,model_path
