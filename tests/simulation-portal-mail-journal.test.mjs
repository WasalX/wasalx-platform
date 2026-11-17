import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {parseSmtpEffectRows} from '../scripts/release/simulation-mail-assertions.mjs';
const mailbox='support-journal@alpha.invalid',marker='wasalx-mail-10000000-0000-4000-8000-000000000001';
const raw=Buffer.from('From: '+mailbox+'\r\nTo: '+mailbox+'\r\nSubject: WasalX verification '+marker+'\r\nX-Zammad-Test-Message: '+marker+'\r\nMessage-ID: <probe@alpha.invalid>\r\n\r\nSynthetic\r\n');
const accepted={type:'accepted',from:mailbox,recipients:[mailbox],bytesBase64:raw.toString('base64'),sha256:createHash('sha256').update(raw).digest('hex')};
const deleted={type:'mailbox-verification-expunged',uid:1,marker,sha256:accepted.sha256,at:'2026-10-18T00:00:00Z'};
const encode=rows=>Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n'));
const parse=async()=>({messageId:'probe@alpha.invalid',subject:'WasalX verification '+marker});
const options={allowVerification:true,verificationMailbox:mailbox};
test('current journal preserves exact verification accepts and expunges, historical parser rejects additions',async()=>{
 const rows=await parseSmtpEffectRows(encode([accepted,deleted]),parse,options);assert.equal(rows.length,2);assert.equal(rows[0].bytesBase64,accepted.bytesBase64);assert.equal(rows[1].uid,1);
 await assert.rejects(parseSmtpEffectRows(encode([accepted,deleted]),parse));
});
test('identical wire acceptances remain two UIDs and cannot be coalesced or expunged twice',async()=>{
 assert.equal((await parseSmtpEffectRows(encode([accepted,accepted,deleted,{...deleted,uid:2}]),parse,options)).length,4);
 for(const rows of[[accepted,deleted,deleted],[accepted,{...deleted,uid:2}],[deleted,accepted],[accepted,{...deleted,sha256:'f'.repeat(64)}]])await assert.rejects(parseSmtpEffectRows(encode(rows),parse,options));
});
test('verification metadata cannot admit wrong recipient, sender, marker or unknown fields',async()=>{
 for(const row of[{...accepted,from:'other@alpha.invalid'},{...accepted,recipients:['other@alpha.invalid']}])await assert.rejects(parseSmtpEffectRows(encode([row,deleted]),parse,options));
 await assert.rejects(parseSmtpEffectRows(encode([accepted,{...deleted,secret:'PRIVATE'}]),parse,options));
 await assert.rejects(parseSmtpEffectRows(encode([accepted,deleted]),parse,{allowVerification:true}));
});
