import importlib.util,json,pathlib,tempfile,unittest,subprocess,shutil,os
from unittest import mock
P=pathlib.Path(__file__).resolve().parents[1]/'scripts/release/playwright-runner.py'
spec=importlib.util.spec_from_file_location('runner',P);runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class Runner(unittest.TestCase):
 def test_readonly_mount_is_explicit(self):
  self.assertEqual(runner.mount('/evidence','/evidence',True),'type=bind,src=/evidence,dst=/evidence,readonly')
 def test_worktree_git_common_directory_is_mounted(self):
  with tempfile.TemporaryDirectory() as tmp:
   base=pathlib.Path(tmp);root=base/'worktree';common=base/'repo'/'.git';gitdir=common/'worktrees'/'candidate'
   root.mkdir();gitdir.mkdir(parents=True);(root/'.git').write_text('gitdir: '+str(gitdir));(gitdir/'commondir').write_text('../..')
   self.assertEqual(runner.git_common_dir(root),common.resolve())
 def test_preflight_checks_browser_docker_and_compose(self):
  with mock.patch.object(runner,'runtime',return_value=(['docker','run','image'],{'imageReference':'image'})),mock.patch.object(runner.subprocess,'run') as run:
   run.side_effect=[mock.Mock(stdout='{"gitHead":"a","gitTree":"b","gitObjectClosureSha256":"c"}\n'),mock.Mock(stdout='{"playwright":"1.62.1"}\n')];result=runner.preflight('/srv/wasalx-fast/candidate','image','1.62.1')
  git_command,browser_command=[call.args[0] for call in run.call_args_list];git_script=git_command[git_command.index('-e')+1];browser_script=browser_command[browser_command.index('-e')+1]
  self.assertIn("'rev-list','--objects','--no-object-names','HEAD^{tree}'",git_script);self.assertIn("'cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'",git_script);self.assertIn("'cat-file','--batch'",git_script);self.assertIn("for await(const chunk of cat.stdout)hash.update(chunk)",git_script)
  self.assertIn("launchPersistentContext",browser_script);self.assertIn("channel:'chromium'",browser_script);self.assertIn("['compose','-f','-','config']",browser_script);self.assertEqual(result['playwright'],'1.62.1');self.assertEqual(result['gitObjectClosureSha256'],'c')
 def test_run_preserves_exit_code(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir'];identity={**dict.fromkeys(keys,'same'),'gitHead':'a','gitTree':'b','gitObjectClosureSha256':'c'}
  with tempfile.TemporaryDirectory() as private:
   receipt=pathlib.Path(private)/'preparation.json';receipt.write_text(json.dumps({'testRunner':identity}))
   with mock.patch.object(runner.sys,'argv',['runner','run','/root',private,'image',str(receipt),'--','node','script']),mock.patch.object(runner,'runtime',return_value=(['container'],identity)) as runtime,mock.patch.object(runner,'git_probe',return_value={'gitHead':'a','gitTree':'b','gitObjectClosureSha256':'c'}),mock.patch.object(runner.subprocess,'run',return_value=mock.Mock(returncode=7)):
    with self.assertRaises(SystemExit) as stopped:runner.main()
  runtime.assert_called_once_with('/root','image',pathlib.Path(private).resolve());self.assertEqual(stopped.exception.code,7)
 def test_changed_tools_never_execute(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir'];expected=dict.fromkeys(keys,'same')
  for key in ['executionRoot','gitCommonDir','dockerSha256','composePluginSha256']:
   with self.subTest(key=key),tempfile.TemporaryDirectory() as private:
    receipt=pathlib.Path(private)/'preparation.json';receipt.write_text(json.dumps(expected))
    current={**expected,key:'changed'}
    with mock.patch.object(runner.sys,'argv',['runner','run','/root',private,'image',str(receipt),'--','node','script']),mock.patch.object(runner,'runtime',return_value=(['container'],current)),mock.patch.object(runner.subprocess,'run') as run:
     with self.assertRaisesRegex(AssertionError,key):runner.main()
     run.assert_not_called()
 def test_run_passes_explicit_evidence_snapshot_to_runtime(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir'];identity={**dict.fromkeys(keys,'same'),'gitHead':'a','gitTree':'b','gitObjectClosureSha256':'c'}
  with tempfile.TemporaryDirectory() as private:
   receipt=pathlib.Path(private)/'preparation.json';receipt.write_text(json.dumps(identity));evidence='/srv/wasalx-fast/wasalx-evidence-fixture'
   with mock.patch.object(runner.sys,'argv',['runner','run','/root',private,'image',str(receipt),evidence,'--','node','script']),mock.patch.object(runner,'runtime',return_value=(['container'],identity)) as runtime,mock.patch.object(runner,'git_probe',return_value={'gitHead':'a','gitTree':'b','gitObjectClosureSha256':'c'}),mock.patch.object(runner.subprocess,'run',return_value=mock.Mock(returncode=0)):
    with self.assertRaises(SystemExit) as stopped:runner.main()
  runtime.assert_called_once_with('/root','image',pathlib.Path(private).resolve(),evidence);self.assertEqual(stopped.exception.code,0)
 def test_run_rejects_changed_or_incomplete_git_object_closure_before_scenario(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir'];identity={**dict.fromkeys(keys,'same'),'gitHead':'a','gitTree':'b','gitObjectClosureSha256':'c'}
  with tempfile.TemporaryDirectory() as private:
   receipt=pathlib.Path(private)/'preparation.json';receipt.write_text(json.dumps(identity))
   with mock.patch.object(runner.sys,'argv',['runner','run','/root',private,'image',str(receipt),'--','node','script']),mock.patch.object(runner,'runtime',return_value=(['container'],identity)),mock.patch.object(runner,'git_probe',return_value={**identity,'gitObjectClosureSha256':'changed'}),mock.patch.object(runner.subprocess,'run') as run:
    with self.assertRaisesRegex(AssertionError,'gitObjectClosureSha256'):runner.main()
    run.assert_not_called()
 def test_distinct_standalone_checkout_receipt_cannot_run(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir']
  expected={**dict.fromkeys(keys,'same'),'executionRoot':'/srv/wasalx-fast/tool','gitCommonDir':None}
  current={**expected,'executionRoot':'/srv/wasalx-fast/app'}
  with tempfile.TemporaryDirectory() as private:
   receipt=pathlib.Path(private)/'preparation.json';receipt.write_text(json.dumps(expected))
   with mock.patch.object(runner.sys,'argv',['runner','run',current['executionRoot'],private,'image',str(receipt),'--','node','script']),mock.patch.object(runner,'runtime',return_value=(['container'],current)),mock.patch.object(runner.subprocess,'run') as run:
    with self.assertRaisesRegex(AssertionError,'executionRoot'):runner.main()
    run.assert_not_called()
 def test_unconfigured_ownership_preserves_command(self):
  with mock.patch.dict(runner.os.environ,{},clear=True):
   args=['docker','run','--rm','image']
   self.assertIs(runner.owned_args(args,pathlib.Path('/private')),args)
 def test_owned_runner_is_namespace_and_invocation_bound(self):
  invocation='a'*32;project='wasalx-simulation-generic-fixture'
  env={'INVOCATION_ID':invocation,'WASALX_QUALIFICATION_RUNNER_NAME':'wasalx-qualrunner-'+invocation,'WASALX_QUALIFICATION_RUNNER_PROJECT':project,'WASALX_QUALIFICATION_RUNNER_INVOCATION':invocation,'WASALX_QUALIFICATION_RUNNER_CGROUP':'wasalxtest.slice'}
  with mock.patch.dict(runner.os.environ,env,clear=True):
   args=runner.owned_args(['docker','run','--rm','image'],pathlib.Path('/srv/wasalx-fast')/project)
  self.assertIn('wasalxtest.slice',args);self.assertIn('io.wasalx.qualification.project='+project,args);self.assertIn('io.wasalx.qualification.invocation='+invocation,args)
  for key in ('WASALX_QUALIFICATION_RUNNER_PROJECT','WASALX_QUALIFICATION_RUNNER_INVOCATION','WASALX_QUALIFICATION_RUNNER_NAME','WASALX_QUALIFICATION_RUNNER_CGROUP'):
   with self.subTest(key=key),mock.patch.dict(runner.os.environ,{**env,key:'wrong'},clear=True):
    with self.assertRaises(AssertionError):runner.owned_args(['docker','run','--rm','image'],pathlib.Path('/srv/wasalx-fast')/project)
 def test_partial_ownership_never_executes(self):
  with mock.patch.dict(runner.os.environ,{'WASALX_QUALIFICATION_RUNNER_NAME':'partial'},clear=True):
   with self.assertRaisesRegex(AssertionError,'Incomplete'):runner.owned_args(['docker','run','image'],pathlib.Path('/private'))


 def test_missing_dependency_stops_preflight_before_browser(self):
  with mock.patch.object(runner,'runtime',return_value=(['container'],{})),mock.patch.object(runner.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['node'])) as run:
   with self.assertRaises(subprocess.CalledProcessError):runner.preflight('/candidate','image','1.62.1')
   self.assertEqual(run.call_count,1)
 def test_missing_dependency_stops_run_before_scenario(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir'];identity=dict.fromkeys(keys,'same')
  with tempfile.TemporaryDirectory() as private:
   receipt=pathlib.Path(private)/'preparation.json';receipt.write_text(json.dumps(identity))
   with mock.patch.object(runner.sys,'argv',['runner','run','/candidate',private,'image',str(receipt),'--','node','scenario']),mock.patch.object(runner,'runtime',return_value=(['container'],identity)),mock.patch.object(runner,'git_probe',side_effect=subprocess.CalledProcessError(1,['node'])),mock.patch.object(runner.subprocess,'run') as run:
    with self.assertRaises(subprocess.CalledProcessError):runner.main()
    run.assert_not_called()
 def test_actual_import_closure_is_transitive_and_candidate_contained(self):
  node=shutil.which('node')
  if not node:self.skipTest('Native Node required for actual import fixture')
  with mock.patch.object(runner.subprocess,'run',return_value=mock.Mock(stdout='{}')) as run:
   runner.git_probe(['node'],'/candidate')
  args=run.call_args.args[0];script=args[args.index('-e')+1];probe=script[:script.index('\nconst head=')]+"\nconsole.log('IMPORT_CLOSURE_PASS');"
  required=['pg','ioredis','@playwright/test','typescript','yaml']
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp)/'candidate';root.mkdir();(root/'package.json').write_text('{}')
   for name in required:
    package=root/'node_modules'/name;package.mkdir(parents=True);(package/'package.json').write_text(json.dumps({'name':name,'main':'index.cjs'}));(package/'index.cjs').write_text('module.exports={}');
   # This synthetic candidate must not inherit workstation Node preload hooks.
   env=dict(os.environ);env.pop('NODE_PATH',None);env['NODE_OPTIONS']=''
   command=[node,'--input-type=module','-e',probe,str(root)]
   passed=subprocess.run(command,capture_output=True,text=True,env=env);self.assertEqual(passed.returncode,0,passed.stderr);self.assertIn('IMPORT_CLOSURE_PASS',passed.stdout)
   redis=root/'node_modules/ioredis/index.cjs';redis.write_text("require('wasalx-missing-transitive-fixture')")
   failed=subprocess.run(command,capture_output=True,text=True,env=env);self.assertNotEqual(failed.returncode,0);self.assertNotIn('IMPORT_CLOSURE_PASS',failed.stdout)
   redis.write_text('module.exports={}')
   outside=pathlib.Path(temp)/'outside.cjs';outside.write_text('module.exports={}')
   (root/'node_modules/pg/package.json').write_text(json.dumps({'name':'pg','main':str(outside)}))
   escaped=subprocess.run(command,capture_output=True,text=True,env=env);self.assertNotEqual(escaped.returncode,0);self.assertIn('Qualification dependency escapes candidate: pg',escaped.stderr)
   (root/'node_modules/pg/package.json').write_text(json.dumps({'name':'pg','main':'index.cjs'}))
   redis.write_text('require('+json.dumps(str(outside))+')')
   escaped_transitive=subprocess.run(command,capture_output=True,text=True,env=env);self.assertNotEqual(escaped_transitive.returncode,0);self.assertIn('Qualification dependency closure escapes candidate',escaped_transitive.stderr)


 def test_owned_network_profile_requires_complete_fixed_and_native_forwarding(self):
  import hashlib
  profile={'project':'wasalx-simulation-fixture','origins':{'portal':3100,'keycloak':8100,'zammad-nginx':8200},'networks':{'edge':{'name':'fixture-edge','id':'d'*64,'internal':False},'postgres':{'name':'fixture-core','id':'e'*64,'internal':True}},'nativeIsolation':{'port':8300,'namespace':'isolated-one'}}
  receipt={'kind':'owned-loopback-network','project':profile['project'],'invocation':'a'*32,'cgroupParent':'owned.slice','socketRoot':'/srv/wasalx-fast/tmp/nw-'+'a'*12,'profile':profile,'profileSha256':hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'anchor':{'id':'b'*64,'imageId':'image','name':'wasalx-netanchor-'+'a'*32},'forwarders':[{'port':p} for p in [3100,8100,8200,8300]]}
  self.assertEqual(runner.validate_network_receipt(receipt,'image',profile['project'],'a'*32,'owned.slice'),profile)
  for key,value in [('invocation','c'*32),('project','foreign'),('cgroupParent','foreign.slice'),('profileSha256','0'*64),('socketRoot','/wrong/root')]:
   with self.subTest(key=key),self.assertRaises(AssertionError):runner.validate_network_receipt({**receipt,key:value},'image',profile['project'],'a'*32,'owned.slice')
  with self.assertRaisesRegex(AssertionError,'Incomplete loopback'):runner.validate_network_receipt({**receipt,'forwarders':receipt['forwarders'][:-1]},'image',profile['project'],'a'*32,'owned.slice')
 def test_unconfigured_network_retains_host_startup_compatibility(self):
  with mock.patch.dict(runner.os.environ,{},clear=True):self.assertEqual(runner.network_binding('image'),('host',None))
 def test_partial_network_profile_rejected_before_docker(self):
  with mock.patch.dict(runner.os.environ,{'WASALX_QUALIFICATION_NETWORK_RECEIPT':'/private/network.json'},clear=True),mock.patch.object(runner.subprocess,'check_output') as docker:
   with self.assertRaisesRegex(AssertionError,'Incomplete owned network'):runner.network_binding('image')
   docker.assert_not_called()
 def test_changed_network_profile_never_runs_scenario(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir'];identity=dict.fromkeys(keys,'same')
  with tempfile.TemporaryDirectory() as private:
   path=pathlib.Path(private)/'preparation.json';path.write_text(json.dumps(identity))
   with mock.patch.object(runner.sys,'argv',['runner','run','/root',private,'image',str(path),'--','node','scenario']),mock.patch.object(runner,'runtime',return_value=(['container'],{**identity,'network':{'mode':'owned-loopback','profileSha256':'new','privateRoot':private}})),mock.patch.object(runner.subprocess,'run') as run:
    with self.assertRaisesRegex(AssertionError,'network profile changed'):runner.main()
    run.assert_not_called()

 def test_stale_isolated_preflight_never_runs_in_successor_invocation(self):
  keys=['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir']
  network={'mode':'owned-loopback','profileSha256':'same-profile','privateRoot':'same-private','invocation':'a'*32,'anchorId':'b'*64,'networkReceiptSha256':'c'*64}
  expected={**dict.fromkeys(keys,'same'),'network':network}
  with tempfile.TemporaryDirectory() as private:
   path=pathlib.Path(private)/'preparation.json';path.write_text(json.dumps(expected))
   for key,value in [('invocation','d'*32),('anchorId','e'*64),('networkReceiptSha256','f'*64)]:
    with self.subTest(key=key),mock.patch.object(runner.sys,'argv',['runner','run','/root',private,'image',str(path),'--','node','scenario']),mock.patch.object(runner,'runtime',return_value=(['container'],{**expected,'network':{**network,key:value}})),mock.patch.object(runner,'git_probe') as probe,mock.patch.object(runner.subprocess,'run') as run:
     with self.assertRaisesRegex(AssertionError,'network profile changed'):runner.main()
     probe.assert_not_called();run.assert_not_called()

if __name__=='__main__':unittest.main()
