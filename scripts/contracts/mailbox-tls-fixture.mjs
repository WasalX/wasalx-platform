// Isolated qualification fixture only; no production SMTP/IMAP implementation.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const MARKER=/\bwasalx-mail-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\b/iu;
const SYNTHETIC=/^[a-z0-9._+-]+@(?:[a-z0-9-]+\.)*synthetic\.test$/u;
const equal=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const safeRecipient=value=>SYNTHETIC.test(value)?value:'REDACTED_OUTSIDE_SYNTHETIC';
function parseHeaders(raw){
 const end=raw.indexOf('\r\n\r\n');if(end<0)throw Error('missing headers');
 const bytes=raw.subarray(0,end+4),fields=new Map();
 for(const line of bytes.toString('utf8').replace(/\r\n[ \t]+/gu,' ').split('\r\n')){
  if(!line)continue;const match=line.match(/^([A-Za-z0-9-]+):[ \t]*(.*)$/u);if(!match)throw Error('invalid headers');
  const name=match[1].toLowerCase();if(fields.has(name))throw Error('duplicate headers');fields.set(name,match[2]);
 }
 return {bytes,fields};
}
export function createMailboxState(config,auth,{mailboxAllowed=value=>SYNTHETIC.test(value),onExpunge}={}){
 assert.equal(config.isolated,true);assert.equal(mailboxAllowed(config.mailbox),true);assert(onExpunge===undefined||typeof onExpunge==='function');assert.equal(auth.username,config.mailbox);
 assert.equal(typeof auth.password,'string');assert(auth.password.length>=16&&auth.password.length<=256&&!/[\r\n\0]/u.test(auth.password));
 const state={onExpunge,config,messages:[],accepted:[],recipientAttempts:[],authAttempts:[],deleted:[],modes:{deny_smtp_starttls:false,deny_imap_starttls:false},nextId:1};
 const record=(list,row)=>{if(list.length>=256)throw Error('fixture audit capacity');list.push(row);};
 state.authenticate=(protocol,secure,user,password,transport)=>{
  const success=secure&&equal(user,auth.username)&&equal(password,auth.password);
  record(state.authAttempts,{protocol,secure,success,transport});return success;
 };
 state.recipient=(address,transport)=>{const allowed=address===config.mailbox;record(state.recipientAttempts,{address:safeRecipient(address),allowed,transport});return allowed;};
 state.accept=(from,recipients,raw,transport)=>{
  if(state.messages.length>=32||raw.length>65_536||from!==config.mailbox||recipients.length!==1||recipients[0]!==config.mailbox)throw Error('mail admission');
  if(raw.includes(Buffer.from(auth.password)))throw Error('credential content rejected');
  const parsed=parseHeaders(raw),subject=parsed.fields.get('subject')??'',marker=subject.match(MARKER)?.[0];
  if(!marker||!subject.startsWith('WasalX verification ')||parsed.fields.get('x-zammad-test-message')!==marker||parsed.fields.has('bcc')||parsed.fields.has('cc')||
    !(parsed.fields.get('from')??'').includes(config.mailbox)||!(parsed.fields.get('to')??'').includes(config.mailbox))throw Error('synthetic marker or recipient shape');
  const id=state.nextId++,row={id,marker,from,recipients:[...recipients],bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),transport,header_bcc_present:false};
  state.messages.push({...row,raw:Buffer.from(raw),headers:parsed.bytes,deleted:false});record(state.accepted,row);return id;
 };
 state.audit=()=>({mode:'SIMULATED',mailbox:config.mailbox,accepted:state.accepted,recipient_attempts:state.recipientAttempts,auth_attempts:state.authAttempts,deleted_markers:state.deleted,spool_count:state.messages.length,modes:state.modes});
 state.reset=()=>{state.messages.length=0;state.accepted.length=0;state.recipientAttempts.length=0;state.authAttempts.length=0;state.deleted.length=0;state.nextId=1;};
 return state;
}
// Remove the plaintext parser before upgrading. Pipelined plaintext is refused.
function lines(socket,onLine,upgrade,maximum=65_538){
 let buffer=Buffer.alloc(0);
 const onData=chunk=>{
  buffer=Buffer.concat([buffer,chunk]);if(buffer.length>maximum){socket.destroy();return;}
  let end;while((end=buffer.indexOf('\r\n'))>=0){const row=buffer.subarray(0,end);buffer=buffer.subarray(end+2);
   try{if(onLine(row)==='UPGRADE'){if(buffer.length){socket.destroy();return;}socket.pause();socket.removeListener('data',onData);upgrade(socket);return;}}
   catch{socket.destroy();return;}
  }
 };
 socket.on('data',onData);socket.on('error',()=>{});socket.setTimeout?.(15_000,()=>socket.destroy());
}
function plainAuth(value){
 if(!/^[A-Za-z0-9+/]+={0,2}$/u.test(value))return null;
 const fields=Buffer.from(value,'base64').toString('utf8').split('\0');
 return fields.length===3&&(!fields[0]||fields[0]===fields[1])?{user:fields[1],password:fields[2]}:null;
}
export function attachSmtp(socket,state,{secure=false,transport='SMTP_STARTTLS',greeting=true,upgrade=()=>socket.destroy()}={}){
 let authenticated=false,pending=null,from=null,recipients=[],data=false,parts=[],size=0;
 const reply=value=>socket.write(value+'\r\n');
 const reset=()=>{from=null;recipients=[];data=false;parts=[];size=0;};
 const authenticate=value=>{const auth=plainAuth(value);authenticated=state.authenticate('SMTP',secure,auth?.user??'',auth?.password??'',transport);reply(authenticated?'235 2.7.0 Authenticated':'535 5.7.8 Authentication failed');};
 if(greeting)reply('220 mailbox.synthetic.test WasalX isolated mailbox');
 lines(socket,row=>{
  const line=row.toString('ascii');
  if(pending){const kind=pending;pending=null;
   if(kind==='PLAIN')authenticate(line);
   else if(kind==='LOGIN_USER'){pending={user:Buffer.from(line,'base64').toString('utf8')};reply('334 UGFzc3dvcmQ6');}
   else{authenticated=state.authenticate('SMTP',secure,kind.user,Buffer.from(line,'base64').toString('utf8'),transport);reply(authenticated?'235 2.7.0 Authenticated':'535 5.7.8 Authentication failed');}return;
  }
  if(data){
   if(line!=='.'){const value=row[0]===46?row.subarray(1):row;size+=value.length+2;if(size>65_536)throw Error('mail limit');parts.push(value,Buffer.from('\r\n'));return;}
   try{state.accept(from,recipients,Buffer.concat(parts),transport);reset();reply('250 2.0.0 Accepted');}catch{reset();reply('550 5.7.1 Only owned synthetic verification mail is accepted');}return;
  }
  if(/^(EHLO|HELO) /iu.test(line)){reply('250-mailbox.synthetic.test');if(!secure&&!state.modes.deny_smtp_starttls)reply('250-STARTTLS');if(secure)reply('250-AUTH PLAIN LOGIN');reply('250 SIZE 65536');return;}
  if(/^STARTTLS$/iu.test(line)){
   if(secure||authenticated||from!==null){reply('503 Invalid sequence');return;}
   if(state.modes.deny_smtp_starttls){reply('454 4.7.0 TLS unavailable');return;}reply('220 2.0.0 Begin TLS');return 'UPGRADE';
  }
  if(/^AUTH(?: |$)/iu.test(line)){
   if(!secure){state.authenticate('SMTP',false,'','',transport);reply('538 5.7.11 Encryption required');return;}
   if(authenticated||from!==null){reply('503 Invalid sequence');return;}
   const plain=line.match(/^AUTH PLAIN(?: ([A-Za-z0-9+/=]+))?$/iu);
   if(plain){if(plain[1])authenticate(plain[1]);else{pending='PLAIN';reply('334 ');}return;}
   if(/^AUTH LOGIN$/iu.test(line)){pending='LOGIN_USER';reply('334 VXNlcm5hbWU6');return;}reply('504 Unsupported AUTH');return;
  }
  if(/^MAIL FROM:/iu.test(line)){
   if(!authenticated){reply('530 Authentication required');return;}
   const match=line.match(/^MAIL FROM:<([^<>\s]+)>(?: [A-Za-z0-9=]+)*$/iu);
   if(!match||match[1]!==state.config.mailbox){reply('553 Sender outside owned fixture');return;}reset();from=match[1];reply('250 Sender accepted');return;
  }
  if(/^RCPT TO:/iu.test(line)){
   const match=line.match(/^RCPT TO:<([^<>\s]+)>$/iu);if(from===null){reply('503 MAIL required');return;}
   if(!match||!state.recipient(match[1],transport)){reply('550 Relay prohibited');return;}
   if(recipients.includes(match[1])){reply('553 Duplicate recipient');return;}recipients.push(match[1]);reply('250 Recipient accepted');return;
  }
  if(/^DATA$/iu.test(line)){if(recipients.length!==1){reply('503 One owned recipient required');return;}data=true;reply('354 End with dot');return;}
  if(/^RSET$/iu.test(line)){reset();reply('250 Reset');return;}
  if(/^NOOP$/iu.test(line)){reply('250 OK');return;}
  if(/^QUIT$/iu.test(line)){reply('221 Bye');socket.end();return;}reply('502 Unsupported command');
 },upgrade);
}

