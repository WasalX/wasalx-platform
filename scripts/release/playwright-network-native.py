"""Invocation-owned loopback namespace for the existing finite native runner.

The caller supplies its existing guard and stop_owned, installs signal handlers,
and admits effects before entry. This is a context manager, not a dispatcher.
"""
import contextlib,hashlib,json,os,pathlib,re,socket,subprocess,sys,time

def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def identity(pid):
 return {'pid':pid,'start':pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[19],'networkNamespace':os.readlink('/proc/'+str(pid)+'/ns/net')}
def write(path,value):
 with pathlib.Path(path).open('x') as out:
  os.chmod(path,0o600);json.dump(value,out,sort_keys=True);out.write('\n');out.flush();os.fsync(out.fileno())
def port(namespace,origins):
 assert re.fullmatch('[A-Za-z0-9-]{1,40}',namespace)
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));value=probe.getsockname()[1]
 assert value not in origins.values();return {'namespace':namespace,'port':value}
def profile(project,origins,networks,native=None):
 assert set(origins)=={'portal','keycloak','zammad-nginx'} and len(set(origins.values()))==3
 assert all(type(p) is int and 1024<=p<=65535 for p in origins.values())
 assert set(networks)=={'edge','postgres'}
 for role,row in networks.items():
  assert row['Driver']=='bridge' and row['Labels']['com.docker.compose.project']==project
  assert row['Internal'] is (role=='postgres') and re.fullmatch('[a-f0-9]{64}',row['Id'])
 if native:assert native['port'] not in origins.values() and 1024<=native['port']<=65535 and re.fullmatch('[A-Za-z0-9-]{1,40}',native['namespace'])
 return {'project':project,'origins':origins,'networks':{k:{'name':v['Name'],'id':v['Id'],'internal':v['Internal']} for k,v in networks.items()},'nativeIsolation':native}

def cleanup_owned(intent_path,invocation,project,parent,image_id,log=None):
 """Also used by the finite unit's hash-bound ExecStopPost after SIGKILL."""
 path=pathlib.Path(intent_path)
 assert path.resolve()==path and not path.is_symlink() and path.stat().st_mode&0o077==0 and path.stat().st_uid==os.getuid()
 intent=json.loads(path.read_text());names={'anchor':'wasalx-netanchor-'+invocation,'runner':'wasalx-qualrunner-'+invocation}
 assert intent=={'project':project,'invocation':invocation,'cgroupParent':parent,'imageId':image_id,'names':names,'socketRoot':'/srv/wasalx-fast/tmp/nw-'+invocation[:12]}
 read=lambda a:subprocess.check_output(['docker',*a],text=True,timeout=30)
 for key in ('runner','anchor'):
  ids=read(['ps','-aq','--no-trunc','--filter','name=^/'+names[key]+'$']).split()
  if ids:
   assert len(ids)==1;row=json.loads(read(['inspect',ids[0]]))[0]
   assert row['Name']=='/'+names[key] and row['Image']==image_id and row['HostConfig']['CgroupParent']==parent
   assert row['Config']['Labels'].get('io.wasalx.qualification.project')==project and row['Config']['Labels'].get('io.wasalx.qualification.invocation')==invocation
   subprocess.run(['docker','rm','-f',row['Id']],check=True,stdout=log if log is not None else subprocess.DEVNULL,stderr=log,timeout=30)
  assert not read(['ps','-aq','--filter','name=^/'+names[key]+'$']).strip()
 sockets=pathlib.Path(intent['socketRoot'])
 if sockets.exists():
  assert sockets.resolve()==sockets and not sockets.is_symlink() and sockets.stat().st_mode&0o077==0 and sockets.stat().st_uid==os.getuid()
  for p in sockets.iterdir():assert p.name in ('0.sock','1.sock','2.sock','3.sock') and p.is_socket() and not p.is_symlink();p.unlink()
  sockets.rmdir()
 return {'ownedRunnerAbsent':True,'ownedAnchorAbsent':True,'ownedSocketsAbsent':True}

