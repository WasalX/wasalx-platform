# Main-only preparation. Existing credentials resolve in memory and are never printed.
# python3 prepare-invitation-smtps.py CHECKOUT PRIVATE_DIR PACKET_DIR [ADDITIONAL_CURRENT_OVERLAY ...]
import pathlib,subprocess,json,os,sys,shutil,hashlib
checkout=pathlib.Path(sys.argv[1]).resolve();private=pathlib.Path(sys.argv[2]).resolve();packet=pathlib.Path(sys.argv[3]).resolve()
def validate_checkout_boundary(checkout,private):
 assert any(checkout.is_relative_to(pathlib.Path(base)) and checkout!=pathlib.Path(base) for base in ['/srv/wasalx-fast/candidates','/srv/wasalx-fast/qualification']),'Unsupported qualification checkout'
 assert str(private).startswith('/srv/wasalx-fast/wasalx-simulation-'),'Unsupported private simulation root'
 assert checkout!=private and checkout not in private.parents and private not in checkout.parents,'Checkout and private roots overlap'

validate_checkout_boundary(checkout,private)
assert private in packet.parents and (private/'private.env').stat().st_mode & 0o077 == 0
def command(args,**kwargs):return subprocess.run(args,capture_output=True,text=True,check=True,**kwargs).stdout
import importlib.util
helper=checkout/os.environ["WASALX_OWNER_RECOVERY_SCRIPT"]
spec=importlib.util.spec_from_file_location('fresh_owner',helper);owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
selected_model=private/'fresh-model.json'
if selected_model.exists() or any((private/name).exists() for name in ['fresh-owner-claim.json','fresh-owner-claims.json','fresh-model-owner.json','preparation-with-owner.json']):_,selected_model=owner.load_fresh_preparation(private)
files=[selected_model] if selected_model.exists() else [checkout/'compose.yaml',checkout/'compose.full.yaml',private/'compose.simulation-proposed.yaml',private/'compose.simulation-ipam-proposed.yaml',private/'compose.simulation-origins-proposed.yaml']
for supplied in sys.argv[4:]:
 overlay=pathlib.Path(supplied).resolve();assert private in overlay.parents and overlay.is_file();
 if overlay not in files:files.append(overlay)
compose=['docker','compose','--project-directory',str(checkout),'--env-file',str(private/'private.env')]
for f in files:compose+=['-f',str(f)]
# Read excluded service configuration without activating it.
model=json.loads(command(compose+['--profile','*','config','--format','json']));project=model['name'];assert project.startswith('wasalx-simulation-')
inspect=lambda name:json.loads(command(['docker','inspect',name]))[0]
control=inspect(project+'-control-api-1');assert control['State']['Status']=='running' and control['Config']['Labels']['com.docker.compose.project']==project
node=inspect(project+'-waha-gows-1');mailer=model['services']['invitation-mailer'];image=json.loads(command(['docker','image','inspect',mailer['image']]))[0]
head=command(['git','-C',str(checkout),'rev-parse','HEAD']).strip();tree=command(['git','-C',str(checkout),'rev-parse','HEAD^{tree}']).strip()
assert image['Config']['Labels']['org.opencontainers.image.revision']==head and image['Config']['Labels']['io.wasalx.source.tree']==tree
assert subprocess.run(['docker','inspect',project+'-invitation-mailer-1'],capture_output=True).returncode != 0, 'Existing mailer requires explicit reconciliation, not preparation replay'
pg=inspect(project+'-postgres-1');pg_env=dict(x.split('=',1) for x in pg['Config']['Env'])
count=int(command(['docker','exec',pg['Id'],'psql','-U',pg_env['POSTGRES_USER'],'-d',pg_env['POSTGRES_DB'],'-At','-c','SELECT count(*) FROM tenant_invitation_email_outbox']).strip())
assert count==0,'Existing invitation effects must be reconciled before enabling a previously excluded mailer'
reference=mailer['environment']['INVITATION_EMAIL_PROVIDER_SECRET_REFERENCE'];assert reference.startswith('secret://')
js="const e=process.env;const r=await fetch(e.SECRET_SIDECAR_URL+'/v1/resolve',{method:'POST',headers:{authorization:'Bearer '+e.SECRET_SIDECAR_TOKEN,'content-type':'application/json'},body:JSON.stringify({reference:"+json.dumps(reference)+"}),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('private resolution failed');const s=await r.json();const p=s.apiKey??s.token??s.value;if(typeof p!=='string'||p.length<8||p.length>4096)throw Error('private credential invalid');process.stdout.write(JSON.stringify({password:p}));"
# stdout below remains only in this trusted process; no secret-bearing subprocess logging.
try:secret=json.loads(command(['docker','exec',control['Id'],'node','--input-type=module','-e',js]))
except subprocess.CalledProcessError:raise RuntimeError('Invitation SMTP credential resolution failed') from None
def bind_smtp_parent(overlay,mailer):
 parent=mailer.get('cgroup_parent')
 if parent is None:return
 assert isinstance(parent,str) and parent,'Invalid declared mailer cgroup parent'
 sink=overlay['services']['alpha-smtps']
 assert sink.get('cgroup_parent',parent)==parent,'SMTP cgroup parent conflicts with mailer'
 sink['cgroup_parent']=parent

