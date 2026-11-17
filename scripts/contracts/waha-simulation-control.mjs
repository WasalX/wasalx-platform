import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {lstat,chmod} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';

export async function dispatchSimulationControl(provider,command){
  assert(command&&typeof command==='object');
  if(command.action==='arm-next-send')return provider.armNextSend(command.input);
  if(command.action==='read-arms')return provider.readArms();
  if(command.action==='state'){provider.simulateState(command.state);return {applied:true};}
  if(command.action==='mutation')return provider.emitMutation(command.input);
  if(command.action==='session-status')return provider.emitSessionStatus(command.input);
  if(command.action==='inbound')return provider.emitInbound(command.input);
  if(command.action==='ack')return provider.emitAck(command.input);
  throw Error('Unsupported simulation control');
}
// The owned socket lives inside a 0700 directory, never on provider TCP.
export async function startSimulationControl(provider,socketPath){
  assert(process.platform!=='win32'&&isAbsolute(socketPath),'Linux absolute socket path required');
  assert(Buffer.byteLength(socketPath,'utf8')<=107,'Simulation control socket path too long');
  const directory=await lstat(dirname(socketPath));assert(directory.isDirectory()&&!directory.isSymbolicLink()&&(directory.mode&0o077)===0,'Private owned socket directory required');
  assert(directory.uid===process.getuid(),'Socket directory owner mismatch');
  try{await lstat(socketPath);throw Error('Socket path already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  const control=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method!=='POST'||req.url!=='/command'){res.writeHead(404);res.end('{}');return;}
    try{
      let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('Too large');chunks.push(chunk);}
      const result=await dispatchSimulationControl(provider,JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify(result));
    }catch{res.writeHead(400);res.end('{"error":"simulation-control-rejected"}');}
  });
  control.requestTimeout=10000;control.headersTimeout=10000;
  await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(socketPath,resolve);});
  try{await chmod(socketPath,0o600);return control;}catch(error){await new Promise(resolve=>control.close(resolve));throw error;}
}
export function callSimulationControl(socketPath,command){
  return new Promise((resolve,reject)=>{
    const req=request({socketPath,path:'/command',method:'POST',headers:{'content-type':'application/json'},timeout:15000},res=>{
      let size=0,chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(Error('Control response too large'));}else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200);resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Control request rejected'));}});
    });
    req.on('timeout',()=>req.destroy(Error('Control timeout')));req.on('error',reject);req.end(JSON.stringify(command));
  });
}
