import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const clean = value => { assert.equal(typeof value,'string'); assert.ok(value && !/[\r\n]/u.test(value)); return value; };
export function mailFixture({runId, phase, from='customer@alpha.invalid', to='support@alpha.invalid', inReplyTo, attachment}) {
  assert.match(runId,/^[a-zA-Z0-9-]{1,80}$/u); assert.match(phase,/^[a-zA-Z0-9-]{1,40}$/u);
  const messageId=`<${runId}.${phase}@alpha.invalid>`, boundary=`wasalx-${runId}-${phase}`;
  const headers=[`From: ${clean(from)}`,`To: ${clean(to)}`,`Message-ID: ${messageId}`,`Subject: WasalX ${runId}`, 'MIME-Version: 1.0'];
  if(inReplyTo) headers.push(`In-Reply-To: ${clean(inReplyTo)}`,`References: ${inReplyTo}`);
  const body=`WasalX ${runId} ${phase}`;
  let content=body;
  if(attachment){
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    content=[`--${boundary}`,'Content-Type: text/plain; charset=UTF-8','',''+body,`--${boundary}`,'Content-Type: application/octet-stream','Content-Disposition: attachment; filename="proof.bin"','Content-Transfer-Encoding: base64','',Buffer.from(attachment).toString('base64').match(/.{1,76}/gu).join('\r\n'),`--${boundary}--`].join('\r\n');
  } else headers.push('Content-Type: text/plain; charset=UTF-8');
  const bytes=Buffer.from([...headers,'',content,''].join('\r\n'));
  return {messageId, bytes, sha256:sha256(bytes), attachmentSha256:attachment?sha256(attachment):null};
}
