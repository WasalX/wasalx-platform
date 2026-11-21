"""Prepare a NEW private simulation env. Never reads existing env or credentials."""
import base64, datetime, json, os, pathlib, re, secrets, socket, subprocess, sys
root=pathlib.Path(sys.argv[1]).resolve(); target=pathlib.Path(sys.argv[2]).resolve(); provider=pathlib.Path(sys.argv[3]).resolve()
assert provider.is_file() and not target.exists()
text=(root/'compose.yaml').read_text()+(root/'compose.full.yaml').read_text()
keys=set(re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?',text))
values={k:secrets.token_hex(24) for k in keys}
for k in values:
 if k.endswith('_PASSWORD'):values[k]='Aa9!'+secrets.token_hex(24)
values.update(COMPOSE_PROJECT_NAME='wasalx-simulation-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S'),PORTAL_PORT='43000',IDENTITY_PORT='43080',ZAMMAD_PORT='43081',WASALX_SIM_PROVIDER_SCRIPT=str(provider),WAHA_SIM_SESSION='simulation-session',WAHA_SIM_GROUP_ID='120000000000000001@g.us',WAHA_SIM_PHONE='12025550103',WAHA_SIM_VERSION='2026.7.2',DEV_SECRET_STORE_ENCRYPTION_KEY=base64.b64encode(secrets.token_bytes(32)).decode(),WASALX_FULL_INVITATION_EMAIL_PROVIDER_URL='http://simulation-mail-disabled.invalid',CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED='false')
# Generate synthetic invitation crypto locally, never copy runtime material.
key=subprocess.check_output(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048'],stderr=subprocess.DEVNULL)
pub=subprocess.check_output(['openssl','pkey','-pubout'],input=key,stderr=subprocess.DEVNULL)
values['WASALX_FULL_INVITATION_PRIVATE_KEY_PEM_JSON']=json.dumps(key.decode())
values['WASALX_INVITATION_TOKEN_PUBLIC_KEY']=pub.decode().strip()
values['PUBLIC_WEBHOOK_BASE_URL']='https://simulation.invalid'
rehearsal = sys.argv[4:] == ['--installer-rehearsal']
if rehearsal:
 # .internal is reserved for private use and does not delegate to a mail provider.
 values.update(
  PORTAL_PORT='3000', IDENTITY_PORT='8080', ZAMMAD_PORT='8081',
  PUBLIC_WEBHOOK_BASE_URL='https://webhook.nightly.internal',
  WASALX_FULL_INVITATION_EMAIL_PROVIDER_URL='https://mail.nightly.internal',
  WASALX_FULL_INVITATION_EMAIL_FROM='invitations@nightly.internal',
  WASALX_FULL_INVITATION_EMAIL_TEMPLATE_ID='nightly',
  WASALX_FULL_KEYCLOAK_SMTP_HOST='mail.nightly.internal',
  WASALX_FULL_KEYCLOAK_SMTP_PORT='587',
  WASALX_FULL_KEYCLOAK_SMTP_FROM='identity@nightly.internal',
  WASALX_FULL_KEYCLOAK_SMTP_USER='identity@nightly.internal',
  WASALX_FULL_KEYCLOAK_SMTP_PASSWORD='Aa9!'+secrets.token_hex(24),
  WASALX_FULL_QUALIFICATION_OWNER_EMAIL='owner@nightly.internal',
 )
else:
 for name in ['PORTAL_PORT','IDENTITY_PORT','ZAMMAD_PORT']:
  with socket.socket() as probe:
   probe.bind(('127.0.0.1',0));values[name]=str(probe.getsockname()[1])
fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 for k,v in sorted(values.items()):
  assert "'" not in v and ('\n' not in v or k=='WASALX_INVITATION_TOKEN_PUBLIC_KEY')
  f.write(k+"='"+v+"'\n")
print(json.dumps({'path':str(target),'project':values['COMPOSE_PROJECT_NAME'],'status':'prepared; render and review before launch','variables':len(values)}))
