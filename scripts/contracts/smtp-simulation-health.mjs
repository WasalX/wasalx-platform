import tls from 'node:tls';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function smtpTlsHealth({port=465,servername='alpha-smtps',ca}) {
 return new Promise(resolve=>{
  let done=false,received='';
  const socket=tls.connect({host:'127.0.0.1',port,servername,ca,rejectUnauthorized:true,minVersion:'TLSv1.2'});
  const finish=ok=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(ok);};
  const timer=setTimeout(()=>finish(false),2500);
  socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));
  socket.on('data',data=>{received+=data.toString('ascii');if(received.length>4096)return finish(false);if(received.includes('\r\n'))finish(socket.authorized&&/^220 [^\r\n]*\r\n/u.test(received));});
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{process.exitCode=await smtpTlsHealth({ca:readFileSync('/run/wasalx-simulation/ca.crt')})?0:1;}catch{process.exitCode=1;}
}
