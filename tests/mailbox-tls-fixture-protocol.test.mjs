// Socket doubles only: these tests never bind a listener or start a resource.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createMailboxState,attachSmtp,attachImap} from '../scripts/contracts/mailbox-tls-fixture.mjs';
class Socket extends EventEmitter{
 constructor(){super();this.output=[];this.destroyed=false;}
 write(value){this.output.push(Buffer.from(value));return true;}
 setTimeout(){} pause(){} resume(){} end(){this.ended=true;} destroy(){this.destroyed=true;}
 send(value){this.emit('data',Buffer.from(value));}
 text(){return Buffer.concat(this.output).toString('utf8');}
}
const mailbox='owned-mailbox@mailbox.synthetic.test',password='synthetic-only-private-password';
const marker='wasalx-mail-10000000-0000-4000-8000-000000000001';
const state=()=>createMailboxState({isolated:true,mailbox},{username:mailbox,password});
const auth=()=>Buffer.from('\0'+mailbox+'\0'+password).toString('base64');
const raw=()=>Buffer.from('From: '+mailbox+'\r\nTo: '+mailbox+'\r\nSubject: WasalX verification '+marker+'\r\nX-Zammad-Test-Message: '+marker+'\r\n\r\nSynthetic verification body\r\n');
test('secure SMTP accepts one owned marker, audits BCC/recipient attempts without AUTH content',()=>{
 assert(('Subject: WasalX verification '+marker).length<=78);
 const s=state(),socket=new Socket();attachSmtp(socket,s,{secure:true,transport:'SMTP_TLS'});
 socket.send('EHLO synthetic.test\r\nAUTH PLAIN '+auth()+'\r\nMAIL FROM:<'+mailbox+'>\r\nRCPT TO:<'+mailbox+'>\r\nDATA\r\n');
 socket.send(raw());socket.send('.\r\nQUIT\r\n');assert.equal(s.accepted.length,1);assert.deepEqual(s.accepted[0].recipients,[mailbox]);
 assert.equal(s.messages.length,1);assert.equal(s.accepted[0].header_bcc_present,false);assert.equal(s.authAttempts[0].secure,true);
 assert.ok(!JSON.stringify(s.audit()).includes(password));assert.ok(!JSON.stringify(s.audit()).includes(raw().toString('base64')));
 const other=new Socket();attachSmtp(other,s,{secure:true});other.send('AUTH PLAIN '+auth()+'\r\nMAIL FROM:<'+mailbox+'>\r\nRCPT TO:<archive-outside@example.test>\r\n');
 assert.match(other.text(),/550 Relay prohibited/u);assert.equal(s.recipientAttempts.at(-1).address,'REDACTED_OUTSIDE_SYNTHETIC');assert.equal(s.accepted.length,1);
});
test('plaintext AUTH and missing STARTTLS fail closed; pipelined plaintext cannot cross upgrade',()=>{
 const s=state();s.modes.deny_smtp_starttls=true;const socket=new Socket();attachSmtp(socket,s);
 socket.send('EHLO synthetic.test\r\nSTARTTLS\r\nAUTH PLAIN '+auth()+'\r\n');assert.doesNotMatch(socket.text(),/250-STARTTLS/u);assert.match(socket.text(),/454/u);assert.match(socket.text(),/538/u);assert.equal(s.authAttempts[0].success,false);
 s.modes.deny_smtp_starttls=false;const pipelined=new Socket();let upgrades=0;attachSmtp(pipelined,s,{upgrade:()=>upgrades++});
 pipelined.send('STARTTLS\r\nAUTH PLAIN '+auth()+'\r\n');assert.equal(upgrades,0);assert.equal(pipelined.destroyed,true);assert.equal(s.accepted.length,0);
 const valid=new Socket();attachSmtp(valid,s,{upgrade:()=>upgrades++});valid.send('STARTTLS\r\n');assert.equal(upgrades,1);
});
test('IMAP serves literal native verification headers and deletes exactly its selected marker',()=>{
 const s=state();s.accept(mailbox,[mailbox],raw(),'SMTP_TLS');const socket=new Socket();attachImap(socket,s,{secure:true,transport:'IMAP_TLS'});
 socket.send('R1 LOGIN "'+mailbox+'" "'+password+'"\r\nR2 SELECT INBOX\r\nR3 SEARCH ALL\r\nR4 FETCH 1 (RFC822.HEADER)\r\n');
 assert.match(socket.text(),/R1 OK Authenticated/u);assert.match(socket.text(),/\* SEARCH 1/u);
 assert.ok(socket.text().includes('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)'));
 assert.ok(socket.text().includes('RFC822.HEADER {'+s.messages[0].headers.length+'}\r\n'));assert.ok(!socket.text().includes('Synthetic verification body'));
 socket.send('R5 STORE 1 +FLAGS (\\Deleted)\r\nR6 EXPUNGE\r\n');assert.equal(s.messages.length,0);assert.deepEqual(s.deleted,[marker]);assert.equal(s.accepted.length,1);assert.ok(!socket.text().includes(password));
});
test('IMAP STARTTLS denial does not authenticate and unexpected messages never enter spool',()=>{
 const s=state();s.modes.deny_imap_starttls=true;const socket=new Socket();attachImap(socket,s);
 socket.send('R1 STARTTLS\r\nR2 LOGIN '+mailbox+' '+password+'\r\n');assert.match(socket.text(),/R1 NO TLS unavailable/u);assert.match(socket.text(),/R2 NO/u);assert.equal(s.authAttempts[0].secure,false);assert.equal(s.messages.length,0);
 assert.throws(()=>s.accept(mailbox,[mailbox],Buffer.from('From: '+mailbox+'\r\n\r\nUnmarked body'),'SMTP_TLS'));
});
