// Preparation only: no listener, container, scheduler, network or DB actions.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,X509Certificate} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export const MAILBOX_FIXTURE_NODE_IMAGE='node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d';
const run=promisify(execFile);
export async function prepareMailboxFixture(directory,{image=MAILBOX_FIXTURE_NODE_IMAGE,fixtureSource=fileURLToPath(new URL('./mailbox-tls-fixture.mjs',import.meta.url)),openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl'}={}){
 assert(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/u.test(image),'Exact pinned cached Node image required');
 const target=join(resolve(directory),'mailbox-tls-fixture');await mkdir(target,{mode:0o700});
 const privateDir=join(target,'private');await mkdir(privateDir,{mode:0o700});
 const path=name=>join(privateDir,name),put=(name,value,mode=0o600)=>writeFile(path(name),value,{mode,flag:'wx'});
 await put('openssl.cnf','[req]\ndistinguished_name=dn\n[dn]\n');
 const ssl=async(...args)=>{try{await run(openssl,args,{env:{...process.env,OPENSSL_CONF:path('openssl.cnf')},timeout:30_000,maxBuffer:262_144});}catch{throw Error('Ephemeral mailbox certificate preparation failed');}};
 for(const name of ['ca','untrusted-ca'])await ssl('req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=WasalX isolated '+name,
  '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-addext','subjectKeyIdentifier=hash',
  '-keyout',path(name+'.key'),'-out',path(name+'.crt'),'-days','2');
 await ssl('req','-newkey','rsa:2048','-nodes','-subj','/CN=mailbox.synthetic.test','-keyout',path('server.key'),'-out',path('server.csr'));
 await put('server.ext','subjectAltName=DNS:mailbox.synthetic.test\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nauthorityKeyIdentifier=keyid,issuer\nsubjectKeyIdentifier=hash\n');
 await ssl('x509','-req','-in',path('server.csr'),'-CA',path('ca.crt'),'-CAkey',path('ca.key'),'-CAcreateserial','-out',path('server.crt'),'-days','2','-extfile',path('server.ext'));
 const mailbox='owned-mailbox@mailbox.synthetic.test';
 // These credentials authorize only this in-memory synthetic mailbox. Never print their values.
 await put('auth.json',JSON.stringify({username:mailbox,password:'synthetic-'+randomBytes(24).toString('hex')}),0o644);
 await put('control-token',randomBytes(32).toString('hex'),0o644);
 const mount='/run/wasalx-mailbox-fixture';
 const config={isolated:true,host:'0.0.0.0',mailbox,ports:{smtpTls:465,smtpStarttls:587,imapTls:993,imapStarttls:143,control:8080},
  tls:{keyFile:mount+'/server.key',certFile:mount+'/server.crt'},authFile:mount+'/auth.json',controlTokenFile:mount+'/control-token'};
 await put('config.json',JSON.stringify(config),0o644);
 for(const name of ['ca.key','untrusted-ca.key','server.key'])await chmod(path(name),0o600);
 for(const name of ['ca.crt','untrusted-ca.crt','server.crt'])await chmod(path(name),0o644);
 const bind=(source,target)=>({type:'bind',source:resolve(source),target,read_only:true});
 const certificates=await Promise.all(['ca','untrusted-ca','server'].map(async name=>{const cert=new X509Certificate(await readFile(path(name+'.crt')));return {name,path:path(name+'.crt'),fingerprint256:cert.fingerprint256,validTo:cert.validTo};}));
 const uid=process.getuid?.()??1000,gid=process.getgid?.()??1000;
 return {directory:target,privateDir,certificates,networks:{'mailbox-fixture':{internal:true}},nativeNetworks:['default','mailbox-fixture'],
  service:{image,pull_policy:'never',user:String(uid)+':'+String(gid),entrypoint:['node'],command:['/fixture/mailbox-tls-fixture.mjs',mount+'/config.json'],
   environment:{WASALX_MAILBOX_FIXTURE_ISOLATED:'1'},mem_limit:'128m',memswap_limit:'128m',cpus:0.5,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],
   sysctls:{'net.ipv4.ip_unprivileged_port_start':'0'},ports:[],networks:{'mailbox-fixture':{aliases:['mailbox.synthetic.test','mismatch.mailbox.synthetic.test']}},
   volumes:[bind(fixtureSource,'/fixture/mailbox-tls-fixture.mjs'),bind(privateDir,mount)],
   healthcheck:{test:['CMD','node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2000)});if(!r.ok||(await r.json()).mode!=='SIMULATED')process.exit(1);"],interval:'3s',timeout:'3s',retries:10}},
  nativeEnvironment:{SSL_CERT_FILE:mount+'/ca.crt',WASALX_ADMIN_TEST_MODE:'simulated',WASALX_ADMIN_TLS_FIXTURE:'1',WASALX_ADMIN_TLS_HOST:'mailbox.synthetic.test',
   WASALX_ADMIN_TLS_EMAIL:mailbox,WASALX_ADMIN_TLS_USER:mailbox,WASALX_ADMIN_TLS_SMTP_PORT:'465',WASALX_ADMIN_TLS_IMAP_PORT:'993',WASALX_ADMIN_TLS_FIXTURE_AUTH_FILE:mount+'/auth.json',
   WASALX_ADMIN_TLS_FIXTURE_CONTROL_FILE:mount+'/control-token',WASALX_ADMIN_TLS_FIXTURE_URL:'http://mailbox.synthetic.test:8080',
   WASALX_MAIL_ALLOWED_HOSTS:'mailbox.synthetic.test,mismatch.mailbox.synthetic.test'},
  nativeVolumes:['ca.crt','untrusted-ca.crt','auth.json','control-token'].map(name=>bind(path(name),mount+'/'+name))};
}
