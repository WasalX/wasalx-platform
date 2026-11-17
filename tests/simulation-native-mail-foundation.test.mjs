import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createMailboxState} from '../scripts/contracts/mailbox-tls-fixture.mjs';
import {replayAlphaMailboxJournal} from '../scripts/contracts/alpha-native-mailbox-boundary.mjs';
import {validateSyntheticMailbox,readSyntheticMailboxCredentials} from '../scripts/release/simulation-native-mail-capability.mjs';
const scratch=fileURLToPath(new URL('../output/',import.meta.url));mkdirSync(scratch,{recursive:true});

const namespace='fresh-mail-unit',mailbox='support-'+namespace+'@alpha.invalid';
const config=()=>({schemaVersion:1,namespace,host:'alpha-smtp',mailbox,smtpPort:465,imapPort:993,folder:'INBOX',security:'TLS',allowedSenders:[mailbox],allowedRecipients:[mailbox,'customer@alpha.invalid','failure-'+namespace+'@alpha.invalid'],credentialsReference:'email-native-tls/auth.json',trustReference:'email-native-tls/ca.crt',verification:{recipient:mailbox,mode:'NATIVE_OWNED_SMTP_IMAP'}});
const auth={username:mailbox,password:'synthetic-'.repeat(4)};
const state=()=>createMailboxState({isolated:true,mailbox},auth,{mailboxAllowed:value=>value===mailbox});
const marker='wasalx-mail-00000000-0000-4000-8000-000000000001';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const asset=(path,bytes)=>({path,sha256:sha(bytes),mode:lstatSync(path).mode,uid:lstatSync(path).uid});
const raw=Buffer.from(`From: ${mailbox}\r\nTo: ${mailbox}\r\nSubject: WasalX verification ${marker}\r\nX-Zammad-Test-Message: ${marker}\r\n\r\nVerification\r\n`);
const accepted={type:'accepted',from:mailbox,recipients:[mailbox],sha256:sha(raw),bytesBase64:raw.toString('base64'),at:new Date().toISOString()};
const expunged={type:'mailbox-verification-expunged',uid:1,marker,sha256:sha(raw),at:new Date().toISOString()};

test('journal replay preserves separate verification UID effects and durable expunge',()=>{
 const ordinary=Buffer.from('Subject: Customer mail\r\n\r\nHello\r\n');
 const s=state();replayAlphaMailboxJournal(s,[{...accepted,bytesBase64:ordinary.toString('base64'),sha256:sha(ordinary)},accepted,accepted,expunged]);
 assert.equal(s.messages.length,1);assert.equal(s.messages[0].id,2);assert.deepEqual(s.deleted,[marker]);assert.equal(s.nextId,3);
});
test('replay rejects unmatched, repeated, corrupt and malformed deletion evidence',()=>{
 for(const rows of [[expunged],[accepted,expunged,expunged],[{...accepted,sha256:'0'.repeat(64)}],[accepted,{...expunged,uid:2}],[accepted,{...expunged,at:'yesterday'}],[accepted,{...expunged,extra:true}]])assert.throws(()=>replayAlphaMailboxJournal(state(),rows));
});
test('diagnostic mailbox default stays narrow; current fixture uses exact owner admission',()=>{
 assert.throws(()=>createMailboxState({isolated:true,mailbox},auth));
 assert.throws(()=>state().accept(mailbox,['outside@example.com'],raw,'SMTP_TLS'));
 assert.throws(()=>state().accept(mailbox,[mailbox],Buffer.from(raw.toString().replace('Verification\r\n',auth.password+'\r\n')),'SMTP_TLS'));
});
test('single mailbox contract rejects insecure, cross-namespace and invented fields',()=>{
 assert.deepEqual(validateSyntheticMailbox(config()),config());
 for(const patch of [{smtpPort:2525},{security:'PLAIN'},{namespace:'other'},{credentialsReference:'../auth.json'},{extra:true}])assert.throws(()=>validateSyntheticMailbox({...config(),...patch},namespace));
});
test('private credential capability checks owner, private mode and exact shape',async()=>{
 const root=mkdtempSync(join(scratch,'wasalx-mail-unit-'));try{
  mkdirSync(join(root,'email-native-tls'),{mode:0o700});const path=join(root,'email-native-tls','auth.json');writeFileSync(path,JSON.stringify(auth),{mode:0o600});
  const session={model:{name:'wasalx-simulation-unit'},privateDir:root};assert.deepEqual(await readSyntheticMailboxCredentials(session,config()),auth);
  await assert.rejects(readSyntheticMailboxCredentials({...session,model:{name:'unowned'}},config()));
  writeFileSync(path,JSON.stringify({...auth,extra:true}));await assert.rejects(readSyntheticMailboxCredentials(session,config()));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('preparation census includes new mail readonly assets and validates prior immutable bytes',()=>{
 const root=mkdtempSync(join(scratch,'wasalx-mail-census-'));try{
  const paths=['model.json','overlay.json','ca.crt','auth.json','config.json'].map(name=>join(root,name));paths.forEach((path,index)=>writeFileSync(path,'synthetic-'+index,{mode:0o600}));
  const receipt={modelSha256:sha('synthetic-0'),generatedImmutableFiles:[asset(paths[2],'synthetic-2')]};
  const model={services:{smtp:{volumes:paths.slice(2).map(source=>({type:'bind',read_only:true,source}))}}},composeArgs=['compose','-f',paths[0],'-f',paths[1]];
  const helper=fileURLToPath(new URL('../scripts/release/simulation-native-mail-bootstrap.py',import.meta.url));
  const code="import importlib.util,json,sys; s=importlib.util.spec_from_file_location('mail_assets',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); p=json.load(sys.stdin); print(json.dumps(m.freeze_selected_assets(p['receipt'],p['model'],p['composeArgs'],p['root'])))";
  const run=()=>spawnSync(process.platform==='win32'?'python':'python3',['-c',code,helper],{input:JSON.stringify({receipt,model,composeArgs,root}),encoding:'utf8',windowsHide:true});
  const result=run();assert.equal(result.status,0,result.stderr);const frozen=JSON.parse(result.stdout);
  assert.deepEqual(frozen.selectedCompose.map(row=>row.path),paths.slice(0,2));assert.deepEqual(frozen.generatedImmutableFiles.map(row=>row.path).sort(),paths.slice(2).sort());
  writeFileSync(paths[2],'changed');assert.notEqual(run().status,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
