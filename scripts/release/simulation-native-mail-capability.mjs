// Read-only qualification capability. Never print/serialize the returned value.
import assert from 'node:assert/strict';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';

export function validateSyntheticMailbox(value,namespace=value?.namespace){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),['allowedRecipients','allowedSenders','credentialsReference','folder','host','imapPort','mailbox','namespace','schemaVersion','security','smtpPort','trustReference','verification']);
 assert.match(namespace,/^[A-Za-z0-9-]{1,50}$/u);assert.equal(value.namespace,namespace);assert.equal(value.schemaVersion,1);
 const mailbox='support-'+namespace.toLowerCase()+'@alpha.invalid';
 assert.equal(value.mailbox,mailbox);assert.equal(value.host,'alpha-smtp');assert.equal(value.smtpPort,465);assert.equal(value.imapPort,993);
 assert.equal(value.folder,'INBOX');assert.equal(value.security,'TLS');
 assert.equal(value.credentialsReference,'email-native-tls/auth.json');assert.equal(value.trustReference,'email-native-tls/ca.crt');
 assert.deepEqual(value.verification,{recipient:mailbox,mode:'NATIVE_OWNED_SMTP_IMAP'});
 for(const field of ['allowedSenders','allowedRecipients']){
  const rows=value[field];assert(Array.isArray(rows)&&rows.length>=1&&rows.length<=32&&new Set(rows).size===rows.length&&rows.includes(mailbox));
  for(const email of rows)assert.match(email,/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u);
 }
 assert(value.allowedRecipients.includes('customer@alpha.invalid')&&value.allowedRecipients.includes('failure-'+namespace.toLowerCase()+'@alpha.invalid'));
 return value;
}

export async function readSyntheticMailboxCredentials(session,frozenConfig){
 const config=validateSyntheticMailbox(frozenConfig);
 assert(session.model?.name?.startsWith('wasalx-simulation-'),'Owned simulation model required');
 assert(isAbsolute(session.privateDir));
 const root=await realpath(session.privateDir),path=resolve(root,config.credentialsReference),rel=relative(root,path);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
 let cursor=root;
 for(const part of rel.split(sep)){
  cursor=resolve(cursor,part);const info=await lstat(cursor);
  assert(!info.isSymbolicLink(),'Private mailbox reference must not traverse symlinks');
  if(cursor!==path)assert(info.isDirectory());
 }
 const info=await lstat(path);assert(info.isFile()&&info.size<=8192);
 if(process.platform!=='win32')assert.equal(info.mode&0o077,0,'Synthetic account credentials require private file mode');
 assert.equal(await realpath(path),path);
 const value=JSON.parse(await readFile(path,'utf8'));
 assert.deepEqual(Object.keys(value).sort(),['password','username']);assert.equal(value.username,config.mailbox);
 assert(typeof value.password==='string'&&value.password.length>=16&&value.password.length<=256&&value.password.startsWith('synthetic-')&&!/[\r\n\0]/u.test(value.password));
 return {username:value.username,password:value.password};
}