@contextlib.contextmanager
def owned_network(c,guard,stop_owned):
 """Config: privateRoot, project, unit, cgroupParent, imageReference,
 modelPath/modelSha256, outputName; optional nativeIsolationNamespace.
 Yield environment for a NEW runner preflight and run in this same invocation.
 Creation provenance and previously consumed runner receipts remain untouched.
 """
 if sys.flags.optimize:raise RuntimeError('Safety assertions required')
 assert sys.platform=='linux'
 assert not os.environ.get('DOCKER_CONTEXT') and os.environ.get('DOCKER_HOST','unix:///var/run/docker.sock')=='unix:///var/run/docker.sock'
 inv=os.environ['INVOCATION_ID'];assert re.fullmatch('[a-f0-9]{32}',inv)
 private=pathlib.Path(c['privateRoot']);project=c['project'];unit=c['unit'];parent=c['cgroupParent']
 assert private.resolve()==private and not private.is_symlink() and private.is_dir() and private.name==project
 assert str(private).startswith('/srv/wasalx-fast/wasalx-simulation-') and private.stat().st_mode&0o077==0
 assert re.fullmatch(r'[A-Za-z0-9_.@-]+-maintenance\.service',unit)
 assert pathlib.Path('/proc/self/cgroup').read_text().strip()=='0::/system.slice/'+unit
 assert re.fullmatch(r'[A-Za-z0-9_.@-]+\.slice',parent) and parent not in ('system.slice','user.slice','machine.slice')
 assert re.fullmatch('[a-z0-9./_-]+@sha256:[a-f0-9]{64}',c['imageReference'])
 model_path=pathlib.Path(c['modelPath']);assert model_path.resolve()==model_path and model_path.is_relative_to(private) and not model_path.is_symlink() and sha(model_path)==c['modelSha256']
 model=json.loads(model_path.read_text());assert model['name']==project
 assert pathlib.Path(c['outputName']).name==c['outputName'];out=private/c['outputName']
 assert not out.exists() and not out.is_symlink()
 def read(args):guard();result=subprocess.check_output(['docker',*args],text=True,timeout=30);guard();return result
 def inspect(args):return json.loads(read(args))[0]
 containers={}
 for service in ('portal','keycloak','zammad-nginx','postgres','control-api'):
  ids=read(['ps','-q','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+service]).split();assert len(ids)==1
  row=inspect(['inspect',ids[0]]);assert row['State']['Status']=='running' and row['State'].get('Health',{}).get('Status','healthy')=='healthy'
  assert row['Image']==inspect(['image','inspect',model['services'][service]['image']])['Id'] and row['HostConfig']['CgroupParent']==parent
  containers[service]=row
 edge=model['networks']['edge'].get('name') or project+'_edge'
 pg=list(containers['postgres']['NetworkSettings']['Networks']);assert len(pg)==1
 networks={'edge':inspect(['network','inspect',edge]),'postgres':inspect(['network','inspect',pg[0]])}
 origins={}
 for service in ('portal','keycloak','zammad-nginx'):
  published=model['services'][service]['ports'];assert len(published)==1 and published[0]['host_ip']=='127.0.0.1'
  p=int(published[0]['published']);assert containers[service]['NetworkSettings']['Ports'][str(published[0]['target'])+'/tcp']==[{'HostIp':'127.0.0.1','HostPort':str(p)}]
  origins[service]=p
 native=port(c['nativeIsolationNamespace'],origins) if c.get('nativeIsolationNamespace') else None
 selected=profile(project,origins,networks,native)
 image=inspect(['image','inspect',c['imageReference']]);assert c['imageReference'] in image['RepoDigests'] and image['Os']=='linux' and image['Architecture']=='amd64'
 names={'anchor':'wasalx-netanchor-'+inv,'runner':'wasalx-qualrunner-'+inv}
 for name in names.values():assert not read(['ps','-aq','--filter','name=^/'+name+'$']).strip()
 sockets=pathlib.Path('/srv/wasalx-fast/tmp')/('nw-'+inv[:12]);assert not sockets.exists() and not sockets.is_symlink()
 guard();out.mkdir(mode=0o700);processes=[];anchor_id=None;child=None
 completion={'kind':'owned-network-lifecycle','invocation':inv,'project':project,'status':'FAILED','readbackRequired':True}
 log=(out/'private.log').open('x');os.chmod(out/'private.log',0o600)
 def command(args):
  nonlocal child
  child=subprocess.Popen(['docker',*args],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  deadline=time.monotonic()+60
  while child.poll() is None:guard();assert time.monotonic()<deadline,'Owned Docker command exceeded bound';time.sleep(1)
  code=child.returncode;child=None;guard();assert code==0,'Owned Docker command failed; private diagnostics retained'
 def exact(row,name):
  assert row['Name']=='/'+name and row['Image']==image['Id'] and row['HostConfig']['CgroupParent']==parent
  assert row['Config']['Labels'].get('io.wasalx.qualification.project')==project and row['Config']['Labels'].get('io.wasalx.qualification.invocation')==inv
 try:
  write(out/'intent.json',{'project':project,'invocation':inv,'cgroupParent':parent,'imageId':image['Id'],'names':names,'socketRoot':str(sockets)})
  sockets.mkdir(mode=0o700)
  common=['--cgroup-parent',parent,'--label','io.wasalx.qualification.project='+project,'--label','io.wasalx.qualification.invocation='+inv]
  command(['create','--name',names['anchor'],*common,'--network',edge,'--pull','never','--read-only','--tmpfs','/tmp','--memory','128m','--cpus','0.1','--entrypoint','node',c['imageReference'],'-e','setInterval(()=>{},1000)'])
  anchor=inspect(['inspect',names['anchor']]);exact(anchor,names['anchor']);anchor_id=anchor['Id']
  command(['network','connect',pg[0],anchor_id]);command(['start',anchor_id]);anchor=inspect(['inspect',anchor_id]);exact(anchor,names['anchor'])
  ns=identity(anchor['State']['Pid']);assert ns['networkNamespace']!=os.readlink('/proc/self/ns/net')
  pairs=[]
  for index,p in enumerate([*origins.values(),*([native['port']] if native else [])]):
   sock=sockets/(str(index)+'.sock')
   host=subprocess.Popen(['socat','UNIX-LISTEN:'+str(sock)+',mode=0600,fork','TCP4:127.0.0.1:'+str(p)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True);processes.append(host)
   until=time.monotonic()+5
   while not sock.exists():guard();assert host.poll() is None and time.monotonic()<until;time.sleep(.1)
   assert identity(ns['pid'])==ns
   inside=subprocess.Popen(['nsenter','--target',str(ns['pid']),'--net','socat','TCP4-LISTEN:'+str(p)+',bind=127.0.0.1,reuseaddr,fork','UNIX-CONNECT:'+str(sock)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True);processes.append(inside)
   until=time.monotonic()+5
   while identity(inside.pid)['networkNamespace']!=ns['networkNamespace']:
    guard();assert inside.poll() is None and time.monotonic()<until,'Namespace forwarder did not enter owned namespace';time.sleep(.1)
   pairs.append({'port':p,'socket':str(sock),'host':identity(host.pid),'inside':identity(inside.pid)})
  time.sleep(.3);guard();assert all(p.poll() is None for p in processes)
  receipt={'kind':'owned-loopback-network','privateRoot':str(private),'project':project,'invocation':inv,'unit':unit,'cgroupParent':parent,'socketRoot':str(sockets),'profile':selected,'profileSha256':hashlib.sha256(json.dumps(selected,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'anchor':{'id':anchor_id,'name':names['anchor'],'imageId':image['Id'],**ns},'forwarders':pairs}
  target=out/'network.json';write(target,receipt)
  env={'WASALX_QUALIFICATION_NETWORK_RECEIPT':str(target),'WASALX_QUALIFICATION_NETWORK_RECEIPT_SHA256':sha(target),'WASALX_QUALIFICATION_RUNNER_NAME':names['runner'],'WASALX_QUALIFICATION_RUNNER_PROJECT':project,'WASALX_QUALIFICATION_RUNNER_INVOCATION':inv,'WASALX_QUALIFICATION_RUNNER_CGROUP':parent}
  completion['networkReceiptSha256']=sha(target)
  yield env
  guard();assert identity(ns['pid'])==ns and all(p.poll() is None for p in processes);completion['status']='COMPLETED'
 finally:
  errors=[]
  for process in ([child] if child else [])+processes:
   try:stop_owned(process)
   except BaseException as e:errors.append(type(e).__name__)
  try:completion['cleanup']=cleanup_owned(out/'intent.json',inv,project,parent,image['Id'],log)
  except BaseException as e:errors.append(type(e).__name__)
  completion.update(cleanupErrors=errors,readbackRequired=bool(errors),finishedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
  if errors:completion['status']='FAILED_OWNED_CLEANUP'
  write(out/'completion.json',completion);log.close()
  if errors:raise RuntimeError('Owned network cleanup requires readback')

if __name__=='__main__':
 if sys.flags.optimize:raise RuntimeError('Safety assertions required')
 assert sys.platform=='linux' and len(sys.argv)==4 and sys.argv[1]=='cleanup'
 config=pathlib.Path(sys.argv[2]);assert config.resolve()==config and not config.is_symlink() and sha(config)==sys.argv[3]
 c=json.loads(config.read_text());inv=os.environ['INVOCATION_ID'];assert re.fullmatch('[a-f0-9]{32}',inv)
 assert pathlib.Path('/proc/self/cgroup').read_text().strip()=='0::/system.slice/'+c['unit']
 private=pathlib.Path(c['privateRoot']);assert private.name==c['project'] and private.resolve()==private and str(private).startswith('/srv/wasalx-fast/wasalx-simulation-')
 assert pathlib.Path(c['outputName']).name==c['outputName']
 image=json.loads(subprocess.check_output(['docker','image','inspect',c['imageReference']],text=True,timeout=30))[0];assert c['imageReference'] in image['RepoDigests']
 intent=private/c['outputName']/'intent.json'
 # An entrypoint that failed before durable intent had no namespace effects.
 proof=cleanup_owned(intent,inv,c['project'],c['cgroupParent'],image['Id']) if intent.exists() else {'noIntentNoNamespaceAction':True}
 print(json.dumps(proof))
