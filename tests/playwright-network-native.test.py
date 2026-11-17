import hashlib,importlib.util,json,pathlib,tempfile,unittest
from unittest import mock
P=pathlib.Path(__file__).resolve().parents[1]/'scripts/release'
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,P/path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
native=load('native','playwright-network-native.py');runner=load('runner','playwright-runner.py')
class Network(unittest.TestCase):
 def test_actual_metadata_profile_matches_runner_for_three_and_four_ports(self):
  project='wasalx-simulation-fixture';inv='a'*32;origins={'portal':3100,'keycloak':8100,'zammad-nginx':8200}
  networks={role:{'Name':'fixture-'+role,'Id':char*64,'Internal':role=='postgres','Driver':'bridge','Labels':{'com.docker.compose.project':project}} for role,char in [('edge','d'),('postgres','e')]}
  for fourth in [None,{'namespace':'isolation-one','port':8300}]:
   value=native.profile(project,origins,networks,fourth)
   receipt={'kind':'owned-loopback-network','project':project,'invocation':inv,'cgroupParent':'owned.slice','socketRoot':'/srv/wasalx-fast/tmp/nw-'+inv[:12],'profile':value,'profileSha256':hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'anchor':{'id':'b'*64,'name':'wasalx-netanchor-'+inv,'imageId':'image'},'forwarders':[{'port':p} for p in [*origins.values(),*([fourth['port']] if fourth else [])]]}
   self.assertEqual(runner.validate_network_receipt(receipt,'image',project,inv,'owned.slice'),value)
  with self.assertRaises(AssertionError):native.profile(project,origins,{**networks,'postgres':{**networks['postgres'],'Internal':False}})
 def intent(self,path):
  value={'project':'project','invocation':'a'*32,'cgroupParent':'owned.slice','imageId':'image','names':{'anchor':'wasalx-netanchor-'+'a'*32,'runner':'wasalx-qualrunner-'+'a'*32},'socketRoot':'/srv/wasalx-fast/tmp/nw-'+'a'*12}
  native.write(path,value);return value
 def test_cleanup_identity_mismatch_never_removes_container(self):
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'intent.json';value=self.intent(path)
   row={'Name':'/'+value['names']['runner'],'Image':'foreign','HostConfig':{'CgroupParent':'owned.slice'}}
   with mock.patch.object(native.os,'getuid',return_value=0,create=True),mock.patch.object(native.pathlib.Path,'stat',return_value=mock.Mock(st_mode=0o100600,st_uid=0)),mock.patch.object(native.subprocess,'check_output',side_effect=['b'*64,json.dumps([row])]) as read,mock.patch.object(native.subprocess,'run') as remove:
    with self.assertRaises(AssertionError):native.cleanup_owned(path,'a'*32,'project','owned.slice','image')
    remove.assert_not_called();self.assertEqual(read.call_count,2)
 def test_cleanup_absence_uses_readback_not_heavy_guard(self):
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'intent.json';self.intent(path)
   with mock.patch.object(native.os,'getuid',return_value=0,create=True),mock.patch.object(native.pathlib.Path,'stat',return_value=mock.Mock(st_mode=0o100600,st_uid=0)),mock.patch.object(native.pathlib.Path,'exists',return_value=False),mock.patch.object(native.subprocess,'check_output',return_value='') as read,mock.patch.object(native.subprocess,'run') as remove:
    proof=native.cleanup_owned(path,'a'*32,'project','owned.slice','image');remove.assert_not_called();self.assertEqual(read.call_count,4)
    self.assertTrue(proof['ownedAnchorAbsent'] and proof['ownedRunnerAbsent'])
 def test_successful_cli_cleanup_keeps_stdout_json_only_and_preserves_private_log(self):
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'intent.json';value=self.intent(path)
   row={'Id':'b'*64,'Name':'/'+value['names']['runner'],'Image':'image','HostConfig':{'CgroupParent':'owned.slice'},'Config':{'Labels':{'io.wasalx.qualification.project':'project','io.wasalx.qualification.invocation':'a'*32}}}
   for private_log in (None,mock.Mock()):
    with self.subTest(private_log=private_log is not None),mock.patch.object(native.os,'getuid',return_value=0,create=True),mock.patch.object(native.pathlib.Path,'stat',return_value=mock.Mock(st_mode=0o100600,st_uid=0)),mock.patch.object(native.pathlib.Path,'exists',return_value=False),mock.patch.object(native.subprocess,'check_output',side_effect=['b'*64,json.dumps([row]),'','','']),mock.patch.object(native.subprocess,'run') as remove:
     proof=native.cleanup_owned(path,'a'*32,'project','owned.slice','image',private_log)
     self.assertTrue(proof['ownedRunnerAbsent']);remove.assert_called_once()
     self.assertIs(remove.call_args.kwargs['stdout'],private_log if private_log is not None else native.subprocess.DEVNULL)
     self.assertIs(remove.call_args.kwargs['stderr'],private_log)

if __name__=='__main__':unittest.main()
