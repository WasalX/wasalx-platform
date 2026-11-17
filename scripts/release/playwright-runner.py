"""Run trusted qualification scripts in a pinned Playwright container."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys

PLUGIN_CANDIDATES=(
 pathlib.Path('/usr/libexec/docker/cli-plugins/docker-compose'),
 pathlib.Path('/usr/local/lib/docker/cli-plugins/docker-compose'),
)

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def mount(source,target,readonly):return f'type=bind,src={source},dst={target}'+(',readonly' if readonly else '')

def git_common_dir(root):
 dot=root/'.git'
 if dot.is_dir():return None
 assert dot.is_file() and not dot.is_symlink(),'Candidate Git metadata missing'
 line=dot.read_text().strip();assert line.startswith('gitdir: '),'Invalid worktree Git pointer'
 gitdir=(root/line[8:]).resolve();assert gitdir.is_dir(),'Worktree Git directory missing'
 common=(gitdir/(gitdir/'commondir').read_text().strip()).resolve() if (gitdir/'commondir').is_file() else gitdir
 assert common.is_dir() and not common.is_relative_to(root),'Invalid external Git common directory'
 return common

def validate_network_receipt(value, image_id, project, invocation, parent):
 assert value['kind']=='owned-loopback-network' and value['project']==project and value['invocation']==invocation and value['cgroupParent']==parent
 profile=value['profile'];assert profile['project']==project
 encoded=json.dumps(profile,sort_keys=True,separators=(',',':')).encode()
 assert hashlib.sha256(encoded).hexdigest()==value['profileSha256'],'Network profile digest mismatch'
 anchor=value['anchor'];assert re.fullmatch('[a-f0-9]{64}',anchor['id']) and anchor['imageId']==image_id
 assert anchor['name']=='wasalx-netanchor-'+invocation
 assert set(profile['origins'])=={'portal','keycloak','zammad-nginx'}
 ports=list(profile['origins'].values());assert all(isinstance(p,int) and 1024<=p<=65535 for p in ports) and len(set(ports))==3
 isolation=profile.get('nativeIsolation')
 if isolation is not None:
  assert isinstance(isolation['port'],int) and 1024<=isolation['port']<=65535 and isolation['port'] not in ports
  assert re.fullmatch('[A-Za-z0-9-]{1,40}',isolation['namespace']);ports.append(isolation['port'])
 assert set(profile['networks'])=={'edge','postgres'}
 for role,network in profile['networks'].items():
  assert re.fullmatch('[a-f0-9]{64}',network['id']) and isinstance(network['name'],str) and network['name']
  assert network['internal'] is (role=='postgres')
 assert value['socketRoot']=='/srv/wasalx-fast/tmp/nw-'+invocation[:12]
 assert sorted(x['port'] for x in value['forwarders'])==sorted(ports),'Incomplete loopback forwarding'
 return profile

def network_binding(image_id):
 path=os.environ.get('WASALX_QUALIFICATION_NETWORK_RECEIPT','');expected=os.environ.get('WASALX_QUALIFICATION_NETWORK_RECEIPT_SHA256','')
 if not path and not expected:return 'host',None
 assert path and re.fullmatch('[a-f0-9]{64}',expected),'Incomplete owned network binding'
 ref=pathlib.Path(path);assert not ref.is_symlink() and ref.is_file() and ref.resolve()==ref
 assert ref.stat().st_mode&0o077==0 and ref.stat().st_uid==os.getuid() and digest(ref)==expected
 value=json.loads(ref.read_text());private=pathlib.Path(value['privateRoot']);assert private.name==value['project'] and str(private).startswith('/srv/wasalx-fast/wasalx-simulation-') and ref.is_relative_to(private)
 invocation=os.environ.get('WASALX_QUALIFICATION_RUNNER_INVOCATION');project=os.environ.get('WASALX_QUALIFICATION_RUNNER_PROJECT');parent=os.environ.get('WASALX_QUALIFICATION_RUNNER_CGROUP')
 assert re.fullmatch('[a-f0-9]{32}',invocation or '') and invocation==os.environ.get('INVOCATION_ID')
 assert project==value['project'] and re.fullmatch(r'[A-Za-z0-9_.@-]+\.slice',parent or '') and parent not in ('system.slice','user.slice','machine.slice')
 assert re.fullmatch(r'[A-Za-z0-9_.@-]+-maintenance\.service',value['unit']),'Finite native maintenance unit required'
 profile=validate_network_receipt(value,image_id,project,invocation,parent)
 anchor=value['anchor'];row=json.loads(subprocess.check_output(['docker','inspect',anchor['id']],text=True))[0]
 assert row['Id']==anchor['id'] and row['Name']=='/'+anchor['name'] and row['Image']==image_id and row['State']['Status']=='running' and row['State']['Pid']==anchor['pid']
 assert row['HostConfig']['CgroupParent']==parent and row['Config']['Labels'].get('io.wasalx.qualification.project')==project and row['Config']['Labels'].get('io.wasalx.qualification.invocation')==invocation
 def identity(pid):
  return {'start':pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[19],'namespace':os.readlink('/proc/'+str(pid)+'/ns/net')}
 actual=identity(anchor['pid']);assert actual=={'start':anchor['start'],'namespace':anchor['networkNamespace']} and actual['namespace']!=os.readlink('/proc/self/ns/net')
 assert set(row['NetworkSettings']['Networks'])=={x['name'] for x in profile['networks'].values()}
 for net in profile['networks'].values():
  network=json.loads(subprocess.check_output(['docker','network','inspect',net['id']],text=True))[0]
  assert network['Id']==net['id'] and network['Name']==net['name'] and network['Internal'] is net['internal'] and network['Driver']=='bridge' and network['Labels'].get('com.docker.compose.project')==project
 tcp=subprocess.check_output(['nsenter','--target',str(anchor['pid']),'--net','ss','-H','-lntp'],text=True).splitlines()
 unix=subprocess.check_output(['ss','-H','-lxnp'],text=True).splitlines()
 for forward in value['forwarders']:
  for key,namespace in [('host',os.readlink('/proc/self/ns/net')),('inside',anchor['networkNamespace'])]:
   item=forward[key];assert identity(item['pid'])=={'start':item['start'],'namespace':namespace}
   assert pathlib.Path('/proc',str(item['pid']),'cgroup').read_text().strip()=='0::/system.slice/'+value['unit']
  socket=pathlib.Path(forward['socket']);assert socket.parent==pathlib.Path(value['socketRoot'])
  assert any('127.0.0.1:'+str(forward['port']) in line.split() and 'pid='+str(forward['inside']['pid'])+',' in line for line in tcp),'Loopback listener identity changed'
  assert any(str(socket) in line.split() and 'pid='+str(forward['host']['pid'])+',' in line for line in unix),'Unix listener identity changed'
  assert socket.resolve()==socket and socket.is_socket() and socket.stat().st_mode&0o077==0 and socket.stat().st_uid==os.getuid()
  assert socket.parent.stat().st_mode&0o077==0 and socket.parent.stat().st_uid==os.getuid()
 assert subprocess.check_output(['systemctl','show',value['unit'],'-p','InvocationID','--value'],text=True).strip()==invocation
 return 'container:'+anchor['id'],{'mode':'owned-loopback','profileSha256':value['profileSha256'],'privateRoot':str(private),'invocation':invocation,'anchorId':anchor['id'],'networkReceiptSha256':expected}


def runtime(root,image,private=None,evidence=None):
 root=pathlib.Path(root).resolve()
 assert root.is_dir() and str(root).startswith('/srv/wasalx-fast/')
 assert re.fullmatch(r'[a-z0-9./_-]+@sha256:[a-f0-9]{64}',image),'Pinned runner digest required'
 docker=pathlib.Path(shutil.which('docker') or '').resolve();assert docker.is_file()
 plugins=[path for path in PLUGIN_CANDIDATES if path.is_file()];assert len(plugins)==1,'Exactly one Compose plugin required'
 plugin=plugins[0]
 row=json.loads(subprocess.check_output([docker,'image','inspect',image],text=True))[0]
 assert image in row.get('RepoDigests',[]) and row['Architecture']=='amd64' and row['Os']=='linux'
 test=(root/'node_modules/@playwright/test').resolve()
 playwright=(test.parents[1]/'playwright').resolve()
 core=(playwright.parent/'playwright-core').resolve()
 for path in [test,playwright,core]:assert path.is_dir() and path.is_relative_to(root),'Playwright dependency escapes candidate'
 common=git_common_dir(root)
 if common is not None:assert str(common).startswith('/srv/wasalx-fast/'),'Git common directory outside qualification storage'
 mounts=[('/var/run/docker.sock','/var/run/docker.sock',False),(str(docker),str(docker),True),(str(plugin),str(plugin),True),(str(root),str(root),True)]
 if common is not None:mounts.append((str(common),str(common),True))
 if private is not None:
  private=pathlib.Path(private).resolve();assert private.is_dir() and str(private).startswith('/srv/wasalx-fast/wasalx-simulation-')
  mounts.append((str(private),str(private),False))
 if evidence is not None:
  evidence=pathlib.Path(evidence);assert not evidence.is_symlink();evidence=evidence.resolve()
  assert evidence.is_dir() and str(evidence).startswith('/srv/wasalx-fast/wasalx-evidence-')
  mounts.append((str(evidence),str(evidence),True))
 network,network_receipt=network_binding(row['Id'])
 args=['docker','run','--rm','--init','--network',network,'--pull','never','--memory','8g','--cpus','4','--shm-size','1g','--tmpfs','/tmp:rw,nosuid,nodev,size=1g,mode=1777','-e','PLAYWRIGHT_BROWSERS_PATH=/ms-playwright','-w',str(root)]
 for source,target,readonly in mounts:args+=['--mount',mount(source,target,readonly)]
 args+=[image]
 return args,{'executionRoot':str(root),'imageReference':image,'imageId':row['Id'],'dockerPath':str(docker),'dockerSha256':digest(docker),'composePluginPath':str(plugin),'composePluginSha256':digest(plugin),'gitCommonDir':str(common) if common is not None else None,**({'network':network_receipt} if network_receipt else {})}

def git_probe(args,root):
 script=r"""
