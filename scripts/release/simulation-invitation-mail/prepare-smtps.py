# Main-only file preparation; never starts/recreates a container or changes secrets.
# python3 prepare-smtps.py PRIVATE_DIR EXACT_NODE_IMAGE PRIVATE_AUTH_JSON RECIPIENTS_JSON CERTIFICATE_LIFETIME_DAYS
import pathlib,sys,json,subprocess,os,hashlib,datetime
root=pathlib.Path(sys.argv[1]).resolve(); assert str(root).startswith('/srv/wasalx-fast/wasalx-simulation-')
image=sys.argv[2]; assert image.startswith('sha256:') and len(image)==71
auth_path=pathlib.Path(sys.argv[3]).resolve(); assert root in auth_path.parents and auth_path.stat().st_mode & 0o077 == 0
auth=json.loads(auth_path.read_text()); recipients=json.loads(pathlib.Path(sys.argv[4]).read_text())
days=int(sys.argv[5]);assert str(days)==sys.argv[5] and 3<=days<=30
assert isinstance(recipients,list) and recipients and all(isinstance(x,str) and '\n' not in x and '@' in x for x in recipients)
assert isinstance(auth['password'],str) and len(auth['password'])>=8
subprocess.run(['docker','image','inspect',image],capture_output=True,check=True)
service_name=sys.argv[6] if len(sys.argv)>6 else 'alpha-smtps'
assert service_name in ['alpha-smtps','alpha-smtp'],'Explicit known synthetic TLS service required'
native_mail=service_name=='alpha-smtp'
target=root/('email-native-tls' if native_mail else 'email-smtps');target.mkdir(mode=0o700)
def run(*args):subprocess.run(args,capture_output=True,check=True)
run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-subj',('/CN=WasalX isolated alpha-smtp CA' if native_mail else '/CN=WasalX isolated SMTP CA'),'-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-addext','subjectKeyIdentifier=hash','-keyout',str(target/'ca.key'),'-out',str(target/'ca.crt'),'-days',str(days))
run('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN='+service_name,'-keyout',str(target/'server.key'),'-out',str(target/'server.csr'))
(target/'ext.cnf').write_text('subjectAltName=DNS:'+service_name+'\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nauthorityKeyIdentifier=keyid,issuer\nsubjectKeyIdentifier=hash\n')
run('openssl','x509','-req','-in',str(target/'server.csr'),'-CA',str(target/'ca.crt'),'-CAkey',str(target/'ca.key'),'-CAcreateserial','-out',str(target/'server.crt'),'-days',str(days),'-extfile',str(target/'ext.cnf'))
(target/'auth.json').write_text(json.dumps(auth))
if native_mail:
 for f in target.iterdir():os.chmod(f,0o600);os.chown(f,1000,1000)
 os.chown(target,1000,1000)
 certificates=[]
 for service,name in [('alpha-smtp-ca','ca.crt'),('alpha-smtp','server.crt')]:
  path=target/name;end=subprocess.check_output(['openssl','x509','-in',str(path),'-noout','-enddate'],text=True).strip().removeprefix('notAfter=')
  certificates.append({'service':service,'path':str(path),'containerPath':'/run/wasalx-simulation-tls/'+name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'notAfter':datetime.datetime.strptime(end,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')})
 print(json.dumps({'prepared':True,'nativeMailbox':True,'directory':str(target),'syntheticTls':certificates,'noRuntimeMutation':True}))
 sys.exit(0)
config={'isolated':True,'host':'0.0.0.0','port':465,'journal':'/state/journal.jsonl','tls':{'keyFile':'/run/wasalx-simulation/server.key','certFile':'/run/wasalx-simulation/server.crt'},'authFile':'/run/wasalx-simulation/auth.json','allowedRecipients':recipients,'faults':[]}
(target/'config.json').write_text(json.dumps(config))
for f in target.iterdir():os.chmod(f,0o600);os.chown(f,1000,1000)
os.chmod(target/'ca.crt',0o644)
os.chown(target,1000,1000)
state=target/'state';state.mkdir(mode=0o700);os.chown(state,1000,1000)
model={'services':{'alpha-smtps':{'image':image,'user':'1000:1000','entrypoint':['node'],'command':['/driver/smtp-simulation-server.mjs','/run/wasalx-simulation/config.json'],'networks':['tenant-zammad'],'ports':[],'read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'sysctls':{'net.ipv4.ip_unprivileged_port_start':'0'},'volumes':[str(target/'smtp-simulation-server.mjs')+':/driver/smtp-simulation-server.mjs:ro',*[str(target/name)+':/run/wasalx-simulation/'+name+':ro' for name in ['config.json','auth.json','server.key','server.crt']],str(state)+':/state']}}}
model['services']['alpha-smtps']['volumes'] += [str(target/'ca.crt')+':/run/wasalx-simulation/ca.crt:ro',str(target/'smtp-simulation-health.mjs')+':/driver/smtp-simulation-health.mjs:ro']
# Override the inherited worker image's HTTP readyz check with actual SMTPS.
# This proves TLS identity + greeting only; authenticated provider.ready is separate.
model['services']['alpha-smtps']['healthcheck']={'test':['CMD','node','/driver/smtp-simulation-health.mjs'],'interval':'5s','timeout':'3s','retries':5,'start_period':'5s'}
with open(root/'compose.simulation-smtps.yaml','x') as f:json.dump(model,f)
os.chmod(root/'compose.simulation-smtps.yaml',0o600)
certificates=[]
for service,name in [('alpha-smtps-ca','ca.crt'),('alpha-smtps','server.crt')]:
 path=target/name;end=subprocess.check_output(['openssl','x509','-in',str(path),'-noout','-enddate'],text=True).strip().removeprefix('notAfter=')
 certificates.append({'service':service,'path':str(path),'containerPath':'/run/wasalx-simulation/'+name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'notAfter':datetime.datetime.strptime(end,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')})
print(json.dumps({'prepared':True,'sourceStillRequired':str(target/'smtp-simulation-server.mjs'),'healthSourceStillRequired':str(target/'smtp-simulation-health.mjs'),'clientTrustFile':str(target/'ca.crt'),'endpoint':'smtps://alpha-smtps:465','syntheticTls':certificates,'noRuntimeMutation':True}))
