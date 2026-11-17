// Certificate bootstrap only: never starts a listener, container or database action.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {prepareMailboxFixture,MAILBOX_FIXTURE_NODE_IMAGE} from '../scripts/contracts/prepare-mailbox-tls-fixture.mjs';
test('ephemeral certificate bootstrap has one verified name, unrelated trust rejection and isolated mounts',async()=>{
 const output=resolve('output/playwright/inbox');await mkdir(output,{recursive:true});
 const owner=await mkdtemp(join(output,'mailbox-tls-cert-check-'));
 assert(owner.startsWith(output+sep)&&owner!==output);
 try{
  const prepared=await prepareMailboxFixture(owner);
  const certificate=async name=>new X509Certificate(await readFile(join(prepared.privateDir,name+'.crt')));
  const [ca,untrusted,server]=await Promise.all(['ca','untrusted-ca','server'].map(certificate));
  assert.equal(ca.ca,true);assert.equal(untrusted.ca,true);assert.equal(server.ca,false);
  assert.equal(server.verify(ca.publicKey),true);assert.equal(server.verify(untrusted.publicKey),false);
  assert.equal(server.checkHost('mailbox.synthetic.test'),'mailbox.synthetic.test');
  assert.equal(server.checkHost('mismatch.mailbox.synthetic.test'),undefined);
  assert.equal(server.subjectAltName,'DNS:mailbox.synthetic.test');
  assert(Date.parse(server.validTo)>Date.now()&&Date.parse(server.validTo)<Date.now()+3*86_400_000);
  assert.equal(prepared.service.image,MAILBOX_FIXTURE_NODE_IMAGE);assert.equal(prepared.service.pull_policy,'never');
  assert.deepEqual(prepared.service.ports,[]);assert.deepEqual(prepared.networks,{'mailbox-fixture':{internal:true}});
  assert.deepEqual(Object.keys(prepared.service.networks),['mailbox-fixture']);
  assert.equal(prepared.service.read_only,true);assert.deepEqual(prepared.service.cap_drop,['ALL']);
  assert(prepared.nativeVolumes.every(bind=>bind.read_only&&!bind.source.endsWith('.key')));
  assert.equal(prepared.nativeEnvironment.SSL_CERT_FILE,'/run/wasalx-mailbox-fixture/ca.crt');
  const auth=JSON.parse(await readFile(join(prepared.privateDir,'auth.json'),'utf8'));
  assert.equal(auth.username,'owned-mailbox@mailbox.synthetic.test');assert.match(auth.password,/^synthetic-[a-f0-9]{48}$/u);
  assert(!JSON.stringify(prepared).includes(auth.password));
  await assert.rejects(prepareMailboxFixture(owner),{code:'EEXIST'});
 }finally{
  // Delete only this exact, newly created and containment-checked test directory.
  assert(resolve(owner).startsWith(output+sep)&&resolve(owner)!==output);
  await rm(owner,{recursive:true,force:false});
 }
});
