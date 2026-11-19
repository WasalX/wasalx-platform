import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const passwordLengthLimit=4096;
function passwordBlock(password){
  // Compare fixed-size buffers and bind the byte length so padding cannot affect equality.
  const block=Buffer.alloc(2+3*passwordLengthLimit);
  block.writeUInt16BE(block.write(password,2,'utf8'));
  return block;
}
export function createSmtpBoundary({journal, faults=[], tls:tlsConfig, authFile, allowedRecipients=[], allowedSenders, onAccepted}) {
  assert.equal(Boolean(tlsConfig),Boolean(authFile),'TLS and AUTH must be enabled together');
  const auth=authFile?JSON.parse(fs.readFileSync(authFile,'utf8')):null;
  if(auth){assert.match(auth.username,/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u);assert.equal(typeof auth.password,'string');assert(auth.password.length>=8&&auth.password.length<=passwordLengthLimit);if(process.platform!=='win32')assert.equal(fs.statSync(authFile).mode&0o077,0);}
  const expectedPassword=auth?passwordBlock(auth.password):null;
  for(const recipient of allowedRecipients)assert.match(recipient,/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u);
  if(auth)assert(allowedRecipients.length>0,'Authenticated sink requires explicit recipients');
  const senders=allowedSenders??(auth?[auth.username]:[]);
  assert(Array.isArray(senders)&&new Set(senders).size===senders.length);
  if(auth){assert(senders.length>0);for(const sender of senders)assert.match(sender,/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u);}
  assert(onAccepted===undefined||typeof onAccepted==='function');
  const allowed=recipient=>allowedRecipients.length>0?allowedRecipients.includes(recipient):!auth&&/^[^\s<>@]+@alpha\.invalid$/u.test(recipient);
  const secureOptions=tlsConfig?{key:fs.readFileSync(tlsConfig.keyFile),cert:fs.readFileSync(tlsConfig.certFile),minVersion:'TLSv1.2'}:null;
  const fd=fs.openSync(journal,'a+',0o600); if(process.platform!=='win32')assert.equal(fs.fstatSync(fd).mode&0o077,0);
  const rows=fs.readFileSync(journal,'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const used=new Set(rows.filter(x=>x.faultId).map(x=>x.faultId));
  for(const f of faults){assert.match(f.id,/^[\w-]+$/u);assert(allowed(f.recipient));assert.ok(['reject','disconnect-before','disconnect-after'].includes(f.kind));}
  assert.equal(new Set(faults.map(x=>x.id)).size,faults.length);
  const append=row=>{fs.writeSync(fd,JSON.stringify({...row,at:new Date().toISOString()})+'\n');fs.fsyncSync(fd);};
  const handleConnection=socket=>{
    let buffer=Buffer.alloc(0),data=false,parts=[],size=0,from=null,recipients=[],authenticated=!auth,authPending=false;
    const reply=x=>socket.write(x+'\r\n'); const reset=()=>{data=false;parts=[];size=0;from=null;recipients=[];};
    socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});reply('220 alpha.invalid isolated SMTP');
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>2*1024*1024){socket.destroy();return;}
      let end;while((end=buffer.indexOf('\r\n'))>=0){const bytes=buffer.subarray(0,end);buffer=buffer.subarray(end+2);const line=bytes.toString('ascii');
        const authenticate=value=>{let fields;try{assert.match(value,/^[a-zA-Z0-9+/]*={0,2}$/u);fields=Buffer.from(value,'base64').toString('utf8').split('\0');}catch{reply('535 5.7.8 Authentication rejected');return;}
          const ok=fields.length===3&&(!fields[0]||fields[0]===auth.username)&&fields[1]===auth.username
            &&fields[2].length<=passwordLengthLimit&&timingSafeEqual(passwordBlock(fields[2]),expectedPassword);
          authenticated=ok;reply(ok?'235 2.7.0 Authenticated':'535 5.7.8 Authentication rejected');};
        if(authPending){authPending=false;authenticate(line);continue;}
        if(!data&&/^AUTH(?: |$)/iu.test(line)){
          if(!auth||!socket.encrypted){reply('538 Encryption required');continue;}
          if(authenticated||from!==null){reply('503 Invalid authentication sequence');continue;}
          const match=line.match(/^AUTH PLAIN(?: ([A-Za-z0-9+/=]+))?$/iu);if(!match){reply('504 Unsupported authentication');continue;}
          if(match[1])authenticate(match[1]);else{authPending=true;reply('334 ');}continue;
        }
        if(data){
          if(line!=='.'){const unstuffed=bytes[0]===46?bytes.subarray(1):bytes;size+=unstuffed.length+2;if(size>1024*1024){socket.destroy();return;}parts.push(unstuffed,Buffer.from('\r\n'));continue;}
          const raw=Buffer.concat(parts);
          if(auth&&raw.includes(Buffer.from(auth.password))){reset();reply('550 Credential content rejected');continue;}
          const fault=faults.find(x=>!used.has(x.id)&&recipients.includes(x.recipient));
          if(fault){used.add(fault.id);append({type:'fault-consumed',faultId:fault.id,kind:fault.kind});}
          if(fault?.kind==='disconnect-before'){socket.destroy();return;}
          if(fault?.kind==='reject'){append({type:'rejected',from,recipients,sha256:createHash('sha256').update(raw).digest('hex'),bytesBase64:raw.toString('base64')});reset();reply('550 5.1.1 Simulated rejection');continue;}
          const sha256=createHash('sha256').update(raw).digest('hex');
          append({type:'accepted',from,recipients,sha256,bytesBase64:raw.toString('base64')});
          try{onAccepted?.({from,recipients:[...recipients],sha256,raw:Buffer.from(raw)});}catch{reset();socket.destroy();return;}
          reset();
          if(fault?.kind==='disconnect-after'){socket.destroy();return;}
          reply('250 2.0.0 Accepted');continue;
        }
        if(/^(EHLO|HELO) /iu.test(line)){reply('250-alpha.invalid');if(auth)reply('250-AUTH PLAIN');reply('250 SIZE 1048576');}
        else if(/^MAIL FROM:/iu.test(line)){if(!authenticated){reply('530 Authentication required');continue;}const m=line.match(/^MAIL FROM:<([^<>\s]*)>(?: SIZE=\d+)?$/iu);if(!m){reply('501 Syntax');continue;}if(auth&&!senders.includes(m[1])){reply('553 Sender does not match authenticated account');continue;}reset();from=m[1];reply('250 OK');}
        else if(/^RCPT TO:/iu.test(line)){const m=line.match(/^RCPT TO:<([^<>\s]+)>$/iu);if(from===null){reply('503 MAIL required');continue;}if(!m||!allowed(m[1])){reply('550 Relay prohibited');continue;}recipients.push(m[1]);reply('250 OK');}
        else if(line.toUpperCase()==='DATA'){if(!recipients.length){reply('503 RCPT required');continue;}data=true;reply('354 End with dot');}
        else if(line.toUpperCase()==='RSET'){reset();reply('250 OK');}
        else if(line.toUpperCase()==='QUIT'){reply('221 Bye');socket.end();return;}
        else if(line.toUpperCase()==='NOOP')reply('250 OK');else reply('502 Unsupported');
      }
    });
  };
  const server=secureOptions?tls.createServer(secureOptions,handleConnection):net.createServer(handleConnection);
  server.on('tlsClientError',()=>{});
  server.on('close',()=>fs.closeSync(fd));return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));assert.equal(config.isolated,true);
 createSmtpBoundary(config).listen(config.port??2525,config.host??'127.0.0.1');
}
