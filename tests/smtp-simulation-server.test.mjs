import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {createSmtpBoundary} from '../scripts/contracts/smtp-simulation-server.mjs';
const exec=(file,args)=>new Promise((resolve,reject)=>execFile(file,args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
test('independent Python SMTP client verifies dot framing, rejection, unknown acceptance and restart fencing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'smtp-alpha-')),journal=join(dir,'journal.jsonl');
 const faults=[{id:'reject',recipient:'reject@alpha.invalid',kind:'reject'},{id:'before',recipient:'before@alpha.invalid',kind:'disconnect-before'},{id:'after',recipient:'after@alpha.invalid',kind:'disconnect-after'}];
 let server=createSmtpBoundary({journal,faults});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const run=async(recipient)=>exec(process.platform==='win32'?'python':'python3',['-c',String.raw`import smtplib,sys
s=smtplib.SMTP('127.0.0.1',int(sys.argv[1]),timeout=3)
try:
 s.sendmail('sender@alpha.invalid',[sys.argv[2]],b'Message-ID: <test@alpha.invalid>\r\n\r\n.first\r\n..second\r\n')
 print('accepted')
except smtplib.SMTPDataError: print('rejected')
except smtplib.SMTPServerDisconnected: print('unknown')
finally: s.close()
`,String(server.address().port),recipient]);
 try{
 assert.match((await run('ok@alpha.invalid')).stdout,/accepted/);
 assert.match((await run('reject@alpha.invalid')).stdout,/rejected/);
 assert.match((await run('before@alpha.invalid')).stdout,/unknown/);
 assert.match((await run('after@alpha.invalid')).stdout,/unknown/);
 let rows=(await readFile(journal,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.type==='accepted').length,2);
 assert.ok(Buffer.from(rows.find(r=>r.type==='accepted').bytesBase64,'base64').toString().includes('\r\n.first\r\n..second\r\n'));
 await new Promise(r=>server.close(r));server=createSmtpBoundary({journal,faults});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 assert.match((await run('reject@alpha.invalid')).stdout,/accepted/);
 rows=(await readFile(journal,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.type==='fault-consumed').length,3);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('plain SMTP nonempty allowlist rejects unowned recipients before DATA without journaling',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'smtp-exact-')),journal=join(dir,'journal.jsonl');
 const server=createSmtpBoundary({journal,allowedRecipients:['owned@alpha.invalid']});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const result=await exec(process.platform==='win32'?'python':'python3',['-c',String.raw`import smtplib,sys,json
s=smtplib.SMTP('127.0.0.1',int(sys.argv[1]),timeout=3)
try:
 s.ehlo()
 rows=[]
 for recipient in ['owned@alpha.invalid','unowned@alpha.invalid','outside@example.com']:
  assert s.mail('sender@alpha.invalid')[0]==250
  rows.append([recipient,s.rcpt(recipient)[0]])
  s.rset()
 print(json.dumps(rows))
finally: s.close()
`,String(server.address().port)]);
  assert.deepEqual(JSON.parse(result.stdout),[['owned@alpha.invalid',250],['unowned@alpha.invalid',550],['outside@example.com',550]]);
  assert.equal(await readFile(journal,'utf8'),'','Rejected RCPT transactions must not produce journal records');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