const {createHash}=await import('node:crypto');const {execFileSync,spawn}=await import('node:child_process');const {createRequire}=await import('node:module');const {realpathSync}=await import('node:fs');const {join,relative,isAbsolute,sep}=await import('node:path');
const root=process.argv[1],git=(values,options={})=>execFileSync('git',['-C',root,...values],{encoding:'utf8',stdio:['pipe','pipe','ignore'],maxBuffer:16*1024*1024,...options}).trim();
// Validate the actual runtime imports before any browser, private state or scenario effect.
const require=createRequire(join(root,'package.json'));
for(const name of ['pg','ioredis','@playwright/test','typescript','yaml']){
 const path=relative(root,realpathSync(require.resolve(name)));
 if(isAbsolute(path)||path==='..'||path.startsWith('..'+sep))throw Error('Qualification dependency escapes candidate: '+name);
 require(name); // Node loads its transitive dependency closure; never instantiate a client.
}
for(const filename of Object.keys(require.cache)){
 const path=relative(root,realpathSync(filename));
 if(isAbsolute(path)||path==='..'||path.startsWith('..'+sep))throw Error('Qualification dependency closure escapes candidate: '+JSON.stringify({root,filename,path}));
}

const head=git(['rev-parse','HEAD']),tree=git(['rev-parse','HEAD^{tree}']),input=git(['rev-list','--objects','--no-object-names','HEAD^{tree}'])+'\n',ids=input.trim().split('\n'),checks=git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{input}).split('\n');
if(checks.length!==ids.length||checks.some((line,index)=>!new RegExp('^'+ids[index]+' (?:blob|tree) [0-9]+$').test(line)))throw Error('Git object closure unavailable');
const cat=spawn('git',['-C',root,'cat-file','--batch'],{stdio:['pipe','pipe','ignore']}),hash=createHash('sha256'),completed=new Promise((resolve,reject)=>{cat.once('error',reject);cat.once('close',resolve)});cat.stdin.end(input);for await(const chunk of cat.stdout)hash.update(chunk);const code=await completed;if(code!==0)throw Error('Git object closure unavailable');
console.log(JSON.stringify({gitHead:head,gitTree:tree,gitObjectClosureSha256:hash.digest('hex')}));
"""
 completed=subprocess.run(args+['node','--input-type=module','-e',script,str(pathlib.Path(root).resolve())],check=True,capture_output=True,text=True,timeout=120)
 return json.loads(completed.stdout.strip().splitlines()[-1])

def preflight(root,image,version):
 args,receipt=runtime(root,image)
 if receipt.get('network'):args=owned_args(args,pathlib.Path(receipt['network']['privateRoot']))
 receipt.update(git_probe(args,root))
 script=r"""