def controlled_recipients(identity):
 recipient=identity['recipient'];allowed=identity.get('recipients',[recipient])
 assert isinstance(recipient,str) and recipient.count('@')==1 and not any(c.isspace() for c in recipient)
 assert allowed in [[recipient],[recipient,recipient.replace('@','-isolation@')]],'Only primary and deterministic isolation recipient permitted'
 return allowed
identity=json.loads((packet/'identity-mail-config.json').read_text());sender=identity['sender'];recipient=identity['recipient'];allowed=controlled_recipients(identity)
assert isinstance(sender,str) and isinstance(recipient,str) and '\n' not in sender and '\n' not in recipient
auth=private/'invitation-smtps-auth.json';recipients=private/'invitation-smtps-recipients.json'
for path,value in [(auth,{'username':sender,'password':secret['password']}),(recipients,allowed)]:
 with open(path,'x') as f:os.chmod(path,0o600);json.dump(value,f)
del secret
prepared=json.loads(command(['python3',str(packet/'prepare-smtps.py'),str(private),node['Image'],str(auth),str(recipients),str(identity['certificateLifetimeDays'])]))
smtp_overlay=private/'compose.simulation-smtps.yaml'
assert smtp_overlay.is_file() and not smtp_overlay.is_symlink() and smtp_overlay.stat().st_mode&0o077==0
smtp_model=json.loads(smtp_overlay.read_text());bind_smtp_parent(smtp_model,mailer)
with smtp_overlay.open('w') as f:json.dump(smtp_model,f);f.flush();os.fsync(f.fileno())
target=private/'email-smtps'
for source,destination in [('smtp-simulation-server.mjs','smtp-simulation-server.mjs'),('smtp-simulation-health.mjs','smtp-simulation-health.mjs')]:
 shutil.copyfile(packet/source,target/destination);os.chmod(target/destination,0o600);os.chown(target/destination,1000,1000)
ports=model['services']['portal']['ports'];assert len(ports)==1 and ports[0]['host_ip']=='127.0.0.1';portal='http://127.0.0.1:'+str(ports[0]['published'])
# Existing worker networks are all isolated by simulation overlay; add only native
# internal network for sink access. Never re-enable any other excluded service.
overlay={'services':{'invitation-mailer':{'image':image['Id'],'environment':{'INVITATION_EMAIL_PROVIDER_URL':'smtps://alpha-smtps:465','INVITATION_EMAIL_FROM':sender,'INVITATION_EMAIL_TEMPLATE_ID':'wasalx-invitation-v1','PORTAL_PUBLIC_ORIGIN':portal,'NODE_EXTRA_CA_CERTS':'/simulation-smtp-ca/ca.crt','WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST':json.dumps(allowed)},'networks':{'tenant-zammad':None},'volumes':[str(target/'ca.crt')+':/simulation-smtp-ca/ca.crt:ro']}}}
overlay_path=private/'compose.simulation-invitation-smtps.yaml'
with open(overlay_path,'x') as f:os.chmod(overlay_path,0o600);json.dump(overlay,f)
full=compose+['-f',str(private/'compose.simulation-smtps.yaml'),'-f',str(overlay_path)]
rendered=json.loads(command(full+['--profile','*','config','--format','json']))
for service in ['alpha-smtps','invitation-mailer']:
 for network in rendered['services'][service]['networks']:assert rendered['networks'][network].get('internal')==True,'Noninternal network refused'
assert not rendered['services']['alpha-smtps'].get('ports')
# --no-deps prevents startup of dependencies, but Compose still validates their
# presence in its selected model. The full profile includes the seed definition.
profiles=['full','runtime-workers']
if (private/'preparation.json').exists():
 args=json.loads((private/'preparation.json').read_text())['composeArgs']
 profiles=list(dict.fromkeys(profiles+[args[i+1] for i,x in enumerate(args[:-1]) if x=='--profile']))
start=full+[item for profile in profiles for item in ['--profile',profile]]
for service in ['alpha-smtps','invitation-mailer']:
 command(start+['--dry-run','up','-d','--no-build','--pull','never','--no-deps',service])
receipt={'prepared':True,'at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'project':project,'candidate':{'sha':head,'tree':tree},'mailerImage':image['Id'],'smtpImage':node['Image'],'queueBefore':count,'credentialSource':'secret-sidecar','credentialReused':True,'recipient':recipient,'recipients':allowed,'sender':sender,'portalOrigin':portal,'syntheticTls':prepared['syntheticTls'],'overlayPaths':[str(private/'compose.simulation-smtps.yaml'),str(overlay_path)],'startSinkCommand':start+['up','-d','--no-build','--pull','never','--no-deps','alpha-smtps'],'startMailerCommand':start+['up','-d','--no-build','--pull','never','--no-deps','invitation-mailer'],'startModelDryRunPassed':True,'noRuntimeMutation':True}
with open(private/'invitation-smtps-preparation.json','x') as f:os.chmod(f.name,0o600);json.dump(receipt,f,indent=2)
print('{"prepared":true}')