function imapWords(value){
 const result=[];let rest=value.trim();
 while(rest){const match=rest.match(/^(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))(?:\s+|$)/u);if(!match)throw Error('invalid IMAP argument');result.push(match[1]===undefined?match[2]:match[1].replace(/\\(.)/gu,'$1'));rest=rest.slice(match[0].length);}
 return result;
}
export function attachImap(socket,state,{secure=false,transport='IMAP_STARTTLS',greeting=true,upgrade=()=>socket.destroy()}={}){
 let authenticated=false,selected=false,pendingTag=null;
 const reply=value=>socket.write(value+'\r\n');
 const capabilities=()=> 'IMAP4rev1'+(secure?' AUTH=PLAIN':' LOGINDISABLED'+(state.modes.deny_imap_starttls?'':' STARTTLS'));
 const authenticate=(tag,user,password)=>{authenticated=state.authenticate('IMAP',secure,user,password,transport);reply(tag+' '+(authenticated?'OK Authenticated':'NO [AUTHENTICATIONFAILED] Authentication failed'));};
 if(greeting)reply('* OK [CAPABILITY '+capabilities()+'] WasalX isolated mailbox');
 lines(socket,row=>{
  const line=row.toString('ascii');
  if(pendingTag){const tag=pendingTag;pendingTag=null;const auth=plainAuth(line);authenticate(tag,auth?.user??'',auth?.password??'');return;}
  const match=line.match(/^([A-Za-z0-9.-]{1,64}) ([A-Za-z]+)(?: (.*))?$/u);
  if(!match){reply('* BAD Invalid command');return;}
  const [,tag,verbRaw,args='']=match,verb=verbRaw.toUpperCase();
  if(verb==='CAPABILITY'){reply('* CAPABILITY '+capabilities());reply(tag+' OK CAPABILITY completed');return;}
  if(verb==='STARTTLS'){
   if(secure||authenticated){reply(tag+' BAD Invalid sequence');return;}
   if(state.modes.deny_imap_starttls){reply(tag+' NO TLS unavailable');return;}reply(tag+' OK Begin TLS');return 'UPGRADE';
  }
  if(verb==='LOGIN'){
   const values=imapWords(args);if(values.length!==2){reply(tag+' BAD Invalid LOGIN');return;}authenticate(tag,values[0],values[1]);return;
  }
  if(verb==='AUTHENTICATE'){
   const values=imapWords(args);if(!secure||values[0]?.toUpperCase()!=='PLAIN'){reply(tag+' NO Authentication requires TLS');return;}
   if(values[1]){const auth=plainAuth(values[1]);authenticate(tag,auth?.user??'',auth?.password??'');}else{pendingTag=tag;reply('+ ');}return;
  }
  if(verb==='LOGOUT'){reply('* BYE Closing');reply(tag+' OK LOGOUT completed');socket.end();return;}
  if(verb==='NOOP'){reply(tag+' OK NOOP completed');return;}
  if(!authenticated){reply(tag+' NO Authenticate first');return;}
  if(verb==='SELECT'){
   const values=imapWords(args);if(values.length!==1||values[0].toUpperCase()!=='INBOX'){reply(tag+' NO [NONEXISTENT] Unknown mailbox');return;}
   selected=true;reply('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');reply('* '+state.messages.length+' EXISTS');reply('* 0 RECENT');reply('* OK [UIDVALIDITY 1] UIDs valid');reply('* OK [UIDNEXT '+state.nextId+'] Next UID');reply(tag+' OK [READ-WRITE] SELECT completed');return;
  }
  if(!selected){reply(tag+' NO Select INBOX first');return;}
  if(verb==='SEARCH'){
   if(!/^(?:CHARSET US-ASCII )?(?:ALL|UNSEEN|NOT SEEN)$/iu.test(args)){reply(tag+' BAD Unsupported search');return;}
   reply('* SEARCH'+state.messages.map((_,i)=>' '+(i+1)).join(''));reply(tag+' OK SEARCH completed');return;
  }
  if(verb==='FETCH'){
   const fetch=args.match(/^([1-9][0-9]*) \(?RFC822\.HEADER\)?$/iu),item=fetch&&state.messages[Number(fetch[1])-1];
   if(!item){reply(tag+' NO Message unavailable');return;}
   socket.write(Buffer.concat([Buffer.from('* '+fetch[1]+' FETCH (RFC822.HEADER {'+item.headers.length+'}\r\n'),item.headers,Buffer.from(')\r\n'+tag+' OK FETCH completed\r\n')]));return;
  }
  if(verb==='STORE'){
   const store=args.match(/^([1-9][0-9]*) \+FLAGS(?:\.SILENT)? \(\\Deleted\)$/iu),item=store&&state.messages[Number(store[1])-1];
   if(!item){reply(tag+' BAD Unsupported store');return;}item.deleted=true;reply('* '+store[1]+' FETCH (FLAGS (\\Deleted))');reply(tag+' OK STORE completed');return;
  }
  if(verb==='EXPUNGE'){
   for(let i=0;i<state.messages.length;){const item=state.messages[i];if(!item.deleted){i++;continue;}
    state.onExpunge?.(item);state.messages.splice(i,1);state.deleted.push(item.marker);reply('* '+(i+1)+' EXPUNGE');}
   reply(tag+' OK EXPUNGE completed');return;
  }
  reply(tag+' BAD Unsupported command');
 },upgrade,8192);
}
export async function startMailboxFixture(config){
 assert.equal(process.env.WASALX_MAILBOX_FIXTURE_ISOLATED,'1','Explicit isolated fixture admission required');
 const auth=JSON.parse(readFileSync(config.authFile,'utf8')),state=createMailboxState(config,auth),token=readFileSync(config.controlTokenFile,'utf8').trim();assert(token.length>=32);
 const tlsOptions={key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile),minVersion:'TLSv1.2'},context=tls.createSecureContext(tlsOptions);
 const sockets=new Set(),servers=[];
 const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});if(sockets.size>16)socket.destroy();return socket;};
 const upgrade=(attach,transport)=>raw=>{const secure=new tls.TLSSocket(raw,{isServer:true,secureContext:context});track(secure);attach(secure,state,{secure:true,transport,greeting:false});secure.resume();};
 const smtpTls=tls.createServer(tlsOptions,socket=>attachSmtp(track(socket),state,{secure:true,transport:'SMTP_TLS'}));
 const smtpStarttls=net.createServer(socket=>attachSmtp(track(socket),state,{upgrade:upgrade(attachSmtp,'SMTP_STARTTLS')}));
 const imapTls=tls.createServer(tlsOptions,socket=>attachImap(track(socket),state,{secure:true,transport:'IMAP_TLS'}));
 const imapStarttls=net.createServer(socket=>attachImap(track(socket),state,{upgrade:upgrade(attachImap,'IMAP_STARTTLS')}));
 for(const server of [smtpTls,imapTls])server.on('tlsClientError',()=>{});
 const control=http.createServer((request,response)=>{
  const send=(status,body)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body));};
  if(request.method==='GET'&&request.url==='/healthz'){send(200,{mode:'SIMULATED',ready:true});return;}
  if(request.method==='GET'&&request.url==='/audit'){send(200,state.audit());return;}
  if(request.method!=='POST'||request.url!=='/control'||!equal(request.headers.authorization??'','Bearer '+token)){send(403,{error:'Fixture control unavailable'});return;}
  let bytes=0,body='';request.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024){request.destroy();return;}body+=chunk.toString('utf8');});
  request.on('end',()=>{try{const input=JSON.parse(body);assert(input&&typeof input==='object'&&!Array.isArray(input));
    assert(Object.keys(input).every(key=>['deny_smtp_starttls','deny_imap_starttls','reset'].includes(key)));assert(Object.values(input).every(value=>typeof value==='boolean'));
    if(input.reset){if(sockets.size){send(409,{error:'Fixture connections active'});return;}state.reset();}
    for(const key of ['deny_smtp_starttls','deny_imap_starttls'])if(Object.hasOwn(input,key))state.modes[key]=input[key];send(200,{modes:state.modes});
   }catch{send(400,{error:'Invalid fixture control'});}});
 });
 const bind=async(server,port)=>{assert(Number.isInteger(port)&&port>=1&&port<=65535);servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,config.host??'127.0.0.1',resolve);});};
 try{await bind(smtpTls,config.ports.smtpTls);await bind(smtpStarttls,config.ports.smtpStarttls);await bind(imapTls,config.ports.imapTls);await bind(imapStarttls,config.ports.imapStarttls);await bind(control,config.ports.control);}
 catch(error){for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));throw error;}
 return {state,close:async()=>{for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const config=JSON.parse(readFileSync(process.argv[2],'utf8'));const fixture=await startMailboxFixture(config);
 process.once('SIGTERM',()=>void fixture.close().then(()=>process.exit(0)));process.once('SIGINT',()=>void fixture.close().then(()=>process.exit(0)));
 // Never log commands, AUTH arguments, mailbox bodies or private keys.
 process.stdout.write(JSON.stringify({mode:'SIMULATED',ready:true,ports:config.ports})+'\n');
}
