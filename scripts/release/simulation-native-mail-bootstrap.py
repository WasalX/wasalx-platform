"""Preparation only. No container start, restart, native DB or account changes."""
import hashlib, json, os, pathlib, re, secrets, subprocess, sys

def immutable_asset(path):
 path=pathlib.Path(path)
 assert path.is_absolute() and not path.is_symlink() and path.resolve()==path,'Unsafe immutable asset'
 if path.is_file():digest=hashlib.sha256(path.read_bytes()).hexdigest()
 else:
  assert path.is_dir(),'Missing immutable asset'
  entries=[]
  for child in sorted(path.rglob('*')):
   assert not child.is_symlink(),'Symlink inside immutable asset'
   if child.is_file():entries.append([child.relative_to(path).as_posix(),hashlib.sha256(child.read_bytes()).hexdigest()])
  digest=hashlib.sha256(json.dumps(entries,separators=(',',':')).encode()).hexdigest()
 state=path.lstat()
 return {'path':str(path),'sha256':digest,'mode':state.st_mode,'uid':state.st_uid}

def freeze_selected_assets(receipt,model,compose_args,target):
 """Extend the existing receipt; validate old immutable bytes before adding new ones."""
 target=pathlib.Path(target);assert target.is_absolute() and target.resolve()==target
 for row in receipt.get('selectedCompose',[]):
  path=pathlib.Path(row['path']);assert path.is_relative_to(target) and path!=target
  assert immutable_asset(path)['sha256']==row['sha256'],'Prior selected Compose changed'
 assets={}
 for row in receipt['generatedImmutableFiles']:
  assert immutable_asset(row['path'])==row,'Previously frozen immutable asset changed'
  prior=assets.setdefault(row['path'],row);assert prior==row
 selected=[];seen=set()
 for index,value in enumerate(compose_args):
  if value!='-f':continue
  assert index+1<len(compose_args)
  path=pathlib.Path(compose_args[index+1]);assert path.is_absolute() and path.is_relative_to(target) and path!=target and str(path) not in seen,'Unsafe or repeated selected Compose'
  assert path.is_file();row=immutable_asset(path);selected.append({'path':str(path),'sha256':row['sha256']});seen.add(str(path))
 assert selected and any(row['sha256']==receipt['modelSha256'] for row in selected),'Selected model digest missing'
 for service in model['services'].values():
  for mount in service.get('volumes',[]):
   if mount.get('type')!='bind' or not mount.get('read_only'):continue
   path=pathlib.Path(mount['source'])
   if not path.is_relative_to(target) or path==target:continue
   row=immutable_asset(path);prior=assets.setdefault(str(path),row);assert prior==row,'Immutable bind changed'
 receipt['selectedCompose']=selected
 receipt['generatedImmutableFiles']=[assets[path] for path in sorted(assets)]
 return receipt

def validate_mailbox(spec, namespace):
 required={'schemaVersion','namespace','host','mailbox','smtpPort','imapPort','folder','security','allowedSenders','allowedRecipients','credentialsReference','trustReference','verification'}
 assert isinstance(spec,dict) and set(spec)==required,'Exact syntheticMailbox contract required'
 assert type(spec['schemaVersion']) is int and spec['schemaVersion']==1
 assert re.fullmatch(r'[A-Za-z0-9-]{1,50}',namespace) and spec['namespace']==namespace
 mailbox='support-'+namespace.lower()+'@alpha.invalid'
 assert spec['host']=='alpha-smtp' and spec['mailbox']==mailbox
 assert type(spec['smtpPort']) is int and spec['smtpPort']==465 and type(spec['imapPort']) is int and spec['imapPort']==993
 assert spec['folder']=='INBOX' and spec['security']=='TLS'
 assert spec['credentialsReference']=='email-native-tls/auth.json' and spec['trustReference']=='email-native-tls/ca.crt'
 assert spec['verification']=={'recipient':mailbox,'mode':'NATIVE_OWNED_SMTP_IMAP'}
 for field in ['allowedSenders','allowedRecipients']:
  values=spec[field]
  assert isinstance(values,list) and 1<=len(values)<=32 and len(set(values))==len(values) and mailbox in values
  assert all(isinstance(value,str) and re.fullmatch(r'[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+',value) for value in values)
 assert {'customer@alpha.invalid','failure-'+namespace.lower()+'@alpha.invalid'}.issubset(spec['allowedRecipients'])
 return spec

