import copy,hashlib,importlib.util,json,os,pathlib,tempfile,unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[1]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('isolation','scripts/release/prepare-native-isolation.py')
class Isolation(unittest.TestCase):
 def setUp(self):
  if os.name=='nt':
   actual=pathlib.Path.stat
   def linux_private(path,*args,**kwargs):
    value=actual(path,*args,**kwargs);fields=list(value);fields[0]&=~0o077;return os.stat_result(fields)
   self.enterContext(mock.patch.object(pathlib.Path,'stat',linux_private))
 def fixture(self):
  image='sha256:'+'a'*64;project='wasalx-simulation-unit';env={'WASALX_TENANT_ID':m.PRIMARY,'WASALX_ZAMMAD_INSTANCE_ID':m.INSTANCE,'POSTGRESQL_PASS':'old-database','WASALX_SERVICE_JWT_SECRET':'old-jwt','ZAMMAD_SERVICE_TOKEN':'old-runtime','ZAMMAD_PRIVACY_TOKEN':'old-privacy','WASALX_ZAMMAD_BOOTSTRAP_PASSWORD':'old-bootstrap','WASALX_ZAMMAD_AGENT_PASSWORD':'old-agent'}
  model={'name':project,'services':{name:{'environment':dict(env),'networks':{'primary':None},'volumes':[{'type':'volume','source':'zammad-storage','target':'/opt/zammad/storage'}]} for name in m.SERVICES},'volumes':{name:{'name':project+'_'+name} for name in ['zammad-backup','zammad-storage','zammad-postgresql-data','zammad-redis-data','zammad-elasticsearch-data']},'networks':{'primary':{'name':project+'_primary'}}}
  model['services']['zammad-postgresql']['environment'].update(POSTGRES_DB='zammad_production',POSTGRES_USER='zammad',POSTGRES_PASSWORD='old-database')
  model['services']['zammad-runtime-bootstrap']['environment']['WASALX_ZAMMAD_DISPLAY_TIMEZONE']='Asia/Tokyo'
  for name in ['control-api','connector-worker']:model['services'][name]={'networks':{'primary':None}}
  model['services']['secret-sidecar']={'environment':{'DEV_SECRET_STORE_JSON':'{}'}}
  plan={'stateMode':'fresh','operatorSurface':'portal','project':project,'namespace':'unit','nativeIsolation':{'tenantId':m.TENANT,'instanceId':'00000000-0000-4000-8000-000000000013','subnet':'192.0.2.0/24'},'images':{name:image for name in m.SERVICES},'files':[{'path':str(ROOT/relative),'sha256':m.digest((ROOT/relative).read_bytes())} for relative in ['scripts/release/prepare-native-isolation.py','scripts/release/simulation-native-isolation-fixture.rb','scripts/release/simulation-native-isolation.mjs']]}
  return model,plan
 def test_complete_internal_clone_reuses_images_and_separates_secrets(self):
  model,plan=self.fixture();original=copy.deepcopy(model)
  with tempfile.TemporaryDirectory() as directory:
   result=m.prepare(ROOT,plan,pathlib.Path(directory),model);self.assertEqual(result['subnet'],'192.0.2.0/24');self.assertEqual(len(result['services']),9);self.assertEqual(model['networks'][m.NETWORK]['internal'],True)
   for name,alias in m.NAMES.items():
    self.assertEqual(model['services'][alias]['image'],plan['images'][name]);self.assertEqual(list(model['services'][alias]['networks']),[m.NETWORK]);self.assertNotIn('ports',model['services'][alias])
    if name in ['zammad-package','zammad-runtime-bootstrap']:self.assertEqual(model['services'][alias]['environment']['WASALX_SERVICE_IDENTITY_MODE'],'fresh')
    elif name not in ['zammad-postgresql','zammad-redis','zammad-memcached','zammad-elasticsearch']:self.assertNotIn('WASALX_SERVICE_IDENTITY_MODE',model['services'][alias]['environment'])
   self.assertEqual(model['services']['zammad-runtime-bootstrap'],original['services']['zammad-runtime-bootstrap']);self.assertNotEqual(model['services']['zammad-isolation-runtime-bootstrap']['environment']['ZAMMAD_SERVICE_TOKEN'],original['services']['zammad-runtime-bootstrap']['environment']['ZAMMAD_SERVICE_TOKEN'])
   self.assertEqual(model['services']['zammad-isolation-runtime-bootstrap']['environment']['WASALX_ZAMMAD_DISPLAY_TIMEZONE'],'Asia/Tokyo')
   with self.assertRaisesRegex(AssertionError,'already exists'):m.prepare(ROOT,plan,pathlib.Path(directory),model)
 def test_invalid_plan_bounds_fail_without_private_write(self):
  for change in [lambda p:p.update(operatorSurface='native'),lambda p:p['nativeIsolation'].update(subnet='192.0.2.0/31'),lambda p:p['nativeIsolation'].update(subnet='8.8.8.0/24'),lambda p:p['nativeIsolation'].update(instanceId=m.INSTANCE),lambda p:p['nativeIsolation'].update(tenantId=m.PRIMARY),lambda p:p['nativeIsolation'].update(extra=True)]:
   model,plan=self.fixture();change(plan)
   with tempfile.TemporaryDirectory() as directory:
    with self.assertRaises(AssertionError):m.prepare(ROOT,plan,pathlib.Path(directory),model)
    self.assertEqual(list(pathlib.Path(directory).iterdir()),[])
 def test_unfrozen_source_refused_before_private_write(self):
  model,plan=self.fixture();plan['files'][0]['sha256']='0'*64
  with tempfile.TemporaryDirectory() as directory:
   with self.assertRaisesRegex(AssertionError,'Unfrozen'):m.prepare(ROOT,plan,pathlib.Path(directory),model)
   self.assertEqual(list(pathlib.Path(directory).iterdir()),[])
 def test_capacity_preserves_primary_and_adds_secondary_peak(self):
  normal={'services':{}};self.assertEqual(m.capacity_floor(normal),(18*m.GIB,20*m.GIB));normal['services']['zammad-isolation-railsserver']={};memory,disk=m.capacity_floor(normal);self.assertGreaterEqual(memory,24*m.GIB);self.assertGreaterEqual(disk,28*m.GIB)
 def test_child_failure_never_exposes_secrets(self):
  secret='synthetic-private-sentinel'
  with mock.patch.object(m.subprocess,'run',return_value=type('Result',(),{'returncode':1,'stdout':secret,'stderr':secret})()):
   with self.assertRaises(AssertionError) as raised:m.private_run(['owned'])
  self.assertNotIn(secret,str(raised.exception))
 def test_incomplete_isolation_receipt_cannot_fall_back(self):
  with tempfile.TemporaryDirectory() as directory:
   target=pathlib.Path(directory)
   with self.assertRaisesRegex(AssertionError,'Incomplete'):m.load_preparation(target,{'nativeIsolation':{'status':'PREPARED_NATIVE_ONLY'}},target/'parent',target/'model')
   self.assertEqual(m.load_preparation(target,{},target/'parent',target/'model'),({},target/'model'))
 def test_ready_derivative_preserves_full_parent_and_rejects_tampering(self):
  with tempfile.TemporaryDirectory() as directory:
   target=pathlib.Path(directory);private=target/'native-isolation-private.json';m.write_private(private,{'synthetic':'private'});asset={'path':str(private),'sha256':m.digest(private.read_bytes()),'mode':private.stat().st_mode,'uid':private.stat().st_uid}
   parent={'project':'wasalx-simulation-unit','modelSha256':'a'*64,'planSha256':'b'*64,'selectedModel':{'path':str(target/'model'),'sha256':'a'*64},'images':{'one':'sha256:'+'c'*64},'generatedImmutableFiles':[asset],'nativeIsolation':{'namespace':'unit','private':asset}}
   parent_path=target/'preparation-with-owner.json';m.write_private(parent_path,parent);proof={'project':parent['project'],'namespace':'unit','modelSha256':parent['modelSha256'],'status':'READY_NATIVE_ONLY'};m.write_private(target/'native-isolation-ready.json',proof)
   value=copy.deepcopy(parent);value['nativeIsolation'].update(status='READY_NATIVE_ONLY',proof={'path':str(target/'native-isolation-ready.json'),'sha256':m.digest((target/'native-isolation-ready.json').read_bytes())});value['nativeIsolationParent']={'path':str(parent_path),'sha256':m.digest(parent_path.read_bytes())};selected=target/'preparation-with-native-isolation.json';m.write_private(selected,value)
   self.assertEqual(m.load_preparation(target,parent,parent_path,target/'model')[0],value)
   for mutate in [lambda v:v['generatedImmutableFiles'].clear(),lambda v:v.update(modelSha256='d'*64),lambda v:v['nativeIsolation']['proof'].update(sha256='e'*64),lambda v:v['nativeIsolationParent'].update(sha256='f'*64)]:
    bad=copy.deepcopy(value);mutate(bad);selected.write_text(json.dumps(bad))
    with self.assertRaises(AssertionError):m.load_preparation(target,parent,parent_path,target/'model')
if __name__=='__main__':unittest.main()
