// Actual-stack alpha email fixture: existing SMTP journal/fault engine and shared
// verification-only IMAP protocol. No customer mail is admitted into its IMAP spool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createSmtpBoundary} from './smtp-simulation-server.mjs';
import {createMailboxState,attachImap} from './mailbox-tls-fixture.mjs';
import {smtpTlsHealth} from './smtp-simulation-health.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const marker=/^wasalx-mail-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const verification=raw=>/^X-Zammad-Test-Message:/imu.test(raw.subarray(0,Math.max(0,raw.indexOf('\r\n\r\n'))).toString('utf8'));
const records=path=>fs.existsSync(path)?fs.readFileSync(path,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];

export function replayAlphaMailboxJournal(state,rows){
 for(const row of rows){
  if(row.type==='accepted'){
   const raw=Buffer.from(row.bytesBase64,'base64');assert.equal(sha(raw),row.sha256);
   if(verification(raw))state.accept(row.from,row.recipients,raw,'SMTP_TLS');
  }else if(row.type==='mailbox-verification-expunged'){
   assert.deepEqual(Object.keys(row).sort(),['at','marker','sha256','type','uid']);
   assert(Number.isSafeInteger(row.uid)&&row.uid>0);assert.match(row.marker,marker);assert.match(row.sha256,/^[a-f0-9]{64}$/u);assert.equal(new Date(row.at).toISOString(),row.at);
   const index=state.messages.findIndex(item=>item.id===row.uid&&item.marker===row.marker&&item.sha256===row.sha256);
   assert(index>=0,'Verification journal deletion has no matching admitted message');
   state.messages.splice(index,1);state.deleted.push(row.marker);
  }else assert(['rejected','fault-consumed'].includes(row.type),'Unknown provider journal record');
 }
}

export function createAlphaMailboxBoundary(config){
 assert.equal(config.isolated,true);assert.equal(config.schemaVersion,1);
 assert.match(config.ownerNamespace,/^[A-Za-z0-9-]{1,50}$/u);
 const expected='support-'+config.ownerNamespace.toLowerCase()+'@alpha.invalid';
 assert.equal(config.mailbox,expected);assert.equal(config.serverName,'alpha-smtp');
 assert.equal(config.port,465);assert.equal(config.imapPort,993);assert(config.tls&&config.authFile);
 assert(config.allowedRecipients.includes(expected));assert(config.allowedSenders.includes(expected));
 const auth=JSON.parse(fs.readFileSync(config.authFile,'utf8'));
 const append=row=>{const fd=fs.openSync(config.journal,'a',0o600);try{fs.writeSync(fd,JSON.stringify({...row,at:new Date().toISOString()})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const state=createMailboxState({isolated:true,mailbox:expected},auth,{
  mailboxAllowed:value=>value===expected,
  onExpunge:item=>append({type:'mailbox-verification-expunged',uid:item.id,marker:item.marker,sha256:item.sha256}),
 });
 // Journal replay preserves delayed receiving-only reconciliation across fault restarts.
 replayAlphaMailboxJournal(state,records(config.journal));
 const smtp=createSmtpBoundary({...config,onAccepted:row=>{
  if(verification(row.raw))state.accept(row.from,row.recipients,row.raw,'SMTP_TLS');
 }});
 const imap=tls.createServer({key:fs.readFileSync(config.tls.keyFile),cert:fs.readFileSync(config.tls.certFile),minVersion:'TLSv1.2'},
  socket=>attachImap(socket,state,{secure:true,transport:'IMAP_TLS'}));
 imap.on('tlsClientError',()=>{});
 const sockets=new Set();
 for(const server of [smtp,imap])server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 return {smtp,imap,state,async close(){for(const socket of sockets)socket.destroy();await Promise.all([smtp,imap].map(server=>new Promise((resolve,reject)=>server.listening?server.close(error=>error?reject(error):resolve()):resolve())));}};
}

export function imapTlsHealth({port=993,servername='alpha-smtp',ca}){
 return new Promise(resolve=>{
  let done=false,received='';const socket=tls.connect({host:'127.0.0.1',port,servername,ca,rejectUnauthorized:true,minVersion:'TLSv1.2'});
  const finish=ok=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(ok);};
  const timer=setTimeout(()=>finish(false),2500);socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));
  socket.on('data',bytes=>{received+=bytes.toString('ascii');if(received.length>4096)return finish(false);if(received.includes('\r\n'))finish(socket.authorized&&/^\* OK [^\r\n]*\r\n/u.test(received));});
 });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const health=process.argv[2]==='--health';const config=JSON.parse(fs.readFileSync(process.argv[health?3:2],'utf8'));
 if(health){
  const ca=fs.readFileSync(config.caFile),checks=await Promise.all([smtpTlsHealth({port:config.port,servername:config.serverName,ca}),imapTlsHealth({port:config.imapPort,servername:config.serverName,ca})]);
  process.exitCode=checks.every(Boolean)?0:1;
 }else{
  const boundary=createAlphaMailboxBoundary(config);
  const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,config.host??'127.0.0.1',resolve);});
  await Promise.all([listen(boundary.smtp,config.port),listen(boundary.imap,config.imapPort)]);
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void boundary.close().then(()=>process.exit(0),()=>process.exit(1)));
 }
}
