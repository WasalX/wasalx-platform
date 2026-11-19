import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createSmtpBoundary} from '../scripts/contracts/smtp-simulation-server.mjs';
import {smtpTlsHealth} from '../scripts/contracts/smtp-simulation-health.mjs';
const exec=(file,args,options={})=>new Promise((resolve,reject)=>execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
test('trusted SMTPS, sender-bound AUTH, rejected trust/credentials, actual provider readiness',async()=>{
 // RFC 8375 names exercise production address validation without a real mailbox.
 const sender=['fixture-sender','example.home.arpa'].join('@'),recipient=['fixture-recipient','example.home.arpa'].join('@');
 const dir=await mkdtemp(join(tmpdir(),'alpha-smtp-tls-')),openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';let server;
 try{
  await writeFile(join(dir,'openssl.cnf'),'[req]\ndistinguished_name=dn\n[dn]\n');
  const ssl=(...args)=>exec(openssl,args,{env:{...process.env,OPENSSL_CONF:join(dir,'openssl.cnf')}});
  await ssl('req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=Alpha Test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-addext','subjectKeyIdentifier=hash','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.crt'),'-days','1');
  await ssl('req','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',join(dir,'server.key'),'-out',join(dir,'server.csr'));
  await writeFile(join(dir,'ext.cnf'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nauthorityKeyIdentifier=keyid,issuer\nsubjectKeyIdentifier=hash\n');
  await ssl('x509','-req','-in',join(dir,'server.csr'),'-CA',join(dir,'ca.crt'),'-CAkey',join(dir,'ca.key'),'-CAcreateserial','-out',join(dir,'server.crt'),'-days','1','-extfile',join(dir,'ext.cnf'));
  const authFile=join(dir,'auth.json');await writeFile(authFile,JSON.stringify({username:sender,password:'synthetic-password-1'}),{mode:0o600});
  server=createSmtpBoundary({journal:join(dir,'journal.jsonl'),tls:{keyFile:join(dir,'server.key'),certFile:join(dir,'server.crt')},authFile,allowedRecipients:[recipient]});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const ca=await readFile(join(dir,'ca.crt'));assert.equal(await smtpTlsHealth({port,servername:'localhost',ca}),true);assert.equal(await smtpTlsHealth({port,servername:'wrong.invalid',ca}),false);
  const code=`import smtplib,ssl,sys,socket
port=int(sys.argv[1]);ca=sys.argv[2];context=ssl.create_default_context(cafile=ca)
def connect(): return smtplib.SMTP_SSL('127.0.0.1',port,context=context,timeout=3)
with connect() as s:
 assert s.mail('${sender}')[0]==530
 for password in ('synthetic-password-2','synthetic-password-1-extra','x'*4097):
  try: s.login('${sender}',password); raise AssertionError('bad auth accepted')
  except smtplib.SMTPAuthenticationError: pass
 s.login('${sender}','synthetic-password-1')
 assert s.mail('other@alpha.invalid')[0]==553
 raw=bytes([13,10]).join([b'Message-ID: <tls@alpha.invalid>',b'',b'AUTH is body text',b''])
 s.sendmail('${sender}',['${recipient}'],raw)
try:
 smtplib.SMTP_SSL('127.0.0.1',port,context=ssl.create_default_context(),timeout=3);raise AssertionError('untrusted accepted')
except ssl.SSLCertVerificationError: pass
try:
 with socket.create_connection(('127.0.0.1',port),timeout=3) as raw:
  context.wrap_socket(raw,server_hostname='wrong.invalid');raise AssertionError('wrong hostname accepted')
except ssl.SSLCertVerificationError: pass
print('wire assertions passed')`;
  assert.match((await exec(process.platform==='win32'?'python':'python3',['-c',code,String(port),join(dir,'ca.crt')])).stdout,/wire assertions passed/);
  const provider=pathToFileURL(resolve('services/invitation-mailer/dist/provider.js')).href;
  const js=`import {SmtpTransactionalEmailProvider} from ${JSON.stringify(provider)};const p=new SmtpTransactionalEmailProvider(new URL('smtps://127.0.0.1:${port}'),'synthetic',{resolve:async()=>({apiKey:'synthetic-password-1'})},'${sender}');if(!await p.ready())throw Error('actual provider not ready');const receipt=await p.send({sender:'${sender}',recipient:'${recipient}',deliveryId:'11111111-1111-4111-8111-111111111111',idempotencyKey:'synthetic-test',templateId:'invitation',acceptanceUrl:'https://portal.invalid/accept/synthetic'});if(!receipt.messageId.startsWith('<wasalx-invite-'))throw Error('invalid receipt');console.log('ready');`;
  assert.match((await exec(process.execPath,['--input-type=module','-e',js],{env:{...process.env,NODE_EXTRA_CA_CERTS:join(dir,'ca.crt')}})).stdout,/ready/);
  const rows=(await readFile(join(dir,'journal.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter(x=>x.type==='accepted').length,2);assert.match(Buffer.from(rows[0].bytesBase64,'base64').toString(),/AUTH is body text/);
 }finally{if(server)await new Promise(r=>server.close(r));assert(resolve(dir).startsWith(resolve(tmpdir())));await rm(dir,{recursive:true,force:true});}
});
