// Qualification-only file access. Mount evidence is never replaced by a host mirror.
import assert from 'node:assert/strict';
import {readFile,open,rename,stat,chown} from 'node:fs/promises';
import {join} from 'node:path';
import {platform} from 'node:os';
import {createHash} from 'node:crypto';
import {isOwnedMailPath} from './simulation-mail-record.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
const limits={'config.json':8192,'journal.jsonl':16*1024*1024};
export function assertSmtpFilename(name){assert(Object.hasOwn(limits,name),'Unsupported SMTP file');return limits[name];}
export function smtpVolumeName(model,mount){
 const entries=(model.services['alpha-smtp'].volumes??[]).map(v=>typeof v==='string'?{source:v.split(':')[0],target:v.split(':')[1],type:'volume'}:v);
 const declared=entries.filter(v=>v.target==='/run/wasalx-simulation');assert.equal(declared.length,1);assert.equal(declared[0].type,'volume');
 const expected=model.volumes?.[declared[0].source]?.name??model.name+'_'+declared[0].source;
 assert.equal(mount.Name,expected);return expected;
}
// Actual Linux UID/mode, stable bytes and durable replacement are checked inside the sink.
export const smtpNativeFileProgram=String.raw`const fs=require('fs'),assert=require('assert').strict,crypto=require('crypto');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');const root='/run/wasalx-simulation';const [action,name,payload]=process.argv.slice(1);const limits={'config.json':8192,'journal.jsonl':16777216};assert(Object.hasOwn(limits,name));const directory=fs.lstatSync(root);assert(directory.isDirectory()&&!directory.isSymbolicLink());assert.equal(directory.uid,process.getuid());assert.equal(directory.mode&63,0);const path=root+'/'+name;function read(){const s=fs.lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,process.getuid());assert.equal(s.mode&511,384);assert(s.size<=limits[name]);const b=fs.readFileSync(path);const after=fs.lstatSync(path);assert.equal(after.ino,s.ino);assert.equal(after.size,b.length);assert.equal(after.mtimeMs,s.mtimeMs);return b;}if(action==='read'){const b=read();process.stdout.write(JSON.stringify({bytesBase64:b.toString('base64'),sha256:sha(b)}));}else{assert.equal(action,'replace');assert.equal(name,'config.json');const p=JSON.parse(Buffer.from(payload,'base64'));assert.match(p.namespace,/^[A-Za-z0-9-]{1,60}$/);assert.equal(sha(read()),p.beforeSha256);const data=Buffer.from(p.bytesBase64,'base64');assert(data.length<=limits[name]);assert.equal(sha(data),p.afterSha256);assert.equal(JSON.parse(data).isolated,true);const temp=root+'/.config-'+p.namespace+'.json';const fd=fs.openSync(temp,'wx',384);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}assert.equal(sha(read()),p.beforeSha256);fs.renameSync(temp,path);const directoryFd=fs.openSync(root,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}assert.equal(sha(read()),p.afterSha256);process.stdout.write(JSON.stringify({beforeSha256:p.beforeSha256,afterSha256:p.afterSha256,atomic:true}));}`;
export async function ownedSmtpFiles(s,container){
 const project=s.model.name;assert(project.startsWith('wasalx-simulation-'));assert.match(container.Id,/^[a-f0-9]{64}$/);assert.equal(container.Config.Labels['com.docker.compose.project'],project);assert.equal(container.Config.Labels['com.docker.compose.service'],'alpha-smtp');assert.equal(container.State.Status,'running');
 const mount=container.Mounts.filter(m=>m.Destination==='/run/wasalx-simulation');assert.equal(mount.length,1);const m=mount[0];assert.equal(m.RW,true);
 let hostDirectory;
 if(m.Type==='bind'){assert(isOwnedMailPath(s.privateDir,m.Source));hostDirectory=m.Source;}
 else{
  assert.equal(m.Type,'volume');assert.equal(container.Config.Image,s.model.services['alpha-smtp'].image);const expected=smtpVolumeName(s.model,m),owner=s.model.services['alpha-smtp'].labels?.['io.wasalx.owner.task'];assert.match(owner??'',/^[a-f0-9-]{36}$/);assert.equal(container.Config.Labels['io.wasalx.owner.task'],owner);
  const rows=JSON.parse(await s.run('docker',['volume','inspect',expected]));assert.equal(rows.length,1);assert.equal(rows[0].Name,expected);assert.equal(rows[0].Labels['com.docker.compose.project'],project);assert.equal(rows[0].Labels['io.wasalx.owner.task'],owner);
 }
 async function read(name){const limit=assertSmtpFilename(name);if(hostDirectory){const b=await readFile(join(hostDirectory,name));assert(b.length<=limit);return b;}const result=JSON.parse(await s.run('docker',['exec',container.Id,'node','-e',smtpNativeFileProgram,'read',name]));assert.match(result.sha256,/^[a-f0-9]{64}$/);const b=Buffer.from(result.bytesBase64,'base64');assert(b.length<=limit);assert.equal(digest(b),result.sha256);return b;}
 async function replaceConfig(original,desired,namespace){assert.match(namespace,/^[A-Za-z0-9-]{1,60}$/);const before=await read('config.json');assert.deepEqual(JSON.parse(before),original,'SMTP configuration drift; no overwrite');assert.equal(desired.isolated,true);const data=Buffer.from(JSON.stringify(desired));assert(data.length<=limits['config.json']);const expected={beforeSha256:digest(before),afterSha256:digest(data),atomic:true};
  if(hostDirectory){const path=join(hostDirectory,'config.json'),temp=path+'.'+namespace,ownership=await stat(path);const fd=await open(temp,'wx',0o600);try{await fd.writeFile(data);if(platform()!=='win32')await chown(temp,ownership.uid,ownership.gid);await fd.sync();}finally{await fd.close();}assert.equal(digest(await read('config.json')),expected.beforeSha256);await rename(temp,path);if(platform()!=='win32'){const dir=await open(hostDirectory,'r');try{await dir.sync();}finally{await dir.close();}}assert.equal(digest(await read('config.json')),expected.afterSha256);}
  else{const payload=Buffer.from(JSON.stringify({...expected,bytesBase64:data.toString('base64'),namespace})).toString('base64');const result=JSON.parse(await s.run('docker',['exec',container.Id,'node','-e',smtpNativeFileProgram,'replace','config.json',payload]));assert.deepEqual(result,expected);}
  return expected;
 }
 return {read,replaceConfig,container};
}
