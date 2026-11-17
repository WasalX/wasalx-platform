import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { invitationMailStage, verifyInvitationMailerReadiness } from '../scripts/release/simulation-invitation-mail.mjs';

test('invitation mail failure records a secret-free step and preserves the cause', async () => {
 const failure = Object.assign(new Error('private transport detail'), { code: 'ETIMEDOUT' });
 const checkpoints = [];
 const session = {
  model: { name: 'wasalx-simulation-test' },
  run: async () => { throw failure; },
  checkpoint: async row => { checkpoints.push(row); },
 };
 await assert.rejects(invitationMailStage(session, { config: { recipient: 'synthetic@example.test', sourceSha256: 'a' } }), error => error === failure);
 assert.deepEqual(checkpoints, [{
  phase: 'invitation-mail-prerequisite-failed',
  step: 'containers',
  errorClass: 'Error',
  errorCode: 'ETIMEDOUT',
  messageSha256: createHash('sha256').update(failure.message).digest('hex'),
 }]);
});

test('invitation readiness executes only in the verified private mailer', async () => {
 const id = 'a'.repeat(64), calls = [];
 const row = { Id: id, Config: { Labels: { 'com.docker.compose.project': 'wasalx-simulation-test', 'com.docker.compose.service': 'invitation-mailer' } }, State: { Status: 'running', Health: { Status: 'healthy' } }, HostConfig: { PortBindings: {} } };
 const session = { model: { name: 'wasalx-simulation-test' }, run: async (command, args) => { calls.push({command,args}); return JSON.stringify(args[0] === 'inspect' ? [row] : {status:200,providerConnection:true}); } };
 assert.deepEqual(await verifyInvitationMailerReadiness(session,id),{status:200,providerConnection:true});
 assert.deepEqual(calls[1].args.slice(0,4),['exec',id,'node','-e']);
 assert(calls[1].args[4].includes("http://127.0.0.1:"));
 assert(calls[1].args[4].includes('/readyz'));
 row.Config.Labels['com.docker.compose.project']='foreign';
 await assert.rejects(verifyInvitationMailerReadiness(session,id));
 assert.equal(calls.length,3,'Identity mismatch must fail before exec');
 row.Config.Labels['com.docker.compose.project']='wasalx-simulation-test';
 session.run=async (_command,args)=>JSON.stringify(args[0]==='inspect'?[row]:{status:503,providerConnection:false});
 await assert.rejects(verifyInvitationMailerReadiness(session,id));
 session.run=async (_command,args)=>JSON.stringify(args[0]==='inspect'?[row]:{status:200,providerConnection:false});
 await assert.rejects(verifyInvitationMailerReadiness(session,id));
});