const {createRequire}=await import('node:module');const {execFileSync}=await import('node:child_process');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
const root=process.argv[1],expected=process.argv[2],require=createRequire(join(root,'package.json')),actual=require('@playwright/test/package.json').version;if(actual!==expected)throw Error('Playwright version mismatch');
const {chromium}=require('@playwright/test');const server=execFileSync('docker',['version','--format','{{.Server.Version}}'],{encoding:'utf8'}).trim(),compose=execFileSync('docker',['compose','version','--short'],{encoding:'utf8'}).trim();
execFileSync('docker',['compose','-f','-','config'],{input:'services:\n  probe:\n    image: scratch\n',stdio:['pipe','ignore','pipe']});
const browser=await chromium.launch({headless:true});await browser.close();const profile=await mkdtemp(join(tmpdir(),'wasalx-pw-'));const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium'});await context.close();await rm(profile,{recursive:true,force:true});
console.log(JSON.stringify({node:process.version,playwright:actual,browser:chromium.executablePath(),dockerServer:server,compose}));
"""
 completed=subprocess.run(args+['node','--input-type=module','-e',script,str(pathlib.Path(root).resolve()),version],check=True,capture_output=True,text=True,timeout=120)
 receipt.update(json.loads(completed.stdout.strip().splitlines()[-1]));return receipt

def owned_args(args, private):
 keys=('WASALX_QUALIFICATION_RUNNER_NAME','WASALX_QUALIFICATION_RUNNER_PROJECT','WASALX_QUALIFICATION_RUNNER_INVOCATION','WASALX_QUALIFICATION_RUNNER_CGROUP')
 values=[os.environ.get(key,'') for key in keys]
 if not any(values):return args
 assert all(values),'Incomplete qualification runner ownership'
 name,project,invocation,parent=values
 assert re.fullmatch(r'[a-z0-9][a-z0-9_.-]*',project) and project==pathlib.Path(private).name,'Runner private project mismatch'
 assert re.fullmatch(r'[0-9a-f]{32}',invocation) and invocation==os.environ.get('INVOCATION_ID'),'Native invocation identity mismatch'
 assert name=='wasalx-qualrunner-'+invocation,'Runner name must be invocation-unique'
 assert re.fullmatch(r'[a-zA-Z0-9_.@-]+\.slice',parent) and parent not in ('system.slice','user.slice','machine.slice'),'Owned executor slice required'
 assert args[:2]==['docker','run'],'Unexpected runner command'
 assert '--name' not in args and '--cgroup-parent' not in args,'Duplicate runner ownership configuration'
 extra=[]
 if os.environ.get('WASALX_QUALIFICATION_NETWORK_RECEIPT'):
  for key in (*keys,'INVOCATION_ID','WASALX_QUALIFICATION_NETWORK_RECEIPT','WASALX_QUALIFICATION_NETWORK_RECEIPT_SHA256'):extra+=['-e',key+'='+os.environ[key]]
 return args[:2]+extra+['--name',name,'--cgroup-parent',parent,'--label','io.wasalx.qualification.project='+project,'--label','io.wasalx.qualification.invocation='+invocation]+args[2:]

def main():
 if sys.argv[1]=='preflight':
  assert len(sys.argv)==5;print(json.dumps(preflight(sys.argv[2],sys.argv[3],sys.argv[4])));return
 assert sys.argv[1]=='run' and len(sys.argv)>=8
 separator=7 if len(sys.argv)>=9 and sys.argv[7]=='--' else 6
 assert sys.argv[separator]=='--'
 private=pathlib.Path(sys.argv[3]).resolve();receipt=pathlib.Path(sys.argv[5]).resolve()
 assert receipt.is_relative_to(private) and receipt.is_file() and not receipt.is_symlink(),'Prepared runtime receipt required'
 expected_doc=json.loads(receipt.read_text());expected=expected_doc.get('testRunner') or expected_doc.get('runtime') or expected_doc
 args,current=runtime(sys.argv[2],sys.argv[4],private,sys.argv[6]) if separator==7 else runtime(sys.argv[2],sys.argv[4],private)
 for key in ['executionRoot','imageReference','imageId','dockerPath','dockerSha256','composePluginPath','composePluginSha256','gitCommonDir']:
  assert key in expected and current.get(key)==expected[key],'Runner preflight identity changed: '+key
 assert current.get('network')==expected.get('network'),'Runner network profile changed'
 args=owned_args(args,private)
 closure=git_probe(args,sys.argv[2])
 for key in ['gitHead','gitTree','gitObjectClosureSha256']:
  assert key in expected and closure.get(key)==expected[key],'Runner Git object closure changed: '+key
 raise SystemExit(subprocess.run(args+sys.argv[separator+1:]).returncode)

if __name__=='__main__':main()