def prepare(root,plan,target,model):
 spec=validate_mailbox(plan['email']['syntheticMailbox'],plan['namespace'])
 assert plan.get('stateMode')=='fresh' and plan.get('operatorSurface')=='portal','Current mailbox mode needs explicit fresh portal plan'
 service=model['services']['alpha-smtp']
 assert service.get('user')=='1000:1000' and not service.get('ports')
 assert set(service.get('networks',{}))=={'tenant-zammad'}
 sources=['scripts/contracts/smtp-simulation-server.mjs','scripts/contracts/smtp-simulation-health.mjs','scripts/contracts/mailbox-tls-fixture.mjs','scripts/contracts/alpha-native-mailbox-boundary.mjs','scripts/release/simulation-invitation-mail/prepare-smtps.py']
 for relative in sources:
  source=root/relative
  digest=hashlib.sha256(source.read_bytes()).hexdigest()
  assert source.is_file() and not source.is_symlink() and any(pathlib.Path(row['path']).resolve()==source.resolve() and row['sha256']==digest for row in plan['files']),'Unfrozen native mailbox source'
 # The synthetic provider owns this account; the application receives the value
 # only via the authorized UI and persists it exclusively in native Channel.
 seed=target/'native-mail-auth-seed.json';recipients=target/'native-mail-recipients.json'
 for path,value in [(seed,{'username':spec['mailbox'],'password':'synthetic-'+secrets.token_hex(24)}),(recipients,spec['allowedRecipients'])]:
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as stream:json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
 try:
  receipt=json.loads(subprocess.check_output([sys.executable,str(root/sources[-1]),str(target),plan['images']['alpha-smtp'],str(seed),str(recipients),str(plan['syntheticCertificateLifetimeDays']),'alpha-smtp'],text=True))
 finally:
  # Exact newly created ephemeral inputs only; no recursive or retained cleanup.
  seed.unlink()
  recipients.unlink()
 assert receipt['prepared'] is True and receipt['nativeMailbox'] is True
 tls_directory=target/'email-native-tls';assert pathlib.Path(receipt['directory'])==tls_directory
 directory=target/'email-smtp';directory.mkdir(mode=0o700);os.chown(directory,1000,1000)
 mount='/run/wasalx-simulation-tls'
 config={'schemaVersion':1,'isolated':True,'ownerNamespace':spec['namespace'],'serverName':'alpha-smtp','mailbox':spec['mailbox'],
  'host':'0.0.0.0','port':465,'imapPort':993,'journal':'/run/wasalx-simulation/journal.jsonl','faults':[],
  'tls':{'keyFile':mount+'/server.key','certFile':mount+'/server.crt'},'authFile':mount+'/auth.json','caFile':mount+'/ca.crt',
  'allowedSenders':spec['allowedSenders'],'allowedRecipients':spec['allowedRecipients']}
 path=directory/'config.json';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as stream:json.dump(config,stream);stream.flush();os.fsync(stream.fileno())
 os.chown(path,1000,1000)
 bind=lambda source,destination,readonly=True:{'type':'bind','source':str(source),'target':destination,'read_only':readonly}
 service.pop('container_name',None)
 service.update(entrypoint=['node'],command=['/driver/alpha-native-mailbox-boundary.mjs','/run/wasalx-simulation/config.json'])
 service['sysctls']={**service.get('sysctls',{}),'net.ipv4.ip_unprivileged_port_start':'0'}
 service['volumes']=[bind(root/relative,'/driver/'+pathlib.Path(relative).name) for relative in sources[:-1]]
 service['volumes'] += [bind(directory,'/run/wasalx-simulation',False),bind(path,'/run/wasalx-simulation/config.json')]
 service['volumes'] += [bind(tls_directory/name,mount+'/'+name) for name in ['auth.json','server.key','server.crt','ca.crt']]
 service['healthcheck']={'test':['CMD','node','/driver/alpha-native-mailbox-boundary.mjs','--health','/run/wasalx-simulation/config.json'],'interval':'5s','timeout':'5s','retries':5,'start_period':'5s'}
 # Add a hashed CA directory without replacing platform SSL_CERT_FILE or roots.
 hashed=subprocess.check_output(['openssl','x509','-in',str(tls_directory/'ca.crt'),'-noout','-hash'],text=True).strip()
 assert re.fullmatch(r'[a-f0-9]{8}',hashed)
 native_ca='/run/wasalx-alpha-mail-ca/'+hashed+'.0'
 native_services=['zammad-init','zammad-package','zammad-runtime-bootstrap','zammad-railsserver','zammad-scheduler','zammad-websocket','zammad-activation']
 for name in native_services:
  if name not in model['services']:continue
  native=model['services'][name];env=native.setdefault('environment',{})
  assert env.get('WASALX_MAIL_ALLOWED_HOSTS','') in ['', 'alpha-smtp'],'Fresh fixture cannot inherit external mail admission'
  env['WASALX_MAIL_ALLOWED_HOSTS']='alpha-smtp'
  existing=env.get('SSL_CERT_DIR','/etc/ssl/certs')
  assert isinstance(existing,str) and existing and all(value.startswith('/') and '\n' not in value for value in existing.split(':'))
  assert '/run/wasalx-alpha-mail-ca' not in existing.split(':'),'Native mail CA already injected'
  env['SSL_CERT_DIR']=existing+':/run/wasalx-alpha-mail-ca'
  native.setdefault('volumes',[]).append(bind(tls_directory/'ca.crt',native_ca))
 certificates=receipt['syntheticTls']
 for row in certificates:
  row['containerPath']=mount+('/ca.crt' if row['service']=='alpha-smtp-ca' else '/server.crt')
  if row['service']=='alpha-smtp-ca':row['nativeTrustContainerPath']=native_ca
 return certificates
